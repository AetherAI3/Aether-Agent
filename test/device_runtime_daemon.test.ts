import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceRuntimeEnabled } from "../src/core/device_runtime/enablement.js";
import { daemonStartRefusal, runDeviceDaemon } from "../src/core/device_runtime/daemon.js";
import { saveEnrollment, type EnrollmentRecord } from "../src/core/device_runtime/identity.js";
import { readDaemonState } from "../src/core/device_runtime/daemon_state.js";
import type { TelemetryInputs } from "../src/core/device_runtime/telemetry.js";
import type { DeviceObservation } from "../src/core/device_runtime/contract.js";
import type { DeviceNet } from "../src/core/device_runtime/net.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { AetherConfig } from "../src/types.js";

function cfg(overrides: Partial<AetherConfig> = {}): AetherConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

async function withEnv<T>(env: Record<string, string | undefined>, body: () => T | Promise<T>): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("the runtime is OFF by default and by explicit false", async () => {
  await withEnv({ AETHER_DEVICE_RUNTIME: undefined }, () => {
    assert.equal(deviceRuntimeEnabled(cfg()), false);
    assert.equal(deviceRuntimeEnabled(cfg({ deviceRuntime: { enabled: false } })), false);
  });
});

test("either the config switch or the env override enables it", async () => {
  await withEnv({ AETHER_DEVICE_RUNTIME: undefined }, () => {
    assert.equal(deviceRuntimeEnabled(cfg({ deviceRuntime: { enabled: true } })), true);
  });
  await withEnv({ AETHER_DEVICE_RUNTIME: "1" }, () => {
    assert.equal(deviceRuntimeEnabled(cfg()), true);
  });
  // Any other env value is not the opt-in.
  await withEnv({ AETHER_DEVICE_RUNTIME: "true" }, () => {
    assert.equal(deviceRuntimeEnabled(cfg()), false);
  });
});

test("the daemon REFUSES to start when the runtime is disabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-dev-daemon-"));
  await withEnv({ AETHER_CONFIG_DIR: dir, AETHER_DEVICE_RUNTIME: undefined }, async () => {
    const code = await runDeviceDaemon();
    assert.equal(code, 3, "a disabled runtime must exit with the disabled code");
    assert.match(daemonStartRefusal() ?? "", /disabled/);
  });
  rmSync(dir, { recursive: true, force: true });
});

test("the daemon refuses to start when enabled but not enrolled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-dev-daemon-"));
  await withEnv({ AETHER_CONFIG_DIR: dir, AETHER_DEVICE_RUNTIME: "1" }, async () => {
    const code = await runDeviceDaemon();
    assert.equal(code, 4, "an unenrolled device must exit with the not-enrolled code");
    assert.match(daemonStartRefusal() ?? "", /not enrolled/);
  });
  rmSync(dir, { recursive: true, force: true });
});

// ── One full sample/publish pass ────────────────────────────────────────────

const ENROLLMENT: EnrollmentRecord = {
  device_id: "dev-loop",
  device_token: "tok-secret-value",
  device_command_key: "key-secret-value",
  display_name: "operator-laptop",
  base_url: "https://api.example.test/cloud",
  enrolled_at: 0,
};

function fakeInputs(): TelemetryInputs {
  let t = 1_000_000;
  return {
    cpuTimes: () => ({ idle: 50, total: 100 }),
    cpuLogical: () => 12,
    memTotalBytes: () => 32 * 1024 ** 3,
    memAvailBytes: () => 16 * 1024 ** 3,
    disk: () => ({ total_gb: 900, free_gb: 400 }),
    swap: () => ({ swap_total_mb: 4096, swap_used_mb: 1024, oom_pressure_pct: 25 }),
    now: () => (t += 1000),
  };
}

/** A DeviceNet stand-in that records what the daemon actually sent. */
function captureNet(outcome: "ok" | "retry" = "ok"): { published: DeviceObservation[]; net: DeviceNet } {
  const published: DeviceObservation[] = [];
  const net = {
    observe: async (o: DeviceObservation) => {
      published.push(o);
      return outcome;
    },
    pollCommands: async () => [],
    postResult: async () => {},
    registerGroup: async () => {},
    offerHandoff: async () => {},
    health: async () => ({ reachable: true, status: 200, latencyMs: 1 }),
  } as unknown as DeviceNet;
  return { published, net };
}

