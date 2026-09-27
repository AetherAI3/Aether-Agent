// Regression tests for the "login succeeds but model-select throws HTTP 401"
// bug (PR #47). Four layers:
//   1. tokenStoreFromEnv: a fresh login must PERSIST even when AETHER_TOKEN is
//      injected — previously it vanished with the process, so every later run
//      re-read the stale env token and 401'd despite "✓ Logged in."
//   2. ApiClient: an expired session token gets ONE transparent /auth/refresh
//      + retry before the 401 surfaces. aek_ API keys never trigger refresh.
//   3. errorHint: 401 / 402 / 403 are distinct + the server's own detail
//      (e.g. a UVT-balance message) is surfaced instead of a bare "HTTP 401".
//   4. renderAuthBox (LOOP-06): `aether auth status` must not print
//      "Authenticated" when the server has just rejected the stored token
//      with a 401/403 — that used to be folded into the same silent
//      "server unreachable, show what we know locally" catch as a genuine
//      network outage.
//   5. cmdAuth (LOOP-06 round 2): renderAuthBox's /models call is the FIRST
//      network round-trip either the "status" subcommand or bare `aether
//      auth` make, and previously nothing was written to stdout until the
//      whole thing resolved — up to DEFAULT_REQUEST_TIMEOUT_MS of silence on
//      a slow connection ("the REPL just looks hung", the exact defect class
//      PR #47 fixed for slash.ts's catalog fetch). cmdAuth must now print a
//      loading line BEFORE awaiting renderAuthBox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tokenStoreFromEnv, FileTokenStore, StaticTokenStore } from "../src/core/auth.js";
import { ApiClient } from "../src/core/transport.js";
import { errorHint, HttpError } from "../src/core/errors.js";
import { hintFor } from "../src/core/error_hints.js";
import { renderAuthBox, cmdAuth } from "../src/commands/auth.js";
import type { LoginOpts } from "../src/commands/login.js";
import { stripAnsi } from "../src/ui/theme.js";
import type { AppContext } from "../src/core/context.js";

