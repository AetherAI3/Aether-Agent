import { classifyConsoleInput, type ConsoleInput } from "./console_input.js";
import { sanitizeServerText } from "../core/transport.js";

/** Inputs that may wait behind an active turn. Errors and empty lines never queue. */
export type QueueableInput = Extract<ConsoleInput, { kind: "chat" | "shell" | "reset-shell" | "profile" | "share" }>;

export interface QueueEntry {
  /** Stable for the session and never reused: q1, q2, … */
  readonly id: string;
  readonly input: QueueableInput;
}

export const QUEUE_MAX_ENTRIES = 32;
export const QUEUE_MAX_BYTES = 64 * 1024;

export type QueueCommand =
  | { op: "list" }
  | { op: "clear" }
  | { op: "resume" }
  | { op: "remove"; id: string }
  | { op: "edit"; id: string; text: string }
  | { op: "usage"; message: string };

export type QueueResult = { ok: true; entry: QueueEntry } | { ok: false; message: string };

/** Management commands are matched strictly so ordinary tasks still queue:
 * `/queue clear the cache` is a task, `/queue clear` is the command, and
 * edit/remove only act on a `q<number>` id. */
export function parseQueueCommand(raw: string): QueueCommand | null {
  const text = raw.trim();
  if (text === "/queue" || text === "/queue list") return { op: "list" };
  if (text === "/queue clear") return { op: "clear" };
  if (text === "/queue resume") return { op: "resume" };
  const remove = /^\/queue[ \t]+(?:remove|rm)[ \t]+(q\d+)$/i.exec(text);
  if (remove) return { op: "remove", id: remove[1]!.toLowerCase() };
  const edit = /^\/queue[ \t]+edit[ \t]+(q\d+)(?:[ \t]+([\s\S]*))?$/i.exec(text);
  if (edit) {
    const replacement = (edit[2] ?? "").trim();
    return replacement ? { op: "edit", id: edit[1]!.toLowerCase(), text: replacement } : { op: "usage", message: "usage: /queue edit <id> <text>" };
  }
  return null;
}

/** Human-facing type of an entry. */
export function entryKind(input: QueueableInput): "chat" | "user shell" | "shell reset" | "shell profile" | "shell-share" {
  if (input.kind === "chat") return "chat";
  if (input.kind === "shell") return "user shell";
  if (input.kind === "reset-shell") return "shell reset";
  if (input.kind === "profile") return "shell profile";
  return "shell-share";
}

function inputBytes(input: QueueableInput): number {
  if (input.kind === "chat") return Buffer.byteLength(input.text, "utf8");
  if (input.kind === "shell") return Buffer.byteLength(input.command, "utf8");
  if (input.kind === "share") return Buffer.byteLength(input.value ?? "", "utf8");
  return 0;
}

