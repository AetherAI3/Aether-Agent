// Command acceptance + execution — the FAIL-CLOSED gate for DeviceCommands.
//
// A command is a signed, chained instruction from the Cloud. Before ANY side
// effect, every one of these must hold, or the command is rejected with no
// partial execution (contract §DeviceCommand):
//
//   1. structural shape and a known command_class,
//   2. device_id matches this device,
//   3. digest == sha256(canonical(command without digest+signature)),
//   4. signature == HMAC-SHA256(device_command_key, digest),
//   5. command_id not already seen (else "duplicate", idempotent),
//   6. not expired,
//   7. prev_digest continues this device's outbox chain,
//   8. outbox_seq strictly advances (a replay is "duplicate"),
//   9. when a process_group_id is named, it is a currently-registered group
//      whose lease_epoch and fence_token both match.
//
// Only then does the executor run, and every path produces a bounded,
// secret-redacted CommandResult. Chain state (last seq, last digest, seen ids,
// idempotent results) is persisted per device under its own lock.

import { redactForBundle } from "../redaction.js";
import { atomicWriteFile, readJsonFile, withFileLock } from "../durable_store.js";
import { mkdirSync } from "node:fs";
import {
  COMMAND_CLASSES,
  COMMAND_RESULT_SCHEMA,
  COMMAND_SCHEMA,
  type CommandClass,
  type CommandResult,
  type CommandResultStatus,
  type DeviceCommand,
  type DeviceCommandCore,
} from "./contract.js";
import { ZERO_DIGEST, digestOf, hmacSha256Hex, timingSafeHexEqual } from "./canonical_json.js";
import { commandChainLockPath, commandChainPath, deviceRuntimeDir } from "./paths.js";

const MAX_DETAIL = 2000;
const MAX_SEEN_IDS = 400;

export interface ChainState {
  device_id: string;
  last_outbox_seq: number;
  last_digest: string;
  seen_command_ids: string[];
  result_seq: number;
  results: Record<string, CommandResult>;
}

export interface GroupCurrency {
  lease_epoch: number;
  fence_token: string;
  /** The command classes the launcher granted this group. A class outside this
   *  set is refused even with a perfect signature — authority is per-group. */
  command_classes: string[];
}

/**
 * Command classes that act ON a managed process group. Each one is meaningless
 * — and dangerous — without an explicitly allowlisted target, so a command in
 * one of these classes with a null process_group_id is rejected before any side
 * effect. This is the rule that stops a signed `emergency_terminate` with no
 * target from ever becoming "terminate whatever is running": there is no path
 * from a DeviceCommand to a process that is not a registered managed group.
 */
export const GROUP_SCOPED_CLASSES: ReadonlySet<CommandClass> = new Set<CommandClass>([
  "emergency_terminate",
  "revoke_group",
]);

export interface AcceptanceContext {
  deviceId: string;
  commandKey: string;
  now: number;
  lastDigest: string;
  lastOutboxSeq: number;
  seenCommandIds: ReadonlySet<string>;
  lookupGroup: (id: string) => GroupCurrency | undefined;
}

export type Classification =
  | { status: "accepted" }
  | { status: "rejected"; reason: string }
  | { status: "duplicate"; reason: string };

function isCommandClass(value: unknown): value is CommandClass {
  return typeof value === "string" && (COMMAND_CLASSES as readonly string[]).includes(value);
}

/** The digest a command should carry: sha256 over its canonical core. */
export function computeCommandDigest(cmd: DeviceCommand): string {
  const core: DeviceCommandCore = {
    schema: cmd.schema,
    command_id: cmd.command_id,
    device_id: cmd.device_id,
    outbox_seq: cmd.outbox_seq,
    prev_digest: cmd.prev_digest,
    issued_at: cmd.issued_at,
    expires_at: cmd.expires_at,
    command_class: cmd.command_class,
    process_group_id: cmd.process_group_id,
    lease_epoch: cmd.lease_epoch,
    fence_token: cmd.fence_token,
    payload: cmd.payload,
    policy_digest: cmd.policy_digest,
  };
  return digestOf(core);
}

/**
 * Pure classification of a command against the acceptance context. No side
 * effects — the caller persists state only for the outcome this returns.
 */
