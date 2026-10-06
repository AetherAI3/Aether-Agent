// SteerChannel — routes a console /steer to the brain running the current turn
// and reports, honestly, what happened to it (#283).
//
// A note typed during a turn is only "accepted" when a control-capable brain
// acknowledged it, and only "applied" when that brain says the note entered a
// model request. Anything else is kept for the next turn and said so: a hosted
// chat route that has no control acknowledgement, a brain that cannot report
// application, or a turn that ended before the note reached the model. A
// steer is guidance text only; it never changes tool permissions or approves
// anything.

import type { Brain, BrainControlResult, SteerApplied } from "./brain.js";
import { terminalSafeReview } from "./tool_approval.js";

/** Same bounds the local brain enforces on its own steering queue. */
export const STEER_MAX_NOTES = 16;
export const STEER_MAX_BYTES = 16 * 1024;
const NOTE_PREVIEW_CHARS = 80;
const BUDGET_REASON = "steer budget exceeded (16 notes / 16 KiB)";

export type SteerAck =
  | { kind: "held"; turn: number; note: string }
  | { kind: "accepted"; turn: number; note: string }
  | {
      kind: "applied";
      turn: number;
      notes: number;
      boundary: SteerApplied["boundary"];
      withheld: readonly string[];
      finished: readonly string[];
    }
  | { kind: "refused"; turn: number; note: string; reason: string }
  | { kind: "deferred"; turn: number; notes: number; reason: string | null };

type Phase = "idle" | "starting" | "live" | "next-turn-only";

/** Ordered notes under a count and byte budget. */
class BoundedNotes {
  private readonly items: string[] = [];
  private bytes = 0;

  push(note: string): boolean {
    const size = Buffer.byteLength(note, "utf8");
    if (this.items.length >= STEER_MAX_NOTES || this.bytes + size > STEER_MAX_BYTES) return false;
    this.items.push(note);
    this.bytes += size;
    return true;
  }

  take(count = this.items.length): string[] {
    const taken = this.items.splice(0, count);
    for (const note of taken) this.bytes -= Buffer.byteLength(note, "utf8");
    return taken;
  }

  remove(note: string): void {
    const index = this.items.indexOf(note);
    if (index < 0) return;
    this.items.splice(index, 1);
    this.bytes -= Buffer.byteLength(note, "utf8");
  }

  get size(): number {
    return this.items.length;
  }
}

export class SteerChannel {
  private phase: Phase = "idle";
  private turn = 0;
  private generation = 0;
  private brain: Brain | null = null;
  private deferReason = "";
  // Typed while the turn was still starting, before any brain existed.
  private readonly held = new BoundedNotes();
  // Acknowledged by the brain, not yet reported as applied. Oldest first.
  private readonly inFlight = new BoundedNotes();
  private readonly nextTurn = new BoundedNotes();
  private hostSkipped: string[] = [];
  private finished: string[] = [];

  constructor(private readonly onAck: (ack: SteerAck) => void) {}

  /** Start a chat turn. Returns its number. */
  beginTurn(): number {
    this.endTurn();
    this.turn += 1;
    this.phase = "starting";
    return this.turn;
  }

  /** The turn's brain is running. Live only if it can report application. */
  attach(brain: Brain): void {
    if (this.phase !== "starting") return;
    if (typeof brain.onSteerApplied !== "function") {
      this.markNextTurnOnly("this brain cannot report when steering reaches the model");
      return;
    }
    const generation = this.generation;
    brain.onSteerApplied((applied) => this.applied(generation, applied));
    this.brain = brain;
    this.phase = "live";
    for (const note of this.held.take()) void this.deliver(note);
  }

  /** The turn runs on a route with no control acknowledgement. */
  markNextTurnOnly(reason: string): void {
    if (this.phase !== "starting") return;
    this.phase = "next-turn-only";
    this.deferReason = reason;
    const held = this.held.take();
    if (held.length > 0) this.defer(held, reason);
  }

