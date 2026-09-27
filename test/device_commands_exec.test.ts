// Command acceptance is the device's authorisation boundary: a DeviceCommand is
// the only thing that can throttle a machine, checkpoint a workspace, or kill a
// process group. It is therefore FAIL CLOSED, and this file is the red team —
// every check in the contract gets its own mutation, and each mutation must be
// the ONLY reason the command is refused.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  classifyCommand,
  computeCommandDigest,
  boundDetail,
  buildResult,
  emptyChain,
  executeAccepted,
  loadChain,
  processCommand,
  type AcceptanceContext,
  type ExecutorDeps,
  type GroupCurrency,
  type ProcessDeps,
} from "../src/core/device_runtime/commands_exec.js";
import {
  COMMAND_CLASSES,
  COMMAND_RESULT_SCHEMA,
  type DeviceCommand,
} from "../src/core/device_runtime/contract.js";
import { ZERO_DIGEST } from "../src/core/device_runtime/canonical_json.js";
import {
  TEST_COMMAND_KEY,
  TEST_DEVICE_ID,
  signedCommand,
  withDeviceSandboxAsync,
} from "./device_sandbox.js";

// Granted every class, so these cases isolate the acceptance checks they name.
// Per-group class authority has its own dedicated tests.
const LIVE_GROUP: GroupCurrency = {
  lease_epoch: 4,
  fence_token: "fence-current",
  command_classes: [...COMMAND_CLASSES],
};

function ctx(overrides: Partial<AcceptanceContext> = {}): AcceptanceContext {
  return {
    deviceId: TEST_DEVICE_ID,
    commandKey: TEST_COMMAND_KEY,
    now: 5_000_000,
    lastDigest: ZERO_DIGEST,
    lastOutboxSeq: 0,
    seenCommandIds: new Set<string>(),
    lookupGroup: (id) => (id === "grp-live" ? LIVE_GROUP : undefined),
    ...overrides,
  };
}

test("a well-formed, correctly-signed, in-chain command is accepted", () => {
  const cmd = signedCommand();
  assert.deepEqual(classifyCommand(cmd, ctx()), { status: "accepted" });
  // The digest the Cloud computed must be reproducible byte-for-byte here.
  assert.equal(computeCommandDigest(cmd), cmd.digest);
});

test("RED TEAM: a forged signature is rejected", () => {
  // Signed with the WRONG key — body is otherwise perfect and self-consistent.
  const attacker = signedCommand({}, "attacker-key-not-the-device-key");
  const decision = classifyCommand(attacker, ctx());
  assert.equal(decision.status, "rejected");
  assert.match(decision.status === "rejected" ? decision.reason : "", /signature verification failed/);

  // A hand-written signature of the right shape is equally refused.
  const spoofed: DeviceCommand = { ...signedCommand(), signature: "f".repeat(64) };
  assert.equal(classifyCommand(spoofed, ctx()).status, "rejected");
  // And a truncated one cannot slip through the constant-time comparison.
  assert.equal(classifyCommand({ ...signedCommand(), signature: "" }, ctx()).status, "rejected");
});

test("RED TEAM: a tampered body is caught by the digest before the signature is even trusted", () => {
  const original = signedCommand({ command_class: "noop" });
  // Escalate noop -> emergency_terminate while keeping the original digest and
  // signature. The digest recomputation catches it.
  const escalated: DeviceCommand = { ...original, command_class: "emergency_terminate", process_group_id: "grp-live" };
  const decision = classifyCommand(escalated, ctx());
  assert.equal(decision.status, "rejected");
  assert.match(decision.status === "rejected" ? decision.reason : "", /digest does not match/);

  // Every signed field is covered, not just command_class.
  for (const mutation of [
    { expires_at: 9_999_999_999 },
    { lease_epoch: 99 },
    { fence_token: "fence-attacker" },
    { payload: { evil: true } },
    { policy_digest: `sha256:${"b".repeat(64)}` },
    { outbox_seq: 7 },
  ] as Array<Partial<DeviceCommand>>) {
    const mutated = { ...original, ...mutation } as DeviceCommand;
    assert.equal(classifyCommand(mutated, ctx()).status, "rejected", `mutation ${JSON.stringify(mutation)} must be rejected`);
  }
});

