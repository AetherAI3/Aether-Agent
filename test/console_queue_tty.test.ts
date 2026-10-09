import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { repl, replLines } from "../src/commands/chat.js";
import { ConsoleShell } from "../src/commands/console_input.js";
import { ApiClient } from "../src/core/transport.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { historyPath } from "../src/core/history_store.js";
import type { AppContext } from "../src/core/context.js";
import type { TokenStore } from "../src/core/auth.js";

// Raw-TTY queue behaviour (#284). Every queue operation here happens while a
// hosted turn is still streaming; fetch is the only model path and the file
// system is the only process evidence.

const tokens = { get: async () => "fixture-token" } as unknown as TokenStore;
function context(root: string): AppContext {
  return {
    cfg: { ...DEFAULT_CONFIG, baseUrl: "https://stub.test", backend: "cloud", defaultModel: "", permissionMode: "ask", autoApply: false },
    flags: { cwd: root, json: true, yes: false, audit: false },
    tokens, api: new ApiClient("https://stub.test", tokens), confirm: async () => false,
  } as AppContext;
}
const turnResponse = (): Response => new Response('data: {"type":"delta","text":"answer"}\n\ndata: {"type":"done","uvt":0,"cents":0}\n\n', { headers: { "content-type": "text/event-stream" } });
/** A local shell command that leaves a file behind, valid in Bash and cmd. */
const touch = (name: string): string => `!"${process.execPath}" -e "require('fs').writeFileSync('${name}','x')"`;

interface Harness {
  root: string;
  bodies: string[];
  output: () => string;
  submit: (text: string) => void;
  type: (text: string) => void;
  until: (predicate: () => boolean, label: string) => Promise<void>;
  /** Wait for model call `n` to be in flight, then answer it. */
  answer: (n: number, response?: Response) => Promise<void>;
  waitForCall: (n: number) => Promise<void>;
}

async function withConsole(run: (h: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "aether-queue-tty-"));
  const oldFetch = globalThis.fetch;
  const oldWrite = process.stdout.write;
  const oldErrWrite = process.stderr.write;
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const raw = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
  const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  let output = "";
  const bodies: string[] = [];
  const responders: Array<(response: Response) => void> = [];
  let pending: Promise<number> | null = null;
  const until = async (predicate: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`TTY test timed out waiting for ${label}: ` + output.slice(-1500));
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
  // Wide enough that the composer never windows a draft behind a long temp-dir prompt.
  Object.defineProperty(process.stdout, "columns", { value: 400, configurable: true });
  process.stdout.write =((text: string | Uint8Array) => { output += String(text); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((text: string | Uint8Array) => { output += String(text); return true; }) as typeof process.stderr.write;
  globalThis.fetch = (async (url, init) => {
    if (!String(url).includes("/agent/chat/stream")) return Response.json({ models: [] });
    bodies.push(String(init?.body ?? ""));
    return await new Promise<Response>((resolve, reject) => {
      responders[bodies.length - 1] = resolve;
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  }) as typeof fetch;
  const submit = (text: string): void => { process.stdin.emit("data", Buffer.from(text + "\r")); };
  const type = (text: string): void => { process.stdin.emit("data", Buffer.from(text)); };
  const waitForCall = (n: number): Promise<void> => until(() => responders[n - 1] !== undefined, `model call ${n}`);
  const answer = async (n: number, response = turnResponse()): Promise<void> => {
    await waitForCall(n);
    responders[n - 1]!(response);
  };
  try {
    pending = repl(context(root), { noSkills: true });
    await until(() => output.includes("\x1b[?2004h"), "console ready");
    await run({ root, bodies, output: () => output, submit, type, until, answer, waitForCall });
    process.stdin.emit("data", Buffer.from("\x03")); // clear any draft
    submit("/exit"); process.stdin.emit("data", Buffer.from("\r"));
    assert.equal(await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error("TTY exit timed out")), 2000))]), 0);
    pending = null;
  } finally {
    for (const respond of responders) respond?.(turnResponse());
    if (pending) {
      process.stdin.emit("data", Buffer.from("\x03\x03\x04"));
      await Promise.race([pending.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
    }
    globalThis.fetch = oldFetch; process.stdout.write = oldWrite; process.stderr.write = oldErrWrite;
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty); else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    if (raw) Object.defineProperty(process.stdin, "setRawMode", raw); else delete (process.stdin as unknown as { setRawMode?: unknown }).setRawMode;
    if (columns) Object.defineProperty(process.stdout, "columns", columns); else delete (process.stdout as unknown as { columns?: number }).columns;
    rmSync(historyPath(root), { force: true }); rmSync(root, { recursive: true, force: true });
  }
}

