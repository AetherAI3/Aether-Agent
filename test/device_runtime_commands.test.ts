import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyCommand,
  computeCommandDigest,
  executeAccepted,
  loadChain,
  processCommand,
  type AcceptanceContext,
  type ExecutorDeps,
  type GroupCurrency,
} from "../src/core/device_runtime/commands_exec.js";
import { COMMAND_CLASSES, COMMAND_SCHEMA, type CommandClass, type DeviceCommand } from "../src/core/device_runtime/contract.js";
import { ZERO_DIGEST, hmacSha256Hex } from "../src/core/device_runtime/canonical_json.js";

const KEY = "device-command-key";
const DEVICE = "dev-1";

interface CoreOverrides {
  command_id?: string;
  outbox_seq?: number;
  prev_digest?: string;
  expires_at?: number;
  command_class?: CommandClass;
  process_group_id?: string | null;
  lease_epoch?: number;
  fence_token?: string;
  payload?: Record<string, unknown>;
  device_id?: string;
}

/** Build a fully, correctly signed command from a core spec. */
function signed(overrides: CoreOverrides = {}): DeviceCommand {
  const cmd: DeviceCommand = {
    schema: COMMAND_SCHEMA,
    command_id: overrides.command_id ?? "cmd-1",
    device_id: overrides.device_id ?? DEVICE,
    outbox_seq: overrides.outbox_seq ?? 1,
    prev_digest: overrides.prev_digest ?? ZERO_DIGEST,
    issued_at: 1000,
    expires_at: overrides.expires_at ?? 1_000_000,
    command_class: overrides.command_class ?? "noop",
    process_group_id: overrides.process_group_id ?? null,
    lease_epoch: overrides.lease_epoch ?? 0,
    fence_token: overrides.fence_token ?? "",
    payload: overrides.payload ?? {},
    policy_digest: "sha256:" + "0".repeat(64),
    digest: "",
    signature: "",
  };
  cmd.digest = computeCommandDigest(cmd);
  cmd.signature = hmacSha256Hex(KEY, cmd.digest);
  return cmd;
}

function ctx(overrides: Partial<AcceptanceContext> = {}): AcceptanceContext {
  return {
    deviceId: DEVICE,
    commandKey: KEY,
    now: 5000,
    lastDigest: ZERO_DIGEST,
    lastOutboxSeq: 0,
    seenCommandIds: new Set<string>(),
    lookupGroup: () => undefined,
    ...overrides,
  };
}

// ── Red-team acceptance (fail closed) ───────────────────────────────────────

test("a correctly signed, chained command is accepted", () => {
  assert.deepEqual(classifyCommand(signed(), ctx()), { status: "accepted" });
});

test("a forged signature is rejected", () => {
  const cmd = signed();
  cmd.signature = hmacSha256Hex("wrong-key", cmd.digest);
  assert.equal(classifyCommand(cmd, ctx()).status, "rejected");
});

test("a tampered field with a stale digest is rejected", () => {
  const cmd = signed({ command_class: "noop" });
  // Escalate to a destructive class without re-signing.
  cmd.command_class = "emergency_terminate";
  const outcome = classifyCommand(cmd, ctx());
  assert.equal(outcome.status, "rejected");
  assert.match((outcome as { reason: string }).reason, /digest/);
});

test("a broken prev_digest chain is rejected", () => {
  const cmd = signed({ prev_digest: "sha256:" + "1".repeat(64) });
  const outcome = classifyCommand(cmd, ctx({ lastDigest: ZERO_DIGEST }));
  assert.equal(outcome.status, "rejected");
  assert.match((outcome as { reason: string }).reason, /chain/);
});

test("a replayed outbox_seq is a duplicate, not an execution", () => {
  const prev = "sha256:" + "2".repeat(64);
  const cmd = signed({ outbox_seq: 5, prev_digest: prev });
  const outcome = classifyCommand(cmd, ctx({ lastDigest: prev, lastOutboxSeq: 5 }));
  assert.equal(outcome.status, "duplicate");
});

test("an expired command is rejected", () => {
  const cmd = signed({ expires_at: 4000 });
  const outcome = classifyCommand(cmd, ctx({ now: 5000 }));
  assert.equal(outcome.status, "rejected");
  assert.match((outcome as { reason: string }).reason, /expired/);
});

test("a duplicate command_id is rejected as duplicate", () => {
  const cmd = signed({ command_id: "seen" });
  const outcome = classifyCommand(cmd, ctx({ seenCommandIds: new Set(["seen"]) }));
  assert.equal(outcome.status, "duplicate");
});

