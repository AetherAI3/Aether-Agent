// Containment — launching and terminating a task under a Windows Job Object,
// with the Job Object owned by a per-group PowerShell warden.
//
// The safety model, top to bottom:
//   * launchManaged resolves the exe to its CANONICAL path and verifies its
//     sha256 against the caller's expectation BEFORE spawning it — a basename
//     spoof (a different `node.exe` on PATH) is rejected here, and again by the
//     registry.
//   * the task is assigned to a Job Object created with
//     KILL_ON_JOB_CLOSE, so it (and everything it spawns) dies if the warden
//     ever exits — there is no way for a managed group to outlive its warden.
//   * terminateManaged enforces the PID-reuse guard: it refuses to kill when
//     the recorded (pid, start_time) no longer matches, so a recycled PID that
//     now belongs to an unrelated process is never signalled. Only after that
//     check does it TerminateJobObject; taskkill /T is a verified fallback used
//     strictly inside the same managed boundary.
//
// Every OS interaction is injectable (the warden factory, the spawn, the
// start-time probe, the hasher), so unit tests drive the whole flow with a
// mock warden and the win32 integration test drives the real one.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { terminateProcessTree } from "../process_tree_kill.js";
import { PROCESS_GROUP_SCHEMA, type ProcessGroupRegistration } from "./contract.js";
import { getGroup, registerGroup, removeGroup } from "./registry.js";
import { WARDEN_SCRIPT } from "./warden_script.js";

/** The Job Object operations a warden exposes. Mocked wholesale in unit tests. */
export interface WardenHandle {
  ping(): Promise<void>;
  create(name: string): Promise<void>;
  assign(pid: number): Promise<void>;
  list(): Promise<number[]>;
  terminate(): Promise<void>;
  /** Close stdin and tear the warden down (its handle closing kills the job). */
  close(): Promise<void>;
}

export interface SpawnedTask {
  pid: number;
  child: ChildProcess;
}

export interface LaunchSpec {
  /** Controller-minted group id (contract: process_group_id). */
  process_group_id?: string;
  /** The enrolled device this group belongs to. Empty when the launcher is not
   *  enrolled — the Cloud still knows the device from the bearer, but a local
   *  registry entry that names its device is what makes `aether device groups`
   *  readable after a re-enrollment. */
  device_id?: string;
  owner: string;
  project: string;
  workspace_id: string;
  task_id: string;
  /** Path to the executable; resolved to canonical and hash-verified. */
  exe_path: string;
  /** Expected sha256 hex of the exe; a mismatch aborts the launch. */
  exe_sha256: string;
  trusted_publisher: string | null;
  command_classes: string[];
  lease_epoch: number;
  fence_token: string;
  expires_at: number;
  policy_digest: string;
  args: string[];
  cwd: string;
}

export interface ContainmentDeps {
  wardenFactory?: () => Promise<WardenHandle>;
  spawnTask?: (exe: string, args: string[], cwd: string) => SpawnedTask;
  processStartTimeMs?: (pid: number) => number | null;
  hashFileSha256?: (path: string) => string;
  resolveExe?: (path: string) => string;
  now?: () => number;
  uuid?: () => string;
  /** The taskkill-tree fallback, injected so a test can prove exactly when it
   *  does and does not fire. Production is core/process_tree_kill.ts. */
  treeKill?: (pid: number) => void;
}

export interface TerminateResult {
  status: "terminated" | "pid-reuse-blocked" | "unknown";
  via: "job-object" | "tree-kill-fallback" | "none";
  members: number[];
  group_id: string;
}

function defaultHashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Default win32 start-time probe: Get-Process StartTime as unix ms. */
export function defaultProcessStartTimeMs(pid: number): number | null {
  if (process.platform !== "win32") {
    // Non-Windows dev fallback: /proc is not modelled; report unknown so the
    // PID-reuse guard treats the process as gone rather than falsely verified.
    return null;
  }
  try {
    const res = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `try { [int64]([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds() } catch { '' }`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 2500 },
    );
    const ms = Number.parseInt((res.stdout ?? "").trim(), 10);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