test("RED TEAM: a broken prev_digest chain is rejected", () => {
  const priorHead = `sha256:${"c".repeat(64)}`;
  // Correctly signed and fresh, but it does not continue THIS device's chain —
  // a command lifted from another outbox, or one that skips a link.
  const orphan = signedCommand({ prev_digest: `sha256:${"9".repeat(64)}`, outbox_seq: 5 });
  const decision = classifyCommand(orphan, ctx({ lastDigest: priorHead, lastOutboxSeq: 4 }));
  assert.equal(decision.status, "rejected");
  assert.match(decision.status === "rejected" ? decision.reason : "", /prev_digest does not continue/);

  // The same command WITH the correct link is accepted, isolating the cause.
  const linked = signedCommand({ prev_digest: priorHead, outbox_seq: 5 });
  assert.equal(classifyCommand(linked, ctx({ lastDigest: priorHead, lastOutboxSeq: 4 })).status, "accepted");
});

test("RED TEAM: a replayed outbox_seq is a duplicate, never a re-execution", () => {
  const head = `sha256:${"c".repeat(64)}`;
  const replay = signedCommand({ prev_digest: head, outbox_seq: 4 });
  const decision = classifyCommand(replay, ctx({ lastDigest: head, lastOutboxSeq: 4 }));
  assert.equal(decision.status, "duplicate");
  assert.match(decision.status === "duplicate" ? decision.reason : "", /outbox_seq already consumed/);

  // A seq that goes BACKWARDS is likewise a duplicate, not an acceptance.
  assert.equal(classifyCommand(signedCommand({ prev_digest: head, outbox_seq: 1 }), ctx({ lastDigest: head, lastOutboxSeq: 4 })).status, "duplicate");
});

test("RED TEAM: an already-seen command_id is a duplicate", () => {
  const id = randomUUID();
  const cmd = signedCommand({ command_id: id });
  const decision = classifyCommand(cmd, ctx({ seenCommandIds: new Set([id]) }));
  assert.equal(decision.status, "duplicate");
  assert.match(decision.status === "duplicate" ? decision.reason : "", /already processed/);
});

test("RED TEAM: an expired command is rejected", () => {
  const cmd = signedCommand({ issued_at: 1_000, expires_at: 2_000 });
  const decision = classifyCommand(cmd, ctx({ now: 2_001 }));
  assert.equal(decision.status, "rejected");
  assert.match(decision.status === "rejected" ? decision.reason : "", /command expired/);

  // Exactly at the expiry instant is still valid — the bound is inclusive.
  assert.equal(classifyCommand(cmd, ctx({ now: 2_000 })).status, "accepted");
});

test("RED TEAM: a command addressed to another device is rejected", () => {
  const cmd = signedCommand({ device_id: "dev_someone_else" });
  const decision = classifyCommand(cmd, ctx());
  assert.equal(decision.status, "rejected");
  assert.match(decision.status === "rejected" ? decision.reason : "", /device_id mismatch/);
});

test("RED TEAM: an unknown, expired, stale-lease or stale-fence group is rejected", () => {
  const base = { process_group_id: "grp-live", lease_epoch: LIVE_GROUP.lease_epoch, fence_token: LIVE_GROUP.fence_token };

  // Baseline: the current group, lease and fence are accepted.
  assert.equal(classifyCommand(signedCommand(base), ctx()).status, "accepted");

  // Unknown / already-expired group (lookupGroup returns undefined for both).
  const unknown = classifyCommand(signedCommand({ ...base, process_group_id: "grp-gone" }), ctx());
  assert.equal(unknown.status, "rejected");
  assert.match(unknown.status === "rejected" ? unknown.reason : "", /unknown or expired/);

  // A stale lease epoch — the group was re-leased since this command was minted.
  const staleLease = classifyCommand(signedCommand({ ...base, lease_epoch: 3 }), ctx());
  assert.equal(staleLease.status, "rejected");
  assert.match(staleLease.status === "rejected" ? staleLease.reason : "", /lease_epoch is stale/);

  // A stale fence token — the classic fenced-writer attack.
  const staleFence = classifyCommand(signedCommand({ ...base, fence_token: "fence-old" }), ctx());
  assert.equal(staleFence.status, "rejected");
  assert.match(staleFence.status === "rejected" ? staleFence.reason : "", /fence_token is stale/);
});

