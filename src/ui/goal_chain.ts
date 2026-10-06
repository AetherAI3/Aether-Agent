// goal_chain.ts — ANSI renderer for the goal chain display.
// Renders phase boxes side-by-side with status colors, arrows, detail panel.

import type { Goal, GoalPhase } from "../core/goals.js";
import { visibleWidth } from "./text.js";

// ── Truecolor palette ──
// One complete SGR sequence per color: \x1b[38;2;R;G;Bm … \x1b[0m. (The old
// helpers closed the escape at \x1b[38m and printed ";2;R;G;Bm" as literal
// text on screen.)
const fg = (r: number, g: number, b: number) => (s: string): string =>
  `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const muted = (s: string): string => `\x1b[38;5;240m${s}\x1b[0m`;
const cyan = fg(26, 166, 183);
const iceBlue = fg(135, 215, 255);
const green = fg(0, 200, 100);
const yellow = fg(220, 200, 50);
const red = fg(220, 60, 60);

function statusIcon(status: string): string {
  switch (status) {
    case "complete": return green("●");
    case "in_progress": return yellow("◉");
    case "running": return yellow("◉");
    case "failed": return red("✗");
    case "pending": case "queued": return muted("○");
    default: return muted("○");
  }
}

const PHASE_W = 22;

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - visibleWidth(s)));
}

function phaseBox(p: GoalPhase, selected: boolean, isActive: boolean): string[] {
  const b = selected ? cyan : isActive ? iceBlue : muted;
  const tFn = selected ? bold : (s: string) => s;
  const icon = statusIcon(p.status);
  const num = p.id.replace("phase-", "");
  const title = p.title.length > 14 ? p.title.slice(0, 13) + "…" : p.title;

  const top = b("┌" + "─".repeat(PHASE_W - 2) + "┐");
  const bot = b("└" + "─".repeat(PHASE_W - 2) + "┘");

  const l1 = b("│ ") + pad(`${icon} ${bold(num)}. ${tFn(title)}`, PHASE_W - 4) + b(" │");

  const statStr = p.status === "in_progress" ? yellow("▶ active") :
    p.status === "complete" ? green("✓ done") :
    p.status === "pending" ? muted("· queued") :
    p.status === "failed" ? red("✗ failed") : muted("· " + p.status);
  const l2 = b("│ ") + pad(statStr, PHASE_W - 4) + b(" │");

  const done = p.tasks.filter(t => t.status === "complete").length;
  const tStr = `${done}/${p.tasks.length} tasks`;
  const l3 = b("│ ") + pad(muted(tStr), PHASE_W - 4) + b(" │");

  const noteIcon = p.userNote ? yellow("✎ note") : dim("  —");
  const l4 = b("│ ") + pad(noteIcon, PHASE_W - 4) + b(" │");

  return [top, l1, l2, l3, l4, bot];
}

function phaseArrow(i: number, phases: GoalPhase[]): string {
  if (i === 0) return "";
  return phases[i - 1]!.status === "complete" ? green(" → ") : muted(" ─ ");
}

export function renderGoalChain(goal: Goal, cols: number): string[] {
  const lines: string[] = [];

  // Title bar
  const statusLabel = goal.status === "running" ? yellow("[running]") :
    goal.status === "complete" ? green("[complete]") :
    goal.status === "paused" ? yellow("[paused]") : muted(`[${goal.status}]`);
  lines.push(cyan("╔══ GOAL ══╗") + "  " + bold(goal.title.slice(0, 50)) + "  " + statusLabel);
  lines.push("");

  // Phase boxes side-by-side
  const phases = goal.phases;
  if (phases.length === 0) {
    lines.push(muted("  (no phases planned yet)"));
    return lines;
  }

  const totalW = phases.length * PHASE_W + (phases.length - 1) * 3;
  const padLeft = Math.max(0, Math.floor((cols - totalW) / 2));
  const leftPad = " ".repeat(padLeft);

  for (let row = 0; row < 6; row++) {
    let line = leftPad;
    for (let i = 0; i < phases.length; i++) {
      if (i > 0) line += row === 2 ? phaseArrow(i, phases) : "   ";
      line += phaseBox(phases[i]!, phases[i]!.id === goal.selectedPhaseId, phases[i]!.id === goal.activePhaseId)[row];
    }
    lines.push(line);
  }

  lines.push("");
  lines.push(muted("  /goal edit [id]   /goal start   /goal pause   /goals list"));

  return lines;
}

export function renderPhaseDetail(goal: Goal, cols: number): string[] {
  const lines: string[] = [];
  const sel = goal.phases.find(p => p.id === goal.selectedPhaseId);
  if (!sel) return lines;

  const w = Math.min(cols - 2, 66);
  const inner = w - 4;

  lines.push("");
  lines.push(cyan("╭─ Phase Detail ─" + "─".repeat(inner - 14) + "╮"));

  const t1 = `  ${bold(sel.id.replace("phase-", ""))}. ${bold(sel.title)}`;
  lines.push(cyan("│") + pad(t1, inner) + cyan("│"));
  lines.push(cyan("│") + pad("  " + dim(sel.description), inner) + cyan("│"));

  const statStr = sel.status === "in_progress" ? yellow("▶ in progress") :
    sel.status === "complete" ? green("✓ complete") :
    sel.status === "pending" ? muted("· pending") : muted("· " + sel.status);
  lines.push(cyan("│") + pad("  Status: " + statStr, inner) + cyan("│"));

  if (sel.userNote) {
    lines.push(cyan("│") + pad("  " + yellow("✎ Note: ") + sel.userNote.slice(0, inner - 12), inner) + cyan("│"));
  } else {
    lines.push(cyan("│") + pad("  " + muted("(no notes — type /goal note " + sel.id + " <text>"), inner) + cyan("│"));
  }

  lines.push(cyan("│") + pad("  " + muted("─".repeat(Math.max(0, inner - 4))), inner) + cyan("│"));

  for (const t of sel.tasks) {
    lines.push(cyan("│") + pad(`   ${statusIcon(t.status)}  ${t.title}`, inner) + cyan("│"));
  }

  lines.push(cyan("╰" + "─".repeat(inner) + "╯"));

  return lines;
}

function navigatePhase(goal: Goal, dir: number): Goal {
  const phases = goal.phases;
  if (phases.length === 0) return goal;
  const idx = phases.findIndex(p => p.id === goal.selectedPhaseId);
  const newIdx = idx < 0 ? 0 : Math.max(0, Math.min(phases.length - 1, idx + dir));
  return { ...goal, selectedPhaseId: phases[newIdx]!.id };
}

export { navigatePhase };
