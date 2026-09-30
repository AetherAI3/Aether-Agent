// `aether agent [--local] "<task>"` — the hybrid coding terminal. One host loop
// drives a pluggable brain: cloud (Aether API, UVT-metered) by default, or the
// local Python/Ollama brain with --local. Same host, same render, same tools,
// same commands — only the brain transport differs (specs/aethercode_bridge.md).
//
// The loop is the seam: the brain decides (emits events); the host renders every
// event and executes every tool_call locally, then replies. That is why local
// and cloud are indistinguishable UX.

import type { AppContext } from "../core/context.js";
import { completeMemory, pinMemory } from "../core/project_memory/run.js";
import type { Brain, TaskCommand } from "../core/brain.js";
import type { BrainEvent } from "../core/brain_protocol.js";
import type { RunOptions, ToolResult } from "../core/tool_executor.js";
import { LocalBrain } from "../core/brain_local.js";
import { OllamaBrain } from "../core/brain_ollama.js";
import { resolveHostedModel, resolveLocalModelSelection } from "../core/local_ollama.js";
import { CloudBrain } from "../core/brain_cloud.js";
import { ToolExecutor } from "../core/tool_executor.js";
import { stdioPrompt } from "../ui/interact.js";
import { defaultRunner, type Runner } from "../core/worktree.js";
import { isCurrentWorkspace } from "../core/workspace_scope.js";
import { HostRenderer, routingDriftLines } from "../ui/host_render.js";
import { SessionLog } from "../core/session_log.js";
import { finalVerify, type BrainDone, type VerifyOutcome } from "../core/verify_gate.js";
import { StatusRenderer } from "../ui/status_renderer.js";
import { AnimationController } from "../ui/animations.js";
import { HeartbeatIndicator } from "../ui/heartbeat.js";
import { LocalAgentSource, bindEventSource } from "../core/agent_events.js";
import { phaseVerb } from "../ui/phase_verb.js";
import { TaskLedger } from "../ui/ledger.js";
import {
  CODE_STAGES,
  answerAgentQuestionIfPresent,
  applyToLedger,
  prepareWorkspace,
  runSummary,
  stageGate,
  writeDiffLines,
} from "./code_support.js";
import { continuationTask, resolveResume, resumeReplayLines, wroteFile, type ResolvedResume } from "../core/handoff.js";
import { resumeHint } from "./resume.js";
import { createWorktree, mergeHint, type Worktree } from "../core/worktree.js";
import { parseRepoSpec, ensureLocalClone, type RepoSpec } from "../core/repo.js";
import { chooseBackend, chooseLocalBrain } from "../core/backend.js";
import { ModelTextProgress } from "../core/model_text_progress.js";
import { ModelOutputBudget } from "../core/model_output_budget.js";
import { decideGate } from "../core/autonomy.js";
import { openRunSession, refusalToolResult } from "../core/skills/run_session.js";
import type { SessionContext } from "../core/session_resume.js";
import type { SkillSessionProvenance } from "../core/skills/skill_session.js";
import type { SkillRefusal } from "../core/skills/skill_errors.js";
import {
  TurnLifecycle,
  type TurnLifecycleOptions,
  type TurnOutcome,
} from "../core/turn_lifecycle.js";
import {
  MeaningfulProgressTimeoutError,
  ModelOutputLimitError,
  StreamTimeoutError,
  TurnDeadlineError,
  errorMessage,
  isAbortError,
} from "../core/errors.js";
import { sanitizeServerText } from "../core/transport.js";
import { turnOutcomeJson } from "./chat.js";

export { prepareWorkspace } from "./code_support.js";

/**
 * Exit code 3 — ROUTING REFUSED.
 *
 * The run asked for a transport with LOCAL authority and the server would not
 * give it (agent dev sessions disabled / route absent), so the host refused to
 * continue on a transport that executes tools somewhere else.
 *
 * Distinct from the existing table (COMMANDS.md "Exit codes"): 0 success, 1
 * runtime error, 2 usage error — and 130/143 are the signal conventions the UI
 * already uses. A refusal is neither a crash nor a mistyped argument: a script
 * that sees 3 knows nothing ran and that retrying without an operator change
 * will produce the same answer.
 */
export const EXIT_ROUTING_REFUSED = 3;

/**
 * A coding brain may keep its transport alive indefinitely with duplicate
 * status/telemetry frames. This deadline is about useful progress, not socket
 * traffic. It intentionally matches the terminal event adapter's hard bound.
 */
export const DEFAULT_CODE_MEANINGFUL_PROGRESS_TIMEOUT_MS = 120_000;
export const CODE_MEANINGFUL_PROGRESS_TIMEOUT_ENV = "AETHER_AGENT_PROGRESS_TIMEOUT_MS";
export const DEFAULT_CODE_MODEL_SEGMENT_TIMEOUT_MS = 30 * 60_000;
export const CODE_MODEL_SEGMENT_TIMEOUT_ENV = "AETHER_AGENT_SEGMENT_TIMEOUT_MS";

/** Bound one model segment even if it emits endlessly novel text. */
export function codeModelSegmentTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const parsed = Number(env[CODE_MODEL_SEGMENT_TIMEOUT_ENV]);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.trunc(parsed))
    : DEFAULT_CODE_MODEL_SEGMENT_TIMEOUT_MS;
}

/** Parse the coding-turn progress deadline without allowing a malformed or
 * negative environment value to disable the production bound accidentally.
 * An explicit 0 remains available to embedders/tests through HostLoopOptions,
 * but the CLI itself always has a finite default. */
export function codeMeaningfulProgressTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[CODE_MEANINGFUL_PROGRESS_TIMEOUT_ENV]?.trim();
  if (!raw) return DEFAULT_CODE_MEANINGFUL_PROGRESS_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.trunc(parsed))
    : DEFAULT_CODE_MEANINGFUL_PROGRESS_TIMEOUT_MS;
}

/** Approve (or refuse) one brain-emitted tool call before the host executes it. */
export type ToolGate = (call: { name: string; args: Record<string, unknown> }) => Promise<boolean>;

export interface CodeOpts {
  /** Use the local Python/Ollama brain instead of the cloud API. */
  local: boolean;
  /** Pool size in GB (sets the status-bar denominator: pool x 233M). */
  pool: number;
  /** Effort tier (LOW..CODEPRO) — passed to the brain as a budget ceiling. */
  effort?: string;
  /** Command the grounding gate runs (default pytest -q, host-executed). */
  testCmd?: string;
  /** Strip the personality frames to plain lines. */
  quiet: boolean;
  /** Auto-pause at each stage boundary to accept a /steer (TTY only). */
  interactive?: boolean;
  /** Disable the local session log. */
  noLog?: boolean;
  /** Number of swarm workers (gated — see the swarm guard below). */
  swarm?: number;
  /** Continue a prior session: a local session id, or the path to a handoff
   *  file exported from another machine. The prior context is summarized into
   *  the brief the brain reads (core/handoff.ts), not just replayed on screen. */
  resume?: string;
  /** Isolate the run in a fresh git worktree on an auto-named branch. */
  worktree?: boolean;
  /** Work on a GitHub repo (owner/name): clone via gh/git, then worktree it. */
  repo?: string;
  /** `--skill <id>`: load this skill explicitly (id, short name, or command alias). */
  skill?: string;
  /** `--no-skills`: load no skill. The project's own AGENTS.md still applies. */
  noSkills?: boolean;
}

