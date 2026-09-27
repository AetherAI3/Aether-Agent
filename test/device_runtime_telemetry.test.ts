import { test } from "node:test";
import assert from "node:assert/strict";
import { hostname } from "node:os";
import {
  TelemetrySampler,
  composeObservation,
  serializeObservation,
  type ObservationMeta,
  type TelemetryInputs,
} from "../src/core/device_runtime/telemetry.js";

function inputs(overrides: Partial<TelemetryInputs> = {}): TelemetryInputs {
  let t = 0;
  return {
    cpuTimes: () => ({ idle: 0, total: 0 }),
    cpuLogical: () => 8,
    memTotalBytes: () => 16 * 1024 ** 3,
    memAvailBytes: () => 8 * 1024 ** 3,
    disk: () => ({ total_gb: 500, free_gb: 200 }),
    swap: () => ({ swap_total_mb: null, swap_used_mb: null, oom_pressure_pct: null }),
    now: () => (t += 1000),
    ...overrides,
  };
}

const META: ObservationMeta = {
  device_id: "dev-1",
  boot_id: "boot-1",
  seq: 5,
  agent_version: "0.3.0",
  display_name: "host",
  capabilities: ["c1"],
  runtime_labels: ["win32"],
  repo: null,
  lanes_active: 1,
  lanes_reserved: 2,
  workload_count: 3,
};

test("cpu utilisation is 0 on the first sample then derives from the tick delta", () => {
  let idle = 0;
  let total = 0;
  const sampler = new TelemetrySampler(
    inputs({
      cpuTimes: () => ({ idle, total }),
    }),
    1, // alpha = 1 so the smoothed value equals the instantaneous one
  );
  const first = sampler.sample();
  assert.equal(first.cpu_util_pct, 0);
  // Next tick: 100 total, 50 idle -> 50% busy.
  idle = 50;
  total = 100;
  const second = sampler.sample();
  assert.equal(second.cpu_util_pct, 50);
});

test("EWMA smooths a spike rather than tracking it fully", () => {
  const busy = { idle: 0, total: 0 };
  const sampler = new TelemetrySampler(inputs({ cpuTimes: () => ({ ...busy }) }), 0.5);
  // The first sample has no previous tick to difference against, so it carries
  // no real utilisation and must NOT seed the average — a device that boots
  // under load would otherwise report 0 and take several publish cycles to
  // cross the throttle threshold, which is exactly when shedding matters most.
  sampler.sample();
  busy.idle = 100;
  busy.total = 100; // first REAL delta: fully idle, seeds the average at 0
  assert.equal(sampler.sample().cpu_util_pct, 0);
  busy.total = 200; // idle unchanged => 100% busy this tick
  const s = sampler.sample();
  assert.ok(
    s.cpu_util_pct > 0 && s.cpu_util_pct < 100,
    `smoothed value ${s.cpu_util_pct} should sit between the seed and the spike`,
  );
});

test("120s window maxima track the peak over the window", () => {
  const cpu = { idle: 100, total: 100 };
  const sampler = new TelemetrySampler(inputs({ cpuTimes: () => ({ ...cpu }) }), 1);
  sampler.sample(); // 0
  cpu.idle = 0;
  cpu.total += 100; // 100% this tick
  const peak = sampler.sample();
  assert.equal(peak.cpu_util_pct_max_120s, 100);
  cpu.idle = 100;
  cpu.total += 100; // idle again
  const after = sampler.sample();
  assert.equal(after.cpu_util_pct, 0);
  // The peak is still remembered within the window.
  assert.equal(after.cpu_util_pct_max_120s, 100);
});

test("memory percent and integer sizes are computed", () => {
  const sampler = new TelemetrySampler(inputs());
  const m = sampler.sample();
  assert.equal(m.mem_total_mb, 16 * 1024);
  assert.equal(m.mem_avail_mb, 8 * 1024);
  assert.equal(m.mem_used_pct, 50);
  assert.equal(m.disk_workspace_total_gb, 500);
  assert.equal(m.disk_workspace_free_gb, 200);
  assert.ok(Number.isInteger(m.mem_total_mb));
});

