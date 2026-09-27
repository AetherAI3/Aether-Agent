// LOOP-06 round 2: end-to-end regression for cmdLogin's headless
// `--username/--password` path. loginWithPassword's thrown Error is written
// straight to process.stderr with NO sanitization of its own (see
// commands/login.ts's `catch (err) { process.stderr.write(\`✗ ${err.message}\n\`) }`)
// — so a malicious/misconfigured server's `reason` field must already be
// sanitized and length-capped by the time it reaches loginWithPassword's
// thrown message (fixed in core/auth.ts via transport.ts's
// sanitizeServerText()). This test exercises the FULL path, not just the
// auth.ts unit, to confirm the raw control bytes never reach stderr.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cmdLogin } from "../src/commands/login.js";
import { StaticTokenStore } from "../src/core/auth.js";
import { ApiClient } from "../src/core/transport.js";
import type { AppContext } from "../src/core/context.js";

function fakeCtx(): AppContext {
  return {
    cfg: { baseUrl: "https://api.example" },
    tokens: new StaticTokenStore(""),
    flags: { cwd: process.cwd(), json: false, audit: false, yes: false },
    confirm: async () => false,
  } as unknown as AppContext;
}

/** Same as fakeCtx() but with a real ApiClient wired in — the device-code
 *  request/poll paths of cmdLogin go through ctx.api, unlike the headless
 *  --username/--password path above which calls loginWithPassword directly. */
function fakeCtxWithApi(): AppContext {
  const tokens = new StaticTokenStore("");
  return {
    cfg: { baseUrl: "https://api.example" },
    api: new ApiClient("https://api.example", tokens),
    tokens,
    flags: { cwd: process.cwd(), json: false, audit: false, yes: false },
    confirm: async () => false,
  } as unknown as AppContext;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const orig = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = ((s: string) => ((out += s), true)) as typeof process.stderr.write;
  return {
    text: () => out,
    restore: () => {
      process.stderr.write = orig;
    },
  };
}

test("cmdLogin (--username/--password): a malicious server `plan` on a SUCCESSFUL login cannot survive into the process's stdout output", async () => {
  const realFetch = globalThis.fetch;
  const realWrite = process.stdout.write.bind(process.stdout);
  const evilPlan = "\x1b]52;c;ZXZpbA==\x07pro" + "E".repeat(300);
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ authenticated: true, session_token: "sess_ok", plan: evilPlan }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  let captured = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: unknown): boolean => {
    captured += String(chunk);
    return true;
  };
  try {
    const code = await cmdLogin(fakeCtx(), { username: "u", password: "p" });
    assert.equal(code, 0, "a successful login must still report success");
    assert.ok(captured.includes("Logged in"), "the success message must still be reported");
    assert.ok(!captured.includes("\x1b"), "raw ESC byte must never reach stdout");
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(captured), "no other C0/C1 control bytes may reach stdout");
    assert.ok(captured.length < 260, `stdout output must be length-capped, got ${captured.length} chars`);
  } finally {
    globalThis.fetch = realFetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = realWrite;
  }
});

test("cmdLogin (--username/--password): a malicious server `reason` cannot survive into the process's stderr output", async () => {
  const realFetch = globalThis.fetch;
  const realWrite = process.stderr.write.bind(process.stderr);
  const evilReason = "\x1b]52;c;ZXZpbA==\x07" + "B".repeat(300);
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ authenticated: false, reason: evilReason }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  let captured = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: unknown): boolean => {
    captured += String(chunk);
    return true;
  };
  try {
    const code = await cmdLogin(fakeCtx(), { username: "u", password: "p" });
    assert.equal(code, 1, "headless login must fail (exit 1) for a rejected login");
    assert.ok(captured.length > 0, "the failure message must still be reported");
    assert.ok(!captured.includes("\x1b"), "raw ESC byte must never reach stderr");
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(captured), "no other C0/C1 control bytes may reach stderr");
    assert.ok(captured.length < 260, `stderr output must be length-capped, got ${captured.length} chars`);
  } finally {
    globalThis.fetch = realFetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = realWrite;
  }
});

