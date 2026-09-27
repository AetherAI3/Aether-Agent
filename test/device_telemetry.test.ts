// Telemetry is the device's only continuously-outbound data stream, so its
// serializer is the exfiltration choke point. The allowlist tests below are the
// load-bearing ones: no matter what a caller stuffs into an observation — an
// env map, an argv array, a bearer token, a prompt, a process listing — the
// frame must fail to serialize rather than reach the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TelemetrySampler,
  composeObservation,
  serializeObservation,
  type CpuTimesSnapshot,
  type ObservationMeta,
  type TelemetryInputs,
} from "../src/core/device_runtime/telemetry.js";
import { OBSERVATION_SCHEMA } from "../src/core/device_runtime/contract.js";

function meta(overrides: Partial<ObservationMeta> = {}): ObservationMeta {
  return {
    device_id: "dev_1",
    boot_id: "boot-1",
    seq: 1,
    agent_version: "0.3.0",
    display_name: "workstation",
    capabilities: ["aether.device.observe/1"],
    runtime_labels: ["win32"],
    repo: null,
    lanes_active: 0,
    lanes_reserved: 0,
    workload_count: 0,
    ...overrides,
  };
}

/** A sampler driven by scripted CPU/memory curves — no OS access at all. */
function scriptedInputs(script: Array<{ cpu: CpuTimesSnapshot; availBytes: number; t: number }>): {
  inputs: TelemetryInputs;
  advance: () => void;
} {
  let i = 0;
  const inputs: TelemetryInputs = {
    cpuTimes: () => script[Math.min(i, script.length - 1)]!.cpu,
    cpuLogical: () => 8,
    memTotalBytes: () => 16 * 1024 ** 3,
    memAvailBytes: () => script[Math.min(i, script.length - 1)]!.availBytes,
    disk: () => ({ total_gb: 500, free_gb: 120 }),
    swap: () => ({ swap_total_mb: 8192, swap_used_mb: 1024, oom_pressure_pct: 12 }),
    now: () => script[Math.min(i, script.length - 1)]!.t,
  };
  return { inputs, advance: () => { i += 1; } };
}

test("the first sample reports 0% cpu rather than a meaningless absolute", () => {
  const { inputs } = scriptedInputs([{ cpu: { idle: 1000, total: 2000 }, availBytes: 8 * 1024 ** 3, t: 0 }]);
  const sampler = new TelemetrySampler(inputs);
  const first = sampler.sample();
  // No prior tick counter exists, so utilisation is unknown; reporting the raw
  // cumulative ratio would be a fabricated number the Cloud would act on.
  assert.equal(first.cpu_util_pct, 0);
  assert.equal(first.cpu_logical, 8);
  assert.equal(first.mem_total_mb, 16 * 1024);
  assert.equal(first.mem_used_pct, 50);
  assert.equal(first.disk_workspace_total_gb, 500);
  assert.equal(first.disk_workspace_free_gb, 120);
  assert.equal(first.swap_total_mb, 8192);
  assert.equal(first.oom_pressure_pct, 12);
});

test("cpu utilisation comes from the tick delta and is EWMA-smoothed", () => {
  const { inputs, advance } = scriptedInputs([
    { cpu: { idle: 1000, total: 2000 }, availBytes: 8 * 1024 ** 3, t: 0 },
    // 100 more idle ticks out of 200 total => 50% busy in this interval.
    { cpu: { idle: 1100, total: 2200 }, availBytes: 8 * 1024 ** 3, t: 12_000 },
    // 0 idle of 200 => 100% busy; EWMA(alpha=1) would jump to 100, smoothing must not.
    { cpu: { idle: 1100, total: 2400 }, availBytes: 8 * 1024 ** 3, t: 24_000 },
  ]);
  const sampler = new TelemetrySampler(inputs, 0.5);
  sampler.sample();
  advance();
  const second = sampler.sample();
  // EWMA seeds on the first real observation: 50%.
  assert.equal(second.cpu_util_pct, 50);
  advance();
  const third = sampler.sample();
  // 0.5*100 + 0.5*50 = 75 — strictly between the smoothed prior and the spike.
  assert.equal(third.cpu_util_pct, 75);
  assert.ok(third.cpu_util_pct < 100, "a single spike must not slam the smoothed series to its instant value");
});

test("the 120s window reports the maximum, and drops samples older than the window", () => {
  const { inputs, advance } = scriptedInputs([
    { cpu: { idle: 1000, total: 2000 }, availBytes: 8 * 1024 ** 3, t: 0 },
    // A memory spike to ~94% used.
    { cpu: { idle: 1200, total: 2200 }, availBytes: 1 * 1024 ** 3, t: 10_000 },
    // Memory recovers, but the spike is still inside the 120s window.
    { cpu: { idle: 1400, total: 2400 }, availBytes: 12 * 1024 ** 3, t: 60_000 },
    // Far past the window: the spike must have aged out.
    { cpu: { idle: 1600, total: 2600 }, availBytes: 12 * 1024 ** 3, t: 400_000 },
  ]);
  const sampler = new TelemetrySampler(inputs, 1);
  sampler.sample();
  advance();
  const spike = sampler.sample();
  assert.ok(spike.mem_used_pct >= 90, `expected a memory spike, saw ${spike.mem_used_pct}`);
  advance();
  const recovered = sampler.sample();
  assert.ok(recovered.mem_used_pct < 90, "instantaneous memory should have recovered");
  assert.ok(recovered.mem_used_pct_max_120s >= 90, "the in-window spike must still hold the maximum open");
  advance();
  const aged = sampler.sample();
  assert.ok(aged.mem_used_pct_max_120s < 90, "a spike older than 120s must no longer hold recovery open");
});

