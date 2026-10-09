import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaBrain, ollamaToolSchemas } from "../src/core/brain_ollama.js";
import { TOOLS, type ToolName } from "../src/core/brain_protocol.js";
import { TOOL_DEFINITIONS } from "../src/core/tool_registry.js";
import type { Brain, TaskCommand } from "../src/core/brain.js";
import type { BrainEvent } from "../src/core/brain_protocol.js";
import type { ChatMessage, ChatReply } from "../src/core/ollama.js";

// A scripted fake of the ollama chat seam: the i-th call returns the i-th reply.
// It records the messages it was handed so the test can assert the tool_result
// was fed back to the model on the second turn.
function fakeChat(replies: readonly ChatReply[]): {
  chat: (messages: readonly ChatMessage[]) => Promise<ChatReply>;
  calls: () => readonly (readonly ChatMessage[])[];
} {
  const seen: (readonly ChatMessage[])[] = [];
  let i = 0;
  return {
    chat: async (messages: readonly ChatMessage[]): Promise<ChatReply> => {
      seen.push(messages);
      const r = replies[Math.min(i, replies.length - 1)];
      i += 1;
      return r ?? { role: "assistant", content: "" };
    },
    calls: () => seen,
  };
}

const task: TaskCommand = { type: "task", text: "fix the bug", cwd: ".", poolGb: 5 };

/** Drive a brain through the host loop, executing tool_calls with a stub. */
async function driveBrain(
  brain: Brain,
  exec: (name: string, args: Record<string, unknown>) => { output: string; exitCode: number },
): Promise<BrainEvent[]> {
  const events: BrainEvent[] = [];
  for await (const ev of brain.run(task)) {
    events.push(ev);
    if (ev.type === "tool_call") {
      const r = exec(ev.name, ev.args);
      brain.sendToolResult(ev.id, r);
    }
  }
  brain.close();
  return events;
}

test("OllamaBrain emits a tool_call, accepts sendToolResult, then a done", async () => {
  // Turn 1: the model asks to read a file. Turn 2: it answers (no tool call).
  const { chat, calls } = fakeChat([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      ],
    },
    { role: "assistant", content: "all set — the bug is fixed." },
  ]);
  const brain = new OllamaBrain({ chat });

  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const events = await driveBrain(brain, (name, args) => {
    executed.push({ name, args });
    return { output: "[exit 0]\nfile contents", exitCode: 0 };
  });

  const types = events.map((e) => e.type);
  // Exactly one tool_call, ending in monologue then done.
  assert.equal(types.filter((t) => t === "tool_call").length, 1, "one tool_call emitted");
  assert.ok(types.includes("monologue"), "final answer surfaced as monologue");
  assert.equal(types.at(-1), "done", "stream ends with done");

  const call = events.find((e) => e.type === "tool_call");
  assert.equal(call?.type === "tool_call" ? call.name : "", "read_file");
  assert.equal(executed.length, 1);
  assert.equal(executed[0]?.name, "read_file");

  const done = events.find((e) => e.type === "done");
  assert.equal(done?.type === "done" ? done.ok : false, true, "done.ok true on a clean finish");

  // The tool_result must have been fed back to the model on the 2nd turn: the
  // second chat call's message list includes a role:"tool" reply for this call.
  const second = calls()[1] ?? [];
  const toolMsg = second.find((m) => m.role === "tool");
  assert.ok(toolMsg, "tool_result fed back into the conversation");
  assert.equal(toolMsg?.tool_call_id, call?.type === "tool_call" ? call.id : "");
  assert.equal(second.find((m) => m.role === "assistant")?.tool_calls?.[0]?.id, toolMsg?.tool_call_id);
});

test("OllamaBrain answers immediately when the model makes no tool call", async () => {
  const { chat } = fakeChat([{ role: "assistant", content: "here is the answer." }]);
  const brain = new OllamaBrain({ chat });
  const events = await driveBrain(brain, () => ({ output: "", exitCode: 0 }));
  const types = events.map((e) => e.type);
  assert.equal(types.filter((t) => t === "tool_call").length, 0, "no tool_call");
  assert.ok(types.includes("monologue"));
  assert.equal(types.at(-1), "done");
});

test("OllamaBrain surfaces an error event when the chat seam throws", async () => {
  const brain = new OllamaBrain({
    chat: async () => {
      throw new Error("ollama is down");
    },
  });
  const events = await driveBrain(brain, () => ({ output: "", exitCode: 0 }));
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "error event emitted on a chat failure");
  assert.match(err?.type === "error" ? err.msg : "", /ollama is down/);
  assert.equal(events.at(-1)?.type, "done", "still ends with a done so the host loop terminates");
});

test("OllamaBrain stops after maxTurns without a final answer", async () => {
  // The model never stops calling tools — the loop must break, not hang.
  const { chat } = fakeChat([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
      ],
    },
  ]);
  const brain = new OllamaBrain({ chat, maxTurns: 3 });
  const events = await driveBrain(brain, () => ({ output: "[exit 0]\nx", exitCode: 0 }));
  const toolCalls = events.filter((e) => e.type === "tool_call").length;
  assert.ok(toolCalls <= 3, "capped at maxTurns tool calls");
  const done = events.find((e) => e.type === "done");
  assert.ok(done, "loop terminates with a done even on a runaway model");
  assert.equal(done?.type === "done" ? done.reason : "", "max-turns");
});