function group(overrides: Partial<GroupCurrency> = {}): GroupCurrency {
  return { lease_epoch: 1, fence_token: "f", command_classes: [...COMMAND_CLASSES], ...overrides };
}

test("a command for an unknown/expired group is rejected", () => {
  const cmd = signed({ process_group_id: "grp", lease_epoch: 1, fence_token: "f" });
  const outcome = classifyCommand(cmd, ctx({ lookupGroup: () => undefined }));
  assert.equal(outcome.status, "rejected");
  assert.match((outcome as { reason: string }).reason, /unknown or expired/);
});

test("a stale fence_token is rejected", () => {
  const cmd = signed({ process_group_id: "grp", lease_epoch: 1, fence_token: "old" });
  const outcome = classifyCommand(cmd, ctx({ lookupGroup: () => group({ fence_token: "current" }) }));
  assert.equal(outcome.status, "rejected");
  assert.match((outcome as { reason: string }).reason, /fence/);
});

test("a stale lease_epoch is rejected", () => {
  const cmd = signed({ process_group_id: "grp", lease_epoch: 1, fence_token: "f" });
  const outcome = classifyCommand(cmd, ctx({ lookupGroup: () => group({ lease_epoch: 2 }) }));
  assert.equal(outcome.status, "rejected");
  assert.match((outcome as { reason: string }).reason, /lease/);
});

test("a command class the group was NOT granted is rejected", () => {
  // The launcher granted this group observation only; a perfectly signed,
  // perfectly chained emergency_terminate against it is still refused.
  const cmd = signed({ command_class: "emergency_terminate", process_group_id: "grp", lease_epoch: 1, fence_token: "f" });
  const outcome = classifyCommand(cmd, ctx({ lookupGroup: () => group({ command_classes: ["observe"] }) }));
  assert.equal(outcome.status, "rejected");
  assert.match((outcome as { reason: string }).reason, /not granted/);
});

test("a granted command class against a current group is accepted", () => {
  const cmd = signed({ command_class: "emergency_terminate", process_group_id: "grp", lease_epoch: 1, fence_token: "f" });
  const outcome = classifyCommand(cmd, ctx({ lookupGroup: () => group({ command_classes: ["emergency_terminate"] }) }));
  assert.equal(outcome.status, "accepted");
});

// ── The "never kill an unrelated process" boundary ──────────────────────────
//
// There is no path from a DeviceCommand to a process that is not a registered
// managed group: the ONLY process identifier a command carries is a
// process_group_id, and an unregistered one is rejected before any executor
// runs. These three tests are that refusal, stated the way an operator worries
// about it — a browser, an IDE, a Windows service.

test("a destructive command naming an UNMANAGED target never reaches an executor", async () => {
  for (const impostor of ["chrome.exe", "Code.exe", "ChatGPT", "svchost", "node.exe", "1234"]) {
    const cmd = signed({
      command_class: "emergency_terminate",
      process_group_id: impostor,
      lease_epoch: 1,
      fence_token: "f",
    });
    // Nothing by that name was ever registered, so the registry lookup misses.
    const outcome = classifyCommand(cmd, ctx({ lookupGroup: () => undefined }));
    assert.equal(outcome.status, "rejected", `${impostor} must not be accepted`);
    assert.match((outcome as { reason: string }).reason, /unknown or expired/);
  }
});

test("a destructive command with NO process group is rejected, not broadened", async () => {
  for (const cls of ["emergency_terminate", "revoke_group"] as const) {
    const cmd = signed({ command_class: cls, process_group_id: null });
    const outcome = classifyCommand(cmd, ctx());
    assert.equal(outcome.status, "rejected", `${cls} with a null target must be rejected`);
    assert.match((outcome as { reason: string }).reason, /requires an allowlisted process_group_id/);
  }
});

test("processCommand runs NO executor for a command against an unmanaged target", async () => {
  await withConfigDir(async () => {
    const deps = executorDeps();
    const cmd = signed({
      command_id: "kill-the-browser",
      command_class: "emergency_terminate",
      process_group_id: "chrome.exe",
      lease_epoch: 1,
      fence_token: "f",
    });
    const result = await processCommand(cmd, {
      ...deps,
      deviceId: DEVICE,
      boot_id: "b",
      commandKey: KEY,
      lookupGroup: () => undefined,
    });
    assert.equal(result.status, "rejected");
    assert.deepEqual(deps.calls, [], "no executor may run for an unmanaged target");
    // And the chain head did not move, so the Cloud can re-issue cleanly.
    assert.equal(loadChain(DEVICE).last_outbox_seq, 0);
  });
});

