// Device daemon — the long-lived, outbound-only process that samples this
// machine, publishes observations, and executes signed Cloud commands.
//
// It is detached and default-off: it refuses to run unless the operator opted
// in (deviceRuntimeEnabled) and the device is enrolled. Two loops run
// concurrently — a sample/publish loop on a jittered cadence, and a command
// long-poll loop — both cancelled cleanly on SIGINT/SIGTERM, at which point
// every live Job Object warden is torn down.
//
// The bottom of the file is the detached entry: `node dist/.../daemon.js` runs
// it. The `aether device start` command spawns exactly that.

import { hostname } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { VERSION } from "../../version.js";
import {
  TelemetrySampler,
  composeObservation,
  defaultTelemetryInputs,
  serializeObservation,
  type ObservationMeta,
  type TelemetryInputs,
} from "./telemetry.js";
import { Publisher } from "./publisher.js";
import { DeviceNet } from "./net.js";
import { ContainmentManager } from "./containment.js";
import { getGroup, listGroups, pruneExpired, removeGroup } from "./registry.js";
import {
  processCommand,
  type ExecutorDeps,
  type GroupCurrency,
} from "./commands_exec.js";
import { toWorkspaceHandoffV1 } from "./handoff_adapter.js";
import { loadEnrollment, nextBootSeq, readSystemBootTimeMs, resolveBootIdentity, type EnrollmentRecord } from "./identity.js";
import { deviceRuntimeEnabled } from "./enablement.js";
import { makeRepoProbe } from "./repo_probe.js";
import { DAEMON_STATE_SCHEMA, writeDaemonState, type DaemonState } from "./daemon_state.js";
import { checkpointDir, deviceRuntimeDir } from "./paths.js";
import type { DeviceCommand } from "./contract.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const MIN_POLL_BACKOFF_MS = 1_000;
const MAX_POLL_BACKOFF_MS = 60_000;
const POLL_BACKOFF_STEPS = 7;

export interface DaemonRunOptions {
  /** Injected for tests; production reads the real config + enrollment. */
  enrollment?: EnrollmentRecord;
  net?: DeviceNet;
  /** When set, the loops run at most this many iterations then return (tests). */
  maxIterations?: number;
  now?: () => number;
  workspaceRoot?: string;
  /** Injected so a test drives repo metadata without a checkout. */
  repoProbe?: () => { name: string; revision: string } | null;
  /** Injected so a test drives the machine curves without touching the OS. */
  telemetryInputs?: TelemetryInputs;
  /** Injected boot-time probe result, so a test never shells out for it. */
  bootTimeMs?: number | null;
}

/** Reason the daemon could not start, or null when it may run. */
export function daemonStartRefusal(): string | null {
  const cfg = loadConfig();
  if (!deviceRuntimeEnabled(cfg)) {
    return "device runtime is disabled — enable it with `aether device` config or AETHER_DEVICE_RUNTIME=1";
  }
  if (!loadEnrollment()) {
    return "device is not enrolled — run `aether device enroll` first";
  }
  return null;
}

class Daemon {
  private stopping = false;
  private throttled = false;
  private lastCommandId: string | null = null;
  private lastPublishSeq = 0;
  private online = false;
  private readonly containment = new ContainmentManager();
  private readonly startedAt: number;

  constructor(
    private readonly enrollment: EnrollmentRecord,
    private readonly net: DeviceNet,
    private readonly sampler: TelemetrySampler,
    private readonly publisher: Publisher,
    private readonly boot_id: string,
    private readonly now: () => number,
    private readonly repoProbe: () => { name: string; revision: string } | null,
  ) {
    this.startedAt = now();
  }

  private meta(seq: number): ObservationMeta {
    const cfg = loadConfig();
    const live = listGroups({ now: this.now });
    // "Active" lanes are the managed groups actually holding a Job Object right
    // now; "reserved" is the operator-declared capacity this device offers, so
    // the Cloud can see headroom rather than inferring it. An undeclared
    // capacity reports the active count — never a number we made up.
    const declaredLanes = cfg.deviceRuntime?.lanes;
    const lanesActive = live.length;
    const lanesReserved =
      typeof declaredLanes === "number" && Number.isFinite(declaredLanes) && declaredLanes >= 0
        ? Math.round(declaredLanes)
        : lanesActive;
    return {
      device_id: this.enrollment.device_id,
      boot_id: this.boot_id,
      seq,
      agent_version: VERSION,
      // Display metadata ONLY. Identity is device_id, which the Cloud minted at
      // enrollment; the hostname never authenticates anything.
      display_name: cfg.deviceRuntime?.displayName ?? this.enrollment.display_name ?? hostname(),
      capabilities: this.capabilities(),
      runtime_labels: [process.platform, `node-${process.versions.node.split(".")[0] ?? "?"}`, `agent-${VERSION}`],
      repo: this.repoProbe(),
      lanes_active: lanesActive,
      lanes_reserved: Math.max(lanesActive, lanesReserved),
      workload_count: live.length,
    };
  }

