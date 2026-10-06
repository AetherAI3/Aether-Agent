import { test } from "node:test";
import assert from "node:assert/strict";

import type { Brain, TaskCommand } from "../src/core/brain.js";
import type { BrainEvent } from "../src/core/brain_protocol.js";
import { MeaningfulProgressTimeoutError, ModelOutputLimitError, TurnDeadlineError } from "../src/core/errors.js";
import type { ToolExecutor } from "../src/core/tool_executor.js";
import type { ToolResult } from "../src/core/tool_executor.js";
import type { CheckReading, VerifyOutcome } from "../src/core/verify_gate.js";
import {
  CODE_MEANINGFUL_PROGRESS_TIMEOUT_ENV,
  DEFAULT_CODE_MEANINGFUL_PROGRESS_TIMEOUT_MS,
  CodeTurnLifecycle,
  codeMeaningfulProgressTimeoutMs,
  emitCodeTurnOutcome,
  hostLoop,
} from "../src/commands/code.js";

const task: TaskCommand = {
  type: "task",
  text: "test task",
  cwd: ".",
  poolGb: 5,
};

const GREEN_CHECK: VerifyOutcome = {
  status: "ok",
  remaining: 0,
  exitCode: 0,
  check: { state: "passed", exitCode: 0, failing: 0, reason: "npm test exited 0" },
};
const UNCONFIGURED_CHECK: CheckReading = {
  state: "unconfigured",
  exitCode: null,
  failing: null,
  reason: "no --test-cmd was given",
};
const failedCheck = (failing: number): CheckReading => ({
  state: "failed",
  exitCode: 1,
  failing,
  reason: "npm test exited 1",
});

const noExec = {
  executeAsync: async (): Promise<ToolResult> => ({ output: "", exitCode: 0 }),
} as unknown as ToolExecutor;

test("coding turn keeps one correlation id and brain done is advisory until host verification", () => {
  const prompt = "DO NOT COPY THIS PROMPT INTO JSON";
  const turn = new CodeTurnLifecycle(prompt, { id: "turn-code-fixed" });

  assert.equal(turn.lifecycle.state, "connecting");
  assert.deepEqual(turn.observe({ type: "stage", name: "execute", face: "" }), {
    accepted: true,
    meaningful: true,
  });
  assert.equal(turn.turnId, "turn-code-fixed");
  assert.equal(turn.lifecycle.state, "streaming");

  turn.observe({ type: "done", ok: true, result: "claimed success", remaining: 0, reason: "" });
  assert.equal(turn.lifecycle.state, "completing");
  assert.equal(turn.outcome, null, "a brain claim cannot finalize success");
  assert.equal(
    turn.observe({ type: "error", msg: "late error" }).accepted,
    false,
    "late frames cannot rewrite the terminal advisory",
  );

  const outcome = turn.settle(GREEN_CHECK);
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.turnId, "turn-code-fixed");
  assert.deepEqual(turn.settle({ status: "error", remaining: 9, exitCode: 1, check: failedCheck(9) }), outcome);

  let line = "";
  emitCodeTurnOutcome(turn.report!, true, (chunk) => {
    line += chunk;
  });
  const record = JSON.parse(line) as Record<string, unknown>;
  assert.equal(record["protocol"], "aether.turn/1");
  assert.equal(record["type"], "turn_outcome");
  assert.equal(record["turn_id"], "turn-code-fixed");
  assert.equal(record["state"], "succeeded");
  assert.equal(record["prompt_preserved"], true);
  assert.equal("prompt" in record, false);
  assert.equal(line.includes(prompt), false, "the terminal record must not duplicate prompt content");
});