  /** Route one /steer note. Every outcome is reported through onAck. */
  async steer(raw: string): Promise<void> {
    const note = raw.trim();
    if (!note) return;
    if (Buffer.byteLength(note, "utf8") > STEER_MAX_BYTES) {
      this.onAck({ kind: "refused", turn: this.phase === "idle" ? this.turn + 1 : this.turn, note, reason: "the note exceeds 16 KiB" });
      return;
    }
    switch (this.phase) {
      case "idle":
        this.defer([note], null);
        return;
      case "next-turn-only":
        this.defer([note], this.deferReason);
        return;
      case "starting":
        if (!this.held.push(note)) this.onAck({ kind: "refused", turn: this.turn, note, reason: BUDGET_REASON });
        else this.onAck({ kind: "held", turn: this.turn, note });
        return;
      case "live":
        await this.deliver(note);
        return;
    }
  }

  /** True while an acknowledged steer has not reached the model: any tool
   *  call the host is holding now was selected before it and must not run. */
  hasPendingSteer(): boolean {
    return this.phase === "live" && this.inFlight.size > 0;
  }

  /** The host refused a stale call because steering was pending. */
  noteToolSkipped(name: string): void {
    if (this.hasPendingSteer()) this.hostSkipped.push(name);
  }

  /** A tool that was already executing when the steer arrived finished. */
  noteToolFinished(name: string): void {
    if (this.hasPendingSteer()) this.finished.push(name);
  }

  /** The turn is over. Notes that never reached the model move to the next turn. */
  endTurn(): void {
    const ended = this.turn;
    const leftover = this.close();
    if (leftover.length > 0) this.defer(leftover, `turn ${ended} ended before the steer reached the model`);
  }

  /** The operator cancelled the turn. Its unapplied notes belonged to that
   *  task, so they are dropped — and each drop is reported, never silent. */
  cancelTurn(): void {
    const cancelled = this.turn;
    for (const note of this.close()) {
      this.onAck({ kind: "refused", turn: cancelled, note, reason: `turn ${cancelled} was cancelled before the steer reached the model` });
    }
  }

  /** Put notes taken for a turn that failed before using them back in front
   *  of the next-turn queue, oldest first, and say so. */
  restoreNextTurnNotes(notes: readonly string[], reason: string): void {
    if (notes.length === 0) return;
    const queued = this.nextTurn.take();
    const kept = notes.filter((note) => this.keepForNextTurn(note)).length;
    for (const note of queued) this.keepForNextTurn(note);
    if (kept > 0) this.onAck({ kind: "deferred", turn: this.turn + 1, notes: kept, reason });
  }

  /** Leave the turn: stale callbacks are ignored from here on. Returns the
   *  notes that never reached the model, oldest first. */
  private close(): string[] {
    if (this.phase === "idle") return [];
    this.generation += 1;
    const leftover = [...this.held.take(), ...this.inFlight.take()];
    this.phase = "idle";
    this.brain = null;
    this.hostSkipped = [];
    this.finished = [];
    return leftover;
  }

  /** Notes for the next submitted turn, oldest first. Clears them. */
  takeNextTurnNotes(): string[] {
    return this.nextTurn.take();
  }

  clearNextTurn(): void {
    this.nextTurn.take();
  }