export function classifyCommand(cmd: DeviceCommand, ctx: AcceptanceContext): Classification {
  // 1. structural shape
  if (cmd.schema !== COMMAND_SCHEMA) return { status: "rejected", reason: "wrong schema" };
  if (!isCommandClass(cmd.command_class)) return { status: "rejected", reason: "unknown command_class" };
  if (typeof cmd.command_id !== "string" || !cmd.command_id) return { status: "rejected", reason: "missing command_id" };
  if (typeof cmd.outbox_seq !== "number" || !Number.isInteger(cmd.outbox_seq)) return { status: "rejected", reason: "invalid outbox_seq" };
  if (typeof cmd.digest !== "string" || typeof cmd.signature !== "string") return { status: "rejected", reason: "missing digest or signature" };
  if (typeof cmd.prev_digest !== "string") return { status: "rejected", reason: "missing prev_digest" };
  if (!cmd.payload || typeof cmd.payload !== "object" || Array.isArray(cmd.payload)) return { status: "rejected", reason: "invalid payload" };

  // 2. device identity
  if (cmd.device_id !== ctx.deviceId) return { status: "rejected", reason: "device_id mismatch" };

  // 3. digest integrity (catches any tampered field)
  const expectedDigest = computeCommandDigest(cmd);
  if (cmd.digest !== expectedDigest) return { status: "rejected", reason: "digest does not match command body" };

  // 4. signature authenticity
  const expectedSig = hmacSha256Hex(ctx.commandKey, cmd.digest);
  if (!timingSafeHexEqual(cmd.signature, expectedSig)) return { status: "rejected", reason: "signature verification failed" };

  // 5. idempotency
  if (ctx.seenCommandIds.has(cmd.command_id)) return { status: "duplicate", reason: "command_id already processed" };

  // 6. expiry
  if (!Number.isInteger(cmd.expires_at) || ctx.now > cmd.expires_at) return { status: "rejected", reason: "command expired" };

  // 7. chain continuity
  if (cmd.prev_digest !== ctx.lastDigest) return { status: "rejected", reason: "prev_digest does not continue the outbox chain" };

  // 8. monotonic sequence (a replay of a consumed seq is a duplicate)
  if (cmd.outbox_seq <= ctx.lastOutboxSeq) return { status: "duplicate", reason: "outbox_seq already consumed" };

  // 9. group / lease / fence currency, and the group's GRANTED command classes.
  if (cmd.process_group_id !== null) {
    if (typeof cmd.process_group_id !== "string" || !cmd.process_group_id) {
      return { status: "rejected", reason: "invalid process_group_id" };
    }
    const group = ctx.lookupGroup(cmd.process_group_id);
    if (!group) return { status: "rejected", reason: "process group is unknown or expired" };
    if (group.lease_epoch !== cmd.lease_epoch) return { status: "rejected", reason: "lease_epoch is stale" };
    if (group.fence_token !== cmd.fence_token) return { status: "rejected", reason: "fence_token is stale" };
    if (!group.command_classes.includes(cmd.command_class)) {
      return { status: "rejected", reason: "command_class is not granted to this process group" };
    }
  } else if (GROUP_SCOPED_CLASSES.has(cmd.command_class)) {
    // A group-scoped class with no target has nothing it is allowed to touch.
    // Refusing here — rather than at execution — means the chain head never
    // advances on an untargeted destructive command.
    return { status: "rejected", reason: `${cmd.command_class} requires an allowlisted process_group_id` };
  }
  return { status: "accepted" };
}

/** Bound + redact a free-text detail string for a CommandResult. */
export function boundDetail(detail: string): string {
  return redactForBundle(detail).slice(0, MAX_DETAIL);
}

export function buildResult(args: {
  command_id: string;
  device_id: string;
  boot_id: string;
  result_seq: number;
  status: CommandResultStatus;
  detail: string;
  receipt: Record<string, unknown>;
  completed_at: number;
}): CommandResult {
  return {
    schema: COMMAND_RESULT_SCHEMA,
    command_id: args.command_id,
    device_id: args.device_id,
    boot_id: args.boot_id,
    result_seq: args.result_seq,
    status: args.status,
    detail: boundDetail(args.detail),
    receipt: args.receipt,
    completed_at: args.completed_at,
  };
}

// ── Executors ───────────────────────────────────────────────────────────────

export interface ExecutorDeps {
  /** Set the daemon's throttle flag; while true it launches no new children. */
  setThrottle: (active: boolean, payload: Record<string, unknown>) => void;
  /** Clear throttle/pause so the device resumes normal launching. */
  clearThrottle: () => void;
  /** Write a durable checkpoint record; returns an opaque checkpoint id. */
  writeCheckpoint: (record: Record<string, unknown>) => string;
  /** Build + validate a workspace handoff from the command; may throw on a leak. */
  buildWorkspaceHandoff: (cmd: DeviceCommand) => { handoff_id: string; change_digest: string };
  /** Terminate a managed group; returns a short status + how it was done. */
  terminateGroup: (group_id: string) => Promise<{ status: string; via: string; members: number[] }>;
  /** Fence + remove a group's registration (revoke). Returns true if present. */
  revokeGroup: (group_id: string) => boolean;
  now: () => number;
}

