import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createMcpMenuIO, runMcpMenu } from "../src/commands/mcp.js";
import type { MenuIO } from "../src/commands/mcp.js";
import { LocalMcpStore } from "../src/core/mcp_store.js";
import { McpClient } from "../src/core/mcp.js";
import type { BrowserOpenResult } from "../src/core/browser.js";
import type { Key } from "../src/commands/chat.js";
import type { ApiClient } from "../src/core/transport.js";

function keyScript(seq: Array<Key | string>): () => Promise<Key> {
  const keys: Key[] = seq.map((k) =>
    typeof k === "string" ? ({ kind: "char", value: k } as Key) : k,
  );
  let i = 0;
  return async () => keys[i++] ?? ({ kind: "interrupt" } as Key);
}

/** A MenuIO.openUrl stub that reports a real browser opened. Tests that care
 *  about the no-browser path override `code`/`launched` instead. */
function openedOk(over: Partial<BrowserOpenResult> = {}): BrowserOpenResult {
  return {
    schema: "aether.cli.browser/1",
    code: "BROWSER_READY",
    available: true,
    platform: "linux",
    launcher: "xdg-open",
    browser: "xdg-open",
    evidence: "test stub",
    launched: true,
    ...over,
  };
}

function makeIO(keys: Array<Key | string>, lines: string[] = []) {
  const out: string[] = [];
  let li = 0;
  const io: MenuIO = {
    out: { write: (s: string) => (out.push(s), true) } as unknown as MenuIO["out"],
    nextKey: keyScript(keys),
    readLine: async () => lines[li++] ?? "",
    openUrl: async () => openedOk(),
    sleep: async () => {},
  };
  return { io, out };
}

/**
 * makeIO with the browser outcome under test control, writing into a SHARED
 * call-order log so browser and broker events can be ordered against each
 * other. `sleep` is a real timer: pollUntilConnected sleeps for the remaining
 * deadline, so a no-op sleep spins the loop thousands of times instead of
 * polling a couple of times like production.
 */
function makeAuthIO(keys: Array<Key | string>, browser: BrowserOpenResult, order: string[]) {
  const { io, out } = makeIO(keys);
  io.openUrl = async () => {
    order.push("open-browser");
    return browser;
  };
  io.sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      order.push("sleep");
      setTimeout(resolve, Math.max(1, Math.min(ms, 40)));
    });
  return { io, out };
}

function fakeApi(routes: Record<string, unknown>): ApiClient {
  return {
    async getJson(path: string) {
      if (!(path in routes)) throw Object.assign(new Error("HTTP 404"), { status: 404 });
      return routes[path];
    },
    async postJson(path: string) {
      if (!(path in routes)) throw Object.assign(new Error("HTTP 404"), { status: 404 });
      return routes[path];
    },
  } as unknown as ApiClient;
}

function deps(routes: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "aether-mcpcmd-"));
  return {
    client: new McpClient(fakeApi(routes)),
    store: new LocalMcpStore(join(dir, "mcp.json")),
  };
}

test("q quits immediately; menu rendered with providers", async () => {
  const { client, store } = deps({
    "/mcp-broker/oauth/providers": [{ provider_id: "fal.ai", display_name: "fal.ai", flow: "pat_paste" }],
    "/mcp-broker/oauth/connections": [],
  });
  const { io, out } = makeIO(["q"]);
  await runMcpMenu(client, store, io);
  const all = out.join("");
  assert.match(all, /MCP Servers/);
  assert.match(all, /fal\.ai/);
});

test("backend 404 degrades to local-only", async () => {
  const { client, store } = deps({});
  store.add({ name: "docs", url: "https://x.example/m", transport: "http" });
  const { io, out } = makeIO(["q"]);
  await runMcpMenu(client, store, io);
  const all = out.join("");
  assert.match(all, /backend connections unavailable/i);
  assert.match(all, /docs/);
});

test("add flow creates a local server", async () => {
  const { client, store } = deps({});
  // 'a' opens add; readLine supplies name, url, token(empty); then 'q' quits.
  const { io } = makeIO(["a", "q"], ["docs", "https://mcp.example.com/sse", ""]);
  await runMcpMenu(client, store, io);
  assert.equal(store.list()[0]?.name, "docs");
});

test("delete flow removes local server after y confirm", async () => {
  const { client, store } = deps({});
  store.add({ name: "docs", url: "https://x.example/m", transport: "http" });
  // Enter on docs row -> manage menu -> down to Delete -> Enter -> 'y' -> back at main -> 'q'
  const { io } = makeIO([
    { kind: "submit" },
    { kind: "down" },
    { kind: "down" },
    { kind: "submit" },
    "y",
    "q",
  ]);
  await runMcpMenu(client, store, io);
  assert.equal(store.list().length, 0);
});

