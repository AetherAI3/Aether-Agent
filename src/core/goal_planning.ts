// Bounded, read-only repository evidence for editable goal drafts.
// A model suggestion is optional; no planning path runs tools or a shell.
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { newGoal, newPhase, type Goal, type GoalPhase, type GoalPlan } from "./goals.js";
import { normalizeWorkspace } from "./workspace_scope.js";

export interface RepositoryFacts {
  stack: string[];
  relevantFiles: string[];
  checks: string[];
  instructions: string[];
  observations: string[];
}

export interface SuggestedPhase {
  title: string;
  description: string;
  criteria: string[];
  note?: string;
}
export interface PlannerSuggestion { phases: SuggestedPhase[]; assumptions?: string[] }
export type GoalPlanner = (objective: string, facts: Readonly<RepositoryFacts>) => Promise<PlannerSuggestion>;

const SKIP = new Set([".git", "node_modules", ".venv", "venv", "dist", "build", "__pycache__", ".next", ".turbo", "coverage"]);
const ROOTS = new Set(["src", "test", "tests", "app", "lib", "packages"]);
const STOP = new Set(["about", "adding", "after", "against", "application", "before", "change", "dependencies", "existing", "failing", "file", "files", "from", "have", "into", "make", "new", "only", "repo", "repository", "should", "test", "tests", "this", "with", "without", "would", "your"]);
const MAX_DIRECTORIES = 18;
const MAX_ENTRIES = 420;
const MAX_FILE_BYTES = 64 * 1024;

function smallText(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      const length = readSync(fd, bytes, 0, bytes.length, 0);
      return length > MAX_FILE_BYTES ? null : bytes.toString("utf8", 0, length);
    } finally { closeSync(fd); }
  } catch { return null; }
}

function objectiveTerms(objective: string): string[] {
  return [...new Set((objective.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [])
    .filter((term) => !STOP.has(term) && !["app", "ship", "full", "stack", "backend", "frontend", "auth", "deploy"].includes(term)))].slice(0, 12);
}

