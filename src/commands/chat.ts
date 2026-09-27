// `aether [prompt]` — one-shot if a prompt is given, else an interactive REPL.
// This is the coding front door: build an envelope, POST to the universal
// stream, decode frames, render. The agent brain runs on Aether's servers.

import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import type { AppContext, GlobalFlags } from "../core/context.js";
import { theme, errTheme } from "../ui/theme.js";
import { buildChatRequest } from "../core/envelope.js";
import { CHAT_STREAM_PATH, CHAT_PATH, defaultStreamTimeoutMs } from "../core/transport.js";
import { decodeSse } from "../core/stream.js";
import { Renderer } from "../core/render.js";
import { StreamIncompleteError, StreamUnavailableError, errorHint, isAbortError } from "../core/errors.js";
import { formatErrorLine } from "../ui/error_line.js";
import { appendCustody } from "../core/custody.js";
import { handleSlash, primeCatalog } from "./slash.js";
import { applyPromptMode } from "./prompt_modes.js";
import { userInfo } from "node:os";
import { renderSplash } from "../ui/splash.js";
import { promptPrefix } from "../ui/prompt.js";
import { InputBuffer } from "../ui/input_line.js";
import { renderInputView } from "../ui/input_render.js";
import { decodeKey, splitKeys } from "../ui/keys.js";
import { ThinkingPulse } from "../ui/thinking.js";
import { registerRestore } from "../ui/restore.js";
import { completeManifestSlash } from "./command_manifest.js";
// history_store.ts (origin/main's own persistence + AETHER_NO_HISTORY opt-out)
// supersedes the old readline-backed ./history.js — see chat.ts's resolution
// report for why that file is now dead code pending a cleanup pass.
import { loadHistory, appendHistory, historyPath, historyEnabled } from "../core/history_store.js";
import { VERSION } from "../version.js";
import { chooseBackend, type BackendPath } from "../core/backend.js";
import { OllamaBrain } from "../core/brain_ollama.js";
import { localModelId, resolveHostedModel, resolveLocalModel } from "../core/local_ollama.js";
import type { Brain } from "../core/brain.js";
import type { ToolResult } from "../core/tool_executor.js";
import { ToolExecutor } from "../core/tool_executor.js";
import { HostRenderer } from "../ui/host_render.js";
import type { TaskCommand } from "../core/brain.js";
import { getRegistry } from "../core/context_registry.js";
import { decideGate } from "../core/autonomy.js";
import { openRunSession, refusalToolResult } from "../core/skills/run_session.js";
import type { SkillRefusal } from "../core/skills/skill_errors.js";
import { renderHud, timerLive } from "../core/hud.js";
import {
  createViewerState,
  applyViewerFrame,
  moveCursor,
  renderCiTree,
  selectAgent,
  renderAgentFeed,
  togglePhaseExpanded,
  viewerClearSequence,
  viewerLineCount,
} from "../ui/workflow_viewer.js";
import type { WorkflowViewerState } from "../ui/workflow_viewer.js";
import type { StreamFrame } from "../core/stream.js";

// Key decoding lives in ui/keys.ts (shared with pickers/viewers); re-exported
// here so existing imports keep working.
export { decodeKey, type Key } from "../ui/keys.js";

// the Aether API ChatResponse: { response, commitment_hash, verified, threat_level }.
interface ChatJsonResponse {
  response?: string;
  commitment_hash?: string;
}

/** Thrown when a turn completes its stream but the server sent an `error`
 *  frame instead of `done` — a rendered "✗ msg" is NOT a successful turn
 *  (CONTRACTS.md invariant 5). runTurn is void+onFrame (orchestrator-style,
 *  see resolveBackend below); this is how it still signals failure to the
 *  one-shot `cmdChat` path without forcing a boolean-return shape onto every
 *  onFrame call site. */
/** Session-level skill selection for REPL/one-shot chat turns (`--skill`, `--no-skills`). */
export interface TurnSkillOptions {
  explicitSkill?: string;
  noSkills?: boolean;
}

export class ChatTurnError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ChatTurnError";
  }
}

/**
 * Resolve which brain runs this turn. AETHER_BACKEND (env) wins, then the saved
 * config, then 'auto'. 'auto' is local-first: cloud when signed in, else local
 * Ollama. Exported so the REPL banner can show the same answer the turn uses.
 */
export async function resolveBackend(ctx: AppContext): Promise<BackendPath> {
  const pref = (process.env["AETHER_BACKEND"] || ctx.cfg.backend || "auto").trim();
  const authed = Boolean(await ctx.tokens.get());
  return chooseBackend(pref, authed);
}

/** Run a single coding turn end to end. Exported for `run.ts` (orchestrators).
 * `signal` cancels the turn client-side (stream AND the fail-soft fallback) —
 * orchestrator runs inherit cancelability through this same seam. Throws
 * ChatTurnError if the server streamed an `error` frame, so callers can exit
 * non-zero instead of treating a rendered "✗ msg" as a successful turn. Also
 * throws StreamIncompleteError if the stream ends without ever sending a
 * terminal `done` or `error` frame (LOOP-06 round 3) — a clean-looking
 * premature close must not render as a successful turn either.
 * `onPulsePaint` fires after every thinking-pulse repaint (see
 * ThinkingPulseOptions.onPaint) so the REPL can re-sync its own input-line
 * redraw — typing ahead during the pre-first-token window would otherwise
 * get stomped by the pulse's own `\r`-repaint landing on the same tty row. */
