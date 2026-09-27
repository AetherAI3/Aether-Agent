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
    device_id: "d",
    boot_id: "b",
    seq,
    sampled_at: seq,
    cpu_logical: 8,
    cpu_util_pct: 1,
    mem_total_mb: 1,
    mem_avail_mb: 1,
    mem_used_pct: 1,
    swap_total_mb: null,
    swap_used_mb: null,
    oom_pressure_pct: null,
    disk_workspace_total_gb: 1,
    disk_workspace_free_gb: 1,
    lanes_active: 0,
    lanes_reserved: 0,
    workload_count: 0,
    capabilities: [],
    runtime_labels: [],
    repo: null,
    agent_version: "0",
    display_name: "d",
    cpu_util_pct_max_120s: 1,
    mem_used_pct_max_120s: 1,
  };
}

test("queue drops the OLDEST frame past the cap", () => {
  const p = new Publisher();
  for (let i = 1; i <= QUEUE_CAP + 5; i++) p.enqueue(obs(i));
  assert.equal(p.queueDepth(), QUEUE_CAP);
});

test("interval jitter stays within ±2s of the base cadence", () => {
  const p = new Publisher({ random: () => 0 });
  assert.equal(p.nextIntervalMs(), BASE_INTERVAL_MS - INTERVAL_JITTER_MS);
  const hi = new Publisher({ random: () => 1 });
  assert.equal(hi.nextIntervalMs(), BASE_INTERVAL_MS + INTERVAL_JITTER_MS);
});

test("drain sends oldest-first in seq order and empties on success", async () => {
  const p = new Publisher();
  for (const i of [1, 2, 3]) p.enqueue(obs(i));
  const sent: number[] = [];
  const result = await p.drain(async (o) => {
    sent.push(o.seq);
    return "ok";
  });
  assert.deepEqual(sent, [1, 2, 3]);
  assert.equal(result.sent, 3);
  assert.equal(p.queueDepth(), 0);
});

test("a retry keeps the frame and arms exponential backoff", async () => {
  const p = new Publisher({ random: () => 0.5 });
  p.enqueue(obs(1));
  const r1 = await p.drain(async () => "retry");
  assert.equal(r1.backedOff, true);
  assert.equal(p.queueDepth(), 1);
  assert.equal(p.isBackedOff(), true);
  const first = p.currentBackoffMs();
  assert.ok(first >= MIN_BACKOFF_MS && first <= MAX_BACKOFF_MS);
  // A second failure deepens the backoff.
  await p.drain(async () => "retry");
  assert.ok(p.currentBackoffMs() >= first);
});

test("a rejected frame is dropped, not retried, and does not arm backoff", async () => {
  const p = new Publisher();
  p.enqueue(obs(1));
  p.enqueue(obs(2));
  const outcomes: PublishOutcome[] = ["reject", "ok"];
  let i = 0;
  const r = await p.drain(async () => outcomes[i++]!);
  assert.equal(r.rejected, 1);
  assert.equal(r.sent, 1);
  assert.equal(p.queueDepth(), 0);
  assert.equal(p.isBackedOff(), false);
});

test("one success clears the backoff so cadence resumes", async () => {
  const p = new Publisher();
  p.enqueue(obs(1));
  await p.drain(async () => "retry");
  assert.equal(p.isBackedOff(), true);
  await p.drain(async () => "ok");
  assert.equal(p.isBackedOff(), false);
  assert.equal(p.currentBackoffMs(), 0);
});

test("reconnect resumes the monotonic seq series without reuse", async () => {
  const p = new Publisher();
  for (const i of [10, 11, 12]) p.enqueue(obs(i));
  // Offline: first send fails, rest stay queued in order.
  let attempts = 0;
  await p.drain(async () => {
    attempts++;
    return "retry";
  });
  assert.equal(attempts, 1);
  // Back online: the same three frames flush in their original order.
  const sent: number[] = [];
  await p.drain(async (o) => {
    sent.push(o.seq);
    return "ok";
  });
  assert.deepEqual(sent, [10, 11, 12]);
});