  private async deliver(note: string): Promise<void> {
    const brain = this.brain;
    const generation = this.generation;
    const turn = this.turn;
    // Counted as pending before the answer, so a call the host holds while an
    // async brain decides is refused rather than raced; a refusal that follows
    // can only make the host more cautious, never run a stale call.
    if (!brain || !this.inFlight.push(note)) {
      this.onAck({ kind: "refused", turn, note, reason: BUDGET_REASON });
      return;
    }
    let result: BrainControlResult | void;
    try {
      // A synchronous acknowledgement is used as-is: awaiting it would yield,
      // and the brain could apply the note before "accepted" was reported.
      const answer = brain.control("steer", note);
      result = answer instanceof Promise ? await answer : answer;
    } catch (err) {
      result = { accepted: false, state: "closed", error: err instanceof Error ? err.message : String(err) };
    }
    // The turn ended while the acknowledgement was outstanding: endTurn has
    // already carried the note forward, so nothing more is claimed here.
    if (generation !== this.generation) return;
    if (result?.accepted) {
      this.onAck({ kind: "accepted", turn, note });
      return;
    }
    this.inFlight.remove(note);
    if (!result) this.defer([note], "the brain gave no control acknowledgement");
    else if (result.state === "closed") this.defer([note], `turn ${turn} was already finishing`);
    else this.onAck({ kind: "refused", turn, note, reason: result.error || "the brain refused it" });
  }

  private applied(generation: number, applied: SteerApplied): void {
    if (generation !== this.generation || this.phase !== "live") return;
    const notes = this.inFlight.take(applied.notes).length;
    if (notes === 0) return;
    this.onAck({
      kind: "applied",
      turn: this.turn,
      notes,
      boundary: applied.boundary,
      withheld: [...this.hostSkipped, ...applied.withheldToolCalls],
      finished: [...this.finished],
    });
    this.hostSkipped = [];
    this.finished = [];
  }

  /** Keep notes for the next turn (the one after the running or last turn). */
  private defer(notes: readonly string[], reason: string | null): void {
    const kept = notes.filter((note) => this.keepForNextTurn(note)).length;
    if (kept > 0) this.onAck({ kind: "deferred", turn: this.turn + 1, notes: kept, reason });
  }

  private keepForNextTurn(note: string): boolean {
    if (this.nextTurn.push(note)) return true;
    this.onAck({ kind: "refused", turn: this.turn + 1, note, reason: `next-turn ${BUDGET_REASON}` });
    return false;
  }
}

/** One terminal-safe status line per acknowledgement. */
export function formatSteerAck(ack: SteerAck): string {
  switch (ack.kind) {
    case "held":
      return `🎯 Steer held for turn ${ack.turn}: "${preview(ack.note)}" — the turn is still starting; its acknowledgement follows.`;
    case "accepted":
      return `🎯 Steer accepted by turn ${ack.turn} (live): "${preview(ack.note)}" — it applies at the next safe model/tool boundary.`;
    case "applied": {
      const count = ack.notes === 1 ? "Steer" : `${ack.notes} steers`;
      const where = ack.boundary === "model-reply"
        ? "the model reply that arrived after it was held back and the model was asked again"
        : "it reached the next model request after the outstanding tool results";
      const parts = [`🎯 ${count} applied to turn ${ack.turn}: ${where}.`];
      if (ack.finished.length > 0) parts.push(`Already running and allowed to finish: ${names(ack.finished)}.`);
      if (ack.withheld.length > 0) parts.push(`Not run (selected before the steer): ${names(ack.withheld)}.`);
      return parts.join(" ");
    }
    case "refused":
      return `🎯 Steer refused for turn ${ack.turn}: ${safe(ack.reason)}. Not retained: "${preview(ack.note)}"`;
    case "deferred": {
      const what = ack.notes === 1 ? "Steering" : `${ack.notes} steering notes`;
      return ack.reason
        ? `🎯 ${what} deferred to turn ${ack.turn} (next turn only): ${safe(ack.reason)}. Kept for that turn.`
        : `🎯 ${what} set for turn ${ack.turn} (next turn only).`;
    }
  }
}

function safe(text: string): string {
  return terminalSafeReview(text, false);
}

function preview(note: string): string {
  const flat = safe(note);
  return flat.length > NOTE_PREVIEW_CHARS ? flat.slice(0, NOTE_PREVIEW_CHARS - 1) + "…" : flat;
}

function names(list: readonly string[]): string {
  return list.map(safe).join(", ");
}
