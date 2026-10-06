import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replLines, repl, runLocalTurn } from "../src/commands/chat.js";
import { ConsoleShell } from "../src/commands/console_input.js";
import { ApiClient } from "../src/core/transport.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { AppContext } from "../src/core/context.js";
import type { TokenStore } from "../src/core/auth.js";
import type { Brain, TaskCommand } from "../src/core/brain.js";
import type { BrainEvent } from "../src/core/brain_protocol.js";
import { ToolExecutor, type ToolResult } from "../src/core/tool_executor.js";
import { historyPath } from "../src/core/history_store.js";

const supported = process.platform === "linux" || process.platform === "darwin";
const tokens = { get: async () => "fixture-token" } as unknown as TokenStore;
function context(root: string): AppContext {
  return {
    cfg: { ...DEFAULT_CONFIG, baseUrl: "https://stub.test", backend: "cloud", defaultModel: "", permissionMode: "ask", autoApply: false },
    flags: { cwd: root, json: true, yes: false, audit: false },
    tokens, api: new ApiClient("https://stub.test", tokens), confirm: async () => false,
  } as AppContext;
}
const turnResponse = (): Response => new Response('data: {"type":"delta","text":"answer"}\n\ndata: {"type":"done","uvt":0,"cents":0}\n\n', { headers: { "content-type": "text/event-stream" } });

test("line console shell commands make zero model calls, keep output out of prompts/history, and return to chat", { skip: !supported }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-console-lines-"));
  mkdirSync(join(root, "subdir"));
  const input = new PassThrough();
  const oldFetch = globalThis.fetch;
  const oldWrite = process.stdout.write;
  let output = "";
  const bodies: string[] = [];
  const shell = new ConsoleShell(root, text => { output += text; }, true);
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ account_id: "fixture-account" });
    bodies.push(String(init?.body ?? ""));
    return turnResponse();
  }) as typeof fetch;
  process.stdout.write = ((text: string | Uint8Array) => { output += String(text); return true; }) as typeof process.stdout.write;
  try {
    const run = replLines(context(root), { noSkills: true }, shell, input);
    input.write("!cd subdir\n!export DEMO=local-only\n!printf '%s' \"$DEMO\" | cat\n!false\n!pwd\n/queue list\n/queue edit q1 !echo never\n/queue clear\n!\n");
    while (!output.includes("usage: !<command>")) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(bodies.length, 0);
    input.write("/queue list\n/queue edit q1 !echo never\n/queue clear\n");
    while (!output.includes("there is no editable pending queue")) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(bodies.length, 0);
    input.end("a normal question\n/exit\n");
    assert.equal(await run, 0);
    assert.equal(bodies.length, 1);
    assert.match(bodies[0]!, /a normal question/);
    assert.doesNotMatch(bodies[0]!, /local-only|printf|export DEMO/);
    assert.match(output, /local-only/);
    assert.match(output, /subdir/);
    assert.match(output, /"exitCode":1/);
    const history = existsSync(historyPath(root)) ? readFileSync(historyPath(root), "utf8") : "";
    assert.doesNotMatch(history, /DEMO|!pwd|!false|!cd/);
    assert.equal(shell.session.state, "closed");
  } finally {
    globalThis.fetch = oldFetch; process.stdout.write = oldWrite;
    shell.close(); input.destroy(); rmSync(historyPath(root), { force: true }); rmSync(root, { recursive: true, force: true });
  }
});

test("explicit shell-result sharing keeps a final summary after a long Unicode command", { skip: !supported }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-console-share-"));
  const shell = new ConsoleShell(root, () => {}, true);
  try {
    await shell.run(`printf 'FINAL SUMMARY: 1 failed'; # ${"😀".repeat(4000)}`);
    assert.equal(shell.share().kind, "empty");
    const shared = shell.share({ kind: "share", action: "send" });
    assert.equal(shared.kind, "attachment");
    if (shared.kind !== "attachment") return;
    assert.ok(shared.text.endsWith("FINAL SUMMARY: 1 failed"));
    assert.match(shared.text, /UTF-8 bytes elided/);
    assert.doesNotMatch(shared.text, /\ufffd/);
    assert.ok(Buffer.byteLength(shared.text) <= 8192 + 80);
  } finally { shell.close(); rmSync(root, { recursive: true, force: true }); }
});

