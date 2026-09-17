import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedDraft } from "../src/core/managed_agent_creation.js";
import { StaticTokenStore } from "../src/core/auth.js";
import { ApiClient } from "../src/core/transport.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { AppContext } from "../src/core/context.js";

const SUBJECT = "11111111-1111-4111-8111-111111111111";
const identity = (subject = SUBJECT): Response => new Response(JSON.stringify({ schema_version: "aether.terminal-account/1", account_subject: subject }));
const ID = "mag_0123456789abcdef";
const config = { identity: { display_name: "Atlas" } };
function context(token = "aek_fixture"): AppContext {
  const tokens = new StaticTokenStore(token);
  return { tokens, api: new ApiClient("https://example.test/cloud", tokens), cfg: { ...DEFAULT_CONFIG, baseUrl: "https://example.test/cloud" },
    flags: { cwd: process.cwd(), json: false, yes: false, audit: false }, confirm: async () => false };
}
const result = (): Response => new Response(JSON.stringify({ schema_version: "aether.managed-agents/1", availability: "ok", agent: {
  agent_id: ID, revision: 1, lifecycle_intent: "draft", config, runtime: { tile_state: "draft", observation: "unavailable" },
} }));

test("lost create response and a restarted client reuse one durable nonce before canonical readback", async () => {
  const root = await mkdtemp(join(tmpdir(), "aether-create-intent-"));
  const previous = globalThis.fetch;
  const keys: string[] = [];
  let loseResponse = true;
  let reads = 0;
  globalThis.fetch = (async (_url, init) => {
    if (String(_url).endsWith("/identity")) return identity();
    if (init?.method === "POST") {
      keys.push(new Headers(init.headers).get("Idempotency-Key")!);
      if (loseResponse) { loseResponse = false; throw new Error("response lost after commit"); }
    } else reads++;
    return result();
  }) as typeof fetch;
  try {
    await assert.rejects(createManagedDraft(context(), config, { root }), /response lost/);
    const resumed = await createManagedDraft(context(), config, { root });
    assert.equal(resumed.agent.agent_id, ID); assert.equal(reads, 1); assert.equal(keys[0], keys[1]);
    const serverDir = (await readdir(join(root, "pending-create")))[0]!;
    const intentDir = join(root, "pending-create", serverDir, (await readdir(join(root, "pending-create", serverDir)))[0]!);
    const intentPath = join(intentDir, (await readdir(intentDir))[0]!);
    assert.doesNotMatch(await readFile(intentPath, "utf8"), /aek_fixture/);
    await resumed.complete();
    assert.equal((await readdir(join(root, "pending-create", serverDir))).length, 0);
  } finally { globalThis.fetch = previous; await rm(root, { recursive: true, force: true }); }
});

test("pending creation survives token rotation for the same verified account and readback failure keeps its key", async () => {
  const root = await mkdtemp(join(tmpdir(), "aether-create-intent-"));
  const previous = globalThis.fetch;
  const keys: string[] = [];
  let failRead = true;
  globalThis.fetch = (async (_url, init) => {
    if (String(_url).endsWith("/identity")) return identity();
    if (init?.method === "POST") keys.push(new Headers(init.headers).get("Idempotency-Key")!);
    else if (failRead) throw new Error("readback offline");
    return result();
  }) as typeof fetch;
  try {
    await assert.rejects(createManagedDraft(context(), config, { root }), /readback offline/);
    assert.equal(keys.length, 1);
    failRead = false;
    const resumed = await createManagedDraft(context("aek_rotated"), config, { root });
    assert.equal(resumed.accountScope.accountSubject, SUBJECT);
    assert.equal(keys[0], keys[1]); await resumed.complete();
  } finally { globalThis.fetch = previous; await rm(root, { recursive: true, force: true }); }
});

test("late completion for an old creation cannot erase a newer pending operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "aether-create-intent-"));
  const previous = globalThis.fetch; const keys: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    if (String(_url).endsWith("/identity")) return identity();
    if (init?.method === "POST") keys.push(new Headers(init.headers).get("Idempotency-Key")!);
    return result();
  }) as typeof fetch;
  try {
    const first = await createManagedDraft(context(), config, { root });
    const slowPeer = await createManagedDraft(context(), config, { root });
    await first.complete();
    const next = await createManagedDraft(context(), config, { root });
    await slowPeer.complete();
    const resumed = await createManagedDraft(context(), config, { root });
    assert.equal(keys[0], keys[1]); assert.notEqual(keys[0], keys[2]); assert.equal(keys[2], keys[3]);
    await next.complete(); await resumed.complete();
  } finally { globalThis.fetch = previous; await rm(root, { recursive: true, force: true }); }
});

