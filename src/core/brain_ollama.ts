// OllamaBrain — the fully-local brain, in TypeScript (no Python subprocess).
//
// It runs the same agentic chat+tool loop the headless Python brain does, but
// inline: it calls Ollama (core/ollama.ts) with the canonical tools, and on a
// tool_call it emits a {type:"tool_call"} event and AWAITS the host's
// tool_result via sendToolResult — mirroring LocalBrain's queue handoff so the
// host loop (commands/code.ts hostLoop) drives it identically to local/cloud.
//
// The brain DECIDES (emits events); the host RENDERS and EXECUTES every tool
// call, replying with a tool_result. One tool implementation, one path-guard —
// so the local-Ollama path is indistinguishable from cloud by construction.
//
// No new deps: it reuses ollamaChat + the EventQueue. close() aborts the loop.

import type { Brain, BrainControlResult, SteerApplied, TaskCommand } from "./brain.js";
import { EventQueue } from "./brain.js";
import type { BrainEvent } from "./brain_protocol.js";
import { TOOL_DEFINITIONS } from "./tool_registry.js";
import { TOOLS, type ToolName } from "./brain_protocol.js";
import type { ToolResult } from "./tool_executor.js";
import {
  ollamaChat,
  type ChatMessage,
  type ChatReply,
  type ToolCall,
  type ToolSchema,
} from "./ollama.js";

// The chat seam — overridable in tests with a scripted fake (no real socket).
export type OllamaChatFn = (
  messages: readonly ChatMessage[],
  opts?: { readonly host?: string; readonly model?: string; readonly tools?: readonly ToolSchema[] },
) => Promise<ChatReply>;

export interface OllamaBrainOptions {
  /** Ollama host (default $OLLAMA_HOST or http://localhost:11434). */
  host?: string;
  /** Model tag (default from the task.model, else the ollama default). */
  model?: string;
  /** Max chat<->tool turns before the loop breaks (runaway guard). */
  maxTurns?: number;
  /** Model-facing tool allowlist. The host still enforces every call. */
  tools?: readonly ToolName[];
  /** Test seam: inject a fake chat. Production omits it and uses ollamaChat. */
  chat?: OllamaChatFn;
}

const DEFAULT_MAX_TURNS = 24;

// The canonical tools, advertised to the model as OpenAI function schemas. The
// ONE implementation lives host-side in tool_executor.ts; this only describes
// them so the model can request them. Names are pinned by TOOLS (protocol v4).
const TOOL_SCHEMAS: readonly ToolSchema[] = ollamaToolSchemas();

function systemPersona(tools: readonly ToolName[]): string {
  const canTest = tools.includes("run_tests");
  return (
    "You are Aether Code, an autonomous coding agent running locally. You work in " +
    "a real repository and make progress by CALLING ONLY THE ADVERTISED TOOLS, not by describing " +
    "actions you cannot perform. Read before you write. " +
    (canTest
      ? "After editing, run the tests. When the task is genuinely complete and the tests pass, "
      : "Do not claim to run tests; the host performs authoritative verification after you finish. When the task is complete, ") +
    "reply with a short final answer and DO NOT call any tool — that ends the turn."
  );
}

export class OllamaBrain implements Brain {
  private readonly queue = new EventQueue();
  private readonly opts: OllamaBrainOptions;
  private readonly chat: OllamaChatFn;
  // Outstanding tool calls, keyed by the id the loop emitted. Keyed rather than
  // anonymous: a single resolver accepted any result for whatever call happened
  // to be waiting, so a duplicate vanished silently and a result carrying the
  // wrong id was indistinguishable from the right one.
  private readonly pending = new Map<string, (r: ToolResult) => void>();
  private aborted = false;
  private running = false;
  private paused = false;
  private readonly pauseWaiters = new Set<() => void>();
  private readonly steerQueue: string[] = [];
  private steerBytes = 0;
  private steerListener: ((applied: SteerApplied) => void) | null = null;
  // Where pending steering will enter: set when a reply is held back, plus the
  // calls that reply (or the rest of a batch) selected but never emitted.
  private steerBoundary: SteerApplied["boundary"] = "tool-results";
  private withheld: string[] = [];
  // Incremented per model reply: tool calls batched into one reply share it.
  private round = 0;