const shellResults = (output: string): number => (output.match(/"type":"shell_result"/g) ?? []).length;

test("TTY: list, edit and remove mixed queued entries while a turn streams; removed entries make zero calls", async () => {
  await withConsole(async ({ root, bodies, output, submit, type, until, answer, waitForCall }) => {
    submit("first question");
    await waitForCall(1);

    // Type-ahead of every entry type while q1 streams.
    submit("second question");
    submit(touch("removed.txt"));
    submit(touch("kept.txt"));
    submit("third question");
    await until(() => output().includes("Queued q5 (chat"), "four entries queued");
    assert.match(output(), /⏳ Queued q2 \(chat, 1 pending\): "second question"/);
    // The preview is capped; a long runner path may hide the filename.
    // Execution and non-disclosure of the full command are checked below.
    assert.match(output(), /⏳ Queued q3 \(user shell, 2 pending\): !.*\(local only; never sent to the model\)/);

    // A send cannot queue without a reviewed preview to bind to.
    submit("/shell-result send");
    await until(() => output().includes("Not queued: a queued /shell-result send must bind"), "unbound send refused");
    assert.equal(bodies.length, 1);
    type("\x15"); // the refused draft stays in the composer; Ctrl+U clears it without cancelling q1

    submit("/queue");
    await until(() => output().includes("Queue: 4 pending"), "listing");
    const listing = output().slice(output().lastIndexOf("Queue: 4 pending"));
    assert.match(listing, /running {2}q1 +chat +"first question"/);
    assert.match(listing, /1\. +q2 +chat +"second question"/);
    assert.match(listing, /2\. +q3 +user shell +!/);
    assert.match(listing, /4\. +q5 +chat +"third question"/);

    // Invalid edits are rejected without reclassifying the entry.
    submit("/queue edit q2 " + touch("smuggled.txt"));
    await until(() => output().includes("q2 is a chat entry"), "chat→shell edit rejected");
    submit("/queue edit q4 plain words");
    await until(() => output().includes("q4 is a user shell entry; the replacement must be !<command>"), "shell→chat edit rejected");
    submit("/queue edit q1 changed");
    await until(() => output().includes("q1 is running and cannot be changed"), "running entry protected");

    submit("/queue edit q2 second question, revised");
    await until(() => output().includes("Edited q2 (chat, position kept)"), "chat edit");
    submit("/queue edit q4 " + touch("edited.txt"));
    await until(() => output().includes("Edited q4 (user shell, position kept)"), "shell edit");
    submit("/queue remove q3");
    await until(() => output().includes("Removed q3 (user shell); it will not run."), "shell removal");
    submit("/queue remove q5");
    await until(() => output().includes("Removed q5 (chat); it will not run."), "chat removal");
    type("draft stays");

    // None of that touched the model or a process.
    assert.equal(bodies.length, 1);
    assert.equal(shellResults(output()), 0);

    await answer(1);
    await answer(2);
    await until(() => shellResults(output()) === 1, "edited shell entry ran");
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(bodies.length, 2, "removed chat made zero model calls");
    assert.match(bodies[1]!, /second question, revised/);
    for (const body of bodies) assert.doesNotMatch(body, /third question|removed\.txt|kept\.txt|edited\.txt|smuggled/);
    assert.equal(existsSync(join(root, "removed.txt")), false, "removed shell made zero process calls");
    assert.equal(existsSync(join(root, "kept.txt")), false, "edited shell ran its replacement only");
    assert.equal(existsSync(join(root, "smuggled.txt")), false);
    assert.equal(existsSync(join(root, "edited.txt")), true);
    assert.match(output(), /→ Running queued q2 \(chat\): "second question, revised"/);
    await until(() => output().includes("draft stays"), "type-ahead draft repainted after the drain");

    // Queue management and shell text stay out of chat history.
    const history = existsSync(historyPath(root)) ? readFileSync(historyPath(root), "utf8") : "";
    assert.doesNotMatch(history, /\/queue|removed\.txt|edited\.txt/);
    assert.match(history, /second question/);
  });
});