test("another canonical account never reuses a previous account's pending nonce", async () => {
  const root = await mkdtemp(join(tmpdir(), "aether-create-account-"));
  const previous = globalThis.fetch; const keys: string[] = []; let subject = SUBJECT;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/identity")) return identity(subject);
    if (init?.method === "POST") { keys.push(new Headers(init.headers).get("Idempotency-Key")!); throw new Error("response lost"); }
    return result();
  }) as typeof fetch;
  try {
    await assert.rejects(createManagedDraft(context(), config, { root }), /response lost/);
    subject = "22222222-2222-4222-8222-222222222222";
    await assert.rejects(createManagedDraft(context("aek_other"), config, { root }), /response lost/);
    assert.notEqual(keys[0], keys[1]);
    subject = SUBJECT;
    await assert.rejects(createManagedDraft(context("aek_rotated"), config, { root }), /response lost/);
    assert.equal(keys[0], keys[2]);
    const saved = await readdir(join(root, "pending-create")); assert.equal(saved.length, 2);
  } finally { globalThis.fetch = previous; await rm(root, { recursive: true, force: true }); }
});

test("unavailable identity does not create a nonce or post an agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "aether-create-unavailable-"));
  const previous = globalThis.fetch; const paths: string[] = [];
  globalThis.fetch = (async url => { paths.push(String(url)); throw new Error("identity offline"); }) as typeof fetch;
  try {
    await assert.rejects(createManagedDraft(context(), config, { root }), /identity offline/);
    assert.deepEqual(await readdir(root), []); assert.equal(paths.length, 1); assert.match(paths[0]!, /\/identity$/);
  } finally { globalThis.fetch = previous; await rm(root, { recursive: true, force: true }); }
});

test("credential changes during identity verification cannot publish pending state or create", async () => {
  const root = await mkdtemp(join(tmpdir(), "aether-create-change-"));
  const previous = globalThis.fetch; const ctx = context(); let token = "aek_first"; let calls = 0;
  ctx.tokens = { get: async () => token, set: async value => { token = value; }, clear: async () => { token = ""; } };
  ctx.api = new ApiClient(ctx.cfg.baseUrl, ctx.tokens);
  globalThis.fetch = (async () => { calls++; token = "aek_replacement"; return identity(); }) as typeof fetch;
  try {
    await assert.rejects(createManagedDraft(ctx, config, { root }), /Sign-in changed/);
    assert.equal(calls, 1); assert.deepEqual(await readdir(root), []);
  } finally { globalThis.fetch = previous; await rm(root, { recursive: true, force: true }); }
});

test("a sign-in switch at request dispatch cannot create under another account's durable nonce", async () => {
  const root = await mkdtemp(join(tmpdir(), "aether-create-dispatch-"));
  const previous = globalThis.fetch; let gets = 0; let token: string | null = "aek_A"; let writes = 0;
  const posts: Array<{ owner: string; key: string }> = [];
  const tokens = { get: async () => { if (++gets === 5) token = "aek_B"; return token; }, set: async (next: string) => { writes++; token = next; }, clear: async () => { writes++; token = null; } };
  const ctx = context(); ctx.tokens = tokens; ctx.api = new ApiClient(ctx.cfg.baseUrl, tokens);
  globalThis.fetch = (async (url, init) => {
    const owner = new Headers(init?.headers).get("Authorization") === "Bearer aek_A" ? SUBJECT : "22222222-2222-4222-8222-222222222222";
    if (String(url).endsWith("/identity")) return identity(owner);
    if (init?.method === "POST") posts.push({ owner, key: new Headers(init.headers).get("Idempotency-Key")! });
    return result();
  }) as typeof fetch;
  try {
    await assert.rejects(createManagedDraft(ctx, config, { root }), /account|Sign-in/i);
    const next = await createManagedDraft(ctx, config, { root }); await next.complete();
    assert.equal(posts.filter(post => post.owner === "22222222-2222-4222-8222-222222222222").length, 1, "B must receive only B's explicit retry, never A's intent");
    assert.equal(posts[0]!.owner, SUBJECT, "the original operation can dispatch only as A");
    assert.equal(writes, 0, "an operation must never replace shared credentials");
  } finally { globalThis.fetch = previous; await rm(root, { recursive: true, force: true }); }
});
