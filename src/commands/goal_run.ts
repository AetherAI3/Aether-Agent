// Explicit one-phase coding runs. The existing `aether agent` host loop owns
// permissions, model routing, tools, deadlines, session logs and final checks.
import type { Writable } from "node:stream";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../core/context.js";
import { getActiveGoal, getGoalForWorkspace, goalsFile, goalsForWorkspace, upsertGoal, type Goal, type GoalPhase, type GoalPhaseRun } from "../core/goals.js";
import { acceptedScopeDigest, acquireGoalRunLease, activeGoalRunOwner, assessGoalPhaseRun, newGoalPhaseRun, readGoalRunControl, requestGoalRunControl, type GoalRunControl } from "../core/goal_run.js";
import { normalizeWorkspace, isCurrentWorkspace, resolveOpaqueChild } from "../core/workspace_scope.js";
import { classifyVerification, readVerification, treeIdentity, type VerificationReading, type TreeIdentity } from "../core/verification_record.js";
import { defaultRunner, repoRoot, type Runner } from "../core/worktree.js";
import { logsRoot } from "../core/session_log.js";
import { redactInline } from "../core/redaction.js";
import { sanitizeServerText } from "../core/transport.js";
import { cmdCode, type CodeOpts, type CodeRunFinished, type CodeRunStarted } from "./code.js";

export type GoalCodeRunner = (ctx: AppContext, task: string, opts: CodeOpts, workspaceRun: Runner) => Promise<number>;
export interface GoalRunDependencies { codeRunner?: GoalCodeRunner; workspaceRun?: Runner; controlPollMs?: number }
const safeReason = (value: string): string => redactInline(sanitizeServerText(value)).slice(0, 300);

function chosenGoal(cwd: string, id?: string): Goal | undefined {
  return id ? getGoalForWorkspace(id, cwd) : getActiveGoal(cwd) ?? goalsForWorkspace(cwd).find(g => g.status !== "complete" && g.status !== "halted");
}

function chosenPhase(goal: Goal): GoalPhase | undefined {
  const active = goal.phases.find(p => p.id === goal.activePhaseId && p.status !== "complete");
  return active ?? goal.phases.find(p => p.status !== "complete");
}

function updateAttempt(cwd: string, goalId: string, phaseId: string, attemptId: string, update: (goal: Goal, phase: GoalPhase, run: GoalPhaseRun) => void): Goal {
  const goal = getGoalForWorkspace(goalId, cwd);
  const phase = goal?.phases.find(p => p.id === phaseId);
  if (!goal || !phase?.run || phase.run.attemptId !== attemptId) throw new Error("saved goal phase changed during its coding run");
  update(goal, phase, phase.run);
  upsertGoal(goal);
  return goal;
}

function runPrompt(goal: Goal, phase: GoalPhase): string {
  return [
    `Saved goal: ${goal.title}`,
    `Run only phase ${phase.id}: ${phase.title}`,
    phase.description && `Phase description: ${phase.description}`,
    phase.userNote && `Phase note: ${phase.userNote}`,
    ...(goal.plan?.constraints ?? []).map(c => `Accepted constraint: ${c}`),
    ...(phase.completionCriteria ?? []).map(c => `Completion criterion: ${c}`),
    `Accepted host check: ${goal.plan?.verification.check ?? "unresolved; do not claim verification"}`,
    "Work only in the selected workspace. Do not start a later phase or publish. The host will run the accepted check after your turn; a done message is not verification.",
  ].filter(Boolean).join("\n");
}

function verificationNow(root: string | null, runner: Runner): { reading: VerificationReading | null; identity: TreeIdentity | null } {
  if (!root) return { reading: null, identity: null };
  const identity = treeIdentity(runner, root);
  return { reading: classifyVerification(readVerification(root), identity), identity };
}

function applyState(goal: Goal, phase: GoalPhase, run: GoalPhaseRun): void {
  if (run.state === "complete") {
    phase.status = "complete";
    phase.completedAt = run.finishedAt ?? new Date().toISOString();
    phase.completionMethod = "verified";
    goal.activePhaseId = undefined;
    if (goal.phases.every(p => p.status === "complete")) {
      goal.status = "complete";
      goal.completedAt = phase.completedAt;
    } else goal.status = "idle"; // A later phase needs its own /goal run.
  } else if (run.state === "failed") {
    phase.status = "failed";
    goal.status = "failed";
  } else if (run.state === "blocked") goal.status = "blocked";
  else if (run.state === "verification_pending") goal.status = "verification_pending";
  else if (run.state === "paused" || run.state === "cancelled" || run.state === "interrupted") goal.status = "paused";
  else goal.status = "running";
}