test("RED TEAM: structurally malformed commands are rejected before any crypto", () => {
  const good = signedCommand();
  const cases: Array<[Partial<DeviceCommand>, RegExp]> = [
    [{ schema: "aether.device.command/2" as DeviceCommand["schema"] }, /wrong schema/],
    [{ command_class: "rm -rf" as DeviceCommand["command_class"] }, /unknown command_class/],
    [{ command_id: "" }, /missing command_id/],
    [{ outbox_seq: 1.5 }, /invalid outbox_seq/],
    [{ digest: 7 as unknown as string }, /missing digest or signature/],
    [{ prev_digest: null as unknown as string }, /missing prev_digest/],
    [{ payload: [] as unknown as Record<string, unknown> }, /invalid payload/],
    [{ payload: null as unknown as Record<string, unknown> }, /invalid payload/],
  ];
  for (const [mutation, pattern] of cases) {
    // Deliberately NOT re-signed: every check above runs before the digest is
    // recomputed, so the structural reason is what the classifier must report.
    // (Some of these bodies — a fractional outbox_seq — cannot be canonically
    // encoded at all, which is itself why they must never reach the hasher.)
    const cmd = { ...good, ...mutation } as DeviceCommand;
    const decision = classifyCommand(cmd, ctx());
    assert.equal(decision.status, "rejected", `${JSON.stringify(mutation)} must be rejected`);
    assert.match(decision.status === "rejected" ? decision.reason : "", pattern);
  }
});

// ── Executors ───────────────────────────────────────────────────────────────

function executorSpy(): { deps: ExecutorDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: ExecutorDeps = {
    setThrottle: () => { calls.push("setThrottle"); },
    clearThrottle: () => { calls.push("clearThrottle"); },
    writeCheckpoint: () => { calls.push("writeCheckpoint"); return "ckpt-1"; },
    buildWorkspaceHandoff: () => { calls.push("buildHandoff"); return { handoff_id: "ho-1", change_digest: `sha256:${"d".repeat(64)}` }; },
    terminateGroup: async () => { calls.push("terminateGroup"); return { status: "terminated", via: "job-object", members: [10, 11] }; },
    revokeGroup: () => { calls.push("revokeGroup"); return true; },
    now: () => 7_000_000,
  };
  return { deps, calls };
}

test("throttle, resume, observe and noop are side-effect exact", async () => {
  for (const [cls, expected] of [
    ["throttle", "setThrottle"],
    ["resume", "clearThrottle"],
  ] as const) {
    const { deps, calls } = executorSpy();
    const out = await executeAccepted(signedCommand({ command_class: cls }), deps);
    assert.equal(out.status, "completed");
    assert.deepEqual(calls, [expected]);
  }
  for (const cls of ["observe", "noop"] as const) {
    const { deps, calls } = executorSpy();
    const out = await executeAccepted(signedCommand({ command_class: cls }), deps);
    assert.equal(out.status, "completed");
    assert.deepEqual(calls, [], `${cls} must not mutate device state`);
  }
});