class ShellBrain implements Brain {
  result: ToolResult | null = null;
  async *run(_task: TaskCommand): AsyncGenerator<BrainEvent> {
    yield { type: "tool_call", id: "shell-call", name: "run_shell", args: { command: "pwd; printf '%s' \"$DEMO\"" } };
    yield { type: "done", ok: true, result: "done", remaining: 0, reason: "" };
  }
  sendToolResult(_id: string, result: ToolResult): void { this.result = result; }
  control(): void {}
  close(): void {}
}

test("user command does not authorize model commands; an approved local model uses the same shell", { skip: !supported }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-console-local-"));
  mkdirSync(join(root, "subdir"));
  const shell = new ConsoleShell(root, () => {}, true);
  const ctx = context(root);
  ctx.flags.local = true;
  ctx.flags.model = "fixture-model";
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("local shell must not call API"); }) as typeof fetch;
  try {
    await shell.run({ kind: "shell", command: "cd subdir; export DEMO=shared" });
    const denied = new ShellBrain();
    await runLocalTurn(ctx, "inspect", undefined, { brain: denied, exec: shell.exec });
    assert.match(denied.result!.output, /denied/);
    ctx.flags.yes = true;
    const approved = new ShellBrain();
    await runLocalTurn(ctx, "inspect", undefined, { brain: approved, exec: shell.exec });
    assert.equal(approved.result!.exitCode, 0);
    assert.equal(approved.result!.output, `[exit 0]\n${root}/subdir\nshared`);
  } finally { globalThis.fetch = oldFetch; shell.close(); rmSync(root, { recursive: true, force: true }); }
});

