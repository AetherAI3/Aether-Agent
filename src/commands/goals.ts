// goals.ts — slash command handlers for /goal and /goals.
// Called from slash.ts when the user types /goal or /goals.

import type { Writable } from "node:stream";
import type { AppContext } from "../core/context.js";
import {
  goalsForWorkspace, getGoalForWorkspace, getActiveGoal, newPhase,
  upsertGoal, startGoal, completePhase,
  setPhaseNote, type Goal,
} from "../core/goals.js";
import { acceptedGoal, draftGoalPlan, renumberPhases, validateGoalDraft } from "../core/goal_planning.js";
import { acceptedScopeDigest } from "../core/goal_run.js";
import { renderGoalChain, renderPhaseDetail } from "../ui/goal_chain.js";
import { resolve } from "node:path";

const cols = () => process.stdout.columns || 100;

function resolveGoal(cwd: string, id?: string): Goal | undefined {
  return id ? getGoalForWorkspace(id, cwd) : getActiveGoal(cwd) ?? goalsForWorkspace(cwd)[0];
}

// Drafts are deliberately kept out of the goal store until /goal save.
const drafts = new Map<string, Goal>();
const draftKey = (cwd: string) => resolve(cwd);
const draftFor = (cwd: string) => drafts.get(draftKey(cwd));
const safe = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

function showPlan(out: Writable, goal: Goal): void {
  const plan = goal.plan;
  out.write(`\n${!plan ? "Legacy saved goal" : plan.state === "accepted" ? "Saved plan" : "Unsaved draft"}: ${safe(goal.title)}\n`);
  if (plan) {
    out.write(`Source: ${plan.source}; stack: ${safe(plan.stack.join(", ") || "unknown")}\n`);
    out.write(`Relevant files: ${safe(plan.relevantFiles.join(", ") || "none identified")}\n`);
    out.write(`Available checks: ${safe(plan.checks.join(", ") || "none identified")}\n`);
    for (const item of plan.instructions) out.write(`Repository instruction: ${safe(item)}\n`);
    for (const item of plan.constraints) out.write(`Constraint: ${safe(item)}\n`);
    for (const item of plan.assumptions) out.write(`Assumption: ${safe(item)}\n`);
    out.write(`Verification: ${plan.verification.state === "known" ? safe(plan.verification.check ?? "") : "unresolved; choose a check before claiming completion"}\n`);
  }
  for (const [index, phase] of goal.phases.entries()) {
    out.write(`${index + 1}. ${safe(phase.title)}\n`);
    if (phase.description) out.write(`   ${safe(phase.description)}\n`);
    for (const criterion of phase.completionCriteria ?? []) out.write(`   Done when: ${safe(criterion)}\n`);
    if (phase.userNote) out.write(`   Note: ${safe(phase.userNote)}\n`);
    if (phase.completionMethod) out.write(`   Completion: ${phase.completionMethod === "manual" ? "manually marked; tests not certified" : "host verified"}\n`);
    if (phase.run) {
      out.write(`   Run: ${phase.run.state} — ${safe(phase.run.reason)}\n`);
      if (phase.run.sessionId) out.write(`   Session ${safe(phase.run.sessionId)}; turn ${safe(phase.run.turnId ?? "unknown")}\n`);
      if (phase.run.check) out.write(`   Host check: ${safe(phase.run.check.state)} — ${safe(phase.run.check.reason)}\n`);
      if (phase.run.verification) out.write(`   Tree receipt: ${safe(phase.run.verification.status)} — ${safe(phase.run.verification.reason)}\n`);
      if (phase.run.baseline && phase.run.resulting) out.write(`   Diff receipt: ${phase.run.baseline.digest.slice(0, 12)} → ${phase.run.resulting.digest.slice(0, 12)} (${phase.run.baseline.digest === phase.run.resulting.digest ? "no tree change" : "working tree changed"})\n`);
      if (phase.run.touchedFiles?.length) out.write(`   Files touched: ${safe(phase.run.touchedFiles.join(", "))}\n`);
    }
  }
  out.write("Planning does not execute work; /goal run starts one saved phase.\n\n");
}

function phaseAt(goal: Goal, ordinal: string) {
  const n = Number(ordinal);
  return Number.isInteger(n) && n >= 1 ? goal.phases[n - 1] : undefined;
}

