// `aether [prompt]` — one-shot if a prompt is given, else an interactive REPL.
// This is the coding front door: build an envelope, POST to the universal
// stream, decode frames, render. The agent brain runs on Aether's servers.

import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import type { AppContext, GlobalFlags } from "../core/context.js";
import { theme, errTheme } from "../ui/theme.js";
import { buildChatRequest } from "../core/envelope.js";
import { CHAT_STREAM_PATH, CHAT_PATH, defaultStreamTimeoutMs, sanitizeServerText } from "../core/transport.js";
import { decodeSse } from "../core/stream.js";
import { Renderer } from "../core/render.js";
import {
  HttpError,
  MeaningfulProgressTimeoutError,
  StreamIncompleteError,
  StreamTimeoutError,
  StreamUnavailableError,
  errorHint,
  errorMessage,
  isAbortError,
} from "../core/errors.js";
import {
  TurnLifecycle,
  describeStreamFailure,
  recoverSubmittedPrompt,
  type TurnOutcome,
} from "../core/turn_lifecycle.js";
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
import type { RunOptions, ToolResult } from "../core/tool_executor.js";
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
import type { BrainEvent } from "../core/brain_protocol.js";

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
 *  (CONTRACTS.md invariant 5). runTurn returns a typed success outcome; this
 *  exception carries the corresponding failed outcome while still signalling
 *  failure to the one-shot `cmdChat` path. */
/** Session-level skill selection for REPL/one-shot chat turns (`--skill`, `--no-skills`). */
export interface TurnSkillOptions {
  explicitSkill?: string;
  noSkills?: boolean;
}

export class ChatTurnError extends Error {
  constructor(
    msg: string,
    readonly outcome?: TurnOutcome,
    /** True when a human/stream frame already reached the selected surface. */
    readonly rendered = true,
  ) {
    super(msg);
    this.name = "ChatTurnError";
  }
}

/** State-aware meaningful-progress classifier. Keepalives, empty chunks and
 * replayed metadata cannot extend the hard turn deadline; visible text and
 * genuine monotonic/state changes can. */
class StreamProgressTracker {
  private maxUsageUvt = Number.NEGATIVE_INFINITY;
  private maxUsageCents = Number.NEGATIVE_INFINITY;
  private connected = false;
  private projectDone = false;
  private readonly seenStateFrames = new Set<string>();
  private static readonly MAX_STATE_FRAMES = 4096;

  meaningful(frame: StreamFrame): boolean {
    switch (frame.type) {
      case "open":
      case "ping":
      case "notice":
      case "done":
      case "error":
        return false;
      case "delta":
      case "reasoning":
        return sanitizeServerText(frame.text).trim().length > 0;
      case "progress":
        return this.nonEmptyOnce("progress:", frame.text ?? "");
      case "usage": {
        if (!Number.isFinite(frame.uvt) || !Number.isFinite(frame.cents)) return false;
        const advanced = frame.uvt > this.maxUsageUvt || frame.cents > this.maxUsageCents;
        this.maxUsageUvt = Math.max(this.maxUsageUvt, frame.uvt);
        this.maxUsageCents = Math.max(this.maxUsageCents, frame.cents);
        return advanced;
      }
      case "connected":
        if (this.connected) return false;
        this.connected = true;
        return true;
      case "project_done":
        if (this.projectDone) return false;
        this.projectDone = true;
        return true;
      case "task_progress":
        return this.once(
          `task_progress:${frame.taskId}:${sanitizeServerText(frame.delta ?? "")}:${frame.uvt ?? ""}:${frame.cents ?? ""}`,
        );
      case "tool_call":
        return this.once(`tool_call:${frame.toolCallId}`);
      case "tool_result_ack":
        return this.once(`tool_result_ack:${frame.toolCallId}`);
      case "session":
        return this.once(`session:${frame.sessionId}:${frame.protocolVersion}`);
      case "custody":
        return this.once(`custody:${String(frame.custody["order_id"] ?? "")}`);
      case "task_start":
        return this.once(`task_start:${frame.taskId ?? ""}:${frame.label ?? ""}`);
      case "task_done":
        return this.once(`task_done:${frame.taskId ?? ""}`);
      case "task_failed":
        return this.once(`task_failed:${frame.taskId ?? ""}:${frame.msg ?? ""}`);
      case "task_blocked":
        return this.once(`task_blocked:${frame.taskId ?? ""}:${frame.msg ?? ""}`);
      case "memory":
        return this.once(`memory:${frame.subtype}:${frame.text ?? ""}:${frame.narrative ?? ""}`);
      case "workflow_start":
        return this.once(`workflow_start:${frame.workflow_id}`);
      case "phase_start":
        return this.once(`phase_start:${frame.phase_n}:${frame.phase_type}`);
      case "phase_done":
        return this.once(`phase_done:${frame.phase_n}:${frame.artifact_summary}`);
      case "agent_spawn":
        return this.once(`agent_spawn:${frame.agent_id}:${frame.phase_n}`);
      case "agent_progress":
        return this.nonEmptyOnce(`agent_progress:${frame.agent_id}:`, frame.delta);
      case "agent_done":
        return this.once(`agent_done:${frame.agent_id}:${frame.phase_n}`);
      case "workflow_done":
        return this.once(`workflow_done:${frame.total_phases}:${frame.total_agents}`);
    }
  }