test("coding turn refuses success for red, missing, or unavailable host verification", () => {
  const red = new CodeTurnLifecycle("red", { id: "turn-red" });
  red.observe({ type: "done", ok: true, result: "looks good", remaining: 0, reason: "" });
  assert.equal(
    red.settle({ status: "incomplete", remaining: 2, exitCode: 1, check: failedCheck(2) }).state,
    "incomplete",
  );

  const unverified = new CodeTurnLifecycle("no gate", { id: "turn-unverified" });
  unverified.observe({ type: "done", ok: true, result: "looks good", remaining: 0, reason: "unverified" });
  const unverifiedOutcome = unverified.settle({
    status: "unverified",
    remaining: 0,
    exitCode: -1,
    check: UNCONFIGURED_CHECK,
  });
  assert.equal(unverifiedOutcome.state, "incomplete");
  assert.equal(unverifiedOutcome.exitCode, 1);

  const missing = new CodeTurnLifecycle("missing", { id: "turn-missing-verify" });
  missing.observe({ type: "done", ok: true, result: "looks good", remaining: 0, reason: "" });
  assert.equal(missing.settle(null).state, "failed");
});

test("coding turn treats EOF and error as failures even when the checkout happens to verify green", () => {
  const eof = new CodeTurnLifecycle("eof", { id: "turn-eof" });
  eof.observe({ type: "monologue", text: "partial output", depth: 0 });
  eof.noteIncompleteEof();
  const eofOutcome = eof.settle(GREEN_CHECK);
  assert.equal(eofOutcome.state, "incomplete");
  assert.equal(eofOutcome.partialOutput, true);
  assert.match(eofOutcome.message, /terminal frame/i);

  const errored = new CodeTurnLifecycle("error", { id: "turn-error" });
  errored.observe({ type: "error", msg: "brain exploded" });
  const errorOutcome = errored.settle(GREEN_CHECK);
  assert.equal(errorOutcome.state, "failed");
  assert.match(errorOutcome.message, /brain exploded/i);
});

test("coding progress timeout config is finite and malformed values cannot disable it", () => {
  assert.equal(codeMeaningfulProgressTimeoutMs({}), DEFAULT_CODE_MEANINGFUL_PROGRESS_TIMEOUT_MS);
  assert.equal(codeMeaningfulProgressTimeoutMs({ [CODE_MEANINGFUL_PROGRESS_TIMEOUT_ENV]: "25" }), 25);
  assert.equal(
    codeMeaningfulProgressTimeoutMs({ [CODE_MEANINGFUL_PROGRESS_TIMEOUT_ENV]: "0" }),
    DEFAULT_CODE_MEANINGFUL_PROGRESS_TIMEOUT_MS,
  );
  assert.equal(
    codeMeaningfulProgressTimeoutMs({ [CODE_MEANINGFUL_PROGRESS_TIMEOUT_ENV]: "not-a-number" }),
    DEFAULT_CODE_MEANINGFUL_PROGRESS_TIMEOUT_MS,
  );
});

test("a long stream of novel model text keeps advancing after 256 frames", () => {
  const turn = new CodeTurnLifecycle("long answer");
  for (let i = 0; i < 400; i += 1) {
    assert.equal(
      turn.observe({ type: "monologue", text: `unique section ${i}: ${i * 7919}`, depth: 0 }).meaningful,
      true,
      `frame ${i} should still advance the progress clock`,
    );
  }
});

test("long model chunks with a shared prefix still advance when their suffix changes", () => {
  const turn = new CodeTurnLifecycle("long chunks");
  const sharedPrefix = "A".repeat(300);
  for (let i = 0; i < 30; i += 1) {
    assert.equal(
      turn.observe({ type: "monologue", text: `${sharedPrefix}\x1b[31mnew-${i}\x1b[0m`, depth: 0 }).meaningful,
      true,
      `chunk ${i} has new visible text beyond the shared prefix`,
    );
  }
});

test("novel prefixes remain progress even when long chunks share a repeated suffix", () => {
  const turn = new CodeTurnLifecycle("novel prefixes");
  const repeatedSuffix = "x".repeat(1_500);
  for (let i = 0; i < 30; i += 1) {
    assert.equal(
      turn.observe({ type: "monologue", text: `new section ${i}: ${repeatedSuffix}`, depth: 0 }).meaningful,
      true,
    );
  }
});