function modifyDraft(cwd: string, out: Writable, subcmd: string, rest: string): boolean {
  const goal = draftFor(cwd);
  if (!goal) { out.write("no draft. create one with /goal <objective> or reopen with /goal edit [id].\n"); return false; }
  const [action, ...words] = rest.trim().split(/\s+/);
  const args = words.join(" ");
  if (subcmd === "phase") {
    if (action === "add" && args) {
      const phase = newPhase(goal.phases.length + 1, args, "");
      phase.completionCriteria = [];
      goal.phases.push(phase);
    } else if (action === "remove" && phaseAt(goal, args) && goal.phases.length > 1) {
      goal.phases.splice(Number(args) - 1, 1);
    } else if (action === "move") {
      const [from, to] = args.split(/\s+/).map(Number);
      if (!from || !to || !phaseAt(goal, String(from)) || !phaseAt(goal, String(to))) { out.write("usage: /goal phase move <from> <to>\n"); return false; }
      goal.phases.splice(to - 1, 0, goal.phases.splice(from - 1, 1)[0]!);
    } else if ((action === "title" || action === "describe") && args) {
      const [ordinal, ...text] = args.split(/\s+/);
      const phase = phaseAt(goal, ordinal ?? "");
      if (!phase || !text.length) { out.write(`usage: /goal phase ${action} <number> <text>\n`); return false; }
      if (action === "title") phase.title = text.join(" ");
      else phase.description = text.join(" ");
    } else { out.write("usage: /goal phase <add|remove|move|title|describe> ...\n"); return false; }
    renumberPhases(goal);
  } else if (subcmd === "criteria" || subcmd === "note") {
    const [ordinal, ...text] = rest.trim().split(/\s+/);
    const phase = phaseAt(goal, ordinal ?? "");
    if (!phase || !text.length) { out.write(`usage: /goal ${subcmd} <number> <text>\n`); return false; }
    if (subcmd === "note") phase.userNote = text.join(" ");
    else phase.completionCriteria = text.join(" ").split(";").map(x => x.trim()).filter(Boolean);
  }
  drafts.set(draftKey(cwd), goal);
  showPlan(out, goal);
  return true;
}

// ── Handlers ──────────────────────────────────────────────────────────

/** Natural objective text is the default; only these explicit words are commands. */
export async function handleGoalInput(ctx: AppContext, out: Writable, input: string): Promise<void> {
  const [first, ...remaining] = input.trim().split(/\s+/);
  const commands = new Set(["draft", "edit", "phase", "criteria", "save", "discard", "run", "start", "pause", "resume", "cancel", "complete", "note", "view"]);
  const command = first?.toLowerCase() ?? "";
  if (commands.has(command)) await handleGoal(ctx, out, command, remaining.join(" "));
  else await handleGoal(ctx, out, "", input);
}

