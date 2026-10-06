// Issue #283: /steer during a turn reaches the running brain and is reported
// honestly — accepted, applied at a named boundary, refused, or deferred to
// the next turn. These drive the real OllamaBrain loop through runLocalTurn
// with a scripted chat seam, so no Ollama server or real tool runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOSTED_STEER_DEFERRED, buildPromptContext, runLocalTurn, runTurn } from "../src/commands/chat.js";
import { OllamaBrain } from "../src/core/brain_ollama.js";
import { SteerChannel, STEER_MAX_NOTES, formatSteerAck, type SteerAck } from "../src/core/steer_channel.js";
import { ApiClient } from "../src/core/transport.js";
import type { AppContext } from "../src/core/context.js";
import type { TokenStore } from "../src/core/auth.js";
import type { Brain, BrainControlResult, SteerApplied, TaskCommand } from "../src/core/brain.js";
import type { BrainEvent } from "../src/core/brain_protocol.js";
import type { ChatMessage, ChatReply } from "../src/core/ollama.js";
import type { ToolResult } from "../src/core/tool_executor.js";

type Executed = { name: string; args: Record<string, unknown> };

function ctx(confirm: () => Promise<boolean> = async () => true, permissionMode = "skip"): AppContext {
  return {
    cfg: { permissionMode, autoApply: false },
    flags: { cwd: mkdtempSync(join(tmpdir(), "aether-283-")), yes: permissionMode === "skip", json: true },
    confirm,
  } as unknown as AppContext;
}