test("TTY: a failed turn pauses pending entries until /queue resume; nothing silently resumes", async () => {
  await withConsole(async ({ root, bodies, output, submit, until, answer, waitForCall }) => {
    submit("will fail");
    await waitForCall(1);
    submit("after failure");
    submit(touch("held.txt"));
    await until(() => output().includes("Queued q3 (user shell"), "entries queued");
    await answer(1, Response.json({ detail: "insufficient UVT balance" }, { status: 402 }));
    await until(() => output().includes("Queue paused (q1 failed): 2 pending entries kept; none ran."), "pause disposition");
    const disposition = output().slice(output().lastIndexOf("Queue paused"));
    assert.match(disposition, /q2 +chat +"after failure"/);
    assert.match(disposition, /q3 +user shell +!/);
    assert.match(disposition, /\/queue resume runs them in order/);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(bodies.length, 1);
    assert.equal(existsSync(join(root, "held.txt")), false);

    // A new submission runs alone; the held entries stay held.
    process.stdin.emit("data", Buffer.from("\x03")); // clear the restored failed prompt
    submit("fresh question");
    await answer(2);
    await until(() => (output().match(/"type":"turn_outcome"/g) ?? []).length >= 1, "fresh turn finished");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(bodies.length, 2);
    assert.match(bodies[1]!, /fresh question/);
    assert.equal(existsSync(join(root, "held.txt")), false);
    submit("/queue list");
    await until(() => output().includes("Queue: 2 pending — PAUSED (q1 failed)"), "paused listing");

    submit("/queue resume");
    await until(() => output().includes("Queue resumed: 2 pending entries run in order."), "resume");
    await answer(3);
    await until(() => shellResults(output()) === 1, "held shell ran after resume");
    assert.match(bodies[2]!, /after failure/);
    assert.equal(existsSync(join(root, "held.txt")), true);
  });
});

test("TTY: cancelling a streaming turn discards and lists pending entries; none run", async () => {
  await withConsole(async ({ root, bodies, output, submit, until, waitForCall }) => {
    submit("long task");
    await waitForCall(1);
    submit("never sent");
    submit(touch("never.txt"));
    await until(() => output().includes("Queued q3 (user shell"), "entries queued");
    process.stdin.emit("data", Buffer.from("\x03"));
    await until(() => output().includes("Queue discarded (turn cancelled): 2 pending entries removed; none ran and none will resume."), "discard disposition");
    const disposition = output().slice(output().lastIndexOf("Queue discarded"));
    assert.match(disposition, /q2 +chat +"never sent"/);
    assert.match(disposition, /q3 +user shell +!/);
    await new Promise(resolve => setTimeout(resolve, 50));
    submit("/queue");
    process.stdin.emit("data", Buffer.from("\r")); // accept picker, then run
    await until(() => output().includes("Queue: 0 pending."), "empty after cancel");
    assert.equal(bodies.length, 1);
    assert.equal(existsSync(join(root, "never.txt")), false);
  });
});