test("drain_checkpoint builds a handoff, writes a checkpoint, and returns the change digest", async () => {
  const { deps, calls } = executorSpy();
  const out = await executeAccepted(signedCommand({ command_class: "drain_checkpoint" }), deps);
  assert.equal(out.status, "completed");
  assert.deepEqual(calls, ["buildHandoff", "writeCheckpoint"]);
  assert.equal(out.receipt["checkpoint_id"], "ckpt-1");
  assert.equal(out.receipt["change_digest"], `sha256:${"d".repeat(64)}`);
});

test("a handoff that would leak fails the drain instead of emitting it", async () => {
  const { deps } = executorSpy();
  const leaky: ExecutorDeps = {
    ...deps,
    buildWorkspaceHandoff: () => { throw new Error("refusing to emit workspace handoff: a field contains an absolute path"); },
  };
  const out = await executeAccepted(signedCommand({ command_class: "drain_checkpoint" }), leaky);
  assert.equal(out.status, "failed");
  assert.match(out.detail, /absolute path/);
});

test("emergency_terminate checkpoints first, then terminates regardless of the checkpoint", async () => {
  const { deps, calls } = executorSpy();
  const out = await executeAccepted(signedCommand({ command_class: "emergency_terminate", process_group_id: "grp-live" }), deps);
  assert.equal(out.status, "completed");
  // Order matters: the bounded checkpoint attempt precedes the kill.
  assert.deepEqual(calls, ["buildHandoff", "writeCheckpoint", "terminateGroup"]);
  assert.equal(out.receipt["terminated_group"], "grp-live");
  assert.equal(out.receipt["terminate_via"], "job-object");

  // A failed checkpoint must NOT cancel the emergency — the kill still runs.
  const { deps: deps2, calls: calls2 } = executorSpy();
  const noCheckpoint: ExecutorDeps = { ...deps2, buildWorkspaceHandoff: () => { throw new Error("workspace is mid-write"); } };
  const out2 = await executeAccepted(signedCommand({ command_class: "emergency_terminate", process_group_id: "grp-live" }), noCheckpoint);
  assert.equal(out2.status, "completed");
  assert.ok(calls2.includes("terminateGroup"), "the emergency kill is always armed");
  assert.match(String(out2.receipt["checkpoint_skipped"]), /mid-write/);
});

test("a terminate the PID-reuse guard blocked reports failed, not completed", async () => {
  const { deps } = executorSpy();
  const blocked: ExecutorDeps = {
    ...deps,
    terminateGroup: async () => ({ status: "pid-reuse-blocked", via: "none", members: [] }),
  };
  const out = await executeAccepted(signedCommand({ command_class: "emergency_terminate", process_group_id: "grp-live" }), blocked);
  assert.equal(out.status, "failed");
  assert.match(out.detail, /pid-reuse-blocked/);
});

test("group-scoped classes without a process_group_id fail rather than acting broadly", async () => {
  for (const cls of ["emergency_terminate", "revoke_group"] as const) {
    const { deps, calls } = executorSpy();
    const out = await executeAccepted(signedCommand({ command_class: cls, process_group_id: null }), deps);
    assert.equal(out.status, "failed");
    assert.match(out.detail, /requires a process_group_id/);
    assert.deepEqual(calls, [], `${cls} must not touch anything without a target group`);
  }
});

test("revoke_group removes the registration and reports whether it was present", async () => {
  const { deps, calls } = executorSpy();
  const out = await executeAccepted(signedCommand({ command_class: "revoke_group", process_group_id: "grp-live" }), deps);
  assert.equal(out.status, "completed");
  assert.deepEqual(calls, ["revokeGroup"]);
  assert.equal(out.receipt["was_present"], true);
});

// ── Result shaping ──────────────────────────────────────────────────────────

