import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STALE_PUBLISH_MS, buildDeviceDoctorReport, type DoctorProbes } from "../src/core/device_runtime/doctor.js";
import { DAEMON_STATE_SCHEMA, daemonPidAlive, readDaemonState, writeDaemonState, type DaemonState } from "../src/core/device_runtime/daemon_state.js";
import { saveEnrollment, type EnrollmentRecord } from "../src/core/device_runtime/identity.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { AetherConfig } from "../src/types.js";
import type { HealthReport } from "../src/core/health.js";

const NOW = 1_700_000_000_000;

function withConfigDir<T>(body: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "aether-dev-doc-"));
  const prior = process.env["AETHER_CONFIG_DIR"];
  const priorEnv = process.env["AETHER_DEVICE_RUNTIME"];
  process.env["AETHER_CONFIG_DIR"] = dir;
  delete process.env["AETHER_DEVICE_RUNTIME"];
  return body().finally(() => {
    if (prior === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = prior;
    if (priorEnv !== undefined) process.env["AETHER_DEVICE_RUNTIME"] = priorEnv;
    rmSync(dir, { recursive: true, force: true });
  });
}

function probes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    cloud: async () => ({ reachable: true, status: 200, latencyMs: 5 }),
    jobObject: async () => true,
    scheduledTask: () => false,
    now: () => NOW,
    ...overrides,
  };
}

function cfg(overrides: Partial<AetherConfig> = {}): AetherConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function check(report: HealthReport, id: string): HealthReport["checks"][number] {
  const found = report.checks.find((c) => c.id === id);
  assert.ok(found, `no check ${id}`);
  return found;
}

const RECORD: EnrollmentRecord = {
  device_id: "dev-doc",
  device_token: "tok",
  device_command_key: "key",
  display_name: "host",
  base_url: "https://api.example.test/cloud",
  enrolled_at: 0,
};

function state(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    schema: DAEMON_STATE_SCHEMA,
    pid: process.pid,
    started_at: NOW - 60_000,
    updated_at: NOW - 1_000,
    device_id: "dev-doc",
    boot_id: "boot-1",
    last_publish_seq: 7,
    last_command_id: null,
    throttled: false,
    queue_depth: 0,
    online: true,
    agent_version: "0.3.0",
    ...overrides,
  };
}

test("an unenrolled, disabled, never-started device reports every axis honestly", async () => {
  await withConfigDir(async () => {
    const report = await buildDeviceDoctorReport(cfg(), probes());
    assert.equal(check(report, "device.enrollment").configured.state, "no");
    assert.equal(check(report, "device.enabled").configured.state, "no");
    assert.equal(check(report, "device.daemon").configured.state, "no");
    // "Never published" is NOT reported as a fresh verification.
    assert.equal(check(report, "device.publish").verified.state, "not-checked");
  });
});

test("enrollment and the opt-in are reported once each is in place", async () => {
  await withConfigDir(async () => {
    saveEnrollment(RECORD);
    const report = await buildDeviceDoctorReport(cfg({ deviceRuntime: { enabled: true } }), probes());
    assert.equal(check(report, "device.enrollment").configured.state, "yes");
    assert.match(check(report, "device.enrollment").configured.evidence ?? "", /dev-doc/);
    assert.equal(check(report, "device.enabled").configured.state, "yes");
  });
});

test("the doctor NEVER prints the device token or command key", async () => {
  await withConfigDir(async () => {
    saveEnrollment(RECORD);
    writeDaemonState(state());
    const report = await buildDeviceDoctorReport(cfg({ deviceRuntime: { enabled: true } }), probes());
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(RECORD.device_token), false, "the device token leaked into the report");
    assert.equal(serialized.includes(RECORD.device_command_key), false, "the command key leaked into the report");
  });
});

test("a heartbeat older than the stale bound fails the publish check", async () => {
  await withConfigDir(async () => {
    writeDaemonState(state({ updated_at: NOW - (STALE_PUBLISH_MS + 5_000) }));
    const report = await buildDeviceDoctorReport(cfg(), probes());
    const publish = check(report, "device.publish");
    assert.equal(publish.verified.state, "no");
    assert.match(publish.verified.evidence ?? "", /s ago/);
  });
});

test("a fresh heartbeat from a live pid verifies the daemon", async () => {
  await withConfigDir(async () => {
    writeDaemonState(state());
    const report = await buildDeviceDoctorReport(cfg({ deviceRuntime: { enabled: true } }), probes());
    assert.equal(check(report, "device.daemon").reachable.state, "yes");
    assert.equal(check(report, "device.publish").verified.state, "yes");
  });
});

test("an unreachable Cloud is a warning, not a crash", async () => {
  await withConfigDir(async () => {
    const report = await buildDeviceDoctorReport(
      cfg(),
      probes({ cloud: async () => ({ reachable: false, status: null, latencyMs: 900 }) }),
    );
    const cloud = check(report, "device.cloud");
    assert.equal(cloud.reachable.state, "no");
    assert.equal(cloud.severity, "warning");
  });
});

test("daemon state round-trips and a stale pid reads as not running", async () => {
  await withConfigDir(async () => {
    assert.equal(readDaemonState(), null);
    writeDaemonState(state());
    assert.equal(readDaemonState()?.last_publish_seq, 7);
    assert.equal(daemonPidAlive(process.pid), true);
    assert.equal(daemonPidAlive(0), false);
    assert.equal(daemonPidAlive(-1), false);
    // A pid that cannot exist reads as dead rather than throwing.
    assert.equal(daemonPidAlive(0x7ffffffe), false);
  });
});