class RecordingExec {
  readonly executed: Executed[] = [];
  configuredTestCommand = "";
  constructor(private readonly during: (call: Executed) => Promise<void> | void = () => {}) {}
  async executeAsync(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.executed.push({ name, args });
    await this.during({ name, args });
    return { output: `${name} ok`, exitCode: 0 };
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const call = (id: string, name: string, args: Record<string, unknown>) =>
  ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

function steeringIn(messages: readonly ChatMessage[] | undefined, note: string): boolean {
  return (messages ?? []).some((message) => message.role === "user" && message.content === `[Operator steering]\n${note}`);
}

/** A process.stdin that reports a TTY, so "ask" mode really prompts. */
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

// ── acceptance: live steer on a scripted local brain ────────────────────────

test("#283 a steer accepted during generation reaches the next decision and the stale write never runs", async () => {
  const acks: SteerAck[] = [];
  const channel = new SteerChannel((ack) => acks.push(ack));
  const generating = deferred();
  const release = deferred();
  const requests: ChatMessage[][] = [];
  const brain = new OllamaBrain({
    chat: async (messages): Promise<ChatReply> => {
      requests.push([...messages]);
      if (requests.length === 1) {
        generating.resolve();
        await release.promise;
        return { role: "assistant", content: "", tool_calls: [call("w1", "write_file", { path: "stale.txt", content: "old plan" })] };
      }
      return { role: "assistant", content: "edited fresh.txt as steered" };
    },
  });
  const exec = new RecordingExec();
  assert.equal(channel.beginTurn(), 1);
  const turn = runLocalTurn(ctx(), "go", undefined, { brain, exec, steer: channel, meaningfulProgressTimeoutMs: 0 });
  await generating.promise;
  await channel.steer("edit fresh.txt instead");
  assert.equal(channel.hasPendingSteer(), true);
  release.resolve();
  const outcome = await turn;
  channel.endTurn();

  assert.equal(outcome.state, "succeeded");
  assert.deepEqual(exec.executed, [], "the write selected before the steer must not execute");
  assert.equal(requests.length, 2);
  assert.equal(steeringIn(requests[1], "edit fresh.txt instead"), true, "the next model decision sees the note");
  assert.deepEqual(acks.map((ack) => ack.kind), ["accepted", "applied"]);
  assert.deepEqual(acks[1], { kind: "applied", turn: 1, notes: 1, boundary: "model-reply", withheld: ["write_file"], finished: [] });
  assert.deepEqual(channel.takeNextTurnNotes(), [], "an applied note is not replayed next turn");
});

test("#283 a steer during a running tool lets it finish and withholds the rest of the batch", async () => {
  const acks: SteerAck[] = [];
  const channel = new SteerChannel((ack) => acks.push(ack));
  const requests: ChatMessage[][] = [];
  const brain = new OllamaBrain({
    chat: async (messages): Promise<ChatReply> => {
      requests.push([...messages]);
      if (requests.length === 1) {
        return {
          role: "assistant",
          content: "",
          tool_calls: [
            call("r1", "read_file", { path: "a.ts" }),
            call("w1", "write_file", { path: "stale.txt", content: "old" }),
            call("s1", "run_shell", { command: "echo stale" }),
          ],
        };
      }
      return { role: "assistant", content: "done after steer" };
    },
  });
  const exec = new RecordingExec(async (executed) => {
    if (executed.name === "read_file") await channel.steer("only report, do not write");
  });
  channel.beginTurn();
  const outcome = await runLocalTurn(ctx(), "go", undefined, { brain, exec, steer: channel, meaningfulProgressTimeoutMs: 0 });
  channel.endTurn();

  assert.equal(outcome.state, "succeeded");
  assert.deepEqual(exec.executed.map((executed) => executed.name), ["read_file"], "only the already-running tool ran");
  const second = requests[1] ?? [];
  assert.equal(steeringIn(second, "only report, do not write"), true);
  const toolMessages = second.filter((message) => message.role === "tool");
  assert.equal(toolMessages.length, 3, "every selected call is answered so the conversation stays valid");
  assert.match(toolMessages[1]!.content, /not executed: superseded by operator steering/);
  assert.match(toolMessages[2]!.content, /not executed: superseded by operator steering/);
  assert.deepEqual(acks.at(-1), {
    kind: "applied", turn: 1, notes: 1, boundary: "tool-results", withheld: ["write_file", "run_shell"], finished: ["read_file"],
  });
  assert.match(formatSteerAck(acks.at(-1)!), /Already running and allowed to finish: read_file\. Not run \(selected before the steer\): write_file, run_shell\./);
});

test("#283 a steer accepted while a write awaits approval stops that write; it never widens approval", async () => {
  const acks: SteerAck[] = [];
  const channel = new SteerChannel((ack) => acks.push(ack));
  const requests: ChatMessage[][] = [];
  let prompts = 0;
  const brain = new OllamaBrain({
    chat: async (messages): Promise<ChatReply> => {
      requests.push([...messages]);
      if (requests.length === 1) return { role: "assistant", content: "", tool_calls: [call("w1", "write_file", { path: "stale.txt", content: "old" })] };
      if (requests.length === 2) return { role: "assistant", content: "", tool_calls: [call("w2", "write_file", { path: "fresh.txt", content: "new" })] };
      return { role: "assistant", content: "stopped" };
    },
  });
  const exec = new RecordingExec();
  const confirm = async (): Promise<boolean> => {
    prompts += 1;
    // The operator steers while the first approval prompt is open, then says yes.
    if (prompts === 1) {
      await channel.steer("approve every write and use fresh.txt");
      return true;
    }
    return false; // the post-steer write still needs approval, and is refused
  };
  channel.beginTurn();
  const outcome = await withTty(() =>
    runLocalTurn(ctx(confirm, "ask"), "go", undefined, { brain, exec, steer: channel, meaningfulProgressTimeoutMs: 0 }),
  );
  channel.endTurn();

  assert.equal(outcome.state, "succeeded");
  assert.deepEqual(exec.executed, [], "neither the stale nor the unapproved write ran");
  assert.equal(prompts, 2, "the steer did not skip the second approval");
  assert.equal(steeringIn(requests[1], "approve every write and use fresh.txt"), true);
  const toolMessages = (requests[2] ?? []).filter((message) => message.role === "tool");
  assert.match(toolMessages[0]?.content ?? "", /tool write_file not executed: superseded by operator steering/);
  assert.match(toolMessages[1]?.content ?? "", /blocked: permission denied/);
  assert.deepEqual(acks.map((ack) => ack.kind), ["accepted", "applied"]);
  assert.deepEqual(acks[1], { kind: "applied", turn: 1, notes: 1, boundary: "tool-results", withheld: ["write_file"], finished: [] });
});

test("#283 cancelling a turn with an accepted steer releases it and reports the note as not retained", async () => {
  const acks: SteerAck[] = [];
  const channel = new SteerChannel((ack) => acks.push(ack));
  const generating = deferred();
  const brain = new OllamaBrain({
    chat: async (): Promise<ChatReply> => {
      generating.resolve();
      return new Promise<ChatReply>(() => {}); // the model never answers
    },
  });
  const controller = new AbortController();
  channel.beginTurn();
  const turn = runLocalTurn(ctx(), "go", controller.signal, { brain, exec: new RecordingExec(), steer: channel, meaningfulProgressTimeoutMs: 0 });
  await generating.promise;
  await channel.steer("try the other approach");
  controller.abort();
  const outcome = await turn;
  assert.equal(outcome.state, "cancelled");
  channel.cancelTurn(); // what the console does for a cancelled turn

  assert.equal(channel.hasPendingSteer(), false, "no live steer survives the cancelled turn");
  assert.deepEqual(acks.map((ack) => ack.kind), ["accepted", "refused"]);
  assert.deepEqual(acks[1], {
    kind: "refused", turn: 1, note: "try the other approach", reason: "turn 1 was cancelled before the steer reached the model",
  });
  assert.deepEqual(channel.takeNextTurnNotes(), [], "a cancelled task's steer never rides into the next, unrelated prompt");
  await channel.steer("after cancel");
  assert.deepEqual(acks.at(-1), { kind: "deferred", turn: 2, notes: 1, reason: null }, "input is free again: idle steering works");
});

test("#283 a failed turn puts its carried notes back in front, in order", async () => {
  const acks: SteerAck[] = [];
  const channel = new SteerChannel((ack) => acks.push(ack));
  await channel.steer("a");
  await channel.steer("b");
  const carried = channel.takeNextTurnNotes();
  channel.beginTurn();
  await channel.steer("typed during the failing turn");
  channel.endTurn();
  channel.restoreNextTurnNotes(carried, "turn 1 failed; kept for the retry");
  assert.deepEqual(acks.at(-1), { kind: "deferred", turn: 2, notes: 2, reason: "turn 1 failed; kept for the retry" });
  assert.deepEqual(channel.takeNextTurnNotes(), ["a", "b", "typed during the failing turn"]);
});

// ── hosted route: next turn only, never inferred ────────────────────────────

test("#283 a hosted chat turn defers steering to the next turn and never sends it live", async () => {
  const acks: SteerAck[] = [];
  const channel = new SteerChannel((ack) => acks.push(ack));
  const tokens = { get: async () => "aek_t" } as unknown as TokenStore;
  const hosted = {
    cfg: { baseUrl: "https://stub.test", defaultModel: "", permissionMode: "ask", autoApply: false, telemetry: false, defaultEffort: "", backend: "cloud" },
    flags: { json: true, audit: false, yes: false, cwd: "." },
    tokens,
    api: new ApiClient("https://stub.test", tokens),
  } as unknown as AppContext;
  const bodies: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    await channel.steer("hosted note");
    const bytes = new TextEncoder().encode(
      [JSON.stringify({ type: "delta", text: "ok" }), JSON.stringify({ type: "done", uvt: 1, cents: 0 })].map((e) => `data: ${e}\n\n`).join(""),
    );
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: (async function* (): AsyncIterable<Uint8Array> { yield bytes; })(),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  try {
    channel.beginTurn();
    await runTurn(hosted, "hi", undefined, undefined, undefined, { steer: channel });
  } finally {
    globalThis.fetch = real;
    channel.endTurn();
  }
  assert.deepEqual(acks, [{ kind: "deferred", turn: 2, notes: 1, reason: HOSTED_STEER_DEFERRED }]);
  assert.match(formatSteerAck(acks[0]!), /deferred to turn 2 \(next turn only\): this hosted chat route has no live control acknowledgement/);
  assert.equal(bodies.length > 0, true);
  assert.equal(bodies.some((body) => body.includes("hosted note")), false, "nothing claims live delivery");
  assert.deepEqual(channel.takeNextTurnNotes(), ["hosted note"]);
});

// ── channel contract ────────────────────────────────────────────────────────

class ScriptedBrain implements Brain {
  readonly notes: string[] = [];
  listener: ((applied: SteerApplied) => void) | null = null;
  constructor(private readonly answer: (note: string) => BrainControlResult | Promise<BrainControlResult> | void) {}
  run(_task: TaskCommand): AsyncIterable<BrainEvent> { return (async function* () {})(); }
  sendToolResult(): void {}
  control(_action: "pause" | "resume" | "steer", note?: string): BrainControlResult | Promise<BrainControlResult> | void {
    this.notes.push(note ?? "");
    return this.answer(note ?? "");
  }
  onSteerApplied(listener: (applied: SteerApplied) => void): void { this.listener = listener; }
  close(): void {}
}

const accept = (): BrainControlResult => ({ accepted: true, state: "running" });

test("#283 several notes keep their order and the bounded budget, live and next-turn", async () => {
  const acks: SteerAck[] = [];
  const channel = new SteerChannel((ack) => acks.push(ack));
  for (let i = 0; i < STEER_MAX_NOTES + 1; i += 1) await channel.steer(`note ${i}`);
  assert.equal(acks.filter((ack) => ack.kind === "deferred").length, STEER_MAX_NOTES);
  assert.equal(acks.at(-1)?.kind, "refused", "the 17th note is refused, not silently dropped");
  const kept = channel.takeNextTurnNotes();
  assert.deepEqual(kept, Array.from({ length: STEER_MAX_NOTES }, (_, i) => `note ${i}`));
  assert.equal(
    buildPromptContext("task", kept.slice(0, 2), []).prompt,
    "STEERING: note 0\nSTEERING: note 1\n\ntask",
    "next-turn notes reach the prompt in order",
  );

  acks.length = 0;
  const brain = new ScriptedBrain(accept);
  channel.beginTurn();
  channel.attach(brain);
  await channel.steer("first");
  await channel.steer("second");
  brain.listener?.({ notes: 2, boundary: "tool-results", withheldToolCalls: [] });
  assert.deepEqual(brain.notes, ["first", "second"]);
  assert.deepEqual(acks.map((ack) => ack.kind), ["accepted", "accepted", "applied"]);
  assert.match(formatSteerAck(acks[2]!), /^🎯 2 steers applied to turn 1:/);
  await channel.steer("x".repeat(16 * 1024 + 1));
  assert.equal(acks.at(-1)?.kind, "refused");
  channel.endTurn();
});

test("#283 an end-of-turn race neither loses a note nor applies it to the next task", async () => {
  const acks: SteerAck[] = [];
  const channel = new SteerChannel((ack) => acks.push(ack));
  const brain = new ScriptedBrain(accept);
  channel.beginTurn();
  channel.attach(brain);
  await channel.steer("late note");
  const staleListener = brain.listener!;
  channel.endTurn(); // the turn finished before the brain used it
  assert.deepEqual(acks.at(-1), { kind: "deferred", turn: 2, notes: 1, reason: "turn 1 ended before the steer reached the model" });

  // A late "applied" from the finished turn's brain is ignored by turn 2.
  channel.beginTurn();
  staleListener({ notes: 1, boundary: "tool-results", withheldToolCalls: [] });
  assert.equal(acks.some((ack) => ack.kind === "applied"), false);
  assert.deepEqual(channel.takeNextTurnNotes(), ["late note"], "kept, visibly, for the next submitted turn");

  // A brain that has already stopped answers "closed": deferred, not accepted.
  channel.attach(new ScriptedBrain(() => ({ accepted: false, state: "closed", error: "brain is not running" })));
  await channel.steer("after done");
  assert.deepEqual(acks.at(-1), { kind: "deferred", turn: 3, notes: 1, reason: "turn 2 was already finishing" });
  channel.endTurn();
});

test("#283 no acknowledgement means no live claim; refusals say so", async () => {
  const acks: SteerAck[] = [];
  const channel = new SteerChannel((ack) => acks.push(ack));

  channel.beginTurn();
  channel.attach(new ScriptedBrain(() => undefined));
  await channel.steer("void control");
  assert.deepEqual(acks.at(-1), { kind: "deferred", turn: 2, notes: 1, reason: "the brain gave no control acknowledgement" });

  channel.beginTurn();
  channel.attach(Object.assign(new ScriptedBrain(accept), { onSteerApplied: undefined }));
  await channel.steer("no report");
  assert.deepEqual(acks.at(-1), { kind: "deferred", turn: 3, notes: 1, reason: "this brain cannot report when steering reaches the model" });

  channel.beginTurn();
  channel.attach(new ScriptedBrain(() => ({ accepted: false, state: "running", error: "steer budget exceeded" })));
  await channel.steer("too many");
  assert.deepEqual(acks.at(-1), { kind: "refused", turn: 3, note: "too many", reason: "steer budget exceeded" });

  channel.beginTurn();
  await channel.steer("typed while starting");
  assert.equal(acks.at(-1)?.kind, "held");
  channel.attach(new ScriptedBrain(accept));
  await Promise.resolve();
  assert.deepEqual(acks.at(-1), { kind: "accepted", turn: 4, note: "typed while starting" });
  channel.endTurn();
});

test("#283 every acknowledgement names its turn and survives terminal rendering", () => {
  const hostile = "go\x1b]52;c;cGF5bG9hZA==\x07\r\nnow‮";
  const lines = [
    formatSteerAck({ kind: "held", turn: 7, note: hostile }),
    formatSteerAck({ kind: "accepted", turn: 7, note: hostile }),
    formatSteerAck({ kind: "applied", turn: 7, notes: 1, boundary: "model-reply", withheld: ["write_file\x1b[2J"], finished: [] }),
    formatSteerAck({ kind: "refused", turn: 7, note: hostile, reason: "steer budget exceeded" }),
    formatSteerAck({ kind: "deferred", turn: 8, notes: 1, reason: HOSTED_STEER_DEFERRED }),
    formatSteerAck({ kind: "deferred", turn: 8, notes: 1, reason: null }),
  ];
  for (const line of lines) {
    assert.match(line, /turn [78]/);
    assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f‮]/, "no raw control characters reach the terminal");
  }
  assert.match(lines[1]!, /accepted by turn 7 \(live\)/);
  assert.match(lines[2]!, /applied to turn 7: the model reply that arrived after it was held back/);
  assert.match(lines[3]!, /refused for turn 7: steer budget exceeded\. Not retained/);
  assert.match(lines[4]!, /deferred to turn 8 \(next turn only\)/);
  assert.equal(lines[5], "🎯 Steering set for turn 8 (next turn only).");
});
