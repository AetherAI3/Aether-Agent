// DeviceNet is the device's only outbound surface, and the two things worth
// asserting about it are that it refuses to carry a bearer over cleartext, and
// that it maps HTTP outcomes onto the publisher's retry/reject decision the way
// the contract's offline behaviour depends on. Doctor is the operator-facing
// readout, where the rule is that a cached heartbeat is never rendered as fresh
// verification.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DeviceNet } from "../src/core/device_runtime/net.js";
import { buildDeviceDoctorReport, STALE_PUBLISH_MS, type DoctorProbes } from "../src/core/device_runtime/doctor.js";
import { DAEMON_STATE_SCHEMA, writeDaemonState } from "../src/core/device_runtime/daemon_state.js";
import { saveEnrollment } from "../src/core/device_runtime/identity.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { COMMAND_SCHEMA, type DeviceObservation } from "../src/core/device_runtime/contract.js";
import { TEST_DEVICE_ID, withDeviceSandbox, withDeviceSandboxAsync } from "./device_sandbox.js";

const OBS = { schema: "aether.device.observation/1", device_id: TEST_DEVICE_ID, seq: 1 } as unknown as DeviceObservation;

function response(status: number, body: unknown = null): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

test("a cleartext base URL is refused so a bearer never traverses it", () => {
  // The device token is a long-lived credential; handing it to an http:// host
  // would put it on the wire in plaintext for anyone on the path.
  assert.throws(() => new DeviceNet("http://cloud.example.com", "dt_token"), /insecure base URL/);
  assert.doesNotThrow(() => new DeviceNet("https://cloud.example.com", "dt_token"));
  // Loopback http is the documented local-dev exception.
  assert.doesNotThrow(() => new DeviceNet("http://127.0.0.1:8080", "dt_token"));
});

test("observe maps HTTP outcomes onto retry vs reject correctly", async () => {
  const cases: Array<[number, "ok" | "retry" | "reject"]> = [
    [200, "ok"],
    [204, "ok"],
    // The Cloud declined this specific frame — re-sending it forever would
    // wedge the queue behind a frame that can never succeed.
    [400, "reject"],
    [401, "reject"],
    [409, "reject"],
    [422, "reject"],
    // Transient: keep the frame and back off.
    [408, "retry"],
    [429, "retry"],
    [500, "retry"],
    [503, "retry"],
  ];
  for (const [status, expected] of cases) {
    const net = new DeviceNet("https://cloud.example.test", "dt", { fetchImpl: async () => response(status) });
    assert.equal(await net.observe(OBS), expected, `HTTP ${status} should be ${expected}`);
  }
  // A thrown transport error is retryable, never a silent drop.
  const flaky = new DeviceNet("https://cloud.example.test", "dt", {
    fetchImpl: async () => { throw new Error("ECONNRESET"); },
  });
  assert.equal(await flaky.observe(OBS), "retry");
});

test("every outbound request carries the device bearer and JSON content type", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const net = new DeviceNet("https://cloud.example.test/", "dt_secret", {
    fetchImpl: async (url, init) => { seen.push({ url, init }); return response(200, { commands: [] }); },
  });
  await net.observe(OBS);
  const headers = seen[0]!.init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer dt_secret");
  assert.equal(headers["Content-Type"], "application/json");
  // A trailing slash on the base URL must not produce a doubled path.
  assert.equal(seen[0]!.url, "https://cloud.example.test/device/v1/observe");
});

test("the command poll accepts every documented body shape and 204 as empty", async () => {
  const cmd = { schema: COMMAND_SCHEMA, command_id: "c1" };
  const shapes: Array<[unknown, number, number]> = [
    [[cmd], 200, 1],                    // a bare array
    [{ commands: [cmd] }, 200, 1],      // an envelope
    [cmd, 200, 1],                      // a single command object
    [{ commands: [] }, 200, 0],
    [null, 204, 0],                     // long-poll timed out with nothing
    [{ unexpected: true }, 200, 0],     // an unrecognised body is empty, not a throw
  ];
  for (const [body, status, expected] of shapes) {
    const net = new DeviceNet("https://cloud.example.test", "dt", { fetchImpl: async () => response(status, body) });
    assert.equal((await net.pollCommands(1)).length, expected, `body ${JSON.stringify(body)}`);
  }
  // A hard error surfaces rather than being read as "no commands", which would
  // make a broken control plane look like a quiet one.
  const broken = new DeviceNet("https://cloud.example.test", "dt", { fetchImpl: async () => response(500) });
  await assert.rejects(broken.pollCommands(1), /command poll failed: HTTP 500/);
});

test("posting a result surfaces a failure rather than silently dropping it", async () => {
  const failing = new DeviceNet("https://cloud.example.test", "dt", { fetchImpl: async () => response(502) });
  await assert.rejects(
    failing.postResult({
      schema: "aether.device.command_result/1",
      command_id: "c1", device_id: TEST_DEVICE_ID, boot_id: "b", result_seq: 1,
      status: "completed", detail: "", receipt: {}, completed_at: 1,
    }),
    /posting command result failed: HTTP 502/,
  );
});

