// Support helpers for `aether code`: workspace preparation and host-side UI glue.
// Keeping these out of code.ts lets the command file stay focused on orchestration.

import { resolve } from "node:path";
import type { AppContext } from "../core/context.js";
import type { Brain } from "../core/brain.js";
import type { BrainEvent } from "../core/brain_protocol.js";
import { ToolExecutor } from "../core/tool_executor.js";
import { confirm, ask, parseAgentQuestion, type PromptIO } from "../ui/interact.js";
import {
  ghAuthStatus,
  isGitRepo,
  repoRoot,
  slugify,
  createGatedWorktree,
  linkGhAccount,
  type Runner,
} from "../core/worktree.js";
import { renderDiff } from "../ui/diff.js";
import { kaomoji } from "../ui/kaomoji.js";
import { theme, errTheme } from "../ui/theme.js";
import { TaskLedger } from "../ui/ledger.js";
import { sanitizeServerText } from "../core/transport.js";
import type { TurnOutcome, TurnTerminalState } from "../core/turn_lifecycle.js";
import type { CheckReading } from "../core/verify_gate.js";

// The engine's fixed reasoning pipeline - seeded into the task ledger so the run
// shows broad multi-step progress (n/7) instead of one opaque task.
export const CODE_STAGES = ["recon", "parse", "brainstorm", "write-plans", "execute", "self-review", "reveal"];

export function applyToLedger(ledger: TaskLedger, ev: BrainEvent): void {
  if (ev.type === "stage") ledger.setActive(ev.name);
  else if (ev.type === "done") {
    if (ev.ok) ledger.finishAll();
  } else if (ev.type === "error") ledger.failActive();
}

export function writeDiffLines(exec: ToolExecutor, args: Record<string, unknown>, withFace: boolean): string[] {
  const path = String(args["path"] ?? "");
  if (!path) return [];
  const content = String(args["content"] ?? "");
  const snap = exec.snapshot(path);
  const cols = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
  const face = withFace ? kaomoji("logging") : undefined;

  // snap.reason === "unsafe" means ToolExecutor's workspace guard is about to
  // reject this write (e.g. a path outside the workspace) — existed is false
  // in that case (unlike binary/too-big, which have existed:true), so without
  // this check execution would fall through to renderDiff and fabricate a
  // clean "(new +N)" preview for a write that never actually happens.
  if (snap.reason === "unsafe") return [];
  // Legacy overwrite calls fail at execution. Do not render their proposed
  // content as if the file had been changed before that refusal is shown.
  const hasProof = typeof args["expected_revision"] === "string" && typeof args["replace_token"] === "string";
  if (snap.existed !== hasProof) return [];

  if (snap.existed && snap.text === null) {
    const what = snap.reason === "binary" ? "binary" : "large file";
    const bytes = Buffer.byteLength(content);
    const faceStr = face ? "  " + theme.dim(face) : "";
    return [
      `  ${theme.cyan("✎")} ${theme.bold(path)}${faceStr}  ${theme.yellow(`(${what}, wrote ${bytes} b)`)}`,
    ];
  }

  return renderDiff(path, snap.text ?? "", content, { cols, isNew: !snap.existed, kaomoji: face });
}

/** `92s` / `3m12s` — the run-summary clock. */
export function fmtDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/**
 * How an `aether agent` run ended: the canonical turn outcome, what the host's
 * check actually did, and — when something other than the check decided the
 * outcome — the turn-level cause. The footer, the JSON outcome and the session
 * record are all rendered from this one value, so they cannot disagree.
 */
export interface CodeRunReport {
  outcome: TurnOutcome;
  check: CheckReading;
  /** Why the turn ended when the check did not decide it (a cancellation, a
   * model timeout, a refusal, a dropped stream); null when the check did. */
  cause: string | null;
}

/** The parts of a report the footer reads. */
export interface RunSummaryInput {
  outcome: Pick<TurnOutcome, "state" | "hint">;
  check: CheckReading;
  cause: string | null;
}

/** Long server text must not wrap the verdict line. */
const MAX_CAUSE_CHARS = 120;

