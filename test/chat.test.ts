import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, cmdChat, ChatTurnError, applyRestart, buildPromptContext, repaintString } from "../src/commands/chat.js";
import { handleSlash } from "../src/commands/slash.js";
import { ApiClient } from "../src/core/transport.js";
import { MeaningfulProgressTimeoutError, StreamIncompleteError } from "../src/core/errors.js";
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

test("heartbeat-only SSE is cancelled by the meaningful-progress watchdog", async () => {
  const real = globalThis.fetch;
  const previous = process.env["AETHER_STREAM_TIMEOUT_MS"];
  process.env["AETHER_STREAM_TIMEOUT_MS"] = "20";
  let returned = false;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: (async function* (): AsyncIterable<Uint8Array> {
      try {
        for (;;) {
          yield new TextEncoder().encode('data: {"type":"ping"}\n\n');
          await new Promise<void>((resolve) => setTimeout(resolve, 2));
        }
      } finally {
        returned = true;
      }
    })(),
  }) as unknown as Response) as typeof globalThis.fetch;
  try {
    await assert.rejects(
      () => runTurn(ctxWith(), "keep this prompt"),
      (error: unknown) =>
        error instanceof MeaningfulProgressTimeoutError &&
        /request was cancelled.*prompt is safe to retry.*aether doctor/i.test(error.message),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(returned, true, "timeout returns the underlying iterator and releases the stream");
  } finally {
    globalThis.fetch = real;
    if (previous === undefined) delete process.env["AETHER_STREAM_TIMEOUT_MS"];
    else process.env["AETHER_STREAM_TIMEOUT_MS"] = previous;
  }
});

test("empty deltas and unchanged usage cannot evade the meaningful-progress watchdog", async () => {
  const real = globalThis.fetch;
  const previous = process.env["AETHER_STREAM_TIMEOUT_MS"];
  process.env["AETHER_STREAM_TIMEOUT_MS"] = "20";
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: (async function* (): AsyncIterable<Uint8Array> {
      for (;;) {
        yield new TextEncoder().encode(
          'data: {"type":"delta","text":""}\n\n' +
          'data: {"type":"usage","uvt":7,"cents":1}\n\n',
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
    })(),
  }) as unknown as Response) as typeof globalThis.fetch;
  try {
    const ctx = ctxWith();
    ctx.flags.json = false;
    await assert.rejects(() => runTurn(ctx, "preserve me"), MeaningfulProgressTimeoutError);
  } finally {
    globalThis.fetch = real;
    if (previous === undefined) delete process.env["AETHER_STREAM_TIMEOUT_MS"];
    else process.env["AETHER_STREAM_TIMEOUT_MS"] = previous;
  }
});

test("alternating cosmetic progress and regressing usage cannot evade the watchdog", async () => {
  const real = globalThis.fetch;
  const previous = process.env["AETHER_STREAM_TIMEOUT_MS"];
  process.env["AETHER_STREAM_TIMEOUT_MS"] = "20";
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: (async function* (): AsyncIterable<Uint8Array> {
      let high = false;
      for (;;) {
        high = !high;
        yield new TextEncoder().encode(
          `data: ${JSON.stringify({ type: "progress", text: high ? "waiting A" : "waiting B" })}\n\n` +
          `data: ${JSON.stringify({ type: "usage", uvt: high ? 1 : 0, cents: 0 })}\n\n`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
    })(),
  }) as unknown as Response) as typeof globalThis.fetch;
  try {
    await assert.rejects(() => runTurn(ctxWith(), "bounded cosmetic cycle"), MeaningfulProgressTimeoutError);
  } finally {
    globalThis.fetch = real;
    if (previous === undefined) delete process.env["AETHER_STREAM_TIMEOUT_MS"];
    else process.env["AETHER_STREAM_TIMEOUT_MS"] = previous;
  }
});

test("a sustained repeated text loop cannot keep a cloud turn alive", async () => {
  const real = globalThis.fetch;
  const previous = process.env["AETHER_STREAM_TIMEOUT_MS"];
  process.env["AETHER_STREAM_TIMEOUT_MS"] = "20";
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: (async function* (): AsyncIterable<Uint8Array> {
      for (;;) {
        yield new TextEncoder().encode('data: {"type":"delta","text":"again"}\n\n');
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
    })(),
  }) as unknown as Response) as typeof globalThis.fetch;
  try {
    await assert.rejects(() => runTurn(ctxWith(), "bounded repeated answer"), MeaningfulProgressTimeoutError);
  } finally {
    globalThis.fetch = real;
    if (previous === undefined) delete process.env["AETHER_STREAM_TIMEOUT_MS"];
    else process.env["AETHER_STREAM_TIMEOUT_MS"] = previous;
  }
});

