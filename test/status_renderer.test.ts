import { test } from "node:test";
import assert from "node:assert/strict";
import { StatusRenderer } from "../src/ui/status_renderer.js";
import { stripAnsi } from "../src/ui/theme.js";
import { visibleWidth } from "../src/ui/text.js";
import { StringSink } from "../src/ui/sink.js";

test("composeLine renders verb, elapsed, and streamed tokens", () => {
  let clock = 0;
  const sr = new StatusRenderer({ quiet: true, now: () => clock });
  sr.start();
  sr.setVerb("Forging", "(ง'̀-'́)ง");
  sr.setStreamed(33_000);
  clock = 2 * 60_000 + 14_000;
  const line = stripAnsi(sr.composeLine());
  assert.match(line, /Forging…/);
  assert.match(line, /2m 14s/);
  assert.match(line, /↑ 33\.0K tokens/);
});

test("with no streamed tokens, the ↑ segment is omitted", () => {
  const sr = new StatusRenderer({ quiet: true, now: () => 1000 });
  assert.doesNotMatch(stripAnsi(sr.composeLine()), /↑/);
});

test("setAnim shows the stage art in the composed line", () => {
  const sr = new StatusRenderer({ quiet: true, now: () => 0 });
  sr.setAnim("▰▰▱▱");
  assert.match(stripAnsi(sr.composeLine()), /▰▰▱▱/);
});

test("composeLine is clamped to the sink width (no wrap on narrow terminals)", () => {
  const sink = new StringSink({ columns: 40, isTTY: false, colorEnabled: false });
  const sr = new StatusRenderer({ quiet: true, now: () => 0, sink });
  sr.setVerb("Reconnoitring the perimeter fences very thoroughly", "( ⚆ _ ⚆ )");
  sr.setStreamed(1_234_567);
  sr.setProgress(123456, 999999);
  assert.ok(visibleWidth(sr.composeLine()) <= 39, "line fits 40-col sink");
});

test("hostile progress metrics are clamped before status rendering", () => {
  const sink = new StringSink({ columns: 200, isTTY: false, colorEnabled: false });
  const sr = new StatusRenderer({ quiet: true, mode: "api", now: () => 0, sink });
  sr.setStreamed(Number.POSITIVE_INFINITY);
  sr.setProgress(-1, 10);
  const normalized = stripAnsi(sr.composeLine());
  assert.match(normalized, /UVT 0\/10/);
  assert.doesNotMatch(normalized, /Infinity|NaN/);
  assert.doesNotThrow(() => {
    sr.setProgress(Number.MAX_VALUE, Number.MIN_VALUE);
    sr.composeLine();
  });
});

test("a confirmation keeps the status line from repainting over the review", () => {
  const sink = new StringSink({ isTTY: true, colorEnabled: false });
  const sr = new StatusRenderer({ sink, now: () => 0, ownsProcess: false });
  sr.start();
  const resume = sr.pauseForPrompt();
  const before = sink.buffer;
  sr.setVerb("Changed while waiting", "");
  sr.setHeartbeat("!");
  assert.equal(sink.buffer, before, "status changes must not overwrite the open prompt");
  resume();
  assert.match(sink.buffer.slice(before.length), /Changed while waiting/);
  const lateResume = sr.pauseForPrompt();
  sr.end();
  const afterEnd = sink.buffer;
  lateResume();
  assert.equal(sink.buffer, afterEnd, "late prompt cleanup must not repaint after teardown");
});