test("a queued shell-share send only sends the preview it was bound to", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-queue-share-"));
  let output = "";
  const shell = new ConsoleShell(root, text => { output += text; });
  try {
    await shell.run({ kind: "shell", command: "echo FIRST" });
    shell.share({ kind: "share", action: "preview" });
    const first = shell.stagedCommandId();
    assert.ok(first);

    // A different binding sends nothing and keeps the reviewed preview.
    assert.deepEqual(shell.share({ kind: "share", action: "send", boundCommandId: "other-command" }), { kind: "empty" });
    assert.match(output, /bound to the preview of command other-command, but the staged preview is now command/);
    assert.equal(shell.stagedCommandId(), first);

    // Cancelled before the queued send runs: still nothing is sent.
    shell.share({ kind: "share", action: "cancel" });
    assert.deepEqual(shell.share({ kind: "share", action: "send", boundCommandId: first }), { kind: "empty" });
    assert.match(output, /which is no longer staged\. Nothing was sent\./);

    // A newer command re-staged: the old binding is refused.
    await shell.run({ kind: "shell", command: "echo SECOND" });
    shell.share({ kind: "share", action: "preview" });
    assert.notEqual(shell.stagedCommandId(), first);
    assert.deepEqual(shell.share({ kind: "share", action: "send", boundCommandId: first }), { kind: "empty" });

    // The matching binding sends exactly the reviewed preview.
    const sent = shell.share({ kind: "share", action: "send", boundCommandId: shell.stagedCommandId()! });
    assert.equal(sent.kind, "chat");
    assert.match((sent as { text: string }).text, /SECOND/);
    assert.doesNotMatch((sent as { text: string }).text, /FIRST/);
  } finally { shell.close(); rmSync(root, { recursive: true, force: true }); }
});

test("line mode has no pending queue: management explains itself and /queue <task> runs in order", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-queue-lines-"));
  const oldFetch = globalThis.fetch;
  const oldWrite = process.stdout.write;
  let output = "";
  let modelCalls = 0;
  process.stdout.write = ((text: string | Uint8Array) => { output += String(text); return true; }) as typeof process.stdout.write;
  globalThis.fetch = (async (url) => {
    if (String(url).includes("/agent/chat/stream")) modelCalls++;
    return Response.json({ models: [] });
  }) as typeof fetch;
  const input = new PassThrough();
  try {
    const session = replLines(context(root), { noSkills: true }, new ConsoleShell(root, text => { output += text; }, true), input);
    input.end(["/queue list", "/queue edit q1 something", "/queue clear", touch("ran.txt").replace("!", "/queue !"), ""].join("\n"));
    assert.equal(await session, 0);
    assert.equal((output.match(/Line mode has no pending queue/g) ?? []).length, 3);
    assert.equal(existsSync(join(root, "ran.txt")), true, "/queue <shell> runs as the next line");
    assert.equal(modelCalls, 0);
    assert.doesNotMatch(output, /\x1b\[/, "line mode does not render the ANSI slash picker");
  } finally {
    globalThis.fetch = oldFetch; process.stdout.write = oldWrite;
    rmSync(historyPath(root), { force: true }); rmSync(root, { recursive: true, force: true });
  }
});

test("TTY: leaving the console with held entries lists them as discarded", async () => {
  await withConsole(async ({ root, bodies, output, submit, until, answer, waitForCall }) => {
    submit("will fail");
    await waitForCall(1);
    submit(touch("abandoned.txt"));
    await until(() => output().includes("Queued q2 (user shell"), "entry queued");
    await answer(1, Response.json({ detail: "insufficient UVT balance" }, { status: 402 }));
    await until(() => output().includes("Queue paused (q1 failed)"), "pause disposition");
    process.stdin.emit("data", Buffer.from("\x03")); // clear the restored failed prompt
    submit("/exit"); process.stdin.emit("data", Buffer.from("\r"));
    await until(() => output().includes("Queue discarded (session ended): 1 pending entry removed; none ran and none will resume."), "exit disposition");
    assert.equal(bodies.length, 1);
    assert.equal(existsSync(join(root, "abandoned.txt")), false);
  });
});