test("result details are bounded and secret-redacted", () => {
  const long = "x".repeat(5000);
  assert.equal(boundDetail(long).length, 2000);
  // The redactor runs BEFORE the truncation, so a secret near the front cannot
  // survive by being inside the kept window.
  const withSecret = boundDetail("poll failed: Authorization: Bearer sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  assert.ok(!withSecret.includes("sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), `detail leaked a secret: ${withSecret}`);
  assert.match(withSecret, /\[REDACTED\]/);
  // A hex secret in a sensitive key position is likewise scrubbed.
  const hexSecret = boundDetail(`device_command_key=${"a1b2c3d4".repeat(8)}`);
  assert.ok(!hexSecret.includes("a1b2c3d4a1b2"), `detail leaked a key: ${hexSecret}`);

  const result = buildResult({
    command_id: "cmd-1",
    device_id: TEST_DEVICE_ID,
    boot_id: "boot-1",
    result_seq: 3,
    status: "completed",
    detail: long,
    receipt: { ok: true },
    completed_at: 42,
  });
  assert.equal(result.schema, COMMAND_RESULT_SCHEMA);
  assert.equal(result.detail.length, 2000);
  assert.equal(result.result_seq, 3);
});

// ── Durable chain behaviour ─────────────────────────────────────────────────

function processDeps(overrides: Partial<ProcessDeps> = {}): ProcessDeps {
  const { deps } = executorSpy();
  return {
    ...deps,
    deviceId: TEST_DEVICE_ID,
    boot_id: "boot-1",
    commandKey: TEST_COMMAND_KEY,
    lookupGroup: (id) => (id === "grp-live" ? LIVE_GROUP : undefined),
    now: () => 5_000_000,
    ...overrides,
  };
}

test("processCommand advances the chain head only on acceptance", async () => {
  await withDeviceSandboxAsync(async () => {
    const first = signedCommand({ outbox_seq: 1, prev_digest: ZERO_DIGEST });
    const r1 = await processCommand(first, processDeps());
    assert.equal(r1.status, "completed");

    const chain = loadChain(TEST_DEVICE_ID);
    assert.equal(chain.last_outbox_seq, 1);
    assert.equal(chain.last_digest, first.digest);

    // A rejected command must NOT move the head — otherwise a single forged
    // command would permanently desynchronise the device from its outbox.
    const forged = signedCommand({ outbox_seq: 2, prev_digest: first.digest }, "wrong-key");
    const r2 = await processCommand(forged, processDeps());
    assert.equal(r2.status, "rejected");
    const after = loadChain(TEST_DEVICE_ID);
    assert.equal(after.last_outbox_seq, 1);
    assert.equal(after.last_digest, first.digest);

    // The legitimate next link still lands.
    const second = signedCommand({ outbox_seq: 2, prev_digest: first.digest });
    assert.equal((await processCommand(second, processDeps())).status, "completed");
    assert.equal(loadChain(TEST_DEVICE_ID).last_outbox_seq, 2);
  });
});

test("RED TEAM: replaying a command returns the stored result and re-executes nothing", async () => {
  await withDeviceSandboxAsync(async () => {
    const calls: string[] = [];
    const deps = processDeps({ setThrottle: () => { calls.push("setThrottle"); } });
    const cmd = signedCommand({ command_class: "throttle", outbox_seq: 1 });

    const first = await processCommand(cmd, deps);
    assert.equal(first.status, "completed");
    assert.deepEqual(calls, ["setThrottle"]);

    const replay = await processCommand(cmd, deps);
    assert.equal(replay.status, "completed");
    // Byte-identical to the first result — an idempotent record, not a rerun.
    assert.deepEqual(replay, first);
    assert.deepEqual(calls, ["setThrottle"], "a replayed command must not execute a second time");
  });
});

test("a chain persisted for a DIFFERENT device is never reused", async () => {
  await withDeviceSandboxAsync(async () => {
    await processCommand(signedCommand({ outbox_seq: 1 }), processDeps());
    assert.equal(loadChain(TEST_DEVICE_ID).last_outbox_seq, 1);
    // Re-enrollment mints a new device_id; inheriting the old head would either
    // reject every command or accept a replay from the previous identity.
    const other = loadChain("dev_reenrolled_0002");
    assert.deepEqual(other, emptyChain("dev_reenrolled_0002"));
    assert.equal(other.last_digest, ZERO_DIGEST);
  });
});
