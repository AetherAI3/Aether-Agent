// src/ui/input_line.ts — a small, testable input model for the pinned prompt.
// Owns the edit buffer, cursor, and history; terminal wiring (raw mode,
// bracketed paste, key decode) lives in chat.ts and calls these pure methods.
// History semantics: consecutive duplicates collapse, recalling history
// stashes the in-progress draft (restored when you arrow back down), and the
// REPL persists entries across sessions via core/history_store.

interface EditSnapshot {
  value: string;
  cursor: number;
  histIdx: number;
  draft: string | null;
  bytes: number;
}

const MAX_UNDO_STEPS = 64;
const MAX_UNDO_BYTES = 1024 * 1024;
const MAX_YANK_BYTES = 1024 * 1024;

export class InputBuffer {
  private chars: string[] = [];
  private cursor = 0;
  private history: string[] = [];
  private histIdx = -1;
  private draft: string | null = null; // the line being typed when history recall began
  private undoStack: EditSnapshot[] = [];
  private undoBytes = 0;
  private killedText: string | null = null;
  private typingEnd: number | null = null;

  get value(): string {
    return this.chars.join("");
  }
  get pos(): number {
    return this.cursor;
  }

  private breakTyping(): void { this.typingEnd = null; }

  private saveEdit(coalesce = false): void {
    if (coalesce && this.typingEnd === this.cursor) return;
    const value = this.value;
    const bytes = Buffer.byteLength(value, "utf8") + Buffer.byteLength(this.draft ?? "", "utf8");
    if (bytes > MAX_UNDO_BYTES) { this.undoStack = []; this.undoBytes = 0; return; }
    this.undoStack.push({ value, cursor: this.cursor, histIdx: this.histIdx, draft: this.draft, bytes });
    this.undoBytes += bytes;
    while (this.undoStack.length > MAX_UNDO_STEPS || this.undoBytes > MAX_UNDO_BYTES) {
      this.undoBytes -= this.undoStack.shift()!.bytes;
    }
  }

