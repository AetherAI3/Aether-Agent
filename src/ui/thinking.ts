// src/ui/thinking.ts — the pre-first-byte liveness pulse. Between submitting a
// turn and the first streamed frame the terminal used to sit silent; this
// writes one soft animated line and clears it the moment real output arrives.
// \r-pinned single line; callers gate on TTY/--json/AETHER_NO_ANIM so piped
// and machine consumers never see a byte of it.
//
// After `stallAfterMs` with no frame the line turns honest — "still waiting,
// Ctrl+C cancels the turn" — because a silent multi-second hang otherwise
// looks indistinguishable from a hung process (E10 arena finding).

import { KAOMOJI } from "./kaomoji.js";

const GLYPHS = [KAOMOJI.idle];
const CLR = "\r\x1b[2K";

/** One pulse frame, plain (styling happens at the write site). Pure. */
export function thinkingFrame(tick: number, stalled: boolean): string {
  const dots = "·".repeat((tick % 3) + 1).padEnd(3);
  const base = `${GLYPHS[tick % GLYPHS.length]} thinking${dots}`;
  return stalled ? `${base} — still waiting · Ctrl+C cancels the turn` : base;
}

export interface ThinkingPulseOptions {
  /** Write target (default process.stdout — callers may inject stderr). */
  write?: (s: string) => void;
  /** Off = zero bytes ever. Caller computes the TTY/json/NO_ANIM gate. */
  enabled?: boolean;
  /** Paint cadence (default 240ms). */
  intervalMs?: number;
  /** Frameless time before the stall suffix appears (default 10s). */
  stallAfterMs?: number;
  /** Called after every paint. In the REPL this re-syncs the caller's own
   *  input-line redraw (same tty row), since a keystroke typed ahead during
   *  the pulse window otherwise gets stomped by the next `\r`-repaint. */
  onPaint?: (frame: string) => void;
}

export class ThinkingPulse {
  private readonly write: (s: string) => void;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly stallAfterMs: number;
  private readonly onPaint?: (frame: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private shown = false;
  private startedAt = 0;

  constructor(opts: ThinkingPulseOptions = {}) {
    this.write = opts.write ?? ((s) => process.stdout.write(s));
    this.enabled = opts.enabled ?? true;
    this.intervalMs = opts.intervalMs ?? 240;
    this.stallAfterMs = opts.stallAfterMs ?? 10_000;
    this.onPaint = opts.onPaint;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.startedAt = Date.now();
    this.paint();
    this.timer = setInterval(() => this.paint(), this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Clear the pulse line (idempotent). Call before the first real write. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.shown) {
      this.write(CLR);
      this.shown = false;
    }
  }

  private paint(): void {
    const stalled = Date.now() - this.startedAt >= this.stallAfterMs;
    const frame = thinkingFrame(this.tick++, stalled);
    this.write(CLR + frame);
    this.shown = true;
    this.onPaint?.(frame);
  }
}