export async function runTurn(
  ctx: AppContext,
  prompt: string,
  signal?: AbortSignal,
  onFrame?: (f: StreamFrame) => void,
  onPulsePaint?: () => void,
  skillOpts: TurnSkillOptions = {},
): Promise<void> {
  const backend = await resolveBackend(ctx);
  // The same seam `aether agent` uses (commands/code.ts). Opened per turn, not
  // per session, because automatic skill selection reads THIS prompt — a turn
  // that says "the CI is failing" should pull the CI skill and the next one
  // should not inherit it.
  const opened = openRunSession({
    projectRoot: ctx.flags.cwd,
    prompt,
    allowIncompleteInstructionDiscovery: backend === "cloud",
    ...(skillOpts.explicitSkill ? { explicitSkill: skillOpts.explicitSkill } : {}),
    ...(skillOpts.noSkills ? { noSkills: true } : {}),
  });
  if (!opened.ok) {
    // Painted here, then thrown as a ChatTurnError — the caller's contract is
    // that a ChatTurnError has already been rendered (see cmdChat), so this
    // must not be left for printError to duplicate.
    for (const line of opened.lines) process.stderr.write(errTheme.red(line) + "\n");
    throw new ChatTurnError(opened.refusal.code + ": " + opened.refusal.detail);
  }
  const run = opened.run;
  // Only say something when something was loaded, and only when it CHANGED.
  // A REPL re-opens its run session every turn (automatic selection reads the
  // prompt), so reprinting an identical five-line header on every turn would
  // bury the answers it sits above. A change — a skill matched, a rules file
  // was edited mid-session — still prints, which is the case worth seeing.
  // A notice is the whole point of this header: an untrusted skill, a manifest
  // that would not index, a rules file dropped for an unparsable scope. Those
  // can all occur with NOTHING composed — no rules, no skill body, zero context
  // tokens — so gating the header on composed size alone silently swallowed
  // exactly the cases the header exists to report.
  if (run.contextTokens > 0 || run.session.notices.length > 0 || run.hasWarnings) {
    const header = run.headerLines.join("\n");
    if (header !== lastTurnHeader) {
      lastTurnHeader = header;
      for (const line of run.headerLines) process.stderr.write(errTheme.dim("  " + line) + "\n");
    }
  } else {
    lastTurnHeader = null;
  }
  const brief = run.brief(prompt);

  if (backend === "local") {
    // Aether meters nothing on a local brain, so the session is unmetered
    // rather than "zero spend so far".
    getRegistry().markLocalUnmetered();
    // The signal used to be dropped here, so the REPL Ctrl+C controller could
    // not reach a local turn at all: the abort fired and nothing observed it.
    await runLocalTurn(ctx, brief, signal, {}, run.guard);
    return;
  }
  // The cloud REPL turn streams from /agent/chat/stream, where the SERVER runs
  // the tools. This host executes nothing on that path, so it can enforce
  // nothing on it either. Say so rather than let the Policy line above read as
  // a guarantee it is not: a narrowing the host cannot check is not in force.
  if (run.policies.length > 0) {
    process.stderr.write(
      errTheme.dim(
        "  " +
          "Policy".padEnd(10) +
          "! NOT ENFORCED on this turn — a cloud chat turn runs its tools server-side, " +
          "so the host cannot refuse them. Use `aether agent` for a host-enforced run.",
      ) + "\n",
    );
  }
  await runCloudTurn(ctx, brief, signal, onFrame, onPulsePaint);
}

/** Monotonic per-process turn id, so a settled turn can be recognised on replay. */
let cloudTurnCounter = 0;

/** Last skill/rules header printed, so an unchanged one is not reprinted per turn. */
let lastTurnHeader: string | null = null;

/** The cloud path — build an envelope, POST to the universal stream, render.
 * Extracted so runTurn can fork local vs cloud. */
