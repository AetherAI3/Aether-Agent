// Spec 2 step 2.5 — the cross-platform runtime supervisor.
//
// start / stop / status / restart / rollback, plus the ordered teardown an
// account switch demands (section 17).
//
// Two rules shape everything here.
//
// STATUS IS OBSERVED, NEVER REMEMBERED. A pid in runtime.json is a claim;
// evidence is a live process that proves it is ours. Section 7.2 puts
// effective mode under ATSv2's authority, so a status call that cannot reach
// the runtime returns offline rather than the last good answer.
//
// WE ONLY SIGNAL PROCESSES WE CAN PROVE ARE OURS. `kill(pid, 0)` proves only
// that *some* process holds that number, and operating systems reuse pids
// aggressively. An earlier revision terminated on that basis, swallowed every
// error, and cleared state as though shutdown had succeeded — which on a
// recycled pid means killing an unrelated program and reporting success. Now a
// process is owned only when the recorded pid is alive AND its platform start
// token still matches (or, where no token is available, an authenticated
// instance handshake confirms it). Anything else is disowned, not killed.

import { randomBytes, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { terminateProcessTree, type KillableChild } from "../process_tree_kill.js";
import {
  offlineCapabilitySnapshot,
  readRuntimeCapabilityReply,
  type RuntimeCapabilitySnapshotV1,
} from "../ats_contracts/runtime.js";
import { writePrivateFile } from "./paths.js";
import {
  otherSlot,
  readSlotReceipt,
  recoverActiveSlot,
  slotDir,
  switchActiveSlot,
  verifyActiveTree,
  ACTIVE_POINTER_SCHEMA,
  type SlotResolution,
} from "./slots.js";
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
   * An opaque identity for a process START, used to detect pid reuse. Returns
   * null when the platform cannot supply one.
   */
  startToken?: (pid: number) => Promise<string | null>;
  /**
   * Authenticated handshake: ask the process at this pid which runtime
   * instance it is. Used where no start token exists, and as corroboration
   * where one does. Returns null when it cannot be established.
   */
  probeIdentity?: (input: { record: RuntimeRecordV1; signal?: AbortSignal }) => Promise<string | null>;
  /**
   * Ask the running runtime what it currently honours. Returns the
   * runtime-authored payload; the caller validates it.
   */
  probe?: (input: { record: RuntimeRecordV1; signal?: AbortSignal }) => Promise<unknown>;
  terminate?: (pid: number) => void;
  /** How long to wait for a confirmed exit before reporting failure. */
  waitMs?: number;
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

/**
 * Platform process-start identity.
 *
 * On Linux, field 22 of /proc/<pid>/stat is the process start time in clock
 * ticks since boot; combined with the pid it identifies one specific process
 * lifetime, so a recycled pid yields a different value. Elsewhere there is no
 * cheap portable equivalent, so this returns null and the supervisor falls
 * back to the handshake.
 */
export async function processStartToken(pid: number): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8");
    // The comm field can contain spaces and parentheses, so fields are counted
    // from after the final ')' rather than by splitting the whole line.
    const tail = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    const startTime = tail[19];
    return startTime ? `${pid}-${startTime}` : null;
  } catch {
    return null;
  }
}

