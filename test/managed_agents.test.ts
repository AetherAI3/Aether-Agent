import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth, stripAnsi } from "../src/ui/text.js";
import { PassThrough, Readable, Writable } from "node:stream";
import { ManagedAgentsClient, managedAgentError, probeManagedReadiness, type ManagedAgent } from "../src/core/managed_agents.js";
import { ApiClient } from "../src/core/transport.js";
import { StaticTokenStore } from "../src/core/auth.js";
import { HttpError } from "../src/core/errors.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { AppContext } from "../src/core/context.js";
import { configureManagedAgent, cmdManagedAgents, cmdManagedAgentChat, renderManagedAgents, renderManagedContext, renderManagedMessage, renderManagedAdmission, writeManagedChatEvent, type ManagedChatSurface } from "../src/commands/managed_agents.js";
import { handleSlash } from "../src/commands/slash.js";

const ID = "mag_0123456789abcdef";
const THREAD = "00000000-0000-0000-0000-000000000001";
const agent: ManagedAgent = {
  agent_id: ID, revision: 4, lifecycle_intent: "draft",
  config: { identity: { display_name: "Test agent", purpose: "Research" }, budget: { total_uvt: 100, per_run_uvt: 20, daily_uvt: 50 }, memory: { backend: "apr", write: false } },
  runtime: { observation: "unavailable", tile_state: "draft" },
};
const envelope = (payload: Record<string, unknown>): Record<string, unknown> => ({ schema_version: "aether.managed-agents/1", availability: "ok", ...payload });
const readiness = (registry = "enabled", dm = registry === "enabled" ? "enabled" : "disabled", model = dm === "enabled" ? "enabled" : "disabled") => ({
  schema_version: "aether.terminal-readiness/1", required_contract: "aether.managed-agents/1.1",
  registry: { state: registry, code: registry === "enabled" ? "READY" : "ACCOUNT_DISABLED", reason: "Registry status.", remedy: "Check the account." },
  dm: { state: dm, code: dm === "enabled" ? "READY" : "DM_DISABLED", reason: "DM status.", remedy: "Check Online." },
  model_uvt: { state: model, code: model === "enabled" ? "ADMISSION_AVAILABLE" : "ADMISSION_DISABLED", reason: "Admission status.", remedy: "Check UVT." },
});
const api = (): ApiClient => new ApiClient("https://example.test/cloud", new StaticTokenStore("aek_test_cli"));
function context(): AppContext {
  const tokens = new StaticTokenStore("aek_test_cli");
  return { cfg: { ...DEFAULT_CONFIG }, api: new ApiClient("https://example.test/cloud", tokens), tokens, flags: { json: false, audit: false, yes: false, cwd: process.cwd() }, confirm: async () => false };
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
    if (url.pathname.endsWith("/readiness")) return json(readiness());
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
    assert.equal(await cmdManagedAgentChat(context(), ID, "Review my strategy", { out: output.out, err: output.out, hooks: { beforeChat: async () => async () => { closed = true; } } }), 1);
  });
  assert.equal(closed, true);
  assert.match(output.text(), /saved · blocked by budget.*Next: configure/);
  assert.equal(paths.length, 4);
  assert.ok(paths.every((path) => path.includes("/agent/managed/")));
});

test("one-shot managed chat closes its attached session before aborting the lifecycle signal", async () => {
  let abortedDuringClose: boolean | undefined;
  const output = capture();
  await stubFetch((url) => {
    if (url.pathname.endsWith("/readiness")) return json(readiness());
    if (url.pathname.endsWith("/thread")) return json({ id: THREAD });
    if (url.pathname.endsWith("/messages")) return json({ id: "message-1", body: "canary", sender_type: "user", admission: { state: "admitted" } });
    return json(envelope({ agent }));
  }, async () => {
    assert.equal(await cmdManagedAgentChat(context(), ID, "canary", { out: output.out, err: output.out, hooks: {
      beforeChat: async (_ctx, _agent, surface) => async () => { abortedDuringClose = surface?.signal.aborted; },
    } }), 0);
  });
  assert.equal(abortedDuringClose, false);
  assert.doesNotMatch(output.text(), /Could not close the attached agent session/);
});