  constructor(opts: OllamaBrainOptions = {}) {
    this.opts = opts;
    this.chat = opts.chat ?? defaultChat;
  }

  run(task: TaskCommand): AsyncIterable<BrainEvent> {
    // Kick the loop off (don't await) and hand back the drain generator; the
    // host consumes events while the loop awaits tool results via sendToolResult.
    void this.loop(task);
    return this.queue.drain();
  }

  sendToolResult(id: string, result: ToolResult): void {
    const resolve = this.pending.get(id);
    if (!resolve) {
      // Unknown id, or a second result for a call already settled. Either way
      // the host and the brain disagree about what is in flight; say so rather
      // than letting the loop advance on a result it never asked for.
      this.queue.push({ type: "error", msg: `tool result for unknown or already-settled call ${id}` });
      return;
    }
    this.pending.delete(id);
    resolve(result);
  }

  control(action: "pause" | "resume" | "steer", note?: string): BrainControlResult {
    if (!this.running || this.aborted) return { accepted: false, state: "closed", error: "brain is not running" };
    if (action === "pause") {
      if (this.paused) return { accepted: false, state: "paused", error: "brain is already paused" };
      this.paused = true;
      return { accepted: true, state: "paused" };
    }
    if (action === "resume") {
      if (!this.paused) return { accepted: false, state: "running", error: "brain is not paused" };
      this.paused = false;
      for (const resume of this.pauseWaiters) resume();
      this.pauseWaiters.clear();
      return { accepted: true, state: "running" };
    }
    const steer = note?.trim() ?? "";
    const bytes = Buffer.byteLength(steer, "utf8");
    if (!steer) return { accepted: false, state: this.paused ? "paused" : "running", error: "steer note is empty" };
    if (this.steerQueue.length >= 16 || this.steerBytes + bytes > 16 * 1024) {
      return { accepted: false, state: this.paused ? "paused" : "running", error: "steer budget exceeded" };
    }
    this.steerQueue.push(steer);
    this.steerBytes += bytes;
    return { accepted: true, state: this.paused ? "paused" : "running" };
  }

  /** Brain.onSteerApplied: told only when notes enter a real model request. */
  onSteerApplied(listener: (applied: SteerApplied) => void): void {
    this.steerListener = listener;
  }

  /** The model reply the outstanding tool call belongs to (Brain.modelRound). */
  modelRound(): number {
    return this.round;
  }