export async function handleGoal(
  ctx: AppContext, out: Writable, subcmd: string, rest: string,
): Promise<void> {
  const c = cols();

  switch (subcmd) {
    case "": {
      if (!rest.trim()) {
        const draft = draftFor(ctx.flags.cwd);
        if (draft) showPlan(out, draft);
        else out.write("usage: /goal <objective> (draft a plan); /goal save to accept it\n");
        return;
      }
      const goal = await draftGoalPlan(rest.trim(), ctx.flags.cwd);
      drafts.set(draftKey(ctx.flags.cwd), goal);
      showPlan(out, goal);
      out.write("Edit with /goal phase, /goal criteria, or /goal note; accept with /goal save.\n");
      break;
    }

    case "draft": {
      if (rest.trim()) return handleGoal(ctx, out, "", rest);
      const draft = draftFor(ctx.flags.cwd);
      if (draft) showPlan(out, draft);
      else out.write("no draft. use /goal <objective>.\n");
      break;
    }

    case "edit": {
      const original = resolveGoal(ctx.flags.cwd, rest.trim());
      if (!original) { out.write("no saved goal found.\n"); return; }
      const draft = structuredClone(original);
      draft.plan = { state: "draft", source: "manual", stack: original.plan?.stack ?? [], relevantFiles: original.plan?.relevantFiles ?? [], checks: original.plan?.checks ?? [], instructions: original.plan?.instructions ?? [], assumptions: original.plan?.assumptions ?? ["This saved goal predates the plan contract; review its phases and criteria."], constraints: original.plan?.constraints ?? [], verification: original.plan?.verification ?? { state: "unresolved", check: null } };
      drafts.set(draftKey(ctx.flags.cwd), draft);
      showPlan(out, draft);
      break;
    }

    case "phase":
    case "criteria":
      modifyDraft(ctx.flags.cwd, out, subcmd, rest);
      break;

    case "save": {
      const draft = draftFor(ctx.flags.cwd);
      if (!draft) { out.write("no draft to save.\n"); return; }
      const issues = validateGoalDraft(draft);
      if (issues.length) { out.write(`cannot save: ${issues.join("; ")}\n`); return; }
      showPlan(out, draft);
      const ok = ctx.flags.yes || await ctx.confirm(`Save this ${draft.phases.length}-phase plan? [y/N] `);
      if (!ok) { out.write("draft kept; no saved plan changed.\n"); return; }
      const saved = acceptedGoal(draft);
      const previous = getGoalForWorkspace(saved.id, ctx.flags.cwd);
      if (previous?.phases.some(p => p.run?.state === "working")) {
        out.write("a phase run is still working; pause or cancel it before changing the accepted plan.\n"); return;
      }
      let invalidated = false;
      if (previous) for (const phase of saved.phases) {
        const old = previous.phases.find(p => p.id === phase.id);
        if (old && acceptedScopeDigest(previous, old) !== acceptedScopeDigest(saved, phase)) {
          if (phase.run) phase.runHistory = [...(phase.runHistory ?? []), phase.run].slice(-8);
          phase.run = undefined;
          phase.completionMethod = undefined;
          phase.status = "pending";
          phase.completedAt = undefined;
          invalidated = true;
        }
      }
      if (invalidated) { saved.status = "idle"; saved.activePhaseId = undefined; saved.completedAt = undefined; }
      upsertGoal(saved);
      drafts.delete(draftKey(ctx.flags.cwd));
      out.write(`Plan accepted and saved: ${saved.id}. Reopen with /goal edit ${saved.id}.\n`);
      break;
    }

    case "discard":
      drafts.delete(draftKey(ctx.flags.cwd));
      out.write("draft discarded; saved goals unchanged.\n");
      break;

    case "run": {
      const [action, id] = rest.trim().split(/\s+/);
      const { runSavedGoalPhase, controlSavedGoalPhase } = await import("./goal_run.js");
      if (action === "pause" || action === "cancel") controlSavedGoalPhase(ctx, out, action, id ?? "");
      else if (action === "resume") await runSavedGoalPhase(ctx, out, id ?? "", true);
      else if (action && !id) await runSavedGoalPhase(ctx, out, action);
      else if (!action) await runSavedGoalPhase(ctx, out);
      else out.write("usage: /goal run [goal-id] | /goal run <resume|pause|cancel> [goal-id]\n");
      break;
    }

    case "start": {
      const id = rest.trim();
      const goal = resolveGoal(ctx.flags.cwd, id);
      if (!goal) { out.write("no goals found. create one first: /goal <description>\n"); return; }
      if (goal.status === "running") { out.write(`already running: ${goal.id}\n`); return; }
      if (goal.phases.every(p => p.status === "complete")) { out.write("all phases are already complete.\n"); return; }
      const started = startGoal(goal);
      upsertGoal(started);
      out.write(`Manual tracking started: ${started.id}. No coding run launched; use /goal run.\n`);
      for (const l of renderGoalChain(started, c)) out.write("  " + l + "\n");
      break;
    }

    case "pause": {
      const goal = getActiveGoal(ctx.flags.cwd);
      if (!goal) { out.write("no active goal to pause.\n"); return; }
      if (goal.phases.find(p => p.id === goal.activePhaseId)?.run?.state === "working") {
        const { controlSavedGoalPhase } = await import("./goal_run.js");
        controlSavedGoalPhase(ctx, out, "pause", goal.id);
        return;
      }
      goal.status = "paused";
      upsertGoal(goal);
      out.write("Goal paused.\n");
      break;
    }

    case "resume": {
      const goal = getActiveGoal(ctx.flags.cwd);
      if (!goal) { out.write("no paused goal to resume.\n"); return; }
      if (["paused", "interrupted", "cancelled", "blocked"].includes(goal.phases.find(p => p.id === goal.activePhaseId)?.run?.state ?? "")) {
        const { runSavedGoalPhase } = await import("./goal_run.js");
        await runSavedGoalPhase(ctx, out, goal.id, true);
        return;
      }
      goal.status = "manual";
      upsertGoal(goal);
      out.write("Manual tracking resumed; no coding run launched.\n");
      break;
    }

    case "cancel": {
      const goal = getActiveGoal(ctx.flags.cwd);
      if (!goal) { out.write("no active goal to cancel.\n"); return; }
      if (goal.phases.find(p => p.id === goal.activePhaseId)?.run?.state === "working") {
        const { controlSavedGoalPhase } = await import("./goal_run.js");
        controlSavedGoalPhase(ctx, out, "cancel", goal.id);
        return;
      }
      const ok = ctx.flags.yes || (await ctx.confirm("Cancel this goal? [y/N] "));
      if (!ok) { out.write("kept.\n"); return; }
      goal.status = "halted";
      upsertGoal(goal);
      out.write("Goal cancelled.\n");
      break;
    }

    case "complete": {
      const active = getActiveGoal(ctx.flags.cwd);
      if (!active) { out.write("no active goal.\n"); return; }
      const phaseId = rest.trim() || active.activePhaseId || "";
      if (!phaseId) { out.write("usage: /goal complete <phase-id>\n"); return; }
      const phase = active.phases.find(p => p.id === phaseId);
      if (!phase) { out.write("no such phase in the active goal.\n"); return; }
      if (phase.status === "complete") { out.write("phase is already complete.\n"); return; }
      if (phase.run?.state === "working") { out.write("a coding run is still working; pause or cancel it first.\n"); return; }
      const updated = completePhase(active, phaseId);
      upsertGoal(updated);
      out.write("Phase marked complete manually; this does not certify tests. Next phase needs a separate /goal run.\n");
      for (const l of renderGoalChain(updated, c)) out.write("  " + l + "\n");
      break;
    }

    case "note": {
      if (draftFor(ctx.flags.cwd)) { modifyDraft(ctx.flags.cwd, out, "note", rest); return; }
      const parts = rest.trim().split(/\s+(.*)/s);
      const phaseId = parts[0] ?? "";
      const note = parts[1] ?? "";
      if (!phaseId || !note) { out.write("usage: /goal note <phase-id> <note text>\n"); return; }
      const active = resolveGoal(ctx.flags.cwd);
      if (!active) { out.write("no goal to add note to.\n"); return; }
      const updated = setPhaseNote(active, phaseId, note);
      upsertGoal(updated);
      out.write(`Note added to ${phaseId}.\n`);
      break;
    }

    case "view": {
      const id = rest.trim();
      const goal = resolveGoal(ctx.flags.cwd, id);
      if (!goal) { out.write("no goals found.\n"); return; }
      out.write("\n");
      for (const l of renderGoalChain(goal, c)) out.write("  " + l + "\n");
      for (const l of renderPhaseDetail(goal, c)) out.write("  " + l + "\n");
      showPlan(out, goal);
      out.write("\n");
      break;
    }

    default:
      out.write(`unknown /goal subcommand: ${subcmd}\n`);
      out.write("try: /goal <objective>, /goal phase ..., /goal criteria ..., /goal save, /goal view\n");
  }
}

