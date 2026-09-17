import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { ManagedAgentsClient, managedAgentError, type ManagedAgent } from "../src/core/managed_agents.js";
import { ApiClient } from "../src/core/transport.js";
import { StaticTokenStore } from "../src/core/auth.js";
import { HttpError } from "../src/core/errors.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { AppContext } from "../src/core/context.js";
import { configureManagedAgent, cmdManagedAgents, cmdManagedAgentChat, renderManagedAgents } from "../src/commands/managed_agents.js";
import { handleSlash } from "../src/commands/slash.js";

const ID = "mag_0123456789abcdef";
const THREAD = "00000000-0000-0000-0000-000000000001";
const agent: ManagedAgent = {
  agent_id: ID, revision: 4, lifecycle_intent: "draft",
  config: { identity: { display_name: "Test agent", purpose: "Research" }, budget: { total_uvt: 100, per_run_uvt: 20, daily_uvt: 50 }, memory: { backend: "apr", write: false } },
  runtime: { observation: "unavailable", tile_state: "draft" },
};
const envelope = (payload: Record<string, unknown>): Record<string, unknown> => ({ schema_version: "aether.managed-agents/1", availability: "ok", ...payload });
const api = (): ApiClient => new ApiClient("https://example.test/cloud", new StaticTokenStore("aek_test_cli"));
function context(): AppContext {
  return { cfg: { ...DEFAULT_CONFIG }, api: api(), tokens: new StaticTokenStore("aek_test_cli"), flags: { json: false, audit: false, yes: false, cwd: process.cwd() }, confirm: async () => false };
}
function capture(): { out: Writable; text: () => string } {
  let text = "";
  return { out: new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } }), text: () => text };
}
async function stubFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>, run: () => Promise<void>): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => handler(new URL(String(input)), init ?? {})) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = previous; }
}
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

test("managed inventory follows all pages and refuses cyclic cursors", async () => {
  const paths: string[] = [];
  await stubFetch((url) => {
    paths.push(url.search);
    return json(envelope({ agents: [agent], next_cursor: paths.length === 1 ? "page.two" : null }));
  }, async () => {
    assert.equal((await new ManagedAgentsClient(api()).list()).length, 2);
    assert.match(paths[0]!, /limit=100/);
    assert.match(paths[1]!, /cursor=page.two/);
  });
  await stubFetch(() => json(envelope({ agents: [], next_cursor: "repeat" })), async () => {
    await assert.rejects(new ManagedAgentsClient(api()).list(), /changed during sync/);
  });
});

test("unavailable or malformed registry cannot masquerade as an empty inventory", async () => {
  for (const response of [{ agents: [] }, { ...envelope({ agents: [] }), availability: "unavailable" }, envelope({ agents: [{}] })]) {
    await stubFetch(() => json(response), async () => { await assert.rejects(new ManagedAgentsClient(api()).list()); });
  }
});

test("create attaches idempotency key and account bearer through shared TLS transport", async () => {
  await stubFetch((url, init) => {
    assert.equal(url.pathname, "/cloud/agent/managed");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer aek_test_cli");
    assert.equal(new Headers(init.headers).get("Idempotency-Key"), "fixed-key-123");
    assert.deepEqual(JSON.parse(String(init.body)), { config: { identity: { display_name: "New agent" } } });
    return json(envelope({ agent }), 201);
  }, async () => {
    assert.equal((await new ManagedAgentsClient(api()).create({ identity: { display_name: "New agent" } }, "fixed-key-123")).agent_id, ID);
  });
  await assert.rejects(new ApiClient("http://example.test", new StaticTokenStore("aek_test_cli")).patchJson("/agent/managed", {}), /insecure|https|refus/i);
});

test("configuration preserves complete config and submits exact revision; conflict is never retried", async () => {
  let calls = 0;
  const updated = configureManagedAgent(agent.config, "tone", "friendly");
  assert.deepEqual(updated["memory"], agent.config["memory"]);
  assert.equal(agent.config.behavior, undefined);
  await stubFetch((_url, init) => {
    calls++;
    assert.equal(init.method, "PATCH");
    assert.deepEqual(JSON.parse(String(init.body)), { expected_revision: 4, config: updated });
    return json({ detail: { code: "REVISION_CONFLICT" } }, 409);
  }, async () => {
    await assert.rejects(new ManagedAgentsClient(api()).configure(agent, updated), (error: unknown) => {
      assert.match(managedAgentError(error), /changed elsewhere/);
      return true;
    });
  });
  assert.equal(calls, 1);
});

