"""Process-held, cross-platform writer lease for one initialized Context pool."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import stat
import sys
from datetime import datetime, timezone
from uuid import UUID


MAX_INPUT = 16 * 1024
MAX_BINDING = 64 * 1024
IDENTITY = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")


def instant() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def fail(message: str, code: str = "MEMORY_LEASE_INVALID") -> None:
    print(json.dumps({"state": "error", "code": code, "message": message}), flush=True)
    raise SystemExit(1)


def lock(handle) -> None:
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            if handle.read(1) == b"":
                handle.seek(0)
                handle.write(b"\0")
                handle.flush()
                os.fsync(handle.fileno())
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (BlockingIOError, OSError):
        fail("Another process owns this memory writer lease.", "MEMORY_LEASE_BUSY")


def unlock(handle) -> None:
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass


def open_nofollow(path: Path, flags: int, mode: int = 0o600):
    descriptor = os.open(path, flags | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0), mode)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (os.name != "nt" and info.st_mode & 0o077):
            fail("Memory lease files must be private regular files.")
        return descriptor, info
    except BaseException:
        os.close(descriptor)
        raise


def main() -> None:
    raw = sys.stdin.buffer.readline(MAX_INPUT + 1)
    if not raw or len(raw) > MAX_INPUT:
        fail("Memory lease request is missing or too large.")
    try:
        request = json.loads(raw)
    except Exception:
        fail("Memory lease request is not valid JSON.")
    allowed = {"directory", "agentId", "ownerScope", "leaseId"}
    if not isinstance(request, dict) or set(request) != allowed:
        fail("Memory lease request shape is invalid.")
    directory = request["directory"]
    agent_id = request["agentId"]
    owner = request["ownerScope"]
    lease_id = request["leaseId"]
    if not isinstance(directory, str) or not Path(directory).is_absolute() or "\x00" in directory:
        fail("Memory lease directory must be absolute.")
    path = Path(directory)
    try:
        canonical = path.resolve(strict=True)
    except OSError:
        fail("Initialized memory directory is unavailable.")
    if canonical != path or path.is_symlink() or not path.is_dir():
        fail("Memory lease directory must be canonical and cannot be a symbolic link.")
    if not isinstance(agent_id, str) or not IDENTITY.fullmatch(agent_id):
        fail("Memory lease agent identity is invalid.")
    if not isinstance(owner, dict) or set(owner) != {"cloudOrigin", "accountSubject"} \
            or not isinstance(owner["cloudOrigin"], str) or not 1 <= len(owner["cloudOrigin"]) <= 2048 \
            or not isinstance(owner["accountSubject"], str) or not 1 <= len(owner["accountSubject"]) <= 256:
        fail("Memory lease account scope is invalid.")
    try:
        if str(UUID(lease_id)) != lease_id:
            fail("Memory lease identity is invalid.")
    except (TypeError, ValueError, AttributeError):
        fail("Memory lease identity is invalid.")
    binding_path = path / ".aether-ats-memory.json"
    if binding_path.is_symlink() or not binding_path.is_file():
        fail("Verified ATS memory binding is missing.")
    try:
        binding_descriptor, binding_info = open_nofollow(binding_path, os.O_RDONLY)
        try:
            if binding_info.st_size > MAX_BINDING:
                fail("Verified ATS memory binding is too large.")
            binding = json.loads(os.read(binding_descriptor, MAX_BINDING + 1).decode("utf-8"))
        finally:
            os.close(binding_descriptor)
    except Exception:
        fail("Verified ATS memory binding is invalid.")
    expected_owner = {"cloud_origin": owner["cloudOrigin"], "account_subject": owner["accountSubject"]}
    if binding.get("state") != "ready" or binding.get("persistence_verified") is not True \
            or binding.get("agent_id") != agent_id or binding.get("directory") != str(path) \
            or binding.get("owner_scope") != expected_owner:
        fail("Verified ATS memory binding does not match this account and agent.")
    lock_path = path / ".aether-ats-runtime.lock"
    if lock_path.is_symlink():
        fail("Memory writer lock cannot be a symbolic link.")
    try:
        descriptor, _ = open_nofollow(lock_path, os.O_RDWR | os.O_CREAT)
        handle = os.fdopen(descriptor, "r+b", buffering=0)
    except OSError:
        fail("Memory writer lock could not be opened safely.")
    try:
        lock(handle)
        receipt = {
            "schema_version": "aether.ats.memory-writer-lease/1",
            "state": "leased",
            "lease_id": lease_id,
            "agent_id": agent_id,
            "directory": str(path),
            "owner_scope": expected_owner,
            "pid": os.getpid(),
            "started_at": instant(),
            "lock_scope": "ats_runtime_writer",
            "runtime_exclusivity_verified": True,
        }
        print(json.dumps(receipt, sort_keys=True), flush=True)
        # Parent death closes the pipe and releases the kernel-held lock.
        release = sys.stdin.buffer.readline(64)
        if release not in {b"", b"release\n"}:
            fail("Memory lease release request is invalid.")
    finally:
        unlock(handle)
        handle.close()


if __name__ == "__main__":
    main()