test("pat auth flow stores PAT via broker", async () => {
  let patBody: unknown = null;
  const api = {
    async getJson(path: string) {
      if (path === "/mcp-broker/oauth/providers")
        return [{ provider_id: "fal.ai", display_name: "fal.ai", flow: "pat_paste" }];
      if (path === "/mcp-broker/oauth/connections") return [];
      throw Object.assign(new Error("HTTP 404"), { status: 404 });
    },
    async postJson(path: string, body: unknown) {
      if (path === "/mcp-broker/oauth/start") return { flow: "pat_paste" };
      if (path === "/mcp-broker/oauth/pat-store") {
        patBody = body;
        return { ok: true };
      }
      throw Object.assign(new Error("HTTP 404"), { status: 404 });
    },
  } as unknown as ApiClient;
  const dir = mkdtempSync(join(tmpdir(), "aether-mcpcmd-"));
  const store = new LocalMcpStore(join(dir, "mcp.json"));
  // Enter on fal.ai -> manage -> Enter on Authenticate -> paste PAT -> quit out
  const { io, out } = makeIO(
    [{ kind: "submit" }, { kind: "submit" }, "q", "q"],
    ["fal-secret-key"],
  );
  await runMcpMenu(new McpClient(api), store, io);
  assert.deepEqual(patBody, { provider_id: "fal.ai", pat: "fal-secret-key", metadata: {} });
  assert.match(out.join(""), /connected/i);
});

test("a hanging broker tool test fails visibly, preserves selection, and ignores late completion", async () => {
  let resolveTools: ((value: Array<{ name: string }>) => void) | undefined;
  let toolSignal: AbortSignal | undefined;
  const tools = new Promise<Array<{ name: string }>>((resolve) => { resolveTools = resolve; });
  const client = {
    async listProviders() {
      return [
        { provider_id: "first", display_name: "First", flow: "pat_paste" as const },
        { provider_id: "second", display_name: "Second", flow: "pat_paste" as const },
      ];
    },
    async listConnections() {
      return [
        { provider_id: "first", created_at: "t", updated_at: "t" },
        { provider_id: "second", created_at: "t", updated_at: "t" },
      ];
    },
    async listTools(_providerId: string, options?: { signal?: AbortSignal }) {
      toolSignal = options?.signal;
      return tools;
    },
  } as unknown as McpClient;
  const dir = mkdtempSync(join(tmpdir(), "aether-mcpcmd-hang-"));
  const { io, out } = makeIO([
    { kind: "down" },
    { kind: "submit" },
    { kind: "down" },
    { kind: "submit" },
    "q",
  ]);
  await runMcpMenu(client, new LocalMcpStore(join(dir, "mcp.json")), io, {
    operationTimeoutMs: 10,
  });
  const beforeLateCompletion = out.join("");
  assert.equal(toolSignal?.aborted, true);
  assert.match(beforeLateCompletion, /stalled for 10ms/i);
  assert.match(beforeLateCompletion, /request was cancelled/i);
  assert.match(beforeLateCompletion, /safe to retry/i);
  const lastFrame = beforeLateCompletion.slice(beforeLateCompletion.lastIndexOf("MCP Servers"));
  assert.match(lastFrame, /❯\s+✔\s+Second/);

  resolveTools?.([{ name: "late" }]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(out.join(""), beforeLateCompletion, "late provider completion must not write after exit");
});

test("a hanging local HTTP/SSE reachability test is bounded and sends no credential", async () => {
  const { client, store } = deps({});
  store.add({
    name: "docs",
    url: "https://mcp.example.test/sse?token=must-not-render",
    transport: "http",
    authToken: "SENTINEL-local-auth-never-send",
  });
  let probeSignal: AbortSignal | undefined;
  const { io, out } = makeIO([{ kind: "submit" }, { kind: "submit" }, "q"]);
  await runMcpMenu(client, store, io, {
    operationTimeoutMs: 10,
    localProbe: async (_url, signal) => {
      probeSignal = signal;
      return new Promise(() => {});
    },
  });
  const rendered = out.join("");
  assert.equal(probeSignal?.aborted, true);
  assert.match(rendered, /local reachability test.*stalled/i);
  assert.match(rendered, /no stored credential was sent/i);
  assert.equal(rendered.includes("must-not-render"), false);
  assert.equal(rendered.includes("SENTINEL-local-auth-never-send"), false);
});

test("Ctrl+C cancels an in-flight MCP operation and restores the terminal loop", async () => {
  let cancelListener: (() => void) | undefined;
  let subscriptions = 0;
  let toolSignal: AbortSignal | undefined;
  const keyQueue: Key[] = [
    { kind: "submit" },
    { kind: "down" },
    { kind: "submit" },
  ];
  const chunks: string[] = [];
  const io: MenuIO = {
    out: { write: (value: string) => (chunks.push(value), true) } as unknown as MenuIO["out"],
    async nextKey() { return keyQueue.shift() ?? { kind: "eof" }; },
    async readLine() { return ""; },
    async openUrl() { return openedOk(); },
    async sleep() {},
    subscribeCancel(cancel) {
      subscriptions++;
      cancelListener = cancel;
      return () => { subscriptions--; };
    },
  };
  const client = {
    async listProviders() {
      return [{ provider_id: "docs", display_name: "Docs", flow: "pat_paste" as const }];
    },
    async listConnections() {
      return [{ provider_id: "docs", created_at: "t", updated_at: "t" }];
    },
    async listTools(_provider: string, options?: { signal?: AbortSignal }) {
      toolSignal = options?.signal;
      queueMicrotask(() => cancelListener?.());
      return new Promise<Array<{ name: string }>>(() => {});
    },
  } as unknown as McpClient;
  await runMcpMenu(client, new LocalMcpStore(join(mkdtempSync(join(tmpdir(), "aether-mcpcancel-")), "mcp.json")), io);
  assert.equal(toolSignal?.aborted, true);
  assert.equal(subscriptions, 0);
  assert.match(chunks.join(""), /was cancelled/i);
  assert.match(chunks.join(""), /terminal is ready/i);
});

test("100 MCP menu IO mount/dispose cycles leave no data listeners or pending readers", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const baseline = input.listenerCount("data");
  for (let index = 0; index < 100; index++) {
    const io = createMcpMenuIO(input, output);
    assert.equal(input.listenerCount("data"), baseline + 1);
    const pending = io.nextKey();
    io.close();
    io.close();
    assert.deepEqual(await pending, { kind: "eof" });
    assert.equal(input.listenerCount("data"), baseline);
  }
  const writtenBefore = output.readableLength;
  input.write("q");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(output.readableLength, writtenBefore, "closed MCP IO must not write after disposal");
  input.destroy();
  output.destroy();
});

