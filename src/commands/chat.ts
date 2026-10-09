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
  TurnDeadlineError,
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
import { handleSlash } from "./slash.js";
import { ConsoleAuthRepair } from "./console_auth.js";
import { applyPromptMode } from "./prompt_modes.js";
import { userInfo } from "node:os";
import { renderSplash } from "../ui/splash.js";
import { promptPrefix } from "../ui/prompt.js";
import { InputBuffer } from "../ui/input_line.js";
import { renderInputView } from "../ui/input_render.js";
import { decodeKey, splitKeys } from "../ui/keys.js";
import {
  backspaceHistoryQuery, olderHistoryMatch, openHistorySearch, renderHistorySearch,
  selectedHistoryMatch, typeHistoryQuery, type HistorySearchState,
} from "../ui/history_search.js";
import { ThinkingPulse } from "../ui/thinking.js";
import { ModelTextProgress } from "../core/model_text_progress.js";
import { ModelOutputBudget } from "../core/model_output_budget.js";
import { sanitizeTerm, visibleWidth } from "../ui/text.js";
import { registerRestore } from "../ui/restore.js";
import {
  acceptSlashPicker, moveSlashPicker, openSlashPicker, refreshSlashPicker, renderSlashPicker, slashDraft,
  type SlashPickerState,
} from "./slash_picker.js";
// history_store.ts (origin/main's own persistence + AETHER_NO_HISTORY opt-out)
// supersedes the old readline-backed ./history.js — see chat.ts's resolution
// report for why that file is now dead code pending a cleanup pass.
import { loadHistory, appendHistory, historyPath, historyEnabled } from "../core/history_store.js";
import { VERSION } from "../version.js";
import { chooseBackend, type BackendPath } from "../core/backend.js";
import { OllamaBrain } from "../core/brain_ollama.js";
import { isLocalModelId, localModelId, ollamaTagFromId, resolveHostedModel, resolveLocalModel } from "../core/local_ollama.js";
import type { Brain } from "../core/brain.js";
import { SteerChannel, formatSteerAck } from "../core/steer_channel.js";
import type { RunOptions, ToolResult } from "../core/tool_executor.js";
import { ToolExecutor } from "../core/tool_executor.js";
import { ConsoleShell, classifyConsoleInput, type ConsoleInput } from "./console_input.js";
import { ConsoleQueue, describeEntry, entryKind, parseQueueCommand, renderDisposition, type QueueCommand, type QueueEntry, type QueueableInput } from "./console_queue.js";
import { HostRenderer } from "../ui/host_render.js";
import type { TaskCommand } from "../core/brain.js";
import { getRegistry } from "../core/context_registry.js";
import { bindToolApprovalVerdict, deniedToolResult, prepareToolApproval, requestToolApproval, terminalSafeReview, type ToolApprovalVerdict } from "../core/tool_approval.js";
import { openRunSession, refusalToolResult } from "../core/skills/run_session.js";
import {
  TRANSIENT_READ_AUTO_RETRIES,
  checkpointDoneEvent,
  checkpointLines,
  classifyToolFailure,
  defaultToolFailureBudget,
  hostMayRetry,
  operationKey,
  type ToolFailureBudget,
  type ToolFailureOrigin,
} from "../core/tool_failure_budget.js";
import type { SkillRefusal } from "../core/skills/skill_errors.js";
import { refuseRunCapability, type RunCapability } from "../core/run_capability.js";
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
import type { BrainEvent, ToolName } from "../core/brain_protocol.js";
import { ConsoleTaskContinuation, accountFingerprint, consoleWorkspaceState, observedWorkspaceChanges, type ModelTarget, type ObservedTool } from "./model_continuation.js";
import { parseOneTurnSkill } from "./one_turn_skill.js";

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
  capability?: RunCapability;
  explicitSkill?: string;
  noSkills?: boolean;
  /** Shell attachments must never become durable receipt/export content. */
  ephemeralAttachment?: boolean;
  /** /skill requires a host-executed route for the resolved policy. */
  requireHostSkillEnforcement?: boolean;
  /** Local console authority, never serialized to Cloud. */
  exec?: ToolExecutor;
  /** Host-observed results only; no model text or shell output. */
  onToolResult?: (tool: ObservedTool) => void;
  /** Console /steer routing for this turn (#283). Never serialized to Cloud. */
  steer?: SteerChannel;
}

/** Why a hosted chat turn only takes steering for the next turn (#283). */
export const HOSTED_STEER_DEFERRED = "this hosted chat route has no live control acknowledgement";

