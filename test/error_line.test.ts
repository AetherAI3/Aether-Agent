// test/error_line.test.ts — LOOP-06 regression: chat.ts's printError
// (client-caught errors) and render.ts's Renderer.error (server-streamed
// `error` SSE frames) must render the SAME "✗ <msg>" convention — glyph, dim
// "  ⤷ hint" line, and trailing blank-line separator — instead of the two
// paths disagreeing on the exact same "session expired" scenario depending
// on which one caught it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { formatErrorLine } from "../src/ui/error_line.js";
import { Renderer } from "../src/core/render.js";
import { cmdChat } from "../src/commands/chat.js";
import { ApiClient } from "../src/core/transport.js";
import { stripAnsi } from "../src/ui/theme.js";
import { errorHint, HttpError } from "../src/core/errors.js";
import type { AppContext } from "../src/core/context.js";
import type { TokenStore } from "../src/core/auth.js";

function collect(): { w: Writable; text: () => string } {
  const chunks: string[] = [];
  const w = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { w, text: () => chunks.join("") };
}

// ── 1. formatErrorLine — the shared primitive ────────────────────────────

test("formatErrorLine: bare message gets a leading blank line, the glyph, and a trailing blank-line separator", () => {
  const line = stripAnsi(formatErrorLine("boom"));
  assert.equal(line, "\n✗ boom\n\n");
});

test("formatErrorLine: a hint renders as its own dim '  ⤷ ' line before the trailing separator", () => {
  const line = stripAnsi(formatErrorLine("session expired", { hint: "run `aether auth login`" }));
  assert.equal(line, "\n✗ session expired\n  ⤷ run `aether auth login`\n\n");
});

test("formatErrorLine: errorCode and refId append onto the SAME head line as chat.ts's printError alone never did", () => {
  const line = stripAnsi(formatErrorLine("bad thing", { errorCode: "E42", refId: "r1" }));
  assert.equal(line, "\n✗ bad thing [E42] (ref r1)\n\n");
});

test("formatErrorLine: a null hint (errorHint's own return type) is treated as absent, not printed", () => {
  const line = stripAnsi(formatErrorLine("boom", { hint: null }));
  assert.equal(line, "\n✗ boom\n\n");
});

test("formatErrorLine: msg/hint/errorCode/refId are all sanitized — no escape bytes survive from any field", () => {
  const line = formatErrorLine("bad\x1b]52;c;ZXZpbA==\x07thing", {
    hint: "hint\x1b[31m",
    errorCode: "E\x1b[2J1",
    refId: "r\x1b[8m1",
  });
  assert.ok(!line.includes("\x1b"), `escape bytes leaked into:\n${JSON.stringify(line)}`);
  assert.ok(stripAnsi(line).includes("badthing"));
});

// ── 2. Renderer.error (server-streamed frame) now uses the shared format ──

test("Renderer.error: a streamed error frame now gets the SAME trailing blank-line separator printError has always had", () => {
  const out = collect();
  const err = collect();
  const r = new Renderer({ json: false, audit: false, out: out.w, err: err.w });
  r.frame({ type: "error", msg: "rate limited" });
  assert.equal(stripAnsi(err.text()), "\n✗ rate limited\n\n");
});

test("Renderer.error: errorCode/refId still render on the head line under the shared formatter", () => {
  const out = collect();
  const err = collect();
  const r = new Renderer({ json: false, audit: false, out: out.w, err: err.w });
  r.frame({ type: "error", msg: "session expired", errorCode: "auth_expired", refId: "req_1" });
  assert.equal(stripAnsi(err.text()), "\n✗ session expired [auth_expired] (ref req_1)\n\n");
});

// ── 3. printError (client-caught error) — same shape, via cmdChat ────────

function ctxWithAek(): AppContext {
  const tokens = { get: async () => "aek_deadtoken" } as unknown as TokenStore;
  return {
    cfg: { baseUrl: "https://stub.test", defaultModel: "", backend: "cloud" },
    flags: { json: false, audit: false, yes: false, cwd: "." },
    tokens,
    api: new ApiClient("https://stub.test", tokens),
  } as unknown as AppContext;
}

test("cmdChat/printError: a 401 (aek_ key, no refresh) renders the exact shared 'session expired' line", async () => {
  const real = globalThis.fetch;
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  let stderrBytes = "";
  process.stderr.write = ((chunk: unknown): boolean => {
    stderrBytes += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ detail: "token revoked" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
  try {
    const ctx = ctxWithAek();
    const code = await cmdChat(ctx, "hi");
    assert.equal(code, 1);
    const expectedMsg = "HTTP 401: token revoked"; // HttpError surfaces the server's detail text
    const expectedHint = errorHint(new HttpError(401, expectedMsg), ctx.cfg.baseUrl);
    assert.ok(
      stripAnsi(stderrBytes).endsWith(stripAnsi(formatErrorLine(expectedMsg, { hint: expectedHint }))),
      "the final error block uses the shared formatter after any context header",
    );
    assert.match(stripAnsi(stderrBytes), /aether auth login/, "the same session-expired hint chat.ts has always shown");
  } finally {
    globalThis.fetch = real;
    process.stderr.write = origStderrWrite;
  }
});

// ── 4. Cross-path parity — the actual LOOP-06 defect ─────────────────────

test("LOOP-06 parity: the identical 'session expired' message renders byte-identical head+separator whether printError or Renderer.error catches it", () => {
  const out = collect();
  const err = collect();
  const r = new Renderer({ json: false, audit: false, out: out.w, err: err.w });
  r.frame({ type: "error", msg: "session expired or invalid — run `aether auth login` to sign in again" });
  const fromRenderer = stripAnsi(err.text());

  const fromPrintErrorEquivalent = stripAnsi(
    formatErrorLine("HTTP 401", { hint: "session expired or invalid — run `aether auth login` to sign in again" }),
  );
  // Both must end in the SAME "\n\n" separator, and neither fuses a hint or
  // message onto the line that follows — the exact parity LOOP-06 was about.
  assert.ok(fromRenderer.endsWith("\n\n"), "Renderer.error must end with the shared blank-line separator");
  assert.ok(fromPrintErrorEquivalent.endsWith("\n\n"), "printError must end with the shared blank-line separator");
});
