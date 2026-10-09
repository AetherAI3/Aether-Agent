// test/keys.test.ts — key decoding + the stdin chunk tokenizer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeKey, splitKeys } from "../src/ui/keys.js";

test("splitKeys: plain text run stays one token", () => {
  assert.deepEqual(splitKeys("abc"), ["abc"]);
});

test("splitKeys: text + escape + text -> three tokens", () => {
  assert.deepEqual(splitKeys("a\x1b[Db"), ["a", "\x1b[D", "b"]);
});

test("splitKeys: multibyte graphemes survive in one run", () => {
  assert.deepEqual(splitKeys("héllo🎉"), ["héllo🎉"]);
});

test("splitKeys: control chars are individual tokens", () => {
  assert.deepEqual(splitKeys("ab\rcd\x7f"), ["ab", "\r", "cd", "\x7f"]);
  assert.deepEqual(splitKeys("a\nb\x1f\x19"), ["a", "\n", "b", "\x1f", "\x19"]);
});

test("Ctrl+J inserts LF by default; explicit compatibility mode submits it", () => {
  assert.deepEqual(decodeKey("\r"), { kind: "submit" });
  assert.deepEqual(decodeKey("\n"), { kind: "newline" });
  assert.deepEqual(decodeKey("\n", true), { kind: "submit" });
  assert.deepEqual(decodeKey("\x1f"), { kind: "undo" });
  assert.deepEqual(decodeKey("\x19"), { kind: "yank" });
});

test("splitKeys: bracketed paste markers tokenize exactly", () => {
  assert.deepEqual(splitKeys("\x1b[200~hi\x1b[201~"), ["\x1b[200~", "hi", "\x1b[201~"]);
});

test("splitKeys: lone ESC is its own token", () => {
  assert.deepEqual(splitKeys("\x1b"), ["\x1b"]);
});

test("decodeKey: delete key", () => {
  assert.deepEqual(decodeKey("\x1b[3~"), { kind: "delete" });
});

test("decodeKey: ctrl-a/e/k/u", () => {
  assert.deepEqual(decodeKey("\x01"), { kind: "home" });
  assert.deepEqual(decodeKey("\x05"), { kind: "end" });
  assert.deepEqual(decodeKey("\x0b"), { kind: "kill-end" });
  assert.deepEqual(decodeKey("\x15"), { kind: "kill-start" });
});

test("decodeKey: multi-char printable run decodes as one char token", () => {
  assert.deepEqual(decodeKey("abc"), { kind: "char", value: "abc" });
});

test("decodeKey: single chars and legacy sequences unchanged", () => {
  assert.deepEqual(decodeKey("\r"), { kind: "submit" });
  assert.deepEqual(decodeKey("\x1b[A"), { kind: "up" });
  assert.deepEqual(decodeKey("x"), { kind: "char", value: "x" });
});

test("Alt/Meta chords are one token and ignored (Alt+Enter must NOT submit)", () => {
  assert.deepEqual(splitKeys("\x1b\r"), ["\x1b\r"]);
  assert.deepEqual(decodeKey("\x1b\r"), { kind: "ignore" });
  assert.deepEqual(splitKeys("\x1ba"), ["\x1ba"]);
  assert.deepEqual(decodeKey("\x1ba"), { kind: "ignore" }, "Alt+a is not a typed letter");
});

test("Alt+Backspace is word-delete", () => {
  assert.deepEqual(decodeKey("\x1b\x7f"), { kind: "word-delete" });
});

test("SS3 (application cursor mode) arrows and Home/End decode", () => {
  assert.deepEqual(decodeKey("\x1bOA"), { kind: "up" });
  assert.deepEqual(decodeKey("\x1bOB"), { kind: "down" });
  assert.deepEqual(decodeKey("\x1bOC"), { kind: "right" });
  assert.deepEqual(decodeKey("\x1bOD"), { kind: "left" });
  assert.deepEqual(decodeKey("\x1bOH"), { kind: "home" });
  assert.deepEqual(decodeKey("\x1bOF"), { kind: "end" });
});

test("SGR mouse reports tokenize as one CSI sequence and are ignored, not typed", () => {
  const report = "\x1b[<0;12;34M";
  assert.deepEqual(splitKeys(report), [report]);
  assert.deepEqual(decodeKey(report), { kind: "ignore" });
});

test("word-jump chords decode (ctrl/alt arrows, alt-b/f)", () => {
  assert.deepEqual(decodeKey("\x1b[1;5D"), { kind: "word-left" });
  assert.deepEqual(decodeKey("\x1b[1;5C"), { kind: "word-right" });
  assert.deepEqual(decodeKey("\x1b[1;3D"), { kind: "word-left" });
  assert.deepEqual(decodeKey("\x1b[1;3C"), { kind: "word-right" });
  assert.deepEqual(decodeKey("\x1bb"), { kind: "word-left" });
  assert.deepEqual(decodeKey("\x1bf"), { kind: "word-right" });
});

test("tab and ctrl-l decode; tab tokenizes as its own control token", () => {
  assert.deepEqual(decodeKey("\t"), { kind: "tab" });
  assert.deepEqual(decodeKey("\x0c"), { kind: "clear-screen" });
  assert.deepEqual(splitKeys("a\tb"), ["a", "\t", "b"]);
});
