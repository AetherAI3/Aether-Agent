// The REPL builds an AbortController per turn and aborts it on Ctrl+C, but
// runTurn dropped the signal on the local branch — it was accepted as a
// parameter and simply not passed on. Ctrl+C therefore did nothing to a local
// turn: the abort fired and nothing was listening.
//
// These drive runLocalTurn with an injected brain, so no Ollama server, no
// child process and no real tool execution is involved.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runLocalTurn } from "../src/commands/chat.js";
import type { AppContext } from "../src/core/context.js";
import type { Brain, TaskCommand } from "../src/core/brain.js";
import type { BrainEvent } from "../src/core/brain_protocol.js";
import type { ToolResult } from "../src/core/tool_executor.js";
import { MeaningfulProgressTimeoutError, ModelOutputLimitError, TurnDeadlineError } from "../src/core/errors.js";

/**
 * A brain that emits one tool_call and then parks forever, exactly like the
 * real one waiting on sendToolResult. close() is the only thing that frees it,
 * so a turn that ignores the abort signal never returns.
 */
class ParkingBrain implements Brain {
  closed = false;
  private release: (() => void) | null = null;

  run(_task: TaskCommand): AsyncIterable<BrainEvent> {
    const self = this;
    return (async function* (): AsyncGenerator<BrainEvent> {
      yield { type: "tool_call", id: "call-1", name: "read_file", args: { path: "a.ts" } };
      await new Promise<void>((resolve) => {
        if (self.closed) resolve();
        else self.release = resolve;
      });
      yield { type: "done", ok: true, result: "done", remaining: 0, reason: "" };
    })();
  }

  sendToolResult(_id: string, _result: ToolResult): void {}
  control(): void {}
  close(): void {
    this.closed = true;
    this.release?.();
    this.release = null;
  }
}

function ctx(): AppContext {
  return {
    cfg: { permissionMode: "skip", autoApply: true },
    flags: { cwd: process.cwd(), yes: true, json: true },
    confirm: async () => true,
  } as unknown as AppContext;
}

const noExec = {
  executeAsync: async (): Promise<ToolResult> => ({ output: "ok", exitCode: 0 }),
};

test("aborting a local turn closes the brain instead of waiting the turn out", async () => {
  const brain = new ParkingBrain();
  const controller = new AbortController();
  const turn = runLocalTurn(ctx(), "do a thing", controller.signal, { brain, exec: noExec });

  // Let the turn reach the parked tool call, then Ctrl+C.
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();

  // Without the signal wired through, this never settles.
  await turn;
  assert.equal(brain.closed, true, "abort must reach the brain");
});

test("a signal already aborted stops the turn rather than starting it", async () => {
  const brain = new ParkingBrain();
  const controller = new AbortController();
  controller.abort();
  await runLocalTurn(ctx(), "do a thing", controller.signal, { brain, exec: noExec });
  assert.equal(brain.closed, true);
});

test("an aborted local turn is not reported as a failed turn", async () => {
  // A user-requested stop is not an error, and must not surface as one.
  const brain = new ParkingBrain();
  const controller = new AbortController();
  const turn = runLocalTurn(ctx(), "do a thing", controller.signal, { brain, exec: noExec });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.doesNotReject(() => turn);
});

test("without a signal a local turn still completes normally", async () => {
  const brain = new ParkingBrain();
  const turn = runLocalTurn(ctx(), "do a thing", undefined, { brain, exec: noExec });
  await new Promise((resolve) => setTimeout(resolve, 20));
  brain.close(); // stand in for the real brain finishing its wait
  await turn;
  assert.equal(brain.closed, true);
});

test("a local brain parked before its first event is bounded and closed", async () => {
  let closes = 0;
  const brain: Brain = {
    run(): AsyncIterable<BrainEvent> {
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<BrainEvent>>(() => {}),
            return: () => { throw new Error("cleanup must not replace timeout"); },
          };
        },
      };
    },
    sendToolResult() {},
    control() {},
    close() { closes++; },
  };

  await assert.rejects(
    () => runLocalTurn(ctx(), "park forever", undefined, {
      brain,
      exec: noExec,
      meaningfulProgressTimeoutMs: 15,
    }),
    MeaningfulProgressTimeoutError,
  );
  assert.ok(closes >= 1, "timeout reaches brain cleanup");
});

test("a local tool that ignores abort cannot strand the turn", async () => {
  let toolSignal: AbortSignal | undefined;
  const brain: Brain = {
    run(): AsyncIterable<BrainEvent> {
      return (async function* (): AsyncGenerator<BrainEvent> {
        yield { type: "tool_call", id: "hung", name: "read_file", args: { path: "a.ts" } };
        await new Promise<void>(() => {});
      })();
    },
    sendToolResult() {},
    control() {},
    close() {},
  };
  const exec = {
    executeAsync: async (_name: string, _args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<ToolResult> => {
      toolSignal = options?.signal;
      return new Promise<ToolResult>(() => {});
    },
  };

  await assert.rejects(
    () => runLocalTurn(ctx(), "hung tool", undefined, {
      brain,
      exec,
      meaningfulProgressTimeoutMs: 15,
    }),
    MeaningfulProgressTimeoutError,
  );
  assert.equal(toolSignal?.aborted, true, "tool receives the same timed-out signal");
});

test("repeated local monologue with rising telemetry cannot extend progress", async () => {
  let closed = 0;
  const brain: Brain = {
    run: () => (async function* (): AsyncGenerator<BrainEvent> {
      for (let i = 0; i < 100; i += 1) {
        yield { type: "monologue", text: "repeated paragraph ".repeat(20), depth: 0 };
        yield { type: "telemetry", tokens: i, tps: 2, ctxUsed: i, ctxCap: 4096, vram: 1 };
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
      yield { type: "done", ok: true, result: "done", remaining: 0, reason: "" };
    })(),
    sendToolResult() {}, control() {}, close() { closed++; },
  };
  await assert.rejects(
    () => runLocalTurn(ctx(), "stop local loop", undefined, { brain, exec: noExec, meaningfulProgressTimeoutMs: 25 }),
    MeaningfulProgressTimeoutError,
  );
  assert.ok(closed >= 1);
});

test("a buffered local model cannot evade its absolute deadline", async () => {
  const brain: Brain = {
    run: () => (async function* (): AsyncGenerator<BrainEvent> {
      for (let i = 0; i < 20_000; i += 1) {
        yield { type: "monologue", text: `novel ${i}`, depth: 0 };
      }
      yield { type: "done", ok: true, result: "done", remaining: 0, reason: "" };
    })(),
    sendToolResult() {}, control() {}, close() {},
  };
  await assert.rejects(
    () => runLocalTurn(ctx(), "finite local turn", undefined, {
      brain, exec: noExec, meaningfulProgressTimeoutMs: 1000, deadlineAt: Date.now() + 1,
    }),
    TurnDeadlineError,
  );
});

test("local model output cap applies per segment", async () => {
  const brain: Brain = {
    run: () => (async function* (): AsyncGenerator<BrainEvent> {
      for (let i = 0; i < 20; i += 1) yield { type: "monologue", text: `unique section ${i}`, depth: 0 };
      yield { type: "done", ok: true, result: "done", remaining: 0, reason: "" };
    })(),
    sendToolResult() {}, control() {}, close() {},
  };
  await assert.rejects(
    () => runLocalTurn(ctx(), "bounded local output", undefined, {
      brain, exec: noExec, modelOutputLimitBytes: 60,
    }),
    ModelOutputLimitError,
  );
});
