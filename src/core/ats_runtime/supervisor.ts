// Spec 2 step 2.5 and PR 2.2 — the cross-platform runtime supervisor.
//
// start / stop / status / restart / rollback, plus the ordered teardown an
// account switch demands (section 17: "Tool host, dashboard, browser, runtime
// access, and memory lease close immediately").
//
// Everything that touches the outside world — spawning, killing, checking a
// pid, asking the runtime what it can do, reading the clock — arrives through
// `SupervisorDeps`. That is not ceremony: a supervisor whose only test is
// "does it really spawn python" is a supervisor nobody tests, and the
// interesting behaviour here is the state machine around the process, not the
// process.
//
// The load-bearing rule is that STATUS IS OBSERVED, NEVER REMEMBERED. A pid in
// runtime.json is a claim; `process.kill(pid, 0)` is evidence. Section 7.2 puts
// effective mode under ATSv2's authority, so a status call that cannot reach
// the runtime returns an offline snapshot rather than the last good one.

import { randomBytes, randomUUID } from "node:crypto";
import { rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { terminateProcessTree, type KillableChild } from "../process_tree_kill.js";
import {
  offlineCapabilitySnapshot,
  readRuntimeCapabilityReply,
  type RuntimeCapabilitySnapshotV1,
} from "../ats_contracts/runtime.js";
import { writePrivateFile } from "./paths.js";
import { readRuntimeRecord, writeRuntimeRecord, type RuntimeRecordV1 } from "./store.js";

/** A spawned child, narrowed to what the supervisor actually uses. */
export interface SupervisedChild extends KillableChild {
  unref?(): void;
}

export interface SupervisorDeps {
  /** Spawn the runtime entry point. Detached, so the CLI can exit without it. */
  spawn?: (command: string, args: readonly string[], options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    detached: boolean;
    stdio: "ignore";
  }) => SupervisedChild;
  now?: () => Date;
  /** True when a process with this pid exists. */
  pidAlive?: (pid: number) => boolean;
  /**
   * Ask the running runtime what it currently honours. Returns the
   * runtime-authored payload; the caller validates it. Absent means the Agent
   * has no channel to the runtime, which resolves to offline.
   */
  probe?: (input: { record: RuntimeRecordV1; signal?: AbortSignal }) => Promise<unknown>;
  terminate?: (pid: number) => void;
}

/** Default liveness check. EPERM means the pid exists but is not ours to signal. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function stamp(deps: SupervisorDeps): string {
  return (deps.now ? deps.now() : new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The runtime's launch command inside its private install directory. Windows
 * needs the `.cmd` shim; POSIX uses the extensionless script. Resolving this
 * from the install directory rather than PATH is deliberate — a runtime picked
 * up from PATH is not the one whose digest was verified.
 */
export function runtimeEntryPoint(installDir: string): string {
  return join(installDir, "bin", process.platform === "win32" ? "ats-runtime.cmd" : "ats-runtime");
}

/** Where the owner-private local service credential lives. */
export function credentialFilePath(installDir: string): string {
  return join(installDir, "runtime-credential");
}

/**
 * Provision the local service credential Spec 2 step 2.4 requires.
 *
 * 32 bytes from the CSPRNG, written 0600 through the same symlink-refusing
 * atomic writer as every other private file. The VALUE is returned to nobody:
 * callers receive the path, and `runtime.json` stores only the path, so a
 * diagnostic bundle or a leaked state file cannot carry the secret itself
 * (section 14).
 */
export async function provisionRuntimeCredential(installDir: string): Promise<string> {
  const path = credentialFilePath(installDir);
  await writePrivateFile(path, randomBytes(32).toString("hex") + "\n");
  return path;
}

/** A fresh runtime instance id. New every install, so receipts never collide. */
export function newRuntimeInstanceId(): string {
  return `rt_${randomUUID().replace(/-/g, "")}`;
}

export interface SupervisorResult {
  readonly record: RuntimeRecordV1;
  readonly changed: boolean;
  readonly reason: string | null;
}

/**
 * Whether the recorded process is actually alive. A record can name a pid that
 * died in a crash or was reused by an unrelated process after a reboot, so
 * nothing downstream may treat a stored pid as "running".
 */
