// status_renderer.ts — single output authority for the one-shot `aether agent`.
// Scrollback above (meaningful events) + ONE pinned, animated status line below.
// log() clears the pinned line, writes the event, repaints the status. No
// alt-screen (that's TuiLayout, for the persistent REPL) — just a `\r`-pinned
// line, which is the right shape for a run-to-completion command.
//
// PRESENTATION ONLY. Writes through an injected RenderSink (StdoutSink for the
// CLI; an xterm-backed sink for the desktop/web embed; a StringSink for tests).
// Color + TTY come from the sink, never from process globals — that is what lets
// an Electron renderer get full ANSI. Non-tty sink -> plain lines, never `\r`/ANSI.
// Honors AETHER_NO_ANIM=1 (animation off). The §8 emission logs stay clean.

import { createTheme, type Theme } from "./theme.js";
import { humanTokens } from "./statusbar.js";
import { formatElapsed } from "./elapsed.js";
import { sliceVisible } from "./text.js";
import { StdoutSink, type RenderSink } from "./sink.js";

/** Structural shape that StatusRenderer.memoryEvent accepts — matches both
 *  StreamFrame's memory variant and BrainEvent's memory variant. */
export interface MemoryFrameShape {
  type: "memory";
  subtype: string;
  text?: string;
  kind?: string;
  confidence?: number;
  skill?: string;
  narrative?: string;
  factCount?: number;
  beforeTokens?: number;
  afterTokens?: number;
  freedPct?: number;
  dimension?: string;
  from?: number;
  to?: number;
  direction?: string;
  // behavioral skill fields
  skill_name?: string;
  description?: string;
  triggers?: string[];
  action?: string;
  category?: string;
}

const ESC = "\x1b[";
const CLR_LINE = "\r" + ESC + "2K"; // carriage-return + clear-to-EOL
const HIDE = ESC + "?25l";
const SHOW = ESC + "?25h";

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export interface StatusRendererOptions {
  quiet?: boolean;
  /** "local" hides the UVT figure; "api" shows used/cap. */
  mode?: "local" | "api";
  /** Injected clock (ms). Defaults to Date.now — overridden in tests. */
  now?: () => number;
  /** Where rendered output goes. Defaults to a StdoutSink (CLI). */
  sink?: RenderSink;
  /** Color theme. Defaults to createTheme(sink.colorEnabled). */
  theme?: Theme;
  /** Install process exit/SIGINT cursor-restore handlers. CLI=true, embed=false. Default true. */
  ownsProcess?: boolean;
}

export class StatusRenderer {
  private readonly sink: RenderSink;
  private readonly theme: Theme;
  private readonly ownsProcess: boolean;
  private readonly tty: boolean;
  private readonly mode: "local" | "api";
  private readonly now: () => number;
  private hb = "·";
  private anim = "";
  private verb = "Working";
  private kao = "";
  private streamed = 0; // output tokens streamed this run (the ↑ figure)
  private used = 0;
  private cap = 0;
  private tasks = ""; // pre-styled multi-task counter (e.g. "3/7"); "" hides it
  private beats = 0; // heartbeat pulses so far (the live "tracking each beat")
  private startedMs: number;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private promptPaused = false;
  private ended = false;
  private cleanupBound = false;
  private onExit: (() => void) | null = null;
  private onSigint: (() => void) | null = null;

  constructor(opts: StatusRendererOptions = {}) {
    this.sink = opts.sink ?? new StdoutSink();
    this.theme = opts.theme ?? createTheme(this.sink.colorEnabled);
    this.ownsProcess = opts.ownsProcess ?? true;
    this.tty = this.sink.isTTY && !opts.quiet && process.env["AETHER_NO_ANIM"] !== "1";
    this.mode = opts.mode ?? "local";
    this.now = opts.now ?? (() => Date.now());
    this.startedMs = this.now();
  }

  start(): void {
    this.ended = false;
    this.startedMs = this.now(); // begin the thinking timer (even off-TTY: harmless)
    if (!this.tty) return;
    try { this.sink.write(HIDE); } catch { /* terminal already gone */ }
    this.installCleanup();
    this.ticker = setInterval(() => this.repaint(), 1000);
    if (typeof this.ticker.unref === "function") this.ticker.unref();
    this.repaint();
  }

