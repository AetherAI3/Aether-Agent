// src/ui/input_render.ts — single-row input view with a horizontal scroll
// window that keeps the cursor visible. Pure; the REPL repaint and TuiLayout's
// pinned input row both render through this, so the chat bar behaves identically
// in plain and alt-screen modes.

import { charWidth, visibleWidth, sliceVisible } from "./text.js";

/** Map a buffer code point to its single-row display form: embedded newlines
 *  show as ⏎, tabs as ⇥ (both width 1); everything else passes through. */
function displayChar(ch: string): string {
  if (ch === "\n" || ch === "\r") return "⏎";
  if (ch === "\t") return "⇥";
  return ch;
}

export interface InputView {
  /** The row to draw: prompt + the visible slice of the value. */
  text: string;
  /** 1-based terminal column where the cursor belongs. */
  cursorCol: number;
}

/**
 * Compute the visible input row for a buffer `value` with the caret at code
 * point index `cursor`, inside a terminal `cols` wide. When the value overflows
 * the row, a window slides so the caret is always on screen (caret pinned to
 * the right edge while typing at the end).
 */
export function renderInputView(prompt: string, value: string, cursor: number, cols: number): InputView {
  // A prompt wider than the row would push the caret off-screen and hard-wrap
  // every repaint; clamp it so at least a few columns remain for typing.
  let p = prompt;
  let pw = visibleWidth(p);
  if (pw > Math.max(0, cols - 8)) {
    p = sliceVisible(p, Math.max(0, cols - 8));
    pw = visibleWidth(p);
  }
  const lines = 1 + [...value].filter((ch) => ch === "\n").length;
  const lineHint = lines > 1 ? ` [${lines}L]` : "";
  const hint = cols - pw >= visibleWidth(lineHint) + 3 ? lineHint : "";
  const avail = Math.max(1, cols - pw - visibleWidth(hint) - 1); // one spare column for the caret
  // Control chars from multi-line pastes render as glyphs — a raw \n written
  // during repaint would drop the cursor a row and stack garbage lines.
  const cps = [...value].map(displayChar);
  const cur = Math.max(0, Math.min(cursor, cps.length));
  const w = (i: number): number => charWidth(cps[i]!.codePointAt(0)!);
  // O(n): one pass for the cursor's prefix width, then slide the window start.
  let winW = 0;
  for (let i = 0; i < cur; i++) winW += w(i);
  let start = 0;
  while (winW > avail - 1) {
    winW -= w(start);
    start++;
  }
  let end = start;
  let used = 0;
  while (end < cps.length && used + w(end) <= avail) {
    used += w(end);
    end++;
  }
  return {
    text: p + cps.slice(start, end).join("") + hint,
    cursorCol: Math.min(Math.max(1, cols), pw + winW + 1),
  };
}