test("MCP menu IO close is exception-safe and does not write after resolving a pending read", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const io = createMcpMenuIO(input, output);
  io.subscribeCancel?.(() => { throw new Error("defective cancel hook"); });
  const pendingLine = io.readLine("value: ");
  const beforeClose = output.readableLength;
  assert.doesNotThrow(() => io.close());
  assert.equal(await pendingLine, "");
  assert.equal(output.readableLength, beforeClose, "EOF cleanup must not append a post-close newline");
  assert.equal(input.listenerCount("data"), 0);
  input.destroy();
  output.destroy();
});

// ── OAuth handoff ───────────────────────────────────────────────────────────
//
// Two failures that both used to read as success, or as a slow provider.

const STALE_ROW = {
  provider_id: "fal.ai",
  created_at: "2026-01-01T00:00:00.000000+00:00",
  updated_at: "2026-01-01T00:00:00.000000+00:00",
};

function oauthApi(order: string[], connections: () => unknown[]): ApiClient {
  return {
    async getJson(path: string) {
      if (path === "/mcp-broker/oauth/providers")
        return [{ provider_id: "fal.ai", display_name: "fal.ai", flow: "auth_code_pkce" }];
      if (path === "/mcp-broker/oauth/connections") {
        order.push("list-connections");
        return connections();
      }
      throw Object.assign(new Error("HTTP 404"), { status: 404 });
    },
    async postJson(path: string) {
      if (path === "/mcp-broker/oauth/start")
        return { flow: "auth_code_pkce", authorize_url: "https://provider.example/authorize?x=1" };
      throw Object.assign(new Error("HTTP 404"), { status: 404 });
    },
  } as unknown as ApiClient;
}

test("a re-authorization that never completes is not reported as connected", async () => {
  // The provider is ALREADY connected. Before the baseline check, the first
  // poll found this row and printed "connected" without the operator having
  // touched the consent screen.
  const order: string[] = [];
  const api = oauthApi(order, () => [STALE_ROW]);
  const dir = mkdtempSync(join(tmpdir(), "aether-mcpoauth-"));
  const store = new LocalMcpStore(join(dir, "mcp.json"));
  const { io, out } = makeAuthIO([{ kind: "submit" }, { kind: "submit" }, "q", "q"], openedOk(), order);

  await runMcpMenu(new McpClient(api), store, io, { oauthTimeoutMs: 150 });
  const text = out.join("");

  // The menu ROW also reads "fal.ai  connected", so the negative has to be
  // the note the auth flow writes, not any occurrence of the word.
  assert.doesNotMatch(text, /✔ fal\.ai connected\n/);
  assert.match(text, /MCP_AUTH_TIMEOUT/);
  assert.match(text, /already connected and that connection was left untouched/);
});