  close(): void {
    this.aborted = true;
    this.running = false;
    this.paused = false;
    for (const resume of this.pauseWaiters) resume();
    this.pauseWaiters.clear();
    // Unblock every loop parked on a tool result so it can observe the abort.
    // Drained as a set so no waiter can be stranded by an early return.
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve({ output: "[aborted]", exitCode: 130 });
    }
    this.queue.end();
  }

  /**
   * Register a waiter for a tool call BEFORE the event is emitted. Registering
   * afterwards only worked because the consumer resumes on a microtask; a host
   * that replied synchronously would have found no waiter and been rejected.
   */
  private waitForTool(id: string): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      this.pending.set(id, resolve);
    });
  }

  private async waitWhilePaused(): Promise<void> {
    if (!this.paused || this.aborted) return;
    await new Promise<void>((resolve) => this.pauseWaiters.add(resolve));
  }

  /** Called immediately before a model request, so "applied" is never early. */
  private applySteers(messages: ChatMessage[]): number {
    const notes = this.steerQueue.splice(0);
    this.steerBytes = 0;
    for (const note of notes) messages.push({ role: "user", content: `[Operator steering]\n${note}` });
    if (notes.length > 0) {
      const applied: SteerApplied = { notes: notes.length, boundary: this.steerBoundary, withheldToolCalls: [...this.withheld] };
      try { this.steerListener?.(applied); } catch { /* an observer cannot stop the run */ }
    }
    this.steerBoundary = "tool-results";
    this.withheld = [];
    return notes.length;
  }

  /** The agentic loop: chat -> (tool calls -> results)* -> final answer. */
  private async loop(task: TaskCommand): Promise<void> {
    this.running = true;
    const model = this.opts.model || task.model || undefined;
    const maxTurns = this.opts.maxTurns ?? DEFAULT_MAX_TURNS;
    const tools = this.opts.tools ?? TOOLS;
    const schemas = this.opts.tools ? ollamaToolSchemas(tools) : TOOL_SCHEMAS;
    const messages: ChatMessage[] = [
      { role: "system", content: systemPersona(tools) },
      { role: "user", content: task.text },
    ];

    let reason = "";
    let ok = true;
    let result = "";
    try {
      for (let turn = 0; turn < maxTurns; turn += 1) {
        if (this.aborted) {
          reason = "aborted";
          ok = false;
          break;
        }
        await this.waitWhilePaused();
        if (this.aborted) {
          reason = "aborted";
          ok = false;
          break;
        }
        this.applySteers(messages);
        let reply: ChatReply;
        try {
          reply = await this.chat(messages, {
            ...(model ? { model } : {}),
            ...(this.opts.host ? { host: this.opts.host } : {}),
            tools: schemas,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.queue.push({ type: "error", msg });
          ok = false;
          reason = "unverified";
          break;
        }

        const calls = reply.tool_calls ?? [];
        this.round += 1;
        // A pause received while the network request was in flight takes
        // effect before any resulting tool call or answer becomes observable.
        await this.waitWhilePaused();
        if (this.aborted) {
          reason = "aborted";
          ok = false;
          break;
        }
        // A steer that arrived during the request gets a fresh model turn.
        // This check precedes tool publication: executing a stale write that
        // the model selected before an accepted steer would make the
        // acknowledgement false. A reply carrying tool calls is discarded
        // because replaying an assistant tool-call turn without tool results
        // would also create an invalid conversation.
        if (this.steerQueue.length > 0) {
          if (calls.length === 0) messages.push(assistantTurn(reply));
          this.steerBoundary = "model-reply";
          this.withheld.push(...calls.map((call) => call.function.name));
          // Applied at the top of the next iteration, right before the model
          // request. With no turn left the notes stay queued and unreported,
          // so the host can carry them forward instead of claiming success.
          if (turn === maxTurns - 1) {
            ok = false;
            reason = "max-turns";
            result = "stopped: accepted steering could not be processed within the turn budget.";
          }
          continue;
        }
        if (calls.length === 0) {
          // No tool call -> this is the final answer. Surface it and finish.
          result = (reply.content || "").trim() || "done";
          this.queue.push({ type: "monologue", text: result, depth: 0 });
          ok = true;
          reason = "";
          break;
        }

        // Record the assistant turn (with its tool calls) before the replies.
        messages.push(assistantTurn(reply));

        for (const call of calls) {
          if (this.aborted) break;
          // A steer accepted mid-batch: the rest of this batch was selected
          // before it, so none of it is emitted. Each call still gets a tool
          // message, or the conversation would carry an unanswered tool call.
          if (this.steerQueue.length > 0) {
            this.withheld.push(call.function.name);
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function.name,
              content: "[not executed: superseded by operator steering accepted before it ran]",
            });
            continue;
          }
          const args = parseArgs(call.function.arguments);
          const waiting = this.waitForTool(call.id);
          this.queue.push({ type: "tool_call", id: call.id, name: call.function.name, args });
          const toolResult = await waiting;
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: toolResult.output,
          });
        }

        if (turn === maxTurns - 1) {
          // Ran the budget without a final answer — break, do not hang.
          ok = false;
          reason = "max-turns";
          result = "stopped: reached the turn budget without a final answer.";
        }
      }
    } finally {
      this.running = false;
      this.paused = false;
      for (const resume of this.pauseWaiters) resume();
      this.pauseWaiters.clear();
      // Always close the stream so the host loop terminates (even on abort/error).
      this.queue.push({
        type: "done",
        ok,
        result: result || (ok ? "done" : "stopped"),
        // The brain does not count failing tests — the host's verify gate does,
        // from a real test run. Reporting a placeholder 1 here made an
        // unreachable-Ollama run print "1 test failing" when no test had run.
        remaining: 0,
        reason,
      });
      this.queue.end();
    }
  }
}