test("failed DM delivery is reported as uncertain and never automatically resent", async () => {
  let sends = 0;
  const output = capture();
  await stubFetch((url) => {
    if (url.pathname.endsWith("/readiness")) return json(readiness());
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
  const root = await mkdtemp(join(tmpdir(), "aether-create-slash-"));
  const previous = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = root;
  try {
    await stubFetch((_url, init) => {
      if (_url.pathname.endsWith("/identity")) return json({ schema_version: "aether.terminal-account/1", account_subject: "11111111-1111-4111-8111-111111111111" });
      if (init.method === "POST") assert.equal(JSON.parse(String(init.body)).config.identity.display_name, "Research friend");
      return json(envelope({ agent }), init.method === "POST" ? 201 : 200);
    }, async () => { await handleSlash(context(), "/agent-create Research friend", output.out); });
    let name = "";
    assert.equal(await cmdManagedAgents(context(), ["create", "ATS", "Market", "Scout"], { hooks: { createATS: async (_ctx, value) => { name = value; return 0; } } }), 0);
    assert.equal(name, "Market Scout");
  } finally {
    if (previous === undefined) delete process.env["AETHER_CONFIG_DIR"]; else process.env["AETHER_CONFIG_DIR"] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("untrusted labels are sanitized and runtime unavailable stays visible", () => {
  const rows = renderManagedAgents([{ ...agent, config: { identity: { display_name: "bad\x1b]52;c;secret\x07name" } } }]);
  assert.equal(rows.includes("\x1b]52"), false);
  assert.match(rows, /unavailable/);
  assert.match(managedAgentError(new HttpError(403, "aek_secret", { token: "aek_secret" })), /Cloud refused/);
  assert.equal(managedAgentError(new HttpError(403, "aek_secret")).includes("aek_secret"), false);
  assert.match(managedAgentError(new HttpError(403, "ignored", { detail: { code: "WRONG_CREDENTIAL_CLASS" } })), /credential cannot access/);
  assert.match(managedAgentError(new HttpError(403, "ignored", { detail: { code: "FEATURE_DISABLED" } })), /not enabled for this account/);
  assert.match(managedAgentError(new HttpError(404, "ignored")), /not found in this account/);
});

for (const columns of [40, 60, 80, 120]) {
  test(`managed list and context stay within ${columns} columns`, () => {
    const untrusted = { ...agent, runtime: { ...agent.runtime, tile_state: "draft\x1b]52;c;secret\x07", observation: "unavailable" }, config: { identity: { display_name: "長い名前".repeat(30) + "\x1b]52;c;secret\x07" } } };
    const list = renderManagedAgents([untrusted], columns);
    const context = renderManagedContext(untrusted, { chat: "paused", memory: "verified 5 GiB", mode: "plan requested", browser: "stale", data: "unverified" }, columns);
    for (const line of [...list.split("\n"), ...context.split("\n")]) assert.ok(visibleWidth(line) <= columns, line);
    assert.ok(list.includes(ID));
    assert.match(context, /DM paused/);
    assert.doesNotMatch(context, /memory|strategies|browser|data/);
    assert.doesNotMatch(list + context, /\x1b\]52/);
  });
}

test("ordinary and ATS status snapshots keep verified sources distinct at narrow and wide widths", () => {
  const typed: ManagedAgent = { ...agent, config: { ...agent.config, profile: { schema_version: "aether.managed-agent.profile/1", kind: "ats" } } };
  const state = { chat: "synced" as const, checkedAt: Date.parse("2026-10-06T12:00:00Z"), profileCheckedAt: Date.parse("2026-10-06T11:59:00Z"), memory: "writer leased 5 GiB", mode: "plan requested", strategies: "configured", browser: "unverified", data: "unverified" };
  for (const columns of [40, 80, 120]) {
    const ordinary = stripAnsi(renderManagedContext(agent, state, columns));
    const ats = stripAnsi(renderManagedContext(typed, state, columns));
    assert.match(ordinary, /Test agent · draft\nDM synced/);
    assert.match(ordinary.replace(/\n/g, " "), /checked\s+2026-10-06T12:00:00.000Z/);
    assert.doesNotMatch(ordinary, /ATS|memory|strategies|browser|data|mode/);
    assert.match(ats, /ATS local/);
    assert.match(ats, /writer leased 5 GiB/);
    assert.match(ats.replace(/\n/g, " "), /checked\s+2026-10-06T11:59:00.000Z/);
    assert.doesNotMatch(ats, /browser|data/);
    for (const line of [...ordinary.split("\n"), ...ats.split("\n")]) assert.ok(visibleWidth(line) <= columns, line);
  }
  const unchecked = stripAnsi(renderManagedContext(typed, { chat: "paused", memory: "writer leased 5 GiB" }, 80));
  assert.match(unchecked, /ATS local · not checked/);
  assert.doesNotMatch(unchecked, /writer leased/);
});

test("transcript snapshots show time and saved, blocked, and admitted states without terminal controls", () => {
  const message = { id: "m1", sender_type: "user", body: "multi\nbyte 長文".repeat(7), created_at: "2026-10-06T12:01:00Z", admission: { state: "blocked_budget" as const } };
  for (const width of [40, 80, 120]) {
    const rendered = stripAnsi(renderManagedMessage(message, agent, width));
    assert.match(rendered, /You · 2026-10-06T12:01:00.000Z\nsaved · blocked by budget/);
    for (const line of rendered.split("\n")) assert.ok(visibleWidth(line) <= width, line);
    assert.doesNotMatch(rendered, /\x1b/);
  }
  assert.match(renderManagedMessage({ id: "m2", body: "reply", sender_type: "agent" }, agent), /time unknown/);
  assert.doesNotMatch(renderManagedMessage({ id: "m2", body: "reply", sender_type: "agent" }, agent), /saved/);
  assert.match(renderManagedAdmission(undefined), /admission unconfirmed.*check the shared conversation/);
  assert.match(renderManagedAdmission({ state: "saved" }), /admission pending.*\/refresh/);
  assert.match(renderManagedAdmission({ state: "blocked_policy" }), /blocked by policy.*review this agent/);
  assert.match(renderManagedAdmission({ state: "needs_review" }), /needs review.*review this message/);
  assert.equal(renderManagedAdmission({ state: "admitted" }), "admitted");
});

test("prompt-preserving status event redraws a moved cursor without changing a draft", () => {
  const output = capture();
  const draft = { value: "a long draft", cursor: 3 };
  const calls: boolean[] = [];
  writeManagedChatEvent(output.out, { getCursorPos: () => ({ rows: 2, cols: 3 }), prompt: (preserve?: boolean) => { calls.push(Boolean(preserve)); } }, "DM sync paused. Next: /refresh");
  assert.match(output.text(), /^\r\x1b\[2A\x1b\[0JDM sync paused/);
  assert.deepEqual(calls, [true]);
  assert.deepEqual(draft, { value: "a long draft", cursor: 3 });
});

test("redirected chat uses plain text, profile-specific help, and a truthful saved transcript", async () => {
  const output = capture();
  let reads = 0;
  await stubFetch((url, init) => {
    if (url.pathname.endsWith("/readiness")) return json(readiness());
    if (url.pathname.endsWith("/thread")) return json({ id: THREAD });
    if (url.pathname.endsWith("/messages") && init.method === "GET") {
      reads++;
      return json({ messages: [{ id: "m1", body: "hello", sender_type: "user", created_at: "2026-10-06T12:01:00Z", admission: { state: "saved" } }] });
    }
    return json(envelope({ agent }));
  }, async () => {
    assert.equal(await cmdManagedAgentChat(context(), ID, "", { out: output.out, err: output.out, input: Readable.from(["/help\n", "/refresh\n", "/exit\n"]), hooks: { help: () => "Browser · /browser status" } }), 0);
  });
  assert.equal(reads, 2);
  assert.match(output.text(), /DM synced/);
  assert.match(output.text(), /saved · admission pending/);
  assert.match(output.text(), /Browser · \/browser status/);
  assert.doesNotMatch(output.text(), /ATS local|\x1b/);
});

test("a later admission update is visible even when the saved message body is unchanged", async () => {
  const output = capture();
  let reads = 0;
  await stubFetch((url) => {
    if (url.pathname.endsWith("/readiness")) return json(readiness());
    if (url.pathname.endsWith("/thread")) return json({ id: THREAD });
    if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "m1", body: "same body", sender_type: "user", admission: { state: ++reads === 1 ? "saved" : "admitted" } }] });
    return json(envelope({ agent }));
  }, async () => {
    assert.equal(await cmdManagedAgentChat(context(), ID, "", { out: output.out, err: output.out, input: Readable.from(["/refresh\n", "/exit\n"]) }), 0);
  });
  assert.equal(reads, 2);
  assert.match(output.text(), /saved · admission pending/);
  assert.match(output.text(), /\nadmitted\n/);
});

test("a Cloud send receipt remains visible when the conversation list omits admission", async () => {
  const output = capture();
  let sends = 0;
  await stubFetch((url, init) => {
    if (url.pathname.endsWith("/readiness")) return json(readiness());
    if (url.pathname.endsWith("/thread")) return json({ id: THREAD });
    if (url.pathname.endsWith("/messages") && init.method === "POST") {
      sends++;
      return json({ id: "m1", body: "hello", admission: { state: "blocked_policy" } });
    }
    if (url.pathname.endsWith("/messages")) return json({ messages: sends ? [{ id: "m1", body: "hello", sender_type: "user" }] : [] });
    return json(envelope({ agent }));
  }, async () => {
    assert.equal(await cmdManagedAgentChat(context(), ID, "", { out: output.out, err: output.out, input: Readable.from(["hello\n", "/exit\n"]) }), 0);
  });
  assert.equal(sends, 1);
  assert.equal((output.text().match(/saved · blocked by policy/g) ?? []).length, 2);
});

test("ATS help labels local preferences and the live-order boundary", async () => {
  const output = capture();
  const typed: ManagedAgent = { ...agent, config: { ...agent.config, profile: { schema_version: "aether.managed-agent.profile/1", kind: "ats" } } };
  await stubFetch((url) => {
    if (url.pathname.endsWith("/readiness")) return json(readiness());
    if (url.pathname.endsWith("/thread")) return json({ id: THREAD });
    if (url.pathname.endsWith("/messages")) return json({ messages: [] });
    return json(envelope({ agent: typed }));
  }, async () => {
    assert.equal(await cmdManagedAgentChat(context(), ID, "", { out: output.out, input: Readable.from(["/help\n", "/exit\n"]),
      hooks: { help: () => "ATS · /ats status", beforeChat: async (_ctx, _agent, surface) => { surface?.setContext?.({ memory: "writer leased 5 GiB", profileCheckedAt: Date.parse("2026-10-06T12:00:00Z") }); } } }), 0);
  });
  assert.match(output.text(), /ATS local/);
  assert.match(output.text(), /memory writer leased 5 GiB/);
  assert.match(output.text(), /ATS · \/ats status/);
  assert.match(output.text(), /live orders.*RC observation is separate/);
});

test("TTY refresh event and resize retain a type-ahead draft at 40 and 80 columns", async () => {
  const output = capture();
  const ttyOut = Object.assign(output.out, { columns: 40 });
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(raw: boolean) { this.isRaw = raw; } });
  let surface: ManagedChatSurface | undefined;
  const task = stubFetch((url) => {
    if (url.pathname.endsWith("/readiness")) return json(readiness());
    if (url.pathname.endsWith("/thread")) return json({ id: THREAD });
    if (url.pathname.endsWith("/messages")) return json({ messages: [] });
    return json(envelope({ agent }));
  }, async () => {
    assert.equal(await cmdManagedAgentChat(context(), ID, "", { out: ttyOut, err: ttyOut, input,
      hooks: { beforeChat: async (_ctx, _agent, current) => { surface = current; } } }), 0);
  });
  try {
    for (let i = 0; i < 50 && !output.text().includes("you › "); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(surface);
    input.write("draft words");
    await new Promise(resolve => setTimeout(resolve, 10));
    surface.write("Background status checked\n");
    ttyOut.columns = 80; ttyOut.emit("resize");
    await new Promise(resolve => setTimeout(resolve, 10));
    input.write("\x15/exit\r");
    input.end();
    await task;
    assert.match(stripAnsi(output.text()), /Background status checked/);
    assert.ok(stripAnsi(output.text()).split("draft words").length >= 3, "draft should be redrawn after the event and resize");
  } finally { input.destroy(); }
});

test("canonical readback refuses a different agent identity", async () => {
  await stubFetch(() => json(envelope({ agent: { ...agent, agent_id: "mag_aaaaaaaaaaaaaaaa" } })), async () => {
    await assert.rejects(new ManagedAgentsClient(api()).get(ID), /different agent/);
  });
});

test("identity contract validates canonical subjects and is fetched on every call", async () => {
  let calls = 0;
  await stubFetch(url => { assert.equal(url.pathname, "/cloud/agent/managed/identity"); calls++; return json({ schema_version: "aether.terminal-account/1", account_subject: "11111111-1111-4111-8111-111111111111" }); }, async () => {
    const client = new ManagedAgentsClient(api()); assert.equal(await client.identity(), await client.identity()); assert.equal(calls, 2);
  });
  for (const value of [{ schema_version: "aether.terminal-account/2", account_subject: "11111111-1111-4111-8111-111111111111" }, { schema_version: "aether.terminal-account/1", account_subject: "../account" }]) {
    await stubFetch(() => json(value), async () => { await assert.rejects(new ManagedAgentsClient(api()).identity(), /canonical account/); });
  }
});

test("inventory accepts both additive contracts and rejects unknown typed profiles", async () => {
  for (const version of ["aether.managed-agents/1", "aether.managed-agents/1.1"]) {
    await stubFetch(() => json({ ...envelope({ agents: [agent] }), schema_version: version }), async () => { assert.equal((await new ManagedAgentsClient(api()).list()).length, 1); });
  }
  const profile = { schema_version: "aether.managed-agent.profile/1", kind: "ats" } as const;
  const typed = { ...agent, config: { ...agent.config, profile } };
  assert.deepEqual(configureManagedAgent(typed.config, "prompt", "New prompt").profile, profile);
  for (const invalid of [{ ...profile, kind: "root" }, { ...profile, permission: "trade" }, { ...profile, schema_version: "unknown" }]) {
    await stubFetch(() => json(envelope({ agents: [{ ...agent, config: { ...agent.config, profile: invalid } }] })), async () => { await assert.rejects(new ManagedAgentsClient(api()).list(), /unsupported managed-agent profile/); });
  }
});

test("readiness classifies entitlement, credential, contract and outage without leaking response details", async () => {
  const cases: Array<[Response, string]> = [
    [json(readiness("disabled")), "ACCOUNT_DISABLED"],
    [json(readiness("enabled", "disabled")), "DM_DISABLED"],
    [json({ detail: { code: "WRONG_CREDENTIAL_CLASS", secret: "aek_private" } }, 403), "WRONG_CREDENTIAL_CLASS"],
    [json({ detail: "aek_private" }, 403), "READINESS_REFUSED"],
    [json({ detail: "not deployed" }, 404), "INCOMPATIBLE_CONTRACT"],
    [json({ ...readiness(), required_contract: "aether.managed-agents/9" }), "INCOMPATIBLE_CONTRACT"],
    [json({ detail: "aek_private" }, 503), "TEMPORARILY_UNAVAILABLE"],
  ];
  for (const [response, expected] of cases) {
    await stubFetch(() => response.clone(), async () => {
      const result = await probeManagedReadiness(api());
      assert.ok(JSON.stringify(result).includes(expected));
      assert.equal(JSON.stringify(result).includes("aek_private"), false);
    });
  }
});

test("a cancelled readiness probe stays cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(probeManagedReadiness(api(), controller.signal));
});