async function runCloudTurn(
  ctx: AppContext,
  prompt: string,
  signal?: AbortSignal,
  onFrame?: (f: StreamFrame) => void,
  onPulsePaint?: () => void,
): Promise<void> {
  const reg = getRegistry();
  // The operator's session cap is checked BEFORE a billable turn starts. It is
  // a local circuit breaker, not a billing control: it stops this terminal
  // from starting more work, and changes nothing about the account.
  const cap = reg.checkUvtCap();
  if (cap.capped) {
    throw new ChatTurnError(
      `session UVT cap reached — ${cap.observed} of ${cap.cap} observed. ` +
        "No further turns will start. This is a local stop only; your plan and " +
        "balance are unchanged. Raise it with /limit <amount>, or /limit off.",
    );
  }
  const turnId = `turn-${++cloudTurnCounter}`;
  reg.beginTurn(turnId);
  const req = buildChatRequest({
    prompt,
    model: resolveHostedModel(ctx.flags.model, ctx.cfg.defaultModel),
    agent: ctx.flags.agent ?? "",
    // Only an explicit --model this invocation counts as a manual pick.
    manualModel: ctx.flags.model != null,
  });
  // Interactive TTY chat gets styled markdown + a pre-first-byte pulse;
  // pipes/--json stay byte-identical raw streams. AETHER_NO_ANIM is the
  // universal animation kill switch (status bar, splash, pulse all honor it).
  const interactive =
    Boolean(process.stdout.isTTY) && !ctx.flags.json && process.env["AETHER_NO_ANIM"] !== "1";
  const renderer = new Renderer({ json: ctx.flags.json, audit: ctx.flags.audit, markdown: interactive });
  // Pulse is presentation-only — like every other status/diagnostic writer in
  // this codebase (StatusRenderer, HostRenderer's status/telemetry), it must
  // target stderr so stdout stays byte-identical for redirection/piping, even
  // when a still-TTY stdout is being captured (script(1), pty recorders).
  const pulseInteractive =
    Boolean(process.stderr.isTTY) && !ctx.flags.json && process.env["AETHER_NO_ANIM"] !== "1";
  const pulse = new ThinkingPulse({
    enabled: pulseInteractive,
    write: (s) => process.stderr.write(errTheme.dim(s)),
    onPaint: onPulsePaint,
  });
  pulse.start();
  let sawError: string | null = null;
  // Whether a terminal `done` or `error` frame was actually observed. decodeSse's
  // for-await loop exits normally (no throw) once the underlying byte stream
  // ends — including a premature-but-clean close (proxy/load-balancer time-box,
  // etc.) that never sent either. Without this, such a close renders whatever
  // partial output arrived and returns as if the turn completed successfully
  // (LOOP-06 round 3).
  let sawTerminal = false;
  try {
    const stream = await ctx.api.stream(CHAT_STREAM_PATH, req, signal);
    for await (const frame of decodeSse(stream)) {
      // open/ping are handshake/keepalive — they render nothing. Stopping on
      // them re-created the dead air on keepalive-happy servers; only frames
      // that produce visible output own the line.
      if (frame.type !== "open" && frame.type !== "ping") pulse.stop();
      // The server signs each turn and returns it; persist the signed receipt
      // locally (best-effort, never breaks the chat).
      // The terminal frame carries the turn's authoritative cost. Settled by
      // turn id so a reconnect replaying it cannot count the same turn twice,
      // and only from the server's own number — never estimated from tokens.
      if (frame.type === "done") getRegistry().settleTurn(turnId, frame.uvt);
      if (frame.type === "custody") appendCustody(frame.custody);
      if (frame.type === "error") sawError = frame.msg;
      if (frame.type === "error" || frame.type === "done") sawTerminal = true;
      onFrame?.(frame);
      renderer.frame(frame);
    }
    // Presence of an error frame is authoritative even when its message is
    // empty. A later done frame can carry cost, but cannot turn failure into
    // success (or let a one-shot command exit zero).
    if (sawError !== null) throw new ChatTurnError(sawError);
    if (!sawTerminal) throw new StreamIncompleteError();
  } catch (err) {
    if (err instanceof StreamUnavailableError) {
      // Contract fail-soft: fall back to the non-streaming request/response.
      // Same signal — the fallback leg is cancelable too (arena AT-3d). A
      // full LLM turn can legitimately run long, so this explicitly opts
      // into stream()'s own generous bound instead of request()'s 30s
      // metadata-call default (LOOP-01/LOOP-06 round-1) — otherwise a
      // perfectly healthy but slow completion would be killed early.
      const r = await ctx.api.postJson<ChatJsonResponse>(CHAT_PATH, req, signal, defaultStreamTimeoutMs());
      pulse.stop();
      process.stdout.write((r.response ?? "") + "\n");
      if (ctx.flags.audit && r.commitment_hash) {
        process.stderr.write(`  signed ✓ ${r.commitment_hash}\n`);
      }
      return;
    }
    throw err;
  } finally {
    pulse.stop();
  }
}

/**
 * The local path — drive an OllamaBrain through the SAME event/tool-exec loop
 * the code command uses: the brain DECIDES (emits events), the host EXECUTES
 * each tool_call (one path-guarded ToolExecutor) and replies, the HostRenderer
 * draws every event. Identical UX to cloud, just an offline brain.
 */
export interface LocalTurnDeps {
  brain?: Brain;
  exec?: { executeAsync(name: string, args: Record<string, unknown>): Promise<ToolResult> };
}