  /** Keep a human confirmation visible while animation and heartbeat timers tick. */
  pauseForPrompt(): () => void {
    if (!this.tty || this.ended) return () => {};
    this.promptPaused = true;
    try { this.sink.write(CLR_LINE + SHOW); } catch { /* terminal already gone */ }
    let resumed = false;
    return () => {
      if (resumed || this.ended) return;
      resumed = true;
      this.promptPaused = false;
      try { this.sink.write(HIDE); } catch { /* terminal already gone */ }
      this.repaint();
    };
  }

  /** A meaningful scrollback line (tool call, checkpoint, monologue, result). */
  log(line: string): void {
    if (!this.tty) {
      this.sink.write(line + "\n");
      return;
    }
    this.sink.write(CLR_LINE + line + "\n");
    this.repaint();
  }

  setHeartbeat(g: string): void {
    this.hb = g;
    this.repaint();
  }
  /** Update the live heartbeat count (drives the thinking timer's ♥ counter). */
  setBeats(n: number): void {
    this.beats = n;
    this.repaint();
  }
  /** Set the activity word + kaomoji (from phaseVerb). */
  setVerb(verb: string, kao: string): void {
    this.verb = verb;
    this.kao = kao;
    this.repaint();
  }
  /** Cumulative output tokens streamed this run (telemetry.tokens). */
  setStreamed(n: number): void {
    this.streamed = finiteNonNegative(n);
    this.repaint();
  }
  /** Current stage-animation frame (from AnimationController.onFrame). */
  setAnim(art: string): void {
    this.anim = art;
    this.repaint();
  }
  setProgress(used: number, cap: number): void {
    this.used = finiteNonNegative(used);
    this.cap = finiteNonNegative(cap);
    this.repaint();
  }
  /** A compact, pre-styled multi-task counter pinned alongside the stage. */
  setTasks(summary: string): void {
    this.tasks = summary;
    this.repaint();
  }

  /** Called when a memory frame arrives. Logs a formatted line + briefly
   *  switches the status verb to the matching memory phase. */
  memoryEvent(frame: MemoryFrameShape): void {
    switch (frame.subtype) {
      case "extract": {
        const pct = frame.confidence ? `  ${this.theme.dim(`(${Math.round(frame.confidence * 100)}%)`)}` : "";
        this.log(`${this.theme.iceBlue("🧠")}  ${this.theme.bold("memory:")} "${frame.text}"${pct}`);
        this.setVerb("Extracting memory", "(◕‿◕)✎");
        break;
      }
      case "skill": {
        const pct = frame.confidence ? `  ${this.theme.dim(`(${Math.round(frame.confidence * 100)}%)`)}` : "";
        this.log(`${this.theme.cyan("🎯")}  ${this.theme.bold("skill learned:")} ${frame.skill} — "${frame.text}"${pct}`);
        this.setVerb("Learning skill", "🧠✨");
        break;
      }
      case "behavioral": {
        const name = frame.skill_name ?? "unknown";
        const pct = frame.confidence ? `  ${this.theme.dim(`(${Math.round(frame.confidence * 100)}%)`)}` : "";
        this.log(`${this.theme.iceBlue("🧠")}  ${this.theme.bold("new skill created:")} ${name}${pct}`);
        this.setVerb("Learning workflow", "🧠✨");
        break;
      }
      case "compacting": {
        const before = humanTokens(frame.beforeTokens ?? 0);
        const after = humanTokens(frame.afterTokens ?? 0);
        const pct = frame.freedPct != null ? ` ${this.theme.dim(`(${frame.freedPct}% freed)`)}` : "";
        this.log(`${this.theme.dim("📦")}  ${this.theme.dim("Compacting context ·")} ${before} → ${after} tokens${pct}`);
        this.setVerb("Compacting context", "(；・∀・)📦");
        break;
      }
      case "dream": {
        this.log(`${this.theme.iceBlue("💭")}  ${this.theme.bold("dream:")} ${frame.narrative?.slice(0, 120) ?? ""}`);
        this.setVerb("Consolidating", "(￣～￣;)💭");
        break;
      }
      case "style": {
        this.log(
          `${this.theme.cyan("🎨")}  ${this.theme.bold("style:")} ` +
          `${frame.dimension} ${this.theme.dim(`${frame.from?.toFixed(2)} → ${frame.to?.toFixed(2)}`)} ` +
          `(${frame.direction})`
        );
        this.setVerb("Adapting style", "(｡•̀ᴗ-)✧");
        break;
      }
    }
  }