/** Bounded to shallow workspace entries; symlinks and heavy folders are never followed. */
export function inspectGoalRepository(cwd: string, objective: string): RepositoryFacts {
  const root = normalizeWorkspace(cwd);
  const facts: RepositoryFacts = { stack: [], relevantFiles: [], checks: [], instructions: [], observations: [] };
  const names: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let visited = 0;
  let entries = 0;
  while (queue.length && visited < MAX_DIRECTORIES && entries < MAX_ENTRIES) {
    const current = queue.shift()!;
    visited++;
    let dir;
    try { dir = opendirSync(current.path); } catch {
      facts.observations.push(`Could not inspect ${relative(root, current.path) || "workspace"}; repository facts may be incomplete.`);
      continue;
    }
    try {
      let item;
      while (entries < MAX_ENTRIES && (item = dir.readSync())) {
        entries++;
        if (item.isSymbolicLink() || SKIP.has(item.name) || item.name.startsWith(".")) continue;
        const path = join(current.path, item.name);
        const rel = relative(root, path).replaceAll("\\", "/");
        if (item.isFile()) names.push(rel);
        else if (item.isDirectory() && current.depth < 2 && (current.depth > 0 || ROOTS.has(item.name))) {
          queue.push({ path, depth: current.depth + 1 });
        }
      }
    } catch {
      facts.observations.push(`Could not finish inspecting ${relative(root, current.path) || "workspace"}; repository facts may be incomplete.`);
    } finally { try { dir.closeSync(); } catch { /* Directory may already be closed. */ } }
  }
  const terms = objectiveTerms(objective);
  facts.relevantFiles = names.filter((name) => terms.some((term) => basename(name).toLowerCase().includes(term)))
    .sort().slice(0, 12);
  for (const name of ["AGENTS.md", "CLAUDE.md"]) if (names.includes(name)) facts.instructions.push(name);

  if (names.includes("package.json")) {
    const raw = smallText(join(root, "package.json"));
    if (raw) {
      try {
        const pkg = JSON.parse(raw) as Record<string, unknown>;
        const manager = names.includes("pnpm-lock.yaml") ? "pnpm" : names.includes("yarn.lock") ? "yarn" : "npm";
        facts.stack.push("Node.js");
        const deps = { ...asRecord(pkg["dependencies"]), ...asRecord(pkg["devDependencies"]) };
        if ("typescript" in deps || names.includes("tsconfig.json")) facts.stack.push("TypeScript");
        for (const framework of ["react", "next", "vue", "svelte", "express", "fastify"]) {
          if (framework in deps) facts.stack.push(framework);
        }
        const scripts = asRecord(pkg["scripts"]);
        for (const [key, value] of Object.entries(scripts).slice(0, 60)) {
          if (typeof value !== "string" || value.length > 512) continue;
          if (/^(test|check|typecheck|lint|build)(:|$)/.test(key)) {
            facts.checks.push(key === "test" && manager === "npm" ? "npm test" : `${manager} run ${key}`);
          }
        }
      } catch { facts.observations.push("package.json could not be parsed; stack and checks remain uncertain."); }
    } else facts.observations.push("package.json could not be read within the planning size limit.");
  }
  if (names.includes("pyproject.toml") || names.includes("requirements.txt")) facts.stack.push("Python");
  if (names.includes("Cargo.toml")) { facts.stack.push("Rust"); facts.checks.push("cargo test"); }
  if (names.includes("go.mod")) { facts.stack.push("Go"); facts.checks.push("go test ./..."); }
  if (names.includes("Makefile")) {
    const makefile = smallText(join(root, "Makefile"));
    if (makefile && /^test\s*:/m.test(makefile)) facts.checks.push("make test");
  }
  facts.stack = [...new Set(facts.stack)];
  facts.checks = [...new Set(facts.checks)].slice(0, 12);
  if (facts.stack.length === 0) facts.observations.push("Stack not identified from bounded repository manifests.");
  if (facts.checks.length === 0) facts.observations.push("No existing verification command was identified.");
  if (facts.relevantFiles.length === 0) facts.observations.push("Relevant files were not identified from shallow filenames; inspect before editing.");
  if (entries === 0) facts.observations.push("Workspace appears empty or inaccessible.");
  if (entries >= MAX_ENTRIES || visited >= MAX_DIRECTORIES) facts.observations.push("Repository listing was bounded; additional files may exist.");
  return facts;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function objectiveConstraints(objective: string): string[] {
  const matched = objective.match(/\b(?:no\s+(?:new|additional)\s+[^,;.]+|do\s+not\s+[^,;.]+|don't\s+[^,;.]+|without\s+[^,;.]+|avoid\s+[^,;.]+)/gi) ?? [];
  return [...new Set(matched.map((item) => item.trim()))].slice(0, 8);
}

function preferredCheck(checks: readonly string[], objective: string): string | null {
  const terms = objectiveTerms(objective);
  return checks.find((check) => terms.some((term) => check.toLowerCase().includes(term)))
    ?? checks.find((check) => /\btest\b|run test/.test(check))
    ?? checks[0] ?? null;
}

function repositoryPhases(objective: string, facts: RepositoryFacts, constraints: readonly string[], check: string | null): SuggestedPhase[] {
  const files = facts.relevantFiles.length ? facts.relevantFiles.join(", ") : "relevant files still to be identified";
  return [
    {
      title: "Address the stated objective",
      description: `Work from the existing repository (${files}). Objective: ${objective}`,
      criteria: ["The requested behavior is addressed in the existing repository.",
        ...(constraints.length ? [`The change respects: ${constraints.join("; ")}.`] : [])],
    },
    {
      title: check ? "Verify with an existing check" : "Resolve verification",
      description: check ? `Use the repository's existing check: ${check}.` : "No verification command was identified from bounded repository facts.",
      criteria: [check ? `${check} passes and its result is recorded.`
        : "Choose and record an appropriate verification check and expected result before marking this phase complete."],
    },
  ];
}

function boundedSuggestion(suggestion: PlannerSuggestion): SuggestedPhase[] {
  if (!Array.isArray(suggestion.phases) || suggestion.phases.length === 0 || suggestion.phases.length > 6) throw new Error("planner returned an invalid phase count");
  return suggestion.phases.map((phase) => {
    if (typeof phase.title !== "string" || !phase.title.trim() || phase.title.length > 120
      || typeof phase.description !== "string" || phase.description.length > 1000
      || !Array.isArray(phase.criteria) || phase.criteria.length > 6
      || phase.criteria.some((criterion) => typeof criterion !== "string" || criterion.length > 240)) {
      throw new Error("planner returned invalid phase text");
    }
    return { title: phase.title.trim(), description: phase.description.trim(),
      criteria: phase.criteria.map((criterion) => criterion.trim()).filter(Boolean),
      ...(typeof phase.note === "string" ? { note: phase.note.slice(0, 500) } : {}) };
  });
}

/** Draft only. Callers must show/edit/confirm before writing it to the goal store. */
export async function draftGoalPlan(objective: string, cwd: string, planner?: GoalPlanner): Promise<Goal> {
  const title = objective.trim();
  if (!title || title.length > 4000) throw new Error("goal objective must be 1–4000 characters");
  const facts = inspectGoalRepository(cwd, title);
  const constraints = objectiveConstraints(title);
  const check = preferredCheck(facts.checks, title);
  const assumptions = [...facts.observations];
  if (facts.instructions.length) assumptions.push(`Repository instructions present (${facts.instructions.join(", ")}); review them before execution.`);
  let source: GoalPlan["source"] = facts.stack.length || facts.relevantFiles.length ? "repository" : "manual";
  let suggested = repositoryPhases(title, facts, constraints, check);
  if (planner) {
    try {
      const proposal = await planner(title, facts);
      suggested = boundedSuggestion(proposal);
      assumptions.push(...(proposal.assumptions ?? []).filter((item) => typeof item === "string").slice(0, 8).map((item) => item.slice(0, 300)));
      source = "model";
    } catch {
      assumptions.push("Planning model unavailable or returned an invalid draft; edit this repository-based plan manually.");
    }
  } else assumptions.push("No planning model was used; this is editable planning text, not executed work.");
  const goal = newGoal(title, cwd);
  goal.phases = suggested.map((item, idx): GoalPhase => {
    const phase = newPhase(idx + 1, item.title, item.description);
    phase.completionCriteria = item.criteria;
    phase.userNote = item.note ?? "";
    return phase;
  });
  goal.selectedPhaseId = goal.phases[0]?.id;
  goal.plan = {
    state: "draft", source, stack: facts.stack, relevantFiles: facts.relevantFiles,
    checks: facts.checks, instructions: facts.instructions, assumptions,
    constraints, verification: { state: check ? "known" : "unresolved", check },
  };
  return goal;
}

export function validateGoalDraft(goal: Goal): string[] {
  const issues: string[] = [];
  if (!goal.plan) issues.push("plan metadata is missing");
  if (goal.phases.length < 1 || goal.phases.length > 6) issues.push("plan needs 1–6 phases");
  for (const phase of goal.phases) {
    if (!phase.title.trim()) issues.push(`${phase.id} needs a title`);
    if (!phase.completionCriteria?.length || phase.completionCriteria.some((criterion) => !criterion.trim())) {
      issues.push(`${phase.id} needs explicit completion criteria`);
    }
  }
  return issues;
}

export function acceptedGoal(goal: Goal): Goal {
  const issues = validateGoalDraft(goal);
  if (issues.length) throw new Error(issues.join("; "));
  const copy = JSON.parse(JSON.stringify(goal)) as Goal;
  copy.plan = { ...copy.plan!, state: "accepted", acceptedAt: new Date().toISOString() };
  return copy;
}

export function renumberPhases(goal: Goal): void {
  const active = goal.phases.find((phase) => phase.id === goal.activePhaseId);
  const selected = goal.phases.find((phase) => phase.id === goal.selectedPhaseId);
  goal.phases.forEach((phase, idx) => { phase.id = `phase-${idx + 1}`; });
  goal.activePhaseId = active?.id;
  goal.selectedPhaseId = selected?.id ?? goal.phases[0]?.id;
}