export async function runLocalTurn(
  ctx: AppContext,
  prompt: string,
  signal?: AbortSignal,
  deps: LocalTurnDeps = {},
  skillGuard?: (tool: string) => SkillRefusal | null,
): Promise<void> {
  const cwd = ctx.flags.cwd;
  const model = resolveLocalModel(ctx.flags.model, ctx.cfg.localModel ?? "", {
    allowBareExplicit: ctx.flags.local === true,
  });
  const brain = deps.brain ?? new OllamaBrain({ model });
  const exec = deps.exec ?? new ToolExecutor(cwd);
  const renderer = new HostRenderer({ poolGb: 5, json: ctx.flags.json });
  const approveTool = async (name: string, args: Record<string, unknown>): Promise<boolean> => {
    const outcome = decideGate(name, ctx.cfg.permissionMode, ctx.cfg.autoApply, {
      yes: ctx.flags.yes,
      isTty: Boolean(process.stdin.isTTY),
    });
    if (outcome === "allow") return true;
    if (outcome === "deny") {
      process.stderr.write(`blocked ${name}: confirmation required; use --yes or permissionMode skip\n`);
      return false;
    }
    const detail = String(args["path"] ?? args["command"] ?? args["message"] ?? "");
    const shown = detail.length > 120 ? detail.slice(0, 117) + "..." : detail;
    return ctx.confirm(`\nwarning ${name}${shown ? " " + shown : ""} - run it? [y/N] `);
  };
  const task: TaskCommand = {
    type: "task",
    text: prompt,
    cwd,
    poolGb: 5,
    model,
  };
  let sawError: string | null = null;
  // close() is what unblocks a loop parked on a tool result, so an abort that
  // arrives mid-turn is observed rather than waiting out the whole turn.
  // Registered before the loop starts so an already-aborted signal still fires.
  const onAbort = (): void => brain.close();
  if (signal?.aborted) brain.close();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const ev of brain.run(task)) {
      if (signal?.aborted) break;
      renderer.event(ev);
      if (ev.type === "error") sawError = ev.msg;
      if (ev.type === "done" && !ev.ok) sawError = ev.result || ev.reason || "turn did not complete";
      if (ev.type === "tool_call") {
        // Same ordering as hostLoop (commands/code.ts): the skill narrowing is
        // checked first and refuses without executing or prompting; the
        // operator gate then decides about whatever survived. A skill can only
        // subtract here — it is never consulted again after this line.
        const refusal = skillGuard ? skillGuard(ev.name) : null;
        if (refusal) {
          brain.sendToolResult(ev.id, refusalToolResult(refusal));
        } else {
          // executeAsync so the two web tools (web_search/web_fetch) work too.
          const approved = await approveTool(ev.name, ev.args);
          const result = approved
            ? await exec.executeAsync(ev.name, ev.args)
            : { output: `[tool ${ev.name} blocked: permission denied]`, exitCode: 1 };
          brain.sendToolResult(ev.id, result);
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    brain.close();
  }
  // An aborted turn is not a failed one — the user asked for it to stop.
  if (signal?.aborted) return;
  // Mirror runCloudTurn/CONTRACTS.md invariant 5: a streamed error event is a
  // failed turn, not a silently-successful one — the renderer already painted
  // it, so callers (cmdChat/run.ts) special-case ChatTurnError to avoid a
  // double print.
  if (sawError) throw new ChatTurnError(sawError);
}

/** Apply a confirmed model/agent switch: set the new selection, clear the other,
 * and let the caller start a fresh session (context cleared). */
export function applyRestart(flags: GlobalFlags, r: { model?: string; agent?: string }): void {
  if (r.model) {
    flags.model = r.model;
    flags.agent = undefined;
  } else if (r.agent) {
    flags.agent = r.agent;
    flags.model = undefined;
  }
}

/** Build a prompt with optional steering and btw context prepended.
 *  Clears steering and btwNotes in the returned result so callers
 *  can use single-shot semantics.  Exported for testing. */
export function buildPromptContext(
  base: string,
  steering: string | null,
  btwNotes: string[],
): { prompt: string; steering: string | null; btwNotes: string[] } {
  const ctxParts: string[] = [];
  if (steering) ctxParts.push(`STEERING: ${steering}`);
  if (btwNotes.length) ctxParts.push(`NOTE: ${btwNotes.join("; ")}`);
  const prompt = ctxParts.length ? ctxParts.join("\n") + "\n\n" + base : base;
  return { prompt, steering: null, btwNotes: [] };
}

/** One composer repaint: clear the row, draw the cursor-windowed view, and put
 *  the hardware cursor at the caret's real column. Pure — unit-tested. */
export function repaintString(prompt: string, value: string, cursor: number, cols: number): string {
  const v = renderInputView(prompt, value, cursor, cols);
  return "\r\x1b[2K" + v.text + `\x1b[${v.cursorCol}G`;
}

/** What one Ctrl+C should do, given the REPL's state. A state machine, not a
 *  kill switch:
 *    mid-paste           → exit (a stuck paste must never brick raw mode)
 *    turn streaming      → abort the TURN, session lives (again → quit)
 *    draft in the buffer → clear the line
 *    idle, empty buffer  → press twice within the window to quit
 *  Pure — unit-tested. */
export type CtrlCAction = "exit" | "abort-turn" | "arm-quit" | "clear-line" | "arm-exit";
export function ctrlCDecision(s: {
  pasting: boolean;
  busy: boolean;
  abortable: boolean;
  hasDraft: boolean;
  armed: boolean;
}): CtrlCAction {
  if (s.pasting) return "exit";
  if (s.busy) {
    if (s.abortable) return "abort-turn";
    return s.armed ? "exit" : "arm-quit";
  }
  if (s.hasDraft) return "clear-line";
  return s.armed ? "exit" : "arm-exit";
}

/** Truncate a queued-prompt preview to 55 chars for the "⏳ Queued" echo lines. */
function previewLine(s: string): string {
  return s.length > 55 ? s.slice(0, 55) + "…" : s;
}

// A trailing partial escape sequence (CSI/SS3/OSC intro with no final byte) —
// held back until the next stdin chunk so markers/arrows split across chunk
// boundaries reassemble instead of degrading into garbage or a stuck paste.
// A BARE trailing ESC is NOT held: that's the Esc key (or an Alt chord whose
// tail lands in the same chunk), and holding it would delay it forever.
const PARTIAL_ESC_RE = /\x1b(?:\[[0-9;:<=>?]*[ -/]*|O|\])$/;

export async function cmdChat(
  ctx: AppContext,
  prompt: string,
  skillOpts: TurnSkillOptions = {},
): Promise<number> {
  if (prompt.trim()) {
    try {
      await runTurn(ctx, prompt, undefined, undefined, undefined, skillOpts);
      return 0;
    } catch (err) {
      // ChatTurnError: the Renderer already painted "✗ <msg>" for the
      // server's error frame — printError would double it.
      if (!(err instanceof ChatTurnError)) printError(err, ctx.cfg.baseUrl);
      return 1;
    }
  }
  return repl(ctx, skillOpts);
}

// skillOpts is session-level (`--skill` / `--no-skills` on the launching
// command): every turn in this REPL opens its run session with it.
async function repl(ctx: AppContext, skillOpts: TurnSkillOptions = {}): Promise<number> {
  const username = userInfo().username || "you";
  const backend = await resolveBackend(ctx);
  const model = backend === "local"
    ? localModelId(resolveLocalModel(ctx.flags.model, ctx.cfg.localModel ?? "", {
        allowBareExplicit: ctx.flags.local === true,
      }))
    : resolveHostedModel(ctx.flags.model, ctx.cfg.defaultModel) || "auto";
  process.stdout.write(
    renderSplash({
      version: VERSION,
      model: model || "auto",
      effort: ctx.cfg.defaultEffort || "default",
      // Single additive field (lane AA-CONT-04): passing the workspace turns on
      // the PROJECT CONTINUITY block in ui/splash.ts. Omitting it renders the
      // splash exactly as before, and reads nothing from disk.
      cwd: ctx.flags.cwd,
    }) + "\n\n",
  );
  // One-line dim banner: which brain serves turns this session (local-first).
  const where = backend === "local" ? "local Ollama (offline)" : "cloud (Aether API)";
  process.stdout.write(theme.dim(`backend: ${where}`) + "\n");
  process.stdout.write("Type a prompt, or /help for commands. /exit to quit.\n\n");
  if (!process.stdin.isTTY) return replLines(ctx, skillOpts);
  void primeCatalog(ctx); // non-blocking warm; first /models is then instant

  const buf = new InputBuffer();
  const histPath = historyPath(ctx.flags.cwd);
  if (historyEnabled()) buf.loadHistory(loadHistory(histPath));
  const remember = (line: string): void => {
    if (historyEnabled()) appendHistory(line, histPath);
  };
  const prompt = promptPrefix(username);
  // A turn/slash is async; Node still delivers stdin 'data' events while we
  // await. While busy, the buffer still ACCUMULATES (type-ahead, /steer, /queue)
  // but repaint is suppressed — a mid-stream "\r\x1b[2K" would stomp the line
  // the answer is currently streaming onto.
  let busy = false;
  const renderHudLine = (): void => {
    if (!process.stdout.isTTY) return;
    const reg = getRegistry();
    if (reg.hudElements.length === 0) return;
    const cols = process.stdout.columns ?? 80;
    const live = timerLive(reg.hudTimer);
    const state = {
      tokensUsed: reg.uvtSpent,
      tokensCap: reg.uvtCap ?? 1_000_000_000,
      sessionMs: live.userMs + live.agentMs,
      timer: reg.hudTimer,
      streamedTokens: 0,
      uvtUsed: reg.uvtSpent,
      uvtCap: reg.uvtCap ?? 0,
    };
    const line = renderHud(reg.hudElements, state, cols);
    if (line) process.stdout.write("\n" + line);
  };
  const repaint = (): void => {
    if (busy) return;
    process.stdout.write(repaintString(prompt, buf.value, buf.pos, process.stdout.columns ?? 80));
  };
  // Unlike repaint(), this does NOT gate on busy: it's the thinking-pulse's
  // onPaint hook, fired from inside the pulse's own \r-repaint on stderr
  // (which happens precisely DURING the busy window). The pulse and the
  // input line share the same tty row, so every pulse frame must be
  // followed by re-drawing whatever the user has typed ahead, or their
  // in-progress keystrokes get stomped by the pulse's next `\r\x1b[2K`.
  const redrawInput = (): void => {
    process.stdout.write(repaintString(prompt, buf.value, buf.pos, process.stdout.columns ?? 80));
  };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?2004h"); // bracketed paste ON
  // Crash-safe: even an uncaught throw restores cooked mode + paste-off.
  const unregisterRestore = registerRestore(() => {
    process.stdout.write("\x1b[?2004l\x1b[?25h");
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* terminal already gone */
    }
  });
  repaint();

  let pasting = false;
  let pasteAcc = "";
  let carry = ""; // partial escape sequence held across chunk boundaries
  const queue: string[] = [];
  let steering: string | null = null;
  const btwNotes: string[] = [];
  let turnAbort: AbortController | null = null; // live while a cloud turn streams
  // Live while a slash command (e.g. /audit, /doctor) is in flight — kept
  // separate from turnAbort so Ctrl+C cancels only the network call actually
  // running, not a chat turn that isn't (fixes: Ctrl+C during a slow slash
  // command used to fall through to the double-press "quit" prompt instead
  // of canceling it, since turnAbort was null).
  let slashAbort: AbortController | null = null;
  let ctrlCArmedAt = 0; // double-press window for quitting
  const CTRL_C_WINDOW_MS = 1500;
  // Workflow swarm viewer — updated as workflow_* frames arrive during a turn.
  let viewerState: WorkflowViewerState = createViewerState();
  let viewerOpen = false;
  // Line count of the last panel actually printed (tree or agent-feed), so
  // redrawViewerTree can clear exactly that many lines instead of stacking
  // duplicate copies in scrollback on every cursor move (Finding B).
  let viewerLastLines = 0;
  return await new Promise<number>((resolve) => {
    const onResize = (): void => repaint();
    const cleanup = (): void => {
      process.stdout.write("\x1b[?2004l\x1b[?25h"); // paste off + cursor shown
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* terminal already gone */
      }
      unregisterRestore();
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.removeListener("resize", onResize);
    };
    const finish = (code: number): void => {
      cleanup();
      process.stdout.write("\n");
      resolve(code);
    };

    /** Run one turn. Returns true when the user aborted it (Ctrl+C). */
    const runQueuedTurn = async (text: string): Promise<boolean> => {
      const built = buildPromptContext(text, steering, btwNotes);
      steering = built.steering;
      btwNotes.length = 0;
      viewerState = createViewerState();
      viewerOpen = false;
      viewerLastLines = 0;
      turnAbort = new AbortController();
      try {
        await runTurn(ctx, built.prompt, turnAbort.signal, (f) => {
          switch (f.type) {
            case "workflow_start":
              viewerState = applyViewerFrame(viewerState, { type: "workflow_start", workflowId: f.workflow_id, phases: f.phases, totalAgents: f.total_agents });
              break;
            case "phase_start":
              viewerState = applyViewerFrame(viewerState, { type: "phase_start", phaseN: f.phase_n, phaseType: f.phase_type, agentCount: f.agent_count });
              if (viewerOpen) redrawViewerTree();
              break;
            case "phase_done":
              viewerState = applyViewerFrame(viewerState, { type: "phase_done", phaseN: f.phase_n, artifactSummary: f.artifact_summary });
              if (viewerOpen) redrawViewerTree();
              break;
            case "agent_spawn":
              viewerState = applyViewerFrame(viewerState, { type: "agent_spawn", agentId: f.agent_id, phaseN: f.phase_n, brief: f.brief });
              if (viewerOpen) redrawViewerTree();
              break;
            case "agent_progress":
              viewerState = applyViewerFrame(viewerState, { type: "agent_progress", agentId: f.agent_id, delta: f.delta });
              // Only the drilled-into agent's feed view actually changes on a
              // progress delta — the tree view's row doesn't show feed content,
              // so redrawing there on every token would just be flicker.
              if (viewerOpen && viewerState.selectedAgentId === f.agent_id) redrawViewerTree();
              break;
            case "agent_done":
              viewerState = applyViewerFrame(viewerState, {
                type: "agent_done",
                agentId: f.agent_id,
                phaseN: f.phase_n,
                summary: f.summary,
                tokens: f.tokens,
                toolCalls: f.tool_calls,
                durationMs: f.duration_ms,
              });
              if (viewerOpen) redrawViewerTree();
              break;
            case "workflow_done":
              viewerState = applyViewerFrame(viewerState, { type: "workflow_done", synthesis: f.synthesis, totalPhases: f.total_phases, totalAgents: f.total_agents });
              // Symmetric with the Escape-close path: erase the panel from the
              // terminal instead of just flipping viewerOpen, or a popout still
              // on screen when the workflow finishes is stuck in scrollback for
              // the rest of the turn (the exact defect class Finding B fixed).
              if (viewerOpen) {
                process.stdout.write(viewerClearSequence(viewerLastLines));
                viewerLastLines = 0;
                repaint();
              }
              viewerOpen = false;
              break;
          }
        }, redrawInput, skillOpts);
        return false;
      } catch (err) {
        if (isAbortError(err)) {
          // User said stop: drop the queued follow-ups too.
          queue.length = 0;
          process.stdout.write("\n" + theme.dim("✗ turn aborted") + "\n");
          return true;
        }
        // ChatTurnError means the Renderer already painted "✗ <msg>" for the
        // server's error frame (frame() runs before runTurn throws) — only
        // genuinely unrendered failures (network, fallback-leg errors) need
        // printError's own "✗" line, or the user sees the error twice.
        if (!(err instanceof ChatTurnError)) printError(err, ctx.cfg.baseUrl);
        return false;
      } finally {
        turnAbort = null;
      }
    };

    const onCtrlC = (): void => {
      const now = Date.now();
      const armed = now - ctrlCArmedAt <= CTRL_C_WINDOW_MS && ctrlCArmedAt > 0;
      const active = turnAbort ?? slashAbort;
      const action = ctrlCDecision({
        pasting,
        busy,
        abortable: active != null && !active.signal.aborted,
        hasDraft: buf.value.length > 0,
        armed,
      });
      switch (action) {
        case "exit":
          finish(0);
          return;
        case "abort-turn":
          active!.abort();
          ctrlCArmedAt = now;
          return;
        case "arm-quit":
          ctrlCArmedAt = now;
          process.stdout.write("\n" + theme.dim("(ctrl+c again to quit)") + "\n");
          return;
        case "clear-line":
          buf.clear();
          ctrlCArmedAt = 0;
          repaint();
          return;
        case "arm-exit":
          ctrlCArmedAt = now;
          process.stdout.write("\n" + theme.dim("(ctrl+c again to exit)") + "\n");
          repaint();
          return;
      }
    };

    const onSubmit = async (): Promise<void> => {
      let t = buf.value.trim();
      // ── mid-turn Enter: bypass commands + type-ahead queueing ──
      if (busy) {
        if (t.startsWith("/steer ")) {
          steering = t.slice(7).trim() || steering;
          remember(buf.value);
          buf.commit(buf.value);
          if (steering) process.stdout.write(`\n🎯 Steering set: "${steering}"\n`);
          return;
        }
        if (t.startsWith("/btw ")) {
          const note = t.slice(5).trim();
          remember(buf.value);
          buf.commit(buf.value);
          if (note) {
            btwNotes.push(note);
            process.stdout.write(`\n📝 Noted: "${note}"\n`);
          }
          return;
        }
        if (t.startsWith("/queue ")) t = t.slice(7).trim();
        remember(buf.value);
        buf.commit(buf.value);
        if (!t || t.startsWith("/")) return; // other slashes wait for the turn
        queue.push(t);
        process.stdout.write(`\n⏳ Queued (${queue.length}): "${previewLine(t)}"\n`);
        return;
      }

      process.stdout.write("\n");
      remember(buf.value);
      buf.commit(buf.value);
      if (!t) {
        repaint();
        return;
      }
      // ── /steer /btw /queue — stateful, stay inline ──
      if (t.startsWith("/steer ") || t === "/steer") {
        const guidance = t.slice(6).trim();
        if (!guidance) { process.stdout.write("usage: /steer <guidance>\n"); repaint(); return; }
        steering = guidance;
        process.stdout.write(`🎯 Steering set: "${guidance}"\n`);
        repaint(); return;
      }
      if (t.startsWith("/btw ") || t === "/btw") {
        const note = t.slice(4).trim();
        if (!note) { process.stdout.write("usage: /btw <note>\n"); repaint(); return; }
        btwNotes.push(note);
        process.stdout.write(`📝 Noted: "${note}"\n`);
        repaint(); return;
      }
      if (t.startsWith("/queue ") || t === "/queue") {
        const task = t.slice(6).trim();
        if (!task) { process.stdout.write("usage: /queue <task>\n"); repaint(); return; }
        // not busy — run immediately as a normal turn
        process.stdout.write(`⏳ Running: "${task}"\n`);
        t = task;
      }
      // ── stateless prompt-rewrite modes (/recon, /plan, /research, …) ──
      const mode = applyPromptMode(t);
      if (mode.handled) {
        if (mode.error) { process.stdout.write(mode.error + "\n"); repaint(); return; }
        process.stdout.write(mode.notice + "\n");
        t = mode.prompt!;
      }
      busy = true;
      if (t.startsWith("/")) {
        slashAbort = new AbortController();
        try {
          const res = await handleSlash(ctx, t, process.stdout, slashAbort.signal);
          if (res.exit) {
            cleanup();
            resolve(0);
            return;
          }
          if (res.restart) {
            applyRestart(ctx.flags, res.restart);
            process.stdout.write(theme.dim("session restarted — context cleared.\n"));
          }
        } catch (err) {
          if (isAbortError(err)) {
            process.stdout.write(theme.dim("✗ canceled") + "\n");
          } else {
            printError(err, ctx.cfg.baseUrl);
          }
        } finally {
          busy = false;
          slashAbort = null;
        }
        renderHudLine();
        repaint();
        return;
      }
      try {
        getRegistry().startAgentTimer();
        // An aborted turn skips the drain entirely — even an item that slipped
        // into the queue during abort teardown must not auto-run.
        let aborted = await runQueuedTurn(t);
        while (!aborted && queue.length > 0) {
          const next = queue.shift()!;
          process.stdout.write(`\n→ Queued: "${previewLine(next)}"\n`);
          aborted = await runQueuedTurn(next);
        }
      } finally {
        busy = false;
        getRegistry().startUserTimer();
      }
      renderHudLine();
      repaint();
    };

    // Clear exactly the previously-printed panel (tree or agent-feed, per
    // viewerLastLines) and redraw it at the current cursor/selection, then
    // restore the input line below it. Renders the agent feed instead of the
    // tree once an agent is selected (Finding D).
    const redrawViewerTree = (): void => {
      process.stdout.write(viewerClearSequence(viewerLastLines));
      const rendered = viewerState.selectedAgentId != null
        ? renderAgentFeed(viewerState)
        : renderCiTree(viewerState);
      process.stdout.write(rendered + "\n");
      viewerLastLines = viewerLineCount(rendered);
      repaint();
    };

    // SYNC on purpose: every key is fully processed before the next token, so
    // out-of-order edits are impossible. Submits are fired un-awaited — the
    // busy flag is set synchronously inside onSubmit before its first await,
    // so later tokens correctly land in the type-ahead path.
    const processSeq = (seq: string): void => {
      // Ctrl-C is handled BEFORE paste accumulation so a stuck paste or hung
      // stream can never hard-lock the terminal in raw mode.
      if (seq === "\x03") {
        onCtrlC();
        return;
      }
      if (pasting) {
        const k = decodeKey(seq);
        if (k.kind === "paste-end") {
          buf.paste(pasteAcc);
          pasteAcc = "";
          pasting = false;
          repaint();
        } else {
          pasteAcc += seq; // raw bytes — pasted content may legitimately contain escapes
        }
        return;
      }
      const k = decodeKey(seq);
      switch (k.kind) {
        case "paste-start":
          pasting = true;
          pasteAcc = "";
          return;
        case "char":
          buf.insert(k.value);
          repaint();
          return;
        case "backspace":
          buf.backspace();
          repaint();
          return;
        case "delete":
          buf.deleteForward();
          repaint();
          return;
        case "word-delete":
          buf.deleteWord();
          repaint();
          return;
        case "kill-end":
          buf.killToEnd();
          repaint();
          return;
        case "kill-start":
          buf.killToStart();
          repaint();
          return;
        case "left":
          // While the tree is open on a workflow with real phase data,
          // Left/Right collapse/expand the phase under the cursor instead of
          // moving the (currently irrelevant) text-input caret — matches the
          // design mockup's "→/Enter expand phase · ←/Esc collapse" footer.
          if (viewerOpen && viewerState.selectedAgentId == null && viewerState.phases.length > 0) {
            const agent = viewerState.agents[viewerState.cursorIndex];
            if (agent) {
              viewerState = togglePhaseExpanded(viewerState, agent.phaseN);
              redrawViewerTree();
            }
            return;
          }
          buf.left();
          repaint();
          return;
        case "right":
          if (viewerOpen && viewerState.selectedAgentId == null && viewerState.phases.length > 0) {
            const agent = viewerState.agents[viewerState.cursorIndex];
            if (agent) {
              viewerState = togglePhaseExpanded(viewerState, agent.phaseN);
              redrawViewerTree();
            }
            return;
          }
          buf.right();
          repaint();
          return;
        case "word-left":
          buf.wordLeft();
          repaint();
          return;
        case "word-right":
          buf.wordRight();
          repaint();
          return;
        case "tab": {
          // Slash-command completion: complete to the unambiguous prefix, or
          // show the candidates. Plain text Tab is ignored (no file paths yet).
          if (busy) return;
          const v = buf.value;
          if (v.startsWith("/") && !/\s/.test(v) && buf.pos === [...v].length) {
            const r = completeManifestSlash(v);
            if (r.completed) {
              buf.clear();
              buf.insert(r.completed);
            } else if (r.matches.length > 1) {
              const shown = r.matches.slice(0, 12).map((m) => "/" + m).join("  ");
              const more = r.matches.length > 12 ? `  … +${r.matches.length - 12} more` : "";
              process.stdout.write("\n" + theme.dim(shown + more) + "\n");
            }
            repaint();
          }
          return;
        }
        case "clear-screen":
          if (!busy) {
            process.stdout.write("\x1b[2J\x1b[H");
            repaint();
          }
          return;
        case "home":
          buf.home();
          repaint();
          return;
        case "end":
          buf.end();
          repaint();
          return;
        case "up":
          if (viewerOpen) {
            if (viewerState.selectedAgentId == null) {
              viewerState = moveCursor(viewerState, -1);
              redrawViewerTree();
            }
          } else {
            buf.historyUp();
            repaint();
          }
          return;
        case "down":
          if (viewerState.visible && !viewerOpen) {
            viewerOpen = true;
            redrawViewerTree();
          } else if (viewerOpen) {
            if (viewerState.selectedAgentId == null) {
              viewerState = moveCursor(viewerState, 1);
              redrawViewerTree();
            }
          } else {
            buf.historyDown();
            repaint();
          }
          return;
        case "interrupt":
          onCtrlC();
          return;
        case "eof":
          if (!buf.value) finish(0);
          return;
        case "submit":
          // While the popout is open, Enter drills into the agent under the
          // cursor instead of submitting the input buffer as a chat turn
          // (Finding D: selectAgent/renderAgentFeed were fully built but
          // never wired to a key handler).
          if (viewerOpen) {
            if (viewerState.selectedAgentId == null) {
              const agent = viewerState.agents[viewerState.cursorIndex];
              if (agent) {
                viewerState = selectAgent(viewerState, agent.id);
                redrawViewerTree();
              }
            }
            return;
          }
          // Last-resort catch: an error escaping onSubmit's own handlers must
          // still leave a usable session — without busy=false + repaint() the
          // REPL sat with no visible prompt (PR #47 UX audit, finding 5).
          void onSubmit().catch((err) => {
            printError(err, ctx.cfg.baseUrl);
            busy = false;
            repaint();
          });
          return;
        case "escape":
          if (viewerOpen) {
            if (viewerState.selectedAgentId != null) {
              // Back out of the agent-feed drill-down to the tree, not a
              // full close — mirrors the design's two-level Esc behavior.
              viewerState = selectAgent(viewerState, null);
              redrawViewerTree();
            } else {
              viewerOpen = false;
              process.stdout.write(viewerClearSequence(viewerLastLines));
              viewerLastLines = 0;
              repaint();
            }
          }
          return;
        default:
          return; // ignore
      }
    };

    // StringDecoder: a multibyte UTF-8 char split across chunks must not be
    // decoded as two replacement chars.
    const decoder = new StringDecoder("utf8");
    const onData = (chunk: Buffer): void => {
      let data = carry + decoder.write(chunk);
      carry = "";
      const partial = PARTIAL_ESC_RE.exec(data);
      if (partial && partial[0].length > 0 && partial.index + partial[0].length === data.length) {
        carry = partial[0];
        data = data.slice(0, partial.index);
      }
      for (const seq of splitKeys(data)) {
        processSeq(seq);
      }
    };
    process.stdin.on("data", onData);
    process.stdout.on("resize", onResize);
  });
}

