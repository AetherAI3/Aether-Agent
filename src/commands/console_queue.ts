import { classifyConsoleInput, type ConsoleInput } from "./console_input.js";
import { sanitizeShellAttachment, shellAttachment, SHELL_ATTACHMENT_BODY_BYTES } from "./shell_attachment.js";
import { terminalSafeReview } from "../core/tool_approval.js";

export const CONSOLE_QUEUE_MAX_ENTRIES = 32;
export const CONSOLE_QUEUE_MAX_BYTES = 64 * 1024;
export type QueuedInput = Extract<ConsoleInput, { kind: "chat" | "shell" | "reset-shell" | "attachment" }>;
export interface QueueEntry {
  readonly id: string;
  readonly input: QueuedInput;
  readonly approved: boolean;
}
export type QueueControl = { action: "list" | "clear" | "remove" | "edit" | "send" | "run" | "invalid"; id?: string; text?: string };

/** Parse management before the legacy /queue <task> prefix or chat history. */
export function parseQueueControl(raw: string): QueueControl | null {
  const match = /^\s*\/queue(?:\s+(list|clear|remove|edit|send|run)(?:[ \t]+(\S+))?(?:[ \t]+([\s\S]*))?)?\s*$/.exec(raw);
  if (!match) return /^\s*\/queue\s+(?:list|clear|remove|edit|send|run)(?:\s|$)/.test(raw) ? { action: "invalid" } : null;
  if (match[3] && !match[2]) return { action: "invalid" };
  return { action: (match[1] ?? "list") as QueueControl["action"], ...(match[2] ? { id: match[2] } : {}), ...(match[3] !== undefined ? { text: match[3] } : {}) };
}

export function queueKind(input: QueuedInput): string {
  return input.kind === "shell" ? "user shell" : input.kind === "attachment" ? "shell-share" : input.kind === "reset-shell" ? "shell reset" : "chat";
}

// Include retained provenance/body copies, not just the model-facing selection.
function bytes(input: QueuedInput): number { return Buffer.byteLength(JSON.stringify(input), "utf8"); }
function entry(id: string, input: QueuedInput, approved = true): QueueEntry {
  return Object.freeze({ id, input: Object.freeze({ ...input }), approved });
}