function sessionSummary(sessionId: string, cwd: string): {
  ended: boolean; endedAt?: string; status: string;
  check?: { state: string; exitCode: number | null; reason: string };
  receipt?: GoalPhaseRun["checkReceipt"];
  hostRefusals?: string[];
} | null {
  try {
    const dir = resolveOpaqueChild(logsRoot(), sessionId, "session id");
    const file = join(dir, "manifest.json");
    if (statSync(file).size > 64 * 1024) return null;
    const manifest = JSON.parse(readFileSync(file, "utf8")) as {
      cwd?: string; ended?: string | null; finalStatus?: string;
      verification?: { state: string; exitCode: number | null; reason: string };
      verificationRecord?: GoalPhaseRun["checkReceipt"];
      hostRefusals?: string[];
    };
    if (!isCurrentWorkspace(manifest.cwd, cwd)) return null;
    return { ended: Boolean(manifest.ended), ...(manifest.ended ? { endedAt: manifest.ended } : {}), status: manifest.finalStatus ?? "running",
      ...(manifest.verification ? { check: manifest.verification } : {}),
      ...(manifest.verificationRecord ? { receipt: manifest.verificationRecord } : {}),
      ...(Array.isArray(manifest.hostRefusals) ? { hostRefusals: manifest.hostRefusals.slice(0, 16) } : {}) };
  } catch { return null; }
}

function reconcilePrior(goal: Goal, phase: GoalPhase, workspaceRun: Runner): GoalPhaseRun | null {
  const run = phase.run;
  if (!run || run.state !== "working") return run ?? null;
  const summary = run.sessionId ? sessionSummary(run.sessionId, run.workspace) : null;
  if (summary?.ended) {
    if (summary.check) run.check = summary.check;
    if (summary.receipt && summary.endedAt && summary.receipt.ranAt <= summary.endedAt) run.checkReceipt = summary.receipt;
    if (summary.hostRefusals?.length) run.hostRefusals = summary.hostRefusals;
    const root = repoRoot(workspaceRun, run.workspace);
    const { reading } = verificationNow(root, workspaceRun);
    run.verification = { status: reading?.status ?? "unknown", reason: reading?.reason ?? "no repository verification receipt", ...(reading?.record?.ranAt ? { ranAt: reading.record.ranAt } : {}) };
    if (summary.hostRefusals?.length) { run.state = "blocked"; run.reason = `host refused a tool: ${safeReason(summary.hostRefusals[0]!)}`; }
    else if (summary.status === "ok") Object.assign(run, assessGoalPhaseRun(run, acceptedScopeDigest(goal, phase), reading));
    else {
      run.state = summary.status === "cancelled" ? "cancelled" : "failed";
      run.reason = `prior session ended ${summary.status}; review its log before continuing`;
    }
  } else {
    run.state = "interrupted";
    run.reason = run.sessionId ? "prior session ended without a final host result" : "prior coding session did not start";
  }
  run.finishedAt = new Date().toISOString();
  applyState(goal, phase, run);
  upsertGoal(goal);
  return run;
}

