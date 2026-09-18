import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { managedAccountOperation, managedAccountScope, managedAgentStorageDirectory, managedBrowserOwner } from "../src/core/managed_agent_local.js";

import { ApiClient } from "../src/core/transport.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { AppContext } from "../src/core/context.js";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const agent = "mag_0123456789abcdef";
const root = resolve("local-agent-fixture");

test("managed storage includes canonical origin, account and agent without a credential-derived identity", () => {
  const scope = managedAccountScope("https://api.aethersystems.net/cloud", a);
  const path = managedAgentStorageDirectory(root, scope, agent);
  assert.equal(path, managedAgentStorageDirectory(root, managedAccountScope("https://api.aethersystems.net/other", a), agent));
  assert.notEqual(path, managedAgentStorageDirectory(root, managedAccountScope(scope.cloudOrigin, b), agent));
  assert.notEqual(path, managedAgentStorageDirectory(root, managedAccountScope("https://staging.example.test", a), agent));
  assert.notEqual(path, managedAgentStorageDirectory(root, scope, "mag_fedcba9876543210"));
  assert.throws(() => managedAccountScope(scope.cloudOrigin, "aek_not_an_account_subject"));
  assert.throws(() => managedAccountScope("https://user:secret@example.test", a));
  assert.throws(() => managedAgentStorageDirectory("relative", scope, agent));
  assert.throws(() => managedAgentStorageDirectory(root, scope, "../foreign"));
});

test("browser owner reuses only same-origin enrolled metadata and exposes no secrets", () => {
  const scope = managedAccountScope("https://api.aethersystems.net/cloud", a);
  const enrollment = () => ({ device_id: "scdev_0123456789abcdef", display_name: "fixture", base_url: scope.cloudOrigin + "/cloud", enrolled_at: 1 });
  assert.deepEqual(managedBrowserOwner(root, scope, agent, { enrollment }), {
    origin: scope.cloudOrigin, accountSubject: a, agentId: agent, deviceId: "scdev_0123456789abcdef",
  });
  const local = managedBrowserOwner(root, scope, agent, { enrollment: () => null, hostname: () => "fixture-host" });
  assert.match(local.deviceId, /^local_[0-9a-f]{32}$/);
  assert.equal(local.deviceId, managedBrowserOwner(root, scope, agent, { enrollment: () => ({ ...enrollment(), base_url: "https://foreign.example.test" }), hostname: () => "fixture-host" }).deviceId);
  assert.notEqual(local.deviceId, managedBrowserOwner(root, scope, agent, { enrollment: () => null, hostname: () => "another-host" }).deviceId);
});


test("fixed account operation dispatches its original credential and cannot refresh or mutate shared auth", async () => {
  const prior = globalThis.fetch; let token = "session-A"; let writes = 0; const auth: string[] = []; let rejectCreate = false;
  const tokens = { get: async () => token, set: async (value: string) => { writes++; token = value; }, clear: async () => { writes++; token = ""; } };
  const ctx: AppContext = { tokens, api: new ApiClient("https://example.test", tokens), cfg: { ...DEFAULT_CONFIG, baseUrl: "https://example.test" }, flags: { cwd: process.cwd(), json: false, yes: false, audit: false }, confirm: async () => false };
  globalThis.fetch = (async (url, init) => {
    auth.push(new Headers(init?.headers).get("Authorization")!);
    if (String(url).endsWith("/identity")) return new Response(JSON.stringify({ schema_version: "aether.terminal-account/1", account_subject: a }));
    if (String(url).endsWith("/auth/refresh")) return new Response(JSON.stringify({ session_token: "session-from-refresh" }));
    if (rejectCreate) return new Response("denied", { status: 401 });
    return new Response(JSON.stringify({ schema_version: "aether.managed-agents/1.1", availability: "ok", agent: { agent_id: agent, revision: 1, lifecycle_intent: "draft", config: { identity: { display_name: "Atlas" } }, runtime: { tile_state: "draft", observation: "unavailable" } } }));
  }) as typeof fetch;
  try {
    const operation = await managedAccountOperation(ctx); await operation.assertCurrent();
    token = "session-B"; // Switch after the caller's last guard, before transport dispatch.
    await operation.client.create({ identity: { display_name: "Atlas" } }, "fixed-nonce");
    assert.ok(auth.every(header => header === "Bearer session-A"));
    await assert.rejects(operation.assertCurrent(), /Sign-in changed/);
    rejectCreate = true;
    await assert.rejects(operation.client.create({ identity: { display_name: "Atlas" } }, "fixed-nonce"));
    assert.ok(auth.every(header => header === "Bearer session-A"));
    assert.equal(token, "session-B"); assert.equal(writes, 0);
  } finally { globalThis.fetch = prior; }
});
