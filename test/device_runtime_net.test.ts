import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeviceNet } from "../src/core/device_runtime/net.js";
import {
  DEVICE_COMMANDS_POLL_PATH,
  DEVICE_GROUPS_PATH,
  DEVICE_HANDOFF_PATH,
  DEVICE_HEALTH_PATH,
  DEVICE_OBSERVE_PATH,
  OBSERVATION_SCHEMA,
  deviceCommandResultPath,
  type CommandResult,
  type DeviceObservation,
  type WorkspaceHandoffV1,
} from "../src/core/device_runtime/contract.js";

const BASE = "https://api.example.test/cloud";
const TOKEN = "dev-token-value";

function obs(): DeviceObservation {
  return {
    schema: OBSERVATION_SCHEMA,
    device_id: "d",
    boot_id: "b",
    seq: 1,
    sampled_at: 1,
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

interface Recorded {
  url: string;
  init: RequestInit;
}

function recorder(respond: (url: string) => Response): { calls: Recorded[]; fetchImpl: (url: string, init: RequestInit) => Promise<Response> } {
  const calls: Recorded[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return respond(url);
    },
  };
}

const ok = (body: unknown = {}, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("an insecure base URL is refused outright — a bearer never traverses cleartext", () => {
  for (const bad of ["http://evil.example.com/cloud", "ftp://host/x", "not a url", ""]) {
    assert.throws(() => new DeviceNet(bad, TOKEN), /insecure base URL/, `${bad} must be refused`);
  }
  // https anywhere, and http only on loopback, are the two accepted shapes.
  assert.doesNotThrow(() => new DeviceNet("https://api.example.test", TOKEN));
  assert.doesNotThrow(() => new DeviceNet("http://127.0.0.1:8787", TOKEN));
});

test("every call targets a /device/v1 path and carries the device bearer", async () => {
  const rec = recorder(() => ok());
  const net = new DeviceNet(BASE, TOKEN, { fetchImpl: rec.fetchImpl });
  await net.observe(obs());
  await net.pollCommands(1);
  await net.postResult({ command_id: "c-1" } as unknown as CommandResult);
  await net.registerGroup({ process_group_id: "g" } as never);
  await net.offerHandoff({ handoff_id: "h" } as unknown as WorkspaceHandoffV1);
  await net.health();

  const paths = rec.calls.map((c) => c.url.replace(BASE, "").replace(/\?.*$/, ""));
  assert.deepEqual(paths, [
    DEVICE_OBSERVE_PATH,
    DEVICE_COMMANDS_POLL_PATH,
    deviceCommandResultPath("c-1"),
    DEVICE_GROUPS_PATH,
    DEVICE_HANDOFF_PATH,
    DEVICE_HEALTH_PATH,
  ]);
  for (const call of rec.calls) {
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], `Bearer ${TOKEN}`);
    assert.ok(call.url.startsWith(BASE), `${call.url} left the enrolled base URL`);
  }
});

test("observe maps HTTP onto the publisher's outcome vocabulary", async () => {
  const cases: Array<[number, string]> = [
    [200, "ok"],
    [202, "ok"],
    [400, "reject"],
    [409, "reject"],
    [422, "reject"],
    [408, "retry"],
    [429, "retry"],
    [500, "retry"],
    [503, "retry"],
  ];
  for (const [status, expected] of cases) {
    const net = new DeviceNet(BASE, TOKEN, { fetchImpl: async () => ok({}, status) });
    assert.equal(await net.observe(obs()), expected, `HTTP ${status}`);
  }
});

test("a transport failure is a retry, never a silent drop", async () => {
  const net = new DeviceNet(BASE, TOKEN, {
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(await net.observe(obs()), "retry");
  // health() never throws — the doctor probe reports unreachable instead.
  assert.deepEqual((await net.health()).reachable, false);
});

test("pollCommands tolerates 204, arrays, envelopes and junk", async () => {
  const empty = new DeviceNet(BASE, TOKEN, { fetchImpl: async () => new Response(null, { status: 204 }) });
  assert.deepEqual(await empty.pollCommands(1), []);

  const arr = new DeviceNet(BASE, TOKEN, { fetchImpl: async () => ok([{ command_id: "a" }]) });
  assert.equal((await arr.pollCommands(1)).length, 1);

  const env = new DeviceNet(BASE, TOKEN, { fetchImpl: async () => ok({ commands: [{ command_id: "b" }] }) });
  assert.equal((await env.pollCommands(1)).length, 1);

  const junk = new DeviceNet(BASE, TOKEN, { fetchImpl: async () => ok({ nonsense: true }) });
  assert.deepEqual(await junk.pollCommands(1), []);

  const bad = new DeviceNet(BASE, TOKEN, { fetchImpl: async () => ok({}, 500) });
  await assert.rejects(() => bad.pollCommands(1), /command poll failed/);
});

// ── The outbound-only invariant, asserted against the source ────────────────

test("the device runtime opens NO listening socket anywhere", () => {
  const dir = fileURLToPath(new URL("../src/core/device_runtime/", import.meta.url));
  // Anything that could accept an inbound connection. The daemon is a client of
  // the Cloud and nothing else; a listener here would be a new attack surface on
  // the operator's machine, which the contract forbids outright.
  const forbidden = [
    /createServer\s*\(/,
    /\.listen\s*\(/,
    /new\s+WebSocketServer/,
    /node:net["']/,
    /node:http["']/,
    /node:https["']/,
    /node:http2["']/,
    /node:dgram["']/,
    /node:tls["']/,
  ];
  const offenders: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts")) continue;
    const source = readFileSync(join(dir, name), "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(source)) offenders.push(`${name}: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], "the device runtime must never listen for inbound connections");
});
