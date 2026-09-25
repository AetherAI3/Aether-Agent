import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PcActionBroker, type PcActionRequest } from "../src/core/pc/broker.js";
import { isPcTarget, pcDoctor, pcMap, pcTargetUrl } from "../src/core/pc/doctor.js";
import { findManifestCommand } from "../src/commands/command_manifest.js";

const request: PcActionRequest = {
  adapter: "browser.open", operation: "open", target: "claude", expectedState: "MSEdgeHTM",
};

test("PC broker binds one action to interactive approval, fresh state and one use", async () => {
  let approvals = 0;
  let effects = 0;
  const broker = new PcActionBroker("session-a", "user-a", {
    interactive: true,
    approve: async () => { approvals++; return true; },
  }, () => 1_000);
  const plan = broker.plan(request);
  const first = await broker.execute(plan, () => "MSEdgeHTM", () => { effects++; return true; });
  assert.equal(first.status, "succeeded");
  assert.equal(approvals, 1);
  assert.equal(effects, 1);
  assert.equal((await broker.execute(plan, () => "MSEdgeHTM", () => { effects++; return true; })).status, "denied");
  assert.equal(effects, 1);
});

test("PC broker refuses changed request, stale target, expiry and revocation", async () => {
  let now = 1_000;
  let effects = 0;
  const broker = new PcActionBroker("session-a", "user-a", {
    interactive: true, approve: async () => true,
  }, () => now);
  const changed = broker.plan(request);
  assert.equal((await broker.execute({ ...changed, target: "chatgpt" }, () => request.expectedState, () => { effects++; return true; })).status, "denied");
  const stale = broker.plan(request);
  assert.equal((await broker.execute(stale, () => "different-browser", () => { effects++; return true; })).status, "stale");
  const expired = broker.plan(request, 50);
  now += 50;
  assert.equal((await broker.execute(expired, () => request.expectedState, () => { effects++; return true; })).status, "denied");
  const revoked = broker.plan(request);
  broker.revoke();
  assert.equal((await broker.execute(revoked, () => request.expectedState, () => { effects++; return true; })).status, "denied");
  assert.equal(effects, 0);
});

test("headless or declined approval never reaches the adapter", async () => {
  for (const approval of [{ interactive: false, approve: async () => true }, { interactive: true, approve: async () => false }]) {
    let effects = 0;
    const broker = new PcActionBroker("s", "u", approval);
    const plan = broker.plan(request);
    assert.equal((await broker.execute(plan, () => request.expectedState, () => { effects++; return true; })).status, "denied");
    assert.equal(effects, 0);
  }
});

test("PC map reports unavailable control rather than inheriting legacy shell authority", () => {
  const map = pcMap("win32", () => 0);
  assert.equal(map.schema, "aether.pc/1");
  assert.equal(map.capabilities.find((item) => item.id === "pc.act")?.state, "unavailable");
  assert.equal(map.capabilities.find((item) => item.id === "command.execute")?.state, "denied");
  assert.equal(map.capabilities.find((item) => item.id === "device.runtime")?.state, "unavailable");
  assert.ok(["unverified", "unavailable"].includes(map.capabilities.find((item) => item.id === "browser.verify")?.state ?? ""));
  assert.equal(map.capabilities.find((item) => item.id === "cloud.act")?.state, "unverified");
});

test("PC doctor does not contact remote targets unless explicitly requested", async () => {
  const called: string[] = [];
  const deps = {
    wait: async () => {},
    fetchHead: async (url: string) => { called.push(url); return [10, 12, 30][called.length - 1]!; },
    processProbe: () => ({ state: "measured" as const, items: [] }),
  };
  const root = process.cwd();
  const offline = await pcDoctor("claude", root, false, deps);
  assert.deepEqual(called, []);
  assert.equal(offline.metrics.find((item) => item.id === "target.reachability_p50")?.state, "not-checked");
  const online = await pcDoctor("claude", root, true, deps);
  assert.deepEqual(called, Array(3).fill(pcTargetUrl("claude")));
  assert.equal(online.metrics.find((item) => item.id === "target.reachability_p50")?.value, 12);
  assert.equal(online.metrics.find((item) => item.id === "target.reachability_p95")?.value, 30);
  assert.equal(online.processes.state, "measured");
});

test("target set and command manifest stay closed and visible", () => {
  assert.equal(isPcTarget("http://127.0.0.1:1234"), false);
  assert.equal(isPcTarget("claude"), true);
  const entry = findManifestCommand("shell", "pc");
  assert.equal(entry?.docs.visible, true);
  assert.equal(entry?.ownedFlags["probe-network"]?.type, "boolean");
  assert.equal(entry?.release?.disposition, "new");
});

test("CLI cannot turn --yes into PC browser approval", () => {
  const entry = fileURLToPath(new URL("../src/main.js", import.meta.url));
  for (const args of [["verify-browser"], ["open", "claude"]]) {
    const result = spawnSync(process.execPath, [entry, "pc", ...args, "--yes", "--json"], {
      encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /fresh interactive approval/);
    assert.equal(result.stdout, "");
  }
});