/** Bounded, memory-only FIFO. Active entries are never editable or removable. */
export class ConsoleQueue {
  private pending: QueueEntry[] = [];
  private nextId = 1;
  active: QueueEntry | null = null;
  constructor(readonly maxEntries = CONSOLE_QUEUE_MAX_ENTRIES, readonly maxBytes = CONSOLE_QUEUE_MAX_BYTES) {}
  get length(): number { return this.pending.length; }
  get byteLength(): number { return this.pending.reduce((total, item) => total + bytes(item.input), 0); }
  get waitingForApproval(): boolean { return this.pending[0]?.approved === false; }
  list(): readonly QueueEntry[] { return [...this.pending]; }
  enqueue(input: QueuedInput): QueueEntry | string {
    if (this.length >= this.maxEntries || this.byteLength + bytes(input) > this.maxBytes) return `Queue full: maximum ${this.maxEntries} pending entries / ${this.maxBytes} UTF-8 bytes. Submission not queued; remove or clear pending entries.`;
    const added = entry(`q${this.nextId++}`, input);
    this.pending.push(added);
    return added;
  }
  start(input: QueuedInput): QueueEntry { return this.active = entry(`q${this.nextId++}`, input); }
  /** Stop at an unapproved head; never skip/reorder it to execute later work. */
  take(): QueueEntry | null {
    if (!this.pending[0]?.approved) return null;
    return this.active = this.pending.shift()!;
  }
  finish(): void { this.active = null; }
  private index(id: string): number { return this.pending.findIndex(item => item.id === id); }
  private missing(id: string): string {
    return this.active?.id === id ? `${id} is active and immutable; use Ctrl+C to cancel the active operation.` : `No pending entry ${id}.`;
  }
  remove(id: string): string {
    const index = this.index(id);
    if (index < 0) return this.missing(id);
    const [removed] = this.pending.splice(index, 1);
    return `Discarded ${removed!.id} (${queueKind(removed!.input)}); ${this.length} pending. Nothing executed.`;
  }
  clear(reason: string): string {
    const discarded = this.pending.map(item => `${item.id} (${queueKind(item.input)})`);
    this.pending = [];
    return `Queue ${reason}: discarded ${discarded.length ? discarded.join(", ") : "none"}; 0 pending. No discarded entry will resume.`;
  }
  edit(id: string, text: string): string {
    const index = this.index(id);
    if (index < 0) return this.missing(id);
    const old = this.pending[index]!;
    let replacement: QueuedInput;
    if (old.input.kind === "attachment") {
      const body = sanitizeShellAttachment(text);
      if (Buffer.byteLength(body) > SHELL_ATTACHMENT_BODY_BYTES) return `Edit refused: attachment body exceeds ${SHELL_ATTACHMENT_BODY_BYTES} UTF-8 bytes; pending entry unchanged.`;
      replacement = shellAttachment(old.input.capture, body, true);
    } else {
      const parsed = classifyConsoleInput(text);
      if (old.input.kind === "reset-shell" || parsed.kind !== old.input.kind || (parsed.kind === "chat" && parsed.text.startsWith("/"))) return `Edit refused: ${id} must remain ${queueKind(old.input)} (shell edits require !command); entry unchanged.`;
      replacement = parsed as QueuedInput;
    }
    if (this.byteLength - bytes(old.input) + bytes(replacement) > this.maxBytes) return `Edit refused: queue exceeds ${this.maxBytes} UTF-8 bytes; pending entry unchanged.`;
    this.pending[index] = entry(id, replacement, replacement.kind !== "attachment");
    return replacement.kind === "attachment"
      ? `Updated ${id} in place; old send approval revoked. Review this exact attachment, then /queue send ${id}:\n${replacement.text}`
      : `Updated ${id} (${queueKind(replacement)}) in place; ${this.length} pending.`;
  }
  approve(id: string): string {
    const index = this.index(id);
    if (index < 0) return this.missing(id);
    const old = this.pending[index]!;
    if (old.input.kind !== "attachment") return `${id} is not a shell-share entry.`;
    if (!old.input.body.trim()) return `Empty shell selection ${id} remains unsent; use /queue remove ${id}.`;
    this.pending[index] = entry(id, old.input);
    return `Reviewed attachment ${id} approved for its existing FIFO position.`;
  }
  describe(): string {
    const active = this.active ? `${this.active.id} (${queueKind(this.active.input)}, immutable)` : "none";
    const lines = [`Active: ${active}. Pending: ${this.length}/${this.maxEntries}, ${this.byteLength}/${this.maxBytes} UTF-8 bytes.`];
    for (const item of this.pending) {
      const input = item.input;
      const text = input.kind === "chat" || input.kind === "attachment" ? input.text : input.kind === "shell" ? "!" + input.command : "/shell-reset";
      lines.push(`${item.id} | ${queueKind(input)} | ${item.approved ? "ready" : "awaiting explicit /queue send"}${input.kind === "attachment" ? " | bound capture " + input.capture.id : ""}\n${terminalSafeReview(text)}`);
    }
    return lines.join("\n") + "\n";
  }
  control(command: QueueControl): { message: string; drain: boolean } {
    const local = (message: string) => ({ message, drain: false });
    if (command.action === "invalid") return local("Invalid queue control; use /queue list, edit <id> <replacement>, remove <id>, clear, send <id>, or run. Nothing queued.");
    if (command.action === "list" || command.action === "clear" || command.action === "run") {
      if (command.id || command.text) return local(`usage: /queue ${command.action}`);
      if (command.action === "run") return { message: this.waitingForApproval ? "Queue remains paused: first shell-share needs explicit /queue send <id>." : "Running ready pending entries in FIFO order.", drain: true };
      return local(command.action === "list" ? this.describe() : this.clear("cleared by user"));
    }
    if (!command.id || (command.action !== "edit" && command.text)) return local("usage: /queue remove|send <id>; /queue edit <id> <replacement>");
    if (command.action === "remove") return local(this.remove(command.id));
    if (command.action === "send") {
      const input = this.pending[this.index(command.id)]?.input;
      return { message: this.approve(command.id), drain: input?.kind === "attachment" && Boolean(input.body.trim()) };
    }
    return local(this.edit(command.id, command.text ?? ""));
  }
}