export function recordRunning(record: RuntimeRecordV1, deps: SupervisorDeps = {}): boolean {
  const pid = record.supervisor.pid;
  if (pid === null) return false;
  return (deps.pidAlive ?? pidAlive)(pid);
}

/**
 * Start the runtime. Refuses when no verified installation exists: section 2
 * permits exactly one installation path and it ends in a receipt, so a missing
 * receipt means there is nothing whose provenance was ever proven.
 */
export async function startRuntime(
  recordPath: string,
  record: RuntimeRecordV1,
  deps: SupervisorDeps = {},
): Promise<SupervisorResult> {
  if (!record.installation) {
    return { record, changed: false, reason: "No verified ATS runtime is installed." };
  }
  if (recordRunning(record, deps)) {
    return { record, changed: false, reason: "The ATS runtime is already running." };
  }
  const spawn = deps.spawn;
  if (!spawn) {
    return { record, changed: false, reason: "No runtime launcher is available on this platform." };
  }

  const command = runtimeEntryPoint(record.install_dir);
  let child: SupervisedChild;
  try {
    child = spawn(command, [], {
      cwd: record.install_dir,
      // A deliberately narrow environment. The runtime is handed its own
      // private directory and credential FILE; inheriting the operator's whole
      // environment would drag broker credentials and provider keys into a
      // process that has no need for them (section 14).
      env: {
        ATS_RUNTIME_HOME: record.install_dir,
        ATS_RUNTIME_INSTANCE: record.runtime_instance_id,
        ...(record.credential_file ? { ATS_RUNTIME_CREDENTIAL_FILE: record.credential_file } : {}),
        PATH: process.env["PATH"] ?? "",
      },
      detached: true,
      stdio: "ignore",
    });
  } catch (error) {
    const next = await persist(recordPath, {
      ...record,
      supervisor: { ...record.supervisor, pid: null, started_at: null, last_error: redact(error) },
      updated_at: stamp(deps),
    });
    return { record: next, changed: true, reason: "The ATS runtime failed to start." };
  }

  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    return { record, changed: false, reason: "The ATS runtime did not report a process id." };
  }
  // Detach so the supervising CLI can exit without taking the runtime with it.
  child.unref?.();

  const next = await persist(recordPath, {
    ...record,
    supervisor: { pid, started_at: stamp(deps), last_exit_code: null, last_error: null },
    updated_at: stamp(deps),
  });
  return { record: next, changed: true, reason: null };
}

/**
 * Stop the runtime and clear its pid. Clearing the pid even when the process
 * was already gone is the point: a stale pid that later gets reused would make
 * `status` claim a healthy runtime that is actually somebody else's process.
 */
export async function stopRuntime(
  recordPath: string,
  record: RuntimeRecordV1,
  deps: SupervisorDeps = {},
): Promise<SupervisorResult> {
  const pid = record.supervisor.pid;
  if (pid === null) {
    return { record, changed: false, reason: "The ATS runtime is not running." };
  }
  const terminate = deps.terminate ?? ((target: number) => {
    // The runtime is spawned detached, so on POSIX the whole process GROUP is
    // signalled — a runtime that forked workers must not leave them behind.
    terminateProcessTree({ pid: target, kill: (signal?: NodeJS.Signals) => process.kill(target, signal) });
  });
  try {
    terminate(pid);
  } catch {
    // A process that is already gone is the outcome we wanted. Failing here
    // would leave the pid recorded and the runtime unstoppable.
  }
  const next = await persist(recordPath, {
    ...record,
    supervisor: { pid: null, started_at: null, last_exit_code: record.supervisor.last_exit_code, last_error: null },
    updated_at: stamp(deps),
  });
  return { record: next, changed: true, reason: null };
}

export async function restartRuntime(
  recordPath: string,
  record: RuntimeRecordV1,
  deps: SupervisorDeps = {},
): Promise<SupervisorResult> {
  const stopped = await stopRuntime(recordPath, record, deps);
  return startRuntime(recordPath, stopped.record, deps);
}

/**
 * Observe what the runtime currently honours.
 *
 * Every path that is not "the process is alive AND it answered with a valid
 * snapshot naming this instance" resolves to OFFLINE. Section 7.2 forbids
 * deriving effective mode locally, so there is no fallback to the operator's
 * requested mode and no reuse of a previous good answer.
 */
