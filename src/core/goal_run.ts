// One saved phase per explicit invocation. Locks are process-wide, while the
// checkpoint lives in goals.json so a restarted console can inspect it.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { Goal, GoalPhase, GoalPhaseRun } from "./goals.js";
import type { VerificationReading } from "./verification_record.js";

export type GoalRunControl = "pause" | "cancel";
interface LockOwner { attemptId: string; pid: number; host: string; startedAt: string }

/** The goal coding action never publishes; publishing is a separate ship action. */
export function isPublicationToolCall(name: string, args: Record<string, unknown>): boolean {
  if (name !== "run_shell") return false;
  const command = args["command"];
  return typeof command === "string" && /\b(?:git\s+push|gh\s+pr\s+(?:create|merge)|(?:npm|pnpm)\s+publish|yarn\s+npm\s+publish|twine\s+upload|docker\s+push|aether\s+ship|vercel\s+deploy|kubectl\s+apply)\b/i.test(command);
}

export function acceptedScopeDigest(goal: Goal, phase: GoalPhase): string {
  return createHash("sha256").update(JSON.stringify({
    workspace: goal.cwd, objective: goal.title, phaseId: phase.id,
    title: phase.title, description: phase.description, note: phase.userNote,
    criteria: phase.completionCriteria ?? [], constraints: goal.plan?.constraints ?? [],
    check: goal.plan?.verification.check ?? null,
  })).digest("hex");
}

export function goalRunLockPath(file: string, goalId: string, phaseId: string): string {
  const key = createHash("sha256").update(`${goalId}\0${phaseId}`).digest("hex").slice(0, 24);
  return join(`${file}.runlocks`, `${key}.lock`);
}

function readOwner(path: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as LockOwner;
    return typeof value.attemptId === "string" && Number.isInteger(value.pid) && typeof value.host === "string" ? value : null;
  } catch { return null; }
}