  /** The contract capabilities this build actually implements on this platform. */
  private capabilities(): string[] {
    const caps = ["aether.device.observe/1", "aether.device.command/1", "aether.workspace-handoff/1"];
    if (process.platform === "win32") caps.push("aether.device.job-object/1");
    return caps;
  }

  private writeState(): void {
    const state: DaemonState = {
      schema: DAEMON_STATE_SCHEMA,
      pid: process.pid,
      started_at: this.startedAt,
      updated_at: this.now(),
      device_id: this.enrollment.device_id,
      boot_id: this.boot_id,
      last_publish_seq: this.lastPublishSeq,
      last_command_id: this.lastCommandId,
      throttled: this.throttled,
      queue_depth: this.publisher.queueDepth(),
      online: this.online,
      agent_version: VERSION,
    };
    try {
      writeDaemonState(state);
    } catch {
      // A transient state-write failure must not crash the daemon.
    }
  }

  private executorDeps(): ExecutorDeps {
    return {
      setThrottle: (active) => {
        this.throttled = active;
      },
      clearThrottle: () => {
        this.throttled = false;
      },
      writeCheckpoint: (record) => this.writeCheckpoint(record),
      buildWorkspaceHandoff: (cmd) => this.buildWorkspaceHandoff(cmd),
      terminateGroup: (id) => this.containment.terminateManaged(id),
      revokeGroup: (id) => removeGroup(id),
      now: this.now,
    };
  }

