import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SSE_EVENT_BYTES,
  decodeSse,
  normalizeFrame,
  parseEvent,
  type StreamFrame,
} from "../src/core/stream.js";
import { StreamEventTooLargeError, StreamIncompleteError } from "../src/core/errors.js";

test("normalizeFrame done maps token fields and carries no signature", () => {
  const f = normalizeFrame({
    type: "done",
    uvt: 12,
    cents: 3.4,
    input_tokens: 100,
    output_tokens: 50,
  });
  assert.deepEqual(f, {
    type: "done",
    uvt: 12,
    cents: 3.4,
    inputTokens: 100,
    outputTokens: 50,
  });
});

test("normalizeFrame error uses contract keys msg/error_code/ref_id", () => {
  const f = normalizeFrame({ type: "error", msg: "boom", error_code: "E42", ref_id: "r1" });
  assert.deepEqual(f, { type: "error", msg: "boom", errorCode: "E42", refId: "r1" });
});

test("normalizeFrame surfaces the custody frame (client decides to save)", () => {
  const custody = {
    protocol: "custody-1",
    order_id: "chat_abc",
    commitment: { record: {}, signature: { ed25519: "deadbeef" } },
    attestation: { record: {}, env_hash: "f00d" },
  };
  const f = normalizeFrame({ type: "custody", custody });
  assert.deepEqual(f, { type: "custody", custody });
});

test("normalizeFrame supports ping/reasoning/open liveness frames", () => {
  assert.deepEqual(normalizeFrame({ type: "ping" }), { type: "ping" });
  assert.deepEqual(normalizeFrame({ type: "open" }), { type: "open" });
  assert.deepEqual(normalizeFrame({ type: "reasoning", text: "hmm" }), {
    type: "reasoning",
    text: "hmm",
  });
});

test("normalizeFrame task_progress maps task_id + intra-task fields", () => {
  const f = normalizeFrame({ type: "task_progress", task_id: "t9", delta: "x", uvt: 5, cents: 0.1 });
  assert.deepEqual(f, { type: "task_progress", taskId: "t9", delta: "x", uvt: 5, cents: 0.1 });
});

test("normalizeFrame returns null for unknown type (ignored per contract)", () => {
  assert.equal(normalizeFrame({ type: "heartbeat" }), null);
  assert.equal(normalizeFrame({ no: "type" }), null);
});

test("parseEvent skips comment lines incl the CF-flush preamble", () => {
  assert.equal(parseEvent(":" + " ".repeat(4096)), null);
  const raw = ': keepalive\ndata: {"type":"delta","text":"hi"}';
  assert.deepEqual(parseEvent(raw), { type: "delta", text: "hi" });
});

test("parseEvent ignores [DONE] sentinel and bad JSON", () => {
  assert.equal(parseEvent("data: [DONE]"), null);
  assert.equal(parseEvent("data: {bad"), null);
});

test("decodeSse yields frames split on blank lines", async () => {
  async function* bytes(): AsyncGenerator<Uint8Array> {
    const enc = new TextEncoder();
    yield enc.encode('data: {"type":"open"}\n\n');
    yield enc.encode('data: {"type":"delta","text":"a"}\n\n');
    yield enc.encode('data: {"type":"done","uvt":2,"cents":0.2}\n\n');
  }
  const frames = [];
  for await (const f of decodeSse(bytes())) frames.push(f);
  assert.equal(frames.length, 3);
  assert.equal(frames[0]?.type, "open");
  assert.equal(frames[2]?.type, "done");
});

test("decodeSse handles CRLF servers, including a CRLF split across chunks", async () => {
  async function* bytes(): AsyncGenerator<Uint8Array> {
    const enc = new TextEncoder();
    yield enc.encode('data: {"type":"delta","text":"a"}\r\n\r\n');
    // Split the CRLF pair across a chunk boundary.
    yield enc.encode('data: {"type":"delta","text":"b"}\r');
    yield enc.encode('\n\r\ndata: {"type":"done","uvt":1,"cents":0}\r\n\r\n');
  }
  const frames = [];
  for await (const f of decodeSse(bytes())) frames.push(f);
  assert.equal(frames.length, 3);
  assert.deepEqual(frames[0], { type: "delta", text: "a" });
  assert.deepEqual(frames[1], { type: "delta", text: "b" });
  assert.equal(frames[2]?.type, "done");
});

test("decodeSse handles a frame split across chunks", async () => {
  async function* bytes(): AsyncGenerator<Uint8Array> {
    const enc = new TextEncoder();
    yield enc.encode('data: {"type":"del');
    yield enc.encode('ta","text":"split"}\n\n');
  }
  const frames = [];
  for await (const f of decodeSse(bytes())) frames.push(f);
  assert.deepEqual(frames, [{ type: "delta", text: "split" }]);
});

