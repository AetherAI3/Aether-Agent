import { test } from "node:test";
import assert from "node:assert/strict";
import { ConsoleQueue, parseQueueControl } from "../src/commands/console_queue.js";
import { captureShellResult, shellAttachment } from "../src/commands/shell_attachment.js";

test("queue keeps stable typed IDs, FIFO order, and an immutable active entry", () => {
  const queue = new ConsoleQueue();
  const active = queue.start({ kind: "chat", text: "active" });
  const shell = queue.enqueue({ kind: "shell", command: "echo before" });
  const chat = queue.enqueue({ kind: "chat", text: "after" });
  assert.notEqual(typeof shell, "string"); assert.notEqual(typeof chat, "string");
  if (typeof shell === "string" || typeof chat === "string") return;
  assert.match(queue.edit(active.id, "changed"), /active and immutable/);
  assert.match(queue.remove(active.id), /active and immutable/);
  assert.equal(queue.active?.input.kind, "chat");
  assert.match(queue.edit(shell.id, "!echo edited"), /Updated/);
  assert.equal(queue.list()[0]?.id, shell.id);
  assert.match(queue.edit(shell.id, "accidental chat"), /Edit refused/);
  assert.match(queue.edit(chat.id, "!echo accidental shell"), /Edit refused/);
  assert.match(queue.edit(chat.id, "/shell-result send"), /Edit refused/);
  assert.equal(queue.take()?.id, shell.id);
  assert.deepEqual(queue.active?.input, { kind: "shell", command: "echo edited" });
  assert.equal(queue.take()?.id, chat.id);
  assert.equal(queue.take(), null);
});

test("remove/clear are local and cannot resurrect discarded entries", () => {
  const queue = new ConsoleQueue();
  const first = queue.enqueue({ kind: "shell", command: "never run" });
  const second = queue.enqueue({ kind: "chat", text: "never sent" });
  if (typeof first === "string" || typeof second === "string") throw new Error("unexpected limit");
  assert.match(queue.remove(first.id), /Nothing executed/);
  assert.match(queue.clear("failed"), new RegExp(second.id));
  assert.equal(queue.length, 0); assert.equal(queue.byteLength, 0);
  assert.equal(queue.take(), null);
  assert.match(queue.remove(first.id), /No pending/);
  assert.match(queue.approve(second.id), /No pending/);
});

test("queue count and UTF-8 byte limits include edits and retained attachment provenance", () => {
  const queue = new ConsoleQueue(2, 100);
  const first = queue.enqueue({ kind: "chat", text: "small" });
  if (typeof first === "string") throw new Error(first);
  assert.equal(typeof queue.enqueue({ kind: "chat", text: "😀".repeat(100) }), "string");
  assert.match(queue.edit(first.id, "😀".repeat(100)), /Edit refused/);
  assert.deepEqual(queue.list()[0]?.input, { kind: "chat", text: "small" });
  queue.enqueue({ kind: "chat", text: "second" });
  assert.equal(typeof queue.enqueue({ kind: "chat", text: "third" }), "string");
  const source = captureShellResult("s", "c", "metadata", "x".repeat(7000), 0);
  assert.equal(typeof new ConsoleQueue(32, 1000).enqueue(shellAttachment(source, "tiny edit", true)), "string");
});

test("editing a reviewed shell-share revokes consent and blocks FIFO until explicit send", () => {
  const queue = new ConsoleQueue();
  const source = captureShellResult("sessionA", "commandA", "private cwd", "resultA", 12);
  const original = shellAttachment(source);
  const first = queue.enqueue(original);
  const second = queue.enqueue({ kind: "shell", command: "echo later" });
  if (typeof first === "string" || typeof second === "string") throw new Error("unexpected limit");
  assert.match(queue.edit(first.id, "edited resultA"), /old send approval revoked/);
  assert.equal(queue.take(), null);
  assert.equal(queue.waitingForApproval, true);
  assert.match(queue.describe(), /awaiting explicit/);
  assert.match(queue.approve(first.id), /approved/);
  const sent = queue.take()!;
  assert.equal(sent.id, first.id);
  assert.equal(sent.input.kind, "attachment");
  if (sent.input.kind === "attachment") {
    assert.equal(sent.input.capture, source);
    assert.ok(sent.input.text.endsWith("edited resultA"));
    assert.notEqual(sent.input, original);
  }
  assert.equal(queue.take()?.id, second.id);
  const empty = queue.enqueue(original);
  if (typeof empty === "string") throw new Error(empty);
  queue.edit(empty.id, "");
  assert.match(queue.approve(empty.id), /Empty shell selection/);
  assert.equal(queue.take(), null);
});

test("queue operations parse before the legacy task prefix, with safe local rendering", () => {
  assert.deepEqual(parseQueueControl("/queue"), { action: "list" });
  assert.deepEqual(parseQueueControl("/queue edit q1 !echo hello"), { action: "edit", id: "q1", text: "!echo hello" });
  assert.equal(parseQueueControl("/queue ordinary task"), null);
  assert.deepEqual(parseQueueControl("/queue edit q1\n!echo never"), { action: "invalid" });
  const queue = new ConsoleQueue();
  queue.enqueue({ kind: "shell", command: "echo \x1b]52;c;fixture\x07" });
  assert.doesNotMatch(queue.describe(), /\x1b|\x07/);
  assert.match(queue.describe(), /user shell/);
  assert.match(queue.control({ action: "remove" }).message, /usage/);
});