test("a repeated paragraph longer than 256 characters stops advancing progress", () => {
  const turn = new CodeTurnLifecycle("repeated paragraph");
  const paragraph = ("The agent should finish the response before repeating it. ").repeat(6).slice(0, 300);
  let stalled = false;
  for (let i = 0; i < 40; i += 1) {
    if (!turn.observe({ type: "monologue", text: paragraph, depth: 0 }).meaningful) stalled = true;
    assert.equal(turn.observe({ type: "telemetry", tokens: i + 1, ctxUsed: i + 1, ctxCap: 10_000, tps: 1, vram: 0 }).meaningful, false);
  }
  assert.equal(stalled, true);
});

test("sustained repeated model text stops advancing while ordinary repeated words do not", () => {
  const turn = new CodeTurnLifecycle("repeated answer");
  for (let i = 0; i < 20; i += 1) {
    assert.equal(turn.observe({ type: "monologue", text: "the", depth: 0 }).meaningful, true);
  }
  let stalled = false;
  for (let i = 0; i < 250; i += 1) {
    if (!turn.observe({ type: "monologue", text: "the", depth: 0 }).meaningful) stalled = true;
  }
  assert.equal(stalled, true, "a sustained repeated passage is no longer model progress");
  assert.equal(
    turn.observe({ type: "monologue", text: "novel answer content", depth: 0 }).meaningful,
    true,
    "new content must recover the progress clock",
  );
});

class CosmeticForeverBrain implements Brain {
  closed = 0;
  private stopped = false;

  run(_task: TaskCommand): AsyncIterable<BrainEvent> {
    const self = this;
    return (async function* (): AsyncGenerator<BrainEvent> {
      while (!self.stopped) {
        yield { type: "status", phase: "same", poolUsed: 1, poolCap: 10 };
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
    })();
  }

  sendToolResult(_id: string, _result: ToolResult): void {}
  control(): void {}
  close(): void {
    this.closed += 1;
    this.stopped = true;
  }
}

test("host loop times out duplicate cosmetic traffic, closes once, and delivers no late events", async () => {
  const brain = new CosmeticForeverBrain();
  const seen: BrainEvent[] = [];
  await assert.rejects(
    () => hostLoop(brain, noExec, (event) => {
      seen.push(event);
    }, task, undefined, undefined, undefined, {
      meaningfulProgressTimeoutMs: 40,
    }),
    MeaningfulProgressTimeoutError,
  );
  assert.equal(brain.closed, 1);
  assert.ok(seen.length > 1, "the fixture must prove cosmetic traffic was flowing");
  const atSettlement = seen.length;
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  assert.equal(seen.length, atSettlement, "a timed-out iterator cannot write after cleanup");
});

test("an endlessly novel coding segment hits its absolute deadline", async () => {
  let closed = 0;
  const brain = {
    run: () => (async function* (): AsyncGenerator<BrainEvent> {
      for (let i = 0; i < 200; i += 1) {
        yield { type: "monologue", text: `novel coding step ${i}`, depth: 0 };
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
      yield { type: "done", ok: true, result: "done", remaining: 0, reason: "" };
    })(),
    sendToolResult: () => {},
    control: () => {},
    close: () => { closed += 1; },
  } as Brain;
  await assert.rejects(
    () => hostLoop(brain, noExec, () => {}, task, undefined, undefined, undefined, {
      meaningfulProgressTimeoutMs: 200,
      modelSegmentTimeoutMs: 30,
    }),
    TurnDeadlineError,
  );
  assert.equal(closed, 1);
});

test("a coding model segment stops at its output cap before terminal done", async () => {
  let closed = 0;
  const brain = {
    run: () => (async function* (): AsyncGenerator<BrainEvent> {
      for (let i = 0; i < 20; i += 1) yield { type: "monologue", text: `novel coding section ${i}`, depth: 0 };
      yield { type: "done", ok: true, result: "done", remaining: 0, reason: "" };
    })(),
    sendToolResult: () => {}, control: () => {}, close: () => { closed++; },
  } as Brain;
  await assert.rejects(
    () => hostLoop(brain, noExec, () => {}, task, undefined, undefined, undefined, {
      modelOutputLimitBytes: 80,
    }),
    ModelOutputLimitError,
  );
  assert.equal(closed, 1);
});

class DoneThenLateToolBrain implements Brain {
  closed = 0;
  toolResults = 0;

  run(_task: TaskCommand): AsyncIterable<BrainEvent> {
    return (async function* (): AsyncGenerator<BrainEvent> {
      yield { type: "done", ok: true, result: "done", remaining: 0, reason: "" };
      yield { type: "tool_call", id: "late", name: "write_file", args: { path: "late.txt", content: "bad" } };
    })();
  }

  sendToolResult(_id: string, _result: ToolResult): void {
    this.toolResults += 1;
  }
  control(): void {}
  close(): void {
    this.closed += 1;
  }
}

test("host loop stops at the first terminal frame and cannot execute a late tool", async () => {
  const brain = new DoneThenLateToolBrain();
  const seen: string[] = [];
  const code = await hostLoop(brain, noExec, (event) => {
    seen.push(event.type);
  }, task);
  assert.equal(code, 0);
  assert.deepEqual(seen, ["done"]);
  assert.equal(brain.toolResults, 0);
  assert.equal(brain.closed, 1);
});

class ParkedBrainWithThrowingReturn implements Brain {
  closed = 0;

  run(_task: TaskCommand): AsyncIterable<BrainEvent> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<BrainEvent> {
        return {
          next: () => new Promise<IteratorResult<BrainEvent>>(() => {}),
          return: () => {
            throw new Error("cleanup must not replace the timeout");
          },
        };
      },
    };
  }
  sendToolResult(_id: string, _result: ToolResult): void {}
  control(): void {}
  close(): void {
    this.closed += 1;
  }
}