test("decodeSse refuses an undelimited terminal frame at EOF", async () => {
  async function* bytes(): AsyncGenerator<Uint8Array> {
    const enc = new TextEncoder();
    yield enc.encode('data: {"type":"delta","text":"partial"}\n\n');
    yield enc.encode('data: {"type":"done","uvt":1,"cents":0}');
  }
  const frames: StreamFrame[] = [];
  await assert.rejects(async () => {
    for await (const frame of decodeSse(bytes())) frames.push(frame);
  }, StreamIncompleteError);
  assert.deepEqual(frames, [{ type: "delta", text: "partial" }]);
});

test("decodeSse refuses a truncated data frame but ignores a trailing comment", async () => {
  const enc = new TextEncoder();
  async function* truncated(): AsyncGenerator<Uint8Array> {
    yield enc.encode('data: {"type":"done"');
  }
  await assert.rejects(async () => {
    for await (const _frame of decodeSse(truncated())) { /* drain */ }
  }, StreamIncompleteError);

  async function* comment(): AsyncGenerator<Uint8Array> {
    yield enc.encode(': keepalive');
  }
  const frames = [];
  for await (const frame of decodeSse(comment())) frames.push(frame);
  assert.deepEqual(frames, []);
});

test("decodeSse rejects an oversized delimiter-free event and closes its source", async () => {
  let closed = false;
  async function* bytes(): AsyncGenerator<Uint8Array> {
    try {
      yield new Uint8Array(MAX_SSE_EVENT_BYTES + 1).fill(0x61);
      yield new TextEncoder().encode("\n\n");
    } finally {
      closed = true;
    }
  }
  await assert.rejects(
    async () => {
      for await (const _frame of decodeSse(bytes())) {
        assert.fail("an oversized event must not yield a frame");
      }
    },
    (error: unknown) =>
      error instanceof StreamEventTooLargeError && error.maxBytes === MAX_SSE_EVENT_BYTES,
  );
  assert.equal(closed, true, "decoder failure closes the owned source iterator");
});

test("memory extract frame parses with subtype, text, kind, confidence", () => {
  const frame = normalizeFrame({
    type: "memory",
    subtype: "extract",
    text: "User prefers TypeScript",
    kind: "preference",
    confidence: 0.87,
  });
  assert.equal(frame?.type, "memory");
  if (frame?.type === "memory") {
    assert.equal(frame.subtype, "extract");
    assert.equal(frame.text, "User prefers TypeScript");
    assert.equal(frame.kind, "preference");
    assert.equal(frame.confidence, 0.87);
  }
});

test("memory skill frame parses with subtype, skill, confidence", () => {
  const frame = normalizeFrame({
    type: "memory",
    subtype: "skill",
    text: "User runs pytest -q --tb=short",
    skill: "test_runner_preference",
    confidence: 0.92,
  });
  assert.equal(frame?.type, "memory");
  if (frame?.type === "memory") {
    assert.equal(frame.subtype, "skill");
    assert.equal(frame.skill, "test_runner_preference");
    assert.equal(frame.confidence, 0.92);
    assert.equal(frame.text, "User runs pytest -q --tb=short");
  }
});

test("memory frame with unknown subtype is still parsed (forward-compat)", () => {
  const frame = normalizeFrame({
    type: "memory",
    subtype: "future_thing",
    text: "some data",
  });
  assert.equal(frame?.type, "memory");
  if (frame?.type === "memory") {
    assert.equal(frame.subtype, "future_thing");
    assert.equal(frame.text, "some data");
  }
});

test("memory compacting frame parses with beforeTokens, afterTokens, freedPct", () => {
  const frame = normalizeFrame({
    type: "memory",
    subtype: "compacting",
    before_tokens: 1165000000,
    after_tokens: 932000000,
    freed_pct: 20,
  });
  assert.equal(frame?.type, "memory");
  if (frame?.type === "memory") {
    assert.equal(frame.subtype, "compacting");
    assert.equal(frame.beforeTokens, 1165000000);
    assert.equal(frame.afterTokens, 932000000);
    assert.equal(frame.freedPct, 20);
  }
});

test("behavioral memory frame parses with skill fields", () => {
  const frame = normalizeFrame({
    type: "memory",
    subtype: "behavioral",
    skill_name: "writing-plans",
    description: "Write detailed implementation plans",
    triggers: ["invoke writing-plans", "write a plan", "plan mode"],
    action: "Load the plan skill and write a detailed plan.",
    category: "software-development",
    confidence: 0.88,
  });
  assert.equal(frame?.type, "memory");
  if (frame?.type === "memory") {
    assert.equal(frame.subtype, "behavioral");
    assert.equal(frame.skill_name, "writing-plans");
    assert.equal(frame.description, "Write detailed implementation plans");
    assert.deepEqual(frame.triggers, ["invoke writing-plans", "write a plan", "plan mode"]);
    assert.equal(frame.action, "Load the plan skill and write a detailed plan.");
    assert.equal(frame.category, "software-development");
    assert.equal(frame.confidence, 0.88);
  }
});