  private insertText(s: string, typing: boolean): void {
    if (!s) return;
    this.saveEdit(typing);
    // One O(n) rebuild — splice-per-char is O(n²) and freezes on large pastes.
    const add = [...s];
    this.chars = this.chars.slice(0, this.cursor).concat(add, this.chars.slice(this.cursor));
    this.cursor += add.length;
    this.typingEnd = typing ? this.cursor : null;
  }
  /** Adjacent printable typing is one undo transaction until another action. */
  insert(s: string): void {
    this.insertText(s, !s.includes("\n") && !s.includes("\r"));
  }
  insertNewline(): void {
    this.insertText("\n", false);
  }
  /** Completion replaces the current draft as one undoable edit. */
  replace(s: string, cursor: number = [...s].length): void {
    if (s === this.value) {
      this.cursor = Math.max(0, Math.min(cursor, this.chars.length));
      this.breakTyping();
      return;
    }
    this.saveEdit();
    this.chars = [...s];
    this.cursor = Math.max(0, Math.min(cursor, this.chars.length));
    this.histIdx = -1;
    this.draft = null;
    this.breakTyping();
  }
  /** Restore the exact draft/caret from before a temporary input overlay. */
  restoreDraft(value: string, cursor: number): void {
    this.chars = [...value];
    this.cursor = Math.max(0, Math.min(cursor, this.chars.length));
    this.histIdx = -1;
    this.draft = null;
    this.endRecoveryScope();
  }
  /** A bracketed-paste block: inserted verbatim (newlines kept) at the cursor. */
  paste(block: string): void {
    this.breakTyping();
    this.insertText(block, false);
  }
  backspace(): void {
    if (this.cursor > 0) {
      this.saveEdit();
      this.chars.splice(this.cursor - 1, 1);
      this.cursor--;
    }
    this.breakTyping();
  }
  /** Delete the char at the cursor (the `Del` key). */
  deleteForward(): void {
    if (this.cursor < this.chars.length) { this.saveEdit(); this.chars.splice(this.cursor, 1); }
    this.breakTyping();
  }
  /** Kill from the cursor to end of line (ctrl-k). */
  killToEnd(): void {
    const killed = this.chars.slice(this.cursor).join("");
    if (killed) { this.saveEdit(); this.rememberKill(killed); }
    this.chars.splice(this.cursor);
    this.breakTyping();
  }
  /** Kill from start of line to the cursor (ctrl-u). */
  killToStart(): void {
    const killed = this.chars.slice(0, this.cursor).join("");
    if (killed) { this.saveEdit(); this.rememberKill(killed); }
    this.chars.splice(0, this.cursor);
    this.cursor = 0;
    this.breakTyping();
  }
  deleteWord(): void {
    let i = this.cursor;
    while (i > 0 && this.chars[i - 1] === " ") i--;
    while (i > 0 && this.chars[i - 1] !== " ") i--;
    const killed = this.chars.slice(i, this.cursor).join("");
    if (killed) { this.saveEdit(); this.rememberKill(killed); }
    this.chars.splice(i, this.cursor - i);
    this.cursor = i;
    this.breakTyping();
  }
  private rememberKill(text: string): void {
    this.killedText = Buffer.byteLength(text, "utf8") <= MAX_YANK_BYTES ? text : null;
  }
  yank(): void {
    if (this.killedText) this.insertText(this.killedText, false);
    this.breakTyping();
  }
  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.undoBytes -= previous.bytes;
    this.chars = [...previous.value];
    this.cursor = previous.cursor;
    this.histIdx = previous.histIdx;
    this.draft = previous.draft;
    this.breakTyping();
  }
  /** A different input owner cannot recover this draft's earlier edits. */
  endRecoveryScope(): void {
    this.undoStack = [];
    this.undoBytes = 0;
    this.killedText = null;
    this.breakTyping();
  }
  left(): void {
    if (this.cursor > 0) this.cursor--;
    this.breakTyping();
  }
  right(): void {
    if (this.cursor < this.chars.length) this.cursor++;
    this.breakTyping();
  }
  /** Jump to the start of the previous word (ctrl/alt-left). */
  wordLeft(): void {
    let i = this.cursor;
    while (i > 0 && this.chars[i - 1] === " ") i--;
    while (i > 0 && this.chars[i - 1] !== " ") i--;
    this.cursor = i;
    this.breakTyping();
  }
  /** Jump past the end of the next word (ctrl/alt-right). */
  wordRight(): void {
    let i = this.cursor;
    const n = this.chars.length;
    while (i < n && this.chars[i] === " ") i++;
    while (i < n && this.chars[i] !== " ") i++;
    this.cursor = i;
    this.breakTyping();
  }
  home(): void {
    this.cursor = 0;
    this.breakTyping();
  }
  end(): void {
    this.cursor = this.chars.length;
    this.breakTyping();
  }
  clear(): void {
    this.chars = [];
    this.cursor = 0;
    this.histIdx = -1;
    this.draft = null;
    this.endRecoveryScope();
  }
  /** Record a submitted line into history and clear the buffer.
   *  Consecutive duplicates collapse to one entry. */
  commit(line: string): void {
    if (line.trim() && this.history[this.history.length - 1] !== line) {
      this.history.push(line);
    }
    this.clear();
  }
  /** Seed history from a persisted store (oldest first). */
  loadHistory(lines: readonly string[]): void {
    this.history = [...lines];
    this.histIdx = -1;
    this.endRecoveryScope();
  }
  historyUp(): void {
    if (this.history.length === 0) return;
    if (this.histIdx === 0) return;
    this.saveEdit();
    if (this.histIdx < 0) {
      this.draft = this.value; // stash what was being typed
      this.histIdx = this.history.length - 1;
    } else {
      this.histIdx = Math.max(0, this.histIdx - 1);
    }
    this.setTo(this.history[this.histIdx]!);
    this.breakTyping();
  }
  historyDown(): void {
    if (this.histIdx < 0) return;
    this.saveEdit();
    this.histIdx++;
    if (this.histIdx >= this.history.length) {
      this.histIdx = -1;
      this.setTo(this.draft ?? ""); // restore the stashed draft
      this.draft = null;
    } else {
      this.setTo(this.history[this.histIdx]!);
    }
    this.breakTyping();
  }
  private setTo(s: string): void {
    this.chars = [...s];
    this.cursor = this.chars.length;
  }
}