function alive(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return true; // Never reclaim another host's lock by guessing.
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function removeIfOwned(path: string, attemptId: string): void {
  if (readOwner(path)?.attemptId === attemptId) {
    try { unlinkSync(path); } catch { /* A concurrent owner may have changed it. */ }
  }
}

function abandonedEmptyLock(path: string): boolean {
  try { return readOwner(path) === null && Date.now() - statSync(path).mtimeMs > 60_000; }
  catch { return false; }
}

export interface GoalRunLease {
  path: string;
  attemptId: string;
  release(): void;
}

/** Exclusive creation is the duplicate-start boundary across consoles. */
export function acquireGoalRunLease(file: string, goalId: string, phaseId: string, attemptId: string, recover = false): GoalRunLease {
  const path = goalRunLockPath(file, goalId, phaseId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const claim = (): boolean => {
    let fd: number;
    try { fd = openSync(path, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try { writeFileSync(fd, JSON.stringify({ attemptId, pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })); }
    finally { closeSync(fd); }
    return true;
  };
  if (!claim()) {
    const owner = readOwner(path);
    if (!recover || (owner ? alive(owner) : !abandonedEmptyLock(path))) throw new Error("this phase already has a live or unreconciled run; use /goal run resume after the prior process exits");
    // A separate recovery lock prevents two consoles from reclaiming the same
    // dead owner's file and both starting a new coding loop.
    const recovery = `${path}.recovery`;
    let fd: number;
    try { fd = openSync(recovery, "wx", 0o600); }
    catch {
      const prior = readOwner(recovery);
      if (!prior || alive(prior)) throw new Error("another console is recovering this phase");
      removeIfOwned(recovery, prior.attemptId);
      try { fd = openSync(recovery, "wx", 0o600); }
      catch { throw new Error("another console is recovering this phase"); }
    }
    try {
      try { writeFileSync(fd, JSON.stringify({ attemptId, pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })); }
      finally { closeSync(fd); }
      if (owner && readOwner(path)?.attemptId === owner.attemptId && !alive(owner)) removeIfOwned(path, owner.attemptId);
      else if (!owner && abandonedEmptyLock(path)) try { unlinkSync(path); } catch { /* Another recovery won. */ }
      if (!claim()) throw new Error("another console started this phase first");
    } finally { removeIfOwned(recovery, attemptId); }
  }
  return { path, attemptId, release: () => {
    if (readOwner(path)?.attemptId === attemptId) {
      try { unlinkSync(`${path}.control`); } catch { /* no control request */ }
      removeIfOwned(path, attemptId);
    }
  } };
}

export function activeGoalRunOwner(file: string, goalId: string, phaseId: string): LockOwner | null {
  const owner = readOwner(goalRunLockPath(file, goalId, phaseId));
  return owner && alive(owner) ? owner : null;
}

export function requestGoalRunControl(file: string, goalId: string, phaseId: string, action: GoalRunControl, attemptId: string): boolean {
  const path = goalRunLockPath(file, goalId, phaseId);
  if (readOwner(path)?.attemptId !== attemptId) return false;
  const control = `${path}.control`;
  const temporary = `${control}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ attemptId, action }), { mode: 0o600 });
  renameSync(temporary, control);
  return true;
}

export function readGoalRunControl(lease: GoalRunLease): GoalRunControl | null {
  try {
    const control = JSON.parse(readFileSync(`${lease.path}.control`, "utf8")) as { attemptId?: string; action?: string };
    return control.attemptId === lease.attemptId && (control.action === "pause" || control.action === "cancel") ? control.action : null;
  } catch { return null; }
}

/** A green command proves only criteria that explicitly name that command. */
export function unresolvedCriteria(criteria: readonly string[], checkCommand: string): string[] {
  const command = checkCommand.trim().toLowerCase();
  return criteria.filter((criterion) => {
    const text = criterion.trim().toLowerCase().replace(/[.!]$/, "");
    if (text === "result recorded" || text === "verification result recorded") return false;
    if (!command || !text.startsWith(command)) return true;
    const result = text.slice(command.length).trim();
    return !/^(?:passes|passed|succeeds|succeeded|exits 0|exited 0)(?: and (?:its )?result (?:is )?recorded)?$/.test(result);
  });
}

export function assessGoalPhaseRun(
  run: GoalPhaseRun,
  currentDigest: string,
  verification: VerificationReading | null,
): { state: GoalPhaseRun["state"]; reason: string } {
  if (currentDigest !== run.acceptedScopeDigest) return { state: "blocked", reason: "the accepted phase scope changed after this run began" };
  if (!run.checkCommand) return { state: "verification_pending", reason: "no accepted host check is configured for this phase" };
  if (run.check?.state !== "passed") return { state: run.check?.state === "failed" ? "failed" : "verification_pending", reason: run.check?.reason ?? "the host check did not run" };
  if (!verification || verification.status !== "verified" || !verification.record) {
    return { state: "verification_pending", reason: verification?.reason ?? "no attributable host verification receipt exists" };
  }
  const receipt = run.checkReceipt;
  if (!receipt || receipt.command !== run.checkCommand || receipt.ranAt < run.startedAt
    || receipt.ranAt !== verification.record.ranAt || receipt.head !== verification.record.head
    || receipt.treeDigest !== verification.record.treeDigest || receipt.exitCode !== 0) {
    return { state: "verification_pending", reason: "the verification receipt is not from this accepted phase run" };
  }
  const unresolved = unresolvedCriteria(run.criteria, run.checkCommand);
  if (unresolved.length) return { state: "verification_pending", reason: `host verification cannot certify: ${unresolved.join("; ")}` };
  return { state: "complete", reason: `${run.checkCommand} passed for the current working tree and the accepted criteria` };
}

export function newGoalPhaseRun(goal: Goal, phase: GoalPhase, workspace: string): GoalPhaseRun {
  return {
    attemptId: randomUUID(), state: "working", reason: "coding turn is starting",
    startedAt: new Date().toISOString(), workspace,
    checkCommand: goal.plan?.verification.check ?? null,
    acceptedScopeDigest: acceptedScopeDigest(goal, phase),
    criteria: [...(phase.completionCriteria ?? [])],
  };
}
