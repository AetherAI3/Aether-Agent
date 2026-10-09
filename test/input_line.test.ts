import { test } from "node:test";
import assert from "node:assert/strict";
import { InputBuffer } from "../src/ui/input_line.js";

test("typed characters accumulate", () => {
  const b = new InputBuffer();
  for (const c of "hello") b.insert(c);
  assert.equal(b.value, "hello");
});
test("bracketed paste inserts the whole block at the cursor", () => {
  const b = new InputBuffer();
  b.insert("a");
  b.paste("X\nY");
  assert.equal(b.value, "aX\nY");
});
test("backspace deletes before the cursor", () => {
  const b = new InputBuffer();
  for (const c of "abc") b.insert(c);
  b.backspace();
  assert.equal(b.value, "ab");
});
test("left/right move the cursor; insert respects it", () => {
  const b = new InputBuffer();
  for (const c of "ac") b.insert(c);
  b.left();
  b.insert("b");
  assert.equal(b.value, "abc");
});
test("history up/down recalls submitted lines", () => {
  const b = new InputBuffer();
  b.commit("first");
  b.commit("second");
  b.historyUp();
  assert.equal(b.value, "second");
  b.historyUp();
  assert.equal(b.value, "first");
  b.historyDown();
  assert.equal(b.value, "second");
});
test("deleteWord removes the word before the cursor", () => {
  const b = new InputBuffer();
  for (const c of "foo bar") b.insert(c);
  b.deleteWord();
  assert.equal(b.value, "foo ");
});
test("deleteForward removes the char at the cursor", () => {
  const b = new InputBuffer();
  for (const c of "abc") b.insert(c);
  b.left();
  b.deleteForward();
  assert.equal(b.value, "ab");
  assert.equal(b.pos, 2);
});
test("killToEnd truncates from the cursor", () => {
  const b = new InputBuffer();
  for (const c of "abcd") b.insert(c);
  b.left();
  b.left();
  b.killToEnd();
  assert.equal(b.value, "ab");
});
test("killToStart removes before the cursor and zeroes it", () => {
  const b = new InputBuffer();
  for (const c of "abcd") b.insert(c);
  b.left();
  b.killToStart();
  assert.equal(b.value, "d");
  assert.equal(b.pos, 0);
});

test("wordLeft/wordRight jump across space-delimited words", () => {
  const b = new InputBuffer();
  b.insert("one two  three");
  b.wordLeft();
  assert.equal(b.value.slice(b.pos), "three");
  b.wordLeft();
  assert.equal(b.value.slice(b.pos), "two  three");
  b.wordRight();
  assert.equal(b.pos, 7); // lands just past "two"
  b.home();
  b.wordRight();
  assert.equal(b.pos, 3);
});

test("history: consecutive duplicate commits collapse to one entry", () => {
  const b = new InputBuffer();
  b.insert("same");
  b.commit("same");
  b.insert("same");
  b.commit("same");
  b.historyUp();
  assert.equal(b.value, "same");
  b.historyUp();
  assert.equal(b.value, "same"); // single entry — stays put
});

test("history recall stashes the draft and restores it on the way down", () => {
  const b = new InputBuffer();
  b.insert("old");
  b.commit("old");
  b.insert("draft in progress");
  b.historyUp();
  assert.equal(b.value, "old");
  b.historyDown();
  assert.equal(b.value, "draft in progress");
});

test("loadHistory seeds persisted entries for up-arrow", () => {
  const b = new InputBuffer();
  b.loadHistory(["a", "b"]);
  b.historyUp();
  assert.equal(b.value, "b");
  b.historyUp();
  assert.equal(b.value, "a");
});

test("insert is bulk — a large paste lands intact with the cursor at the end", () => {
  const b = new InputBuffer();
  const big = "x".repeat(50_000) + "🙂";
  b.paste(big);
  assert.equal(b.value, big);
  assert.equal(b.pos, 50_001); // 50k ascii + one astral code point
});

test("adjacent Unicode typing coalesces; newline is its own undo step", () => {
  const b = new InputBuffer();
  b.insert("é");
  b.insert("🙂");
  b.insertNewline();
  b.insert("漢");
  b.undo();
  assert.equal(b.value, "é🙂\n");
  assert.equal(b.pos, 3);
  b.undo();
  assert.equal(b.value, "é🙂");
  assert.equal(b.pos, 2);
  b.undo();
  assert.equal(b.value, "");
  assert.equal(b.pos, 0);
});

test("bracketed paste is one transaction and restores the prior cursor", () => {
  const b = new InputBuffer();
  b.insert("ab");
  b.left();
  b.paste("👩‍💻\nnext");
  assert.equal(b.value, "a👩‍💻\nnextb");
  b.undo();
  assert.equal(b.value, "ab");
  assert.equal(b.pos, 1);
});

test("kill, yank, and undo recover text without crossing a clear or submit", () => {
  const b = new InputBuffer();
  b.insert("alpha beta");
  b.deleteWord();
  assert.equal(b.value, "alpha ");
  b.yank();
  assert.equal(b.value, "alpha beta");
  b.undo();
  assert.equal(b.value, "alpha ");
  b.undo();
  assert.equal(b.value, "alpha beta");
  b.commit(b.value);
  b.undo();
  b.yank();
  assert.equal(b.value, "", "sent text and its kill register are outside the recovery scope");
  b.insert("new draft");
  b.killToStart();
  b.clear();
  b.yank();
  b.undo();
  assert.equal(b.value, "");
});

test("input-owner changes end recovery but keep the live draft", () => {
  const b = new InputBuffer();
  b.insert("draft");
  b.left();
  b.left();
  b.killToEnd();
  b.endRecoveryScope();
  b.undo();
  b.yank();
  assert.equal(b.value, "dra");
});

test("history recall and slash completion are undoable within one draft", () => {
  const b = new InputBuffer();
  b.loadHistory(["older", "latest"]);
  b.insert("draft");
  b.historyUp();
  assert.equal(b.value, "latest");
  b.undo();
  assert.equal(b.value, "draft");
  b.replace("/models");
  b.undo();
  assert.equal(b.value, "draft");
});

test("undo retains at most 64 edit snapshots", () => {
  const b = new InputBuffer();
  for (let i = 0; i < 100; i++) { b.insert("x"); b.left(); b.right(); }
  for (let i = 0; i < 100; i++) b.undo();
  assert.equal(b.value.length, 36);
});
