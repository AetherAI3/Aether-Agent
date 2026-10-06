// goals.ts — persistent goal chain for the terminal agent.
// Mirrors AetherCloud desktop task-chain model, adapted for file-based CLI.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { isCurrentWorkspace, normalizeWorkspace } from "./workspace_scope.js";

// ── Types ───────────────────────────────────────────────────────────

export type PhaseStatus = "pending" | "in_progress" | "complete" | "failed" | "skipped";
export type GoalStatus = "idle" | "manual" | "running" | "paused" | "blocked" | "verification_pending" | "complete" | "halted" | "failed";
export type TaskMiniStatus = "queued" | "running" | "complete" | "failed" | "skipped";

export interface GoalTask {
  id: string;
  title: string;
  status: TaskMiniStatus;
}

export interface GoalPhase {
  id: string;
  title: string;
  description: string;
  status: PhaseStatus;
  tasks: GoalTask[];
  userNote: string;
  /** User-accepted conditions for declaring this phase complete. */
  completionCriteria?: string[];
  /** A manual mark is never presented as host-verified work. */
  completionMethod?: "manual" | "verified";
  /** The latest explicit coding attempt and its durable host receipts. */
  run?: GoalPhaseRun;
  /** Prior attempts remain available when an interrupted phase is resumed. */
  runHistory?: GoalPhaseRun[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface GoalPhaseRun {
  attemptId: string;
  state: "working" | "blocked" | "verification_pending" | "failed" | "complete" | "paused" | "cancelled" | "interrupted";
  reason: string;
  startedAt: string;
  finishedAt?: string;
  sessionId?: string;
  turnId?: string;
  model?: string;
  workspace: string;
  checkCommand: string | null;
  acceptedScopeDigest: string;
  criteria: string[];
  baseline?: { head: string | null; digest: string };
  resulting?: { head: string | null; digest: string };
  touchedFiles?: string[];
  hostRefusals?: string[];
  check?: { state: string; exitCode: number | null; reason: string };
  verification?: { status: "verified" | "failed" | "stale" | "unknown"; reason: string; ranAt?: string };
  checkReceipt?: { command: string; ranAt: string; head: string | null; treeDigest: string; exitCode: number };
  exitCode?: number;
}

export interface Goal {
  id: string;
  title: string;
  phases: GoalPhase[];
  status: GoalStatus;
  activePhaseId?: string;
  selectedPhaseId?: string;
  createdAt: string;
  completedAt?: string;
  cwd?: string;
  /** Absent on plans saved before editable authoring was introduced. */
  plan?: GoalPlan;
}

export interface GoalPlan {
  state: "draft" | "accepted";
  source: "repository" | "model" | "manual";
  stack: string[];
  relevantFiles: string[];
  checks: string[];
  instructions: string[];
  assumptions: string[];
  constraints: string[];
  verification: { state: "known" | "unresolved"; check: string | null };
  acceptedAt?: string;
}

// ── Store ────────────────────────────────────────────────────────────

export function goalsFile(): string {
  return process.env["AETHER_GOALS_FILE"] ?? join(homedir(), ".config", "aether", "goals.json");
}

function ensureDir(file: string): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export type GoalStoreStatus = "missing" | "ok" | "corrupt" | "unreadable";
export interface GoalStoreState { status: GoalStoreStatus; goals: Goal[] }

export function readGoals(file: string = goalsFile()): GoalStoreState {
  if (!existsSync(file)) return { status: "missing", goals: [] };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { status: "unreadable", goals: [] };
  }
  try {
    if (!raw.trim()) return { status: "corrupt", goals: [] };
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? { status: "ok", goals: parsed as Goal[] }
      : { status: "corrupt", goals: [] };
  } catch {
    return { status: "corrupt", goals: [] };
  }
}

export function loadGoals(file: string = goalsFile()): Goal[] {
  return readGoals(file).goals;
}

function mutableGoals(file: string): Goal[] {
  const state = readGoals(file);
  if (state.status === "corrupt" || state.status === "unreadable") {
    throw new Error(
      `goal store is ${state.status}; refusing to overwrite it at ${file} — inspect/repair the file by hand before retrying`,
    );
  }
  return state.goals;
}

function saveGoals(goals: Goal[], file: string): void {
  ensureDir(file);
  // Write-then-rename so a killed/interrupted process can never leave a torn
  // goals.json — mirrors mcp_store.ts's atomic write pattern.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(goals, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

export function upsertGoal(goal: Goal, file: string = goalsFile()): void {
  const all = mutableGoals(file);
  const idx = all.findIndex((g) => g.id === goal.id);
  if (idx >= 0) all[idx] = goal;
  else all.push(goal);
  saveGoals(all, file);
}

export function deleteGoal(id: string, file: string = goalsFile()): void {
  const all = mutableGoals(file).filter((g) => g.id !== id);
  saveGoals(all, file);
}

export function getGoal(id: string, file: string = goalsFile()): Goal | undefined {
  return loadGoals(file).find((g) => g.id === id);
}

/** Legacy (pre-workspace-scoping) goals have no `cwd` and are excluded by default. */
export interface WorkspaceGoalOptions {
  /** Surface legacy cwd-less goals instead of leaving them silently unreachable. Off by default. */
  includeUnscoped?: boolean;
}

export function getGoalForWorkspace(
  id: string,
  cwd: string,
  file: string = goalsFile(),
  options: WorkspaceGoalOptions = {},
): Goal | undefined {
  const goal = getGoal(id, file);
  if (!goal) return undefined;
  if (isCurrentWorkspace(goal.cwd, cwd)) return goal;
  return options.includeUnscoped && goal.cwd == null ? goal : undefined;
}

export function goalsForWorkspace(
  cwd: string,
  file: string = goalsFile(),
  options: WorkspaceGoalOptions = {},
): Goal[] {
  return loadGoals(file).filter(
    (goal) => isCurrentWorkspace(goal.cwd, cwd) || (options.includeUnscoped === true && goal.cwd == null),
  );
}

export function getActiveGoal(cwd: string, file: string = goalsFile()): Goal | undefined {
  const goals = goalsForWorkspace(cwd, file);
  return goals.find((g) => g.status === "running")
    ?? goals.find((g) => ["manual", "paused", "blocked", "verification_pending"].includes(g.status));
}

export function newGoal(title: string, cwd: string): Goal {
  return {
    id: `goal_${randomUUID().slice(0, 8)}`,
    title,
    cwd: normalizeWorkspace(cwd),
    phases: [],
    status: "idle",
    createdAt: new Date().toISOString(),
  };
}

export function newPhase(idx: number, title: string, description: string): GoalPhase {
  return {
    id: `phase-${idx}`,
    title,
    description,
    status: "pending",
    tasks: [],
    userNote: "",
    completionCriteria: [],
    createdAt: new Date().toISOString(),
  };
}

export function newTask(title: string): GoalTask {
  return { id: `t_${randomUUID().slice(0, 6)}`, title, status: "queued" };
}

function cloneGoal(goal: Goal): Goal {
  return JSON.parse(JSON.stringify(goal)) as Goal;
}

export function selectPhase(goal: Goal, phaseId: string): Goal {
  const copy = cloneGoal(goal);
  copy.selectedPhaseId = phaseId;
  return copy;
}

export function setPhaseNote(goal: Goal, phaseId: string, note: string): Goal {
  const copy = cloneGoal(goal);
  const phase = copy.phases.find((p) => p.id === phaseId);
  if (phase) phase.userNote = note;
  return copy;
}

export function startGoal(goal: Goal): Goal {
  const copy = cloneGoal(goal);
  copy.status = "manual";
  const first = copy.phases.find((p) => p.status === "pending");
  if (first) {
    first.status = "in_progress";
    first.startedAt = new Date().toISOString();
    copy.activePhaseId = first.id;
    copy.selectedPhaseId = first.id;
  }
  return copy;
}

export function completePhase(goal: Goal, phaseId: string): Goal {
  const copy = cloneGoal(goal);
  const phase = copy.phases.find((p) => p.id === phaseId);
  if (!phase || phase.run?.state === "working") return copy;
  phase.status = "complete";
  phase.completionMethod = "manual";
  phase.completedAt = new Date().toISOString();
  if (copy.phases.every((p) => p.status === "complete")) {
    copy.status = "complete";
    copy.completedAt = new Date().toISOString();
  } else copy.status = "idle";
  copy.activePhaseId = undefined;
  return copy;
}
