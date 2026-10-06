// Issue #285 on the local-chat path: runLocalTurn drives an OllamaBrain (or
// any brain) through its own tool loop, separate from hostLoop. The same
// repeated-failure budget must hold there — asserted on executions, approval
// prompts, delivered results and the settled turn outcome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { ChatTurnError, runLocalTurn } from "../src/commands/chat.js";
import { TOOL_FAILURE_BUDGET } from "../src/core/tool_failure_budget.js";
import { ToolExecutor, type ToolResult } from "../src/core/tool_executor.js";
import { OllamaBrain } from "../src/core/brain_ollama.js";
import type { AppContext } from "../src/core/context.js";
import type { Brain, TaskCommand } from "../src/core/brain.js";
import type { BrainEvent } from "../src/core/brain_protocol.js";
import type { ChatReply } from "../src/core/ollama.js";

type Call = { name: string; args: Record<string, unknown> };

class LoopingBrain implements Brain {
  readonly results: Array<{ id: string; result: ToolResult }> = [];
  readonly emitted: string[] = [];
  closed = false;
  private readonly waiting = new Map<string, (result: ToolResult) => void>();

  constructor(private readonly plan: (index: number) => Call | null, private readonly max = 40) {}

  async *run(_task: TaskCommand): AsyncIterable<BrainEvent> {
    for (let index = 0; index < this.max && !this.closed; index += 1) {
      const call = this.plan(index);
      if (!call) break;
      const id = `call-${index}`;
      const reply = new Promise<ToolResult>((resolve) => this.waiting.set(id, resolve));
      this.emitted.push(id);
      yield { type: "tool_call", id, name: call.name, args: call.args };
      await reply;
    }
    if (!this.closed) yield { type: "done", ok: true, result: "done", remaining: 0, reason: "" };
  }

  sendToolResult(id: string, result: ToolResult): void {
    this.results.push({ id, result });
    const resolve = this.waiting.get(id);
    this.waiting.delete(id);
    resolve?.(result);
  }

  control(): { accepted: boolean; state: "closed" } {
    return { accepted: false, state: "closed" };
  }

  close(): void {
    this.closed = true;
    for (const [id, resolve] of this.waiting) {
      this.waiting.delete(id);
      resolve({ output: "[aborted]", exitCode: 130 });
    }
  }
}

class FakeExec {
  readonly executed: Call[] = [];
  configuredTestCommand = "";
  shellContext = "s";
  shellCwd = ".";
  constructor(private readonly respond: (call: Call, attempt: number) => ToolResult) {}
  async executeAsync(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.executed.push({ name, args });
    return this.respond({ name, args }, this.executed.length);
  }
}

function root(): string {
  return mkdtempSync(join(tmpdir(), "aether-285-local-"));
}

function ctx(cwd: string, confirm: () => Promise<boolean> = async () => true, permissionMode = "skip"): AppContext {
  return {
    cfg: { permissionMode, autoApply: true },
    flags: { cwd, yes: permissionMode === "skip", json: true },
    confirm,
  } as unknown as AppContext;
}