test("a command for a different device is rejected", () => {
  const cmd = signed({ device_id: "other" });
  assert.equal(classifyCommand(cmd, ctx()).status, "rejected");
});

// ── Executors ───────────────────────────────────────────────────────────────

function executorDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    setThrottle: () => calls.push("throttle"),
    clearThrottle: () => calls.push("clear"),
    writeCheckpoint: () => {
      calls.push("checkpoint");
      return "cp-1";
    },
    buildWorkspaceHandoff: () => ({ handoff_id: "ho-1", change_digest: "sha256:" + "a".repeat(64) }),
    terminateGroup: async () => {
      calls.push("terminate");
      return { status: "terminated", via: "job-object", members: [1, 2] };
    },
    revokeGroup: () => {
      calls.push("revoke");
      return true;
    },
    now: () => 1000,
    ...overrides,
  };
}

test("throttle executor sets the flag and completes", async () => {
  const deps = executorDeps();
  const out = await executeAccepted(signed({ command_class: "throttle" }), deps);
  assert.equal(out.status, "completed");
  assert.deepEqual(deps.calls, ["throttle"]);
});

test("drain_checkpoint writes a checkpoint and returns the change digest", async () => {
  const deps = executorDeps();
  const out = await executeAccepted(signed({ command_class: "drain_checkpoint" }), deps);
  assert.equal(out.status, "completed");
  assert.equal(out.receipt["checkpoint_id"], "cp-1");
  assert.match(String(out.receipt["change_digest"]), /^sha256:/);
});

test("emergency_terminate checkpoints then terminates the group", async () => {
  const deps = executorDeps();
  const out = await executeAccepted(signed({ command_class: "emergency_terminate", process_group_id: "g" }), deps);
  assert.equal(out.status, "completed");
  assert.deepEqual(deps.calls, ["checkpoint", "terminate"]);
  assert.equal(out.receipt["terminated_group"], "g");
});

test("revoke_group removes the registration", async () => {
  const deps = executorDeps();
  const out = await executeAccepted(signed({ command_class: "revoke_group", process_group_id: "g" }), deps);
  assert.equal(out.status, "completed");
  assert.deepEqual(deps.calls, ["revoke"]);
});

test("resume clears throttle", async () => {
  const deps = executorDeps();
  const out = await executeAccepted(signed({ command_class: "resume" }), deps);
  assert.equal(out.status, "completed");
  assert.deepEqual(deps.calls, ["clear"]);
});

test("a drain checkpoint that would leak fails the command instead", async () => {
  const deps = executorDeps({
    buildWorkspaceHandoff: () => {
      throw new Error("refusing to emit workspace handoff: a field contains an absolute path");
    },
  });
  const out = await executeAccepted(signed({ command_class: "drain_checkpoint" }), deps);
  assert.equal(out.status, "failed");
  assert.match(out.detail, /drain checkpoint failed/);
});

// ── End-to-end persistence ──────────────────────────────────────────────────

function withConfigDir<T>(body: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "aether-dev-cmd-"));
  const prior = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = dir;
  return body().finally(() => {
    if (prior === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = prior;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("processCommand advances the chain on accept and is idempotent on replay", async () => {
  await withConfigDir(async () => {
    const deps = executorDeps();
    const pdeps = {
      ...deps,
      deviceId: DEVICE,
      boot_id: "boot-1",
      commandKey: KEY,
      lookupGroup: () => undefined,
    };
    const cmd = signed({ command_id: "c1", outbox_seq: 1 });
    const first = await processCommand(cmd, pdeps);
    assert.equal(first.status, "completed");
    const chain = loadChain(DEVICE);
    assert.equal(chain.last_outbox_seq, 1);
    assert.equal(chain.last_digest, cmd.digest);

    // Re-delivering the same command returns the stored result, no re-execution.
    deps.calls.length = 0;
    const again = await processCommand(cmd, pdeps);
    assert.equal(again.status, "completed");
    assert.equal(again.result_seq, first.result_seq);
  });
});

test("processCommand records a rejection without advancing the chain head", async () => {
  await withConfigDir(async () => {
    const deps = executorDeps();
    const pdeps = { ...deps, deviceId: DEVICE, boot_id: "b", commandKey: KEY, lookupGroup: () => undefined };
    const forged = signed({ command_id: "bad" });
    forged.signature = "deadbeef";
    const result = await processCommand(forged, pdeps);
    assert.equal(result.status, "rejected");
    assert.equal(loadChain(DEVICE).last_outbox_seq, 0);
  });
});