// ── tool-call correlation (SC-A4) ───────────────────────────────────────────
// The pending tool result used to be a single anonymous resolver and
// sendToolResult ignored its `id` parameter entirely. Any result satisfied
// whatever call happened to be waiting, a duplicate vanished silently, and a
// result for an unknown id was indistinguishable from the real one.

function toolThenAnswer(): readonly ChatReply[] {
  return [
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
    },
    { role: "assistant", content: "done" },
  ];
}

test("a tool result for an unknown id is rejected, not applied to the waiting call", async () => {
  const { chat } = fakeChat(toolThenAnswer());
  const brain = new OllamaBrain({ chat });
  const events: BrainEvent[] = [];
  for await (const ev of brain.run(task)) {
    events.push(ev);
    if (ev.type === "tool_call") {
      brain.sendToolResult("not-the-right-id", { output: "WRONG", exitCode: 0 });
      brain.sendToolResult(ev.id, { output: "right", exitCode: 0 });
    }
  }
  brain.close();
  const errors = events.filter((ev) => ev.type === "error");
  assert.equal(errors.length >= 1, true, "an unrecognised tool-call id must be surfaced, not swallowed");
  assert.equal(events.some((ev) => ev.type === "done"), true, "the run still terminates");
});

test("a duplicate tool result does not advance the loop twice", async () => {
  const { chat, calls } = fakeChat(toolThenAnswer());
  const brain = new OllamaBrain({ chat });
  for await (const ev of brain.run(task)) {
    if (ev.type === "tool_call") {
      brain.sendToolResult(ev.id, { output: "first", exitCode: 0 });
      brain.sendToolResult(ev.id, { output: "second", exitCode: 0 });
    }
  }
  brain.close();
  const toolReplies = calls()
    .flat()
    .filter((message) => message.role === "tool");
  const outputs = toolReplies.map((message) => message.content);
  assert.equal(outputs.includes("second"), false, "the second result must not reach the model");
  assert.equal(outputs.filter((text) => text === "first").length >= 1, true);
});

test("close resolves an outstanding waiter so the run cannot hang", async () => {
  const { chat } = fakeChat(toolThenAnswer());
  const brain = new OllamaBrain({ chat });
  const events: BrainEvent[] = [];
  for await (const ev of brain.run(task)) {
    events.push(ev);
    if (ev.type === "tool_call") brain.close(); // never send a result
  }
  assert.equal(events.some((ev) => ev.type === "tool_call"), true);
});

// ── control honesty ─────────────────────────────────────────────────────────

test("control() acknowledges steering only when it reaches a fresh model turn", async () => {
  const { chat, calls } = fakeChat(toolThenAnswer());
  const brain = new OllamaBrain({ chat });
  const events: BrainEvent[] = [];
  let acknowledgement: ReturnType<OllamaBrain["control"]> | undefined;
  for await (const ev of brain.run(task)) {
    events.push(ev);
    if (ev.type === "tool_call") {
      acknowledgement = brain.control("steer", "actually, do something else");
      brain.sendToolResult(ev.id, { output: "ok", exitCode: 0 });
    }
  }
  brain.close();
  assert.deepEqual(acknowledgement, { accepted: true, state: "running" });
  assert.equal(
    calls().at(-1)?.some((message) => message.role === "user" && message.content.includes("[Operator steering]\nactually, do something else")),
    true,
    "an acknowledged steer must reach the next model request",
  );
  assert.equal(events.some((ev) => ev.type === "done"), true, "the steered run still terminates");
});

// ── advertised tool schemas ─────────────────────────────────────────────────

test("advertised tool schemas are generated from TOOL_DEFINITIONS, not hand-written", () => {
  const schemas = ollamaToolSchemas();
  assert.deepEqual(
    schemas.map((schema) => schema.function.name).sort(),
    [...TOOLS].sort(),
    "every protocol tool is advertised, and nothing else",
  );

  for (const schema of schemas) {
    const name = schema.function.name as ToolName;
    const definition = TOOL_DEFINITIONS[name];
    const parameters = schema.function.parameters as {
      properties: Record<string, { type: string; maxLength?: number; minimum?: number; maximum?: number }>;
      required?: string[];
      additionalProperties?: boolean;
    };

    assert.equal(parameters.additionalProperties, false, `${name} must not accept arbitrary extra arguments`);
    assert.deepEqual(
      Object.keys(parameters.properties).sort(),
      Object.keys(definition.args).sort(),
      `${name} advertises exactly the arguments the host validates`,
    );
    assert.deepEqual(
      (parameters.required ?? []).sort(),
      Object.entries(definition.args)
        .filter(([, argument]) => argument.required !== false)
        .map(([key]) => key)
        .sort(),
      `${name} required set matches the host validator`,
    );
  }

  // Spot-check that bounds actually crossed over rather than being dropped.
  const search = schemas.find((schema) => schema.function.name === "web_search");
  const limit = (search!.function.parameters as { properties: Record<string, { minimum?: number; maximum?: number }> })
    .properties["limit"];
  assert.equal(limit?.minimum, 1);
  assert.equal(limit?.maximum, 10);
});
