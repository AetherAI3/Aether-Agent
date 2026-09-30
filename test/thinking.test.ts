import { test } from "node:test";
import assert from "node:assert/strict";
import { ThinkingPulse, thinkingFrame } from "../src/ui/thinking.js";

test("thinkingFrame cycles dots and turns honest when stalled", () => {
  assert.equal(thinkingFrame(0, false), "(⌨_⌨) thinking·  ");
  assert.equal(thinkingFrame(1, false), "(⌨_⌨) thinking·· ");
  assert.equal(thinkingFrame(2, false), "(⌨_⌨) thinking···");
  assert.equal(thinkingFrame(3, false), "(⌨_⌨) thinking·  "); // wraps
  assert.match(thinkingFrame(0, true), /still waiting · Ctrl\+C cancels the turn/);
});

test("start paints immediately; stop clears the line exactly once", () => {
  let out = "";
  const p = new ThinkingPulse({ write: (s) => (out += s), intervalMs: 60_000 }); // interval never fires in-test
  p.start();
  assert.ok(out.includes("thinking"), "first frame painted synchronously");
  const before = out;
  p.stop();
  assert.equal(out, before + "\r\x1b[2K", "stop clears the pinned line");
  const after = out;
  p.stop(); // idempotent
  assert.equal(out, after);
});

test("start is idempotent while running", () => {
  let frames = 0;
  const p = new ThinkingPulse({
    write: () => {
      frames += 1;
    },
    intervalMs: 60_000,
  });
  p.start();
  p.start();
  assert.equal(frames, 1);
  p.stop();
});

test("stop before any paint writes nothing", () => {
  let out = "";
  const p = new ThinkingPulse({ write: (s) => (out += s), intervalMs: 60_000 });
  p.stop();
  assert.equal(out, "");
});

test("frame gains the stall suffix after stallAfterMs of silence", async () => {
  let out = "";
  // 5ms cadence, 20ms stall threshold — fast enough for a real-time test.
  const p = new ThinkingPulse({ write: (s) => (out += s), intervalMs: 5, stallAfterMs: 20 });
  p.start();
  await new Promise((r) => setTimeout(r, 40));
  p.stop();
  assert.match(out, /still waiting · Ctrl\+C cancels the turn/);
});

test("disabled pulse writes zero bytes, ever", () => {
  let out = "";
  const p = new ThinkingPulse({ write: (s) => (out += s), enabled: false });
  p.start();
  p.stop();
  assert.equal(out, "");
});

test("onPaint fires after every repaint (lets the REPL re-sync its input line)", () => {
  let out = "";
  let paints = 0;
  let lastFrame = "";
  const p = new ThinkingPulse({
    write: (s) => (out += s),
    intervalMs: 60_000,
    onPaint: (frame) => { paints++; lastFrame = frame; },
  });
  p.start();
  assert.equal(paints, 1);
  assert.match(lastFrame, /thinking/);
  assert.ok(out.includes(lastFrame), "the REPL can redraw its input with the live pulse still visible");
  p.stop();
  assert.equal(paints, 1, "stop() must not itself trigger a paint");
});
