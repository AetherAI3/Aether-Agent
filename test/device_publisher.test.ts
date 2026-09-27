// The publisher is what the device does when the Cloud is unreachable. The
// contract's rules — cap 40, drop-oldest, 1s..60s jittered backoff — are all
// about the same choice: under a sustained outage, keep the FRESHEST load data
// and shed the stalest, because the Cloud's scheduling decisions are only ever
// about now. Time and transport are injected, so nothing here sleeps.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_INTERVAL_MS,
  INTERVAL_JITTER_MS,
  MAX_BACKOFF_MS,
  MIN_BACKOFF_MS,
  Publisher,
  QUEUE_CAP,
  type PublishOutcome,
} from "../src/core/device_runtime/publisher.js";
import { OBSERVATION_SCHEMA, type DeviceObservation } from "../src/core/device_runtime/contract.js";

function obs(seq: number): DeviceObservation {
  return {
    schema: OBSERVATION_SCHEMA,
    device_id: "dev_1",
    boot_id: "boot-1",
    seq,
    sampled_at: seq * 1000,
    cpu_logical: 8,
    cpu_util_pct: 10,
    mem_total_mb: 16384,
    mem_avail_mb: 8192,
    mem_used_pct: 50,
    swap_total_mb: null,
    swap_used_mb: null,
    oom_pressure_pct: null,
    disk_workspace_total_gb: 500,
    disk_workspace_free_gb: 120,
    lanes_active: 0,
    lanes_reserved: 0,
    workload_count: 0,
    capabilities: [],
    runtime_labels: ["win32"],
    repo: null,
    agent_version: "0.3.0",
    display_name: "workstation",
    cpu_util_pct_max_120s: 10,
    mem_used_pct_max_120s: 50,
  };
}

/** A transport that answers from a script and records what it was handed. */
function transport(script: PublishOutcome[]): { send: (o: DeviceObservation) => Promise<PublishOutcome>; seen: number[] } {
  const seen: number[] = [];
  let i = 0;
  return {
    seen,
    send: async (o) => {
      seen.push(o.seq);
      return script[Math.min(i++, script.length - 1)] ?? "ok";
    },
  };
}

test("the queue is capped and drops the OLDEST frame", async () => {
  const p = new Publisher({ random: () => 0.5 });
  for (let seq = 1; seq <= QUEUE_CAP + 10; seq++) p.enqueue(obs(seq));
  assert.equal(p.queueDepth(), QUEUE_CAP);

  const t = transport(["ok"]);
  await p.drain(t.send);
  // The surviving window is the NEWEST 40 — an outage must not leave the Cloud
  // being told about load from ten minutes ago while the recent spike is gone.
  assert.equal(t.seen.length, QUEUE_CAP);
  assert.equal(t.seen[0], 11);
  assert.equal(t.seen[t.seen.length - 1], QUEUE_CAP + 10);
});

test("frames drain oldest-first so the sequence stays monotonic on the wire", async () => {
  const p = new Publisher({ random: () => 0.5 });
  for (const seq of [7, 8, 9]) p.enqueue(obs(seq));
  const t = transport(["ok"]);
  const result = await p.drain(t.send);
  assert.deepEqual(t.seen, [7, 8, 9]);
  assert.deepEqual(result, { sent: 3, rejected: 0, backedOff: false });
  assert.equal(p.queueDepth(), 0);
});

test("a retryable failure keeps the frame, arms backoff, and stops the drain", async () => {
  const p = new Publisher({ random: () => 0.5 });
  for (const seq of [1, 2, 3]) p.enqueue(obs(seq));
  const t = transport(["retry"]);
  const result = await p.drain(t.send);

  assert.deepEqual(result, { sent: 0, rejected: 0, backedOff: true });
  // Exactly one attempt: continuing to hammer a dead endpoint with the rest of
  // the queue is what the backoff exists to prevent.
  assert.deepEqual(t.seen, [1]);
  assert.equal(p.queueDepth(), 3, "a retryable frame is retained, never dropped");
  assert.equal(p.isBackedOff(), true);
});