test("the health probe never throws, so doctor always renders", async () => {
  const down = new DeviceNet("https://cloud.example.test", "dt", {
    fetchImpl: async () => { throw new Error("ENOTFOUND"); },
  });
  const result = await down.health();
  assert.equal(result.reachable, false);
  assert.equal(result.status, null);
  assert.ok(result.latencyMs >= 0);
});

// ── Doctor ──────────────────────────────────────────────────────────────────

function probes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    cloud: async () => ({ reachable: true, status: 200, latencyMs: 12 }),
    jobObject: async () => true,
    scheduledTask: () => false,
    now: () => 1_700_000_100_000,
    ...overrides,
  };
}

test("doctor reports an unenrolled, disabled device with actionable remediation", async () => {
  await withDeviceSandboxAsync(async () => {
    const report = await buildDeviceDoctorReport(DEFAULT_CONFIG, probes());
    const byId = new Map(report.checks.map((c) => [c.id, c]));

    const enrollment = byId.get("device.enrollment");
    assert.equal(enrollment?.configured.state, "no");
    assert.match(String(enrollment?.remediation), /aether device enroll/);

    const enabled = byId.get("device.enabled");
    assert.equal(enabled?.configured.state, "no");
    assert.match(String(enabled?.remediation), /AETHER_DEVICE_RUNTIME=1|deviceRuntime\.enabled/);

    // The daemon is not running, but with the runtime disabled that is the
    // CORRECT state — it must not be reported as a warning.
    assert.equal(byId.get("device.daemon")?.severity, "info");
  });
});

test("doctor reports a stale heartbeat as unverified, with the cached timestamp", async () => {
  await withDeviceSandboxAsync(async () => {
    const now = 1_700_000_100_000;
    saveEnrollment({
      device_id: TEST_DEVICE_ID, device_token: "dt", device_command_key: "k",
      display_name: "workstation", base_url: "https://cloud.example.test", enrolled_at: 1,
    });
    // A heartbeat older than the contract's 30s staleness threshold.
    const staleAt = now - STALE_PUBLISH_MS - 5_000;
    writeDaemonState({
      schema: DAEMON_STATE_SCHEMA, pid: 999_999, started_at: staleAt, updated_at: staleAt,
      device_id: TEST_DEVICE_ID, boot_id: "b", last_publish_seq: 7, last_command_id: null,
      throttled: false, queue_depth: 3, online: false, agent_version: "0.3.0",
    });

    const report = await buildDeviceDoctorReport(DEFAULT_CONFIG, probes({ now: () => now }));
    const publish = report.checks.find((c) => c.id === "device.publish");
    assert.equal(publish?.verified.state, "no", "a stale heartbeat is not a verified publish");
    // The evidence is stamped with WHEN it was observed, so a cached reading is
    // never rendered as a fresh probe.
    assert.equal(publish?.verified.checkedAt, new Date(staleAt).toISOString());
    assert.match(String(publish?.verified.evidence), /s ago/);
  });
});

test("doctor marks Job Object containment not-applicable off Windows", async () => {
  await withDeviceSandboxAsync(async () => {
    const report = await buildDeviceDoctorReport(DEFAULT_CONFIG, probes({ jobObject: async () => false }));
    const job = report.checks.find((c) => c.id === "device.job_object");
    if (process.platform === "win32") {
      // A Windows box that cannot create a job cannot contain anything, so this
      // is a real warning rather than an informational note.
      assert.equal(job?.verified.state, "no");
      assert.equal(job?.severity, "warning");
    } else {
      assert.equal(job?.configured.state, "na");
      assert.equal(job?.verified.state, "na");
    }
  });
});

test("doctor treats the boot-persistence task as optional, never an error", async () => {
  await withDeviceSandboxAsync(async () => {
    const absent = await buildDeviceDoctorReport(DEFAULT_CONFIG, probes({ scheduledTask: () => false }));
    const check = absent.checks.find((c) => c.id === "device.scheduled_task");
    // Boot persistence is an explicit operator opt-in; not having installed it
    // is the DEFAULT, so flagging it would train operators to ignore doctor.
    assert.equal(check?.severity, "info");
    assert.match(String(check?.remediation), /optional/);

    const present = await buildDeviceDoctorReport(DEFAULT_CONFIG, probes({ scheduledTask: () => true }));
    assert.equal(present.checks.find((c) => c.id === "device.scheduled_task")?.configured.state, "yes");
  });
});

test("an unreachable Cloud is a warning that does not fail the whole report", async () => {
  withDeviceSandbox(() => {});
  await withDeviceSandboxAsync(async () => {
    const report = await buildDeviceDoctorReport(
      DEFAULT_CONFIG,
      probes({ cloud: async () => ({ reachable: false, status: null, latencyMs: 3000 }) }),
    );
    const cloud = report.checks.find((c) => c.id === "device.cloud");
    assert.equal(cloud?.reachable.state, "no");
    assert.equal(cloud?.severity, "warning");
    // Warnings are not errors: a device that is merely offline is not broken.
    assert.equal(report.summary.error, 0);
  });
});
