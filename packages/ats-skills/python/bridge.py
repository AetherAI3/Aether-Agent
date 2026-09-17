"""Bounded JSON adapter. It imports native engines; it never executes strategy files."""
from __future__ import annotations
import contextlib
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import uuid
import tempfile
from dataclasses import replace

MAX_INPUT = 64 * 1024
BINDING = ".aether-ats-memory.json"
LOCK = ".aether-ats-memory.lock"


def reject_links(path: Path):
    for candidate in (path, *path.parents):
        if candidate.is_symlink():
            raise ValueError("Memory paths cannot follow symbolic links")


def atomic_json(path: Path, value):
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temp.open("x", encoding="utf-8") as handle:
            os.chmod(temp, 0o600)
            json.dump(value, handle, sort_keys=True, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def initialize_memory(request):
    agent_id, size = request.get("agentId"), request.get("sizeGb")
    if not isinstance(agent_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", agent_id):
        raise ValueError("A valid agent identity is required")
    if type(size) is not int or not 5 <= size <= 1024:
        raise ValueError("Memory size must be an integer from 5 to 1024 GiB")
    directory = request.get("directory")
    if not isinstance(directory, str) or not Path(directory).is_absolute():
        raise ValueError("Choose an absolute memory directory")
    path = Path(directory)
    reject_links(path)
    path = path.resolve()
    # Import before creating a directory: unavailable engines leave no partial setup.
    try:
        import numpy as np
        import aether_context
        from aether_context.config import PoolConfig
        from aether_context.context_pool import ContextPool, Slice
    except ImportError:
        return {"state": "unavailable", "code": "CONTEXT_ENGINE_UNAVAILABLE", "message": "Install the pinned aether-context engine, or select its Python interpreter."}
    ceiling = size * 1024 ** 3
    ancestor = path
    while not ancestor.exists():
        ancestor = ancestor.parent
    free_bytes = shutil.disk_usage(ancestor).free
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    reject_links(path)
    lock = path / LOCK
    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    pool = None
    try:
        binding_path = path / BINDING
        reject_links(binding_path)
        expected = {"schema_version": "aether.ats.memory/1", "agent_id": agent_id, "directory": str(path), "size_gb": size, "ceiling_bytes": ceiling}
        existing = binding_path.exists()
        if existing:
            prior = json.loads(binding_path.read_text(encoding="utf-8"))
            if any(prior.get(key) != value for key, value in expected.items()):
                raise ValueError("Memory directory is bound to another agent or size; choose a new directory")
        elif any(item.name != LOCK for item in path.iterdir()):
            raise ValueError("Choose an empty directory; existing unbound files will not be overwritten")
        required_free = 1024 ** 2 if existing else ceiling
        if free_bytes < required_free:
            raise ValueError("Available disk space is smaller than the required setup capacity")
        for item in path.iterdir():
            if item.is_symlink():
                raise ValueError("Memory files cannot be symbolic links")
        os.chmod(path, 0o700)
        if existing:
            if not (path / "config.json").is_file() or not (path / "pool.json").is_file():
                raise ValueError("Bound memory is incomplete; existing files will not be overwritten")
            config = PoolConfig.load(path)
            if type(config.pool_gb) is not int or config.pool_gb != size or config.dir.resolve() != path:
                raise ValueError("Native memory configuration does not match its binding")
        else:
            config = PoolConfig(pool_gb=size, dir=path, mode="separate", index="flat")
        # Never add a setup probe to the user's pool: add() can evict data at capacity.
        # Exercise real disk persistence in an exclusively owned temporary pool on
        # the same drive, preserving the configured native format and dimensions.
        with tempfile.TemporaryDirectory(prefix=".ats-probe-", dir=path) as temporary:
            try:
                probe_path = Path(temporary)
                probe_config = replace(config, dir=probe_path)
                probe_config.save()
                pool = ContextPool(probe_config, ceiling_bytes=ceiling)
                check = "ats-setup-" + uuid.uuid4().hex
                vector = np.zeros(config.dim, dtype=np.float32)
                vector[0] = 1.0
                pool.add(Slice(id=check, session=check, vector=vector, text=check, tokens=1, meta={"source": "setup-probe"}, score=1.0))
                pool.close()
                pool = ContextPool(PoolConfig.load(probe_path), ceiling_bytes=ceiling)
                found = pool.search(vector, k=1, session=check)
                if len(found) != 1 or found[0].id != check or found[0].text != check or pool.ceiling_bytes != ceiling:
                    raise RuntimeError("Native memory readback failed")
                pool.clear_session(check)
                vectors_name = pool.vectors_path.name
                pool.close()
                pool = None
                if not existing:
                    # Only a previously empty unbound location receives these empty,
                    # native-created files. Existing pools and configuration are untouched.
                    config.save()
                    atomic_json(binding_path, expected)
                    os.replace(probe_path / vectors_name, path / vectors_name)
                    os.replace(probe_path / "pool.json", path / "pool.json")
            finally:
                if pool is not None:
                    pool.close()
                    pool = None
        pool = ContextPool(config, ceiling_bytes=ceiling)
        before = pool.stats()
        pool.close()
        pool = ContextPool(PoolConfig.load(path), ceiling_bytes=ceiling)
        stats = pool.stats()
        if stats != before or pool.ceiling_bytes != ceiling:
            raise RuntimeError("Native memory reopen changed its accounting")
        pool.close()
        pool = None
        receipt = {**expected, "state": "ready", "backend": "aether-context", "runtime_version": aether_context.__version__, "persistence_verified": True, "quota_kind": "native_slice_accounting", "reserved_bytes": 0, "stats": stats}
        atomic_json(binding_path, receipt)
        return receipt
    finally:
        if pool is not None:
            pool.close()
        lock.unlink(missing_ok=True)


def scan_strategies(request):
    directory = request.get("directory")
    if not isinstance(directory, str) or not Path(directory).is_absolute():
        raise ValueError("Choose an absolute strategy directory")
    reject_links(Path(directory))
    path = Path(directory).resolve(strict=True)
    if not path.is_dir():
        raise ValueError("The strategy location is not a directory")
    runtime = os.environ.get("AETHER_ATS_RUNTIME_PATH")
    if runtime:
        runtime_path = Path(runtime)
        if not runtime_path.is_absolute() or not (runtime_path / "llmre" / "nano_compile.py").is_file():
            raise ValueError("AETHER_ATS_RUNTIME_PATH must identify the installed ATS runtime")
        sys.path.insert(0, str(runtime_path.resolve()))
    try:
        compiler = importlib.import_module("llmre.nano_compile")
    except ImportError:
        compiler = None
    # Bounded, direct children only; recursive discovery needs a separate explicit selection.
    records, seen = [], 0
    with os.scandir(path) as entries:
        for entry in entries:
            seen += 1
            if seen > 1024:
                raise ValueError("Strategy directory exceeds the 1024-entry scan limit")
            suffix = Path(entry.name).suffix.lower()
            if suffix not in {".nano", ".pine", ".pinescript", ".py"}:
                continue
            if len(records) >= 100:
                raise ValueError("Select a directory with at most 100 strategies")
            if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                records.append({"file": entry.name, "state": "rejected", "code": "NOT_REGULAR_FILE"})
                continue
            target = path / entry.name
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
            descriptor = os.open(target, flags)
            with os.fdopen(descriptor, "rb") as handle:
                import stat
                if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                    raise ValueError("Strategy changed to a non-regular file during scan")
                raw = handle.read(16 * 1024 + 1)
            if len(raw) > 16 * 1024:
                records.append({"file": entry.name, "state": "rejected", "code": "SOURCE_TOO_LARGE"})
                continue
            try:
                source = raw.decode("utf-8")
            except UnicodeDecodeError:
                records.append({"file": entry.name, "state": "rejected", "code": "UTF8_REQUIRED"})
                continue
            item = {"file": entry.name, "source_sha256": hashlib.sha256(raw).hexdigest(), "source_bytes": len(raw)}
            if suffix != ".nano":
                item.update(state="needs_conversion", target_language="nano", message="Prepare and review native Nano source, then compile it; imported code is never executed.")
            elif compiler is None:
                item.update(state="unavailable", code="ATS_COMPILER_UNAVAILABLE")
            else:
                outcome = compiler.compile_proposal(source)
                item.update(state="compiled" if outcome.ok else "rejected", diagnostics=[d.to_dict() for d in outcome.diagnostics])
                if outcome.ok:
                    strategy = outcome.strategy
                    item.update(name=strategy.name, source_hash=strategy.source_hash, ir_version=strategy.ir_version, effects=list(strategy.effects), signals=list(strategy.signals), interval=strategy.interval)
            records.append(item)
    records.sort(key=lambda record: record["file"])
    return {"state": "scanned", "directory": str(path), "compiler": "native_ats" if compiler else "unavailable", "strategies": records, "execution_enabled": False, "recursive": False}


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise ValueError("Request exceeds size limit")
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("Request must be an object")
        operation = request.pop("operation", None)
        handler = {"initialize_memory": initialize_memory, "scan_strategies": scan_strategies}.get(operation)
        if handler is None:
            raise ValueError("Unknown ATS bridge operation")
        with contextlib.redirect_stdout(sys.stderr):
            result = handler(request)
        print(json.dumps(result, sort_keys=True))
    except Exception as error:
        print(json.dumps({"state": "error", "code": type(error).__name__, "message": str(error)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