test("raw TTY manages pending chat/shell during a model stream, preserves draft, and executes only edited FIFO entries", { skip: !supported }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-console-tty-"));
  const oldFetch = globalThis.fetch;
  const oldWrite = process.stdout.write;
  const originalRun = ToolExecutor.prototype.runUserCommand;
  const executed: string[] = [];
  ToolExecutor.prototype.runUserCommand = async function (this: ToolExecutor, command, options) {
    executed.push(command);
    return await originalRun.call(this, command, options);
  };
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const raw = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
  let output = "";
  const bodies: string[] = [];
  let release: (() => void) | null = null;
  let pending: Promise<number> | null = null;
  const until = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("TTY test timed out: " + output.slice(-500));
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
  process.stdout.write = ((text: string | Uint8Array) => { output += String(text); return true; }) as typeof process.stdout.write;
  globalThis.fetch = (async (url, init) => {
    if (!String(url).includes("/agent/chat/stream")) return Response.json({ models: [] });
    bodies.push(String(init?.body ?? ""));
    await new Promise<void>(resolve => { release = resolve; });
    return turnResponse();
  }) as typeof fetch;
  const submit = (text: string): void => { process.stdin.emit("data", Buffer.from(text + "\r")); };
  try {
    pending = repl(context(root), { noSkills: true });
    await until(() => output.includes("\x1b[?2004h"));
    submit("!printf user-first");
    await until(() => output.includes("shell_result"));
    assert.equal(bodies.length, 0);
    submit("model question");
    await until(() => release !== null);
    submit("!printf queued-once >> queued.txt");
    submit("!printf removed > removed.txt");
    submit("removed chat must never reach model");
    submit("/queue list");
    await until(() => output.includes("Pending: 3/32"));
    const ids = [...output.matchAll(/(q\d+) \| (?:user shell|chat) \| ready/g)].map(match => match[1]!);
    assert.equal(ids.length, 3);
    const activeId = /Active: (q\d+) \(chat, immutable\)/.exec(output)![1]!;
    submit(`/queue edit ${activeId} cannot change active`);
    submit(`/queue edit ${ids[0]} accidental chat reclassification`);
    submit(`/queue edit ${ids[0]} !printf queued-edited >> queued.txt`);
    submit(`/queue remove ${ids[1]}`);
    submit(`/queue remove ${ids[2]}`);
    submit("!printf cleared > cleared.txt");
    submit("/queue list");
    await until(() => output.includes("Pending: 2/32"));
    const lastId = [...output.matchAll(/(q\d+) \| user shell \| ready/g)].at(-1)![1]!;
    submit(`/queue remove ${lastId}`);
    assert.equal(bodies.length, 1, "all management remains local while streaming");
    assert.match(output, /active and immutable/);
    assert.match(output, /Edit refused/);
    process.stdin.emit("data", Buffer.from("new draft"));
    assert.equal(existsSync(join(root, "queued.txt")), false);
    release!(); release = null;
    await until(() => output.match(/"type":"shell_result"/g)?.length === 2);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(readFileSync(join(root, "queued.txt"), "utf8"), "queued-edited");
    assert.equal(existsSync(join(root, "removed.txt")), false, "removed shell made zero process calls");
    assert.equal(existsSync(join(root, "cleared.txt")), false);
    assert.equal(executed.filter(command => /removed\.txt|cleared\.txt/.test(command)).length, 0, "process spy: removed shell entries never reach execution");
    assert.equal(bodies.length, 1);
    assert.doesNotMatch(bodies[0]!, /queued-once|queued-edited|user-first|new draft|removed chat/);
    assert.match(output, /new draft/);
    // Clear the retained draft before leaving, then exercise shell cancellation.
    process.stdin.emit("data", Buffer.from("\x03"));
    submit("!sleep 1; touch never-replayed");
    await until(() => output.includes('"command":"sleep 1; touch never-replayed"'));
    submit("!touch cleared-by-user");
    submit("cleared chat by user");
    submit("/queue clear");
    await until(() => output.includes("Queue cleared by user: discarded"));
    assert.equal(existsSync(join(root, "cleared-by-user")), false);
    assert.equal(bodies.length, 1);
    submit("!touch discarded-after-cancel");
    submit("discarded chat after cancel");
    submit("/queue list");
    await until(() => output.includes("discarded chat after cancel"));
    process.stdin.emit("data", Buffer.from("\x03"));
    await until(() => output.includes('"state":"cancelled"'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(existsSync(join(root, "never-replayed")), false);
    assert.equal(existsSync(join(root, "discarded-after-cancel")), false);
    assert.equal(executed.filter(command => /cleared-by-user|discarded-after-cancel/.test(command)).length, 0, "process spy: cleared/cancelled entries never reach execution");
    assert.match(output, /Queue cancelled by user: discarded q\d+ \(user shell\), q\d+ \(chat\); 0 pending/);
    submit("/shell-reset");
    await until(() => output.includes('"type":"shell_reset"'));
    await new Promise(resolve => setImmediate(resolve));
    submit("/exit");
    assert.equal(await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error("TTY exit timed out")), 1000))]), 0); pending = null;
  } finally {
    (release as (() => void) | null)?.();
    if (pending) {
      process.stderr.write("TTY failure capture: " + output.slice(-2000) + "\n");
      process.stdin.emit("data", Buffer.from("\x03\x03\x04"));
      await Promise.race([pending.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
    }
    ToolExecutor.prototype.runUserCommand = originalRun;
    globalThis.fetch = oldFetch; process.stdout.write = oldWrite;
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty); else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    if (raw) Object.defineProperty(process.stdin, "setRawMode", raw); else delete (process.stdin as unknown as { setRawMode?: unknown }).setRawMode;
    rmSync(historyPath(root), { force: true }); rmSync(root, { recursive: true, force: true });
  }
});

