import { test } from "node:test";
import assert from "node:assert/strict";
import { cmdChat, runTurn, ChatTurnError, applyRestart, buildPromptContext, repaintString } from "../src/commands/chat.js";
import { handleSlash } from "../src/commands/slash.js";
import { ApiClient } from "../src/core/transport.js";
import { StreamIncompleteError } from "../src/core/errors.js";
import { STREAM_ERROR_NO_DETAILS } from "../src/core/stream.js";
import type { GlobalFlags, AppContext } from "../src/core/context.js";
import type { TokenStore } from "../src/core/auth.js";

const tokens = { get: async () => "aek_t" } as unknown as TokenStore;

function sseFetch(events: string[]): typeof globalThis.fetch {
  const body = events.map((e) => `data: ${e}\n\n`).join("");
  return (async () => {
    const bytes = new TextEncoder().encode(body);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: (async function* (): AsyncIterable<Uint8Array> {
        yield bytes;
      })(),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
}

function ctxWith(): AppContext {
  return {
    cfg: {
      baseUrl: "https://stub.test",
      defaultModel: "",
      permissionMode: "ask",
      autoApply: false,
      telemetry: false,
      defaultEffort: "",
      backend: "cloud", // pin cloud so resolveBackend doesn't probe a local Ollama in CI
    },
    flags: { json: true, audit: false, yes: false, cwd: "." }, // json:true keeps stdout output quiet
    tokens,
    api: new ApiClient("https://stub.test", tokens),
  } as unknown as AppContext;
}

// runTurn is void+onFrame (orchestrator-shaped, see resolveBackend/runCloudTurn
// in chat.ts); a streamed `error` frame is signaled by throwing ChatTurnError
// rather than a boolean return, since the Renderer already paints the "✗ msg"
// line before runTurn can return control to the caller (CONTRACTS.md: a
// rendered error is not the same as a successful turn).
test("runTurn throws ChatTurnError when the server streams an error frame", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = sseFetch([
    JSON.stringify({ type: "delta", text: "partial" }),
    JSON.stringify({ type: "error", msg: "rate limited" }),
  ]);
  try {
    await assert.rejects(() => runTurn(ctxWith(), "hi"), ChatTurnError);
  } finally {
    globalThis.fetch = real;
  }
});

test("one-shot chat exits nonzero and renders the public error field or a fallback even when done follows", async () => {
  const realFetch = globalThis.fetch;
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: unknown): boolean => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    for (const { wire, expected } of [
      { wire: { type: "error" }, expected: STREAM_ERROR_NO_DETAILS },
      { wire: { type: "error", msg: "   " }, expected: STREAM_ERROR_NO_DETAILS },
      { wire: { type: "error", error: "The media studio agent hit an error.", reason: "private internal reason" }, expected: "The media studio agent hit an error." },
    ]) {
      stderr = "";
      globalThis.fetch = sseFetch([
        JSON.stringify(wire),
        JSON.stringify({ type: "done", uvt: 0, cents: 0 }),
      ]);
      const ctx = ctxWith();
      ctx.flags.json = false;
      assert.equal(await cmdChat(ctx, "just testing reply 1"), 1);
      assert.ok(stderr.includes(`✗ ${expected}`));
      assert.doesNotMatch(stderr, /\n✗\s*\n/, "the operator must not see a bare error glyph");
      assert.doesNotMatch(stderr, /private internal reason/, "the private reason must not reach the terminal");
    }
  } finally {
    globalThis.fetch = realFetch;
    process.stderr.write = realStderrWrite;
  }
});

test("runTurn resolves cleanly on a clean stream", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = sseFetch([
    JSON.stringify({ type: "delta", text: "ok" }),
    JSON.stringify({ type: "done", uvt: 1, cents: 0 }),
  ]);
  try {
    await runTurn(ctxWith(), "hi"); // must not throw
  } finally {
    globalThis.fetch = real;
  }
});

// LOOP-06 round 3: a stream that ends after only `delta` frames (no `done`,
// no `error` — e.g. a proxy/load-balancer time-boxing the SSE response and
// closing the socket within the idle window) must NOT be treated as a
// successful turn. decodeSse's for-await loop exits normally on a plain
// end-of-stream, so without an explicit terminal-frame check runTurn used to
// resolve as if the turn had completed cleanly.
test("runTurn throws StreamIncompleteError when the stream ends with only delta frames (no done/error)", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = sseFetch([JSON.stringify({ type: "delta", text: "partial" })]);
  try {
    await assert.rejects(() => runTurn(ctxWith(), "hi"), StreamIncompleteError);
  } finally {
    globalThis.fetch = real;
  }
});