const nowIso = (): string => new Date().toISOString();

/** Resolve the hosted model once for both the wire command and durable provenance. */
export function resolveHostedSessionModel(explicit: string | undefined, configured: string): string {
  return resolveHostedModel(explicit, configured);
}

/** Map a BrainEvent onto the pinned status line (verb + streamed tokens).
 * Exported so the wiring is unit-testable without a real brain. */
export function applyEventToStatus(
  sr: { setVerb(v: string, k: string): void; setStreamed(n: number): void },
  ev: BrainEvent,
  tick: number,
): void {
  if (ev.type === "stage") {
    const v = phaseVerb(ev.name, tick);
    sr.setVerb(v.verb, v.kao);
  } else if (ev.type === "telemetry") {
    sr.setStreamed(ev.tokens);
  }
}

/** Bounded de-duplication for the coding host's progress deadline. */
class CodeProgressTracker {
  private readonly seen = new Set<string>();
  private readonly modelText = new ModelTextProgress();
  private static readonly MAX_KEYS = 256;
  private static readonly MAX_KEY_LENGTH = 512;

  meaningful(ev: BrainEvent): boolean {
    switch (ev.type) {
      case "done":
      case "error":
        return false;
      case "stage": {
        const next = sanitizeServerText(ev.name).trim();
        return next.length > 0 && this.once(`stage:${next}`);
      }
      case "monologue":
        return this.modelText.meaningful(ev.text);
      case "skill":
        return this.once(`skill:${ev.name}:${ev.reason}`);
      case "turn": {
        const next = `${ev.n}:${ev.toolCalls}:${ev.malformed}:${ev.invented}:${ev.noCall}:${ev.failCount ?? ""}`;
        return this.once(`turn:${next}`);
      }
      case "tool_call":
        return this.once(`tool:${ev.id}`);
      case "telemetry":
        return false; // tokens can rise while the answer repeats
      case "status": {
        // Pool/cap oscillation is presentation telemetry. Only a previously
        // unseen, non-empty phase can establish semantic progress.
        const phase = sanitizeServerText(ev.phase).trim();
        return phase.length > 0 && this.once(`status:${phase}`);
      }
      case "checkpoint":
        return this.once(`checkpoint:${ev.gitSha}`);
      case "memory":
        return this.once(
          `memory:${ev.subtype}:${ev.text ?? ""}:${ev.narrative ?? ""}:${ev.factCount ?? ""}:${ev.afterTokens ?? ""}`,
        );
      case "workflow_start":
        return this.once(`workflow:${ev.workflowId}`);
      case "phase_start":
        return this.once(`phase-start:${ev.phaseN}:${ev.phaseType}`);
      case "phase_done":
        return this.once(`phase-done:${ev.phaseN}:${ev.artifactSummary}`);
      case "agent_spawn":
        return this.once(`agent-spawn:${ev.agentId}:${ev.phaseN}`);
      case "agent_progress":
        return this.nonEmptyOnce(`agent-progress:${ev.agentId}:`, ev.delta);
      case "agent_done":
        return this.once(`agent-done:${ev.agentId}:${ev.phaseN}`);
      case "workflow_done":
        return this.once(`workflow-done:${ev.totalPhases}:${ev.totalAgents}`);
      case "routing_drift":
        return this.once(`routing-drift:${ev.requested}:${ev.resolved}:${ev.status}:${ev.fatal}`);
    }
  }

  private once(key: string): boolean {
    const bounded = key.length <= CodeProgressTracker.MAX_KEY_LENGTH
      ? key
      : key.slice(0, CodeProgressTracker.MAX_KEY_LENGTH);
    if (this.seen.has(bounded) || this.seen.size >= CodeProgressTracker.MAX_KEYS) return false;
    this.seen.add(bounded);
    return true;
  }

  private nonEmptyOnce(prefix: string, value: string): boolean {
    const text = sanitizeServerText(value).trim();
    return text.length > 0 && this.once(prefix + text);
  }
}

export interface CodeTurnObservation {
  /** False after the first brain terminal frame; late frames are ignored. */
  accepted: boolean;
  meaningful: boolean;
}

/**
 * The production `aether agent` lifecycle adapter. A brain terminal frame is
 * deliberately only advisory: this object cannot enter `succeeded` until the
 * host verification result is supplied to settle().
 */
export class CodeTurnLifecycle {
  readonly lifecycle: TurnLifecycle;

  private readonly progress = new CodeProgressTracker();
  private terminalFrameSeen = false;
  private eofBeforeTerminal = false;
  private thrown: unknown = null;
  private partialOutput = false;
  private brainError = "";
  private done: BrainDone | null = null;
  private fatal: Extract<BrainEvent, { type: "routing_drift" }> | null = null;

  constructor(prompt: string, opts: TurnLifecycleOptions = {}) {
    this.lifecycle = new TurnLifecycle(prompt, opts);
    this.lifecycle.transition("submitted");
    this.lifecycle.transition("connecting");
  }

  get turnId(): string {
    return this.lifecycle.id;
  }

  get outcome(): TurnOutcome | null {
    return this.lifecycle.outcome;
  }

  get lastDone(): BrainDone | null {
    return this.done ? { ...this.done } : null;
  }

  get sawError(): boolean {
    return this.brainError.length > 0;
  }

  get fatalDrift(): Extract<BrainEvent, { type: "routing_drift" }> | null {
    return this.fatal ? { ...this.fatal } : null;
  }

  get hasTerminalFrame(): boolean {
    return this.terminalFrameSeen;
  }

  observe(ev: BrainEvent): CodeTurnObservation {
    if (this.terminalFrameSeen || this.lifecycle.outcome) {
      return { accepted: false, meaningful: false };
    }

    const meaningful = this.progress.meaningful(ev);
    if (meaningful && ev.type !== "status" && ev.type !== "telemetry" && ev.type !== "turn") {
      this.partialOutput = true;
    }

    if (ev.type === "done") {
      this.done = { ok: ev.ok, remaining: ev.remaining, reason: sanitizeServerText(ev.reason) };
      this.terminalFrameSeen = true;
      this.toCompleting();
      return { accepted: true, meaningful: false };
    }
    if (ev.type === "error") {
      this.brainError = sanitizeServerText(ev.msg).trim() || "the coding brain reported an error";
      this.terminalFrameSeen = true;
      this.toCompleting();
      return { accepted: true, meaningful: false };
    }
    if (ev.type === "routing_drift" && ev.fatal) {
      this.fatal = ev;
      this.terminalFrameSeen = true;
      this.toCompleting();
      return { accepted: true, meaningful };
    }

    if (meaningful) this.noteActive(ev.type === "tool_call");
    return { accepted: true, meaningful };
  }