test("config rejects implicit authority and invalid UVT bounds", () => {
  assert.throws(() => configureManagedAgent(agent.config, "owner_user_id", "x"), /Unknown setting/);
  assert.throws(() => configureManagedAgent(agent.config, "run-uvt", "101"), /cannot exceed/);
  assert.throws(() => configureManagedAgent(agent.config, "total-uvt", "1.5"), /whole UVT/);
  assert.throws(() => configureManagedAgent(agent.config, "tone", "unsafe"), /Tone/);
});

test("DM send uses canonical conversation and nonce; no coding or chat runtime endpoint", async () => {
  const paths: string[] = [];
  let closed = false;
  const output = capture();
  await stubFetch((url, init) => {
    paths.push(url.pathname);
    if (url.pathname.endsWith("/thread")) return json({ id: THREAD });
    if (url.pathname.endsWith("/messages")) {
      assert.equal(url.searchParams.get("conversation_id"), THREAD);
      const body = JSON.parse(String(init.body));
      assert.equal(body.body, "Review my strategy");
      assert.match(body.client_nonce, /^[a-f0-9-]{36}$/);
      return json({ id: "message-1", body: body.body, sender_type: "user", admission: { state: "blocked_budget", reason: "Set a budget" } });
    }
    return json(envelope({ agent }));
  }, async () => {
    assert.equal(await cmdManagedAgentChat(context(), ID, "Review my strategy", { out: output.out, err: output.out, hooks: { beforeChat: async () => async () => { closed = true; } } }), 0);
  });
  assert.equal(closed, true);
  assert.match(output.text(), /blocked_budget/);
  assert.equal(paths.length, 3);
  assert.ok(paths.every((path) => path.includes("/agent/managed/")));
});

test("failed DM delivery is reported as uncertain and never automatically resent", async () => {
  let sends = 0;
  const output = capture();
  await stubFetch((url) => {
    if (url.pathname.endsWith("/thread")) return json({ id: THREAD });
    if (url.pathname.endsWith("/messages")) { sends++; throw new Error("network unavailable"); }
    return json(envelope({ agent }));
  }, async () => {
    assert.equal(await cmdManagedAgentChat(context(), ID, "message", { out: output.out, err: output.out }), 1);
  });
  assert.equal(sends, 1);
  assert.match(output.text(), /Delivery is unconfirmed/);
});

test("signed-out and local-only commands refuse without network calls", async () => {
  let calls = 0;
  const output = capture();
  await stubFetch(() => { calls++; throw new Error("must not call"); }, async () => {
    const signedOut = context(); signedOut.tokens = { get: async () => null, set: async () => {}, clear: async () => {} };
    assert.equal(await cmdManagedAgents(signedOut, ["list"], { err: output.out }), 1);
    const local = context(); local.flags.local = true;
    assert.equal(await cmdManagedAgentChat(local, ID, "hi", { err: output.out }), 1);
  });
  assert.equal(calls, 0);
});

test("agent-create slash command creates a synchronized draft, and ATS delegates setup", async () => {
  const output = capture();
  await stubFetch((_url, init) => {
    assert.equal(JSON.parse(String(init.body)).config.identity.display_name, "Research friend");
    return json(envelope({ agent }), 201);
  }, async () => { await handleSlash(context(), "/agent-create Research friend", output.out); });
  let name = "";
  assert.equal(await cmdManagedAgents(context(), ["create", "ATS", "Market", "Scout"], { hooks: { createATS: async (_ctx, value) => { name = value; return 0; } } }), 0);
  assert.equal(name, "Market Scout");
});

test("untrusted labels are sanitized and runtime unavailable stays visible", () => {
  const rows = renderManagedAgents([{ ...agent, config: { identity: { display_name: "bad\x1b]52;c;secret\x07name" } } }]);
  assert.equal(rows.includes("\x1b]52"), false);
  assert.match(rows, /unavailable/);
  assert.match(managedAgentError(new HttpError(403, "aek_secret", { token: "aek_secret" })), /not enabled/);
  assert.equal(managedAgentError(new HttpError(403, "aek_secret")).includes("aek_secret"), false);
});
