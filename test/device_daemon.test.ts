// The daemon is default-OFF, and that is the single most important thing about
// it: a persistent, boot-launched process that talks to a remote control plane
// must never start because it happened to be installed. Opting in is an
// explicit operator act, and the refusal is asserted from both entry points.
//
// The rest of the file covers the loops' observable contract — the state file
// the CLI reads, the sample/publish cycle, and the poll/execute/post cycle —
// all with an injected DeviceNet so nothing opens a socket.

import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { daemonStartRefusal, runDeviceDaemon } from "../src/core/device_runtime/daemon.js";
import { DeviceNet } from "../src/core/device_runtime/net.js";
import { DAEMON_STATE_SCHEMA, daemonPidAlive, readDaemonState, writeDaemonState } from "../src/core/device_runtime/daemon_state.js";
import { deviceRuntimeEnabled } from "../src/core/device_runtime/enablement.js";
import { saveEnrollment, type EnrollmentRecord } from "../src/core/device_runtime/identity.js";
import { daemonStatePath } from "../src/core/device_runtime/paths.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { CommandResult, DeviceCommand, DeviceObservation } from "../src/core/device_runtime/contract.js";
import { signedCommand, withDeviceSandbox, withDeviceSandboxAsync, TEST_COMMAND_KEY, TEST_DEVICE_ID } from "./device_sandbox.js";

const ENROLLMENT: EnrollmentRecord = {
  device_id: TEST_DEVICE_ID,
  device_token: "dt_token",
  device_command_key: TEST_COMMAND_KEY,
  display_name: "workstation",
  base_url: "https://api.example.test",
  enrolled_at: 1_700_000_000_000,
};

/** A DeviceNet stand-in that records traffic and answers from a script. */
function fakeNet(commands: DeviceCommand[][] = []): {
  net: DeviceNet;
  published: DeviceObservation[];
  results: CommandResult[];
} {
  const published: DeviceObservation[] = [];
  const results: CommandResult[] = [];
  let poll = 0;
  const net = {
    observe: async (o: DeviceObservation) => { published.push(o); return "ok" as const; },
    pollCommands: async () => commands[poll++] ?? [],
    postResult: async (r: CommandResult) => { results.push(r); },
    registerGroup: async () => {},
    offerHandoff: async () => {},
    health: async () => ({ reachable: true, status: 200, latencyMs: 1 }),
  } as unknown as DeviceNet;
  return { net, published, results };
}

// ── Default-off ─────────────────────────────────────────────────────────────

test("the runtime is OFF unless explicitly opted in", () => {
  const off = { ...DEFAULT_CONFIG };
  // Absence is off. `enabled: false` is off. Any env value other than exactly
  // "1" is off — "true"/"yes"/"0" must not smuggle the daemon into running.
  assert.equal(deviceRuntimeEnabled(off, {}), false);
  assert.equal(deviceRuntimeEnabled({ ...off, deviceRuntime: {} }, {}), false);
  assert.equal(deviceRuntimeEnabled({ ...off, deviceRuntime: { enabled: false } }, {}), false);
  for (const value of ["true", "yes", "0", "", "on", "2"]) {
    assert.equal(deviceRuntimeEnabled(off, { AETHER_DEVICE_RUNTIME: value }), false, `env value ${JSON.stringify(value)} must not enable`);
  }
  // The two documented opt-ins, and only those.
  assert.equal(deviceRuntimeEnabled({ ...off, deviceRuntime: { enabled: true } }, {}), true);
  assert.equal(deviceRuntimeEnabled(off, { AETHER_DEVICE_RUNTIME: "1" }), true);
});

test("daemonStartRefusal names disabled before it names unenrolled", () => {
  withDeviceSandbox(() => {
    // Nothing configured at all: the refusal an operator sees first should be
    // the one they must act on first.
    assert.match(String(daemonStartRefusal()), /device runtime is disabled/);

    process.env["AETHER_DEVICE_RUNTIME"] = "1";
    assert.match(String(daemonStartRefusal()), /not enrolled/);

    saveEnrollment(ENROLLMENT);
    assert.equal(daemonStartRefusal(), null);
  });
});

test("runDeviceDaemon refuses to run when the runtime is disabled", async () => {
  await withDeviceSandboxAsync(async () => {
    saveEnrollment(ENROLLMENT);
    // Enrolled but NOT opted in — the daemon must still refuse. Exit 3 is the
    // "disabled" code the CLI and the scheduled task both key off.
    const code = await runDeviceDaemon({ maxIterations: 1, now: () => 1_000 });
    assert.equal(code, 3);
    // Nothing was started, so no heartbeat was ever written.
    assert.equal(readDaemonState(), null);
  });
});

test("runDeviceDaemon refuses to run when the device is not enrolled", async () => {
  await withDeviceSandboxAsync(async () => {
    process.env["AETHER_DEVICE_RUNTIME"] = "1";
    const code = await runDeviceDaemon({ maxIterations: 1, now: () => 1_000 });
    assert.equal(code, 4);
    assert.equal(readDaemonState(), null);
  });
});

// ── Loops ───────────────────────────────────────────────────────────────────