  /** Called only after hostLoop reaches iterator EOF without done/error. */
  noteIncompleteEof(): void {
    if (this.terminalFrameSeen || this.lifecycle.outcome) return;
    this.eofBeforeTerminal = true;
    this.terminalFrameSeen = true;
    this.toCompleting();
  }

  noteThrown(error: unknown): void {
    if (this.lifecycle.outcome) return;
    this.thrown = error;
    this.terminalFrameSeen = true;
    this.toCompleting();
  }

  /** Exactly-once terminal reduction. Repeated cleanup paths receive the first
   * immutable outcome rather than attempting a second finalization. */
  settle(verification: VerifyOutcome | null): TurnOutcome {
    const settled = this.lifecycle.outcome;
    if (settled) return settled;
    this.toCompleting();

    if (this.thrown instanceof StreamTimeoutError) {
      return this.lifecycle.finalize("timed_out", {
        message: sanitizeServerText(this.thrown.message),
        hint: "retry the prompt or run `aether doctor` to inspect connectivity",
        retryable: true,
        partialOutput: this.partialOutput,
      });
    }
    if (isAbortError(this.thrown)) {
      return this.lifecycle.finalize("cancelled", {
        message: "coding turn cancelled",
        retryable: true,
        partialOutput: this.partialOutput,
      });
    }
    if (this.fatal) {
      return this.lifecycle.finalize("failed", {
        message: "coding transport was refused before local execution",
        hint: sanitizeServerText(this.fatal.remediation),
        partialOutput: this.partialOutput,
      });
    }
    if (this.thrown !== null) {
      return this.lifecycle.finalize("failed", {
        message: "coding turn failed before final verification",
        retryable: false,
        partialOutput: this.partialOutput,
      });
    }
    if (this.eofBeforeTerminal) {
      return this.lifecycle.finalize("incomplete", {
        message: "connection ended before the coding brain delivered a terminal frame",
        hint: "the prompt is safe to retry; run `aether doctor` to inspect connectivity",
        retryable: true,
        partialOutput: this.partialOutput,
      });
    }
    if (this.brainError) {
      return this.lifecycle.finalize("failed", {
        message: this.brainError,
        partialOutput: this.partialOutput,
      });
    }
    if (!verification) {
      return this.lifecycle.finalize("failed", {
        message: "host final verification did not complete",
        partialOutput: this.partialOutput,
      });
    }
    if (verification.status === "ok") {
      return this.lifecycle.finalize("succeeded", {
        message: "host verification passed",
        partialOutput: this.partialOutput,
      });
    }
    if (verification.status === "unverified") {
      return this.lifecycle.finalize("incomplete", {
        message: "coding turn completed without host verification",
        hint: "re-run with --test-cmd so the host can establish a green result",
        retryable: false,
        partialOutput: this.partialOutput,
      });
    }
    if (verification.status === "error" || verification.status === "failed") {
      return this.lifecycle.finalize("failed", {
        message: "coding turn or host verification failed",
        partialOutput: this.partialOutput,
      });
    }
    const count = verification.remaining > 0 ? ` (${verification.remaining} remaining)` : "";
    return this.lifecycle.finalize("incomplete", {
      message: `host verification did not pass${count}`,
      partialOutput: this.partialOutput,
    });
  }

  private noteActive(waitingForTool: boolean): void {
    if (this.lifecycle.state === "connecting") {
      this.lifecycle.transition(waitingForTool ? "waiting_for_tool" : "streaming");
    } else if (this.lifecycle.state === "streaming" && waitingForTool) {
      this.lifecycle.transition("waiting_for_tool");
    } else if (this.lifecycle.state === "waiting_for_tool" && !waitingForTool) {
      this.lifecycle.transition("streaming");
    } else if (this.lifecycle.state === "streaming" || this.lifecycle.state === "waiting_for_tool") {
      this.lifecycle.meaningfulActivity();
    }
  }

  private toCompleting(): void {
    if (
      this.lifecycle.state === "connecting" ||
      this.lifecycle.state === "streaming" ||
      this.lifecycle.state === "waiting_for_tool"
    ) {
      this.lifecycle.transition("completing");
    }
  }
}

/** Append the shared headless terminal record exactly once at the command edge. */
export function emitCodeTurnOutcome(
  outcome: TurnOutcome,
  json: boolean,
  write: (line: string) => unknown = (line) => process.stdout.write(line),
): void {
  if (json) write(turnOutcomeJson(outcome) + "\n");
}