  private once(key: string): boolean {
    if (this.seenStateFrames.has(key)) return false;
    if (this.seenStateFrames.size >= StreamProgressTracker.MAX_STATE_FRAMES) return false;
    this.seenStateFrames.add(key);
    return true;
  }

  private nonEmptyOnce(prefix: string, value: string): boolean {
    const safe = sanitizeServerText(value).trim();
    return safe.length > 0 && this.once(prefix + safe);
  }
}

/** Local brains use the same bounded, replay-resistant notion of progress as
 * hosted streams. A cycle of previously-seen status/stage frames is liveness,
 * not evidence that the user's turn is advancing. */
class LocalBrainProgressTracker {
  private readonly seen = new Set<string>();
  private static readonly MAX_KEYS = 4096;
  private static readonly MAX_KEY_LENGTH = 512;

  meaningful(event: BrainEvent): boolean {
    switch (event.type) {
      case "done":
      case "error":
        return false;
      case "stage":
        return this.nonEmptyOnce("stage:", event.name);
      case "monologue":
        return this.nonEmptyOnce(`monologue:${event.depth}:`, event.text);
      case "skill":
        return this.once(`skill:${event.name}:${event.reason}`);
      case "turn":
        return this.once(`turn:${event.n}:${event.toolCalls}:${event.malformed}:${event.invented}:${event.noCall}:${event.failCount ?? ""}`);
      case "tool_call":
        return this.once(`tool:${event.id}`);
      case "telemetry":
        return this.once(`telemetry:${event.tokens}:${event.ctxUsed}:${event.ctxCap}`);
      case "status":
        return this.once(`status:${event.phase}:${event.poolUsed}:${event.poolCap}`);
      case "checkpoint":
        return this.once(`checkpoint:${event.gitSha}`);
      case "memory":
        return this.once(`memory:${event.subtype}:${event.text ?? ""}:${event.narrative ?? ""}:${event.afterTokens ?? ""}`);
      case "workflow_start":
        return this.once(`workflow:${event.workflowId}`);
      case "phase_start":
        return this.once(`phase-start:${event.phaseN}:${event.phaseType}`);
      case "phase_done":
        return this.once(`phase-done:${event.phaseN}:${event.artifactSummary}`);
      case "agent_spawn":
        return this.once(`agent-spawn:${event.agentId}:${event.phaseN}`);
      case "agent_progress":
        return this.nonEmptyOnce(`agent-progress:${event.agentId}:`, event.delta);
      case "agent_done":
        return this.once(`agent-done:${event.agentId}:${event.phaseN}`);
      case "workflow_done":
        return this.once(`workflow-done:${event.totalPhases}:${event.totalAgents}`);
      case "routing_drift":
        return this.once(`routing-drift:${event.requested}:${event.resolved}:${event.status}:${event.fatal}`);
    }
  }

  private once(key: string): boolean {
    const bounded = key.slice(0, LocalBrainProgressTracker.MAX_KEY_LENGTH);
    if (this.seen.has(bounded) || this.seen.size >= LocalBrainProgressTracker.MAX_KEYS) return false;
    this.seen.add(bounded);
    return true;
  }