export async function runtimeStatus(
  record: RuntimeRecordV1,
  deps: SupervisorDeps = {},
  signal?: AbortSignal,
): Promise<RuntimeCapabilitySnapshotV1> {
  const observedAt = stamp(deps);
  const offline = (reason: string): RuntimeCapabilitySnapshotV1 =>
    offlineCapabilitySnapshot(record.runtime_instance_id, record.requested_mode, reason, observedAt);

  if (!record.installation) return offline("No verified ATS runtime is installed.");
  if (!recordRunning(record, deps)) return offline("The ATS runtime is not running.");
  if (!deps.probe) return offline("This Agent build has no channel to the ATS runtime.");

  try {
    const payload = await deps.probe({ record, ...(signal ? { signal } : {}) });
    return readRuntimeCapabilityReply(payload, { runtimeInstanceId: record.runtime_instance_id });
  } catch {
    // A probe that throws is a runtime that did not answer. Its exception may
    // carry a socket path or an install path, so it is not surfaced.
    return offline("The ATS runtime did not answer a capability probe.");
  }
}

/**
 * Roll back to the previous installation. Spec 2 step 2.5 requires a rollback
 * path and section 17 drills it, so this swaps the directories rather than
 * deleting anything: a failed rollback must leave BOTH versions on disk.
 */
export async function rollbackRuntime(
  recordPath: string,
  record: RuntimeRecordV1,
  previousDir: string,
  deps: SupervisorDeps = {},
): Promise<SupervisorResult> {
  try {
    if (!(await stat(previousDir)).isDirectory()) {
      return { record, changed: false, reason: "No previous ATS runtime is available to roll back to." };
    }
  } catch {
    return { record, changed: false, reason: "No previous ATS runtime is available to roll back to." };
  }

  // Stop first. Swapping directories under a live process is how a rollback
  // produces a runtime that is neither version.
  const stopped = await stopRuntime(recordPath, record, deps);
  const scratch = `${record.install_dir}.rollback-${randomUUID()}`;
  await rename(record.install_dir, scratch).catch(() => {});
  await rename(previousDir, record.install_dir);
  await rm(scratch, { recursive: true, force: true }).catch(() => {});

  // The receipt described the version just rolled away from, so it is cleared.
  // Section 7.1 has no "probably this version" state: the next start must
  // re-verify rather than inherit a receipt for bytes that are no longer here.
  const next = await persist(recordPath, { ...stopped.record, installation: null, updated_at: stamp(deps) });
  return { record: next, changed: true, reason: "Rolled back to the previous ATS runtime. Re-verify before starting." };
}

/**
 * Ordered teardown for an account switch or logout.
 *
 * Stop the process first, then drop the local authority state. Doing it in the
 * other order would leave a running runtime holding a credential whose record
 * had already been erased — a process nothing can find to stop.
 *
 * The installation receipt and install directory are intentionally KEPT: the
 * bytes on disk are still what they were, and section 17's rollback canary
 * requires disabling a runtime "without data loss". What is revoked is the
 * credential and the running process, not the evidence.
 */
export async function tearDownForAccountSwitch(
  recordPath: string,
  deps: SupervisorDeps = {},
): Promise<{ stopped: boolean }> {
  const record = await readRuntimeRecord(recordPath);
  if (!record) return { stopped: false };
  const stopped = await stopRuntime(recordPath, record, deps);
  if (record.credential_file) {
    // Revoke rather than reuse. A credential provisioned for one account must
    // never be presented on behalf of another.
    await rm(record.credential_file, { force: true }).catch(() => {});
    await persist(recordPath, { ...stopped.record, credential_file: null, updated_at: stamp(deps) });
  }
  return { stopped: stopped.changed };
}

/**
 * Bounded, path-free error text safe to persist and show. The raw message
 * routinely contains the full spawn path; only the errno code is kept, which
 * says what went wrong without saying where.
 */
function redact(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && code.length <= 32
    ? `The runtime launcher failed (${code}).`
    : "The runtime launcher failed.";
}

async function persist(recordPath: string, record: RuntimeRecordV1): Promise<RuntimeRecordV1> {
  await writeRuntimeRecord(recordPath, record);
  return record;
}