export async function runSavedGoalPhase(
  ctx: AppContext, out: Writable, goalId = "", resume = false, deps: GoalRunDependencies = {},
): Promise<void> {
  const cwd = normalizeWorkspace(ctx.flags.cwd);
  const first = chosenGoal(cwd, goalId || undefined);
  if (!first) { out.write("no saved goal in this workspace.\n"); return; }
  if (first.plan?.state !== "accepted") { out.write("accept the plan with /goal save before running a phase.\n"); return; }
  const selected = chosenPhase(first);
  if (!selected) { out.write("all phases are already complete.\n"); return; }
  if (ctx.flags.testCmd && ctx.flags.testCmd !== (first.plan.verification.check ?? undefined)) {
    out.write("the console check differs from the accepted plan; edit and save the plan before running.\n"); return;
  }
  const file = goalsFile();
  const attempt = newGoalPhaseRun(first, selected, cwd);
  let lease;
  try { lease = acquireGoalRunLease(file, first.id, selected.id, attempt.attemptId, resume); }
  catch (error) { out.write(`${error instanceof Error ? error.message : String(error)}\n`); return; }
  const runner = deps.workspaceRun ?? defaultRunner();
  const codeRunner = deps.codeRunner ?? cmdCode;
  const phaseId = selected.id;
  const goalIdBound = first.id;
  let controller = new AbortController();
  let controlAction: GoalRunControl | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let observedFinish = false;
  try {
    const goal = getGoalForWorkspace(goalIdBound, cwd);
    const phase = goal?.phases.find(p => p.id === phaseId);
    if (!goal || !phase || goal.plan?.state !== "accepted") throw new Error("accepted phase disappeared before launch");
    if (acceptedScopeDigest(goal, phase) !== attempt.acceptedScopeDigest) throw new Error("accepted phase changed before launch; review the saved plan and retry");
    if (activeGoalRunOwner(file, goalIdBound, phaseId)?.attemptId !== attempt.attemptId) throw new Error("phase run lease was lost");
    if (phase.run?.state === "working" && !resume) throw new Error("prior phase run needs /goal run resume; it will not be replayed automatically");
    if (resume) {
      if (!phase.run) throw new Error("there is no prior phase run to resume");
      reconcilePrior(goal, phase, runner);
      if (phase.run.state === "complete") { out.write("prior run already completed this phase; no tools replayed.\n"); return; }
      if (phase.run.acceptedScopeDigest !== acceptedScopeDigest(goal, phase)) {
        throw new Error("accepted phase scope changed since the checkpoint; start a new explicit run after review");
      }
      const expectedTree = phase.run.resulting ?? phase.run.baseline;
      const currentRoot = repoRoot(runner, cwd);
      if (expectedTree && currentRoot) {
        const currentTree = treeIdentity(runner, currentRoot);
        if (expectedTree.head !== currentTree.head || expectedTree.digest !== currentTree.digest) {
          throw new Error("workspace changed since the checkpoint; review the diff before starting a new run");
        }
      }
    }
    const previous = phase.run;
    if (previous) phase.runHistory = [...(phase.runHistory ?? []), structuredClone(previous)].slice(-8);
    const root = repoRoot(runner, cwd);
    if (root) attempt.baseline = treeIdentity(runner, root);
    phase.run = attempt;
    phase.status = "in_progress";
    phase.startedAt ??= attempt.startedAt;
    goal.activePhaseId = phaseId;
    goal.selectedPhaseId = phaseId;
    goal.status = "running";
    upsertGoal(goal); // Durable checkpoint before any model or tool call.

    timer = setInterval(() => {
      const action = readGoalRunControl(lease);
      if (action && !controller.signal.aborted) {
        controlAction = action;
        controller.abort(new DOMException(`goal phase ${action} requested`, "AbortError"));
      }
    }, deps.controlPollMs ?? 500);
    timer.unref?.();

    const options: CodeOpts = {
      local: Boolean(ctx.flags.local), pool: 5, quiet: false,
      workspaceMode: "current", signal: controller.signal, forbidPublication: true,
      testCmd: attempt.checkCommand ?? undefined,
      effort: ctx.flags.effort,
      ...(resume && previous?.sessionId ? { resume: previous.sessionId } : {}),
      runObserver: {
        started: (started: CodeRunStarted) => {
          if (!isCurrentWorkspace(started.workspace, cwd)) throw new Error("coding run moved outside the accepted workspace");
          updateAttempt(cwd, goalIdBound, phaseId, attempt.attemptId, (_goal, _phase, run) => {
            run.sessionId = started.sessionId;
            run.turnId = started.turnId;
            run.model = started.model;
            run.workspace = normalizeWorkspace(started.workspace);
            run.reason = "host coding loop is working";
          });
        },
        finished: (finished: CodeRunFinished) => {
          observedFinish = true;
          const rootNow = repoRoot(runner, cwd);
          const { reading, identity } = verificationNow(rootNow, runner);
          updateAttempt(cwd, goalIdBound, phaseId, attempt.attemptId, (liveGoal, livePhase, run) => {
            run.sessionId = finished.sessionId;
            run.turnId = finished.turnId;
            run.model = finished.model;
            run.touchedFiles = finished.touchedFiles.slice(0, 200);
            run.hostRefusals = finished.hostRefusals?.slice(0, 16) ?? [];
            run.check = { state: finished.report.check.state, exitCode: finished.report.check.exitCode, reason: finished.report.check.reason };
            if (finished.recordedCheck?.written) {
              const record = finished.recordedCheck.written;
              run.checkReceipt = { command: record.command, ranAt: record.ranAt, head: record.head, treeDigest: record.treeDigest, exitCode: record.exitCode };
            }
            run.verification = { status: reading?.status ?? "unknown", reason: reading?.reason ?? "no Git verification receipt", ...(reading?.record?.ranAt ? { ranAt: reading.record.ranAt } : {}) };
            if (identity) run.resulting = identity;
            run.finishedAt = new Date().toISOString();
            run.exitCode = finished.report.outcome.exitCode;
            const state = finished.report.outcome.state;
            if (controlAction) { run.state = controlAction === "pause" ? "paused" : "cancelled"; run.reason = `operator requested ${controlAction}; resume uses the session checkpoint`; }
            else if (run.hostRefusals.length) { run.state = "blocked"; run.reason = `host refused a tool: ${run.hostRefusals[0]}`; }
            else if (/401|auth|permission|routing refused/i.test(finished.report.outcome.message)) {
              run.state = "blocked"; run.reason = safeReason(finished.report.outcome.message);
            }
            else if (["unconfigured", "launch_failed", "timed_out"].includes(run.check.state)) {
              run.state = "verification_pending"; run.reason = run.check.reason;
            }
            else if (state === "succeeded") Object.assign(run, assessGoalPhaseRun(run, acceptedScopeDigest(liveGoal, livePhase), reading));
            else if (state === "cancelled" || state === "timed_out" || state === "incomplete") {
              run.state = "interrupted";
              run.reason = safeReason(finished.report.outcome.message || `${state} before verified completion`);
            } else {
              run.state = "failed";
              run.reason = safeReason(finished.report.outcome.message || "coding turn failed before verified completion");
            }
            applyState(liveGoal, livePhase, run);
          });
        },
      },
    };
    out.write(`Running ${goalIdBound}/${phaseId} in ${cwd}. One phase only; no publication.\n`);
    const exitCode = await codeRunner(ctx, runPrompt(goal, phase), options, runner);
    if (!observedFinish) {
      updateAttempt(cwd, goalIdBound, phaseId, attempt.attemptId, (liveGoal, livePhase, run) => {
        run.state = controlAction === "pause" ? "paused" : controlAction === "cancel" ? "cancelled" : "blocked";
        run.reason = controlAction ? `operator requested ${controlAction}` : `coding command ended before a host result (exit ${exitCode}); inspect the console and retry with /goal run resume`;
        run.exitCode = exitCode;
        run.finishedAt = new Date().toISOString();
        const currentRoot = repoRoot(runner, cwd);
        if (currentRoot) run.resulting = treeIdentity(runner, currentRoot);
        applyState(liveGoal, livePhase, run);
      });
    }
    const final = getGoalForWorkspace(goalIdBound, cwd)?.phases.find(p => p.id === phaseId)?.run;
    out.write(`Phase ${phaseId}: ${final?.state ?? "blocked"}${final?.reason ? ` — ${final.reason}` : ""}.\n`);
    if (final?.sessionId) out.write(`Session ${final.sessionId}; turn ${final.turnId ?? "unknown"}.\n`);
  } catch (error) {
    const reason = safeReason(error instanceof Error ? error.message : String(error));
    try {
      updateAttempt(cwd, goalIdBound, phaseId, attempt.attemptId, (goal, phase, run) => {
        run.state = "blocked"; run.reason = reason; run.finishedAt = new Date().toISOString();
        const currentRoot = repoRoot(runner, cwd);
        if (currentRoot) run.resulting = treeIdentity(runner, currentRoot);
        applyState(goal, phase, run);
      });
    } catch {
      if (resume) {
        const current = getGoalForWorkspace(goalIdBound, cwd);
        const prior = current?.phases.find(p => p.id === phaseId);
        if (current && prior?.run && prior.run.state !== "complete") {
          prior.run.state = "blocked";
          prior.run.reason = reason;
          applyState(current, prior, prior.run);
          upsertGoal(current);
        }
      }
    }
    out.write(`Phase run blocked: ${reason}.\n`);
  } finally {
    if (timer) clearInterval(timer);
    lease.release();
  }
}

export function controlSavedGoalPhase(ctx: AppContext, out: Writable, action: GoalRunControl, id = ""): void {
  const goal = chosenGoal(ctx.flags.cwd, id || undefined);
  const phase = goal && chosenPhase(goal);
  if (!goal || !phase?.run || phase.run.state !== "working") { out.write("no working phase run to control.\n"); return; }
  if (!activeGoalRunOwner(goalsFile(), goal.id, phase.id)) { out.write("the run is no longer live; use /goal run resume to reconcile its checkpoint.\n"); return; }
  if (requestGoalRunControl(goalsFile(), goal.id, phase.id, action, phase.run.attemptId)) out.write(`${action} requested for ${goal.id}/${phase.id}; waiting for the host loop to stop safely.\n`);
  else out.write("the phase run changed before the control request was delivered.\n");
}