export const DEFAULT_CHAT_TURN_DEADLINE_MS = 30 * 60_000;
/** A positive override is useful for tests and operators; 0 cannot disable it. */
export function chatTurnDeadlineMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const parsed = Number(env["AETHER_CHAT_TURN_DEADLINE_MS"]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : DEFAULT_CHAT_TURN_DEADLINE_MS;
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
  private readonly modelText = new ModelTextProgress();
  private readonly taskText = new Map<string, ModelTextProgress>();
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
        return this.modelText.meaningful(frame.text);
      case "progress":
        return this.nonEmptyOnce("progress:", frame.text ?? "");
      case "usage":
        return false; // spend can rise while a model repeats itself
      case "connected":
        if (this.connected) return false;
        this.connected = true;
        return true;
      case "project_done":
        if (this.projectDone) return false;
        this.projectDone = true;
        return true;
      case "task_progress":
        if (!this.taskText.has(frame.taskId)) {
          if (this.taskText.size >= 16) return false;
          this.taskText.set(frame.taskId, new ModelTextProgress());
        }
        return this.taskText.get(frame.taskId)!.meaningful(frame.delta ?? "");
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
  private readonly modelText = new ModelTextProgress();
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
        return this.modelText.meaningful(event.text);
      case "skill":
        return this.once(`skill:${event.name}:${event.reason}`);
      case "turn":
        return this.once(`turn:${event.n}:${event.toolCalls}:${event.malformed}:${event.invented}:${event.noCall}:${event.failCount ?? ""}`);
      case "tool_call":
        return this.once(`tool:${event.id}`);
      case "telemetry":
        return false; // token counters can rise during a repeated answer
      case "status":
        return this.nonEmptyOnce("status:", event.phase);
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
 * Resolve which brain runs this turn. AETHER_BACKEND (env) wins, then an
 * explicit --local, the saved config, and 'auto'. 'auto' is local-first: cloud
 * when signed in, else local Ollama. The REPL banner uses the same route.
 */
export async function resolveBackend(ctx: AppContext): Promise<BackendPath> {
  const pref = (process.env["AETHER_BACKEND"] || (ctx.flags.local ? "local" : ctx.cfg.backend) || "auto").trim();
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
  onPulsePaint?: (frame: string) => void,
  skillOpts: TurnSkillOptions = {},
): Promise<TurnOutcome> {
  const lifecycle = new TurnLifecycle(prompt);
  lifecycle.transition("submitted");
  const boundedSignal = new AbortController();
  const forwardAbort = (): void => boundedSignal.abort(signal?.reason ?? new DOMException("turn cancelled", "AbortError"));
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  const deadlineMs = chatTurnDeadlineMs();
  const deadlineAt = Date.now() + deadlineMs;
  const deadline = setTimeout(() => boundedSignal.abort(new TurnDeadlineError(deadlineMs)), deadlineMs);
  deadline.unref?.();
  const preflightPulse = new ThinkingPulse({
    enabled: Boolean(process.stderr.isTTY) && !ctx.flags.json && process.env["AETHER_NO_ANIM"] !== "1",
    write: (s) => process.stderr.write(errTheme.dim(s)),
    onPaint: onPulsePaint,
  });
  preflightPulse.start();
  try {
    const backend = await resolveBackend(ctx);
    if (skillOpts.capability === "planning" && backend === "cloud") {
      throw new ChatTurnError("planning requires host-executed tools; this cloud chat route runs tools on the server. Use `aether agent --planning` or `aether agent --local --planning`.", undefined, false);
    }
    if (skillOpts.explicitSkill && skillOpts.noSkills) {
      throw new ChatTurnError("/skill is unavailable while --no-skills is active.", undefined, false);
    }
    if (skillOpts.requireHostSkillEnforcement && backend === "cloud") {
      throw new ChatTurnError("/skill requires host-executed tools; this cloud chat route runs tools on the server. Switch to a local model or use aether agent --skill <id> <task>.", undefined, false);
    }
    // The same seam `aether agent` uses (commands/code.ts). Opened per turn, not
    // per session, because automatic skill selection reads THIS prompt — a turn
    // that says "the CI is failing" should pull the CI skill and the next one
    // should not inherit it.
    const opened = openRunSession({
      projectRoot: ctx.flags.cwd,
      prompt,
      selectedPins: getRegistry().selectedPins(),
      selectedFileTransport: backend === "cloud" ? "unsupported" : "host",
      ...(skillOpts.capability ? { capability: skillOpts.capability } : {}),
      allowIncompleteInstructionDiscovery: backend === "cloud",
      ...(skillOpts.explicitSkill ? { explicitSkill: skillOpts.explicitSkill } : {}),
      ...(skillOpts.noSkills ? { noSkills: true } : {}),
    });
    preflightPulse.stop();
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
      if (skillOpts.requireHostSkillEnforcement || header !== lastTurnHeader) {
        lastTurnHeader = header;
        for (const line of run.headerLines) process.stderr.write(errTheme.dim("  " + line) + "\n");
      }
    } else {
      lastTurnHeader = null;
    }
    const brief = run.brief(prompt);
    getRegistry().lastAdmitted = run.admittedContext();

    if (backend === "local") {
      // Aether meters nothing on a local brain, so the session is unmetered
      // rather than "zero spend so far".
      getRegistry().markLocalUnmetered();
      // The signal used to be dropped here, so the REPL Ctrl+C controller could
      // not reach a local turn at all: the abort fired and nothing observed it.
      return await runLocalTurn(ctx, brief, boundedSignal.signal, { lifecycle, onPulsePaint, deadlineAt, capability: skillOpts.capability, advertisedTools: run.effectiveTools as readonly ToolName[], ...(skillOpts.exec ? { exec: skillOpts.exec } : {}), ...(skillOpts.onToolResult ? { onToolResult: skillOpts.onToolResult } : {}), ...(skillOpts.steer ? { steer: skillOpts.steer } : {}) }, run.guard);
    }
    // /agent/chat/stream exposes no control acknowledgement, so a steer typed
    // during this turn is kept for the next one rather than reported as live.
    skillOpts.steer?.markNextTurnOnly(HOSTED_STEER_DEFERRED);
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
    return await runCloudTurn(ctx, brief, lifecycle, boundedSignal.signal, onFrame, onPulsePaint, deadlineAt, deadlineMs, skillOpts.ephemeralAttachment !== true);
  } catch (err) {
    const outcome = finalizeThrownTurn(lifecycle, err, ctx.cfg.baseUrl);
    if (err instanceof ChatTurnError) throw err.outcome ? err : new ChatTurnError(err.message, outcome, err.rendered);
    throw attachTurnOutcome(err, outcome);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", forwardAbort);
    preflightPulse.stop();
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
  onPulsePaint?: (frame: string) => void,
  deadlineAt = Date.now() + chatTurnDeadlineMs(),
  deadlineMs = chatTurnDeadlineMs(),
  persistCustody = true,
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
  // A carriage-return pulse would erase a partially streamed answer. Once
  // output starts, use a delayed stderr notice to make later silence visible
  // without changing any answer bytes on stdout.
  const silenceNoticeMs = (() => {
    const parsed = Number(process.env["AETHER_STREAM_SILENCE_NOTICE_MS"] ?? 2_000);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 2_000;
  })();
  let silenceNotice: ReturnType<typeof setTimeout> | null = null;
  let silenceNoticeShown = false;
  let lastSilenceNoticeAt = 0;
  let answerStarted = false;
  const clearSilenceNotice = (): void => {
    if (silenceNotice) clearTimeout(silenceNotice);
    silenceNotice = null;
  };
  const armSilenceNotice = (): void => {
    clearSilenceNotice();
    if (!pulseInteractive || !answerStarted || silenceNoticeShown) return;
    const throttleMs = Math.max(30, silenceNoticeMs * 3);
    const delayMs = Math.max(silenceNoticeMs, lastSilenceNoticeAt + throttleMs - Date.now());
    silenceNotice = setTimeout(() => {
      silenceNotice = null;
      silenceNoticeShown = true;
      lastSilenceNoticeAt = Date.now();
      process.stderr.write(errTheme.dim("\n· Still waiting for the model · Ctrl+C cancels the turn\n"));
    }, delayMs);
    silenceNotice.unref?.();
  };
  let partialOutput = false;
  let streamedError: ChatTurnError | null = null;
  const progressTimeoutMs = defaultStreamTimeoutMs();
  const streamController = new AbortController();
  const forwardAbort = (): void => streamController.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  const progress = new StreamProgressTracker();
  const modelOutput = new ModelOutputBudget();
  const pendingToolCalls = new Set<string>();
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
      // Buffered SSE can yield through microtasks without running timers.
      if (Date.now() >= deadlineAt) throw new TurnDeadlineError(deadlineMs);
      if (frame.type === "delta" || frame.type === "reasoning") modelOutput.add(frame.text);
      if (frame.type === "task_progress") modelOutput.add(frame.delta ?? "");
      // open/ping are handshake/keepalive — they render nothing. Stopping on
      // them re-created the dead air on keepalive-happy servers; only frames
      // that produce visible output own the line.
      const visibleText =
        ((frame.type === "delta" || frame.type === "reasoning") && visibleWidth(sanitizeTerm(frame.text).trim()) > 0) ||
        (frame.type === "task_progress" && visibleWidth(sanitizeTerm(frame.delta ?? "").trim()) > 0);
      if (visibleText || frame.type === "done" || frame.type === "error") pulse.stop();
      if (visibleText) answerStarted = true;
      const meaningful = progress.meaningful(frame);
      if (frame.type === "tool_call" && meaningful && pendingToolCalls.size < 64) pendingToolCalls.add(frame.toolCallId);
      if (frame.type === "tool_result_ack" && meaningful && pendingToolCalls.delete(frame.toolCallId)) modelOutput.reset();
      if (meaningful) {
        armProgressTimeout();
        if (visibleText) silenceNoticeShown = false;
        armSilenceNotice();
      }
      if (frame.type === "done" || frame.type === "error") clearSilenceNotice();
      // The server signs each turn and returns it; persist the signed receipt
      // locally (best-effort, never breaks the chat).
      // The terminal frame carries the turn's authoritative cost. Settled by
      // turn id so a reconnect replaying it cannot count the same turn twice,
      // and only from the server's own number — never estimated from tokens.
      if (frame.type === "done") getRegistry().settleTurn(lifecycle.id, frame.uvt);
      if (frame.type === "custody" && persistCustody) appendCustody(frame.custody);

      if (frame.type === "tool_call") {
        noteWaitingForTool(lifecycle);
      } else if (frame.type !== "open" && frame.type !== "ping" && frame.type !== "done" && frame.type !== "error") {
        noteStreamingActivity(lifecycle);
        if (frame.type === "delta" && sanitizeTerm(frame.text).length > 0) partialOutput = true;
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
      if (Date.now() >= deadlineAt) throw new TurnDeadlineError(deadlineMs);
      modelOutput.add(response);
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
    clearSilenceNotice();
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
  capability?: RunCapability;
  advertisedTools?: readonly ToolName[];
  brain?: Brain;
  exec?: {
    executeAsync(name: string, args: Record<string, unknown>, options?: RunOptions): Promise<ToolResult>;
    previewPatch?(args: Record<string, unknown>): ToolResult;
    readonly shellCwd?: string;
    readonly shellContext?: string;
    readonly configuredTestCommand?: string;
    close?(): void;
  };
  /** Reuse runTurn's lifecycle; direct callers get a fresh one automatically. */
  lifecycle?: TurnLifecycle;
  /** Keep type-ahead visible while the local model has not produced a frame. */
  onPulsePaint?: (frame: string) => void;
  /** Explicit 0 is a test/embed escape hatch; production uses the finite
   * stream deadline and cannot disable it through environment configuration. */
  meaningfulProgressTimeoutMs?: number;
  /** Per-model-segment output cap for embedders and focused tests. */
  modelOutputLimitBytes?: number;
  /** Shared absolute deadline when called through runTurn. */
  deadlineAt?: number;
  /** Repeated-failure budget (#285). Default: one per turn, bound to the
   * workspace. `false` disables it for a deliberate embed. */
  failureBudget?: ToolFailureBudget | false;
  onToolResult?: (tool: ObservedTool) => void;
  /** Live /steer routing: attached once the brain runs (#283). */
  steer?: SteerChannel;
}

/** What the brain is told when the host refuses a call selected before a steer. */
export function staleAfterSteerResult(name: string): ToolResult {
  return { output: `[tool ${name} not executed: superseded by operator steering accepted before it ran]`, exitCode: 1 };
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
  const brain = deps.brain ?? new OllamaBrain({ model, ...(deps.advertisedTools ? { tools: deps.advertisedTools } : {}) });
  const exec = deps.exec ?? new ToolExecutor(cwd);
  const seenCallIds = new Set<string>();
  const controller = new AbortController();
  const renderer = new HostRenderer({ poolGb: 5, json: ctx.flags.json });
  const pulse = new ThinkingPulse({
    enabled: Boolean(process.stderr.isTTY) && !ctx.flags.json && process.env["AETHER_NO_ANIM"] !== "1",
    write: (s) => process.stderr.write(errTheme.dim(s)),
    onPaint: deps.onPulsePaint,
  });
  const approveTool = async (callId: string, name: string, args: Record<string, unknown>): Promise<ToolApprovalVerdict> => {
    let patchPreview: string | undefined;
    if (name === "patch_file" && exec.previewPatch) {
      const preview = exec.previewPatch(args);
      process.stderr.write(terminalSafeReview(preview.output) + "\n");
      if (preview.exitCode !== 0) return { callId, approved: true };
      patchPreview = preview.output;
    }
    return requestToolApproval({
      callId,
      name, args: args as Record<string, string | number>,
      permissionMode: ctx.cfg.permissionMode, autoApply: ctx.cfg.autoApply,
      yes: ctx.flags.yes, isTty: Boolean(process.stdin.isTTY),
      shellCwd: exec.shellCwd ?? cwd, fileRoot: cwd, confirm: ctx.confirm,
      ...(ctx.approvalFeedback ? { feedback: () => ctx.approvalFeedback!(controller.signal) } : {}),
      patchPreview,
      onDeny: () => process.stderr.write(`blocked ${name}: confirmation required; use --yes or permissionMode skip\n`),
    });
  };
  const task: TaskCommand = {
    type: "task",
    capability: deps.capability ?? "coding",
    text: prompt,
    cwd,
    poolGb: 5,
    model,
  };
  let partialOutput = false;
  let terminalError: ChatTurnError | null = null;
  const timeoutMs = deps.meaningfulProgressTimeoutMs ?? defaultStreamTimeoutMs();
  const forwardAbort = (): void => controller.abort(signal?.reason ?? new DOMException("turn cancelled", "AbortError"));
  const closeBrain = (): void => {
    try { brain.close(); } catch { /* cleanup cannot replace the primary outcome */ }
  };
  const onAbort = (): void => closeBrain();
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const progress = new LocalBrainProgressTracker();
  const failures = deps.failureBudget === false ? null : (deps.failureBudget ?? defaultToolFailureBudget(cwd, exec));
  const modelOutput = new ModelOutputBudget(deps.modelOutputLimitBytes);
  const deadlineMs = chatTurnDeadlineMs();
  const deadlineAt = deps.deadlineAt ?? Date.now() + deadlineMs;
  let lastMeaningfulAt = Date.now();
  let iterator: AsyncIterator<BrainEvent> | null = null;
  const timeout = (error: MeaningfulProgressTimeoutError): void => {
    if (!controller.signal.aborted) controller.abort(error);
  };
  try {
    pulse.start();
    iterator = brain.run(task)[Symbol.asyncIterator]();
    deps.steer?.attach(brain);
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
      if (Date.now() >= deadlineAt) throw new TurnDeadlineError(deadlineMs);
      if (ev.type === "monologue") modelOutput.add(ev.text);
      pulse.stop();
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
        if (seenCallIds.has(ev.id)) continue; // one result and no second execution for one call ID
        seenCallIds.add(ev.id);
        noteWaitingForTool(lifecycle);
        renderer.event(ev);
        // Same ordering as hostLoop (commands/code.ts): the skill narrowing is
        // checked first and refuses without executing or prompting; the
        // operator gate then decides about whatever survived. A skill can only
        // subtract here — it is never consulted again after this line.
        const refusal = refuseRunCapability(ev.name, task.capability ?? "coding") ?? (skillGuard ? skillGuard(ev.name) : null);
        const prepared = refusal ? null : prepareToolApproval(ev.name, ev.args, exec.configuredTestCommand);
        const call = { name: ev.name, args: ev.args };
        const key = operationKey(call, { policy: Boolean(refusal), ...(prepared?.ok ? { binding: prepared.binding } : {}) });
        const deliver = (result: ToolResult, origin: ToolFailureOrigin | null): void => {
          if (origin === "execution") deps.onToolResult?.({
            name: ev.name,
            ...(typeof ev.args["path"] === "string" ? { path: ev.args["path"] } : {}),
            exitCode: result.exitCode,
          });
          if (origin) failures?.record(key, call, result, origin);
          const note = origin ? failures?.repeatNote(key) : null;
          brain.sendToolResult(ev.id, note && result.exitCode !== 0 ? { ...result, output: `${result.output}\n${note}` } : result);
        };
        // A steer the brain accepted but has not yet put in front of the
        // model means this call was selected before it. It is answered
        // without prompting or executing, and counts as no failure (#283).
        const supersededBySteer = (): boolean => {
          if (!deps.steer?.hasPendingSteer()) return false;
          deps.steer.noteToolSkipped(ev.name);
          deliver(staleAfterSteerResult(ev.name), null);
          return true;
        };
        if (supersededBySteer()) {
          lastMeaningfulAt = Date.now();
          modelOutput.reset();
          noteStreamingActivity(lifecycle);
          pulse.start();
          continue;
        }
        // Same repeated-failure budget as hostLoop, checked before any prompt
        // or execution: a spent operation is refused once, then stops the turn.
        failures?.noteModelRound(brain.modelRound?.());
        const decision = failures?.check(key, call) ?? { action: "allow" as const };
        if (decision.action === "stop") {
          brain.sendToolResult(ev.id, decision.result);
          // Close before anything yields, so the brain cannot start one more
          // model request on the strength of that result.
          closeBrain();
          const stopped = checkpointDoneEvent(decision.checkpoint);
          renderer.event(stopped);
          if (!ctx.flags.json) {
            process.stderr.write(checkpointLines(decision.checkpoint).map((line) => "  " + line).join("\n") + "\n");
          }
          lifecycle.transition("completing");
          const outcome = lifecycle.finalize("incomplete", {
            message: stopped.result,
            hint: decision.checkpoint.recovery,
            retryable: false,
            partialOutput,
          });
          terminalError = new ChatTurnError(stopped.result, outcome);
          break;
        }
        if (decision.action === "refuse") {
          deliver(decision.result, null);
        } else if (refusal || !prepared) {
          if (refusal) deliver(refusalToolResult(refusal), "policy");
        } else {
          // executeAsync so the two web tools (web_search/web_fetch) work too.
          if (!prepared.ok) {
            deliver({ output: `[tool ${ev.name} rejected: ${prepared.error}]`, exitCode: 1 }, "validation");
            lastMeaningfulAt = Date.now();
            modelOutput.reset();
            noteStreamingActivity(lifecycle);
            pulse.start();
            continue;
          }
          const approvalContext = exec.shellContext;
          const approval = bindToolApprovalVerdict(ev.id, await boundedLocalOperation(
            () => approveTool(ev.id, ev.name, prepared.args),
            controller.signal,
            timeoutMs,
            lastMeaningfulAt,
            timeout,
          ));
          const execute = (): Promise<ToolResult> => {
            const remaining = timeoutMs > 0
              ? Math.max(1, timeoutMs - (Date.now() - lastMeaningfulAt))
              : undefined;
            const toolOptions: RunOptions = {
              signal: controller.signal,
              ...(approvalContext !== undefined ? { expectedShellContext: approvalContext } : {}),
              expectedToolCall: prepared.binding,
              ...(remaining === undefined ? {} : { timeoutMs: remaining }),
            };
            return boundedLocalOperation(
              () => exec.executeAsync(ev.name, prepared.args, toolOptions),
              controller.signal,
              timeoutMs,
              lastMeaningfulAt,
              timeout,
            );
          };
          if (!approval.approved) {
            deliver(deniedToolResult(ev.name, approval), "approval");
          } else if (!supersededBySteer()) {
            // Approval can take a while; a steer accepted during the prompt is
            // checked above, so an approved-but-stale write still never runs.
            let result = await execute();
            // Read-only transient failures only; a mutation is never replayed.
            for (let retry = 0; retry < TRANSIENT_READ_AUTO_RETRIES; retry += 1) {
              if (controller.signal.aborted || deps.steer?.hasPendingSteer() || !hostMayRetry(ev.name, classifyToolFailure(ev.name, result))) break;
              result = await execute();
            }
            deps.steer?.noteToolFinished(ev.name);
            deliver(result, "execution");
          }
        }
        lastMeaningfulAt = Date.now();
        modelOutput.reset();
        noteStreamingActivity(lifecycle);
        pulse.start();
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
    pulse.stop();
    signal?.removeEventListener("abort", forwardAbort);
    controller.signal.removeEventListener("abort", onAbort);
    closeBrain();
    if (!deps.exec) exec.close?.();
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
  // Ctrl+C while the model is generating closes the brain, which ends its
  // stream without a done event. That is a cancellation, not a stream the
  // server cut short, and must settle the same way a cancelled tool wait does.
  const cancelReason: unknown = signal?.aborted ? signal.reason ?? new DOMException("turn cancelled", "AbortError") : null;
  if (cancelReason && isAbortError(cancelReason)) {
    return finalizeThrownTurn(lifecycle, cancelReason, ctx.cfg.baseUrl, partialOutput);
  }
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

async function consoleContinuationState(ctx: AppContext): Promise<ReturnType<typeof consoleWorkspaceState>> {
  const opened = openRunSession({ projectRoot: ctx.flags.cwd, prompt: "", noSkills: true, allowIncompleteInstructionDiscovery: true });
  const rulesDigest = opened.ok ? opened.run.session.provenance.instructionGraphDigest : "rules-unavailable";
  return consoleWorkspaceState(ctx.flags.cwd, accountFingerprint(await ctx.tokens.get()), rulesDigest);
}

function applyModelTarget(ctx: AppContext, target: ModelTarget): void {
  applyRestart(ctx.flags, { model: target.id });
  ctx.flags.local = target.destination === "local";
  ctx.cfg.backend = target.destination;
}

async function currentConsoleModel(ctx: AppContext): Promise<string> {
  if (ctx.flags.model) {
    const tag = ollamaTagFromId(ctx.flags.model);
    return tag ? localModelId(tag) : ctx.flags.model;
  }
  if ((await resolveBackend(ctx)) === "local") return localModelId(resolveLocalModel(undefined, ctx.cfg.localModel ?? ""));
  return ctx.cfg.defaultModel || "auto";
}

function switchDisposition(target: ModelTarget, brief: string, queueCount: number, draftSaved = false): string {
  return `Model switch pending: ${target.label} (${target.destination}).\n` +
    (queueCount ? `Queued entries: ${queueCount}; they stay queued and will not replay across this switch. Review them with /queue; remove them with /queue remove <id> or /queue clear.\n` : "Queued entries: none.\n") +
    `Unsent draft: ${draftSaved ? "saved; restored after continue, fresh, or cancel; never sent automatically" : "none"}.\n` +
    (target.contextWindow !== null && target.contextWindow < 2_048 ? "This target's context window is too small for continuation; choose fresh or cancel.\n" : "") +
    `Exact continuation brief for review:\n${brief}\n` +
    `Choose /switch continue, /switch fresh, or /switch cancel. Edit with /switch edit goal|constraints|outstanding <text>; /switch brief shows it again.\n`;
}

/** Build a prompt with optional steering and btw context prepended.
 *  Several steering notes keep their order, one line each. Clears steering
 *  and btwNotes in the returned result so callers can use single-shot
 *  semantics.  Exported for testing. */
export function buildPromptContext(
  base: string,
  steering: string | readonly string[] | null,
  btwNotes: string[],
): { prompt: string; steering: string | null; btwNotes: string[] } {
  const ctxParts: string[] = [];
  const steers = steering === null ? [] : typeof steering === "string" ? [steering] : steering;
  for (const steer of steers) if (steer) ctxParts.push(`STEERING: ${steer}`);
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

/** Stable machine terminal record. The prompt itself is deliberately omitted:
 * automation needs correlation/outcome/retry facts, not a second copy of user
 * content in every captured JSON log. */
export function turnOutcomeJson(outcome: TurnOutcome): string {
  return JSON.stringify(turnOutcomeRecord(outcome));
}

/** The `aether.turn/1` outcome record as an object, for a command that adds
 * its own terminal facts (`aether agent` adds its verification reading). */
export function turnOutcomeRecord(outcome: TurnOutcome): Record<string, unknown> {
  return {
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
  };
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
export async function repl(ctx: AppContext, skillOpts: TurnSkillOptions = {}): Promise<number> {
  const authRepair = new ConsoleAuthRepair(ctx);
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
  let consoleWrite = (text: string): void => { process.stdout.write(text); };
  const consoleShell = new ConsoleShell(ctx.flags.cwd, text => consoleWrite(text), ctx.flags.json);
  skillOpts = { ...skillOpts, exec: consoleShell.exec };
  const continuation = new ConsoleTaskContinuation(await consoleContinuationState(ctx));
  if (!process.stdin.isTTY) return replLines(ctx, skillOpts, consoleShell, process.stdin, authRepair, continuation);

  const buf = new InputBuffer();
  let switchDraft = "";
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
  let terminalOwnsInput = false;
  let approvalOwnsInput = false;
  let picker: SlashPickerState | null = null;
  let historySearch: HistorySearchState | null = null;
  let searchPriorPicker: SlashPickerState | null = null;
  let pickerPanelLines = 0;
  let pickerSuppressed = false;
  const composerCtx: AppContext = {
    ...ctx,
    confirm: async (question) => {
      buf.endRecoveryScope();
      approvalOwnsInput = true;
      try { return await ctx.confirm(question); }
      finally { approvalOwnsInput = false; }
    },
    approvalFeedback: async (signal) => {
      buf.endRecoveryScope();
      approvalOwnsInput = true;
      try { return await ctx.approvalFeedback?.(signal) ?? null; }
      finally { approvalOwnsInput = false; }
    },
  };
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
    if (pickerPanelLines) process.stdout.write(viewerClearSequence(pickerPanelLines));
    pickerPanelLines = 0;
    if (!buf.value) pickerSuppressed = false;
    if (picker || historySearch) {
      const lines = historySearch
        ? renderHistorySearch(historySearch, process.stdout.columns ?? 80, process.stdout.rows ?? 24)
        : renderSlashPicker(picker!, buf.value, process.stdout.columns ?? 80, process.stdout.rows ?? 24);
      if (lines.length) {
        process.stdout.write("\r\x1b[2K" + lines.join("\n") + "\n");
        pickerPanelLines = lines.length;
      }
    }
    process.stdout.write(repaintString(prompt + consoleShell.prompt(), buf.value, buf.pos, process.stdout.columns ?? 80));
  };
  consoleWrite = (text: string): void => {
    if (pickerPanelLines) {
      process.stdout.write(viewerClearSequence(pickerPanelLines));
      pickerPanelLines = 0;
      picker = null;
    }
    if (!busy) process.stdout.write("\r\x1b[2K");
    process.stdout.write(text);
    if (!busy) repaint();
  };
  // Unlike repaint(), this does NOT gate on busy: it's the thinking-pulse's
  // onPaint hook, fired from inside the pulse's own \r-repaint on stderr
  // (which happens precisely DURING the busy window). The pulse and the
  // input line share the same tty row, so every pulse frame must be
  // followed by re-drawing whatever the user has typed ahead, or their
  // in-progress keystrokes get stomped by the pulse's next `\r\x1b[2K`.
  const redrawInput = (frame: string): void => {
    process.stdout.write(repaintString(`${frame} ${prompt}${consoleShell.prompt()}`, buf.value, buf.pos, process.stdout.columns ?? 80));
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
  const queue = new ConsoleQueue();
  let runningSlash: string | null = null; // names a running slash command for /queue
  // /steer during a turn goes to that turn's brain when it can acknowledge
  // it; everything else waits for the next turn and is reported as such.
  const steerChannel = new SteerChannel((ack) => {
    process.stdout.write((busy ? "\n" : "") + formatSteerAck(ack) + "\n");
    if (!busy) repaint();
  });
  const btwNotes: string[] = [];
  let turnAbort: AbortController | null = null; // live while a local/cloud turn runs
  // Live while a slash command (e.g. /audit, /doctor) is in flight — kept
  // separate from turnAbort so Ctrl+C cancels only the network call actually
  // running, not a chat turn that isn't (fixes: Ctrl+C during a slow slash
  // command used to fall through to the double-press "quit" prompt instead
  // of canceling it, since turnAbort was null).
  let slashAbort: AbortController | null = null;
  let heldDraft: string | null = null; // type-ahead kept while /auth replaces the input line
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
    const onResize = (): void => {
      if ((process.stdout.rows ?? 24) < 3) {
        picker = null;
        searchPriorPicker = null;
      }
      if ((process.stdout.rows ?? 24) < 2 && historySearch) {
        buf.restoreDraft(historySearch.priorValue, historySearch.priorCursor);
        historySearch = null;
        searchPriorPicker = null;
      }
      repaint();
    };
    const cleanup = (): void => {
      consoleShell.close();
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
    /** Every pending entry is dropped and listed; none of them will resume. */
    const discardQueue = (reason: string): void => {
      const removed = queue.clear();
      process.stdout.write(renderDisposition(
        `\nQueue discarded (${reason}): ${removed.length} pending ${removed.length === 1 ? "entry" : "entries"} removed; none ran and none will resume.`,
        removed,
      ));
    };
    /** After a failed entry the rest stay listed but wait for /queue resume. */
    const holdQueue = (failed: QueueEntry): void => {
      if (!queue.hold(`${failed.id} failed`)) return;
      process.stdout.write(renderDisposition(
        `\nQueue paused (${failed.id} failed): ${queue.length} pending ${queue.length === 1 ? "entry" : "entries"} kept; none ran.`,
        queue.pending,
        "/queue resume runs them in order; /queue edit|remove <id> or /queue clear changes them.",
      ));
    };
    const finish = (code: number): void => {
      turnAbort?.abort(); slashAbort?.abort(); discardQueue("session ended");
      cleanup();
      process.stdout.write("\n");
      resolve(code);
    };

    /** Run one turn without sacrificing an existing type-ahead draft. */
    const runQueuedTurn = async (input: ConsoleInput, authContinuation = false): Promise<"completed" | "aborted" | "failed"> => {
      const sharedShellResult = input.kind === "share";
      if (input.kind === "share") input = consoleShell.share(input);
      if (input.kind === "error") { process.stdout.write(input.message + "\n"); return "completed"; }
      if (input.kind === "empty") return "completed";
      if (input.kind === "profile") {
        if (consoleShell.profileCommand(input)) {
          skillOpts = { ...skillOpts, exec: consoleShell.exec };
          discardQueue("shell profile changed");
        }
        return "completed";
      }
      if (input.kind !== "chat") {
        turnAbort = new AbortController();
        try {
          const result = await consoleShell.run(input, turnAbort.signal);
          // Queued shell commands assumed the old shell state: never run them
          // against a fresh one, and never after the user said stop.
          if (result === "aborted") discardQueue("cancelled");
          else if (result === "failed") discardQueue(consoleShell.session.state === "lost" ? "shell state lost" : "shell action failed");
          else if (input.kind === "reset-shell") discardQueue("shell reset");
          return result;
        } finally { turnAbort = null; }
      }
      const text = input.text;
      // An auth continuation replays the saved task verbatim; kept notes wait.
      const carriedSteers = authContinuation ? [] : steerChannel.takeNextTurnNotes();
      const built = authContinuation ? { prompt: text } : buildPromptContext(text, carriedSteers, btwNotes);
      const beforeChanges = observedWorkspaceChanges(ctx.flags.cwd);
      const toolResults: ObservedTool[] = [];
      if (!authContinuation) btwNotes.length = 0;
      const steerTurn = steerChannel.beginTurn();
      // How the turn ended, for its steering: a cancel drops unapplied notes
      // (reported); a failure the operator may retry keeps the carried ones.
      let steerEnd: "ended" | "cancelled" | "retryable" = "ended";
      viewerState = createViewerState();
      viewerOpen = false;
      viewerLastLines = 0;
      turnAbort = new AbortController();
      const receipts: string[] = [];
      let submittedPrompt = built.prompt;
      try {
        if (await resolveBackend(ctx) === "cloud") {
          if (authRepair.submissionBlocked) {
            process.stdout.write("Account changed or could not be verified. Use /auth new before sending another hosted task.\n");
            if (!sharedShellResult && !buf.value) buf.insert(text);
            steerEnd = "retryable";
            return "failed";
          }
          await authRepair.captureAccount();
        }
        const nextPrompt = continuation.promptForNextTurn(built.prompt, continuation.hasAcceptedBrief ? await consoleContinuationState(ctx) : undefined);
        submittedPrompt = nextPrompt;
        if (await resolveBackend(ctx) === "cloud") authRepair.markHostedTurnStarted();
        const outcome = await runTurn(composerCtx, nextPrompt, turnAbort.signal, (f) => {
          if (receipts.length < 64) {
            if (f.type === "tool_call") receipts.push(sanitizeServerText(`tool call ${f.toolCallId} (${f.name})`));
            if (f.type === "tool_result_ack") receipts.push(sanitizeServerText(`tool result ${f.toolCallId}`));
            if (f.type === "custody") receipts.push("signed custody receipt");
          }
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
        }, redrawInput, { ...skillOpts, ephemeralAttachment: sharedShellResult, capability: input.capability ?? "coding",
          ...(input.oneTurnSkill ? { explicitSkill: input.oneTurnSkill.reference, requireHostSkillEnforcement: true } : {}),
          onToolResult: tool => toolResults.push(tool), steer: steerChannel });
        const afterChanges = observedWorkspaceChanges(ctx.flags.cwd);
        continuation.recordTurn(text, toolResults, afterChanges.filter(change => !beforeChanges.includes(change)), outcome.state, !sharedShellResult && !authContinuation);
        if (ctx.flags.json) process.stdout.write(turnOutcomeJson(outcome) + "\n");
        if (outcome.state === "cancelled") {
          if (!ctx.flags.json) process.stdout.write("\n" + theme.dim("✗ turn aborted") + "\n");
          steerEnd = "cancelled";
          discardQueue("turn cancelled");
          return "aborted";
        }
        return "completed";
      } catch (err) {
        const afterChanges = observedWorkspaceChanges(ctx.flags.cwd);
        continuation.recordTurn(text, toolResults, afterChanges.filter(change => !beforeChanges.includes(change)), "failed", !sharedShellResult && !authContinuation);
        if (isAbortError(err)) {
          // User said stop: drop the queued follow-ups too, and say which.
          const outcome = turnOutcomeForError(err);
          if (ctx.flags.json && outcome) process.stdout.write(turnOutcomeJson(outcome) + "\n");
          else process.stdout.write("\n" + theme.dim("✗ turn aborted") + "\n");
          steerEnd = "cancelled";
          discardQueue("turn cancelled");
          return "aborted";
        }
        // ChatTurnError means the Renderer already painted "✗ <msg>" for the
        // server's error frame (frame() runs before runTurn throws) — only
        // genuinely unrendered failures (network, fallback-leg errors) need
        // printError's own "✗" line, or the user sees the error twice.
        const authFailure = !sharedShellResult && await resolveBackend(ctx) === "cloud"
          && authRepair.noteFailure(err, submittedPrompt, turnOutcomeForError(err), receipts);
        if (authFailure && buf.value) heldDraft = buf.value;
        if (authFailure && !ctx.flags.json) {
          process.stderr.write((err instanceof ChatTurnError && err.rendered ? "" : "✗ Hosted credential rejected (401). ")
            + "Task saved. Use /auth login; /auth status shows the credential source.\n");
          for (const receipt of receipts) process.stderr.write(`  ${receipt}\n`);
        } else if (err instanceof ChatTurnError) {
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
        const recovered = sharedShellResult || authFailure ? buf.value : recoverSubmittedPrompt(input.oneTurnSkill?.source ?? text, buf.value);
        if (recovered !== buf.value) {
          buf.clear();
          buf.insert(recovered);
        }
        // A hosted auth failure saved the prompt with its notes already in it.
        if (!authFailure) steerEnd = "retryable";
        return "failed";
      } finally {
        turnAbort = null;
        // Notes that never reached the model are reported either way: kept for
        // the next turn, or — when the operator cancelled — not retained.
        if (steerEnd === "cancelled") steerChannel.cancelTurn();
        else steerChannel.endTurn();
        if (steerEnd === "retryable") {
          steerChannel.restoreNextTurnNotes(carriedSteers, `turn ${steerTurn} failed; kept for the retry`);
        }
      }
    };

    const runEntry = async (entry: QueueEntry, authContinuation = false): Promise<"completed" | "aborted" | "failed"> => {
      queue.setRunning(entry);
      const sessionId = consoleShell.session.id;
      try { return await runQueuedTurn(entry.input, authContinuation); }
      finally {
        if (consoleShell.session.id !== sessionId || consoleShell.session.state !== "ready") discardQueue("shell session changed");
        queue.setRunning(null);
      }
    };

    /** Run one entry, then drain pending entries in strict order. A failure
     * pauses the rest; a cancellation discards them (see runQueuedTurn). */
    const runAndDrain = async (first: QueueEntry, authContinuation = false): Promise<void> => {
      try {
        getRegistry().startAgentTimer();
        let entry: QueueEntry | undefined = first;
        let result = await runEntry(first, authContinuation);
        while (result === "completed") {
          entry = queue.shift();
          if (!entry) break;
          process.stdout.write(`\n→ Running queued ${entry.id} (${entryKind(entry.input)}): ${describeEntry(entry.input)}\n`);
          result = await runEntry(entry);
        }
        if (result === "failed" && entry) holdQueue(entry);
      } finally {
        busy = false;
        getRegistry().startUserTimer();
      }
    };

    /** Queue one input behind the active operation. Returns false (and says
     * why) when it was not queued, so the caller keeps the draft. */
    const enqueueInput = (input: QueueableInput): boolean => {
      const toQueue = input;
      const result = queue.enqueue(toQueue);
      if (!result.ok) {
        const restored = input.kind !== "share" || consoleShell.restoreShare(input);
        process.stdout.write(`\n${result.message} ${restored ? "Draft kept." : "A newer shell preview was preserved; the rejected send was not queued."}\n`);
        return false;
      }
      const paused = queue.held ? "; queue PAUSED, /queue resume runs it" : "";
      process.stdout.write(`\n⏳ Queued ${result.entry.id} (${entryKind(toQueue)}, ${queue.length} pending${paused}): ${describeEntry(toQueue)}\n`);
      return true;
    };

    /** /queue management is local bookkeeping: it never calls a model or
     * starts a process (except /queue resume, which hands entries back to the
     * ordinary drain). */
    const handleQueueCommand = async (command: QueueCommand): Promise<void> => {
      const write = (text: string): void => { process.stdout.write(text); };
      switch (command.op) {
        case "usage": write(command.message + "\n"); return;
        case "list": write(queue.render(runningSlash)); return;
        case "clear": {
          const removed = queue.clear();
          write(removed.length
            ? renderDisposition(`Cleared ${removed.length} pending ${removed.length === 1 ? "entry" : "entries"}; none ran:`, removed)
            : "Queue is already empty.\n");
          return;
        }
        case "remove": {
          const result = queue.remove(command.id);
          write(result.ok ? `Removed ${result.entry.id} (${entryKind(result.entry.input)}); it will not run.\n` : result.message + "\n");
          return;
        }
        case "edit": {
          const result = queue.edit(command.id, command.text);
          write(result.ok ? `Edited ${result.entry.id} (${entryKind(result.entry.input)}, position kept): ${describeEntry(result.entry.input)}\n` : result.message + "\n");
          return;
        }
        case "resume": {
          if (continuation.pending) { write("Resolve the pending model switch with /switch first; the queue stays as listed.\n"); return; }
          if (!queue.resume()) { write(queue.length ? "Queue is not paused.\n" : "Queue is empty; nothing to resume.\n"); return; }
          write(`Queue resumed: ${queue.length} pending ${queue.length === 1 ? "entry runs" : "entries run"} in order${busy ? " after the current operation" : ""}.\n`);
          if (busy) return;
          const next = queue.shift();
          if (!next) return;
          busy = true;
          await runAndDrain(next);
          renderHudLine();
          return;
        }
      }
    };

    const onCtrlC = (): void => {
      picker = null;
      historySearch = null;
      searchPriorPicker = null;
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
      const raw = buf.value;
      // Queue management works mid-turn and during a pending switch (whose
      // disposition asks the user to clear entries). It stays out of history:
      // an edit can carry local shell text.
      const queueCommand = parseQueueCommand(raw);
      if (queueCommand) {
        buf.clear();
        process.stdout.write("\n");
        await handleQueueCommand(queueCommand);
        repaint();
        return;
      }
      if (continuation.pending && !raw.trim().startsWith("/switch")) {
        process.stdout.write("\nChoose /switch continue, fresh, cancel, brief, or edit first. Draft preserved.\n");
        repaint();
        return;
      }
      if (ConsoleShell.isTerminalCommand(raw)) {
        if (busy || queue.length) { process.stdout.write("\nFinish the active operation and resume or clear pending entries before terminal handoff.\n"); return; }
        buf.clear(); // Explicit terminal commands never enter model/history.
        busy = true; terminalOwnsInput = true;
        try { await consoleShell.terminalCommand(raw); }
        catch (error) { printError(error, ctx.cfg.baseUrl); }
        finally { terminalOwnsInput = false; busy = false; repaint(); }
        return;
      }
      const queuePrefix = /^\s*\/queue[ \t]+/.exec(raw);
      const oneTurnSkill = parseOneTurnSkill(queuePrefix ? raw.slice(queuePrefix[0].length) : raw);
      if (oneTurnSkill) {
        if (queuePrefix || busy) {
          process.stdout.write("\n/skill runs only from the idle composer and cannot be queued. Draft preserved.\n");
          repaint(); return;
        }
        if (skillOpts.noSkills) {
          process.stdout.write("\n/skill is unavailable while --no-skills is active. Draft preserved.\n");
          repaint(); return;
        }
        if (oneTurnSkill.kind === "usage") {
          process.stdout.write("\n" + oneTurnSkill.message + "\n");
          repaint(); return;
        }
        remember(raw);
        buf.commit(raw);
        process.stdout.write("\n");
        busy = true;
        await runAndDrain(queue.allocate({ kind: "chat", text: oneTurnSkill.task,
          oneTurnSkill: { reference: oneTurnSkill.reference, source: oneTurnSkill.source } }));
        renderHudLine(); repaint();
        return;
      }
      let input = classifyConsoleInput(queuePrefix ? raw.slice(queuePrefix[0].length) : raw);
      if (input.kind === "share") {
        input = consoleShell.prepareShare(input, ctx.flags.json);
        if (input.kind === "empty") { buf.clear(); repaint(); return; }
      }
      const commit = (): void => {
        if (input.kind === "chat") { remember(buf.value); buf.commit(buf.value); }
        else buf.clear();
      };
      let t = input.kind === "chat" ? input.text : "";
      if (t && heldDraft === t && !t.startsWith("/auth")) heldDraft = null;
      if (input.kind === "error") {
        buf.clear(); // a usage error is reported now, never queued
        process.stdout.write("\n" + input.message + "\n");
        repaint();
        return;
      }
      if (input.kind !== "chat" && input.kind !== "empty") {
        // Shell commands never enter chat history or prompt context. A
        // rejected enqueue keeps the draft in the composer.
        if (busy) {
          if (enqueueInput(input)) buf.clear();
          return;
        }
        buf.clear();
        process.stdout.write("\n");
        busy = true;
        await runAndDrain(queue.allocate(input));
        renderHudLine(); repaint();
        return;
      }
      // ── mid-turn Enter: bypass commands + type-ahead queueing ──
      if (busy) {
        if (t.startsWith("/steer ")) {
          remember(buf.value);
          buf.commit(buf.value);
          // Acknowledged through the channel: accepted/applied by the running
          // turn, refused, or deferred to the next turn — never assumed.
          steerChannel.steer(t.slice(7)).catch(() => { /* acks are best-effort output */ });
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
        if (!t || t.startsWith("/")) {
          remember(buf.value);
          buf.commit(buf.value);
          if (t) process.stdout.write("\nSlash commands are not queued; run it after the current operation (↑ recalls it).\n");
          return;
        }
        if (!enqueueInput({ kind: "chat", text: t })) return;
        remember(buf.value);
        buf.commit(buf.value);
        return;
      }

      // A pending switch owns the idle boundary. A different typed draft is
      // left in the composer, unsubmitted and unrecorded.
      if (continuation.pending && !t.startsWith("/switch")) {
        process.stdout.write("\nChoose /switch continue, fresh, cancel, brief, or edit first. Draft preserved.\n");
        repaint();
        return;
      }

      if (t.startsWith("/switch")) {
        process.stdout.write("\n");
        buf.clear();
        const command = t.slice(7).trim();
        const pending = continuation.pending;
        if (!pending) { process.stdout.write("No model switch is pending.\n"); repaint(); return; }
        if (command === "brief") {
          process.stdout.write(switchDisposition(pending.target, pending.brief, queue.length, Boolean(switchDraft)));
        } else if (command === "cancel") {
          continuation.cancel();
          if (switchDraft) { buf.insert(switchDraft); switchDraft = ""; }
          process.stdout.write("Model switch cancelled; current session and draft kept.\n");
        } else if (command.startsWith("edit ")) {
          const match = /^edit (goal|constraints|outstanding)\s+([\s\S]*)$/.exec(command);
          if (!match) process.stdout.write("usage: /switch edit goal|constraints|outstanding <text>\n");
          else {
            const revised = continuation.edit(match[1] as "goal" | "constraints" | "outstanding", match[2] ?? "");
            if (revised) process.stdout.write(switchDisposition(revised.target, revised.brief, queue.length, Boolean(switchDraft)));
          }
        } else if (command === "continue" || command === "fresh") {
          if (queue.length) {
            process.stdout.write(`Switch paused: ${queue.length} queued entries remain. Review them with /queue; remove them with /queue remove <id> or /queue clear.\n`);
          } else if (process.env["AETHER_BACKEND"] && (await resolveBackend(ctx)) !== pending.target.destination) {
            process.stdout.write("Switch blocked: AETHER_BACKEND pins a different destination.\n");
          } else {
            const now = await consoleContinuationState(ctx);
            const result = command === "continue" ? continuation.accept(now) : continuation.fresh(now);
            if (!result.ok) process.stdout.write(`Switch blocked: ${result.reason}.\n`);
            else {
              applyModelTarget(ctx, result.target);
              if (switchDraft) { buf.insert(switchDraft); switchDraft = ""; }
              process.stdout.write(command === "continue"
                ? `Continuing with ${result.target.label}; the reviewed brief will be sent with the next turn. Saved draft stays unsent.\n`
                : `Starting fresh with ${result.target.label}; prior task context cleared. Saved draft stays unsent.\n`);
            }
          }
        } else process.stdout.write("usage: /switch continue|fresh|cancel|brief|edit\n");
        repaint();
        return;
      }

      process.stdout.write("\n");
      commit();
      if (!t) {
        repaint();
        return;
      }
      // ── /steer /btw /queue — stateful, stay inline ──
      if (t.startsWith("/steer ") || t === "/steer") {
        const guidance = t.slice(6).trim();
        if (!guidance) { process.stdout.write("usage: /steer <guidance>\n"); repaint(); return; }
        // No turn is running: kept, in order, for the next one (the ack repaints).
        steerChannel.steer(guidance).catch(() => { /* acks are best-effort output */ });
        return;
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
      let capability: RunCapability | undefined;
      if (mode.handled) {
        if (mode.error) { process.stdout.write(mode.error + "\n"); repaint(); return; }
        process.stdout.write(mode.notice + "\n");
        t = mode.prompt!;
        capability = mode.capability;
      }
      busy = true;
      if (t.startsWith("/")) {
        slashAbort = new AbortController();
        runningSlash = `slash command ${sanitizeServerText(t.split(/\s/, 1)[0] ?? "")}`;
        if (t === "/auth" || t.startsWith("/auth ")) {
          const sub = t.slice(5).trim().toLowerCase() || "status";
          try {
            if (sub === "status") process.stdout.write(await authRepair.status());
            else if (sub === "login") process.stdout.write(await authRepair.login(slashAbort.signal, ctx.flags.noBrowser === true));
            else if (sub === "continue") {
              const pending = authRepair.takeContinuation();
              if (pending) {
                process.stdout.write(`Continuing saved task ${pending.turnId} after explicit request.\n`);
                await runAndDrain(queue.allocate({ kind: "chat", text: pending.instruction }), true);
              } else process.stdout.write("No safely rejected task is ready. Use /auth status for details.\n");
            } else if (sub === "new") {
              process.stdout.write(authRepair.startNewConversation());
              discardQueue("new conversation"); steerChannel.clearNextTurn(); btwNotes.length = 0;
            } else if (sub === "draft") {
              if (buf.value) process.stdout.write("Current draft is still in the input line; clear it before restoring the earlier draft.\n");
              else if (!heldDraft) process.stdout.write("No earlier type-ahead draft is saved.\n");
              else buf.insert(heldDraft);
            } else process.stdout.write("usage: /auth [status|login|continue|new|draft]\n");
          } catch (err) {
            if (isAbortError(err)) process.stdout.write("Login cancelled. Task and draft preserved.\n");
            else printError(err, ctx.cfg.baseUrl);
          } finally {
            slashAbort = null; busy = false; runningSlash = null;
          }
          if (!buf.value && heldDraft && sub !== "draft") buf.insert(heldDraft);
          renderHudLine(); repaint();
          return;
        }
        setupOwnsInput = /^\/agent-create\s+ATS(?:\s|$)|^\/(?:mcp|model|models|agent)\s*$/i.test(t);
        if (setupOwnsInput) buf.endRecoveryScope();
        if (setupOwnsInput) process.stdout.write("\x1b[?2004l");
        try {
          const res = await handleSlash(composerCtx, t, process.stdout, slashAbort.signal, {
            ...(skillOpts.explicitSkill ? { explicitSkill: skillOpts.explicitSkill } : {}),
            ...(skillOpts.noSkills ? { noSkills: true } : {}),
          });
          if (res.exit) {
            discardQueue("session ended"); // entries held after a failure are listed, not lost silently
            cleanup();
            resolve(0);
            return;
          }
          if (res.restart) {
            applyRestart(ctx.flags, res.restart);
            process.stdout.write(theme.dim("session restarted — context cleared.\n"));
          }
          if (res.modelSwitch) {
            const target: ModelTarget = { id: res.modelSwitch.model, label: res.modelSwitch.label, contextWindow: res.modelSwitch.contextWindow, destination: isLocalModelId(res.modelSwitch.model) ? "local" : "cloud" };
            const choice = continuation.propose(target, await currentConsoleModel(ctx), await consoleContinuationState(ctx));
            if (choice.status === "same") process.stdout.write("Already using this model; session unchanged.\n");
            else {
              switchDraft = buf.value;
              if (switchDraft) buf.clear();
              if (choice.status === "drift") process.stdout.write(`Continuation blocked: ${choice.reason}. Fresh start remains available.\n`);
              process.stdout.write(switchDisposition(target, choice.proposal!.brief, queue.length, Boolean(switchDraft)));
            }
          }
        } catch (err) {
          if (isAbortError(err)) {
            process.stdout.write(theme.dim("✗ canceled") + "\n");
            discardQueue("command cancelled");
          } else {
            printError(err, ctx.cfg.baseUrl);
          }
        } finally {
          if (setupOwnsInput) process.stdout.write("\x1b[?2004h");
          setupOwnsInput = false;
          busy = false;
          slashAbort = null;
          runningSlash = null;
        }
        const next = continuation.pending ? undefined : queue.shift();
        if (next) { busy = true; await runAndDrain(next); }
        renderHudLine();
        repaint();
        return;
      }
      await runAndDrain(queue.allocate({ kind: "chat", text: t, ...(capability ? { capability } : {}) }));
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

    // Input-owner precedence: PTY/approval/setup are gated in onData; paste
    // owns literal bytes. Idle search owns query/Enter/Escape before the slash
    // picker, which in turn owns selection keys before viewer/history. Both
    // overlays only edit the composer; a later Enter submits a draft.
    const dismissPicker = (restore: boolean): void => {
      if (!picker) return;
      if (restore) buf.restoreDraft(picker.priorValue, picker.priorCursor);
      picker = null;
      repaint();
    };
    const refreshPicker = (): void => {
      if (picker) picker = refreshSlashPicker(picker, buf.value);
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
      const k = decodeKey(seq, ctx.cfg.lfSubmits);
      if (k.kind === "history-search") {
        if (busy || viewerOpen || (process.stdout.rows ?? 24) < 2) return;
        if (historySearch) historySearch = olderHistoryMatch(historySearch);
        else {
          searchPriorPicker = picker;
          picker = null;
          buf.endRecoveryScope();
          const enabled = historyEnabled();
          historySearch = openHistorySearch(enabled ? buf.historyEntries() : [], buf.value, buf.pos, !enabled);
        }
        repaint();
        return;
      }
      if (historySearch) {
        switch (k.kind) {
          case "char": historySearch = typeHistoryQuery(historySearch, k.value); repaint(); return;
          case "backspace": historySearch = backspaceHistoryQuery(historySearch); repaint(); return;
          case "submit": {
            const match = selectedHistoryMatch(historySearch);
            if (match === null) { repaint(); return; }
            historySearch = null;
            searchPriorPicker = null;
            picker = null;
            buf.replace(match);
            repaint();
            return;
          }
          case "escape":
            buf.restoreDraft(historySearch.priorValue, historySearch.priorCursor);
            historySearch = null;
            picker = searchPriorPicker;
            searchPriorPicker = null;
            repaint();
            return;
          case "paste-start":
            buf.restoreDraft(historySearch.priorValue, historySearch.priorCursor);
            historySearch = null;
            searchPriorPicker = null;
            break; // paste is owned by the composer below
          case "clear-screen":
            process.stdout.write("\x1b[2J\x1b[H"); repaint(); return;
          default: return;
        }
      }
      switch (k.kind) {
        case "paste-start":
          picker = null;
          pickerSuppressed = true;
          pasting = true;
          pasteAcc = "";
          return;
        case "char": {
          const before = buf.value;
          const beforeCursor = buf.pos;
          buf.insert(k.value);
          if (picker) refreshPicker();
          else {
            if (!busy && !viewerOpen && !pickerSuppressed && (process.stdout.rows ?? 24) >= 3
                && before === "" && k.value.startsWith("/") && !/\s/.test(k.value) && slashDraft(buf.value)) {
              picker = openSlashPicker(buf.value, before, beforeCursor);
            }
            repaint();
          }
          return;
        }
        case "newline":
          if (viewerOpen) return;
          picker = null;
          buf.insertNewline();
          repaint();
          return;
        case "undo":
          if (viewerOpen) return;
          buf.undo();
          refreshPicker();
          return;
        case "yank":
          if (viewerOpen) return;
          buf.yank();
          refreshPicker();
          return;
        case "backspace":
          buf.backspace();
          refreshPicker();
          return;
        case "delete":
          buf.deleteForward();
          refreshPicker();
          return;
        case "word-delete":
          buf.deleteWord();
          refreshPicker();
          return;
        case "kill-end":
          buf.killToEnd();
          refreshPicker();
          return;
        case "kill-start":
          buf.killToStart();
          refreshPicker();
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
          // Slash discovery never submits or mutates a reviewed shell item.
          if (busy) return;
          if (picker) picker = moveSlashPicker(picker, buf.value, 1);
          else if (!viewerOpen && !pickerSuppressed && (process.stdout.rows ?? 24) >= 3 && slashDraft(buf.value)) {
            picker = openSlashPicker(buf.value, buf.value, buf.pos);
          }
          repaint();
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
          if (picker) { picker = moveSlashPicker(picker, buf.value, -1); repaint(); }
          else if (viewerOpen) {
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
          if (picker) { picker = moveSlashPicker(picker, buf.value, 1); repaint(); }
          else if (viewerState.visible && !viewerOpen) {
            viewerOpen = true;
            buf.endRecoveryScope();
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
          if (picker) {
            const accepted = acceptSlashPicker(picker, buf.value, buf.pos);
            picker = null;
            if (accepted) buf.replace(accepted.value, accepted.cursor);
            repaint();
            return;
          }
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
          if (picker) { dismissPicker(true); return; }
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
      if (terminalOwnsInput || approvalOwnsInput) return;
      if (setupOwnsInput) { if (chunk.includes(3)) slashAbort?.abort(); return; }
      let data = carry + decoder.write(chunk);
      carry = "";
      const partial = PARTIAL_ESC_RE.exec(data);
      if (partial && partial[0].length > 0 && partial.index + partial[0].length === data.length) {
        carry = partial[0];
        data = data.slice(0, partial.index);
      }
      for (const seq of splitKeys(data)) {
        if (setupOwnsInput || terminalOwnsInput || approvalOwnsInput) break;
        processSeq(seq);
      }
    };
    process.stdin.on("data", onData);
    process.stdout.on("resize", onResize);
  });
}

const LINE_MODE_QUEUE_NOTE = "Line mode has no pending queue: each input line runs in order after the previous one finishes, so there is nothing to list, edit, remove, clear, or resume. /queue <task> runs the task as the next line.\n";

/** Non-TTY fallback (pipes / CI): a line-oriented readline loop — no raw-mode
 *  key decoding since there's no real terminal to own. `inflight` still wires
 *  Ctrl+C to cancel the current turn/slash-command rather than killing the
 *  whole process (a bare non-TTY session, e.g. `ssh host aether`, still gets
 *  SIGINT delivered normally since readline isn't in terminal mode here). */
export async function replLines(ctx: AppContext, skillOpts: TurnSkillOptions = {}, consoleShell = new ConsoleShell(ctx.flags.cwd, text => { process.stdout.write(text); }, ctx.flags.json), inputStream: NodeJS.ReadableStream = process.stdin, authRepair = new ConsoleAuthRepair(ctx), suppliedContinuation?: ConsoleTaskContinuation): Promise<number> {
  skillOpts = { ...skillOpts, exec: consoleShell.exec };
  const continuation = suppliedContinuation ?? new ConsoleTaskContinuation(await consoleContinuationState(ctx));
  const rl = createInterface({ input: inputStream });
  const p = ctx.flags.json ? "" : promptPrefix(userInfo().username || "you");
  let inflight: AbortController | null = null;
  const onSigint = (): void => inflight?.abort();
  process.on("SIGINT", onSigint);
  try {
    if (p) process.stdout.write(p + consoleShell.prompt());
    for await (const rawLine of rl) {
    // Line mode reads the next line only after the previous one finished, so
    // there is never a pending queue: `/queue <task>` simply runs in order.
    if (parseQueueCommand(rawLine)) {
      process.stdout.write(LINE_MODE_QUEUE_NOTE);
      if (p) process.stdout.write(p + consoleShell.prompt());
      continue;
    }
    const queuePrefix = /^\s*\/queue[ \t]+/.exec(rawLine);
    const line = queuePrefix ? rawLine.slice(queuePrefix[0].length) : rawLine;
    if (parseOneTurnSkill(line)) {
      process.stdout.write("/skill requires the idle interactive composer; line input is unchanged.\n");
      if (p) process.stdout.write(p + consoleShell.prompt());
      continue;
    }
    if (continuation.pending && !line.trim().startsWith("/switch")) {
      process.stdout.write("Choose /switch continue, fresh, cancel, brief, or edit first; input was not sent.\n");
      if (p) process.stdout.write(p + consoleShell.prompt());
      continue;
    }
    if (ConsoleShell.isTerminalCommand(line)) { await consoleShell.terminalCommand(line); continue; }
    let input = classifyConsoleInput(line);
    const sharedShellResult = input.kind === "share";
    if (input.kind === "share") input = consoleShell.share(input, true);
    if (input.kind === "error") { process.stdout.write(input.message + "\n"); if (p) process.stdout.write(p + consoleShell.prompt()); continue; }
    if (input.kind === "profile") {
      if (consoleShell.profileCommand(input)) skillOpts = { ...skillOpts, exec: consoleShell.exec };
      if (p) process.stdout.write(p + consoleShell.prompt());
      continue;
    }
    let t = input.kind === "chat" ? input.text : "";
    let authReplay = false;
    if (continuation.pending && !t.startsWith("/switch")) {
      process.stdout.write("Choose /switch continue, fresh, cancel, brief, or edit first; input was not sent.\n");
      if (p) process.stdout.write(p + consoleShell.prompt());
      continue;
    }
    if (t.startsWith("/switch")) {
      const pending = continuation.pending;
      const command = t.slice(7).trim();
      if (!pending) process.stdout.write("No model switch is pending.\n");
      else if (command === "brief") process.stdout.write(switchDisposition(pending.target, pending.brief, 0));
      else if (command === "cancel") { continuation.cancel(); process.stdout.write("Model switch cancelled.\n"); }
      else if (command.startsWith("edit ")) {
        const match = /^edit (goal|constraints|outstanding)\s+([\s\S]*)$/.exec(command);
        const revised = match ? continuation.edit(match[1] as "goal" | "constraints" | "outstanding", match[2] ?? "") : null;
        process.stdout.write(revised ? switchDisposition(revised.target, revised.brief, 0) : "usage: /switch edit goal|constraints|outstanding <text>\n");
      } else if (command === "continue" || command === "fresh") {
        if (process.env["AETHER_BACKEND"] && (await resolveBackend(ctx)) !== pending.target.destination) {
          process.stdout.write("Switch blocked: AETHER_BACKEND pins a different destination.\n");
        } else {
          const now = await consoleContinuationState(ctx);
          const result = command === "continue" ? continuation.accept(now) : continuation.fresh(now);
          if (!result.ok) process.stdout.write(`Switch blocked: ${result.reason}.\n`);
          else {
            applyModelTarget(ctx, result.target);
            process.stdout.write(command === "continue"
              ? `Continuing with ${result.target.label}; reviewed brief queued for the next turn.\n`
              : `Starting fresh with ${result.target.label}.\n`);
          }
        }
      } else process.stdout.write("usage: /switch continue|fresh|cancel|brief|edit\n");
      if (p) process.stdout.write(p + consoleShell.prompt());
      continue;
    }
    if (input.kind === "shell" || input.kind === "reset-shell") {
      inflight = new AbortController();
      try { await consoleShell.run(input, inflight.signal); }
      finally { inflight = null; }
      if (p) process.stdout.write(p + consoleShell.prompt());
      continue;
    }
    if (!t) {
      if (p) process.stdout.write(p + consoleShell.prompt());
      continue;
    }
    if (historyEnabled() && !sharedShellResult) appendHistory(line.trim(), historyPath(ctx.flags.cwd));
    if (t === "/auth" || t.startsWith("/auth ")) {
      inflight = new AbortController();
      try {
        const sub = t.slice(5).trim().toLowerCase() || "status";
        if (sub === "status") process.stdout.write(await authRepair.status());
        else if (sub === "login") process.stdout.write(await authRepair.login(inflight.signal, ctx.flags.noBrowser === true));
        else if (sub === "new") process.stdout.write(authRepair.startNewConversation());
        else if (sub === "draft") process.stdout.write("No type-ahead draft is held in line mode.\n");
        else if (sub === "continue") {
          const pending = authRepair.takeContinuation();
          if (pending) { t = pending.instruction; authReplay = true; }
          else process.stdout.write("No safely rejected task is ready. Use /auth status for details.\n");
        } else process.stdout.write("usage: /auth [status|login|continue|new|draft]\n");
      } finally { inflight = null; }
      if (t.startsWith("/")) { if (p) process.stdout.write(p + consoleShell.prompt()); continue; }
    }
    if (t.startsWith("/")) {
      inflight = new AbortController();
      try {
        const res = await handleSlash(ctx, t, process.stdout, inflight.signal, {
          ...(skillOpts.explicitSkill ? { explicitSkill: skillOpts.explicitSkill } : {}),
          ...(skillOpts.noSkills ? { noSkills: true } : {}),
        });
        if (res.exit) break;
        if (res.restart) {
          applyRestart(ctx.flags, res.restart);
          process.stdout.write(theme.dim("session restarted — context cleared.\n\n"));
        }
        if (res.modelSwitch) {
          const target: ModelTarget = { id: res.modelSwitch.model, label: res.modelSwitch.label, contextWindow: res.modelSwitch.contextWindow, destination: isLocalModelId(res.modelSwitch.model) ? "local" : "cloud" };
          const choice = continuation.propose(target, await currentConsoleModel(ctx), await consoleContinuationState(ctx));
          if (choice.status === "same") process.stdout.write("Already using this model; session unchanged.\n");
          else {
            if (choice.status === "drift") process.stdout.write(`Continuation blocked: ${choice.reason}. Fresh start remains available.\n`);
            process.stdout.write(switchDisposition(target, choice.proposal!.brief, 0));
          }
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
      if (p) process.stdout.write(p + consoleShell.prompt());
      continue;
    }
    inflight = new AbortController();
    let printed = false; // printError already ends with a blank line
    const receipts: string[] = [];
    const beforeChanges = observedWorkspaceChanges(ctx.flags.cwd);
    const toolResults: ObservedTool[] = [];
    let submittedPrompt = t;
    try {
      if (await resolveBackend(ctx) === "cloud") {
        if (authRepair.submissionBlocked) {
          process.stdout.write("Account changed or could not be verified. Use /auth new before sending another hosted task.\n");
          if (p) process.stdout.write(p + consoleShell.prompt());
          continue;
        }
        await authRepair.captureAccount();
      }
      const nextPrompt = continuation.promptForNextTurn(t, continuation.hasAcceptedBrief ? await consoleContinuationState(ctx) : undefined);
      submittedPrompt = nextPrompt;
      if (await resolveBackend(ctx) === "cloud") authRepair.markHostedTurnStarted();
      const outcome = await runTurn(ctx, nextPrompt, inflight.signal, (frame) => {
        if (receipts.length < 64) {
          if (frame.type === "tool_call") receipts.push(sanitizeServerText(`tool call ${frame.toolCallId} (${frame.name})`));
          if (frame.type === "tool_result_ack") receipts.push(sanitizeServerText(`tool result ${frame.toolCallId}`));
        }
      }, undefined, { ...skillOpts, ephemeralAttachment: sharedShellResult, onToolResult: tool => toolResults.push(tool) });
      const afterChanges = observedWorkspaceChanges(ctx.flags.cwd);
      continuation.recordTurn(t, toolResults, afterChanges.filter(change => !beforeChanges.includes(change)), outcome.state, !sharedShellResult && !authReplay);
      if (ctx.flags.json) process.stdout.write(turnOutcomeJson(outcome) + "\n");
    } catch (err) {
      const afterChanges = observedWorkspaceChanges(ctx.flags.cwd);
      continuation.recordTurn(t, toolResults, afterChanges.filter(change => !beforeChanges.includes(change)), "failed", !sharedShellResult && !authReplay);
      if (isAbortError(err)) {
        const outcome = turnOutcomeForError(err);
        if (ctx.flags.json && outcome) process.stdout.write(turnOutcomeJson(outcome) + "\n");
        else process.stderr.write("\n" + errTheme.dim("✗ canceled — turn discarded") + "\n");
      } else if (!sharedShellResult && await resolveBackend(ctx) === "cloud" && authRepair.noteFailure(err, submittedPrompt, turnOutcomeForError(err), receipts)) {
        if (!ctx.flags.json) process.stderr.write("✗ Hosted credential rejected (401). Task saved. Use /auth login; /auth status shows the credential source.\n");
        printed = true;
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
    if (p) process.stdout.write((printed ? "" : "\n") + p + consoleShell.prompt());
    }
    return 0;
  } finally {
    consoleShell.close();
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