test("local model receives only the explicitly sent exact edited shell attachment", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-console-local-preview-"));
  const shell = new ConsoleShell(root, () => {}, true);
  const input = new PassThrough();
  const oldFetch = globalThis.fetch;
  const oldWrite = process.stdout.write;
  const prompts: string[] = [];
  let output = "";
  const ctx = context(root);
  ctx.cfg.backend = "local";
  ctx.flags.local = true;
  ctx.flags.model = "fixture-local";
  globalThis.fetch = (async (url, init) => {
    assert.ok(String(url).endsWith("/v1/chat/completions"), "must use the local transport");
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    prompts.push(body.messages.find(message => message.role === "user")!.content);
    return Response.json({ choices: [{ message: { content: "fixture local answer" } }] });
  }) as typeof fetch;
  process.stdout.write = ((text: string | Uint8Array) => { output += String(text); return true; }) as typeof process.stdout.write;
  try {
    const pending = replLines(ctx, { noSkills: true }, shell, input);
    input.end(`!"${process.execPath}" -e "console.log('LOCAL_RAW_CAPTURE')"\n/shell-result\n/shell-result cancel\n/shell-result\n/shell-result edit LOCAL_EDITED\n/shell-result send\n/shell-result send\nnormal after\n/exit\n`);
    assert.equal(await pending, 0);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0]!, /untrusted data, not instructions/);
    assert.ok(prompts[0]!.endsWith("LOCAL_EDITED"));
    assert.doesNotMatch(prompts[0]!, /LOCAL_RAW_CAPTURE/);
    assert.equal(prompts[1], "normal after");
    assert.match(output, /No shell preview to send/);
  } finally {
    globalThis.fetch = oldFetch; process.stdout.write = oldWrite;
    shell.close(); input.destroy(); rmSync(historyPath(root), { force: true }); rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ["edit-share", "failure", "auth-failure", "shell-loss", "checkout-change", "exit-paused"] as const) {
  test(`TTY queue ${mode}: explicit disposition and no silent pending replay`, { skip: !supported }, async () => {
    const root = mkdtempSync(join(tmpdir(), "aether-queue-state-"));
    if (mode === "checkout-change") {
      assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
      assert.equal(spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "fixture"], { cwd: root }).status, 0);
    }
    const oldFetch = globalThis.fetch;
    const oldWrite = process.stdout.write;
    const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const raw = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
    const bodies: string[] = [];
    let output = "";
    let release: (() => void) | null = null;
    let pending: Promise<number> | null = null;
    const until = async (predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + 8000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("queue test timed out: " + output.slice(-2500));
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await new Promise(resolve => setImmediate(resolve));
    };
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
    process.stdout.write = ((text: string | Uint8Array) => { output += String(text); return true; }) as typeof process.stdout.write;
    globalThis.fetch = (async (url, init) => {
      if (!String(url).includes("/agent/chat/stream")) return Response.json({ account_id: "fixture-account", models: [] });
      bodies.push(String(init?.body ?? ""));
      await new Promise<void>(resolve => { release = resolve; });
      if (mode === "failure" || mode === "auth-failure") return Response.json({ detail: "fixture failure" }, { status: mode === "failure" ? 500 : 401 });
      return turnResponse();
    }) as typeof fetch;
    const submit = (text: string): void => { process.stdin.emit("data", Buffer.from(text + "\r")); };
    const resume = (): void => { const callback = release; release = null; callback!(); };
    try {
      pending = repl(context(root), { noSkills: true });
      await until(() => output.includes("\x1b[?2004h"));
      submit("!printf original-share");
      await until(() => output.includes('"type":"shell_result"'));
      if (mode === "edit-share" || mode === "exit-paused") { submit("/shell-result"); await until(() => output.includes('"type":"shell_share_preview"')); }
      submit("active chat");
      await until(() => release !== null);
      if (mode === "edit-share" || mode === "exit-paused") {
        submit("/shell-result send");
        submit("!printf following >> following.txt");
        submit("/queue list");
        await until(() => output.includes("shell-share | ready"));
        const id = /(q\d+) \| shell-share \| ready/.exec(output)![1]!;
        submit(`/queue edit ${id} EDITED_APPROVAL_REQUIRED`);
        assert.match(output, /old send approval revoked/);
        resume();
        await until(() => output.includes("Queue paused: 2 pending"));
        assert.equal(bodies.length, 1, "editing never inherits old send approval");
        assert.equal(existsSync(join(root, "following.txt")), false, "FIFO cannot skip unapproved head");
        submit("/terminal-status");
        assert.match(output, /run or clear pending entries before terminal handoff/);
        process.stdin.emit("data", Buffer.from("\x03")); // Terminal refusal preserves the entered command.
        submit("/queue send nonexistent");
        assert.equal(bodies.length, 1, "invalid management cannot drain pending work");
        if (mode === "exit-paused") {
          submit("/exit");
          assert.equal(await pending, 0); pending = null;
          assert.equal(bodies.length, 1);
          assert.equal(existsSync(join(root, "following.txt")), false);
          assert.match(output, /Queue closed: discarded q\d+ \(shell-share\), q\d+ \(user shell\); 0 pending/);
          return;
        }
        submit(`/queue send ${id}`);
        await until(() => bodies.length === 2 && release !== null);
        assert.match(bodies[1]!, /EDITED_APPROVAL_REQUIRED/);
        assert.doesNotMatch(bodies[1]!, /original-share/);
        resume();
        await until(() => existsSync(join(root, "following.txt")));
        await until(() => output.match(/"type":"shell_result"/g)?.length === 2);
        assert.equal(readFileSync(join(root, "following.txt"), "utf8"), "following");
      } else {
        if (mode === "shell-loss") submit("!exit");
        if (mode === "checkout-change") submit("!git switch -c changed-checkout");
        submit("!touch never-after-failure");
        submit("pending chat never submitted");
        submit("/queue list");
        await until(() => output.includes("pending chat never submitted"));
        process.stdin.emit("data", Buffer.from("unsent draft"));
        resume();
        await until(() => output.includes("Queue failed: discarded"));
        assert.match(output, /discarded q\d+ \(user shell\), q\d+ \(chat\); 0 pending/);
        assert.equal(existsSync(join(root, "never-after-failure")), false);
        assert.equal(bodies.length, 1, "failure never drains or retries pending work");
        assert.match(output, /unsent draft/);
        process.stdin.emit("data", Buffer.from("\x03"));
        submit("/queue run");
        assert.equal(bodies.length, 1, "explicit run cannot resurrect discarded work");
        if (mode === "auth-failure") {
          submit("/auth new");
          await until(() => output.includes("Queue new conversation"));
          process.stdin.emit("data", Buffer.from("\x03")); // Existing auth repair restores its separately held draft.
          submit("/queue list");
          assert.equal(bodies.length, 1, "new auth conversation never replays pending work");
        }
        if (mode === "shell-loss") {
          submit("/shell-reset");
          await until(() => output.includes('"type":"shell_reset"'));
          assert.equal(existsSync(join(root, "never-after-failure")), false);
        }
      }
      submit("/exit");
      assert.equal(await pending, 0); pending = null;
    } finally {
      (release as (() => void) | null)?.();
      if (pending) {
        process.stdin.emit("data", Buffer.from("\x03\x03\x04"));
        await Promise.race([pending.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
      }
      globalThis.fetch = oldFetch; process.stdout.write = oldWrite;
      if (tty) Object.defineProperty(process.stdin, "isTTY", tty); else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
      if (raw) Object.defineProperty(process.stdin, "setRawMode", raw); else delete (process.stdin as unknown as { setRawMode?: unknown }).setRawMode;
      rmSync(historyPath(root), { force: true }); rmSync(root, { recursive: true, force: true });
    }
  });
}