function withTempConfigDir<T>(fn: () => Promise<T>): Promise<T> {
  const dir = join(tmpdir(), `aether-401-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const prev = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = dir;
  return fn().finally(() => {
    if (prev === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = prev;
    rmSync(dir, { recursive: true, force: true });
  });
}

// ── 1. login persistence under AETHER_TOKEN ──────────────────────────────

test("tokenStoreFromEnv: set() persists a fresh login to disk even when AETHER_TOKEN is injected", () =>
  withTempConfigDir(async () => {
    const store = tokenStoreFromEnv({ AETHER_TOKEN: "stale_env_token" } as NodeJS.ProcessEnv);
    assert.equal(await store.get(), "stale_env_token");
    await store.set("aek_fresh_login");
    // Same process: the fresh token must win immediately…
    assert.equal(await store.get(), "aek_fresh_login");
    // …and a NEW process (fresh file store, no env token) must see it too.
    assert.equal(await new FileTokenStore().get(), "aek_fresh_login");
  }));

test("tokenStoreFromEnv: clear() signs out both the override and the disk store", () =>
  withTempConfigDir(async () => {
    const store = tokenStoreFromEnv({ AETHER_TOKEN: "envtok" } as NodeJS.ProcessEnv);
    await store.set("aek_x");
    await store.clear();
    assert.equal(await store.get(), null);
    assert.equal(await new FileTokenStore().get(), null);
  }));

// ── 2. transparent refresh-on-401 ────────────────────────────────────────

type Call = { url: string; init: RequestInit };

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler: (url: string, init: RequestInit) => Response, calls: Call[]): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    return handler(u, init ?? {});
  }) as typeof globalThis.fetch;
}

function bearer(init: RequestInit): string {
  return (init.headers as Record<string, string>)["Authorization"] ?? "";
}

test("ApiClient: 401 with a session token triggers one /auth/refresh then a retry that succeeds", async () => {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  const store = new StaticTokenStore("sess_expired");
  stubFetch((url, init) => {
    if (url.endsWith("/auth/refresh")) return jsonRes(200, { session_token: "sess_fresh" });
    if (bearer(init) === "Bearer sess_fresh") return jsonRes(200, { models: [] });
    return jsonRes(401, { detail: "token expired" });
  }, calls);
  try {
    const api = new ApiClient("https://api.example", store);
    const out = await api.getJson<{ models: unknown[] }>("/models");
    assert.deepEqual(out, { models: [] });
    assert.equal(await store.get(), "sess_fresh", "refreshed token must be stored");
    const urls = calls.map((c) => c.url.replace("https://api.example", ""));
    assert.deepEqual(urls, ["/models", "/auth/refresh", "/models"]);
  } finally {
    globalThis.fetch = real;
  }
});

test("ApiClient: aek_ API keys never attempt refresh — the 401 surfaces directly", async () => {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  stubFetch(() => jsonRes(401, {}), calls);
  try {
    const api = new ApiClient("https://api.example", new StaticTokenStore("aek_key"));
    await assert.rejects(() => api.getJson("/models"), (e: unknown) => (e as HttpError).status === 401);
    assert.equal(calls.length, 1, "no refresh call for API keys");
  } finally {
    globalThis.fetch = real;
  }
});

test("ApiClient: failed refresh surfaces the ORIGINAL 401 (no retry loop)", async () => {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  stubFetch((url) => (url.endsWith("/auth/refresh") ? jsonRes(401, {}) : jsonRes(401, { detail: "expired" })), calls);
  try {
    const api = new ApiClient("https://api.example", new StaticTokenStore("sess_dead"));
    await assert.rejects(() => api.getJson("/models"), (e: unknown) => (e as HttpError).status === 401);
    const urls = calls.map((c) => c.url.replace("https://api.example", ""));
    assert.deepEqual(urls, ["/models", "/auth/refresh"], "exactly one refresh attempt, no loop");
  } finally {
    globalThis.fetch = real;
  }
});

test("ApiClient: a 401 from /auth/* itself never recurses into refresh", async () => {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  stubFetch(() => jsonRes(401, {}), calls);
  try {
    const api = new ApiClient("https://api.example", new StaticTokenStore("sess_x"));
    await assert.rejects(() => api.postJson("/auth/refresh", {}));
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = real;
  }
});

// ── 3. error detail + distinct hints ─────────────────────────────────────

test("HttpError carries the server's detail/reason body text, not just 'HTTP 401'", async () => {
  const real = globalThis.fetch;
  stubFetch(() => jsonRes(401, { detail: "insufficient UVT balance" }), []);
  try {
    const api = new ApiClient("https://api.example", new StaticTokenStore("aek_k"));
    await assert.rejects(
      () => api.getJson("/models"),
      (e: unknown) => /insufficient UVT balance/.test((e as Error).message),
    );
  } finally {
    globalThis.fetch = real;
  }
});

test("errorHint: 401, 402, 403 give distinct actionable hints", () => {
  const h401 = errorHint(new HttpError(401, "HTTP 401"), "https://x") ?? "";
  const h402 = errorHint(new HttpError(402, "HTTP 402"), "https://x") ?? "";
  const h403 = errorHint(new HttpError(403, "HTTP 403"), "https://x") ?? "";
  assert.match(h401, /aether auth login/);
  assert.match(h402, /UVT|balance/i);
  assert.match(h403, /plan|tier/i);
  assert.notEqual(h401, h403, "401 (re-auth) and 403 (plan) must not share one hint");
});

test("hintFor mirrors errorHint's 401/402/403 split for embedders", () => {
  assert.match(hintFor(new HttpError(401, "x")) ?? "", /aether auth login/);
  assert.match(hintFor(new HttpError(402, "x")) ?? "", /UVT|balance/i);
  assert.match(hintFor(new HttpError(403, "x")) ?? "", /plan|tier/i);
});

// ── 4. round-2 adversarial-review regressions ────────────────────────────

test("ApiClient: refresh is refused over insecure transport — token never leaves in cleartext", async () => {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  // No bearer attached (empty store at header time), then a token appears by
  // refresh time: previously this POSTed the session token over plain http.
  let first = true;
  const store: import("../src/core/auth.js").TokenStore = {
    async get() { const t = first ? null : "sess_late"; first = false; return t; },
    async set() {}, async clear() {},
  };
  stubFetch(() => jsonRes(401, {}), calls);
  try {
    const api = new ApiClient("http://evil.example.com", store);
    await assert.rejects(() => api.getJson("/models"));
    assert.ok(!calls.some((c) => c.url.includes("/auth/refresh")), "no refresh over insecure transport");
    assert.ok(calls.every((c) => !bearer(c.init)), "no bearer ever sent over http");
  } finally {
    globalThis.fetch = real;
  }
});

test("ApiClient: stream() also refreshes once on 401 and retries", async () => {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  const store = new StaticTokenStore("sess_old");
  stubFetch((url, init) => {
    if (url.endsWith("/auth/refresh")) return jsonRes(200, { session_token: "sess_new" });
    if (bearer(init) === "Bearer sess_new")
      return new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    return jsonRes(401, {});
  }, calls);
  try {
    const api = new ApiClient("https://api.example", store);
    const stream = await api.stream("/agent/chat/stream", {});
    assert.ok(stream);
    const urls = calls.map((c) => c.url.replace("https://api.example", ""));
    assert.deepEqual(urls, ["/agent/chat/stream", "/auth/refresh", "/agent/chat/stream"]);
  } finally {
    globalThis.fetch = real;
  }
});

test("ApiClient: a straggler 401 after a concurrent rotation retries with the NEW token, no second refresh", async () => {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  // The store rotates BETWEEN this request's send (which reads sess_old) and
  // the refresh check — as when a concurrent request already refreshed. The
  // early-return in refreshSession must see current !== usedToken and signal
  // "retry" without POSTing /auth/refresh.
  let reads = 0;
  const store: import("../src/core/auth.js").TokenStore = {
    async get() { return reads++ === 0 ? "sess_old" : "sess_new"; },
    async set() { throw new Error("refresh must not run"); },
    async clear() {},
  };
  stubFetch((url, init) => {
    if (url.endsWith("/auth/refresh")) throw new Error("second refresh burned");
    return bearer(init) === "Bearer sess_new" ? jsonRes(200, { ok: true }) : jsonRes(401, {});
  }, calls);
  try {
    const api = new ApiClient("https://api.example", store);
    const out = await api.getJson<{ ok: boolean }>("/models");
    assert.deepEqual(out, { ok: true });
    assert.ok(!calls.some((c) => c.url.includes("/auth/refresh")), "no /auth/refresh call");
    assert.equal(calls.length, 2, "one failed send + one retry with the rotated token");
  } finally {
    globalThis.fetch = real;
  }
});

test("EnvOverrideTokenStore: update() (auto-refresh) swaps the active token WITHOUT touching disk", () =>
  withTempConfigDir(async () => {
    const disk = new FileTokenStore();
    await disk.set("disk_standalone_login");
    const store = tokenStoreFromEnv({ AETHER_TOKEN: "sess_embedded" } as NodeJS.ProcessEnv);
    await (store.update as (t: string) => Promise<void>)("sess_embedded_rotated");
    assert.equal(await store.get(), "sess_embedded_rotated", "active token rotated in-process");
    assert.equal(await disk.get(), "disk_standalone_login", "standalone on-disk login untouched");
  }));

// ── 5. renderAuthBox (LOOP-06): 401/403 must not read as "Authenticated" ──

function fakeCtx(api: ApiClient, tokens: StaticTokenStore): AppContext {
  return {
    cfg: { baseUrl: "https://api.example" },
    api,
    tokens,
    flags: { cwd: process.cwd(), json: false, audit: false, yes: false },
    confirm: async () => false,
  } as unknown as AppContext;
}

test("renderAuthBox: a 401 from /models renders a distinct 'Session expired' state, not 'Authenticated'", async () => {
  const real = globalThis.fetch;
  // An aek_ API key never triggers refresh (see the aek_ test above), so the
  // 401 from /models surfaces to renderAuthBox's catch untouched.
  const tokens = new StaticTokenStore("aek_deadtoken1234");
  stubFetch(() => jsonRes(401, { detail: "token revoked" }), []);
  try {
    const api = new ApiClient("https://api.example", tokens);
    const panel = stripAnsi(await renderAuthBox(fakeCtx(api, tokens)));
    assert.match(panel, /Session expired/);
    assert.doesNotMatch(panel, /Authenticated/, "must not claim Authenticated for a rejected token");
    assert.match(panel, /aether auth login/);
  } finally {
    globalThis.fetch = real;
  }
});

test("renderAuthBox: a 403 from /models also renders 'Session expired' (not silently 'Authenticated')", async () => {
  const real = globalThis.fetch;
  const tokens = new StaticTokenStore("aek_deadtoken1234");
  stubFetch(() => jsonRes(403, { detail: "forbidden" }), []);
  try {
    const api = new ApiClient("https://api.example", tokens);
    const panel = stripAnsi(await renderAuthBox(fakeCtx(api, tokens)));
    assert.match(panel, /Session expired/);
    assert.doesNotMatch(panel, /Authenticated/);
  } finally {
    globalThis.fetch = real;
  }
});

test("renderAuthBox: a genuine network outage reports a stored but unverified credential", async () => {
  const real = globalThis.fetch;
  const tokens = new StaticTokenStore("aek_deadtoken1234");
  globalThis.fetch = (async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }) as typeof globalThis.fetch;
  try {
    const api = new ApiClient("https://api.example", tokens);
    const panel = stripAnsi(await renderAuthBox(fakeCtx(api, tokens)));
    assert.match(panel, /Verification unavailable/);
    assert.match(panel, /Credential stored, but the server could not verify it/);
    assert.match(panel, /aether doctor --live/);
    assert.doesNotMatch(panel, /Authenticated/, "an unreachable server must not be reported as verified");
    assert.doesNotMatch(panel, /Session expired/);
  } finally {
    globalThis.fetch = real;
  }
});

test("renderAuthBox: a successful /models call renders the normal 'Authenticated' panel with tier/default", async () => {
  const real = globalThis.fetch;
  const tokens = new StaticTokenStore("aek_deadtoken1234");
  stubFetch(() => jsonRes(200, { tier: "pro", default: "aether-large" }), []);
  try {
    const api = new ApiClient("https://api.example", tokens);
    const panel = stripAnsi(await renderAuthBox(fakeCtx(api, tokens)));
    assert.match(panel, /Authenticated/);
    assert.doesNotMatch(panel, /Session expired/);
    assert.match(panel, /pro/);
    assert.match(panel, /aether-large/);
  } finally {
    globalThis.fetch = real;
  }
});

// ── 6. cmdAuth (LOOP-06 round 2): loading feedback before the /models call ──
//
// These intercept the process-wide process.stdout.write, which — unlike the
// renderAuthBox tests above — is a genuinely global stream shared with the
// test runner's own reporter. Matching on a broad /Authenticated/ regex over
// that captured stream is a trap: a SIBLING test's own description text
// ("...renders the normal 'Authenticated' panel...") can be flushed by the
// reporter through that same intercepted stream while this test's capture
// window is open, producing a false match unrelated to cmdAuth's own output.
// PANEL_MARKER is the exact, singular header string renderAuthBox emits
// (auth.ts's `theme.bold("Aether Agent — Authenticated")`) — not a string
// that appears anywhere in a test name — so a match can only come from
// cmdAuth's own finished panel actually having been written.
const PANEL_MARKER = "Aether Agent — Authenticated";

function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    writes,
    restore: () => {
      process.stdout.write = orig;
    },
  };
}

test("cmdAuth 'status': prints a loading line BEFORE the /models call resolves — no silent hang", async () => {
  const real = globalThis.fetch;
  const tokens = new StaticTokenStore("aek_deadtoken1234");
  let resolveFetch: (r: Response) => void = () => {};
  const pending = new Promise<Response>((res) => {
    resolveFetch = res;
  });
  // Simulate a stalled/slow connection: fetch never resolves until we say so.
  globalThis.fetch = (async () => pending) as typeof globalThis.fetch;
  const cap = captureStdout();
  try {
    const api = new ApiClient("https://api.example", tokens);
    const ctx = fakeCtx(api, tokens);
    const done = cmdAuth(ctx, ["status"], {} as LoginOpts);
    // Let queued microtasks (the write before the await) run while the
    // network call is still deliberately left hanging.
    await new Promise((r) => setImmediate(r));
    assert.ok(
      cap.writes.some((w) => /checking session/i.test(w)),
      "a loading line must be written before the network call resolves",
    );
    assert.ok(
      !cap.writes.some((w) => w.includes(PANEL_MARKER)),
      "the finished panel must NOT have printed yet — /models is still pending",
    );
    resolveFetch(jsonRes(200, { tier: "pro", default: "aether-large" }));
    const code = await done;
    assert.equal(code, 0);
    assert.ok(cap.writes.some((w) => w.includes(PANEL_MARKER)), "the panel prints once /models resolves");
  } finally {
    globalThis.fetch = real;
    cap.restore();
  }
});

test("cmdAuth bare `aether auth` (no subcommand): same loading line before the /models call resolves", async () => {
  const real = globalThis.fetch;
  const tokens = new StaticTokenStore("aek_deadtoken1234");
  let resolveFetch: (r: Response) => void = () => {};
  const pending = new Promise<Response>((res) => {
    resolveFetch = res;
  });
  globalThis.fetch = (async () => pending) as typeof globalThis.fetch;
  const cap = captureStdout();
  try {
    const api = new ApiClient("https://api.example", tokens);
    const ctx = fakeCtx(api, tokens);
    const done = cmdAuth(ctx, [], {} as LoginOpts);
    await new Promise((r) => setImmediate(r));
    assert.ok(
      cap.writes.some((w) => /checking session/i.test(w)),
      "bare `aether auth` must also show loading feedback before /models resolves",
    );
    assert.ok(!cap.writes.some((w) => w.includes(PANEL_MARKER)));
    resolveFetch(jsonRes(200, { tier: "pro", default: "aether-large" }));
    const code = await done;
    assert.equal(code, 0);
    assert.ok(cap.writes.some((w) => w.includes(PANEL_MARKER)));
  } finally {
    globalThis.fetch = real;
    cap.restore();
  }
});

test("cmdAuth status exits nonzero when signed out or rejected, and zero only after live verification", async () => {
  const cases = [
    { token: "", response: null, expected: 1 },
    { token: "aek_rejected", response: jsonRes(401, { detail: "expired" }), expected: 1 },
    { token: "aek_verified", response: jsonRes(200, { tier: "pro", default: "aether-large" }), expected: 0 },
  ] as const;
  const real = globalThis.fetch;
  const cap = captureStdout();
  try {
    for (const item of cases) {
      const tokens = new StaticTokenStore(item.token);
      if (item.response) stubFetch(() => item.response, []);
      const api = new ApiClient("https://api.example", tokens);
      assert.equal(await cmdAuth(fakeCtx(api, tokens), ["status"], {} as LoginOpts), item.expected);
    }
  } finally {
    globalThis.fetch = real;
    cap.restore();
  }
});

// ── 7. authRefresh (LOOP-06 round 3): the catch block must go through the
// shared formatErrorLine/errorHint convention — same as chat.ts's printError
// — instead of a hand-built, unstyled `✗ <message>` template string with no
// hint and no /doctor pointer. ──

function captureStderr(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    writes,
    restore: () => {
      process.stderr.write = orig;
    },
  };
}

test("cmdAuth 'refresh': a network failure prints the shared formatErrorLine glyph + a /doctor hint", async () => {
  const real = globalThis.fetch;
  // A session token (not aek_-prefixed) so authRefresh actually attempts the
  // POST /auth/refresh instead of short-circuiting on "API tokens don't expire".
  const tokens = new StaticTokenStore("sess_expiring");
  globalThis.fetch = (async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }) as typeof globalThis.fetch;
  const cap = captureStderr();
  try {
    const api = new ApiClient("https://api.example", tokens);
    const ctx = fakeCtx(api, tokens);
    const code = await cmdAuth(ctx, ["refresh"], {} as LoginOpts);
    assert.equal(code, 1);
    const out = cap.writes.join("");
    assert.match(out, /✗/, "must use formatErrorLine's glyph, not a bare template string");
    assert.match(out, /\/doctor/, "a network failure must surface errorHint's /doctor pointer");
    assert.match(out, /\n\n$/, "formatErrorLine's trailing blank-line separator must be present");
  } finally {
    globalThis.fetch = real;
    cap.restore();
  }
});

test("cmdAuth 'refresh': a server-rejected refresh (HttpError) still prints the shared glyph + the re-login hint", async () => {
  const real = globalThis.fetch;
  const tokens = new StaticTokenStore("sess_expiring");
  globalThis.fetch = (async () => jsonRes(401, { detail: "refresh token revoked" })) as typeof globalThis.fetch;
  const cap = captureStderr();
  try {
    const api = new ApiClient("https://api.example", tokens);
    const ctx = fakeCtx(api, tokens);
    const code = await cmdAuth(ctx, ["refresh"], {} as LoginOpts);
    assert.equal(code, 1);
    const out = cap.writes.join("");
    assert.match(out, /✗/, "must use formatErrorLine's glyph, not a bare template string");
    assert.match(out, /refresh token revoked/, "the server's detail must still surface in the message");
    assert.match(out, /aether auth login/, "a 401 must surface errorHint's re-login pointer");
  } finally {
    globalThis.fetch = real;
    cap.restore();
  }
});

test("cmdAuth 'refresh': a 200 with no session_token also prints the shared formatErrorLine glyph (not the one bare ✗ line left in authRefresh)", async () => {
  const real = globalThis.fetch;
  const tokens = new StaticTokenStore("sess_expiring");
  globalThis.fetch = (async () => jsonRes(200, {})) as typeof globalThis.fetch;
  const cap = captureStderr();
  try {
    const api = new ApiClient("https://api.example", tokens);
    const ctx = fakeCtx(api, tokens);
    const code = await cmdAuth(ctx, ["refresh"], {} as LoginOpts);
    assert.equal(code, 1);
    const out = cap.writes.join("");
    assert.match(out, /✗/, "must use formatErrorLine's glyph, not a bare template string");
    assert.match(out, /Refresh failed/);
    assert.match(out, /aether auth login/, "must still point at re-login even with no err object to derive a hint from");
    assert.match(out, /\n\n$/, "formatErrorLine's trailing blank-line separator must be present");
  } finally {
    globalThis.fetch = real;
    cap.restore();
  }
});
