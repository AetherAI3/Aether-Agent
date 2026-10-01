import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
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
import type { ToolResult } from "../src/core/tool_executor.js";
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
  globalThis.fetch = (async (_url, init) => { bodies.push(String(init?.body ?? "")); return turnResponse(); }) as typeof fetch;
  process.stdout.write = ((text: string | Uint8Array) => { output += String(text); return true; }) as typeof process.stdout.write;
  try {
    const run = replLines(context(root), { noSkills: true }, shell, input);
    input.write("!cd subdir\n!export DEMO=local-only\n!printf '%s' \"$DEMO\" | cat\n!false\n!pwd\n!\n");
    while (!output.includes("usage: !<command>")) await new Promise(resolve => setTimeout(resolve, 5));
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

test("raw TTY queues shell while a model turn is busy, preserves the draft and never sends shell input to the model", { skip: !supported }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-console-tty-"));
  const oldFetch = globalThis.fetch;
  const oldWrite = process.stdout.write;
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
    process.stdin.emit("data", Buffer.from("new draft"));
    assert.equal(existsSync(join(root, "queued.txt")), false);
    release!(); release = null;
    await until(() => output.match(/"type":"shell_result"/g)?.length === 2);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(readFileSync(join(root, "queued.txt"), "utf8"), "queued-once");
    assert.equal(bodies.length, 1);
    assert.doesNotMatch(bodies[0]!, /queued-once|user-first|new draft/);
    assert.match(output, /new draft/);
    // Clear the retained draft before leaving, then exercise shell cancellation.
    process.stdin.emit("data", Buffer.from("\x03"));
    submit("!sleep 1; touch never-replayed");
    await until(() => output.includes('"command":"sleep 1; touch never-replayed"'));
    process.stdin.emit("data", Buffer.from("\x03"));
    await until(() => output.includes('"state":"cancelled"'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(existsSync(join(root, "never-replayed")), false);
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
    globalThis.fetch = oldFetch; process.stdout.write = oldWrite;
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty); else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    if (raw) Object.defineProperty(process.stdin, "setRawMode", raw); else delete (process.stdin as unknown as { setRawMode?: unknown }).setRawMode;
    rmSync(historyPath(root), { force: true }); rmSync(root, { recursive: true, force: true });
  }
});
