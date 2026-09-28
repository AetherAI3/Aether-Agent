import { test } from "node:test";
import assert from "node:assert/strict";

import { ChatTurnError, cmdChat, runLocalTurn, runTurn } from "../src/commands/chat.js";
import type { Brain, TaskCommand } from "../src/core/brain.js";
import type { BrainEvent } from "../src/core/brain_protocol.js";
import type { TokenStore } from "../src/core/auth.js";
import type { AppContext } from "../src/core/context.js";
import { resetRegistry } from "../src/core/context_registry.js";
import { StreamIncompleteError } from "../src/core/errors.js";
import type { ToolResult } from "../src/core/tool_executor.js";
import { ApiClient } from "../src/core/transport.js";
import {
  TURN_STATES,
  TurnAlreadyFinalizedError,
  TurnLifecycle,
  TurnTransitionError,
  recoverSubmittedPrompt,
} from "../src/core/turn_lifecycle.js";

const tokens = { get: async () => "aek_test" } as unknown as TokenStore;

function cloudContext(json = false): AppContext {
  return {
    cfg: {
      baseUrl: "https://stub.test",
      defaultModel: "",
      permissionMode: "ask",
      autoApply: false,
      telemetry: false,
      defaultEffort: "",
      backend: "cloud",
    },
    flags: { json, audit: false, yes: false, cwd: "." },
    tokens,
    api: new ApiClient("https://stub.test", tokens),
  } as unknown as AppContext;
}

function localContext(): AppContext {
  return {
    cfg: {
      baseUrl: "https://stub.test",
      permissionMode: "skip",
      autoApply: true,
      localModel: "",
    },
    flags: { json: true, audit: false, yes: true, cwd: ".", local: true },
    confirm: async () => true,
  } as unknown as AppContext;
}

function sseResponse(events: readonly Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function captureWrites<T>(body: () => Promise<T>): Promise<{ value: T; stdout: string; stderr: string }> {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: unknown): boolean => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await body(), stdout, stderr };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

test("turn lifecycle exposes the complete typed state vocabulary", () => {
  assert.deepEqual(TURN_STATES, [
    "idle",
    "submitted",
    "connecting",
    "streaming",
    "waiting_for_tool",
    "completing",
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "incomplete",
  ]);
});

test("turn lifecycle keeps a stable id and rejects double finalization", () => {
  const times = [100, 110, 120, 130, 140];
  const lifecycle = new TurnLifecycle("keep this prompt", {
    id: "turn-fixed",
    now: () => times.shift() ?? 140,
  });
  lifecycle.transition("submitted");
  lifecycle.transition("connecting");
  lifecycle.transition("completing");
  const outcome = lifecycle.finalize("succeeded", { message: "complete" });

  assert.equal(outcome.turnId, "turn-fixed");
  assert.equal(outcome.prompt, "keep this prompt");
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.finishedAt, 140);
  assert.equal(outcome.lastMeaningfulActivityAt, 130, "finalization is not meaningful progress");
  assert.throws(
    () => lifecycle.finalize("failed", { message: "late error" }),
    TurnAlreadyFinalizedError,
  );
  assert.equal(lifecycle.outcome?.state, "succeeded", "the first terminal outcome remains authoritative");
});

test("turn lifecycle rejects an invalid transition without mutating state", () => {
  const lifecycle = new TurnLifecycle("prompt", { id: "turn-invalid", now: () => 1 });
  assert.throws(() => lifecycle.transition("streaming"), TurnTransitionError);
  assert.equal(lifecycle.state, "idle");
  assert.equal(lifecycle.outcome, null);
});

test("turn lifecycle resumes an active snapshot without changing identity or clocks", () => {
  const original = new TurnLifecycle("same prompt", { id: "turn-remount", now: () => 100 });
  original.transition("submitted", 110);
  original.transition("connecting", 120);
  original.transition("streaming", 130);
  const snapshot = original.snapshot();

  const resumed = new TurnLifecycle("same prompt", {
    id: "turn-remount",
    now: () => 999,
    resume: snapshot,
  });
  assert.deepEqual(resumed.snapshot(), snapshot);
  resumed.transition("completing", 140);
  assert.equal(resumed.finalize("succeeded", { at: 150 }).turnId, "turn-remount");
  assert.equal(original.state, "streaming", "resuming does not mutate the old mount's lifecycle");
});