// LOOP-01/LOOP-06 round-1 regression: request()'s new bounded-by-default
// timeout (AETHER_REQUEST_TIMEOUT_MS, 30s) must NOT apply to the
// non-streaming CHAT_PATH fallback — a full LLM turn can legitimately run
// long, so chat.ts opts that call into stream()'s own generous bound instead.
test("runTurn's non-streaming fallback survives a response slower than the metadata-call timeout default", async () => {
  const real = globalThis.fetch;
  const ENV_KEY = "AETHER_REQUEST_TIMEOUT_MS";
  const prevEnv = process.env[ENV_KEY];
  process.env[ENV_KEY] = "5"; // far shorter than the fallback response's own delay below
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    if (call === 1) {
      // Streaming leg: server signals fail-soft `{"stream": false}`.
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ stream: false }),
      } as unknown as Response;
    }
    // Fallback leg: deliberately slower than the 5ms metadata-call default —
    // this only survives because chat.ts opts into defaultStreamTimeoutMs().
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ response: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    await runTurn(ctxWith(), "hi"); // must not throw/time out
    assert.equal(call, 2, "both the streaming leg and the fallback leg were called");
  } finally {
    globalThis.fetch = real;
    if (prevEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prevEnv;
  }
});

test("applyRestart sets the new model and clears the agent", () => {
  const flags = { model: "haiku", agent: "neo", json: false, audit: false, yes: false, cwd: "." } as GlobalFlags;
  applyRestart(flags, { model: "opus" });
  assert.equal(flags.model, "opus");
  assert.equal(flags.agent, undefined);
});

