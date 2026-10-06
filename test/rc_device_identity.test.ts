import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "../src/core/transport.js";
import { StaticTokenStore } from "../src/core/auth.js";
import { loadOrCreateRcInstallationId, resolveRcDeviceIdentity } from "../src/core/rc/device_identity.js";
import { cmdRc } from "../src/commands/rc.js";
import { payloadDigest } from "../src/core/rc/receipts.js";
import type { AppContext } from "../src/core/context.js";
import type { CommandFlags } from "../src/core/command_dispatch.js";

test("RC installation label seed is stable and corrupt state cannot silently change identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-rc-identity-"));
  const path = join(dir, "identity.json");
  try {
    const first = loadOrCreateRcInstallationId(path);
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    assert.equal(loadOrCreateRcInstallationId(path), first);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).installation_id, first);
    writeFileSync(path, "broken", "utf8");
    assert.throws(() => loadOrCreateRcInstallationId(path), /corrupt/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Cloud resolves the RC label from account auth without calling SC enrollment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-rc-account-"));
  const path = join(dir, "identity.json");
  const previous = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    assert.equal(url.pathname, "/remote/device-identity");
    assert.equal(init?.method, "POST");
    assert.match(JSON.parse(String(init?.body)).installation_id, /^[0-9a-f-]{36}$/);
    return new Response(JSON.stringify({ schema_version: "aether.remote_device_identity.v1", device_id: "rcd_" + "a".repeat(32) }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const api = new ApiClient("https://example.test", new StaticTokenStore("aek_normal_account"));
    assert.equal((await resolveRcDeviceIdentity(api, path)).device_id, "rcd_" + "a".repeat(32));
    assert.deepEqual(calls, ["/remote/device-identity"]);
  } finally { globalThis.fetch = previous; rmSync(dir, { recursive: true, force: true }); }
});

test("ordinary RC start uses its own identity and publishes with zero SC enrollment calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-rc-normal-"));
  const priorConfig = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = dir;
  const calls: string[] = [];
  const sessionId = "rs_" + "1".repeat(32);
  const api = {
    async postJson(path: string, body: unknown): Promise<unknown> {
      calls.push(path);
      if (path === "/remote/device-identity") return { schema_version: "aether.remote_device_identity.v1", device_id: "rcd_" + "a".repeat(32) };
      if (path === "/remote/sessions") {
        assert.equal((body as { device_id: string }).device_id, "rcd_" + "a".repeat(32));
        return { session_id: sessionId, state: "pending_host" };
      }
      if (path.endsWith("/host/attach")) return { session_id: sessionId, state: "live" };
      if (path.endsWith("/host/events")) {
        const events = (body as { events: Array<{ host_event_id: string; payload: Record<string, unknown> }> }).events;
        return { session_id: sessionId, receipts: events.map((event, index) => ({
          host_event_id: event.host_event_id, seq: index + 1, payload_digest: payloadDigest(event.payload),
        })) };
      }
      if (path.endsWith("/grants")) return {
        session_id: sessionId, purpose: "observe", device_id: (body as { device_id: string }).device_id,
        token: "rsgt_" + "b".repeat(48), expires_at: new Date(Date.now() + 300_000).toISOString(),
      };
      throw new Error(`unexpected route ${path}`);
    },
  };
  const output: string[] = [];
  const ctx = { api, flags: { cwd: dir, json: true } } as unknown as AppContext;
  const flags = { str: () => undefined } as unknown as CommandFlags;
  try {
    assert.equal(await cmdRc(ctx, ["start"], flags, {
      cwd: dir, connector: () => null, browser: () => null,
      repo: () => ({ repo: "fixture", branch: "main", base_commit: "0".repeat(40), dirty_file_count: 0 }),
      out: text => output.push(text), err: text => { throw new Error(text); }, isTTY: false, columns: 80,
    }), 0);
    assert.equal(JSON.parse(output[0]!).device_id, "rcd_" + "a".repeat(32));
    assert.equal(calls[0], "/remote/device-identity");
    assert.ok(calls.every(path => !path.includes("/device/v1/")));
  } finally {
    if (priorConfig === undefined) delete process.env["AETHER_CONFIG_DIR"]; else process.env["AETHER_CONFIG_DIR"] = priorConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RC identity refusal stops before session registration with an actionable code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-rc-refused-"));
  const priorConfig = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = dir;
  const calls: string[] = [];
  const errors: string[] = [];
  const ctx = { api: { async postJson(path: string) {
    calls.push(path);
    throw Object.assign(new Error("private Cloud detail"), { status: 403 });
  } }, flags: { cwd: dir, json: false } } as unknown as AppContext;
  try {
    assert.equal(await cmdRc(ctx, ["start"], { str: () => undefined } as unknown as CommandFlags, {
      cwd: dir, connector: () => null, browser: () => null,
      repo: () => ({ repo: "fixture", branch: "main", base_commit: "0".repeat(40), dirty_file_count: 0 }),
      out: () => {}, err: text => errors.push(text), isTTY: false, columns: 80,
    }), 1);
    assert.deepEqual(calls, ["/remote/device-identity"]);
    assert.match(errors.join(""), /RC_NOT_AUTHORIZED/);
    assert.doesNotMatch(errors.join(""), /private Cloud detail/);
  } finally {
    if (priorConfig === undefined) delete process.env["AETHER_CONFIG_DIR"]; else process.env["AETHER_CONFIG_DIR"] = priorConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});