test("one sample cycle publishes an allowlisted frame and writes the heartbeat", async () => {
  await withDeviceSandboxAsync(async () => {
    process.env["AETHER_DEVICE_RUNTIME"] = "1";
    saveEnrollment(ENROLLMENT);
    const { net, published } = fakeNet();

    const code = await runDeviceDaemon({ enrollment: ENROLLMENT, net, maxIterations: 1, now: () => 1_700_000_100_000 });
    assert.equal(code, 0);

    assert.equal(published.length, 1);
    const frame = published[0]!;
    assert.equal(frame.device_id, TEST_DEVICE_ID);
    assert.equal(frame.seq, 1, "the per-boot sequence starts at 1");
    assert.ok(frame.boot_id.length > 0);
    // The frame went through serializeObservation, so it carries no extra keys.
    assert.equal(Object.hasOwn(frame as object, "env"), false);
    assert.equal(Object.hasOwn(frame as object, "argv"), false);

    const state = readDaemonState();
    assert.equal(state?.schema, DAEMON_STATE_SCHEMA);
    assert.equal(state?.device_id, TEST_DEVICE_ID);
    assert.equal(state?.last_publish_seq, 1);
    assert.equal(state?.pid, process.pid);
    assert.equal(state?.online, true);
    // The heartbeat is a status surface, not a secret store.
    const raw = JSON.stringify(state);
    assert.ok(!raw.includes(ENROLLMENT.device_token), "the daemon state file must not carry the device token");
    assert.ok(!raw.includes(TEST_COMMAND_KEY), "the daemon state file must not carry the command key");
  });
});

test("a polled command is executed once and its result posted back", async () => {
  await withDeviceSandboxAsync(async () => {
    process.env["AETHER_DEVICE_RUNTIME"] = "1";
    saveEnrollment(ENROLLMENT);
    const cmd = signedCommand({ command_class: "throttle", outbox_seq: 1, expires_at: 1_700_000_900_000 });
    const { net, results } = fakeNet([[cmd]]);

    await runDeviceDaemon({ enrollment: ENROLLMENT, net, maxIterations: 1, now: () => 1_700_000_100_000 });

    assert.equal(results.length, 1);
    assert.equal(results[0]!.command_id, cmd.command_id);
    assert.equal(results[0]!.status, "completed");
    assert.equal(results[0]!.device_id, TEST_DEVICE_ID);
    assert.equal(readDaemonState()?.last_command_id, cmd.command_id);
    assert.equal(readDaemonState()?.throttled, true);
  });
});

test("a forged command is rejected by the daemon loop, not executed", async () => {
  await withDeviceSandboxAsync(async () => {
    process.env["AETHER_DEVICE_RUNTIME"] = "1";
    saveEnrollment(ENROLLMENT);
    // Correctly shaped, but signed with a key this device does not hold.
    const forged = signedCommand({ command_class: "emergency_terminate", process_group_id: "grp-x", expires_at: 1_700_000_900_000 }, "attacker-key");
    const { net, results } = fakeNet([[forged]]);

    await runDeviceDaemon({ enrollment: ENROLLMENT, net, maxIterations: 1, now: () => 1_700_000_100_000 });

    assert.equal(results.length, 1);
    assert.equal(results[0]!.status, "rejected");
    assert.match(results[0]!.detail, /signature verification failed/);
    // A rejected command must still be REPORTED — silence would look identical
    // to a device that never received it.
    assert.equal(readDaemonState()?.throttled, false);
  });
});

// ── State file ──────────────────────────────────────────────────────────────

test("the daemon state file round-trips and rejects a foreign schema", () => {
  withDeviceSandbox(() => {
    writeDaemonState({
      schema: DAEMON_STATE_SCHEMA,
      pid: 4242,
      started_at: 1,
      updated_at: 2,
      device_id: TEST_DEVICE_ID,
      boot_id: "boot-1",
      last_publish_seq: 9,
      last_command_id: null,
      throttled: false,
      queue_depth: 0,
      online: true,
      agent_version: "0.3.0",
    });
    assert.equal(readDaemonState()?.last_publish_seq, 9);

    if (process.platform !== "win32") {
      assert.equal(statSync(daemonStatePath()).mode & 0o077, 0);
    }

    // A state file from a future or foreign schema reads as absent rather than
    // being interpreted with this version's field meanings.
    writeFileSync(daemonStatePath(), JSON.stringify({ schema: "aether.device.daemon-state/2", pid: 1 }), "utf8");
    assert.equal(readDaemonState(), null);
    writeFileSync(daemonStatePath(), "{broken", "utf8");
    assert.equal(readDaemonState(), null);
  });
});

test("liveness distinguishes a running daemon from a stale state file", () => {
  // Our own pid is alive by construction; a pid that cannot exist is not.
  assert.equal(daemonPidAlive(process.pid), true);
  assert.equal(daemonPidAlive(0), false);
  assert.equal(daemonPidAlive(-1), false);
  assert.equal(daemonPidAlive(1.5), false);
});

test("the runtime directory is created private and holds every runtime file", () => {
  withDeviceSandbox((dir) => {
    writeDaemonState({
      schema: DAEMON_STATE_SCHEMA,
      pid: 1, started_at: 1, updated_at: 1,
      device_id: TEST_DEVICE_ID, boot_id: "b", last_publish_seq: 0,
      last_command_id: null, throttled: false, queue_depth: 0, online: false,
      agent_version: "0.3.0",
    });
    const runtimeDir = join(dir, "device-runtime");
    if (process.platform !== "win32") {
      assert.equal(statSync(runtimeDir).mode & 0o077, 0, "the runtime directory must not be group/world readable");
    }
    assert.equal(daemonStatePath().startsWith(runtimeDir), true);
  });
});