// Regression: the thinking pulse is presentation-only, like every other
// status/diagnostic writer in this codebase (StatusRenderer, HostRenderer's
// status/telemetry). It must target stderr so stdout stays byte-identical
// for redirection/piping — even when stdout is a still-TTY sink (script(1),
// pty recorders). A prior merge resolution accidentally routed it to stdout.
test("interactive TTY chat pulse writes only to stderr, never stdout", async () => {
  const real = globalThis.fetch;
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origStdoutIsTTY = process.stdout.isTTY;
  const origStderrIsTTY = process.stderr.isTTY;

  let stdoutBytes = "";
  let stderrBytes = "";
  (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
  (process.stderr as unknown as { isTTY: boolean }).isTTY = true;
  process.stdout.write = ((chunk: unknown): boolean => {
    stdoutBytes += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    stderrBytes += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  globalThis.fetch = sseFetch([
    JSON.stringify({ type: "delta", text: "ok" }),
    JSON.stringify({ type: "done", uvt: 1, cents: 0 }),
  ]);
  try {
    const ctx = ctxWith();
    ctx.flags.json = false; // json:true would suppress the pulse entirely; must be off to exercise it
    await runTurn(ctx, "hi");
    assert.doesNotMatch(stdoutBytes, /thinking/, "pulse frames must never reach stdout");
  } finally {
    globalThis.fetch = real;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = origStdoutIsTTY;
    (process.stderr as unknown as { isTTY: boolean | undefined }).isTTY = origStderrIsTTY;
  }
  void stderrBytes; // presence on stderr is covered by thinking.test.ts; this test's contract is "never on stdout"
});

test("applyRestart sets the new agent and clears the model", () => {
  const flags = { model: "haiku", agent: undefined, json: false, audit: false, yes: false, cwd: "." } as GlobalFlags;
  applyRestart(flags, { agent: "kronus" });
  assert.equal(flags.agent, "kronus");
  assert.equal(flags.model, undefined);
});

// ── /steer passthrough in handleSlash ──

test("/steer shows handled-in-REPL message", async () => {
  const out: string[] = [];
  const res = await handleSlash(fakeCtx(), "/steer use typescript", { write: (s: string) => out.push(s) } as never);
  assert.equal(res.exit, false);
  assert.match(out.join(""), /is handled directly in the interactive REPL/i);
});

// ── /btw passthrough in handleSlash ──

test("/btw shows handled-in-REPL message", async () => {
  const out: string[] = [];
  const res = await handleSlash(fakeCtx(), "/btw auth was refactored", { write: (s: string) => out.push(s) } as never);
  assert.equal(res.exit, false);
  assert.match(out.join(""), /is handled directly in the interactive REPL/i);
});

// ── /queue passthrough in handleSlash ──

test("/queue shows handled-in-REPL message", async () => {
  const out: string[] = [];
  const res = await handleSlash(fakeCtx(), "/queue fix login bug", { write: (s: string) => out.push(s) } as never);
  assert.equal(res.exit, false);
  assert.match(out.join(""), /is handled directly in the interactive REPL/i);
});

// ── /writing-plans passthrough in handleSlash ──

test("/writing-plans shows handled-in-REPL message", async () => {
  const out: string[] = [];
  const res = await handleSlash(fakeCtx(), "/writing-plans auth module", { write: (s: string) => out.push(s) } as never);
  assert.equal(res.exit, false);
  assert.match(out.join(""), /is handled directly in the interactive REPL/i);
});

// ── /subagent-driven-execution passthrough in handleSlash ──

test("/subagent-driven-execution shows handled-in-REPL message", async () => {
  const out: string[] = [];
  const res = await handleSlash(fakeCtx(), "/subagent-driven-execution refactor auth", { write: (s: string) => out.push(s) } as never);
  assert.equal(res.exit, false);
  assert.match(out.join(""), /is handled directly in the interactive REPL/i);
});

// ── buildPromptContext ──

test("buildPromptContext returns base prompt unchanged when no context", () => {
  const result = buildPromptContext("fix the bug", null, []);
  assert.equal(result.prompt, "fix the bug");
  assert.equal(result.steering, null);
  assert.deepEqual(result.btwNotes, []);
});

test("buildPromptContext prepends STEERING before the base prompt", () => {
  const result = buildPromptContext("fix the bug", "use TypeScript interfaces", []);
  assert.equal(result.prompt, "STEERING: use TypeScript interfaces\n\nfix the bug");
  assert.equal(result.steering, null); // cleared after use
  assert.deepEqual(result.btwNotes, []);
});

test("buildPromptContext prepends NOTE before the base prompt", () => {
  const result = buildPromptContext("fix the bug", null, ["auth refactored", "db is postgres 16"]);
  assert.equal(result.prompt, "NOTE: auth refactored; db is postgres 16\n\nfix the bug");
  assert.equal(result.steering, null);
  assert.deepEqual(result.btwNotes, []); // cleared after use
});

test("buildPromptContext combines steering and btw notes in correct order", () => {
  const result = buildPromptContext("fix the login bug", "use TypeScript", ["auth refactored", "db is postgres 16"]);
  // Steering first, then notes, then user prompt
  assert.equal(
    result.prompt,
    "STEERING: use TypeScript\nNOTE: auth refactored; db is postgres 16\n\nfix the login bug",
  );
  assert.equal(result.steering, null);
  assert.deepEqual(result.btwNotes, []);
});

test("buildPromptContext clears steering after a single use (single-shot)", () => {
  const result = buildPromptContext("task one", "guidance one", []);
  assert.equal(result.steering, null);
  // Second call with no new steering should return no steering
  const result2 = buildPromptContext("task two", null, []);
  assert.equal(result2.steering, null);
  assert.equal(result2.prompt, "task two");
});

test("buildPromptContext clears btwNotes after a single use (single-shot)", () => {
  const result = buildPromptContext("task one", null, ["note one"]);
  assert.deepEqual(result.btwNotes, []);
  // Second call with empty notes should stay empty
  const result2 = buildPromptContext("task two", null, []);
  assert.deepEqual(result2.btwNotes, []);
  assert.equal(result2.prompt, "task two");
});

// ── repaintString ──

test("repaintString clears the row, draws the view, and places the caret", () => {
  const s = repaintString("> ", "abc", 1, 40);
  assert.ok(s.startsWith("\r\x1b[2K"));
  assert.ok(s.includes("> abc"));
  assert.ok(s.endsWith("\x1b[4G")); // 2 prompt cols + 1 char + 1
});

test("repaintString keeps the caret on-row for overflowing input", () => {
  const s = repaintString("> ", "x".repeat(200), 200, 30);
  const col = Number(/\x1b\[(\d+)G$/.exec(s)![1]);
  assert.ok(col <= 30);
});

// ── helpers ──

function fakeCtx(): AppContext {
  return {
    flags: { yes: false, json: false, audit: false, cwd: "." },
    cfg: { defaultModel: "haiku", baseUrl: "x" },
    api: {},
    confirm: async () => true,
  } as unknown as AppContext;
}