function defaultSpawnTask(exe: string, args: string[], cwd: string): SpawnedTask {
  const child = spawn(exe, args, {
    cwd,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (child.pid === undefined) throw new Error("failed to spawn the managed task (no pid)");
  return { pid: child.pid, child };
}

function defaultResolveExe(path: string): string {
  return realpathSync(path);
}

function resolveDeps(deps: ContainmentDeps): Required<ContainmentDeps> {
  return {
    wardenFactory: deps.wardenFactory ?? spawnPowerShellWarden,
    spawnTask: deps.spawnTask ?? defaultSpawnTask,
    processStartTimeMs: deps.processStartTimeMs ?? defaultProcessStartTimeMs,
    hashFileSha256: deps.hashFileSha256 ?? defaultHashFile,
    resolveExe: deps.resolveExe ?? defaultResolveExe,
    now: deps.now ?? Date.now,
    uuid: deps.uuid ?? randomUUID,
    treeKill: deps.treeKill ?? ((pid) => terminateProcessTree({ pid, kill: () => true })),
  };
}

/**
 * Holds the live wardens for the current daemon session and mediates every
 * launch/terminate through the contract's guards. Wardens are session-local:
 * after a restart the KILL_ON_JOB_CLOSE limit has already reaped any orphaned
 * job, so a fresh manager falls back to the PID-reuse-guarded tree kill.
 */
export class ContainmentManager {
  private readonly wardens = new Map<string, WardenHandle>();
  private readonly deps: Required<ContainmentDeps>;

  constructor(deps: ContainmentDeps = {}) {
    this.deps = resolveDeps(deps);
  }

  /** Launch a task inside a fresh Job Object and record its registration. */
  async launchManaged(spec: LaunchSpec): Promise<ProcessGroupRegistration> {
    const canonical = this.deps.resolveExe(spec.exe_path);
    if (!isAbsolute(canonical) || !existsSync(canonical)) {
      throw new Error("managed exe path is not an existing absolute file");
    }
    const actualSha = this.deps.hashFileSha256(canonical);
    if (actualSha !== spec.exe_sha256) {
      throw new Error("managed exe sha256 does not match the expected publisher digest");
    }

    const groupId = spec.process_group_id ?? this.deps.uuid();
    const jobName = `aether-dev-${groupId}`;
    const warden = await this.deps.wardenFactory();
    let task: SpawnedTask;
    try {
      await warden.create(jobName);
      task = this.deps.spawnTask(canonical, spec.args, spec.cwd);
      // Assign as early as possible so descendants the task spawns after this
      // point are created INSIDE the job and inherit its kill-on-close limit.
      await warden.assign(task.pid);
    } catch (err) {
      await warden.close().catch(() => {});
      throw err;
    }

    const startTime = this.deps.processStartTimeMs(task.pid) ?? 0;
    const reg: ProcessGroupRegistration = {
      schema: PROCESS_GROUP_SCHEMA,
      process_group_id: groupId,
      device_id: spec.device_id ?? "",
      owner: spec.owner,
      project: spec.project,
      workspace_id: spec.workspace_id,
      task_id: spec.task_id,
      exe_path: canonical,
      exe_sha256: actualSha,
      trusted_publisher: spec.trusted_publisher,
      parent_pid: task.pid,
      parent_start_time_ms: startTime,
      job_object_name: jobName,
      command_classes: [...spec.command_classes],
      lease_epoch: spec.lease_epoch,
      fence_token: spec.fence_token,
      expires_at: spec.expires_at,
      policy_digest: spec.policy_digest,
      registered_at: this.deps.now(),
    };
    try {
      registerGroup(reg, { hashFileSha256: this.deps.hashFileSha256 });
    } catch (err) {
      // The registry independently rehashes and can still reject; never leave a
      // running-but-unregistered job behind.
      await warden.terminate().catch(() => {});
      await warden.close().catch(() => {});
      throw err;
    }
    this.wardens.set(groupId, warden);
    return reg;
  }

  /** Adopt an already-created warden for a group (used by launchManaged tests). */
  attachWarden(group_id: string, warden: WardenHandle): void {
    this.wardens.set(group_id, warden);
  }

  /**
   * Terminate a managed group. Enforces the PID-reuse guard first: if the
   * recorded (pid, start_time) no longer matches a currently-running process
   * with the same start time, the kill is refused. When the parent is simply
   * gone (start time unknown) the job is still torn down to reap orphans, but
   * the tree-kill fallback — which signals by PID — is skipped.
   */
  async terminateManaged(group_id: string): Promise<TerminateResult> {
    const reg = getGroup(group_id, { now: this.deps.now });
    if (!reg) return { status: "unknown", via: "none", members: [], group_id };

    // A registration whose parent_start_time_ms was never established (probe
    // failed at launch) can never be PID-reuse-verified later, so it is not a
    // safe kill target: a forged or fabricated registration must not become a
    // licence to signal an arbitrary PID. Tear the job down through the warden
    // if we still own one, but never fall back to signalling by PID.
    const parentIdentityKnown = reg.parent_start_time_ms > 0;
    const current = this.deps.processStartTimeMs(reg.parent_pid);
    if (current !== null && current !== reg.parent_start_time_ms) {
      // The PID has been recycled onto a different process. Killing it would hit
      // an innocent bystander — refuse, and leave the (already-dead) registration
      // for the pruner.
      return { status: "pid-reuse-blocked", via: "none", members: [], group_id };
    }
    const parentVerifiedAlive = parentIdentityKnown && current !== null && current === reg.parent_start_time_ms;

    const warden = this.wardens.get(group_id);
    let via: TerminateResult["via"] = "none";
    let members: number[] = [];
    if (warden) {
      try {
        members = await warden.list();
        await warden.terminate();
        via = "job-object";
      } catch {
        // The job terminate itself failed; fall back to a PID-verified tree kill
        // inside the same managed boundary (never a bare basename kill).
        if (parentVerifiedAlive) {
          this.deps.treeKill(reg.parent_pid);
          via = "tree-kill-fallback";
        }
      } finally {
        await warden.close().catch(() => {});
        this.wardens.delete(group_id);
      }
    } else if (parentVerifiedAlive) {
      // No live warden (e.g. after a daemon restart). Only a verified parent may
      // be tree-killed; the KILL_ON_JOB_CLOSE limit already reaped any orphan job.
      this.deps.treeKill(reg.parent_pid);
      via = "tree-kill-fallback";
    }

    removeGroup(group_id);
    return { status: "terminated", via, members, group_id };
  }

  /** Best-effort teardown of every live warden (daemon shutdown). */
  async shutdown(): Promise<void> {
    for (const [id, warden] of this.wardens) {
      await warden.close().catch(() => {});
      this.wardens.delete(id);
    }
  }
}

// ── Real PowerShell warden ──────────────────────────────────────────────────

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

class PowerShellWarden implements WardenHandle {
  private buffer = "";
  private readonly pending: Pending[] = [];
  private closed = false;

  private constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.once("exit", () => {
      this.closed = true;
      const err = new Error("warden exited");
      while (this.pending.length) this.pending.shift()!.reject(err);
    });
  }

  static spawn(): PowerShellWarden {
    const encoded = Buffer.from(WARDEN_SCRIPT, "utf16le").toString("base64");
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    return new PowerShellWarden(child);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      const waiter = this.pending.shift();
      if (!waiter) continue;
      try {
        waiter.resolve(JSON.parse(line) as Record<string, unknown>);
      } catch {
        waiter.reject(new Error(`warden returned unparseable output: ${line.slice(0, 120)}`));
      }
    }
  }

  private request(op: Record<string, unknown>, timeoutMs = 8000): Promise<Record<string, unknown>> {
    if (this.closed || !this.child.stdin?.writable) return Promise.reject(new Error("warden is not running"));
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pending.findIndex((p) => p.resolve === wrappedResolve);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error(`warden op ${String(op["op"])} timed out`));
      }, timeoutMs);
      timer.unref();
      const wrappedResolve = (value: Record<string, unknown>): void => {
        clearTimeout(timer);
        if (value["ok"] === true) resolve(value);
        else reject(new Error(`warden op ${String(op["op"])} failed: ${String(value["error"] ?? "unknown")}`));
      };
      this.pending.push({ resolve: wrappedResolve, reject });
      this.child.stdin!.write(JSON.stringify(op) + "\n");
    });
  }

  async ping(): Promise<void> {
    await this.request({ op: "ping" });
  }
  async create(name: string): Promise<void> {
    await this.request({ op: "create", name });
  }
  async assign(pid: number): Promise<void> {
    await this.request({ op: "assign", pid });
  }
  async list(): Promise<number[]> {
    const res = await this.request({ op: "list" });
    const pids = res["pids"];
    return Array.isArray(pids) ? pids.filter((p): p is number => typeof p === "number") : [];
  }
  async terminate(): Promise<void> {
    await this.request({ op: "terminate" });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin?.end();
    } catch {
      // already gone
    }
    // Give KILL_ON_JOB_CLOSE a moment, then ensure the warden itself is gone.
    await new Promise((r) => setTimeout(r, 50));
    try {
      this.child.kill();
    } catch {
      // already exited
    }
  }
}

/** Default warden factory: spawn a real PowerShell warden and confirm it answers. */
export async function spawnPowerShellWarden(): Promise<WardenHandle> {
  const warden = PowerShellWarden.spawn();
  await warden.ping();
  return warden;
}