export async function handleGoals(
  ctx: AppContext, out: Writable, rest: string,
): Promise<void> {
  const goals = goalsForWorkspace(ctx.flags.cwd);
  const c = cols();

  if (rest.trim()) {
    // /goals <id> — show that goal in detail
    const goal = getGoalForWorkspace(rest.trim(), ctx.flags.cwd);
    if (!goal) { out.write(`no goal found: ${rest.trim()}\n`); return; }
    for (const l of renderGoalChain(goal, c)) out.write("  " + l + "\n");
    for (const l of renderPhaseDetail(goal, c)) out.write("  " + l + "\n");
    showPlan(out, goal);
    return;
  }

  if (goals.length === 0) {
    out.write("(no goals yet)\n");
    out.write("draft one: /goal <objective>\n");
    return;
  }

  out.write(`\n${goals.length} goal(s):\n\n`);
  for (const g of goals) {
    const icon = g.status === "running" ? "●" : g.status === "complete" ? "✓" : "○";
    const done = g.phases.filter(p => p.status === "complete").length;
    const total = g.phases.length;
    out.write(`  ${icon}  ${g.id}  ${g.title.slice(0, 50)}  [${done}/${total} phases]  ${g.status}\n`);
  }
  out.write("\nview one: /goals <id>\n");
}

export function goalHelp(): string {
  return [
    "/goal <objective> draft a repository-grounded plan; no work runs",
    "/goal draft       show the unsaved draft",
    "/goal phase <add|remove|move|title|describe> ...  edit draft phases",
    "/goal criteria <number> <text; text>  set completion criteria",
    "/goal note <number> <text>  set a draft phase note",
    "/goal save        accept and save the reviewed draft",
    "/goal edit [id]   reopen a saved plan for editing",
    "/goal discard     discard the unsaved draft",
    "/goals            list saved goals",
    "/goal view [id]   show goal chain + phase detail",
    "/goal run [id]    execute one accepted phase through the host coding loop",
    "/goal run resume [id]  reconcile and continue a checkpointed phase",
    "/goal run pause|cancel [id]  stop a live coding run safely",
    "/goal start [id]  start manual tracking (does not execute work)",
    "/goal pause       pause the active goal",
    "/goal resume      resume a paused goal",
    "/goal cancel      cancel the active goal",
    "/goal note <phase-id> <text>   add a note to a saved goal when no draft is open",
    "/goal complete <phase>      mark a phase complete manually; tests are not certified",
  ].join("\n");
}