test("swap null fields are tolerated end to end", () => {
  const sampler = new TelemetrySampler(inputs());
  const obs = serializeObservation(composeObservation(META, sampler.sample()));
  assert.equal(obs.swap_total_mb, null);
  assert.equal(obs.oom_pressure_pct, null);
});

test("serializeObservation REJECTS any field outside the allowlist", () => {
  const sampler = new TelemetrySampler(inputs());
  const obs = composeObservation(META, sampler.sample());
  for (const leak of ["env", "argv", "token", "prompt", "process_list", "cwd"]) {
    const poisoned = { ...obs, [leak]: "sensitive value" };
    assert.throws(() => serializeObservation(poisoned), new RegExp(`allowlist.*${leak}|${leak}`), `${leak} should be rejected`);
  }
});

test("serializeObservation rebuilds only allowlisted fields", () => {
  const sampler = new TelemetrySampler(inputs());
  const obs = composeObservation(META, sampler.sample());
  const clean = serializeObservation(obs);
  assert.equal(clean.device_id, "dev-1");
  assert.equal(clean.lanes_reserved, 2);
  assert.deepEqual(Object.keys(clean).sort(), Object.keys(obs).sort());
});

test("the hostname is DISPLAY metadata only, never identity", () => {
  const sampler = new TelemetrySampler(inputs());
  const obs = serializeObservation(
    composeObservation({ ...META, device_id: "dev-canonical", display_name: hostname() }, sampler.sample()),
  );
  // The enrolled device id is what identifies the machine on the wire.
  assert.equal(obs.device_id, "dev-canonical");
  // The hostname appears in exactly one field, and it is not an identity field.
  const carriers = Object.entries(obs).filter(([, v]) => v === hostname()).map(([k]) => k);
  assert.deepEqual(carriers, ["display_name"]);
  // Changing the hostname cannot change who the device is.
  const renamed = serializeObservation(
    composeObservation({ ...META, device_id: "dev-canonical", display_name: "a-totally-different-name" }, sampler.sample()),
  );
  assert.equal(renamed.device_id, obs.device_id);
});

test("the published payload carries no prompt, argv, env, token, transcript or process listing", () => {
  const sampler = new TelemetrySampler(inputs());
  const obs = serializeObservation(composeObservation(META, sampler.sample()));
  // 1. Every key is one of the contract's, so there is no field to hide data in.
  const allowed = new Set([
    "schema", "device_id", "boot_id", "seq", "sampled_at", "cpu_logical", "cpu_util_pct",
    "mem_total_mb", "mem_avail_mb", "mem_used_pct", "swap_total_mb", "swap_used_mb",
    "oom_pressure_pct", "disk_workspace_total_gb", "disk_workspace_free_gb", "lanes_active",
    "lanes_reserved", "workload_count", "capabilities", "runtime_labels", "repo",
    "agent_version", "display_name", "cpu_util_pct_max_120s", "mem_used_pct_max_120s",
  ]);
  for (const key of Object.keys(obs)) assert.ok(allowed.has(key), `unexpected field ${key} on the wire`);
  // 2. None of the forbidden names can be introduced, even nested.
  for (const forbidden of [
    "prompt", "prompts", "argv", "args", "arguments", "env", "environment", "token",
    "secret", "transcript", "messages", "file_body", "contents", "processes", "process_list",
    "cmdline", "command_line", "cwd", "path", "paths", "home",
  ]) {
    assert.throws(
      () => serializeObservation({ ...obs, [forbidden]: "sensitive" }),
      /allowlist/,
      `${forbidden} must be refused`,
    );
  }
  // 3. And the serialized bytes contain no environment value from this process.
  const serialized = JSON.stringify(obs);
  for (const value of Object.values(process.env)) {
    if (typeof value === "string" && value.length >= 12) {
      assert.equal(serialized.includes(value), false, "an environment value reached the payload");
    }
  }
});

test("serializeObservation rejects a non-integer metric", () => {
  const sampler = new TelemetrySampler(inputs());
  const obs = composeObservation(META, sampler.sample());
  assert.throws(() => serializeObservation({ ...obs, cpu_util_pct: 12.5 }), /integer/);
});