test("list and chat use fresh readiness after account switch and avoid unavailable operations", async () => {
  let owner = "first";
  const calls: string[] = [];
  await stubFetch((url, init) => {
    calls.push(`${owner}:${url.pathname}`);
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer aek_${owner === "first" ? "test" : "second"}_cli`);
    if (url.pathname.endsWith("/readiness")) return json(readiness(owner === "first" ? "enabled" : "disabled"));
    return json(envelope({ agents: [agent], next_cursor: null }));
  }, async () => {
    const ctx = context();
    const first = capture();
    assert.equal(await cmdManagedAgents(ctx, ["list"], { out: first.out, err: first.out }), 0);
    assert.match(first.text(), /registry: enabled/);
    owner = "second";
    await ctx.tokens.set("aek_second_cli");
    const second = capture();
    ctx.flags.json = true;
    assert.equal(await cmdManagedAgents(ctx, ["list"], { out: second.out, err: second.out }), 1);
    assert.equal(JSON.parse(second.text()).error.code, "ACCOUNT_DISABLED");
    assert.equal(await cmdManagedAgentChat(ctx, ID, "hello", { out: second.out, err: second.out }), 1);
  });
  assert.equal(calls.filter(path => path.endsWith("/readiness")).length, 3);
  assert.equal(calls.filter(path => path.endsWith("/agent/managed")).length, 1);
});

test("blocked list, show and chat report the same safe codes in human and JSON output", async () => {
  const cases: Array<[string, Response, string]> = [
    ["list", json(readiness("disabled")), "ACCOUNT_DISABLED"],
    ["show", json({ ...readiness(), required_contract: "aether.managed-agents/9", private: "aek_private" }), "INCOMPATIBLE_CONTRACT"],
    ["chat", json(readiness("enabled", "disabled")), "DM_DISABLED"],
    ["list", json({ detail: { code: "WRONG_CREDENTIAL_CLASS", private: "aek_private" } }, 403), "WRONG_CREDENTIAL_CLASS"],
    ["chat", json({ detail: "aek_private" }, 503), "TEMPORARILY_UNAVAILABLE"],
  ];
  for (const [verb, response, code] of cases) {
    for (const jsonMode of [false, true]) {
      const output = capture();
      const ctx = context();
      ctx.flags.json = jsonMode;
      await stubFetch((url) => {
        assert.ok(url.pathname.endsWith("/readiness"), "a blocked command must stop before agent access");
        return response.clone();
      }, async () => {
        const result = verb === "chat"
          ? await cmdManagedAgentChat(ctx, ID, "private message", { out: output.out, err: output.out })
          : await cmdManagedAgents(ctx, verb === "list" ? [verb] : [verb, ID], { out: output.out, err: output.out });
        assert.equal(result, 1);
      });
      if (jsonMode) assert.equal(JSON.parse(output.text()).error.code, code);
      else assert.match(output.text(), new RegExp(code));
      assert.equal(output.text().includes("aek_private"), false);
      assert.equal(output.text().includes("private message"), false);
    }
  }
});

test("chat stays paused when conversation read fails after an enabled readiness probe", async () => {
  const output = capture();
  let state: string | undefined;
  await stubFetch((url) => {
    if (url.pathname.endsWith("/readiness")) return json(readiness());
    if (url.pathname.endsWith("/thread")) return json({ id: THREAD });
    if (url.pathname.endsWith("/messages")) return json({ detail: "private message" }, 503);
    return json(envelope({ agent }));
  }, async () => {
    assert.equal(await cmdManagedAgentChat(context(), ID, "", {
      out: output.out, err: output.out, input: Readable.from(["/state\n", "/exit\n"]),
      hooks: { onChatCommand: async (_ctx, _agent, _input, surface) => { state = surface?.connection?.().chat; return true; } },
    }), 0);
  });
  assert.equal(state, "paused");
  assert.match(output.text(), /DM sync paused.*Next: \/refresh/);
  assert.doesNotMatch(output.text(), /synced|private message/);
});
