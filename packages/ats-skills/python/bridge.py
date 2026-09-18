"""Bounded JSON adapter. It imports native engines; it never executes strategy files."""
from __future__ import annotations
import contextlib
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import uuid
import stat

MAX_INPUT = 64 * 1024
BINDING = ".aether-ats-memory.json"
LOCK = ".aether-ats-memory.lock"
TRANSACTION = ".aether-ats-initialize.json"
VERIFICATION = ".aether-ats-verify.json"
CONTEXT_VERSION = "0.3.1"
NATIVE_FILES = {"config.json", "pool.json", "vectors.f32"}


def reject_links(path: Path):
    for candidate in (path, *path.parents):
        if candidate.is_symlink():
            raise ValueError("Memory paths cannot follow symbolic links")


def sync_directory(path):
    # Windows has no portable directory fsync in the stdlib; filesystem-specific
    # power-loss behavior remains a release qualification requirement.
    if os.name != "nt":
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def sync_native_file(path: Path):
    """Flush a native file using a writable descriptor on every platform.

    Windows rejects fsync on a read-only descriptor (Errno 9). Native setup
    files are owned by this adapter, so opening them read/write is safe and
    keeps the durability check meaningful on both POSIX and Windows.
    """
    reject_links(path)
    flags = os.O_RDWR | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("Native memory file must be a regular file")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_json(path: Path, value):
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temp.open("x", encoding="utf-8") as handle:
            os.chmod(temp, 0o600)
            json.dump(value, handle, sort_keys=True, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
        sync_directory(path.parent)
    finally:
        temp.unlink(missing_ok=True)


@contextlib.contextmanager
def setup_lock(path):
    """Kernel ownership, not a PID/mtime guess. Keep the inode after unlock.

    This coordinates this adapter only. Context 0.3.1 does not participate;
    a future ATS host must stop/lease its native writer before using setup.
    """
    lock = path / LOCK
    reject_links(lock)
    created = False
    try:
        fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except FileExistsError:
        fd = os.open(lock, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    else:
        created = True
    locked = False
    try:
        if created:
            os.write(fd, b"aether.ats.setup-lock/1\n")
            os.fsync(fd)
            sync_directory(path)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("Memory setup lock must be a regular file")
        os.lseek(fd, 0, os.SEEK_SET)
        if os.read(fd, 128) != b"aether.ats.setup-lock/1\n":
            raise ValueError("Legacy or unknown setup lock has no recoverable owner evidence; stop older ATS setup processes before manually recovering this marker")
        os.lseek(fd, 0, os.SEEK_SET)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except OSError as error:
            raise ValueError("Memory setup is busy; wait for the owning setup process") from error
        yield
    finally:
        if locked:
            if os.name == "nt":
                import msvcrt
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def digest(path):
    reject_links(path)
    if not path.is_file():
        raise ValueError("Setup transaction contains a non-regular native file")
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest() if sys.version_info >= (3, 11) else _digest_stream(handle)


def _digest_stream(handle):
    value = hashlib.sha256()
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        value.update(chunk)
    return value.hexdigest()


def owned_stage(path, transaction):
    name = transaction.get("stage")
    if not isinstance(name, str) or not re.fullmatch(r"\.aether-ats-stage-[0-9a-f]{32}", name):
        raise ValueError("Invalid setup staging ownership record; files preserved")
    stage = path / name
    reject_links(stage)
    if stage.exists():
        if not stage.is_dir():
            raise ValueError("Setup staging location is not a directory; files preserved")
        for child in stage.iterdir():
            if child.name not in NATIVE_FILES | {"pool.json.tmp"} or child.is_symlink() or not child.is_file():
                raise ValueError("Unrecognized data in setup staging; files preserved")
    return stage


def cleanup_verification(path, expected):
    journal = path / VERIFICATION
    reject_links(journal)
    if not journal.exists():
        return
    record = json.loads(journal.read_text(encoding="utf-8"))
    name = record.get("snapshot")
    if record.get("schema_version") != "aether.ats.memory-verification/1" or record.get("binding") != expected or not isinstance(name, str) or not re.fullmatch(r"\.ats-verify-[0-9a-f]{32}", name):
        raise ValueError("Unrecognized memory verification ownership; files preserved")
    snapshot = path.parent / name
    reject_links(snapshot)
    if snapshot.exists():
        if not snapshot.is_dir():
            raise ValueError("Verification snapshot is not a directory; files preserved")
        for child in snapshot.iterdir():
            if child.name not in NATIVE_FILES | {"pool.json.tmp"} or child.is_symlink() or not child.is_file():
                raise ValueError("Unrecognized data in verification snapshot; files preserved")
        shutil.rmtree(snapshot)
        sync_directory(path.parent)
    journal.unlink()
    sync_directory(path)


def create_verification(path, expected):
    snapshot = path.parent / (".ats-verify-" + uuid.uuid4().hex)
    atomic_json(path / VERIFICATION, {"schema_version": "aether.ats.memory-verification/1", "binding": expected, "snapshot": snapshot.name})
    snapshot.mkdir(mode=0o700)
    sync_directory(path.parent)
    return snapshot


def validate_native_pool(path, config, ceiling):
    """Validate the pinned unquantized format before Context can pad its mmap.

    Context 0.3.1 silently grows a short vector file on open. A successful
    native constructor and unchanged slice counts cannot prove persistence.
    This reads only; it never repairs a damaged user's pool.
    """
    from aether_context.context_pool import slice_cost_bytes

    def invalid(reason):
        raise ValueError("Invalid persisted memory: " + reason + "; files preserved")

    try:
        header = json.loads((path / "pool.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        invalid("unreadable pool metadata")
    if not isinstance(header, dict):
        invalid("pool metadata must be an object")
    dim = config.dim
    if type(dim) is not int or dim <= 0 or type(config.quantize_bits) is not int or config.quantize_bits != 0:
        invalid("unsupported native vector configuration")
    if (type(header.get("version")) is not int or header["version"] != 1
            or type(header.get("dim")) is not int or header["dim"] != dim
            or type(header.get("quantize_bits")) is not int or header["quantize_bits"] != 0
            or header.get("index") != config.index
            or type(header.get("ceiling_bytes")) is not int or header["ceiling_bytes"] != ceiling):
        invalid("native header does not match the configured format or quota")
    count, capacity, records = header.get("count"), header.get("capacity"), header.get("slices")
    if (type(count) is not int or count < 0 or not isinstance(records, list) or count != len(records)
            or type(capacity) is not int or capacity < 64 or capacity & (capacity - 1) or count > capacity
            or count * slice_cost_bytes(dim) > ceiling):
        invalid("inconsistent native count, capacity or quota")
    ids, rows = set(), set()
    for record in records:
        if not isinstance(record, dict):
            invalid("invalid slice record")
        sid, row = record.get("id"), record.get("row")
        if (not isinstance(sid, str) or not sid or sid in ids
                or type(row) is not int or row < 0 or row >= capacity or row in rows
                or not isinstance(record.get("session"), str) or not isinstance(record.get("text"), str)
                or type(record.get("tokens")) is not int or record["tokens"] < 0
                or not isinstance(record.get("meta"), dict)
                or type(record.get("score")) not in (int, float) or not math.isfinite(record["score"])):
            invalid("invalid or duplicate slice identity, row or payload")
        ids.add(sid)
        rows.add(row)
    vectors = path / "vectors.f32"
    reject_links(vectors)
    if not vectors.is_file() or vectors.stat().st_size != capacity * dim * 4:
        invalid("vector byte extent does not match native capacity")


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
    try:
        import numpy as np
        import aether_context
        from aether_context.config import PoolConfig
        from aether_context.context_pool import ContextPool, Slice
    except ImportError:
        return {"state": "unavailable", "code": "CONTEXT_ENGINE_UNAVAILABLE", "message": "Install the pinned aether-context engine, or select its Python interpreter."}
    if getattr(aether_context, "__version__", None) != CONTEXT_VERSION:
        return {"state": "unavailable", "code": "CONTEXT_VERSION_UNSUPPORTED", "runtime_version": getattr(aether_context, "__version__", None), "required_version": CONTEXT_VERSION, "message": "Select aether-context 0.3.1; other memory formats require explicit qualification."}
    ceiling = size * 1024 ** 3
    expected = {"schema_version": "aether.ats.memory/1", "agent_id": agent_id, "directory": str(path), "size_gb": size, "ceiling_bytes": ceiling}
    scope = request.get("ownerScope")
    if scope is not None:
        if not isinstance(scope, dict) or set(scope) != {"accountSubject", "cloudOrigin"} or any(not isinstance(v, str) or not v or len(v) > 512 for v in scope.values()):
            raise ValueError("Memory owner scope requires the canonical account ID and Cloud origin")
        expected["owner_scope"] = {"account_subject": scope["accountSubject"], "cloud_origin": scope["cloudOrigin"]}
    ancestor = path
    while not ancestor.exists():
        ancestor = ancestor.parent
    free_bytes = shutil.disk_usage(ancestor).free
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    reject_links(path)
    pool = None
    with setup_lock(path):
        try:
            binding_path, transaction_path = path / BINDING, path / TRANSACTION
            reject_links(binding_path)
            reject_links(transaction_path)
            existing = binding_path.exists()
            if existing:
                prior = json.loads(binding_path.read_text(encoding="utf-8"))
                if any(prior.get(key) != value for key, value in expected.items()) or prior.get("owner_scope") != expected.get("owner_scope"):
                    raise ValueError("Memory directory is bound to another agent, account or size; choose a new directory")
                if prior.get("runtime_version", CONTEXT_VERSION) != CONTEXT_VERSION:
                    raise ValueError("Bound memory runtime requires explicit migration; files preserved")
                if not all((path / name).is_file() for name in NATIVE_FILES):
                    raise ValueError("Bound memory is incomplete; existing files will not be overwritten")
            # Recovery removes only a scope-matching, journal-owned scratch
            # snapshot left by an interrupted native verification.
            cleanup_verification(path, expected)
            transaction = None
            if transaction_path.exists():
                transaction = json.loads(transaction_path.read_text(encoding="utf-8"))
                if transaction.get("schema_version") != "aether.ats.memory-setup/1" or transaction.get("binding") != expected or transaction.get("phase") not in {"building", "publishing"}:
                    raise ValueError("Memory setup transaction belongs to another configuration; files preserved")
                stage = owned_stage(path, transaction)
                allowed = {LOCK, TRANSACTION, stage.name} | (NATIVE_FILES if transaction["phase"] == "publishing" else set()) | ({BINDING} if existing else set())
                if any(child.name not in allowed for child in path.iterdir()):
                    raise ValueError("Unrecognized files in memory setup transaction; files preserved")
            elif not existing:
                if any(item.name != LOCK for item in path.iterdir()):
                    raise ValueError("Choose an empty directory; existing unbound files will not be overwritten")
            for item in path.iterdir():
                if item.is_symlink():
                    raise ValueError("Memory files cannot be symbolic links")
            if free_bytes < (1024 ** 2 if existing or (transaction and transaction["phase"] == "publishing") else ceiling):
                raise ValueError("Available disk space is smaller than the required setup capacity")
            os.chmod(path, 0o700)
            if not existing and transaction is None:
                transaction = {"schema_version": "aether.ats.memory-setup/1", "binding": expected, "stage": ".aether-ats-stage-" + uuid.uuid4().hex, "phase": "building"}
                atomic_json(transaction_path, transaction)
                stage = owned_stage(path, transaction)
            if not existing and transaction["phase"] == "building":
                # Only a journal-owned staging directory is reset. No final native
                # files exist in this phase, and unknown/symlink data is refused.
                if stage.exists():
                    shutil.rmtree(stage)
                stage.mkdir(mode=0o700)
                config = PoolConfig(pool_gb=size, dir=stage, mode="separate", index="flat")
                config.save()
                pool = ContextPool(config, ceiling_bytes=ceiling)
                check = "ats-setup-" + uuid.uuid4().hex
                vector = np.zeros(config.dim, dtype=np.float32)
                vector[0] = 1.0
                pool.add(Slice(id=check, session=check, vector=vector, text=check, tokens=1, meta={"source": "setup-probe"}, score=1.0))
                pool.close()
                validate_native_pool(stage, config, ceiling)
                pool = ContextPool(PoolConfig.load(stage), ceiling_bytes=ceiling)
                found = pool.search(vector, k=1, session=check)
                if (len(found) != 1 or found[0].id != check or found[0].text != check
                        or found[0].session != check or found[0].tokens != 1
                        or found[0].meta != {"source": "setup-probe"}
                        or not np.array_equal(found[0].vector, vector) or pool.ceiling_bytes != ceiling):
                    raise RuntimeError("Native memory readback failed")
                pool.clear_session(check)
                pool.close()
                pool = None
                native_config = json.loads((stage / "config.json").read_text(encoding="utf-8"))
                native_config["dir"] = str(path)
                (stage / "config.json").write_text(json.dumps(native_config, sort_keys=True, indent=2), encoding="utf-8")
                for name in NATIVE_FILES:
                    sync_native_file(stage / name)
                transaction = {**transaction, "phase": "publishing", "files": {name: digest(stage / name) for name in sorted(NATIVE_FILES)}}
                atomic_json(transaction_path, transaction)
            if transaction and transaction["phase"] == "publishing":
                files = transaction.get("files", {})
                if set(files) != NATIVE_FILES or any(not isinstance(v, str) or not re.fullmatch(r"[0-9a-f]{64}", v) for v in files.values()):
                    raise ValueError("Invalid memory publication receipt; files preserved")
                for name, checksum in files.items():
                    target = path / name
                    if target.exists():
                        if not existing and digest(target) != checksum:
                            raise ValueError("Published memory changed during setup recovery; files preserved")
                    else:
                        source = stage / name
                        if digest(source) != checksum:
                            raise ValueError("Staged memory changed during setup recovery; files preserved")
                        # Atomic, exclusive publication: never replace unrelated data.
                        # Hard links must be supported on this selected drive.
                        try:
                            os.link(source, target)
                        except OSError as error:
                            raise OSError("Memory publication requires working atomic hard links on the selected drive; files preserved for retry") from error
                        sync_directory(path)
            config = PoolConfig.load(path)
            if type(config.pool_gb) is not int or config.pool_gb != size or config.dir.resolve() != path:
                raise ValueError("Native memory configuration does not match its binding")
            validate_native_pool(path, config, ceiling)
            # Context 0.3.1 reopens vectors with mmap mode="w+". Reverify a
            # digest-checked snapshot instead of reopening an existing user's
            # files. Direct Context writers do not participate in our lock;
            # concurrent changes refuse verification without mutating the pool.
            with contextlib.ExitStack() as verification:
                def close_verification_pool():
                    nonlocal pool
                    if pool is not None:
                        pool.close()
                        pool = None
                original = {name: digest(path / name) for name in NATIVE_FILES}
                copy_bytes = sum((path / name).stat().st_size for name in NATIVE_FILES)
                if free_bytes < copy_bytes + 512 * 1024:
                    raise ValueError("Available disk space is smaller than the memory verification snapshot")
                snapshot = create_verification(path, expected)
                verification.callback(cleanup_verification, path, expected)
                for name in NATIVE_FILES:
                    shutil.copyfile(path / name, snapshot / name)
                    if digest(snapshot / name) != original[name]:
                        raise ValueError("Memory changed during verification; stop its writer and retry")
                verify_path = snapshot
                verification.callback(close_verification_pool)
                verify_config = PoolConfig.load(verify_path)
                validate_native_pool(verify_path, verify_config, ceiling)
                pool = ContextPool(verify_config, ceiling_bytes=ceiling)
                before = pool.stats()
                pool.close()
                if any(digest(verify_path / name) != checksum for name, checksum in original.items()):
                    raise RuntimeError("Native memory reopen changed persisted content")
                pool = ContextPool(PoolConfig.load(verify_path), ceiling_bytes=ceiling)
                stats = pool.stats()
                if stats != before or pool.ceiling_bytes != ceiling:
                    raise RuntimeError("Native memory reopen changed its accounting")
                pool.close()
                pool = None
                if any(digest(verify_path / name) != checksum for name, checksum in original.items()):
                    raise RuntimeError("Native memory reopen changed persisted content")
                if original and any(digest(path / name) != checksum for name, checksum in original.items()):
                    raise ValueError("Memory changed during verification; stop its writer and retry")
            receipt = {**expected, "state": "ready", "backend": "aether-context", "runtime_version": CONTEXT_VERSION, "persistence_verified": True, "quota_kind": "native_slice_accounting", "reserved_bytes": 0, "stats": stats, "lock_scope": "ats_setup_only", "runtime_exclusivity_verified": False, "verification_kind": "persisted_snapshot_reopen" if existing else "native_pool_init_and_snapshot_reopen"}
            # The binding is the readiness commit: all native files were reopened.
            if not existing:
                for name in NATIVE_FILES:
                    sync_native_file(path / name)
            atomic_json(binding_path, receipt)
            if transaction:
                if stage.exists():
                    owned_stage(path, transaction)
                    shutil.rmtree(stage)
                transaction_path.unlink()
                sync_directory(path)
            return receipt
        finally:
            if pool is not None:
                pool.close()


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