function clipped(text: string): string {
  const clean = sanitizeServerText(text);
  if (clean.length <= MAX_CAUSE_CHARS) return clean;
  const cut = clean.slice(0, MAX_CAUSE_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  // Prefer a word boundary unless it would discard most of the text.
  const head = space > MAX_CAUSE_CHARS * 0.6 ? cut.slice(0, space) : cut;
  return head.trimEnd() + "…";
}

function verdict(state: TurnTerminalState): string {
  switch (state) {
    case "succeeded":
      return `${errTheme.green("✓")} ok`;
    case "cancelled":
      return `${errTheme.yellow("■")} cancelled`;
    case "timed_out":
      return `${errTheme.red("✗")} timed out`;
    case "failed":
      return `${errTheme.red("✗")} failed`;
    case "incomplete":
      return `${errTheme.red("✗")} incomplete`;
  }
}

/** What the check did, in words. Only a completed non-zero check is failing. */
function checkPhrase(check: CheckReading): string {
  switch (check.state) {
    case "passed":
      return "tests green";
    case "failed":
      return check.failing !== null && check.failing > 0
        ? `${check.failing} test${check.failing === 1 ? "" : "s"} failing`
        : `check failed (exit ${check.exitCode ?? "?"})`;
    case "timed_out":
    case "cancelled":
    case "launch_failed":
      return `verification: ${clipped(check.reason)}`;
    case "not_run":
    case "unconfigured":
      return "verification not run";
  }
}

/**
 * The one line a user actually needs at the end of `aether agent` — verdict,
 * cause, what the check did, blast radius, clock. Rendered from the turn
 * outcome plus the check reading, never inferred from a failing count: a run
 * that was cancelled, timed out, or refused before its check says so, and says
 * "verification not run". `unverified` explains how to become verified.
 */
export function runSummary(report: RunSummaryInput, filesChanged: number, secs: number): string {
  const { outcome, check, cause } = report;
  const files = `${filesChanged} file${filesChanged === 1 ? "" : "s"} changed`;
  const dur = fmtDuration(secs);
  if (outcome.state === "succeeded") return `${verdict("succeeded")} · ${files} · ${checkPhrase(check)} · ${dur}`;
  if (cause === null && check.state === "unconfigured") {
    return (
      `${errTheme.dim("—")} unverified · ${files} · ${dur}  ` +
      errTheme.dim('⤷ pass --test-cmd "npm test" to make the run prove itself')
    );
  }
  const parts = [verdict(outcome.state), ...(cause ? [clipped(cause)] : []), checkPhrase(check), files, dur];
  const hint = outcome.hint ? "  " + errTheme.dim(`⤷ ${clipped(outcome.hint)}`) : "";
  return parts.join(" · ") + hint;
}

export async function stageGate(brain: Brain, io: PromptIO, stage: string): Promise<void> {
  const note = (
    await io.question(`\n⏸ ${kaomoji("active")}  ${stage} — [enter] to continue · type a steer: `)
  ).trim();
  if (note) brain.control("steer", note);
}

export async function answerAgentQuestionIfPresent(brain: Brain, io: PromptIO, text: string): Promise<void> {
  const question = parseAgentQuestion(text);
  if (!question) return;
  io.note(`\n${kaomoji("idle")}  the agent has a question:\n  ${question}`);
  const answer = await ask(io, "  your answer (blank to let it decide):");
  if (answer) brain.control("steer", answer);
}

/**
 * 2.0 repo gate + gh-gated worktree. Confirms the target repo before any brain
 * starts. With an authenticated `gh`, a git repo runs in an isolated worktree.
 * An attempted but failed worktree creation aborts; without `gh` authentication,
 * the gate is confirm-only and runs in place.
 */
export async function prepareWorkspace(
  ctx: AppContext,
  task: string,
  io: PromptIO,
  run: Runner,
): Promise<{ cwd: string; proceed: boolean; error?: string }> {
  const autoYes = ctx.flags.yes;
  let cwd = resolve(ctx.flags.cwd || ".");

  // Pipe / CI / test: cannot ask + must take no side effects - run in place.
  if (!io.tty && !autoYes) return { cwd, proceed: true };

  let root = repoRoot(run, cwd) ?? cwd;

  // The gate. Exact wording is mirrored in predator-cli - keep it identical.
  const here = await confirm(io, `Are you working in this repo?\n  ${root}`, { default: true, autoYes });
  if (!here) {
    const alt = await ask(io, "No problem — which directory should I work in? (blank to cancel)", { autoYes });
    if (!alt) {
      io.note("Okay, standing down — nothing was changed.");
      return { cwd, proceed: false };
    }
    cwd = resolve(alt);
    root = repoRoot(run, cwd) ?? cwd;
    io.note(`Got it — working in ${root}.`);
  }

  const gh = ghAuthStatus(run);
  if (gh.authed) {
    if (gh.user) {
      linkGhAccount(gh.user, gh.host);
      io.note(`✓ GitHub ${gh.user} linked to this Aether session.`);
    }
    if (isGitRepo(run, root)) {
      io.note("Spinning up an isolated worktree so your branch stays untouched…");
      const wt = createGatedWorktree(run, root, slugify(task));
      if (wt.ok && wt.path) {
        io.note(`⟢ ${wt.branch} ready  ·  ${wt.path}`);
        return { cwd: wt.path, proceed: true };
      }
      const error = `couldn't create an isolated worktree: ${wt.error ?? "unknown error"}`;
      io.note(`✗ ${error}. Coding task not started.`);
      return { cwd: root, proceed: false, error };
    }
  } else {
    io.note("Heads up: gh isn't authenticated, so I'll work in place. Run `gh auth login` for an isolated worktree.");
  }
  return { cwd: root, proceed: true };
}
