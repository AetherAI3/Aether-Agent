import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ConsoleQueue, QUEUE_MAX_BYTES, QUEUE_MAX_ENTRIES, describeEntry, parseQueueCommand, renderDisposition,
} from "../src/commands/console_queue.js";

test("queue commands match strictly so ordinary tasks still queue", () => {
  assert.deepEqual(parseQueueCommand("/queue"), { op: "list" });
  assert.deepEqual(parseQueueCommand("  /queue list "), { op: "list" });
  assert.deepEqual(parseQueueCommand("/queue clear"), { op: "clear" });
  assert.deepEqual(parseQueueCommand("/queue resume"), { op: "resume" });
  assert.deepEqual(parseQueueCommand("/queue remove q3"), { op: "remove", id: "q3" });
  assert.deepEqual(parseQueueCommand("/queue rm Q12"), { op: "remove", id: "q12" });
  assert.deepEqual(parseQueueCommand("/queue edit q2 new text here"), { op: "edit", id: "q2", text: "new text here" });
  assert.deepEqual(parseQueueCommand("/queue edit q2 !ls -la"), { op: "edit", id: "q2", text: "!ls -la" });
  assert.equal(parseQueueCommand("/queue edit q2")?.op, "usage");
  // Plausible tasks are not commands.
  assert.equal(parseQueueCommand("/queue clear the cache"), null);
  assert.equal(parseQueueCommand("/queue edit the readme"), null);
  assert.equal(parseQueueCommand("/queue remove 2 stale files"), null);
  assert.equal(parseQueueCommand("/queue fix login bug"), null);
  assert.equal(parseQueueCommand("hello"), null);
});

test("entries get stable, never-reused ids and drain in strict order", () => {
  const queue = new ConsoleQueue();
  const running = queue.allocate({ kind: "chat", text: "first" });
  assert.equal(running.id, "q1");
  const a = queue.enqueue({ kind: "chat", text: "a" });
  const b = queue.enqueue({ kind: "shell", command: "make test" });
  const c = queue.enqueue({ kind: "reset-shell" });
  assert.ok(a.ok && b.ok && c.ok);
  assert.deepEqual(queue.pending.map(e => e.id), ["q2", "q3", "q4"]);
  assert.ok(queue.remove("q3").ok);
  const d = queue.enqueue({ kind: "chat", text: "d" });
  assert.ok(d.ok && d.entry.id === "q5", "removed ids are never reused");
  assert.deepEqual([queue.shift()?.id, queue.shift()?.id, queue.shift()?.id, queue.shift()], ["q2", "q4", "q5", undefined]);
});

test("edits keep id, position and type; reclassifying edits are rejected unchanged", () => {
  const queue = new ConsoleQueue();
  queue.enqueue({ kind: "chat", text: "one" });
  queue.enqueue({ kind: "shell", command: "echo two" });
  queue.enqueue({ kind: "chat", text: "three" });
  queue.enqueue({ kind: "share", action: "preview" });
  queue.enqueue({ kind: "reset-shell" });
  const snapshot = queue.pending;

  const chat = queue.edit("q1", "one, revised");
  assert.ok(chat.ok);
  assert.deepEqual(queue.pending.map(e => e.id), ["q1", "q2", "q3", "q4", "q5"]);
  assert.deepEqual(queue.pending[0]!.input, { kind: "chat", text: "one, revised" });
  assert.deepEqual(snapshot[0]!.input, { kind: "chat", text: "one" }, "entries are replaced, not mutated");

  const shell = queue.edit("q2", "!echo TWO");
  assert.ok(shell.ok);
  assert.deepEqual(queue.pending[1]!.input, { kind: "shell", command: "echo TWO" });

  const before = queue.pending;
  const rejections = [
    queue.edit("q3", "!rm -rf build"), // chat → shell
    queue.edit("q3", "/exit"), // chat → slash command
    queue.edit("q3", "/shell-reset"), // chat → shell reset
    queue.edit("q2", "plain words"), // shell → chat
    queue.edit("q2", "!"), // shell → usage error
    queue.edit("q4", "/shell-result send"), // share has no text
    queue.edit("q5", "!echo hi"), // reset has no text
    queue.edit("q99", "whatever"), // missing
  ];
  for (const result of rejections) assert.equal(result.ok, false);
  assert.match((rejections[0] as { message: string }).message, /q3 is a chat entry.*Not changed/);
  assert.match((rejections[3] as { message: string }).message, /q2 is a user shell entry; the replacement must be !<command>/);
  assert.match((rejections[5] as { message: string }).message, /shell-share action with no editable text/);
  assert.match((rejections[7] as { message: string }).message, /No pending entry q99/);
  assert.equal(queue.pending, before, "rejected edits change nothing");

  // \! keeps a leading ! as chat text.
  const escaped = queue.edit("q3", "\\!important: three");
  assert.ok(escaped.ok);
  assert.deepEqual(queue.pending[2]!.input, { kind: "chat", text: "!important: three" });
});