test("a TTY cloud turn reports silence after partial text and clears the timer on completion", async () => {
  const real = globalThis.fetch;
  const previous = process.env["AETHER_STREAM_SILENCE_NOTICE_MS"];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origTTY = process.stderr.isTTY;
  process.env["AETHER_STREAM_SILENCE_NOTICE_MS"] = "12";
  (process.stderr as unknown as { isTTY: boolean }).isTTY = true;
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: unknown) => ((stdout += String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => ((stderr += String(chunk)), true)) as typeof process.stderr.write;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: (async function* (): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode('data: {"type":"delta","text":"partial"}\n\n');
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      yield new TextEncoder().encode('data: {"type":"done","uvt":1,"cents":0}\n\n');
    })(),
  }) as unknown as Response) as typeof globalThis.fetch;
  try {
    const ctx = ctxWith();
    ctx.flags.json = false;
    await runTurn(ctx, "answer slowly");
    assert.match(stderr, /Still waiting for the model/);
    assert.match(stdout, /partial/);
    const count = (stderr.match(/Still waiting for the model/g) ?? []).length;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal((stderr.match(/Still waiting for the model/g) ?? []).length, count);
  } finally {
    globalThis.fetch = real;
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    (process.stderr as unknown as { isTTY: boolean | undefined }).isTTY = origTTY;
    if (previous === undefined) delete process.env["AETHER_STREAM_SILENCE_NOTICE_MS"];
    else process.env["AETHER_STREAM_SILENCE_NOTICE_MS"] = previous;
  }
});

test("aborting after partial cloud text clears the pending silence notice", async () => {
  const real = globalThis.fetch;
  const previous = process.env["AETHER_STREAM_SILENCE_NOTICE_MS"];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origTTY = process.stderr.isTTY;
  process.env["AETHER_STREAM_SILENCE_NOTICE_MS"] = "25";
  (process.stderr as unknown as { isTTY: boolean }).isTTY = true;
  let stderr = "";
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => ((stderr += String(chunk)), true)) as typeof process.stderr.write;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: (async function* (): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode('data: {"type":"delta","text":"partial"}\n\n');
      await new Promise<void>(() => {});
    })(),
  }) as unknown as Response) as typeof globalThis.fetch;
  try {
    const controller = new AbortController();
    const ctx = ctxWith();
    ctx.flags.json = false;
    const pending = runTurn(ctx, "abort a stalled answer", controller.signal);
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    assert.doesNotMatch(stderr, /Still waiting for the model/);
  } finally {
    globalThis.fetch = real;
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    (process.stderr as unknown as { isTTY: boolean | undefined }).isTTY = origTTY;
    if (previous === undefined) delete process.env["AETHER_STREAM_SILENCE_NOTICE_MS"];
    else process.env["AETHER_STREAM_SILENCE_NOTICE_MS"] = previous;
  }
});

test("legacy fallback sanitizes TTY output and reports unknown usage truthfully", async () => {
  const realFetch = globalThis.fetch;
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let calls = 0;
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: unknown) => (stdout += String(chunk), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => (stderr += String(chunk), true)) as typeof process.stderr.write;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json({ stream: false });
    }
    return Response.json({
      response: "safe\u001b]52;c;clipboard\u0007 answer",
      commitment_hash: "hash\u001b[2J",
    });
  }) as typeof globalThis.fetch;
  try {
    const ctx = ctxWith();
    ctx.flags.json = false;
    ctx.flags.audit = true;
    const outcome = await runTurn(ctx, "hi");
    assert.equal(outcome.state, "succeeded");
    assert.match(stdout, /safe answer/);
    assert.doesNotMatch(stdout + stderr, /[\u001b\u0007]/);
    assert.match(stderr, /UVT usage unknown/i);
  } finally {
    globalThis.fetch = realFetch;
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
});

test("legacy JSON fallback emits only parseable NDJSON frames and a terminal outcome", async () => {
  const realFetch = globalThis.fetch;
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let calls = 0;
  let stdout = "";
  process.stdout.write = ((chunk: unknown) => (stdout += String(chunk), true)) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1
      ? Response.json({ stream: false })
      : Response.json({ response: "structured answer" });
  }) as typeof globalThis.fetch;
  try {
    const exit = await cmdChat(ctxWith(), "hi");
    assert.equal(exit, 0);
    const frames = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(frames.map((frame) => frame["type"]), ["delta", "done", "turn_outcome"]);
    assert.equal(frames[1]?.["usageKnown"], false);
    assert.equal(frames[2]?.["state"], "succeeded");
  } finally {
    globalThis.fetch = realFetch;
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
});

test("/voice uses the operator rail and keeps output inside the REPL sink", async () => {
  const out: string[] = [];
  const res = await handleSlash(fakeCtx(), "/voice status", { write: (s: string) => out.push(s) } as never);
  assert.equal(res.exit, false);
  assert.match(out.join(""), /AETHER VOICE/);
  assert.match(out.join(""), /default-off/);
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