/** Run with process.stdin reporting a TTY, so "ask" mode really prompts. */
async function withTty<T>(work: () => Promise<T>): Promise<T> {
  const before = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  try {
    return await work();
  } finally {
    if (before) Object.defineProperty(process.stdin, "isTTY", before);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

test("local turn: a repeated invalid call settles incomplete with the checkpoint's recovery", async () => {
  const cwd = root();
  const brain = new LoopingBrain(() => ({ name: "read_file", args: {} }));
  const exec = new FakeExec(() => ({ output: "should not run", exitCode: 0 }));
  await assert.rejects(runLocalTurn(ctx(cwd), "go", undefined, { brain, exec, meaningfulProgressTimeoutMs: 0 }), (err: unknown) => {
    assert.ok(err instanceof ChatTurnError);
    assert.equal(err.outcome?.state, "incomplete");
    assert.match(err.message, /stopped repeated tool failure: read_file \(no arguments\) failed or was refused 3×/);
    assert.match(err.outcome?.hint ?? "", /correct the read_file arguments/);
    assert.equal(err.outcome?.retryable, false);
    return true;
  });
  assert.equal(exec.executed.length, 0);
  assert.equal(brain.emitted.length, TOOL_FAILURE_BUDGET.invalid_arguments + 2, "fail, fail, refuse, stop");
  assert.deepEqual(brain.results.map((r) => r.id), brain.emitted, "every call id answered exactly once");
  assert.equal(brain.closed, true);
});

test("local turn: after a refusal, a corrected call runs and the turn succeeds", async () => {
  const cwd = root();
  const brain = new LoopingBrain((index) =>
    index < 3 ? { name: "read_file", args: {} } : index === 3 ? { name: "read_file", args: { path: "a.ts" } } : null,
  );
  const exec = new FakeExec(() => ({ output: "content", exitCode: 0 }));
  const outcome = await runLocalTurn(ctx(cwd), "go", undefined, { brain, exec, meaningfulProgressTimeoutMs: 0 });
  assert.equal(outcome.state, "succeeded");
  assert.match(brain.results[2]!.result.output, /^\[host refused repeat:/);
  assert.deepEqual(brain.results[3]!.result, { output: "content", exitCode: 0 });
  assert.equal(exec.executed.length, 1, "only the corrected call ran");
});

test("local turn: a denied action is put to the operator once, then stopped without a prompt", async () => {
  const cwd = root();
  let prompts = 0;
  const brain = new LoopingBrain(() => ({ name: "run_shell", args: { command: "git push --force" } }));
  const exec = new FakeExec(() => ({ output: "ran", exitCode: 0 }));
  await withTty(() =>
    assert.rejects(
      runLocalTurn(
        ctx(cwd, async () => {
          prompts += 1;
          return false;
        }, "ask"),
        "go",
        undefined,
        { brain, exec, meaningfulProgressTimeoutMs: 0 },
      ),
      ChatTurnError,
    ),
  );
  assert.equal(prompts, 1, "the operator answered once and was not asked again");
  assert.equal(exec.executed.length, 0);
  assert.match(brain.results.at(-1)!.result.output, /host stopped repeated failure/);
});

test("local turn: a stale patch is bounded and never writes", async () => {
  const cwd = root();
  writeFileSync(join(cwd, "a.txt"), "hello\n");
  const real = new ToolExecutor(cwd);
  let executions = 0;
  const exec = {
    executeAsync: (name: string, args: Record<string, unknown>, options?: Parameters<ToolExecutor["executeAsync"]>[2]) => {
      executions += 1;
      return real.executeAsync(name, args, options);
    },
    previewPatch: (args: Record<string, unknown>) => real.previewPatch(args),
    get shellCwd() {
      return real.shellCwd;
    },
    get shellContext() {
      return real.shellContext;
    },
    get configuredTestCommand() {
      return real.configuredTestCommand;
    },
  };
  const brain = new LoopingBrain(() => ({
    name: "patch_file",
    args: { path: "a.txt", expected_sha256: sha("old\n"), old_text: "hello", new_text: "bye" },
  }));
  try {
    await assert.rejects(runLocalTurn(ctx(cwd), "go", undefined, { brain, exec, meaningfulProgressTimeoutMs: 0 }), (err: unknown) => {
      assert.ok(err instanceof ChatTurnError);
      assert.match(err.outcome?.hint ?? "", /re-read the target/);
      return true;
    });
  } finally {
    real.close();
  }
  assert.equal(executions, TOOL_FAILURE_BUDGET.stale_precondition);
  assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "hello\n");
});

test("local turn: failed tests after each edit keep running; the fixed run succeeds", async () => {
  const cwd = root();
  writeFileSync(join(cwd, "impl.txt"), "broken\n");
  const exec = new FakeExec((call) => {
    if (call.name === "write_file") {
      writeFileSync(join(cwd, String(call.args["path"])), String(call.args["content"]));
      return { output: "[wrote]", exitCode: 0 };
    }
    return readFileSync(join(cwd, "impl.txt"), "utf8").trim() === "fixed"
      ? { output: "[exit 0]", exitCode: 0 }
      : { output: "[exit 1]\n1 failed", exitCode: 1 };
  });
  const brain = new LoopingBrain((index) => {
    if (index >= 10) return null;
    if (index % 2 === 1) return { name: "write_file", args: { path: "impl.txt", content: index === 9 ? "fixed\n" : `try ${index}\n` } };
    return { name: "run_tests", args: { command: "npm test" } };
  });
  const outcome = await runLocalTurn(ctx(cwd), "go", undefined, { brain, exec, meaningfulProgressTimeoutMs: 0 });
  assert.equal(outcome.state, "succeeded");
  assert.equal(exec.executed.filter((c) => c.name === "run_tests").length, 5);
});

test("local turn: a timed-out mutation is not replayed by the host", async () => {
  const cwd = root();
  const exec = new FakeExec(() => ({ output: "[timeout after 5s]", exitCode: 124 }));
  const brain = new LoopingBrain(() => ({ name: "run_shell", args: { command: "npm install" } }));
  await assert.rejects(runLocalTurn(ctx(cwd), "go", undefined, { brain, exec, meaningfulProgressTimeoutMs: 0 }), ChatTurnError);
  assert.equal(exec.executed.length, TOOL_FAILURE_BUDGET.unknown_outcome);
});

test("local turn: cancellation mid-cycle is a cancellation, not a checkpoint", async () => {
  const cwd = root();
  const controller = new AbortController();
  const exec = new FakeExec((_call, attempt) => {
    if (attempt === 2) controller.abort();
    return { output: "[exit 1]\nboom", exitCode: 1 };
  });
  const brain = new LoopingBrain(() => ({ name: "run_shell", args: { command: "false" } }));
  const outcome = await runLocalTurn(ctx(cwd), "go", controller.signal, { brain, exec, meaningfulProgressTimeoutMs: 0 });
  assert.equal(outcome.state, "cancelled");
  assert.ok(exec.executed.length <= 2, "nothing ran after the cancellation");
  assert.equal(brain.closed, true);
});

test("local turn: a model varying its failing call is stopped by the consecutive-failure streak", async () => {
  const cwd = root();
  const brain = new LoopingBrain((index) => ({ name: "read_file", args: { path: `guess-${index}.ts` } }));
  const exec = new FakeExec((call) => ({ output: `[no such file: ${String(call.args["path"])}]`, exitCode: 1 }));
  await assert.rejects(runLocalTurn(ctx(cwd), "go", undefined, { brain, exec, meaningfulProgressTimeoutMs: 0 }), (err: unknown) => {
    assert.ok(err instanceof ChatTurnError);
    assert.match(err.message, /8 tool calls failed in a row \(stopped at: read_file guess-8\.ts\)/);
    return true;
  });
  assert.equal(exec.executed.length, 8, "the ninth guess never ran");
});

test("local turn: the real OllamaBrain stuck on one call stops in four model turns, not 24", async () => {
  const cwd = root();
  let chats = 0;
  const brain = new OllamaBrain({
    chat: async (): Promise<ChatReply> => {
      chats += 1;
      return {
        role: "assistant",
        content: "",
        tool_calls: [{ id: `tc-${chats}`, function: { name: "list_directory", arguments: '{"path":"missing-dir"}' } }],
      } as unknown as ChatReply;
    },
  });
  const exec = new FakeExec(() => ({ output: "[no such directory: missing-dir]", exitCode: 1 }));
  await assert.rejects(runLocalTurn(ctx(cwd), "go", undefined, { brain, exec, meaningfulProgressTimeoutMs: 0 }), ChatTurnError);
  assert.equal(chats, 4);
  assert.equal(exec.executed.length, TOOL_FAILURE_BUDGET.invalid_arguments);
});