export interface ExecutionOutcome {
  status: CommandResultStatus;
  detail: string;
  receipt: Record<string, unknown>;
}

/** Run an already-ACCEPTED command's side effect. Never called for rejected. */
export async function executeAccepted(cmd: DeviceCommand, deps: ExecutorDeps): Promise<ExecutionOutcome> {
  switch (cmd.command_class) {
    case "throttle": {
      deps.setThrottle(true, cmd.payload);
      return { status: "completed", detail: "throttled: no new children", receipt: { throttled: true } };
    }
    case "resume": {
      deps.clearThrottle();
      return { status: "completed", detail: "resumed normal launching", receipt: { resumed: true } };
    }
    case "observe": {
      return { status: "completed", detail: "observation acknowledged", receipt: { observed: true } };
    }
    case "noop": {
      return { status: "completed", detail: "noop", receipt: {} };
    }
    case "drain_checkpoint": {
      try {
        const ho = deps.buildWorkspaceHandoff(cmd);
        const checkpointId = deps.writeCheckpoint({
          kind: "drain_checkpoint",
          command_id: cmd.command_id,
          handoff_id: ho.handoff_id,
          change_digest: ho.change_digest,
          at: deps.now(),
        });
        return {
          status: "completed",
          detail: "drain checkpoint written",
          receipt: { checkpoint_id: checkpointId, change_digest: ho.change_digest, handoff_id: ho.handoff_id },
        };
      } catch (err) {
        return { status: "failed", detail: `drain checkpoint failed: ${errText(err)}`, receipt: { failed: true } };
      }
    }
    case "emergency_terminate": {
      if (cmd.process_group_id === null) {
        return { status: "failed", detail: "emergency_terminate requires a process_group_id", receipt: { failed: true } };
      }
      // Best-effort checkpoint first, then terminate regardless of its outcome.
      const receipt: Record<string, unknown> = {};
      try {
        const ho = deps.buildWorkspaceHandoff(cmd);
        const checkpointId = deps.writeCheckpoint({
          kind: "emergency_checkpoint",
          command_id: cmd.command_id,
          handoff_id: ho.handoff_id,
          change_digest: ho.change_digest,
          at: deps.now(),
        });
        receipt["checkpoint_id"] = checkpointId;
        receipt["change_digest"] = ho.change_digest;
      } catch (err) {
        receipt["checkpoint_skipped"] = errText(err);
      }
      const outcome = await deps.terminateGroup(cmd.process_group_id);
      receipt["terminated_group"] = cmd.process_group_id;
      receipt["terminate_status"] = outcome.status;
      receipt["terminate_via"] = outcome.via;
      const ok = outcome.status === "terminated";
      return {
        status: ok ? "completed" : "failed",
        detail: ok ? "managed group terminated" : `terminate not applied: ${outcome.status}`,
        receipt,
      };
    }
    case "revoke_group": {
      if (cmd.process_group_id === null) {
        return { status: "failed", detail: "revoke_group requires a process_group_id", receipt: { failed: true } };
      }
      const removed = deps.revokeGroup(cmd.process_group_id);
      return {
        status: "completed",
        detail: removed ? "group revoked" : "group was not registered",
        receipt: { revoked_group: cmd.process_group_id, was_present: removed },
      };
    }
    default: {
      // Exhaustive: COMMAND_CLASSES is closed and classified above.
      return { status: "failed", detail: "unhandled command class", receipt: { failed: true } };
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Chain state persistence ─────────────────────────────────────────────────

export function emptyChain(deviceId: string): ChainState {
  return {
    device_id: deviceId,
    last_outbox_seq: 0,
    last_digest: ZERO_DIGEST,
    seen_command_ids: [],
    result_seq: 0,
    results: {},
  };
}

export function loadChain(deviceId: string): ChainState {
  const read = readJsonFile<ChainState>(commandChainPath());
  if (!read.ok) return emptyChain(deviceId);
  const v = read.value;
  if (!v || v.device_id !== deviceId || typeof v.last_outbox_seq !== "number" || typeof v.last_digest !== "string") {
    // A chain for a DIFFERENT device (re-enrollment) must not be reused — its
    // seq/digest would reject or mis-accept the new device's outbox.
    return emptyChain(deviceId);
  }
  return {
    device_id: deviceId,
    last_outbox_seq: v.last_outbox_seq,
    last_digest: v.last_digest,
    seen_command_ids: Array.isArray(v.seen_command_ids) ? v.seen_command_ids.slice(-MAX_SEEN_IDS) : [],
    result_seq: typeof v.result_seq === "number" ? v.result_seq : 0,
    results: v.results && typeof v.results === "object" ? v.results : {},
  };
}

function saveChain(state: ChainState): void {
  mkdirSync(deviceRuntimeDir(), { recursive: true, mode: 0o700 });
  // Keep the idempotent-result map bounded to the same window as seen ids.
  const trimmedSeen = state.seen_command_ids.slice(-MAX_SEEN_IDS);
  const keep = new Set(trimmedSeen);
  const results: Record<string, CommandResult> = {};
  for (const [id, r] of Object.entries(state.results)) if (keep.has(id)) results[id] = r;
  const out: ChainState = { ...state, seen_command_ids: trimmedSeen, results };
  atomicWriteFile(commandChainPath(), JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
}

export interface ProcessDeps extends ExecutorDeps {
  deviceId: string;
  boot_id: string;
  commandKey: string;
  lookupGroup: (id: string) => GroupCurrency | undefined;
}

/**
 * The whole per-command transaction: classify against persisted chain state,
 * execute only if accepted, and record the (idempotent) result. Serialized on
 * the chain lock — which is a DIFFERENT lock from the group registry's, so
 * executors are free to call the registry without self-deadlocking.
 */
export async function processCommand(cmd: DeviceCommand, deps: ProcessDeps): Promise<CommandResult> {
  mkdirSync(deviceRuntimeDir(), { recursive: true, mode: 0o700 });

  // Snapshot chain state and classify under the lock; do not execute yet.
  const decision = withFileLock(commandChainLockPath(), "device-chain-classify", () => {
    const chain = loadChain(deps.deviceId);
    const ctx: AcceptanceContext = {
      deviceId: deps.deviceId,
      commandKey: deps.commandKey,
      now: deps.now(),
      lastDigest: chain.last_digest,
      lastOutboxSeq: chain.last_outbox_seq,
      seenCommandIds: new Set(chain.seen_command_ids),
      lookupGroup: deps.lookupGroup,
    };
    const classification = classifyCommand(cmd, ctx);
    return { chain, classification };
  });

  // A duplicate returns the stored result verbatim when we have one.
  if (decision.classification.status === "duplicate") {
    const prior = decision.chain.results[cmd.command_id];
    if (prior) return prior;
    return recordNonAccepted(cmd, deps, "duplicate", decision.classification.reason);
  }
  if (decision.classification.status === "rejected") {
    return recordNonAccepted(cmd, deps, "rejected", decision.classification.reason);
  }

  // Accepted: execute the side effect OUTSIDE the chain lock, then commit.
  const outcome = await executeAccepted(cmd, deps);
  return withFileLock(commandChainLockPath(), "device-chain-commit", () => {
    const chain = loadChain(deps.deviceId);
    const result_seq = chain.result_seq + 1;
    const result = buildResult({
      command_id: cmd.command_id,
      device_id: deps.deviceId,
      boot_id: deps.boot_id,
      result_seq,
      status: outcome.status,
      detail: outcome.detail,
      receipt: outcome.receipt,
      completed_at: deps.now(),
    });
    saveChain({
      device_id: deps.deviceId,
      last_outbox_seq: cmd.outbox_seq,
      last_digest: cmd.digest,
      seen_command_ids: [...chain.seen_command_ids, cmd.command_id],
      result_seq,
      results: { ...chain.results, [cmd.command_id]: result },
    });
    return result;
  });
}

/** Record a rejected/duplicate result without advancing the chain head. */
function recordNonAccepted(
  cmd: DeviceCommand,
  deps: ProcessDeps,
  status: "rejected" | "duplicate",
  reason: string,
): CommandResult {
  return withFileLock(commandChainLockPath(), "device-chain-nonaccepted", () => {
    const chain = loadChain(deps.deviceId);
    const existing = chain.results[cmd.command_id];
    if (existing) return existing;
    const result_seq = chain.result_seq + 1;
    const result = buildResult({
      command_id: cmd.command_id,
      device_id: deps.deviceId,
      boot_id: deps.boot_id,
      result_seq,
      status,
      detail: reason,
      receipt: { rejected_reason: reason },
      completed_at: deps.now(),
    });
    saveChain({
      device_id: chain.device_id,
      last_outbox_seq: chain.last_outbox_seq,
      last_digest: chain.last_digest,
      seen_command_ids: [...chain.seen_command_ids, cmd.command_id],
      result_seq,
      results: { ...chain.results, [cmd.command_id]: result },
    });
    return result;
  });
}