test("the running entry is named but cannot be edited or removed", () => {
  const queue = new ConsoleQueue();
  const running = queue.allocate({ kind: "chat", text: "streaming now" });
  queue.setRunning(running);
  queue.enqueue({ kind: "chat", text: "next" });
  const edit = queue.edit(running.id, "changed");
  const remove = queue.remove(running.id);
  assert.equal(edit.ok, false);
  assert.equal(remove.ok, false);
  assert.match((edit as { message: string }).message, /q1 is running and cannot be changed/);
  const listing = queue.render();
  assert.match(listing, /running {2}q1 +chat +"streaming now"/);
  assert.match(listing, /1\. +q2 +chat +"next"/);
  assert.match(new ConsoleQueue().render("slash command /doctor"), /running {2}slash command \/doctor/);
});

test("bounds reject with useful feedback and leave the queue unchanged", () => {
  const queue = new ConsoleQueue();
  for (let i = 0; i < QUEUE_MAX_ENTRIES; i++) assert.ok(queue.enqueue({ kind: "chat", text: `t${i}` }).ok);
  const full = queue.enqueue({ kind: "chat", text: "one more" });
  assert.equal(full.ok, false);
  assert.match((full as { message: string }).message, /Queue full \(32 entries\); not queued/);
  assert.equal(queue.length, QUEUE_MAX_ENTRIES);

  const bytes = new ConsoleQueue();
  assert.ok(bytes.enqueue({ kind: "chat", text: "x".repeat(QUEUE_MAX_BYTES - 10) }).ok);
  const big = bytes.enqueue({ kind: "shell", command: "y".repeat(11) });
  assert.equal(big.ok, false);
  assert.match((big as { message: string }).message, /64 KiB/);
  assert.ok(bytes.enqueue({ kind: "chat", text: "é".repeat(5) }).ok, "UTF-8 bytes, not code units, are counted");
  const edit = bytes.edit("q2", "z".repeat(20));
  assert.equal(edit.ok, false);
  assert.match((edit as { message: string }).message, /exceed the 64 KiB queue bound/);
});

test("a hold keeps entries but stops draining until resume; clear and remove report exactly what went", () => {
  const queue = new ConsoleQueue();
  assert.equal(queue.hold("q1 failed"), false, "an empty queue is never held");
  queue.enqueue({ kind: "chat", text: "a" });
  queue.enqueue({ kind: "shell", command: "echo b" });
  assert.equal(queue.hold("q0 failed"), true);
  assert.equal(queue.shift(), undefined);
  assert.equal(queue.length, 2);
  assert.match(queue.render(), /PAUSED \(q0 failed\); nothing runs until \/queue resume/);
  assert.equal(queue.resume(), true);
  assert.equal(queue.resume(), false);
  assert.equal(queue.shift()?.id, "q1");
  queue.hold("q1 failed");
  assert.equal(queue.remove("q2").ok, true);
  assert.equal(queue.held, null, "removing the last held entry ends the hold");
  queue.enqueue({ kind: "chat", text: "c" });
  queue.enqueue({ kind: "chat", text: "d" });
  queue.hold("q3 failed");
  const removed = queue.clear();
  assert.deepEqual(removed.map(e => e.id), ["q3", "q4"]);
  assert.equal(queue.length, 0);
  assert.equal(queue.held, null);
  const text = renderDisposition("Queue discarded (turn cancelled):", removed);
  assert.match(text, /q3 +chat +"c"\n {2}q4 +chat +"d"/);
  assert.equal(renderDisposition("nothing", []), "");
});

test("each entry shows its type and the shell-share binding explicitly", () => {
  assert.match(describeEntry({ kind: "shell", command: "npm test" }), /^!npm test \(local only; never sent to the model\)$/);
  assert.equal(describeEntry({ kind: "reset-shell" }), "/shell-reset");
  assert.match(describeEntry({ kind: "share", action: "preview" }), /stages the latest shell result at execution/);
  assert.match(describeEntry({ kind: "share", action: "drop", first: 2, last: 4 }), /^drop 2-4: acts on the staged preview/);
  assert.match(describeEntry({ kind: "share", action: "send", boundCommandId: "0123456789abcdef" }),
    /sends the preview you reviewed of command 01234567; refused if that preview is gone or replaced/);
  assert.match(describeEntry({ kind: "share", action: "cancel" }), /discards whatever preview is staged at execution/);
  // Terminal controls in queued text never reach the console verbatim.
  assert.doesNotMatch(describeEntry({ kind: "chat", text: "hi\x1b]52;c;payload\x07 there" }), /\x1b|\x07/);
  const queue = new ConsoleQueue();
  queue.enqueue({ kind: "chat", text: "c" });
  queue.enqueue({ kind: "shell", command: "ls" });
  queue.enqueue({ kind: "share", action: "send", boundCommandId: "abcdef0123" });
  const listing = queue.render();
  assert.match(listing, /q1 +chat /);
  assert.match(listing, /q2 +user shell +!ls/);
  assert.match(listing, /q3 +shell-share +send: sends the preview you reviewed of command abcdef01/);
  assert.match(listing, /Bound: 32 entries, 64 KiB \(3 B used\)/);
});