test("the connection baseline is read before the browser is opened", async () => {
  // Order is the whole point: a baseline captured after the browser could
  // already include the authorization it is supposed to be measuring against.
  // The menu's own /connections listing also precedes the browser, so an
  // index comparison cannot tell the two reads apart. This does: the row
  // advances the moment the browser opens (the earliest a consent can land),
  // and only a baseline taken BEFORE that sees the stale row and accepts it.
  const order: string[] = [];
  const advanced = { ...STALE_ROW, updated_at: "2026-01-01T00:05:00.000000+00:00" };
  const api = oauthApi(order, () => (order.includes("open-browser") ? [advanced] : [STALE_ROW]));
  const dir = mkdtempSync(join(tmpdir(), "aether-mcpoauth-"));
  const store = new LocalMcpStore(join(dir, "mcp.json"));
  const { io, out } = makeAuthIO([{ kind: "submit" }, { kind: "submit" }, "q", "q"], openedOk(), order);

  await runMcpMenu(new McpClient(api), store, io, { oauthTimeoutMs: 2_000 });
  const text = out.join("");

  const opened = order.indexOf("open-browser");
  assert.ok(opened > 0 && order.slice(0, opened).includes("list-connections"), JSON.stringify(order));
  // A baseline read after the browser opened would hold `advanced` itself, and
  // the wait would time out against its own evidence.
  assert.match(text, /✔ fal\.ai connected\n/);
  assert.doesNotMatch(text, /MCP_AUTH_TIMEOUT/);
});

test("a machine with no browser is told so, and no authorization wait is started", async () => {
  const order: string[] = [];
  const api = oauthApi(order, () => []);
  const dir = mkdtempSync(join(tmpdir(), "aether-mcpoauth-"));
  const store = new LocalMcpStore(join(dir, "mcp.json"));
  const { io, out } = makeAuthIO(
    [{ kind: "submit" }, { kind: "submit" }, "q", "q"],
    openedOk({
      code: "BROWSER_NOT_FOUND",
      available: false,
      launched: false,
      launcher: null,
      browser: null,
      evidence: "no browser registered",
    }),
    order,
  );

  await runMcpMenu(new McpClient(api), store, io, { oauthTimeoutMs: 30_000 });
  const text = out.join("");

  assert.match(text, /browser not opened \(BROWSER_NOT_FOUND\)/);
  assert.match(text, /authorization was not started/);
  // The authorization wait never began. Its first act is always a sleep, so
  // zero sleeps proves the operator was not held for the full oauth timeout
  // waiting on a browser that was never going to appear.
  assert.equal(order.filter((e) => e === "sleep").length, 0);
  assert.ok(order.indexOf("open-browser") > order.indexOf("list-connections"));
});

test("a broker-authored failure message is redacted to its status, never printed", async () => {
  // safeMcpFailure is an allowlist: only text this CLI composed is printable.
  // Anything the broker or a provider chose to say — here a lure URL inside
  // the error text — must collapse to the HTTP status.
  const order: string[] = [];
  const base = oauthApi(order, () => []);
  const api = {
    ...base,
    async postJson(path: string, body: unknown) {
      if (path === "/mcp-broker/oauth/start") {
        throw Object.assign(new Error("PROVIDER SAYS: visit https://lure.example/reset now"), { status: 502 });
      }
      return (base as unknown as { postJson(p: string, b: unknown): Promise<unknown> }).postJson(path, body);
    },
  } as unknown as ApiClient;
  const dir = mkdtempSync(join(tmpdir(), "aether-mcpoauth-"));
  const store = new LocalMcpStore(join(dir, "mcp.json"));
  const { io, out } = makeAuthIO([{ kind: "submit" }, { kind: "submit" }, "q", "q"], openedOk(), order);

  await runMcpMenu(new McpClient(api), store, io, { oauthTimeoutMs: 150 });
  const text = out.join("");

  assert.match(text, /auth start failed: request failed \(HTTP 502\)/);
  assert.doesNotMatch(text, /lure\.example|PROVIDER SAYS/);
  assert.equal(order.filter((e) => e === "open-browser").length, 0, "no browser on a failed start");
});