  private writeCheckpoint(record: Record<string, unknown>): string {
    const id = randomUUID();
    mkdirSync(checkpointDir(), { recursive: true, mode: 0o700 });
    const path = join(checkpointDir(), `${id}.json`);
    writeFileSync(path, JSON.stringify({ id, ...record }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    return id;
  }

  private buildWorkspaceHandoff(cmd: DeviceCommand): { handoff_id: string; change_digest: string } {
    const p = cmd.payload;
    const str = (k: string): string => (typeof p[k] === "string" ? (p[k] as string) : "");
    const handoff = toWorkspaceHandoffV1({
      handoff_id: str("handoff_id") || randomUUID(),
      task_id: str("task_id"),
      lane_id: str("lane_id"),
      dag_node_id: str("dag_node_id"),
      fence_token: cmd.fence_token,
      lease_epoch: cmd.lease_epoch,
      // The controller's repo facts win; otherwise fall back to what this
      // machine actually has checked out, so a drain checkpoint is still
      // attributable to an exact revision rather than to nothing.
      repo: payloadRepo(p) ?? this.repoProbe() ?? { name: "", revision: "" },
      patch_refs: Array.isArray(p["patch_refs"]) ? (p["patch_refs"] as WorkspacePatchRef[]).map((r) => ({ ref: String(r.ref), sha256: String(r.sha256), bytes: Number(r.bytes) })) : [],
      change_digest: str("change_digest"),
      test_cmd: str("test_cmd"),
      test_verified: p["test_verified"] === true,
      remaining_summary: str("remaining_summary"),
      policy_digest: cmd.policy_digest,
      skill_digest: typeof p["skill_digest"] === "string" ? (p["skill_digest"] as string) : null,
      protocol_c_refs: Array.isArray(p["protocol_c_refs"]) ? (p["protocol_c_refs"] as unknown[]).filter((x): x is string => typeof x === "string") : [],
      source_device_id: this.enrollment.device_id,
      created_at: this.now(),
    });
    // Offer it to the Cloud best-effort; a failed offer never fails the command.
    void this.net.offerHandoff(handoff).catch(() => {});
    return { handoff_id: handoff.handoff_id, change_digest: handoff.change_digest };
  }

  private lookupGroup(id: string): GroupCurrency | undefined {
    const g = getGroup(id, { now: this.now });
    return g
      ? { lease_epoch: g.lease_epoch, fence_token: g.fence_token, command_classes: [...g.command_classes] }
      : undefined;
  }

  async runSampleLoop(maxIterations: number | undefined): Promise<void> {
    let iterations = 0;
    while (!this.stopping) {
      pruneExpired({ now: this.now });
      const seq = nextBootSeq();
      const metrics = this.sampler.sample();
      const observation = serializeObservation(composeObservation(this.meta(seq), metrics));
      this.publisher.enqueue(observation);
      const result = await this.publisher.drain((obs) => this.net.observe(obs));
      this.online = !result.backedOff;
      this.lastPublishSeq = seq;
      this.writeState();
      iterations += 1;
      if (maxIterations !== undefined && iterations >= maxIterations) return;
      const wait = this.publisher.isBackedOff() ? this.publisher.currentBackoffMs() : this.publisher.nextIntervalMs();
      await sleep(wait);
    }
  }

  async runPollLoop(maxIterations: number | undefined): Promise<void> {
    let iterations = 0;
    let pollFailures = 0;
    while (!this.stopping) {
      let commands: DeviceCommand[] = [];
      try {
        commands = await this.net.pollCommands(25);
        pollFailures = 0;
      } catch {
        // Same bounded, jittered backoff the publisher uses, so a Cloud outage
        // does not turn the poll loop into a tight reconnect storm.
        pollFailures = Math.min(pollFailures + 1, POLL_BACKOFF_STEPS);
        if (maxIterations === undefined) await sleep(this.pollBackoffMs(pollFailures));
      }
      for (const cmd of commands) {
        const result = await processCommand(cmd, {
          ...this.executorDeps(),
          deviceId: this.enrollment.device_id,
          boot_id: this.boot_id,
          commandKey: this.enrollment.device_command_key,
          lookupGroup: (id) => this.lookupGroup(id),
        });
        this.lastCommandId = cmd.command_id;
        this.writeState();
        try {
          await this.net.postResult(result);
        } catch {
          // A result we cannot deliver is retried by the Cloud re-issuing.
        }
      }
      iterations += 1;
      if (maxIterations !== undefined && iterations >= maxIterations) return;
    }
  }

  /** Exponential 1s → 60s with ±25% jitter, keyed on the consecutive failures. */
  private pollBackoffMs(failures: number): number {
    const exp = Math.min(MAX_POLL_BACKOFF_MS, MIN_POLL_BACKOFF_MS * 2 ** (failures - 1));
    const jitter = 1 + (Math.random() * 2 - 1) * 0.25;
    return Math.max(MIN_POLL_BACKOFF_MS, Math.min(MAX_POLL_BACKOFF_MS, Math.round(exp * jitter)));
  }

  stop(): void {
    this.stopping = true;
  }

  async shutdown(): Promise<void> {
    await this.containment.shutdown();
  }
}

interface WorkspacePatchRef {
  ref: unknown;
  sha256: unknown;
  bytes: unknown;
}

/** `{name, revision}` from a command payload, or null when it names neither. */
function payloadRepo(p: Record<string, unknown>): { name: string; revision: string } | null {
  const repo = p["repo"];
  if (!repo || typeof repo !== "object" || Array.isArray(repo)) return null;
  const r = repo as Record<string, unknown>;
  const name = typeof r["name"] === "string" ? r["name"] : "";
  const revision = typeof r["revision"] === "string" ? r["revision"] : "";
  return name || revision ? { name, revision } : null;
}

/**
 * Run the daemon. Resolves the boot identity, wires the sampler/publisher/net,
 * and drives both loops until stopped. Returns a process exit code.
 */
export async function runDeviceDaemon(options: DaemonRunOptions = {}): Promise<number> {
  const now = options.now ?? Date.now;
  const cfg = loadConfig();
  const enrollment = options.enrollment ?? loadEnrollment();
  // The default-off gate is unconditional: an injected enrollment is a test
  // seam for identity, never a way past the operator's opt-in.
  if (!deviceRuntimeEnabled(cfg)) {
    process.stderr.write("device runtime is disabled; refusing to start\n");
    return 3;
  }
  if (!enrollment) {
    process.stderr.write("device is not enrolled; refusing to start\n");
    return 4;
  }
  mkdirSync(deviceRuntimeDir(), { recursive: true, mode: 0o700 });
  const boot = resolveBootIdentity(
    options.bootTimeMs !== undefined ? options.bootTimeMs : readSystemBootTimeMs(),
    now,
  );
  const net = options.net ?? new DeviceNet(enrollment.base_url, enrollment.device_token);
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const sampler = new TelemetrySampler(options.telemetryInputs ?? defaultTelemetryInputs(workspaceRoot, now));
  const publisher = new Publisher();
  const repoProbe = options.repoProbe ?? makeRepoProbe(workspaceRoot, now);
  const daemon = new Daemon(enrollment, net, sampler, publisher, boot.boot_id, now, repoProbe);

  const onSignal = (): void => daemon.stop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await Promise.all([daemon.runSampleLoop(options.maxIterations), daemon.runPollLoop(options.maxIterations)]);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await daemon.shutdown();
  }
  return 0;
}

const invoked = process.argv[1]
  ? fileURLToPath(import.meta.url) === process.argv[1] || fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()
  : false;
if (invoked) {
  runDeviceDaemon().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    process.stderr.write(`device daemon crashed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
