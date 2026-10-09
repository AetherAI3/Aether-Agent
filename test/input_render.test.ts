// test/input_render.test.ts — single-row input view with cursor windowing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderInputView } from "../src/ui/input_render.js";
import { stripAnsi } from "../src/ui/text.js";

test("short input: full text, cursor after last char", () => {
  const v = renderInputView("> ", "abc", 3, 40);
  assert.equal(v.text, "> abc");
  assert.equal(v.cursorCol, 6); // 2 prompt cols + 3 chars + 1
});

test("cursor mid-line positions inside the row", () => {
  const v = renderInputView("> ", "abcdef", 2, 40);
  assert.equal(v.cursorCol, 5);
});

test("long input: window slides so the cursor stays visible", () => {
  const value = "x".repeat(100);
  const v = renderInputView("> ", value, 100, 20);
  assert.ok(stripAnsi(v.text).length <= 20, "row fits the terminal");
  assert.ok(v.cursorCol <= 20, "cursor inside the row");
});

test("ANSI prompt prefix: width counted visually", () => {
  const v = renderInputView("\x1b[36m> \x1b[0m", "ab", 2, 40);
  assert.equal(v.cursorCol, 5);
});

test("wide chars position the cursor by columns, not chars", () => {
  const v = renderInputView("> ", "漢字", 2, 40);
  assert.equal(v.cursorCol, 7); // 2 + 4 cols + 1
});

test("embedded newlines render as ⏎ on the single row (no raw linefeed)", () => {
  const v = renderInputView("> ", "ab\ncd", 5, 40);
  assert.ok(!v.text.includes("\n"), "a raw LF would break the pinned row");
  assert.ok(v.text.includes("⏎"));
  assert.equal(v.cursorCol, 2 + 5 + 1); // ⏎ counts one column
  assert.match(v.text, /\[2L\]$/);
});

test("multiline Unicode input keeps a one-row cursor and line hint after resize", () => {
  const value = "漢🙂\nsecond\nthird";
  for (const cols of [12, 20, 40]) {
    const view = renderInputView("> ", value, [...value].length, cols);
    assert.ok(!view.text.includes("\n"));
    assert.ok(view.cursorCol >= 1 && view.cursorCol <= cols);
    assert.ok(stripAnsi(view.text).length <= cols);
    if (cols >= 20) assert.match(view.text, /\[3L\]$/);
  }
});