// ── LOOP-06 round 3: every cmdLogin catch block must go through the shared
// formatErrorLine/errorHint convention (chat.ts's printError, render.ts's
// Renderer.error) instead of a hand-built, unstyled `✗ <message>` template
// string with no hint and no /doctor pointer. ──

test("cmdLogin (--username/--password): a network failure prints the shared formatErrorLine glyph + a /doctor hint", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }) as typeof fetch;
  const stderr = captureStderr();
  try {
    const code = await cmdLogin(fakeCtx(), { username: "u", password: "p" });
    assert.equal(code, 1);
    const out = stderr.text();
    assert.match(out, /✗/, "must use formatErrorLine's glyph, not a bare template string");
    assert.match(out, /\/doctor/, "a network failure must surface errorHint's /doctor pointer");
    assert.match(out, /\n\n$/, "formatErrorLine's trailing blank-line separator must be present");
  } finally {
    globalThis.fetch = realFetch;
    stderr.restore();
  }
});

test("cmdLogin (device-code flow): a network failure requesting the device code prints the shared glyph + hint", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }) as typeof fetch;
  const stderr = captureStderr();
  try {
    const code = await cmdLogin(fakeCtxWithApi(), { noBrowser: true });
    assert.equal(code, 1);
    const out = stderr.text();
    assert.match(out, /✗/, "must use formatErrorLine's glyph, not a bare template string");
    assert.match(out, /could not start login/);
    assert.match(out, /\/doctor/, "a network failure must surface errorHint's /doctor pointer");
  } finally {
    globalThis.fetch = realFetch;
    stderr.restore();
  }
});

test("cmdLogin (device-code flow): a denied authorization still gets the styled ✗ treatment (no hint to show)", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("/auth/device/code")) {
      return new Response(
        JSON.stringify({
          device_code: "dc1",
          user_code: "ABCD",
          verification_uri: "https://x.example/device",
          verification_uri_complete: "https://x.example/device?c=1",
          interval: 0,
          expires_in: 30,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("/auth/device/token")) {
      return new Response(JSON.stringify({ error: "access_denied" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as typeof fetch;
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (): boolean => true; // silence the "To sign in, open:..." prompt noise
  const stderr = captureStderr();
  try {
    const code = await cmdLogin(fakeCtxWithApi(), { noBrowser: true });
    assert.equal(code, 1);
    const out = stderr.text();
    assert.match(out, /✗/, "must use formatErrorLine's glyph, not a bare template string");
    assert.match(out, /authorization denied/);
    assert.doesNotMatch(out, /⤷/, "a plain 'denied' error has no errorHint-derived hint to show");
  } finally {
    globalThis.fetch = realFetch;
    process.stdout.write = realStdoutWrite;
    stderr.restore();
  }
});

test("cmdLogin reports an unavailable browser and continues with the printed device URL", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const value = String(url);
    if (value.includes("/auth/device/code")) {
      return new Response(JSON.stringify({
        device_code: "dc-browser",
        user_code: "BROW-SER",
        verification_uri: "https://x.example/device",
        verification_uri_complete: "https://x.example/device?code=BROW-SER",
        interval: 0,
        expires_in: 30,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("/auth/device/token")) {
      return new Response(JSON.stringify({ access_token: "aek_browser_fallback" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch in test: ${value}`);
  }) as typeof fetch;
  const ctx = fakeCtxWithApi();
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  let stdout = "";
  process.stdout.write = ((chunk: unknown) => ((stdout += String(chunk)), true)) as typeof process.stdout.write;
  const stderr = captureStderr();
  try {
    const code = await cmdLogin(ctx, {}, {
      openBrowser: () => ({ status: "unavailable", detail: "synthetic headless session" }),
    });
    assert.equal(code, 0);
    assert.match(stdout, /https:\/\/x\.example\/device/);
    assert.match(stdout, /BROW-SER/);
    assert.match(stderr.text(), /Browser was not opened \(unavailable\)/);
    assert.match(stderr.text(), /aether auth login --no-browser/);
    assert.equal(await ctx.tokens.get(), "aek_browser_fallback");
  } finally {
    globalThis.fetch = realFetch;
    process.stdout.write = realStdoutWrite;
    stderr.restore();
  }
});