test("a transport that throws is treated as retryable, not as a rejection", async () => {
  const p = new Publisher({ random: () => 0.5 });
  p.enqueue(obs(1));
  const result = await p.drain(async () => { throw new Error("ECONNRESET"); });
  assert.equal(result.backedOff, true);
  assert.equal(p.queueDepth(), 1, "a thrown network error must not discard the frame");
});

test("a rejected frame is dropped and the drain continues past it", async () => {
  const p = new Publisher({ random: () => 0.5 });
  for (const seq of [1, 2, 3]) p.enqueue(obs(seq));
  // The Cloud declined frame 1 (e.g. stale boot_id). Re-sending it forever
  // would wedge the queue behind a frame that can never succeed.
  const t = transport(["reject", "ok", "ok"]);
  const result = await p.drain(t.send);
  assert.deepEqual(result, { sent: 2, rejected: 1, backedOff: false });
  assert.deepEqual(t.seen, [1, 2, 3]);
  assert.equal(p.queueDepth(), 0);
  assert.equal(p.isBackedOff(), false);
});

test("backoff grows exponentially from 1s, caps at 60s, and one success clears it", async () => {
  const p = new Publisher({ random: () => 0.5 }); // 0.5 => zero jitter
  assert.equal(p.currentBackoffMs(), 0, "no failures means publish on cadence");

  const seen: number[] = [];
  for (let attempt = 1; attempt <= 12; attempt++) {
    p.enqueue(obs(attempt));
    await p.drain(async () => "retry");
    seen.push(p.currentBackoffMs());
  }
  assert.equal(seen[0], MIN_BACKOFF_MS);
  assert.equal(seen[1], 2 * MIN_BACKOFF_MS);
  assert.equal(seen[2], 4 * MIN_BACKOFF_MS);
  // Monotonically non-decreasing, and never past the cap.
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i]! >= seen[i - 1]!, `backoff regressed at ${i}`);
  for (const ms of seen) assert.ok(ms >= MIN_BACKOFF_MS && ms <= MAX_BACKOFF_MS, `backoff ${ms} out of bounds`);
  assert.equal(seen[seen.length - 1], MAX_BACKOFF_MS);

  // Reconnecting clears the streak immediately — one good publish, not a slow
  // ramp back down, because the device is useful again the moment it is online.
  await p.drain(async () => "ok");
  assert.equal(p.isBackedOff(), false);
  assert.equal(p.currentBackoffMs(), 0);
});

test("backoff jitter stays inside the bounds for every random draw", () => {
  for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
    const p = new Publisher({ random: () => r });
    // Drive the streak up without awaiting a drain per step.
    for (let i = 0; i < 3; i++) {
      p.enqueue(obs(i));
    }
    const interval = p.nextIntervalMs();
    assert.ok(
      interval >= BASE_INTERVAL_MS - INTERVAL_JITTER_MS && interval <= BASE_INTERVAL_MS + INTERVAL_JITTER_MS,
      `interval ${interval} outside 12s±2s for random ${r}`,
    );
    assert.ok(Number.isInteger(interval) && interval > 0);
  }
});

test("cadence jitter actually varies, so a fleet cannot synchronise", () => {
  const low = new Publisher({ random: () => 0 }).nextIntervalMs();
  const mid = new Publisher({ random: () => 0.5 }).nextIntervalMs();
  const high = new Publisher({ random: () => 0.999 }).nextIntervalMs();
  assert.equal(mid, BASE_INTERVAL_MS);
  assert.ok(low < mid && mid < high, `expected spread, saw ${low}/${mid}/${high}`);
  // A thundering herd is the failure this prevents: every device publishing on
  // the same tick turns a fleet-wide restart into a synchronised burst.
  assert.ok(high - low >= INTERVAL_JITTER_MS);
});

test("draining an empty queue is a no-op that does not arm backoff", async () => {
  const p = new Publisher({ random: () => 0.5 });
  let called = 0;
  const result = await p.drain(async () => { called += 1; return "ok"; });
  assert.deepEqual(result, { sent: 0, rejected: 0, backedOff: false });
  assert.equal(called, 0);
  assert.equal(p.isBackedOff(), false);
});