export async function cmdCode(
  ctx: AppContext,
  task: string,
  opts: CodeOpts,
  workspaceRun: Runner = defaultRunner(),
): Promise<number> {
  // --resume carries the prior session's context forward, so it is also a task
  // of its own: with no new instruction the run continues the ORIGINAL task.
  // Resolved ONCE — the handoff the brain reads and the lines the human sees
  // come from the same read, so a session log is never parsed twice and the
  // file-vs-id decision is made in exactly one place.
  let resumed: ResolvedResume | null = null;
  if (opts.resume) {
    try {
      resumed = resolveResume(opts.resume, ctx.flags.cwd);
    } catch (err) {
      process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  const handoff = resumed?.handoff ?? null;
  const replay = (emit: (line: string) => void): void => {
    if (!resumed || !opts.resume) return;
    for (const line of resumeReplayLines(resumed, opts.resume)) emit(line);
  };
  if (!task.trim() && !handoff) {
    process.stderr.write('✗ nothing to do — try: aether agent "fix the failing tests"\n');
    return 1;
  }
  // What the run is CALLED (worktree branch, session manifest, summary) stays
  // the human-sized instruction; the brief below is what the brain reads.
  const label = task.trim() || handoff!.task;
  // Swarm is GATED on purpose: never swarm an unproven loop — N agents multiply
  // the #1 failure (tool-call emission fraying). It is also LOCAL-ONLY (the cloud
  // path has its own orchestration). Stays gated until the single-agent loop is
  // proven on real long sessions.
  if ((opts.swarm ?? 1) > 1) {
    process.stderr.write(
      "✗ --swarm is not enabled yet.\n" +
        "  N-agent swarms multiply the #1 risk (tool-call emission fraying), so the\n" +
        "  single-agent loop is proven first. Swarm will also be local-only (--local).\n",
    );
    return 2;
  }
  // One interaction channel for the whole run: the repo gate, friendly stage
  // pauses, and agent questions all speak through it (stderr-backed, so piped
  // stdout stays clean; auto-answers in non-TTY / --yes).
  const io = stdioPrompt();

  // Two ways to land in an isolated worktree, kept as ONE sequence (not two
  // parallel systems) so a run never tries to cut a worktree twice:
  //
  //  - explicit (--repo / --worktree): the user opted in by hand, so honor it
  //    exactly — --repo clones the GitHub repo first (their own gh/git auth,
  //    never a backend token) and implies --worktree so the run lands on an
  //    isolated branch ready for a PR.
  //  - implicit (the 2.0 repo gate): with no explicit flag, confirm "are you
  //    working in this repo?" before any brain touches the tree; when `gh` is
  //    authenticated it auto-upgrades to the same kind of isolated worktree.
  //    A non-TTY run without --yes proceeds in place with zero prompts/side
  //    effects, so pipes, CI, and tests never hang.
  let repoSpec: RepoSpec | null = null;
  // The exact revision a --repo worktree must start from. Null for a plain
  // --worktree run, where the user's own checkout is the intended base.
  let repoBase: string | null = null;
  let worktree: Worktree | null = null;
  let cwd: string;
  if (opts.repo || opts.worktree) {
    let repoRoot = ctx.flags.cwd;
    if (opts.repo) {
      try {
        repoSpec = parseRepoSpec(opts.repo);
        const co = ensureLocalClone(repoSpec);
        repoRoot = co.dir;
        // Say what actually happened to the mirror. "reusing local clone" was
        // equally true of a mirror last fetched a week ago, which is exactly the
        // case a user needs told rather than hidden behind a reassuring word.
        const tip = co.freshness.remoteTip ? ` @ ${co.freshness.remoteTip.slice(0, 7)}` : "";
        const how = co.cloned
          ? "(cloned)"
          : co.freshness.state === "fresh"
            ? "(fetched)"
            : `(NOT REFRESHED — ${co.freshness.reason ?? "reason unknown"})`;
        process.stderr.write(`⎇ repo ${repoSpec.full} ${how}${tip}\n  ${co.dir}\n`);
        // Refuse rather than branch off a base nobody can name. git fetch moves
        // remote refs, not the mirror's HEAD, so without a known tip the run
        // would silently start from whatever was on disk while having just
        // printed a reassuring fetch line.
        if (co.freshness.state !== "fresh" || !co.freshness.remoteTip) {
          process.stderr.write(
            `✗ refusing to start: the base for ${repoSpec.full} is not known to match the remote.\n` +
              `  ${co.freshness.reason ?? "no revision was resolved"}\n` +
              "  a worktree cut now would branch off whatever the mirror already had.\n" +
              "  reconnect and retry, or work in a local checkout you control.\n",
          );
          return 1;
        }
        repoBase = co.freshness.remoteTip;
      } catch (err) {
        process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
    }
    try {
      // Pin the worktree to the revision the mirror actually fetched. git fetch
      // moves remote refs, not the mirror's HEAD, so an unpinned `worktree add`
      // branches off a base that can be well behind the tip just reported.
      worktree = createWorktree(repoRoot, label, undefined, repoBase ?? undefined);
      process.stderr.write(`⌥ worktree ${worktree.branch}\n  ${worktree.dir}\n`);
    } catch (err) {
      process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    cwd = worktree.dir;
  } else {
    const ws = await prepareWorkspace(ctx, label, io, workspaceRun);
    if (!ws.proceed) return ws.error ? 1 : 0;
    cwd = ws.cwd;
  }

  // ── Rules and skills enter the run here ─────────────────────────────────
  // Opened against `cwd` — the tree the run actually works in, which is the
  // worktree when there is one, not the directory the user typed the command
  // in. A run must be governed by the AGENTS.md of the code it is editing.
  //
  // This is the ONE seam: the brief composed below is what the cloud
  // dev-session POSTs as `task` and what the local Ollama brain puts in its
  // chat messages, byte for byte, and the policy printed in the header is the
  // policy hostLoop enforces a moment later. A refusal here ends the run — a
  // named skill that cannot be trusted or loaded never degrades into a quiet
  // skill-free run that looks like it worked.
  const opened = openRunSession({
    projectRoot: cwd,
    prompt: task || label,
    ...(opts.skill ? { explicitSkill: opts.skill } : {}),
    ...(opts.noSkills ? { noSkills: true } : {}),
  });
  if (!opened.ok) {
    for (const line of opened.lines) process.stderr.write(line + "\n");
    return 2;
  }
  const run = opened.run;
  for (const line of run.headerLines) process.stderr.write("  " + line + "\n");

  // ── Resuming under the same rules it started under ───────────────────────
  // A session id names a conversation. It does not name the instructions that
  // conversation was conducted under, and those live in files anyone can edit
  // between two runs. Continuing under the old session identity while the rules
  // underneath have changed is the quiet failure this check exists to prevent.
  //
  // A changed SKILL digest refuses: the user named that skill once, its body is
  // executable guidance, and a different body under the same id and version is
  // not the thing they approved. A changed instruction graph is ANNOUNCED but
  // does not refuse — editing AGENTS.md between runs is ordinary work, and
  // refusing it would make resume unusable — but it is never silent.
  if (handoff?.context) {
    const drift = contextDrift(handoff.context, run.session.provenance);
    for (const line of drift.announcements) process.stderr.write("  " + line + "\n");
    if (drift.refusals.length) {
      process.stderr.write("\n✗ refusing to resume " + handoff.sessionId + " under different skills:\n");
      for (const line of drift.refusals) process.stderr.write("  " + line + "\n");
      process.stderr.write(
        "  review what changed, then start a new session, or re-run with --no-skills to continue\n" +
          "  under the project's rules alone.\n",
      );
      return 2;
    }
  }

  const poolGb = opts.pool > 0 ? opts.pool : 5;
  const memoryContext = { ...ctx, flags: { ...ctx.flags, cwd } };
  const pinnedMemory = process.env["AETHER_PROJECT_MEMORY_RECEIPTS_ENABLED"] === "1" ? pinMemory(memoryContext) : null;
  if (ctx.flags.json && pinnedMemory) process.stdout.write(JSON.stringify({ type: "project_memory_pinned", ...pinnedMemory }) + "\n");
  // --local forces the local brain. Otherwise honor the backend preference
  // (AETHER_BACKEND env > config.backend > 'auto'); 'auto' is local-first, so an
  // unauthed user gets the local brain and a signed-in user keeps the cloud default.
  let goLocal = opts.local;
  if (!opts.local) {
    const pref = (process.env["AETHER_BACKEND"] || ctx.cfg.backend || "auto").trim();
    const authed = Boolean(await ctx.tokens.get());
    goLocal = chooseBackend(pref, authed) === "local";
  }
  const brainKind: "local" | "cloud" = goLocal ? "local" : "cloud";
  const localSelection = goLocal
    ? resolveLocalModelSelection(ctx.flags.model, ctx.cfg.localModel ?? "", { allowBareExplicit: opts.local })
    : null;
  const resolvedHostedModel = goLocal ? "" : resolveHostedSessionModel(ctx.flags.model, ctx.cfg.defaultModel);
  // Provenance uses a namespace; the Ollama wire protocol receives only the
  // tag. That makes a handoff unambiguous without changing Ollama's API.
  const resolvedModel = localSelection?.id ?? resolvedHostedModel;

  // The offline path drives the SAME Ollama brain the REPL's `--local` turns
  // already use (commands/chat.ts runLocalTurn) — pure TypeScript, shipped in
  // the npm package, no extra runtime. The headless Python brain is a separate
  // install, so it is opt-in through AETHER_LOCAL_BRAIN=python; before this the
  // one-shot form spawned it unconditionally and a plain npm install could only
  // ever answer `spawn python ENOENT`.
  const brain: Brain = goLocal
    ? chooseLocalBrain(process.env["AETHER_LOCAL_BRAIN"]) === "python"
      ? new LocalBrain()
      : new OllamaBrain()
    : // `aether agent` is a coding session over THIS checkout, so it may not
      // silently accept the one-way chat transport, whose tools run
      // server-side against the cloud vault (brain_cloud CloudBrainOptions).
      new CloudBrain(ctx.api, undefined, { requireLocalAuthority: true });
  const exec = new ToolExecutor(cwd, opts.testCmd);
  // Scope the session manifest to the ORIGINAL launch directory (ctx.flags.cwd),
  // not the possibly-substituted `cwd` (an auto-created worktree, or a manually
  // redirected directory from the repo gate) — resume always compares against
  // ctx.flags.cwd of the *next* invocation (resume.ts, latestSession), which is
  // where the user is standing, not where this run ended up executing.
  const log = opts.noLog
    ? null
    : new SessionLog(
        {
          task: label,
          model: resolvedModel,
          poolGb,
          brain: brainKind,
          cwd: ctx.flags.cwd,
          // Where the run actually executed, when that is not where it was
          // launched from (an auto-created worktree, or a redirect from the
          // repo gate). Recorded so the library can say which checkout the work
          // is in, and so the branch it reports is the branch the commits
          // landed on rather than the launch directory's. (Lane AA-CONT-04.)
          ...(cwd && ctx.flags.cwd && !isCurrentWorkspace(cwd, ctx.flags.cwd) ? { worktree: cwd } : {}),
          ...(opts.testCmd ? { testCmd: opts.testCmd } : {}),
          // Digests and paths, never content: enough for the next run (or the
          // next machine) to tell that the rules moved, and nothing more.
          context: {
            skills: run.session.provenance.skills.map((skill) => ({
              id: skill.id,
              version: skill.version,
              digest: skill.digest,
              invocation: skill.invocation,
              trust: skill.trust,
              lock: skill.lock,
            })),
            instructionSources: [...run.session.provenance.instructionSources],
            instructionGraphDigest: run.session.provenance.instructionGraphDigest,
            conflicts: [...run.session.provenance.conflicts],
          },
        },
        nowIso(),
      );

  // One command-owned cancellation authority spans the brain loop AND the host
  // verification process. Signal handlers never call process.exit(): doing so
  // could strand a shell/test descendant and skip the lifecycle's sole final
  // outcome. The ToolExecutor receives this signal and does not resolve until
  // the process tree has been reaped.
  const commandAbort = new AbortController();
  let signalExitCode: 130 | 143 | null = null;
  let resumePrinted = false;
  const abortForSignal = (name: "SIGINT" | "SIGTERM", exitCode: 130 | 143): void => {
    if (!resumePrinted && log) {
      resumePrinted = true;
      process.stderr.write("\n" + resumeHint(log.sessionId) + "\n");
    }
    if (commandAbort.signal.aborted) return;
    signalExitCode = exitCode;
    commandAbort.abort(new DOMException(`coding turn interrupted by ${name}`, "AbortError"));
  };
  const onSigint = (): void => abortForSignal("SIGINT", 130);
  const onSigterm = (): void => abortForSignal("SIGTERM", 143);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {

  const taskCmd: TaskCommand = {
    type: "task",
    // On a resume the brain reads the prior session's continuation brief FIRST,
    // then the new instruction — that, and not the on-screen replay, is what
    // lets a different model (or a different machine) pick the thread up.
    //
    // run.brief() wraps that with the project's rules, the loaded skill bodies,
    // and the effective host policy. With no rules and no skills it returns the
    // task unchanged, so an unskilled run is byte-identical to one without this
    // seam at all.
    text: run.brief(handoff ? continuationTask(handoff, task) : task),
    // The typed channel, for a brain that reads the NDJSON command frame.
    // Additive and optional (brain_protocol.AgentContextPacket): a brain that
    // predates it sees no key. The brief above is what reaches the Ollama and
    // cloud brains, which never touch encodeCommand.
    ...(run.contextPacket ? { context: run.contextPacket } : {}),
    cwd,
    poolGb,
    // --effort wins; otherwise the /effort dial saved in the Aether config
    // (same backend: TaskCommand.effort reaches the cloud brain unchanged).
    effort: opts.effort ?? (ctx.cfg.defaultEffort || undefined),
    model: localSelection?.tag ?? (resolvedHostedModel || undefined),
    testCmd: opts.testCmd,
  };

  // One correlation identity owns the production run. A brain `done` event is
  // advisory; the lifecycle remains completing until host verification below.
  const turn = new CodeTurnLifecycle(task || label);
  const progressTimeoutMs = codeMeaningfulProgressTimeoutMs();

  const interactive = Boolean(opts.interactive) && Boolean(process.stdin.isTTY);
  const onToolResult = (id: string, result: ToolResult): void => log?.toolResult(id, result, nowIso());

  // Permission gate: every brain-emitted mutating/shell tool call is approved
  // here before the host runs it. Honors the configured permission mode + auto-
  // apply; in `ask` (the default) on a TTY the user gets a y/N prompt, and on a
  // non-TTY (CI/pipe) an un-pre-approved call FAILS CLOSED rather than running
  // unattended. `--yes` or `permissionMode: skip` opt out.
  const gate: ToolGate = async ({ name, args }) => {
    const outcome = decideGate(name, ctx.cfg.permissionMode, ctx.cfg.autoApply, {
      yes: ctx.flags.yes,
      isTty: Boolean(process.stdin.isTTY),
    });
    if (outcome === "allow") return true;
    if (outcome === "deny") {
      process.stderr.write(
        `✗ blocked ${name} — permission mode "${ctx.cfg.permissionMode}" needs confirmation but there is no TTY.\n` +
          `  re-run with --yes, or set a less strict mode: aether config set permissionMode skip\n`,
      );
      return false;
    }
    const detail = String(args["command"] ?? args["path"] ?? args["message"] ?? "");
    const shown = detail.length > 200 ? detail.slice(0, 197) + "…" : detail;
    return ctx.confirm(`\n⚠ ${name}${shown ? ` ${shown}` : ""} — run it? [y/N] `);
  };

  // Presentation fork — TTY (and not --json/--quiet) gets the live animated
  // status line; everything else (pipes, --json, --quiet, CI) gets the plain
  // HostRenderer. The animation layer is strictly downstream of the event data,
  // so the §8 emission logs are never polluted.
  const animated =
    !ctx.flags.json && !opts.quiet && Boolean(process.stdout.isTTY) && process.env["AETHER_NO_ANIM"] !== "1";

  // Multi-task ledger over the reasoning pipeline — drives the pinned n/7 counter
  // (animated) and the end-of-run checklist recap (✓ down the pipeline, ✗ where
  // it broke) on both paths. Seeded with the fixed stages so progress is forward
  // looking from the first frame.
  const ledger = new TaskLedger(CODE_STAGES);
  const cols = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
  // Blast radius for the end-of-run summary: every file the brain wrote.
  const touched = new Set<string>();
  // Same predicate a handoff uses for `filesTouched`, so the live blast radius
  // and the exported record can never disagree about what "wrote a file" means.
  const trackWrites = (ev: BrainEvent): void => {
    const written = wroteFile(ev);
    if (written) touched.add(written);
  };

  let onEvent: (ev: BrainEvent) => void | Promise<void>;
  let teardown = (): void => {};

  if (animated) {
    const sr = new StatusRenderer({ mode: brainKind === "local" ? "local" : "api", ownsProcess: false });
    sr.start();
    replay((line) => sr.log(line));
    const anim = new AnimationController({
      onFrame: (_stage, art) => sr.setAnim(art),
      onProgress: (used, c) => sr.setProgress(used, c),
    });
    // A hosted session can wait for dev-session creation before its first
    // stage event. Paint the idle sequence now so that wait is visibly live.
    sr.setVerb(brainKind === "local" ? "Waiting for local model" : "Connecting to model", "");
    anim.setStage("idle");
    const hb = new HeartbeatIndicator({
      onFrame: (g, beats) => {
        sr.setHeartbeat(g);
        sr.setBeats(beats); // feed the thinking timer's live heartbeat count
      },
    });
    const source = new LocalAgentSource();
    const unbindSource = bindEventSource(source, sr, anim, {
      hb,
      heartbeatTimeoutMs: 5000,
      meaningfulProgressTimeoutMs: progressTimeoutMs,
      ownsSource: true,
    });
    let tick = 0;
    onEvent = async (ev: BrainEvent): Promise<void> => {
      const observation = turn.observe(ev);
      if (!observation.accepted) return;
      if (ev.type === "memory") {
        log?.event(ev, nowIso());
        sr.memoryEvent(ev);
        return;
      }
      if (ev.type === "routing_drift") {
        // The animated path never touches HostRenderer, so without this the
        // drift banner would exist only for piped runs — invisible to exactly
        // the user sitting at the terminal it was written for.
        log?.event(ev, nowIso());
        for (const line of routingDriftLines(ev)) sr.log(line);
        return;
      }
      log?.event(ev, nowIso());
      applyEventToStatus(sr, ev, tick++);
      applyToLedger(ledger, ev);
      trackWrites(ev);
      // Intercept the whole-file write to render a live green/red diff into
      // scrollback — the old file is still on disk because hostLoop runs onEvent
      // BEFORE exec.execute. Skip feedBrain for it so we don't ALSO print the
      // "  : write_file …" line; the animated kaomoji status line keeps pulsing
      // below, so the diff and the live state stay in sync.
      const diff =
        ev.type === "tool_call" && ev.name === "write_file" ? writeDiffLines(exec, ev.args, true) : null;
      if (diff && diff.length) {
        for (const line of diff) sr.log(line);
      } else {
        source.feedBrain(ev); // adapter -> animation/status (presentation only)
      }
      // Refresh the pinned multi-step counter only on stage changes — never after
      // a terminal event (feedBrain's done case already calls sr.end()).
      if (ev.type === "stage") sr.setTasks(ledger.progress());
      if (interactive && ev.type === "stage") await stageGate(brain, io, ev.name);
      if (interactive && ev.type === "monologue") await answerAgentQuestionIfPresent(brain, io, ev.text);
    };
    teardown = (): void => {
      // Final multi-step recap into scrollback, then drop the pinned line.
      const recap = ledger.panel(cols);
      if (recap.length) {
        sr.log("");
        for (const line of recap) sr.log(line);
      }
      // Retaining the disposer is essential on host-loop throws: it detaches
      // the subscription and clears both watchdogs before the renderer ends.
      unbindSource();
      anim.stop();
      hb.stop();
      sr.end();
    };
  } else {
    const renderer = new HostRenderer({ poolGb, quiet: opts.quiet, json: ctx.flags.json });
    replay((line) => process.stdout.write(line + "\n"));
    onEvent = async (ev: BrainEvent): Promise<void> => {
      const observation = turn.observe(ev);
      if (!observation.accepted) return;
      applyToLedger(ledger, ev);
      trackWrites(ev);
      // Same diff interception for the non-animated path (pipes / NO_ANIM /
      // --quiet). Suppressed under --json so machine consumers still receive the
      // raw tool_call event, never the rendered diff.
      const diff =
        !ctx.flags.json && ev.type === "tool_call" && ev.name === "write_file"
          ? writeDiffLines(exec, ev.args, false)
          : null;
      if (diff && diff.length) renderer.writeLines(diff);
      else renderer.event(ev);
      // End-of-run checklist recap (writeLines is a no-op under --json).
      if (ev.type === "done") renderer.writeLines(ledger.panel(cols));
      log?.event(ev, nowIso());
      if (interactive && ev.type === "stage") await stageGate(brain, io, ev.name);
      if (interactive && ev.type === "monologue") await answerAgentQuestionIfPresent(brain, io, ev.text);
    };
  }

  const startedAt = Date.now();
  let loopError: unknown = null;
  let incompleteEof = false;
  try {
    await hostLoop(brain, exec, onEvent, taskCmd, onToolResult, gate, run.guard, {
      meaningfulProgressTimeoutMs: progressTimeoutMs,
      signal: commandAbort.signal,
    });
    if (!turn.hasTerminalFrame) {
      incompleteEof = true;
      turn.noteIncompleteEof();
    }
  } catch (err) {
    loopError = err;
    turn.noteThrown(err);
    if (!ctx.flags.json) {
      process.stderr.write(`\n✗ ${sanitizeServerText(errorMessage(err))}\n`);
    }
  } finally {
    // A brain that throws mid-run must still clear the pinned status line and
    // print the ledger recap — otherwise stale animation sits over the error.
    teardown();
  }

  // ── Routing refused: nothing ran, so there is nothing to verify ──────────
  // Returning BEFORE finalVerify is the point: the gate would run the project's
  // test command and report on a tree no brain ever touched, dressing a refusal
  // up as a red (or, on a green tree, a passing) run.
  if (turn.fatalDrift) {
    // No second copy of the remediation: the ROUTING_DRIFT banner already
    // carried it (host_render.routingDriftLines prints it on a fatal drift),
    // on this path and on the animated one alike.
    log?.close("incomplete", nowIso(), 0);
    emitCodeTurnOutcome(turn.settle(null), ctx.flags.json);
    if (log) process.stderr.write(`  ⤷ log: ${log.dir}\n`);
    return EXIT_ROUTING_REFUSED;
  }

  // ── Final verification gate: ground truth, never the brain's self-report ──
  // The host re-runs the test command ITSELF and derives finalStatus from the real
  // exit code (verify_gate.ts). The brain's `done` is advisory — it only enriches a
  // red result with its breaker reason and can never upgrade a red run to "ok".
  let verification: VerifyOutcome | null = null;
  const loopWasInterrupted =
    commandAbort.signal.aborted || loopError instanceof StreamTimeoutError || loopError instanceof ModelOutputLimitError || isAbortError(loopError);
  if (!loopWasInterrupted) {
    try {
      verification = await finalVerify(
        exec,
        opts.testCmd,
        turn.lastDone,
        turn.sawError || loopError !== null || incompleteEof,
        { signal: commandAbort.signal, timeoutMs: progressTimeoutMs },
      );
      // ToolExecutor reports a killed process as a structured result so callers
      // can distinguish operator cancellation from a clock expiry. Feed that
      // distinction back into the lifecycle instead of flattening either into
      // an ordinary red test run.
      if (verification.exitCode === 130 || commandAbort.signal.aborted) {
        const interrupted = codeSignalReason(commandAbort.signal);
        loopError = interrupted;
        turn.noteThrown(interrupted);
      } else if (verification.exitCode === 124) {
        const timedOut = new MeaningfulProgressTimeoutError(progressTimeoutMs);
        loopError = timedOut;
        turn.noteThrown(timedOut);
      }
    } catch (err) {
      loopError = err;
      turn.noteThrown(err);
      if (!ctx.flags.json) {
        process.stderr.write(`\n✗ final verification failed: ${sanitizeServerText(errorMessage(err))}\n`);
      }
    }
  }
  const outcome = turn.settle(verification);
  emitCodeTurnOutcome(outcome, ctx.flags.json);
  const finalStatus = verification?.status ?? "error";
  const remaining = verification?.remaining ?? turn.lastDone?.remaining ?? 0;
  const verifyExit = verification?.exitCode ?? 1;
  log?.close(finalStatus, nowIso(), remaining);
  // The verdict line — printed even with --no-log (which used to end with
  // NOTHING); suppressed under --json (frames already carry the data). Surfaces
  // the failing-test count the verify gate already computed but used to bury
  // in the log file only. runSummary only distinguishes ok/incomplete/unverified
  // (a breaker reason like "stalled" still reads as "incomplete" to the user —
  // the run didn't finish green either way), so collapse the wider FinalStatus.
  if (!ctx.flags.json) {
    const secs = (Date.now() - startedAt) / 1000;
    const summaryStatus = finalStatus === "ok" || finalStatus === "unverified" ? finalStatus : "incomplete";
    process.stderr.write("\n  " + runSummary(summaryStatus, remaining, touched.size, secs) + "\n");
  }
  if (log) process.stderr.write(`  ⤷ log: ${log.dir}\n`);
  if (process.env["AETHER_PROJECT_MEMORY_RECEIPTS_ENABLED"] === "1") {
    const memory = await completeMemory(memoryContext, pinnedMemory, outcome.state === "succeeded");
    if (ctx.flags.json) process.stdout.write(JSON.stringify({ type: "project_memory_status", text: memory }) + "\n");
    else process.stderr.write(`  ${memory}\n`);
  }
  if (worktree) process.stderr.write(mergeHint(worktree));
  if (repoSpec && worktree) {
    // This used to be `process.stderr.write(prCreateHint(...))` — a printed gh
    // incantation the user had to retype, and the reason nothing in this
    // repository ever exercised PR creation. It is an offer now: on a terminal
    // it asks, and on a yes it runs the same rail `aether ship` runs (publish
    // the head branch, then open the pull request behind a confirmation screen
    // that shows every argv element in full). A pipe/CI run still gets a line
    // it can act on, but the command it names now exists.
    const { offerShip } = await import("./ship.js");
    await offerShip(ctx, process.stderr, repoSpec, worktree.dir, worktree.branch);
  }
  // Process exit follows the centralized terminal contract. Success is only a
  // host-verified green result; EOF, no verification, timeouts, and brain
  // failures remain non-zero even if the brain previously claimed `ok`.
  if (outcome.state === "succeeded") return 0;
  if (outcome.state === "cancelled") return signalExitCode ?? 130;
  return verifyExit > 0 ? verifyExit : outcome.exitCode;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

/**
 * Compare the rules and skills a prior session ran under against the ones this
 * run just resolved. Exported for tests: the comparison is the whole point, so
 * it must be assertable without cutting a worktree and driving a brain.
 *
 * A skill present THEN and absent NOW is reported, not refused — the user may
 * simply not have named it this time, and the run is narrower, never wider.
 */
export function contextDrift(
  before: SessionContext,
  now: SkillSessionProvenance,
): { refusals: string[]; announcements: string[] } {
  const refusals: string[] = [];
  const announcements: string[] = [];
  const current = new Map(now.skills.map((skill) => [skill.id, skill]));
  for (const prior of before.skills) {
    const live = current.get(prior.id);
    if (!live) {
      announcements.push("Note    " + prior.id + " ran in the prior session and is not loaded now");
      continue;
    }
    if (live.digest !== prior.digest) {
      refusals.push(
        prior.id +
          " changed since the prior session (" +
          prior.digest.slice(0, 19) +
          " then, " +
          live.digest.slice(0, 19) +
          " now)",
      );
      continue;
    }
    if (live.trust !== prior.trust) {
      refusals.push(prior.id + " trust changed: " + prior.trust + " then, " + live.trust + " now");
    }
  }
  if (
    before.instructionGraphDigest &&
    now.instructionGraphDigest &&
    before.instructionGraphDigest !== now.instructionGraphDigest
  ) {
    announcements.push(
      "Note    the project's rules changed since the prior session - this run uses the CURRENT ones",
    );
    const priorSources = new Set(before.instructionSources);
    const added = now.instructionSources.filter((path) => !priorSources.has(path));
    const removed = before.instructionSources.filter((path) => !now.instructionSources.includes(path));
    if (added.length) announcements.push("Note    now in force: " + added.join(", "));
    if (removed.length) announcements.push("Note    no longer in force: " + removed.join(", "));
  }
  return { refusals, announcements };
}

/**
 * The host loop — the bridge seam, extracted so it is unit-testable with a fake
 * brain. The brain decides (emits events); the host renders each event and
 * executes each tool_call locally, replying with the result. Returns the process
 * exit code (0 = the run finished green). Always tears the brain down.
 *
 * `skillGuard` is where a loaded skill's narrowing becomes real. It runs BEFORE
 * the operator permission gate, never instead of it: the skill subtracts from
 * the tool surface, then the operator gate decides about what is left. That
 * ordering is the whole never-widen invariant — there is no path by which a
 * manifest can add a tool, add a permission, or skip a confirmation, because
 * nothing a manifest says is ever consulted after this point.
 */
export interface HostLoopOptions {
  /** 0 disables the bound for a deliberate library embed; the CLI never does. */
  meaningfulProgressTimeoutMs?: number;
  /** Absolute bound on one model segment; resets after a tool result. */
  modelSegmentTimeoutMs?: number;
  /** Per-model-segment output cap for embedders and focused tests. */
  modelOutputLimitBytes?: number;
  /** Command-owned cancellation authority, shared with host verification. */
  signal?: AbortSignal;
}

export async function hostLoop(
  brain: Brain,
  exec: ToolExecutor,
  onEvent: (ev: BrainEvent) => void | Promise<void>,
  task: TaskCommand,
  onToolResult?: (id: string, result: ToolResult) => void,
  gate?: ToolGate,
  skillGuard?: (tool: string) => SkillRefusal | null,
  options: HostLoopOptions = {},
): Promise<number> {
  let code = 0;
  let iterator: AsyncIterator<BrainEvent> | null = null;
  const progress = new CodeProgressTracker();
  const modelOutput = new ModelOutputBudget(options.modelOutputLimitBytes);
  const timeoutMs = options.meaningfulProgressTimeoutMs ?? DEFAULT_CODE_MEANINGFUL_PROGRESS_TIMEOUT_MS;
  const segmentTimeoutMs = options.modelSegmentTimeoutMs ?? codeModelSegmentTimeoutMs();
  const signal = options.signal;
  let lastMeaningfulAt = Date.now();
  let modelSegmentStartedAt = lastMeaningfulAt;
  let brainClosed = false;
  const closeBrain = (): void => {
    if (brainClosed) return;
    brainClosed = true;
    brain.close();
  };
  const closeOnAbort = (): void => closeBrain();
  signal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    if (signal?.aborted) throw codeSignalReason(signal);
    iterator = brain.run(task)[Symbol.asyncIterator]();
    for (;;) {
      const next = await boundedCodeOperation(
        () => iterator!.next(),
        timeoutMs,
        lastMeaningfulAt,
        signal,
        segmentTimeoutMs,
        modelSegmentStartedAt,
      );
      if (next.done) break;
      const ev = next.value;
      if (ev.type === "monologue") modelOutput.add(ev.text);
      await boundedCodeOperation(() => onEvent(ev), timeoutMs, lastMeaningfulAt, signal, segmentTimeoutMs, modelSegmentStartedAt);
      if (progress.meaningful(ev)) lastMeaningfulAt = Date.now();
      let terminal = false;
      switch (ev.type) {
        case "tool_call": {
          // The host owns execution + the path-guard. A tool call is gated FIRST
          // (permission mode); a denied call is never executed — the brain gets a
          // synthetic refusal result so the loop continues without running it.
          // executeAsync delegates the 6 sync tools to execute() unchanged and
          // awaits the 2 async web tools (web_search/web_fetch) so they run on
          // this path too — otherwise execute() returns "[tool … is async]".
          // Skill policy first. A tool no active skill declares — or one whose
          // permission a skill forbids, or one outside the operator envelope —
          // is refused HERE, before the user is ever asked to approve it and
          // before a byte of it runs. The brain gets a structured refusal as a
          // normal failed tool result, so the loop continues and the model
          // learns why instead of silently retrying.
          const refusal = skillGuard ? skillGuard(ev.name) : null;
          if (refusal) {
            const denied: ToolResult = refusalToolResult(refusal);
            onToolResult?.(ev.id, denied);
            brain.sendToolResult(ev.id, denied);
            lastMeaningfulAt = Date.now();
            modelSegmentStartedAt = lastMeaningfulAt;
            modelOutput.reset();
            break;
          }
          const approved = gate
            ? await boundedCodeOperation(
                () => gate({ name: ev.name, args: ev.args }),
                timeoutMs,
                lastMeaningfulAt,
                signal,
                segmentTimeoutMs,
                modelSegmentStartedAt,
              )
            : true;
          const remaining = remainingCodeProgressMs(timeoutMs, lastMeaningfulAt);
          const runOptions: RunOptions = {
            ...(signal ? { signal } : {}),
            ...(timeoutMs > 0 ? { timeoutMs: Math.max(1, remaining) } : {}),
          };
          const result: ToolResult = approved
            ? await boundedCodeOperation(
                () => exec.executeAsync(ev.name, ev.args, runOptions),
                timeoutMs,
                lastMeaningfulAt,
                signal,
                segmentTimeoutMs,
                modelSegmentStartedAt,
              )
            : { output: `[denied: ${ev.name} not approved by user]`, exitCode: 1 };
          if (signal?.aborted) throw codeSignalReason(signal);
          onToolResult?.(ev.id, result);
          brain.sendToolResult(ev.id, result);
          lastMeaningfulAt = Date.now();
          modelSegmentStartedAt = lastMeaningfulAt;
          modelOutput.reset();
          break;
        }
        case "done":
          // A prior error event keeps its exit code — a later done ok:true
          // must never launder a failed run back to success.
          if (!ev.ok) code = 1;
          terminal = true;
          break;
        case "error":
          code = 1;
          terminal = true;
          break;
        case "routing_drift":
          terminal = ev.fatal;
          break;
      }
      // A terminal frame ends host authority immediately. A broken source that
      // emits more frames cannot execute a late tool or rewrite the verdict.
      if (terminal) break;
    }
  } finally {
    signal?.removeEventListener("abort", closeOnAbort);
    try {
      closeBrain();
    } finally {
      // Do not await return(): a timed-out iterator is allowed to be parked in
      // an adapter promise forever. close() is the cancellation authority, and
      // this best-effort return still lets well-behaved generators run finally.
      const activeIterator = iterator;
      if (activeIterator?.return) {
        void Promise.resolve()
          .then(() => activeIterator.return!())
          .catch(() => {});
      }
    }
  }
  return code;
}

function remainingCodeProgressMs(timeoutMs: number, lastMeaningfulAt: number): number {
  return timeoutMs <= 0 ? 0 : timeoutMs - (Date.now() - lastMeaningfulAt);
}

function codeSignalReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("coding turn cancelled", "AbortError");
}

/** Bound every awaitable host seam—not just iterator.next(). A renderer,
 * permission prompt, fake executor, or network-backed tool that never settles
 * therefore cannot strand a coding turn. Synchronous throws are captured into
 * the same promise path, which also keeps cleanup from replacing the primary
 * timeout/cancellation reason. */
function boundedCodeOperation<T>(
  work: () => T | PromiseLike<T>,
  timeoutMs: number,
  lastMeaningfulAt: number,
  signal?: AbortSignal,
  segmentTimeoutMs = DEFAULT_CODE_MODEL_SEGMENT_TIMEOUT_MS,
  modelSegmentStartedAt = Date.now(),
): Promise<T> {
  if (signal?.aborted) return Promise.reject(codeSignalReason(signal));
  const progressRemaining = timeoutMs > 0 ? remainingCodeProgressMs(timeoutMs, lastMeaningfulAt) : Infinity;
  const segmentRemaining = segmentTimeoutMs - (Date.now() - modelSegmentStartedAt);
  if (segmentRemaining <= 0) return Promise.reject(new TurnDeadlineError(segmentTimeoutMs));
  if (progressRemaining <= 0) return Promise.reject(new MeaningfulProgressTimeoutError(timeoutMs));
  const segmentFirst = segmentRemaining <= progressRemaining;
  const remaining = Math.min(progressRemaining, segmentRemaining);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => fail(codeSignalReason(signal!));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => fail(segmentFirst ? new TurnDeadlineError(segmentTimeoutMs) : new MeaningfulProgressTimeoutError(timeoutMs)),
      Math.max(1, remaining),
    );
    timer?.unref?.();
    Promise.resolve().then(work).then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      fail,
    );
  });
}