  private nonEmptyOnce(prefix: string, raw: string): boolean {
    const value = sanitizeServerText(raw).trim();
    return value.length > 0 && this.once(prefix + value);
  }
}

function signalReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("turn cancelled", "AbortError");
}

/** Bound iterator, confirmation, and tool promises by one meaningful-progress
 * clock. Late settlement is observed but cannot re-enter the completed turn. */
function boundedLocalOperation<T>(
  work: () => T | PromiseLike<T>,
  signal: AbortSignal,
  timeoutMs: number,
  lastMeaningfulAt: number,
  onTimeout: (error: MeaningfulProgressTimeoutError) => void,
): Promise<T> {
  const pending = Promise.resolve().then(work);
  if (signal.aborted) {
    pending.catch(() => {});
    return Promise.reject(signalReason(signal));
  }
  if (timeoutMs <= 0) return pending;
  const remaining = timeoutMs - (Date.now() - lastMeaningfulAt);
  if (remaining <= 0) {
    const error = new MeaningfulProgressTimeoutError(timeoutMs);
    onTimeout(error);
    pending.catch(() => {});
    return Promise.reject(error);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: (value: never) => void, value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn(value as never);
    };
    const onAbort = (): void => finish(reject, signalReason(signal));
    const timer = setTimeout(() => {
      if (settled) return;
      const error = new MeaningfulProgressTimeoutError(timeoutMs);
      onTimeout(error);
      finish(reject, error);
    }, Math.max(1, remaining));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => finish(resolve as (value: never) => void, value),
      (error: unknown) => finish(reject, error),
    );
  });
}

const TURN_OUTCOME = Symbol("aether.turn.outcome");
type ErrorWithTurnOutcome = Error & { [TURN_OUTCOME]?: TurnOutcome };

function attachTurnOutcome(error: unknown, outcome: TurnOutcome): unknown {
  if (!(error instanceof Error)) return new ChatTurnError(errorMessage(error), outcome, false);
  Object.defineProperty(error, TURN_OUTCOME, { value: outcome, configurable: false, enumerable: false });
  return error;
}

function turnOutcomeForError(error: unknown): TurnOutcome | undefined {
  return error instanceof ChatTurnError
    ? error.outcome
    : error instanceof Error
      ? (error as ErrorWithTurnOutcome)[TURN_OUTCOME]
      : undefined;
}

function finalizeThrownTurn(
  lifecycle: TurnLifecycle,
  err: unknown,
  baseUrl: string,
  partialOutput = false,
): TurnOutcome {
  const settled = lifecycle.outcome;
  if (settled) return settled;
  const message = errorMessage(err);
  if (isAbortError(err)) {
    return lifecycle.finalize("cancelled", {
      message: "turn cancelled",
      retryable: true,
      partialOutput,
    });
  }
  if (err instanceof StreamTimeoutError) {
    return lifecycle.finalize("timed_out", {
      message,
      hint: errorHint(err, baseUrl),
      retryable: true,
      partialOutput,
    });
  }
  if (err instanceof StreamIncompleteError) {
    return lifecycle.finalize("incomplete", {
      message,
      hint: errorHint(err, baseUrl),
      retryable: true,
      partialOutput,
    });
  }
  const hint = errorHint(err, baseUrl);
  return lifecycle.finalize("failed", {
    message,
    hint,
    retryable:
      hint !== null ||
      (err instanceof HttpError && (err.status === 402 || err.status === 429 || err.status >= 500)),
    partialOutput,
  });
}

function beginConnecting(lifecycle: TurnLifecycle): void {
  if (lifecycle.state === "idle") lifecycle.transition("submitted");
  if (lifecycle.state === "submitted") lifecycle.transition("connecting");
}

function noteStreamingActivity(lifecycle: TurnLifecycle): void {
  if (lifecycle.state === "connecting" || lifecycle.state === "waiting_for_tool") {
    lifecycle.transition("streaming");
  } else if (lifecycle.state === "streaming") {
    lifecycle.meaningfulActivity();
  }
}