function stamp(deps: SupervisorDeps): string {
  return (deps.now ? deps.now() : new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The runtime's launch command inside a resolved slot directory. */
export function runtimeEntryPoint(slotDirectory: string): string {
  return join(slotDirectory, "bin", process.platform === "win32" ? "ats-runtime.cmd" : "ats-runtime");
}

/**
 * Where the owner-private local service credential lives: at the install ROOT,
 * not inside a slot, so a rollback or reinstall does not revoke a credential
 * the running runtime still holds.
 */
export function credentialFilePath(installRoot: string): string {
  return join(installRoot, "runtime-credential");
}

/**
 * Provision the local service credential Spec 2 step 2.4 requires. 32 CSPRNG
 * bytes, written 0600 through the symlink-refusing atomic writer. The VALUE is
 * returned to nobody: callers receive the path, and runtime.json stores only
 * the path, so a leaked state file or support bundle cannot carry the secret.
 */
export async function provisionRuntimeCredential(installRoot: string): Promise<string> {
  const path = credentialFilePath(installRoot);
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

export type Ownership = "owned" | "foreign" | "gone";

/**
 * Decide whether the recorded process is ours.
 *
 * `gone`    — nothing holds that pid; safe to clear state, nothing to signal.
 * `foreign` — something holds the pid but cannot be shown to be our runtime.
 *             NEVER signalled: on a recycled pid that is somebody else's
 *             program.
 * `owned`   — the pid is alive and its start token still matches, or the
 *             handshake names our runtime instance.
 */
export async function processOwnership(
  record: RuntimeRecordV1,
  deps: SupervisorDeps = {},
  signal?: AbortSignal,
): Promise<Ownership> {
  const pid = record.supervisor.pid;
  if (pid === null) return "gone";
  if (!(deps.pidAlive ?? pidAlive)(pid)) return "gone";

  const recorded = record.supervisor.start_token;
  if (recorded !== null) {
    const current = await (deps.startToken ?? processStartToken)(pid);
    // A token we can still read that no longer matches is proof of reuse.
    if (current !== null) return current === recorded ? "owned" : "foreign";
  }

  // No usable token. Fall back to an authenticated handshake; absent that we
  // cannot prove ownership, and unprovable means untouchable.
  if (deps.probeIdentity) {
    try {
      const instance = await deps.probeIdentity({ record, ...(signal ? { signal } : {}) });
      return instance === record.runtime_instance_id ? "owned" : "foreign";
    } catch {
      return "foreign";
    }
  }
  return "foreign";
}

/** Back-compat helper: is a process recorded and alive at all? */
export function recordRunning(record: RuntimeRecordV1, deps: SupervisorDeps = {}): boolean {
  const pid = record.supervisor.pid;
  if (pid === null) return false;
  return (deps.pidAlive ?? pidAlive)(pid);
}

/**
 * Start the runtime.
 *
 * Refuses without a verified installation, and — the part that matters —
 * re-hashes the live slot against its receipt first. A receipt proves what was
 * installed; only a fresh digest proves those are still the bytes about to be
 * executed.
 */
export async function startRuntime(
  recordPath: string,
  record: RuntimeRecordV1,
  deps: SupervisorDeps = {},
): Promise<SupervisorResult> {
  if (!record.installation) {
    return { record, changed: false, reason: "No verified ATS runtime is installed." };
  }
  if ((await processOwnership(record, deps)) === "owned") {
    return { record, changed: false, reason: "The ATS runtime is already running." };
  }
  const spawn = deps.spawn;
  if (!spawn) {
    return { record, changed: false, reason: "No runtime launcher is available on this platform." };
  }

  const resolution = await recoverActiveSlot(record.install_dir, stamp(deps));
  if (!resolution) {
    return { record, changed: false, reason: "No consistent ATS runtime slot is installed." };
  }
  if (!(await verifyActiveTree(record.install_dir, resolution))) {
    return {
      record,
      changed: false,
      reason: "The installed ATS runtime does not match its installation receipt. Reinstall before starting.",
    };
  }

  const dir = slotDir(record.install_dir, resolution.slot);
  let child: SupervisedChild;
  try {
    child = spawn(runtimeEntryPoint(dir), [], {
      cwd: dir,
      // A deliberately narrow environment. The runtime gets its own private
      // directory and credential FILE; inheriting the operator's whole
      // environment would drag broker credentials and provider keys into a
      // process with no need for them (section 14).
      env: {
        ATS_RUNTIME_HOME: dir,
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
      supervisor: { ...record.supervisor, pid: null, started_at: null, start_token: null, last_error: redact(error) },
      updated_at: stamp(deps),
    });
    return { record: next, changed: true, reason: "The ATS runtime failed to start." };
  }

  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    return { record, changed: false, reason: "The ATS runtime did not report a process id." };
  }
  child.unref?.();

  // Captured immediately, while we still know this pid is the process we just
  // spawned. Read later it could already describe a replacement.
  const token = await (deps.startToken ?? processStartToken)(pid);

  const next = await persist(recordPath, {
    ...record,
    installation: resolution.receipt.installation,
    supervisor: {
      pid,
      started_at: stamp(deps),
      start_token: token,
      last_exit_code: null,
      last_error: null,
    },
    updated_at: stamp(deps),
  });
  return { record: next, changed: true, reason: null };
}

const DEFAULT_WAIT_MS = 5_000;

async function waitForExit(pid: number, deps: SupervisorDeps): Promise<boolean> {
  const alive = deps.pidAlive ?? pidAlive;
  const deadline = Date.now() + (deps.waitMs ?? DEFAULT_WAIT_MS);
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

/**
 * Stop the runtime.
 *
 * Only an `owned` process is signalled. A `foreign` pid is disowned — state is
 * cleared so nothing points at it again, but nothing is killed, because on a
 * recycled pid that would terminate an unrelated program. Termination failures
 * are reported rather than swallowed, and only a confirmed exit clears the pid.
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

  const ownership = await processOwnership(record, deps);
  if (ownership === "gone") {
    const next = await clearProcess(recordPath, record, deps, null);
    return { record: next, changed: true, reason: "The ATS runtime was already stopped." };
  }
  if (ownership === "foreign") {
    const next = await clearProcess(recordPath, record, deps,
      "The recorded process id belongs to another program and was not signalled.");
    return {
      record: next,
      changed: true,
      reason: "The recorded process id no longer belongs to this runtime. It was released, not terminated.",
    };
  }

  const terminate = deps.terminate ?? ((target: number) => {
    // Spawned detached, so on POSIX the whole process GROUP is signalled — a
    // runtime that forked workers must not leave them behind.
    terminateProcessTree({ pid: target, kill: (sig?: NodeJS.Signals) => process.kill(target, sig) });
  });
  try {
    terminate(pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH is the one benign failure: the process exited between the
    // ownership check and the signal. Anything else is a real problem and is
    // surfaced rather than hidden behind a success message.
    if (code !== "ESRCH") {
      const next = await persist(recordPath, {
        ...record,
        supervisor: { ...record.supervisor, last_error: redact(error) },
        updated_at: stamp(deps),
      });
      return { record: next, changed: false, reason: "The ATS runtime could not be stopped." };
    }
  }

  if (!(await waitForExit(pid, deps))) {
    const next = await persist(recordPath, {
      ...record,
      supervisor: { ...record.supervisor, last_error: "The runtime did not exit after termination." },
      updated_at: stamp(deps),
    });
    return { record: next, changed: false, reason: "The ATS runtime did not exit. Its process id is still recorded." };
  }

  const next = await clearProcess(recordPath, record, deps, null);
  return { record: next, changed: true, reason: null };
}

async function clearProcess(
  recordPath: string,
  record: RuntimeRecordV1,
  deps: SupervisorDeps,
  lastError: string | null,
): Promise<RuntimeRecordV1> {
  return persist(recordPath, {
    ...record,
    supervisor: {
      pid: null,
      started_at: null,
      start_token: null,
      last_exit_code: record.supervisor.last_exit_code,
      last_error: lastError,
    },
    updated_at: stamp(deps),
  });
}

export async function restartRuntime(
  recordPath: string,
  record: RuntimeRecordV1,
  deps: SupervisorDeps = {},
): Promise<SupervisorResult> {
  const stopped = await stopRuntime(recordPath, record, deps);
  // A stop that did not take is not a base to start from: launching now would
  // leave two runtimes against one memory lease.
  if (stopped.record.supervisor.pid !== null) return stopped;
  return startRuntime(recordPath, stopped.record, deps);
}

/**
 * Observe what the runtime currently honours. Every path that is not "the
 * process is ours AND it answered with a valid snapshot naming this instance"
 * resolves to OFFLINE.
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
  const ownership = await processOwnership(record, deps, signal);
  if (ownership === "gone") return offline("The ATS runtime is not running.");
  if (ownership === "foreign") return offline("The recorded process id no longer belongs to this runtime.");
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
 * Roll back to the other installation slot.
 *
 * This deletes NOTHING. Both slots keep their receipts, and the rollback is
 * the same atomic pointer switch an install ends with — so a rollback can
 * itself be rolled back. The previous implementation removed the displaced
 * tree and nulled the receipt, which left the restored version unstartable and
 * the displaced one gone.
 */
export async function rollbackRuntime(
  recordPath: string,
  record: RuntimeRecordV1,
  deps: SupervisorDeps = {},
): Promise<SupervisorResult> {
  const now = stamp(deps);
  const current = await recoverActiveSlot(record.install_dir, now);
  if (!current) {
    return { record, changed: false, reason: "No ATS runtime slot is installed." };
  }
  const target = otherSlot(current.slot);
  const targetReceipt = await readSlotReceipt(record.install_dir, target);
  if (!targetReceipt) {
    return { record, changed: false, reason: "No previous ATS runtime is available to roll back to." };
  }

  // Stop first: switching the pointer under a live process would leave it
  // running bytes the record no longer describes.
  const stopped = await stopRuntime(recordPath, record, deps);
  if (stopped.record.supervisor.pid !== null) {
    return { record: stopped.record, changed: false, reason: "The ATS runtime could not be stopped, so it was not rolled back." };
  }

  await switchActiveSlot(record.install_dir, {
    schema_version: ACTIVE_POINTER_SCHEMA,
    slot: target,
    installation_id: targetReceipt.installation.installation_id,
    tree_sha256: targetReceipt.tree_sha256,
    switched_at: now,
  });

  // The record now describes the slot that is actually live. It is NOT nulled:
  // the rolled-back version has a real, verified receipt of its own.
  const next = await persist(recordPath, {
    ...stopped.record,
    installation: targetReceipt.installation,
    updated_at: now,
  });
  return {
    record: next,
    changed: true,
    reason: `Rolled back to ATS runtime ${targetReceipt.installation.runtime_version}. The previous slot is retained.`,
  };
}

/**
 * Ordered teardown for an account switch or logout.
 *
 * Stop first, then drop the local authority state. The reverse order would
 * leave a running runtime holding a credential whose record had already been
 * erased — a process nothing can find to stop.
 *
 * The installation and its slots are KEPT: the bytes on disk are still what
 * they were, and section 17's rollback canary requires disabling a runtime
 * without data loss. What is revoked is the credential and the running process.
 */
export async function tearDownForAccountSwitch(
  recordPath: string,
  deps: SupervisorDeps = {},
): Promise<{ stopped: boolean }> {
  const record = await readRuntimeRecord(recordPath);
  if (!record) return { stopped: false };
  const stopped = await stopRuntime(recordPath, record, deps);
  if (record.credential_file) {
    // Revoke rather than reuse: a credential provisioned for one account must
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

export type { SlotResolution };
