// Brain — the pluggable, headless decision source behind one interface. The
// host (commands/code.ts) drives it identically whether the brain is local
// (Python/Ollama over stdio) or cloud (Aether API over SSE). Switching local
// <-> cloud swaps the implementation; host code is unchanged.
//
//   brain.run(task)  ->  async stream of BrainEvent
//   on a tool_call   ->  host executes, then brain.sendToolResult(id, result)
//   pause/steer      ->  brain.control(...)
//
// See specs/aethercode_bridge.md + docs/BRIDGE_PROTOCOL.md.

import type { BrainEvent, HostCommand } from "./brain_protocol.js";
import type { ToolResult } from "./tool_executor.js";

export type TaskCommand = Extract<HostCommand, { type: "task" }>;

export interface BrainControlResult {
  accepted: boolean;
  state: "running" | "paused" | "closed";
  error?: string;
}

export interface Brain {
  /** Start the task; yields events until a `done` or `error` event. */
  run(task: TaskCommand): AsyncIterable<BrainEvent>;
  /** Reply to a tool_call the brain emitted (host executed it). */
  sendToolResult(id: string, result: ToolResult): void;
  /** Interactive control: pause / resume / steer (a steer carries a note). */
  control(
    action: "pause" | "resume" | "steer",
    note?: string,
  ): BrainControlResult | Promise<BrainControlResult> | void;
  /** Tear down (kill the subprocess / abort the stream). */
  close(): void;
  /**
   * Optional: which model reply the outstanding tool_call came from. Calls
   * batched into one reply share a round, so the host's repeated-failure
   * budget (#285) never stops a run on a repeat the model has not yet seen
   * a result for. A brain that cannot tell omits it; every call is then
   * treated as its own round.
   */
  modelRound?(): number;
}

// A minimal single-consumer async queue: producers push events (from a
// subprocess 'data' handler or an SSE loop), the run() generator awaits them.
export class EventQueue {
  private readonly items: BrainEvent[] = [];
  private resolver: ((v: IteratorResult<BrainEvent>) => void) | null = null;
  private done = false;

  push(ev: BrainEvent): void {
    if (this.done) return;
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r({ value: ev, done: false });
    } else {
      this.items.push(ev);
    }
  }

  /** Signal end-of-stream; the generator completes after draining buffered items. */
  end(): void {
    this.done = true;
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r({ value: undefined as unknown as BrainEvent, done: true });
    }
  }

  async *drain(): AsyncGenerator<BrainEvent> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift() as BrainEvent;
        continue;
      }
      if (this.done) return;
      const next = await new Promise<IteratorResult<BrainEvent>>((res) => {
        this.resolver = res;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