function noteWaitingForTool(lifecycle: TurnLifecycle): void {
  if (lifecycle.state === "connecting" || lifecycle.state === "streaming") {
    lifecycle.transition("waiting_for_tool");
  } else if (lifecycle.state === "waiting_for_tool") {
    lifecycle.meaningfulActivity();
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
): Promise<TurnOutcome> {
  const lifecycle = new TurnLifecycle(prompt);
  lifecycle.transition("submitted");
  try {
    const backend = await resolveBackend(ctx);
    // The same seam `aether agent` uses (commands/code.ts). Opened per turn, not
    // per session, because automatic skill selection reads THIS prompt — a turn
    // that says "the CI is failing" should pull the CI skill and the next one
    // should not inherit it.
    const opened = openRunSession({
      projectRoot: ctx.flags.cwd,
      prompt,
      ...(skillOpts.explicitSkill ? { explicitSkill: skillOpts.explicitSkill } : {}),
      ...(skillOpts.noSkills ? { noSkills: true } : {}),
    });
    if (!opened.ok) {
      // Painted here, then thrown as a ChatTurnError — the caller's contract is
      // that a ChatTurnError has already been rendered (see cmdChat), so this
      // must not be left for printError to duplicate.
      if (!ctx.flags.json) {
        for (const line of opened.lines) process.stderr.write(errTheme.red(line) + "\n");
      }
      const message = opened.refusal.code + ": " + opened.refusal.detail;
      const outcome = lifecycle.finalize("failed", { message });
      throw new ChatTurnError(message, outcome, !ctx.flags.json);
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
      return await runLocalTurn(ctx, brief, signal, { lifecycle }, run.guard);
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
    return await runCloudTurn(ctx, brief, lifecycle, signal, onFrame, onPulsePaint);
  } catch (err) {
    const outcome = finalizeThrownTurn(lifecycle, err, ctx.cfg.baseUrl);
    if (err instanceof ChatTurnError) throw err;
    throw attachTurnOutcome(err, outcome);
  }
}

/** Last skill/rules header printed, so an unchanged one is not reprinted per turn. */
let lastTurnHeader: string | null = null;

/** The cloud path — build an envelope, POST to the universal stream, render.
 * Extracted so runTurn can fork local vs cloud. */
async function runCloudTurn(
  ctx: AppContext,
  prompt: string,
  lifecycle: TurnLifecycle,
  signal?: AbortSignal,
  onFrame?: (f: StreamFrame) => void,
  onPulsePaint?: () => void,
): Promise<TurnOutcome> {
  beginConnecting(lifecycle);
  const reg = getRegistry();
  // The operator's session cap is checked BEFORE a billable turn starts. It is
  // a local circuit breaker, not a billing control: it stops this terminal
  // from starting more work, and changes nothing about the account.
  const cap = reg.checkUvtCap();
  if (cap.capped) {
    const message =
      `session UVT cap reached — ${cap.observed} of ${cap.cap} observed. ` +
      "No further turns will start. This is a local stop only; your plan and " +
      "balance are unchanged. Raise it with /limit <amount>, or /limit off.";
    if (!ctx.flags.json) process.stderr.write(formatErrorLine(message));
    const outcome = lifecycle.finalize("failed", { message, retryable: true });
    throw new ChatTurnError(message, outcome, !ctx.flags.json);
  }
  reg.beginTurn(lifecycle.id);
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
  let partialOutput = false;
  let streamedError: ChatTurnError | null = null;
  const progressTimeoutMs = defaultStreamTimeoutMs();
  const streamController = new AbortController();
  const forwardAbort = (): void => streamController.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  const progress = new StreamProgressTracker();
  const armProgressTimeout = (): void => {
    if (progressTimer) clearTimeout(progressTimer);
    if (progressTimeoutMs === 0 || streamController.signal.aborted) return;
    progressTimer = setTimeout(
      () => streamController.abort(new MeaningfulProgressTimeoutError(progressTimeoutMs)),
      progressTimeoutMs,
    );
    progressTimer.unref?.();
  };
  try {
    const stream = await ctx.api.stream(CHAT_STREAM_PATH, req, {
      signal: streamController.signal,
      timeoutMs: progressTimeoutMs,
    });
    armProgressTimeout();
    for await (const frame of decodeSse(stream)) {
      // open/ping are handshake/keepalive — they render nothing. Stopping on
      // them re-created the dead air on keepalive-happy servers; only frames
      // that produce visible output own the line.
      if (frame.type !== "open" && frame.type !== "ping") pulse.stop();
      if (progress.meaningful(frame)) armProgressTimeout();
      // The server signs each turn and returns it; persist the signed receipt
      // locally (best-effort, never breaks the chat).
      // The terminal frame carries the turn's authoritative cost. Settled by
      // turn id so a reconnect replaying it cannot count the same turn twice,
      // and only from the server's own number — never estimated from tokens.
      if (frame.type === "done") getRegistry().settleTurn(lifecycle.id, frame.uvt);
      if (frame.type === "custody") appendCustody(frame.custody);

      if (frame.type === "tool_call") {
        noteWaitingForTool(lifecycle);
      } else if (frame.type !== "open" && frame.type !== "ping" && frame.type !== "done" && frame.type !== "error") {
        noteStreamingActivity(lifecycle);
        if (frame.type === "delta" && frame.text.length > 0) partialOutput = true;
      } else if (frame.type === "done" && lifecycle.state !== "completing") {
        lifecycle.transition("completing");
      }

      onFrame?.(frame);

      if (frame.type === "error") {
        const failure = describeStreamFailure({ message: frame.msg, errorCode: frame.errorCode });
        const renderedError: Extract<StreamFrame, { type: "error" }> = {
          ...frame,
          msg: failure.hint ? `${failure.message} — ${failure.hint}` : failure.message,
          ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
        };
        renderer.frame(renderedError);
        const outcome = lifecycle.finalize("failed", {
          message: failure.message,
          hint: failure.hint,
          retryable: failure.retryable,
          partialOutput,
        });
        streamedError = new ChatTurnError(failure.message, outcome);
        break;
      }

      renderer.frame(frame);
      if (frame.type === "done") {
        return lifecycle.finalize("succeeded", {
          message: "turn completed",
          partialOutput,
        });
      }
    }
    if (streamedError) throw streamedError;
    const incomplete = new StreamIncompleteError();
    lifecycle.finalize("incomplete", {
      message: incomplete.message,
      hint: errorHint(incomplete, ctx.cfg.baseUrl),
      retryable: true,
      partialOutput,
    });
    throw incomplete;
  } catch (err) {
    if (err instanceof StreamUnavailableError) {
      // Contract fail-soft: fall back to the non-streaming request/response.
      // Same signal — the fallback leg is cancelable too (arena AT-3d). A
      // full LLM turn can legitimately run long, so this explicitly opts
      // into stream()'s own generous bound instead of request()'s 30s
      // metadata-call default (LOOP-01/LOOP-06 round-1) — otherwise a
      // perfectly healthy but slow completion would be killed early.
      lifecycle.transition("completing");
      const r = await ctx.api.postJson<ChatJsonResponse>(CHAT_PATH, req, signal, defaultStreamTimeoutMs());
      pulse.stop();
      const response = r?.response ?? "";
      if (!response.trim()) {
        const incomplete = new StreamIncompleteError();
        lifecycle.finalize("incomplete", {
          message: incomplete.message,
          hint: errorHint(incomplete, ctx.cfg.baseUrl),
          retryable: true,
        });
        throw incomplete;
      }
      renderer.frame({ type: "delta", text: response });
      renderer.frame({ type: "done", uvt: 0, cents: 0, usageKnown: false });
      if (ctx.flags.audit && r?.commitment_hash) {
        process.stderr.write(`  signed ✓ ${sanitizeServerText(r.commitment_hash)}\n`);
      }
      return lifecycle.finalize("succeeded", {
        message: "turn completed",
        partialOutput: response.length > 0,
      });
    }
    finalizeThrownTurn(lifecycle, err, ctx.cfg.baseUrl, partialOutput);
    throw err;
  } finally {
    if (progressTimer) clearTimeout(progressTimer);
    signal?.removeEventListener("abort", forwardAbort);
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
  exec?: {
    executeAsync(name: string, args: Record<string, unknown>, options?: RunOptions): Promise<ToolResult>;
  };
  /** Reuse runTurn's lifecycle; direct callers get a fresh one automatically. */
  lifecycle?: TurnLifecycle;
  /** Explicit 0 is a test/embed escape hatch; production uses the finite
   * stream deadline and cannot disable it through environment configuration. */
  meaningfulProgressTimeoutMs?: number;
}

export async function runLocalTurn(
  ctx: AppContext,
  prompt: string,
  signal?: AbortSignal,
  deps: LocalTurnDeps = {},
  skillGuard?: (tool: string) => SkillRefusal | null,
): Promise<TurnOutcome> {
  const lifecycle = deps.lifecycle ?? new TurnLifecycle(prompt);
  beginConnecting(lifecycle);
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
  let partialOutput = false;
  let terminalError: ChatTurnError | null = null;
  const timeoutMs = deps.meaningfulProgressTimeoutMs ?? defaultStreamTimeoutMs();
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(signal?.reason ?? new DOMException("turn cancelled", "AbortError"));
  const closeBrain = (): void => {
    try { brain.close(); } catch { /* cleanup cannot replace the primary outcome */ }
  };
  const onAbort = (): void => closeBrain();
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const progress = new LocalBrainProgressTracker();
  let lastMeaningfulAt = Date.now();
  let iterator: AsyncIterator<BrainEvent> | null = null;
  const timeout = (error: MeaningfulProgressTimeoutError): void => {
    if (!controller.signal.aborted) controller.abort(error);
  };
  try {
    iterator = brain.run(task)[Symbol.asyncIterator]();
    for (;;) {
      const next = await boundedLocalOperation(
        () => iterator!.next(),
        controller.signal,
        timeoutMs,
        lastMeaningfulAt,
        timeout,
      );
      if (next.done) break;
      const ev = next.value;
      if (progress.meaningful(ev)) lastMeaningfulAt = Date.now();
      if (ev.type === "done") {
        renderer.event(ev);
        lifecycle.transition("completing");
        if (ev.ok) {
          lifecycle.finalize("succeeded", {
            message: ev.result || "turn completed",
            partialOutput,
          });
        } else {
          const message = sanitizeServerText(ev.result || ev.reason || "turn did not complete") || "turn did not complete";
          const outcome = lifecycle.finalize("failed", { message, partialOutput });
          terminalError = new ChatTurnError(message, outcome);
        }
        break;
      }
      if (ev.type === "error") {
        renderer.event(ev);
        const message = sanitizeServerText(ev.msg) || "turn failed";
        const outcome = lifecycle.finalize("failed", { message, partialOutput });
        terminalError = new ChatTurnError(message, outcome);
        break;
      }
      if (ev.type === "tool_call") {
        noteWaitingForTool(lifecycle);
        renderer.event(ev);
        // Same ordering as hostLoop (commands/code.ts): the skill narrowing is
        // checked first and refuses without executing or prompting; the
        // operator gate then decides about whatever survived. A skill can only
        // subtract here — it is never consulted again after this line.
        const refusal = skillGuard ? skillGuard(ev.name) : null;
        if (refusal) {
          brain.sendToolResult(ev.id, refusalToolResult(refusal));
        } else {
          // executeAsync so the two web tools (web_search/web_fetch) work too.
          const approved = await boundedLocalOperation(
            () => approveTool(ev.name, ev.args),
            controller.signal,
            timeoutMs,
            lastMeaningfulAt,
            timeout,
          );
          const remaining = timeoutMs > 0
            ? Math.max(1, timeoutMs - (Date.now() - lastMeaningfulAt))
            : undefined;
          const toolOptions: RunOptions = {
            signal: controller.signal,
            ...(remaining === undefined ? {} : { timeoutMs: remaining }),
          };
          const result = approved
            ? await boundedLocalOperation(
                () => exec.executeAsync(ev.name, ev.args, toolOptions),
                controller.signal,
                timeoutMs,
                lastMeaningfulAt,
                timeout,
              )
            : { output: `[tool ${ev.name} blocked: permission denied]`, exitCode: 1 };
          brain.sendToolResult(ev.id, result);
        }
        lastMeaningfulAt = Date.now();
        noteStreamingActivity(lifecycle);
        continue;
      }
      noteStreamingActivity(lifecycle);
      partialOutput = true;
      renderer.event(ev);
    }
  } catch (err) {
    const outcome = finalizeThrownTurn(lifecycle, err, ctx.cfg.baseUrl, partialOutput);
    if (isAbortError(err) && signal?.aborted) return outcome;
    throw err;
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
    controller.signal.removeEventListener("abort", onAbort);
    closeBrain();
    // A non-compliant iterator may park forever or throw synchronously from
    // return(). Observe both shapes without replacing the real timeout/error.
    if (iterator?.return) void Promise.resolve().then(() => iterator!.return!()).catch(() => {});
  }
  // Mirror runCloudTurn/CONTRACTS.md invariant 5: a streamed error event is a
  // failed turn, not a silently-successful one — the renderer already painted
  // it, so callers (cmdChat/run.ts) special-case ChatTurnError to avoid a
  // double print.
  if (terminalError) throw terminalError;
  const settled = lifecycle.outcome;
  if (settled) return settled;
  const incomplete = new StreamIncompleteError();
  lifecycle.finalize("incomplete", {
    message: incomplete.message,
    hint: errorHint(incomplete, ctx.cfg.baseUrl),
    retryable: true,
    partialOutput,
  });
  throw incomplete;
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

/** Stable machine terminal record. The prompt itself is deliberately omitted:
 * automation needs correlation/outcome/retry facts, not a second copy of user
 * content in every captured JSON log. */
export function turnOutcomeJson(outcome: TurnOutcome): string {
  return JSON.stringify({
    protocol: "aether.turn/1",
    type: "turn_outcome",
    turn_id: outcome.turnId,
    state: outcome.state,
    exit_code: outcome.exitCode,
    message: outcome.message,
    hint: outcome.hint,
    retryable: outcome.retryable,
    partial_output: outcome.partialOutput,
    started_at: outcome.startedAt,
    finished_at: outcome.finishedAt,
    last_meaningful_activity_at: outcome.lastMeaningfulActivityAt,
    prompt_preserved: true,
  });
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
      const outcome = await runTurn(ctx, prompt, undefined, undefined, undefined, skillOpts);
      if (ctx.flags.json) process.stdout.write(turnOutcomeJson(outcome) + "\n");
      return outcome.exitCode;
    } catch (err) {
      if (err instanceof ChatTurnError) {
        if (ctx.flags.json && err.outcome) process.stdout.write(turnOutcomeJson(err.outcome) + "\n");
        else if (!err.rendered) {
          process.stderr.write(formatErrorLine(err.outcome?.message ?? err.message, { hint: err.outcome?.hint ?? null }));
        }
        return err.outcome?.exitCode ?? 1;
      }
      const outcome = turnOutcomeForError(err);
      if (ctx.flags.json && outcome) process.stdout.write(turnOutcomeJson(outcome) + "\n");
      else printError(err, ctx.cfg.baseUrl);
      return outcome?.exitCode ?? 1;
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
  if (!ctx.flags.json) {
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
  }
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
  let setupOwnsInput = false;
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
  let turnAbort: AbortController | null = null; // live while a local/cloud turn runs
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

    /** Run one turn without sacrificing an existing type-ahead draft. */
    const runQueuedTurn = async (text: string): Promise<"completed" | "aborted" | "failed"> => {
      const built = buildPromptContext(text, steering, btwNotes);
      steering = built.steering;
      btwNotes.length = 0;
      viewerState = createViewerState();
      viewerOpen = false;
      viewerLastLines = 0;
      turnAbort = new AbortController();
      try {
        const outcome = await runTurn(ctx, built.prompt, turnAbort.signal, (f) => {
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
        if (ctx.flags.json) process.stdout.write(turnOutcomeJson(outcome) + "\n");
        if (outcome.state === "cancelled") {
          queue.length = 0;
          if (!ctx.flags.json) process.stdout.write("\n" + theme.dim("✗ turn aborted") + "\n");
          return "aborted";
        }
        return "completed";
      } catch (err) {
        if (isAbortError(err)) {
          // User said stop: drop the queued follow-ups too.
          queue.length = 0;
          const outcome = turnOutcomeForError(err);
          if (ctx.flags.json && outcome) process.stdout.write(turnOutcomeJson(outcome) + "\n");
          else process.stdout.write("\n" + theme.dim("✗ turn aborted") + "\n");
          return "aborted";
        }
        // ChatTurnError means the Renderer already painted "✗ <msg>" for the
        // server's error frame (frame() runs before runTurn throws) — only
        // genuinely unrendered failures (network, fallback-leg errors) need
        // printError's own "✗" line, or the user sees the error twice.
        if (err instanceof ChatTurnError) {
          if (ctx.flags.json && err.outcome) process.stdout.write(turnOutcomeJson(err.outcome) + "\n");
          else if (!err.rendered) {
            process.stderr.write(formatErrorLine(err.outcome?.message ?? err.message, { hint: err.outcome?.hint ?? null }));
          }
        } else {
          const outcome = turnOutcomeForError(err);
          if (ctx.flags.json && outcome) process.stdout.write(turnOutcomeJson(outcome) + "\n");
          else printError(err, ctx.cfg.baseUrl);
        }
        // commit() clears the submitted line before the request starts. Put it
        // back only when the user has not typed ahead; otherwise preserve their
        // newer draft and leave the failed submission in history for recall.
        const recovered = recoverSubmittedPrompt(text, buf.value);
        if (recovered !== buf.value) {
          buf.clear();
          buf.insert(recovered);
        }
        return "failed";
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
        setupOwnsInput = /^\/agent-create\s+ATS(?:\s|$)/i.test(t);
        if (setupOwnsInput) process.stdout.write("\x1b[?2004l");
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
          if (setupOwnsInput) process.stdout.write("\x1b[?2004h");
          setupOwnsInput = false;
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
        let result = await runQueuedTurn(t);
        while (result === "completed" && queue.length > 0) {
          const next = queue.shift()!;
          process.stdout.write(`\n→ Queued: "${previewLine(next)}"\n`);
          result = await runQueuedTurn(next);
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
      if (setupOwnsInput) { if (chunk.includes(3)) slashAbort?.abort(); return; }
      let data = carry + decoder.write(chunk);
      carry = "";
      const partial = PARTIAL_ESC_RE.exec(data);
      if (partial && partial[0].length > 0 && partial.index + partial[0].length === data.length) {
        carry = partial[0];
        data = data.slice(0, partial.index);
      }
      for (const seq of splitKeys(data)) {
        if (setupOwnsInput) break;
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
  const p = ctx.flags.json ? "" : promptPrefix(userInfo().username || "you");
  let inflight: AbortController | null = null;
  const onSigint = (): void => inflight?.abort();
  process.on("SIGINT", onSigint);
  try {
    if (p) process.stdout.write(p);
    for await (const line of rl) {
    const t = line.trim();
    if (!t) {
      if (p) process.stdout.write(p);
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
      if (p) process.stdout.write(p);
      continue;
    }
    inflight = new AbortController();
    let printed = false; // printError already ends with a blank line
    try {
      const outcome = await runTurn(ctx, t, inflight.signal, undefined, undefined, skillOpts);
      if (ctx.flags.json) process.stdout.write(turnOutcomeJson(outcome) + "\n");
    } catch (err) {
      if (isAbortError(err)) {
        const outcome = turnOutcomeForError(err);
        if (ctx.flags.json && outcome) process.stdout.write(turnOutcomeJson(outcome) + "\n");
        else process.stderr.write("\n" + errTheme.dim("✗ canceled — turn discarded") + "\n");
      } else if (err instanceof ChatTurnError) {
        if (ctx.flags.json && err.outcome) {
          process.stdout.write(turnOutcomeJson(err.outcome) + "\n");
          printed = true;
        } else if (!err.rendered) {
          process.stderr.write(formatErrorLine(err.outcome?.message ?? err.message, { hint: err.outcome?.hint ?? null }));
          printed = true;
        }
      } else {
        const outcome = turnOutcomeForError(err);
        if (ctx.flags.json && outcome) process.stdout.write(turnOutcomeJson(outcome) + "\n");
        else printError(err, ctx.cfg.baseUrl);
        printed = true;
      }
    } finally {
      inflight = null;
    }
    if (p) process.stdout.write((printed ? "" : "\n") + p);
    }
    return 0;
  } finally {
    process.off("SIGINT", onSigint);
    rl.close();
    if (p) process.stdout.write("\n");
  }
}

function printError(err: unknown, baseUrl: string): void {
  const msg = err instanceof Error ? err.message : String(err);
  // formatErrorLine (LOOP-06) owns the glyph/hint/separator convention so
  // this reads identically to a server-streamed error frame's Renderer.error
  // — see src/ui/error_line.ts for why both paths must agree.
  process.stderr.write(formatErrorLine(msg, { hint: errorHint(err, baseUrl) }));
}
