import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { promptDenialFeedback } from "../src/ui/approval_feedback.js";
import { InputBuffer } from "../src/ui/input_line.js";
import { MAX_DENIAL_FEEDBACK_BYTES } from "../src/core/tool_approval.js";

function lease() {
  const input = new PassThrough() as PassThrough & { isRaw?: boolean; setRawMode?: (raw: boolean) => void };
  const modes: boolean[] = [];
  input.isRaw = false;
  input.setRawMode = raw => { input.isRaw = raw; modes.push(raw); };
  const output = new PassThrough();
  let text = "";
  output.on("data", chunk => { text += String(chunk); });
  return { input, output, modes, text: () => text };
}

test("feedback owns a separate short-lived buffer and restores the prior raw mode", async () => {
  const main = new InputBuffer();
  main.insert("queued draft");
  main.left();
  const before = { value: main.value, cursor: main.pos };
  const queued = ["pending task"];
  const io = lease();
  const pending = promptDenialFeedback(io);
  io.input.write("Use offlien");
  io.input.write("\x7f\x7fne suite\r");
  assert.equal(await pending, "Use offline suite");
  assert.deepEqual(io.modes, [true, false]);
  assert.deepEqual({ value: main.value, cursor: main.pos }, before);
  assert.deepEqual(queued, ["pending task"]);
  assert.match(io.text(), /Optional instruction/);
});

test("Enter skips, Escape cancels, and a pasted note cannot exceed the byte cap", async () => {
  const skipped = lease();
  const first = promptDenialFeedback(skipped);
  skipped.input.write("\r");
  assert.equal(await first, null);
  const cancelled = lease();
  const second = promptDenialFeedback(cancelled);
  cancelled.input.write("temporary\x1b");
  assert.equal(await second, null);
  const pasted = lease();
  const third = promptDenialFeedback(pasted);
  pasted.input.write("\x1b[200~" + "é".repeat(10_000) + "\x1b[201~\r");
  const result = await third;
  assert.equal(Buffer.byteLength(result!, "utf8"), MAX_DENIAL_FEEDBACK_BYTES);
  assert.equal(pasted.input.listenerCount("data"), 0);
});

test("input batched after feedback submission returns to the next owner", async () => {
  const io = lease();
  const pending = promptDenialFeedback(io);
  io.input.write("Use offline tests\rqueued draft");
  assert.equal(await pending, "Use offline tests");
  let handedBack = "";
  io.input.on("data", chunk => { handedBack += String(chunk); });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(handedBack, "queued draft");
});

test("turn cancellation releases the feedback lease without a note", async () => {
  const io = lease();
  const controller = new AbortController();
  const pending = promptDenialFeedback({ ...io, signal: controller.signal });
  io.input.write("unfinished note");
  controller.abort();
  assert.equal(await pending, null);
  assert.deepEqual(io.modes, [true, false]);
  assert.equal(io.input.listenerCount("data"), 0);
});