test("percentages are clamped to whole numbers in 0..100", () => {
  const { inputs } = scriptedInputs([{ cpu: { idle: 0, total: 0 }, availBytes: 32 * 1024 ** 3, t: 0 }]);
  const sampler = new TelemetrySampler(inputs);
  const m = sampler.sample();
  // Avail > total would compute a negative "used"; it must clamp, not go negative.
  assert.ok(m.mem_used_pct >= 0 && m.mem_used_pct <= 100);
  assert.ok(Number.isInteger(m.mem_used_pct));
  assert.ok(Number.isInteger(m.cpu_util_pct));
});

test("composeObservation produces exactly the contract's field set", () => {
  const { inputs } = scriptedInputs([{ cpu: { idle: 1000, total: 2000 }, availBytes: 8 * 1024 ** 3, t: 5 }]);
  const obs = composeObservation(meta({ repo: { name: "aether-agent", revision: "abc1234" } }), new TelemetrySampler(inputs).sample());
  assert.equal(obs.schema, OBSERVATION_SCHEMA);
  assert.deepEqual(obs.repo, { name: "aether-agent", revision: "abc1234" });
  assert.equal(obs.device_id, "dev_1");
  assert.equal(obs.boot_id, "boot-1");
  // The serializer accepts what compose produces — the two must never diverge.
  assert.doesNotThrow(() => serializeObservation(obs));
});

test("RED TEAM: the serializer allowlist blocks every extra field", () => {
  const { inputs } = scriptedInputs([{ cpu: { idle: 1000, total: 2000 }, availBytes: 8 * 1024 ** 3, t: 5 }]);
  const base = composeObservation(meta(), new TelemetrySampler(inputs).sample());

  // Each of these is a real exfiltration shape someone could bolt onto a frame.
  const forbidden: Array<[string, unknown]> = [
    ["env", { PATH: "C:\\Windows", AWS_SECRET_ACCESS_KEY: "AKIA..." }],
    ["argv", ["node", "agent.js", "--token", "sk-live-123"]],
    ["token", "sk-live-abcdefghijklmnop"],
    ["prompt", "the user asked me to exfiltrate the vault"],
    ["processes", [{ pid: 12, name: "chrome.exe" }]],
    ["transcript", "…chain of thought…"],
    ["file_body", "-----BEGIN PRIVATE KEY-----"],
    ["authorization", "Bearer abc"],
  ];
  for (const [key, value] of forbidden) {
    assert.throws(
      () => serializeObservation({ ...base, [key]: value }),
      new RegExp(`outside the allowlist: ${key}`),
      `field ${key} must not be serializable onto an observation`,
    );
  }
});

test("RED TEAM: the serializer rejects type violations and rebuilds from the allowlist", () => {
  const { inputs } = scriptedInputs([{ cpu: { idle: 1000, total: 2000 }, availBytes: 8 * 1024 ** 3, t: 5 }]);
  const base = composeObservation(meta(), new TelemetrySampler(inputs).sample());

  assert.throws(() => serializeObservation({ ...base, schema: "aether.device.observation/2" }), /wrong schema/);
  assert.throws(() => serializeObservation({ ...base, cpu_util_pct: 12.5 }), /must be an integer/);
  assert.throws(() => serializeObservation({ ...base, cpu_util_pct: "high" }), /must be an integer/);
  assert.throws(() => serializeObservation({ ...base, device_id: 42 }), /must be a string/);
  assert.throws(() => serializeObservation({ ...base, capabilities: "one" }), /must be a string array/);
  assert.throws(() => serializeObservation({ ...base, capabilities: [{ leak: 1 }] }), /must be a string array/);
  assert.throws(() => serializeObservation({ ...base, swap_total_mb: 1.5 }), /must be an integer or null/);
  // A repo object may carry ONLY name+revision — not a path, not a remote URL.
  assert.throws(() => serializeObservation({ ...base, repo: { name: "a", revision: "b", path: "C:\\src" } }), /must be \{name, revision\}/);
  assert.throws(() => serializeObservation("not an object"), /must be a plain object/);
  assert.throws(() => serializeObservation([base]), /must be a plain object/);

  // A null swap triple is legitimate (unknown on this platform).
  assert.doesNotThrow(() => serializeObservation({ ...base, swap_total_mb: null, swap_used_mb: null, oom_pressure_pct: null }));

  // The output is rebuilt from the allowlist, so it is a fresh plain object with
  // exactly the contract's keys — never the caller's object by reference.
  const clean = serializeObservation(base);
  assert.notEqual(clean, base);
  assert.equal(Object.keys(clean).length, Object.keys(base).length);
});