test("iterator cleanup cannot replace the meaningful-progress timeout", async () => {
  const brain = new ParkedBrainWithThrowingReturn();
  await assert.rejects(
    () => hostLoop(brain, noExec, () => {}, task, undefined, undefined, undefined, {
      meaningfulProgressTimeoutMs: 15,
    }),
    MeaningfulProgressTimeoutError,
  );
  assert.equal(brain.closed, 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

class HangingToolBrain implements Brain {
  closed = 0;
  results = 0;

  run(_task: TaskCommand): AsyncIterable<BrainEvent> {
    return (async function* (): AsyncGenerator<BrainEvent> {
      yield { type: "tool_call", id: "hung", name: "run_shell", args: { command: "hang" } };
      await new Promise<void>(() => {});
    })();
  }
  sendToolResult(_id: string, _result: ToolResult): void {
    this.results += 1;
  }
  control(): void {}
  close(): void {
    this.closed += 1;
  }
}

test("command cancellation reaches a hanging tool and settles only once", async () => {
  const brain = new HangingToolBrain();
  const controller = new AbortController();
  let toolSignal: AbortSignal | undefined;
  let toolStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    toolStarted = resolve;
  });
  const hangingExec = {
    executeAsync: async (
      _name: string,
      _args: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<ToolResult> => {
      toolSignal = options?.signal;
      toolStarted();
      return new Promise<ToolResult>(() => {});
    },
  } as unknown as ToolExecutor;

  const pending = hostLoop(brain, hangingExec, () => {}, task, undefined, undefined, undefined, {
    meaningfulProgressTimeoutMs: 1_000,
    signal: controller.signal,
  });
  await started;
  controller.abort(new DOMException("operator cancelled", "AbortError"));
  await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
  assert.equal(toolSignal, controller.signal);
  assert.equal(toolSignal?.aborted, true);
  assert.equal(brain.results, 0, "a late tool completion cannot be delivered after cancellation");
  assert.equal(brain.closed, 1);
});