function clip(text: string, max = 55): string {
  const flat = sanitizeServerText(text).replace(/\s*\n\s*/g, " ⏎ ");
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/** States the shell-share binding explicitly so nobody has to guess which
 * result a queued action will touch when it finally runs. */
export function shareBinding(input: Extract<QueueableInput, { kind: "share" }>): string {
  if (input.action === "send") {
    return input.boundCommandId
      ? `sends the preview you reviewed of command ${input.boundCommandId.slice(0, 8)}; refused if that preview is gone or replaced`
      : "sends the staged preview";
  }
  if (input.action === "cancel") return "discards whatever preview is staged at execution";
  return "acts on the staged preview, or stages the latest shell result at execution";
}

export function describeEntry(input: QueueableInput): string {
  if (input.kind === "chat") return `"${clip(input.text)}"`;
  // Commands often share a long prefix; keep enough to tell entries apart.
  if (input.kind === "shell") return `!${clip(input.command, 120)} (local only; never sent to the model)`;
  if (input.kind === "reset-shell") return "/shell-reset";
  if (input.kind === "profile") return `/shell-profile ${input.action}${input.profile ? " " + input.profile : ""}`;
  const detail = input.action === "drop" ? ` ${input.first}-${input.last}`
    : input.action === "replace" ? ` ${input.first}`
    : input.action === "mask" ? " <literal>"
    : "";
  return `${input.action}${detail}: ${shareBinding(input)}`;
}

export function entryLine(entry: QueueEntry): string {
  return `${entry.id.padEnd(4)} ${entryKind(entry.input).padEnd(11)} ${describeEntry(entry.input)}`;
}

/** Ordered, bounded, local-only queue of follow-ups behind the active turn.
 * Nothing here talks to a model or a process: callers decide when to run. */
export class ConsoleQueue {
  private entries: readonly QueueEntry[] = [];
  private nextId = 1;
  private heldReason: string | null = null;
  private runningEntry: QueueEntry | null = null;

  get pending(): readonly QueueEntry[] { return this.entries; }
  get length(): number { return this.entries.length; }
  get held(): string | null { return this.heldReason; }
  get running(): QueueEntry | null { return this.runningEntry; }
  get bytes(): number { return this.entries.reduce((sum, e) => sum + inputBytes(e.input), 0); }

  /** An id for an input that runs immediately, so the running entry is named too. */
  allocate(input: QueueableInput): QueueEntry {
    return { id: `q${this.nextId++}`, input };
  }

  enqueue(input: QueueableInput): QueueResult {
    if (this.entries.length >= QUEUE_MAX_ENTRIES) {
      return { ok: false, message: `Queue full (${QUEUE_MAX_ENTRIES} entries); not queued. Remove entries with /queue remove <id> or /queue clear.` };
    }
    if (this.bytes + inputBytes(input) > QUEUE_MAX_BYTES) {
      return { ok: false, message: `Queue full (${QUEUE_MAX_BYTES / 1024} KiB of queued text); not queued. Remove entries with /queue remove <id> or /queue clear.` };
    }
    const entry = this.allocate(input);
    this.entries = [...this.entries, entry];
    return { ok: true, entry };
  }

  /** Next entry to run, or undefined while empty or held after a failure. */
  shift(): QueueEntry | undefined {
    if (this.heldReason !== null) return undefined;
    const [next, ...rest] = this.entries;
    this.entries = rest;
    return next;
  }

  setRunning(entry: QueueEntry | null): void { this.runningEntry = entry; }

  /** Keep entries but stop draining until the user explicitly resumes. */
  hold(reason: string): boolean {
    if (!this.entries.length) return false;
    this.heldReason = reason;
    return true;
  }

  resume(): boolean {
    if (this.heldReason === null) return false;
    this.heldReason = null;
    return true;
  }

  /** Remove every pending entry; returns exactly what was discarded. */
  clear(): readonly QueueEntry[] {
    const removed = this.entries;
    this.entries = [];
    this.heldReason = null;
    return removed;
  }

  remove(id: string): QueueResult {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return { ok: false, message: this.missing(id) };
    this.entries = this.entries.filter(e => e.id !== id);
    if (!this.entries.length) this.heldReason = null;
    return { ok: true, entry };
  }

  /** Replace an entry's text in place. The replacement is classified exactly as
   * typed input would be and must produce the same entry type. */
  edit(id: string, raw: string): QueueResult {
    const index = this.entries.findIndex(e => e.id === id);
    if (index < 0) return { ok: false, message: this.missing(id) };
    const current = this.entries[index]!;
    const next = classifyConsoleInput(raw);
    let input: QueueableInput;
    if (current.input.kind === "chat") {
      if (next.kind !== "chat") {
        return { ok: false, message: `${id} is a chat entry and the replacement is not chat text. Not changed (use \\! for chat text starting with !).` };
      }
      if (next.text.startsWith("/")) return { ok: false, message: `${id} is a chat entry; slash commands are not queued. Not changed.` };
      input = { kind: "chat", text: next.text };
    } else if (current.input.kind === "shell") {
      if (next.kind !== "shell") return { ok: false, message: `${id} is a user shell entry; the replacement must be !<command>. Not changed.` };
      input = { kind: "shell", command: next.command };
    } else {
      return { ok: false, message: `${id} is a ${entryKind(current.input)} action with no editable text. Remove it and queue a new one.` };
    }
    if (this.bytes - inputBytes(current.input) + inputBytes(input) > QUEUE_MAX_BYTES) {
      return { ok: false, message: `Edit would exceed the ${QUEUE_MAX_BYTES / 1024} KiB queue bound. Not changed.` };
    }
    const entry: QueueEntry = { id: current.id, input };
    this.entries = this.entries.map((e, i) => (i === index ? entry : e));
    return { ok: true, entry };
  }

  private missing(id: string): string {
    if (this.runningEntry?.id === id) return `${id} is running and cannot be changed; Ctrl+C cancels it.`;
    return `No pending entry ${id} (it already ran, was removed, or never existed). /queue lists pending entries.`;
  }

  /** `runningLabel` names non-entry work (a slash command) when nothing queued runs. */
  render(runningLabel: string | null = null): string {
    const running = this.runningEntry ? entryLine(this.runningEntry) : runningLabel;
    const paused = this.heldReason ? ` — PAUSED (${this.heldReason}); nothing runs until /queue resume` : "";
    const lines = [
      `Queue: ${this.entries.length} pending${paused}. Bound: ${QUEUE_MAX_ENTRIES} entries, ${QUEUE_MAX_BYTES / 1024} KiB (${this.bytes} B used).`,
      `  running  ${running ?? "nothing"}`,
      ...this.entries.map((e, i) => `  ${String(i + 1).padStart(2)}.     ${entryLine(e)}`),
    ];
    if (this.entries.length) lines.push("Edit: /queue edit <id> <text> · remove: /queue remove <id> · clear: /queue clear");
    return lines.join("\n") + "\n";
  }
}

/** Disposition text after failure, cancellation or shell-state loss. */
export function renderDisposition(header: string, entries: readonly QueueEntry[], footer = ""): string {
  if (!entries.length) return "";
  return [header, ...entries.map(e => "  " + entryLine(e)), ...(footer ? [footer] : [])].join("\n") + "\n";
}