test("turn lifecycle rejects inconsistent or identity-changing resume snapshots", () => {
  const original = new TurnLifecycle("prompt", { id: "turn-safe", now: () => 10 });
  original.transition("submitted", 20);
  const snapshot = original.snapshot();
  assert.throws(
    () => new TurnLifecycle("different", { resume: snapshot }),
    /does not match the submitted prompt/i,
  );
  assert.throws(
    () => new TurnLifecycle("prompt", { id: "turn-other", resume: snapshot }),
    /does not match the requested correlation id/i,
  );
  assert.throws(
    () => new TurnLifecycle("prompt", {
      resume: { ...snapshot, state: "succeeded", outcome: null },
    }),
    /state\/outcome are inconsistent/i,
  );
});

test("failed submission recovery preserves newer type-ahead", () => {
  assert.equal(recoverSubmittedPrompt("failed prompt", ""), "failed prompt");
  assert.equal(recoverSubmittedPrompt("failed prompt", "newer draft"), "newer draft");
});

test("one-shot 402 before the SSE body is actionable, sanitized, nonzero, and never falls back", async () => {
  resetRegistry();
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ detail: "insufficient UVT balance\u001b]52;c;payload\u0007" }), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  try {
    const result = await captureWrites(() => cmdChat(cloudContext(), "ship this"));
    assert.equal(result.value, 1);
    assert.equal(urls.length, 1, "a payment refusal must not trigger the request/response fallback");
    assert.match(urls[0] ?? "", /\/agent\/chat\/stream$/);
    assert.match(result.stderr, /HTTP 402/i);
    assert.match(result.stderr, /out of UVT balance/i);
    assert.match(result.stderr, /top up|plan/i);
    assert.doesNotMatch(result.stderr, /\u001b\]52/);
    assert.equal(result.stdout, "", "a refusal must not fabricate model output");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("streamed 402 after a partial delta preserves text and adds actionable sanitized guidance", async () => {
  resetRegistry();
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    urls.push(String(input));
    return sseResponse([
      { type: "delta", text: "partial answer" },
      {
        type: "error",
        msg: "balance depleted\u001b]52;c;payload\u0007",
        error_code: "PAYMENT_REQUIRED_402",
      },
    ]);
  }) as typeof globalThis.fetch;
  try {
    const result = await captureWrites(() => cmdChat(cloudContext(), "ship this"));
    assert.equal(result.value, 1);
    assert.equal(urls.length, 1, "a terminal SSE error must not switch transports or backends");
    assert.equal(result.stdout, "partial answer", "only actual streamed model text reaches stdout");
    assert.match(result.stderr, /balance depleted/i);
    assert.match(result.stderr, /out of UVT balance/i);
    assert.match(result.stderr, /top up|plan/i);
    assert.doesNotMatch(result.stderr, /\u001b\]52/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("one-shot fixed legacy media error is visible without exposing reason or trailing done", async () => {
  resetRegistry();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return sseResponse([
      { type: "error", error: "The media studio agent hit an error.", reason: "internal detail" },
      { type: "done", uvt: 0, cents: 0 },
    ]);
  }) as typeof globalThis.fetch;
  try {
    const result = await captureWrites(() => cmdChat(cloudContext(), "ship this"));
    assert.equal(result.value, 1);
    assert.equal(calls, 1, "a terminal error must not retry or switch transports");
    assert.match(result.stderr, /The media studio agent hit an error\./);
    assert.doesNotMatch(result.stderr, /internal detail|0 UVT/i);
    assert.equal(result.stdout, "", "an error must not fabricate model output");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("one-shot arbitrary error-key text is hidden while the turn still fails", async () => {
  resetRegistry();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => sseResponse([
    { type: "error", error: "provider token=SECRET\u001b]52;c;payload\u0007", reason: "internal detail" },
    { type: "done", uvt: 0, cents: 0 },
  ])) as typeof globalThis.fetch;
  try {
    const result = await captureWrites(() => cmdChat(cloudContext(), "ship this"));
    assert.equal(result.value, 1);
    assert.match(result.stderr, /turn failed/i);
    assert.doesNotMatch(result.stderr, /SECRET|internal detail|\u001b\]52|0 UVT/i);
    assert.equal(result.stdout, "");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("one-shot blank error frame remains a failed turn with a fallback message", async () => {
  resetRegistry();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => sseResponse([
    { type: "error", msg: "  ", reason: "internal detail" },
    { type: "done", uvt: 0, cents: 0 },
  ])) as typeof globalThis.fetch;
  try {
    const result = await captureWrites(() => cmdChat(cloudContext(), "ship this"));
    assert.equal(result.value, 1);
    assert.match(result.stderr, /turn failed/i);
    assert.doesNotMatch(result.stderr, /internal detail|0 UVT/i);
    assert.equal(result.stdout, "");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("empty-body 402 still gives a visible balance action and a nonzero one-shot result", async () => {
  resetRegistry();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("", { status: 402, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  try {
    const result = await captureWrites(() => cmdChat(cloudContext(), "ship this"));
    assert.equal(result.value, 1);
    assert.equal(calls, 1);
    assert.match(result.stderr, /HTTP 402/i);
    assert.match(result.stderr, /out of UVT balance/i);
    assert.match(result.stderr, /top up|plan/i);
    assert.equal(result.stdout, "");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("JSON/headless 402 emits one structured terminal outcome with no human preamble", async () => {
  resetRegistry();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ detail: "insufficient UVT balance" }, { status: 402 })) as typeof globalThis.fetch;
  try {
    const result = await captureWrites(() => cmdChat(cloudContext(true), "keep my prompt"));
    assert.equal(result.value, 1);
    assert.equal(result.stderr, "");
    const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.["protocol"], "aether.turn/1");
    assert.equal(records[0]?.["type"], "turn_outcome");
    assert.equal(records[0]?.["state"], "failed");
    assert.equal(records[0]?.["exit_code"], 1);
    assert.equal(records[0]?.["prompt_preserved"], true);
    assert.match(String(records[0]?.["hint"]), /top up|plan/i);
    assert.equal("prompt" in (records[0] ?? {}), false, "machine outcome does not duplicate user content");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("JSON/headless success appends the same typed terminal outcome after raw frames", async () => {
  resetRegistry();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse([
      { type: "delta", text: "done" },
      { type: "done", uvt: 1, cents: 0 },
    ])) as typeof globalThis.fetch;
  try {
    const result = await captureWrites(() => cmdChat(cloudContext(true), "ship"));
    assert.equal(result.value, 0);
    assert.equal(result.stderr, "");
    const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.at(-1)?.["type"], "turn_outcome");
    assert.equal(records.at(-1)?.["state"], "succeeded");
    assert.equal(records.at(-1)?.["exit_code"], 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("EOF without a terminal frame preserves partial output and exits nonzero as incomplete", async () => {
  resetRegistry();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => sseResponse([{ type: "delta", text: "partial answer" }])) as typeof globalThis.fetch;
  try {
    const result = await captureWrites(() => cmdChat(cloudContext(), "ship this"));
    assert.equal(result.value, 1);
    assert.equal(result.stdout, "partial answer");
    assert.match(result.stderr, /connection ended before the server finished/i);
    assert.match(result.stderr, /retry|doctor/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an undelimited done at EOF cannot make a headless chat turn succeed", async () => {
  resetRegistry();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    'data: {"type":"delta","text":"partial answer"}\n\ndata: {"type":"done","uvt":1,"cents":0}',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )) as typeof globalThis.fetch;
  try {
    const result = await captureWrites(() => cmdChat(cloudContext(), "ship this"));
    assert.equal(result.value, 1);
    assert.equal(result.stdout, "partial answer");
    assert.match(result.stderr, /connection ended before the server finished/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a successful stream returns its stable succeeded outcome", async () => {
  resetRegistry();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse([
      { type: "delta", text: "done" },
      { type: "done", uvt: 1, cents: 0 },
    ])) as typeof globalThis.fetch;
  try {
    const result = await captureWrites(() => runTurn(cloudContext(true), "keep this prompt"));
    assert.equal(result.value.state, "succeeded");
    assert.equal(result.value.exitCode, 0);
    assert.equal(result.value.prompt, "keep this prompt");
    assert.match(result.value.turnId, /^turn-/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

class EndsWithoutDoneBrain implements Brain {
  run(_task: TaskCommand): AsyncIterable<BrainEvent> {
    return (async function* (): AsyncGenerator<BrainEvent> {
      yield { type: "stage", name: "working", face: "..." };
    })();
  }

  sendToolResult(_id: string, _result: ToolResult): void {}
  control(): void {}
  close(): void {}
}

test("a local brain iterator ending without done fails visibly as incomplete", async () => {
  const brain = new EndsWithoutDoneBrain();
  const result = await captureWrites(async () => {
    await assert.rejects(
      () => runLocalTurn(localContext(), "keep this prompt", undefined, { brain }),
      StreamIncompleteError,
    );
  });
  assert.match(result.stdout, /working|stage/i);
});

test("a streamed error remains a ChatTurnError with its failed lifecycle outcome", async () => {
  resetRegistry();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse([{ type: "error", msg: "insufficient UVT balance", error_code: "402" }])) as typeof globalThis.fetch;
  try {
    const result = await captureWrites(async () => {
      await assert.rejects(
        () => runTurn(cloudContext(), "keep this prompt"),
        (err: unknown) =>
          err instanceof ChatTurnError &&
          err.outcome?.state === "failed" &&
          err.outcome.exitCode === 1 &&
          err.outcome.prompt === "keep this prompt",
      );
    });
    assert.match(result.stderr, /top up|plan/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});