test("one pass publishes a complete, contract-shaped observation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-dev-loop-"));
  await withEnv({ AETHER_CONFIG_DIR: dir, AETHER_DEVICE_RUNTIME: "1" }, async () => {
    const { published, net } = captureNet();
    const code = await runDeviceDaemon({
      enrollment: ENROLLMENT,
      net,
      maxIterations: 1,
      bootTimeMs: 1_000,
      telemetryInputs: fakeInputs(),
      repoProbe: () => ({ name: "AetherAI3/aether-agent", revision: "a".repeat(40) }),
      now: () => 2_000_000,
    });
    assert.equal(code, 0);
    assert.equal(published.length, 1);
    const obs = published[0]!;
    assert.equal(obs.device_id, "dev-loop");
    assert.equal(obs.seq, 1, "the first sample of a boot is seq 1");
    assert.equal(obs.cpu_logical, 12);
    assert.equal(obs.mem_total_mb, 32 * 1024);
    assert.equal(obs.disk_workspace_free_gb, 400);
    assert.equal(obs.swap_total_mb, 4096);
    assert.equal(obs.oom_pressure_pct, 25);
    assert.deepEqual(obs.repo, { name: "AetherAI3/aether-agent", revision: "a".repeat(40) });
    assert.ok(obs.capabilities.includes("aether.device.observe/1"));
    assert.ok(obs.runtime_labels.includes(process.platform));
    // Display metadata only; the enrolled id is the identity.
    assert.equal(obs.display_name, "operator-laptop");
    // Nothing secret rides along.
    const wire = JSON.stringify(obs);
    assert.equal(wire.includes(ENROLLMENT.device_token), false);
    assert.equal(wire.includes(ENROLLMENT.device_command_key), false);
  });
  rmSync(dir, { recursive: true, force: true });
});

test("a restart RESUMES the sequence — no reuse, no replay-looking gap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-dev-seq-"));
  await withEnv({ AETHER_CONFIG_DIR: dir, AETHER_DEVICE_RUNTIME: "1" }, async () => {
    const seqs: number[] = [];
    for (let run = 0; run < 3; run++) {
      const { published, net } = captureNet();
      await runDeviceDaemon({
        enrollment: ENROLLMENT,
        net,
        maxIterations: 1,
        bootTimeMs: 1_000, // the SAME boot across all three restarts
        telemetryInputs: fakeInputs(),
        repoProbe: () => null,
        now: () => 2_000_000,
      });
      seqs.push(published[0]!.seq);
    }
    // Strictly increasing by one: a restart neither reuses a seq nor skips one.
    assert.deepEqual(seqs, [1, 2, 3]);
  });
  rmSync(dir, { recursive: true, force: true });
});

test("a NEW boot mints a fresh boot_id and restarts the sequence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-dev-boot-"));
  await withEnv({ AETHER_CONFIG_DIR: dir, AETHER_DEVICE_RUNTIME: "1" }, async () => {
    const first = captureNet();
    await runDeviceDaemon({
      enrollment: ENROLLMENT, net: first.net, maxIterations: 1, bootTimeMs: 1_000,
      telemetryInputs: fakeInputs(), repoProbe: () => null, now: () => 2_000_000,
    });
    const second = captureNet();
    await runDeviceDaemon({
      enrollment: ENROLLMENT, net: second.net, maxIterations: 1, bootTimeMs: 9_000_000,
      telemetryInputs: fakeInputs(), repoProbe: () => null, now: () => 2_000_000,
    });
    const a = first.published[0]!;
    const b = second.published[0]!;
    assert.notEqual(a.boot_id, b.boot_id, "a new boot must mint a new boot_id");
    assert.equal(b.seq, 1, "a new boot restarts the sequence at 1");
  });
  rmSync(dir, { recursive: true, force: true });
});

test("an offline pass keeps the frame queued instead of losing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-dev-off-"));
  await withEnv({ AETHER_CONFIG_DIR: dir, AETHER_DEVICE_RUNTIME: "1" }, async () => {
    const { published, net } = captureNet("retry");
    await runDeviceDaemon({
      enrollment: ENROLLMENT, net, maxIterations: 1, bootTimeMs: 1_000,
      telemetryInputs: fakeInputs(), repoProbe: () => null, now: () => 2_000_000,
    });
    assert.equal(published.length, 1, "the daemon attempted the publish");
    const state = readDaemonState();
    assert.equal(state?.online, false, "a retryable failure reports offline");
    assert.equal(state?.queue_depth, 1, "the unsent frame stays queued");
    assert.equal(state?.last_publish_seq, 1);
  });
  rmSync(dir, { recursive: true, force: true });
});

test("daemonStartRefusal returns null once enabled and enrolled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-dev-daemon-"));
  await withEnv({ AETHER_CONFIG_DIR: dir, AETHER_DEVICE_RUNTIME: "1" }, async () => {
    const record: EnrollmentRecord = {
      device_id: "dev-1",
      device_token: "tok",
      device_command_key: "key",
      display_name: "host",
      base_url: "https://api.example.test/cloud",
      enrolled_at: 0,
    };
    saveEnrollment(record);
    assert.equal(daemonStartRefusal(), null);
  });
  rmSync(dir, { recursive: true, force: true });
});