/** Non-TTY fallback (pipes / CI): a line-oriented readline loop — no raw-mode
 *  key decoding since there's no real terminal to own. `inflight` still wires
 *  Ctrl+C to cancel the current turn/slash-command rather than killing the
 *  whole process (a bare non-TTY session, e.g. `ssh host aether`, still gets
 *  SIGINT delivered normally since readline isn't in terminal mode here). */
async function replLines(ctx: AppContext, skillOpts: TurnSkillOptions = {}): Promise<number> {
  const rl = createInterface({ input: process.stdin });
  const p = promptPrefix(userInfo().username || "you");
  let inflight: AbortController | null = null;
  process.on("SIGINT", () => inflight?.abort());
  process.stdout.write(p);
  for await (const line of rl) {
    const t = line.trim();
    if (!t) {
      process.stdout.write(p);
      continue;
    }
    if (historyEnabled()) appendHistory(t, historyPath(ctx.flags.cwd));
    if (t.startsWith("/")) {
      inflight = new AbortController();
      try {
        const res = await handleSlash(ctx, t, process.stdout, inflight.signal);
        if (res.exit) break;
        if (res.restart) {
          applyRestart(ctx.flags, res.restart);
          process.stdout.write(theme.dim("session restarted — context cleared.\n\n"));
        }
      } catch (err) {
        if (isAbortError(err)) {
          process.stderr.write(errTheme.dim("✗ canceled\n"));
        } else {
          printError(err, ctx.cfg.baseUrl);
        }
      } finally {
        inflight = null;
      }
      process.stdout.write(p);
      continue;
    }
    inflight = new AbortController();
    let printed = false; // printError already ends with a blank line
    try {
      await runTurn(ctx, t, inflight.signal, undefined, undefined, skillOpts);
    } catch (err) {
      if (isAbortError(err)) {
        process.stderr.write("\n" + errTheme.dim("✗ canceled — turn discarded") + "\n");
      } else if (!(err instanceof ChatTurnError)) {
        // ChatTurnError: Renderer already painted the "✗ <msg>" error line.
        printError(err, ctx.cfg.baseUrl);
        printed = true;
      }
    } finally {
      inflight = null;
    }
    process.stdout.write((printed ? "" : "\n") + p);
  }
  rl.close();
  process.stdout.write("\n");
  return 0;
}

function printError(err: unknown, baseUrl: string): void {
  const msg = err instanceof Error ? err.message : String(err);
  // formatErrorLine (LOOP-06) owns the glyph/hint/separator convention so
  // this reads identically to a server-streamed error frame's Renderer.error
  // — see src/ui/error_line.ts for why both paths must agree.
  process.stderr.write(formatErrorLine(msg, { hint: errorHint(err, baseUrl) }));
}