// --- helpers ----------------------------------------------------------------

/** Default production chat seam — the real Ollama client. */
async function defaultChat(
  messages: readonly ChatMessage[],
  opts?: { readonly host?: string; readonly model?: string; readonly tools?: readonly ToolSchema[] },
): Promise<ChatReply> {
  return ollamaChat(messages, opts ?? {});
}

/** Build an assistant ChatMessage that carries the tool calls it requested. */
function assistantTurn(reply: ChatReply): ChatMessage {
  const calls = reply.tool_calls ?? [];
  return {
    role: "assistant",
    content: reply.content || "",
    ...(calls.length > 0 ? { tool_calls: calls as readonly ToolCall[] } : {}),
  };
}

/** Parse a tool_call arguments JSON string into a record (never throws). */
function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Model-facing tool schemas, GENERATED from TOOL_DEFINITIONS.
 *
 * These were hand-written, with `parameters: { properties: {}, additionalProperties: true }`
 * — so the model was told nothing about argument names, types, required-ness or
 * bounds, and the only description of the real shapes lived in free text that
 * nothing kept in step with the validator. Generating them means the host's
 * validator and the model's contract cannot drift.
 */
export function ollamaToolSchemas(tools: readonly ToolName[] = TOOLS): readonly ToolSchema[] {
  const summaries: Readonly<Record<ToolName, string>> = {
    read_file: "Read a bounded byte range (offset/max_bytes) or line range (start_line/max_lines). A complete byte read includes a replace_token for write_file. On supported Linux filesystems, pass the revision as expected_revision on each continuation and restart if stale; other systems return revision_unsupported for guarded reads. An initial unguarded read can return a SHA-256 digest for patch_file. Do not combine range modes.",
    list_directory: "List one bounded page of a workspace directory. Use the returned cursor for the next page.",
    patch_file: "Replace one exact range in a file using its read_file SHA-256 digest. A stale digest fails without writing.",
    write_file: "Create a new workspace file, or replace an existing small text file only with expected_revision and replace_token from one complete read_file byte result. Partial reads cannot authorize replacement; use patch_file for larger files.",
    run_shell: "Run a shell command in the workspace.",
    run_tests: "Run the project's test command.",
    repo_search: "Grep the repository for a string.",
    git_commit: "Stage this run's changes and commit them.",
    web_search: "Search the web.",
    web_fetch: "Fetch a web page as readable text.",
  };

  return tools.map((name) => {
    const definition = TOOL_DEFINITIONS[name];
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];

    for (const [argument, spec] of Object.entries(definition.args)) {
      properties[argument] =
        spec.type === "integer"
          ? { type: "integer", minimum: spec.min, maximum: spec.max }
          // maxBytes is a byte budget; as maxLength it is a ceiling in
          // characters, which is conservative for any multi-byte input.
          : { type: "string", maxLength: spec.maxBytes };
      if (spec.required !== false) required.push(argument);
    }

    return {
      type: "function" as const,
      function: {
        name,
        description: `${summaries[name]} side effect: ${definition.sideEffect}.`,
        parameters: {
          type: "object",
          properties,
          required,
          // The host rejects unknown arguments, so advertising them as allowed
          // only invites the model to send something that will be refused.
          additionalProperties: false,
        },
      },
    };
  });
}