  /** Tear down: clear the pinned line, restore the cursor. */
  end(): void {
    this.ended = true;
    this.promptPaused = false;
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    this.disposeProcessHandlers();   // H2: always clean listeners
    if (!this.tty) return;
    try { this.sink.write(CLR_LINE + SHOW); } catch { /* terminal already gone */ }
  }

  private repaint(): void {
    if (!this.tty || this.promptPaused || this.ended) return;
    try { this.sink.write(CLR_LINE + this.composeLine()); } catch { /* terminal already gone */ }
  }

  /** The pinned status line. Reads the injected clock — public for tests.
   *  Clamped to the sink width via sliceVisible: a wrapped pinned line breaks
   *  the \r+2K repaint and strands a junk row every tick (10-20 repaints/sec
   *  with the heartbeat, so an unclamped wrap floods the screen fast). */
  composeLine(): string {
    const hb = this.theme.cyan(this.hb);
    const anim = this.anim ? `${this.theme.cyan(this.anim)}  ` : "";
    const kao = this.kao ? this.theme.dim(this.kao) + " " : "";
    const head = `${kao}${this.theme.bold(this.verb)}…`;
    const tasksSeg = this.tasks ? "  " + this.tasks : ""; // pre-styled "n/7" counter
    const elapsed = formatElapsed(this.now() - this.startedMs);
    const up = this.streamed > 0 ? ` · ↑ ${humanTokens(this.streamed)} tokens` : "";
    // The heartbeat count rides alongside elapsed time so the thinking timer
    // visibly ticks on every beat, not just once a second.
    const beatsSeg = this.beats > 0 ? ` ♥${this.beats}` : "";
    const uvt =
      this.mode === "api" && this.cap > 0
        ? `  ${this.theme.dim(`UVT ${humanTokens(this.used)}/${humanTokens(this.cap)} ${this.bar()}`)}`
        : "";
    const line =
      `${hb}  ${anim}${head}${tasksSeg} ${this.theme.dim(`(${elapsed}${beatsSeg}${up})`)}${uvt}`;
    return sliceVisible(line, Math.max(20, this.sink.columns - 1));
  }

  private bar(width = 12): string {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const frac = this.cap > 0 ? (this.used >= this.cap ? 1 : this.used / this.cap) : 0;
    const filled = Math.max(0, Math.min(safeWidth, Math.round(frac * safeWidth)));
    return "▓".repeat(filled) + "░".repeat(safeWidth - filled);
  }

  /** Guarded cursor-restore for SIGINT only (see onSigint below). Public-ish for tests. */
  _restoreOnSignalForTest(): void {
    try { this.sink.write(SHOW); } catch { /* terminal already gone */ }
    try { this.sink.write("\n"); } catch { /* terminal already gone */ }
  }

  private installCleanup(): void {
    if (!this.ownsProcess || this.cleanupBound) return;
    this.cleanupBound = true;
    // Plain exit: just show the cursor. No trailing "\n" here — unlike SIGINT,
    // a normal exit isn't interrupting a still-pinned line mid-repaint.
    const restore = (): void => {
      try { this.sink.write(SHOW); } catch { /* terminal already gone */ }
    };
    const onSigint = (): void => {
      this._restoreOnSignalForTest();   // H1: both writes guarded
      process.exit(130);
    };
    this.onExit = restore;
    this.onSigint = onSigint;
    process.on("exit", restore);
    process.on("SIGINT", onSigint);
  }

  /** H2: remove the process listeners installed by installCleanup(). */
  private disposeProcessHandlers(): void {
    if (this.onExit) { process.off("exit", this.onExit); this.onExit = null; }
    if (this.onSigint) { process.off("SIGINT", this.onSigint); this.onSigint = null; }
    this.cleanupBound = false;
  }
}
