// In-REPL orchestra slash commands: /agents /delegate /tree /broadcast
// /gather. Split out of slash.ts (was 1807 lines) to keep each command group
// under the repo's ~800-line file convention.

import type { Writable } from "node:stream";
import { resolve } from "node:path";
import type { AppContext } from "../core/context.js";
import { AGENTS_PATH } from "../core/transport.js";
import { theme } from "../ui/theme.js";
import { delegateWorker, getOrchTree, broadcastToAgents, gatherResults, requireOrchestrator } from "../core/orchestrator.js";
import { projectRefFor, rcOutboxPath } from "./rc.js";
import { subagentEvent, subagentFinishedEvent, subagentStartedEvent, type RcProducedEvent } from "../core/rc/producers.js";
import { publishSubagentEvents } from "../core/rc/subagents.js";

async function publishWorkers(ctx: AppContext, events: readonly RcProducedEvent[]): Promise<void> {
  const root = resolve(ctx.flags.cwd);
  await publishSubagentEvents(ctx.api, root, rcOutboxPath(projectRefFor(root)), events);
}

// ── Agents slash handler ────────────────────────

export async function agentsSlash(ctx: AppContext, out: Writable): Promise<void> {
  try {
    const resp = await ctx.api.getJson<{ agents?: Array<{
      name?: string; status?: string; working_time?: string;
      uvt_streamed?: number; task?: string;
    }> }>(AGENTS_PATH);
    const agents = resp.agents ?? [];
    if (agents.length === 0) {
      out.write("(no active agents)\n");
      return;
    }
    // Columns: name, status, working time, UVT streamed, task
    const nameW = Math.max(20, ...agents.map(a => (a.name ?? "?").length));
    const statusW = 12;
    const timeW = 14;
    const uvtW = 12;

    // Header
    const header = "  " +
      "name".padEnd(nameW) + "  " +
      "status".padEnd(statusW) + "  " +
      "time".padEnd(timeW) + "  " +
      "UVT".padEnd(uvtW) + "  " +
      "task";
    out.write(theme.bold(header) + "\n");
    out.write(theme.dim("  " + "─".repeat(nameW + statusW + timeW + uvtW + 30)) + "\n");

    for (const a of agents) {
      const name = (a.name ?? "?").padEnd(nameW);
      const status = (a.status ?? "?").padEnd(statusW);
      const time = (a.working_time ?? "—").padEnd(timeW);
      const uvt = a.uvt_streamed != null
        ? String(a.uvt_streamed).padEnd(uvtW)
        : "—".padEnd(uvtW);
      const task = (a.task ?? "").slice(0, 50);

      const statusColor = a.status === "running" ? theme.cyan :
        a.status === "complete" ? theme.dim : theme.muted;

      out.write(`  ${theme.bold(name)}${statusColor(status)}${theme.dim(time)}${theme.dim(uvt)}${task}\n`);
    }
  } catch {
    out.write("agents: unreachable (are you logged in? aether auth login)\n");
  }
}

// ── Orchestrator slash handlers ─────────────────

export async function delegateSlash(ctx: AppContext, out: Writable, arg: string): Promise<void> {
  if (!requireOrchestrator(ctx, out)) return;
  const parts = arg.split(/\s+/);
  const model = parts[0];
  const task = parts.slice(1).join(" ");
  if (!model || !task) {
    out.write("usage: /delegate <model> <task>\n");
    return;
  }
  try {
    const r = await delegateWorker(ctx.api, ctx.flags.agent!, model, task);
    await publishWorkers(ctx, [subagentStartedEvent(r.worker_id, r.status)]);
    out.write(`delegated → worker ${r.worker_id} (${r.status}) running ${model}\n`);
  } catch (err) {
    out.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

export async function treeSlash(ctx: AppContext, out: Writable): Promise<void> {
  if (!requireOrchestrator(ctx, out)) return;
  try {
    const r = await getOrchTree(ctx.api, ctx.flags.agent!);
    await publishWorkers(ctx, r.workers.map(subagentEvent));
    out.write(theme.bold(`orchestrator: ${r.orchestrator}`) + "\n");
    if (r.workers.length === 0) {
      out.write("  (no active sub-agents)\n");
      return;
    }
    // Columns: id, model, step, tokens, UVT
    const idW = Math.max(10, ...r.workers.map(w => w.id.length));
    const modelW = Math.max(10, ...r.workers.map(w => w.model.length));
    const stepW = Math.max(12, ...r.workers.map(w => w.step.length));
    const header = "  " +
      "id".padEnd(idW) + "  " +
      "model".padEnd(modelW) + "  " +
      "step".padEnd(stepW) + "  " +
      "tokens".padEnd(10) + "  " +
      "UVT";
    out.write(theme.dim(header) + "\n");
    out.write(theme.dim("  " + "─".repeat(idW + modelW + stepW + 30)) + "\n");
    for (const w of r.workers) {
      out.write(
        `  ${theme.bold(w.id.padEnd(idW))}  ` +
        `${w.model.padEnd(modelW)}  ` +
        `${w.step.padEnd(stepW)}  ` +
        `${String(w.tokens).padEnd(10)}  ` +
        `${w.uvt}\n`
      );
    }
  } catch (err) {
    out.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

export async function broadcastSlash(ctx: AppContext, out: Writable, arg: string): Promise<void> {
  if (!requireOrchestrator(ctx, out)) return;
  const message = arg.trim();
  if (!message) {
    out.write("usage: /broadcast \"<message>\"\n");
    return;
  }
  try {
    const r = await broadcastToAgents(ctx.api, ctx.flags.agent!, message);
    out.write(`broadcast → delivered to ${r.delivered_to} sub-agents\n`);
  } catch (err) {
    out.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

export async function gatherSlash(ctx: AppContext, out: Writable, arg: string): Promise<void> {
  if (!requireOrchestrator(ctx, out)) return;
  const workerId = arg.trim();
  if (!workerId) { out.write("usage: /gather <sub_agent_id|all>\n"); return; }
  try {
    const r = await gatherResults(ctx.api, ctx.flags.agent!, workerId);
    await publishWorkers(ctx, r.results.map((result) => subagentFinishedEvent(result.worker_id, "done")));
    if (r.results.length === 0) { out.write("(no results to gather)\n"); return; }
    for (const res of r.results) {
      out.write(`${theme.bold(res.worker_id)}:\n`);
      if (res.files.length) out.write(`  files:  ${res.files.join(", ")}\n`);
      if (res.diffs.length) out.write(`  diffs:  ${res.diffs.length} diff(s)\n`);
      if (res.patches.length) out.write(`  patches: ${res.patches.length} patch(es)\n`);
    }
  } catch (err) { out.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`); }
}
