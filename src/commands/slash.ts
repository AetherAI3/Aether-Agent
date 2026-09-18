// In-REPL slash commands (Claude-Code style). The interactive `aether` session
// routes any line starting with "/" here. Models + orchestrators come from the
// shared GET /models catalog, so the terminal switches models exactly like the
// desktop picker and web do.
//
//   /help                 list commands
//   /models               list chat models (numbered)
//   /model <n|id>         switch model
//   /agents               list orchestrators (Neo/Kronus)
//   /agent <n|id>         switch orchestrator
//   /tier                 show plan tier + default
//   /audit [n]            recent Aether audit trail
//   /clear                clear the screen
//   /exit | /quit         leave the REPL
//
// Command handlers live in sibling slash_*.ts files, grouped by concern
// (context, git tools, codegen, HUD, vault/workflow, orchestra, media) to
// keep each file under the repo's ~800-line convention. This file owns the
// dispatcher switch, the models/orchestrators catalog cache, and the
// session-level handlers (picker, doctor, help) that need direct access to
// that cache.

import type { Writable } from "node:stream";
import type { AppContext } from "../core/context.js";
import type { CatalogItem, CatalogResponse } from "../types.js";
import { MODELS_PATH } from "../core/transport.js";
import { fetchTrail } from "../core/audit.js";
import { theme } from "../ui/theme.js";
import { suggestManifestCommand } from "./command_manifest.js";
import { printSlashHelp } from "./slash_help.js";
import { EFFORT_TIERS, normalizeEffort, renderEffortSlider, renderCodeProArt } from "../ui/effort.js";
import { saveConfig } from "../core/config.js";
import { handleGoal, handleGoals } from "./goals.js";
import { pickModel } from "../ui/model_picker.js";
import { runLogsViewer } from "../ui/logs_viewer.js";

import { pinSlash, dropSlash, snapshotSlash, limitSlash, auditReceiptSlash, purgeSlash } from "./slash_context.js";
import { rollbackSlash, revertSlash, stageDiffSlash } from "./slash_git_tools.js";
import { reviewSlash } from "./review.js";
import { shipSlash } from "./ship.js";
import { scaffoldSlash, portSlash, testDriveSlash, benchSlash } from "./slash_codegen.js";
import { addSlash, hudSlash } from "./slash_hud.js";
import {
  vaultStatusSlash, vaultContextSlash, vaultSearchSlash, vaultRecentSlash,
  vaultProjectSlash, vaultTagSlash, vaultTreeSlash,
  workflowSlash, workflowTemplatesSlash, workflowTemplateSlash,
} from "./slash_vault_workflow.js";
import { agentsSlash, delegateSlash, treeSlash, broadcastSlash, gatherSlash } from "./slash_orchestra.js";
import { cmdManagedAgents } from "./managed_agents.js";
import { createAtsHooks } from "./ats_agent.js";
import {
  photogenSlash, reframeSlash, videogenSlash, animateSlash, recutSlash,
  outputSlash, storyboardSlash,
} from "./slash_media.js";

export interface SlashResult {
  exit: boolean;
  /** Set when the user confirmed a model/agent switch: the REPL must restart
   * the brain + clear context with the new selection. */
  restart?: { model?: string; agent?: string };
}

type Kind = "model" | "orchestrator";

// Catalog is cached per REPL session; a fresh session re-fetches.
let _catalog: CatalogResponse | null = null;

/** Resolve a selection arg (1-based index OR id) against a list. Pure. */
export function resolveSelection(items: CatalogItem[], arg: string): CatalogItem | null {
  const a = arg.trim();
  if (!a) return null;
  const n = Number(a);
  if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1] ?? null;
  return items.find((i) => i.id === a) ?? null;
}

async function getCatalog(
  ctx: AppContext,
  force = false,
  signal?: AbortSignal,
  out?: Writable,
): Promise<CatalogResponse> {
  if (!_catalog || force) {
    // Loading state: on a cold cache this blocks on a network round-trip, and
    // with no feedback the REPL just looks hung (spec: distinct loading state).
    out?.write(theme.dim("fetching model catalog…\n"));
    _catalog = await ctx.api.getJson<CatalogResponse>(MODELS_PATH, signal);
  }
  return _catalog;
}

/** Warm the catalog cache in the background. Fail-soft: a rejected fetch is
 * swallowed so the prompt is never blocked and the user sees no error. */
export async function primeCatalog(ctx: AppContext): Promise<void> {
  try {
    await getCatalog(ctx, true);
  } catch {
    /* offline / token not ready — /models will retry lazily */
  }
}

function byKind(cat: CatalogResponse, kind: Kind): CatalogItem[] {
  return cat.models.filter((m) => m.kind === kind);
}

export async function handleSlash(
  ctx: AppContext,
  line: string,
  out: Writable,
  signal?: AbortSignal,
): Promise<SlashResult> {
  const parts = line.slice(1).trim().split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase();
  const arg = parts.slice(1).join(" ");

  switch (cmd) {
    case "exit":
    case "quit":
      return { exit: true };
    case "help":
    case "":
      printSlashHelp(out, arg);
      break;
    case "browser":
    case "ats":
      // These operations belong to the managed chat hook/session lifecycle.
      // The coding REPL only gives a handoff, and never replays the arguments.
      out.write(`/${cmd} is available in a managed agent chat. Open one with aether agent chat <id>, then use /${cmd}.\n`);
      break;
    case "models":
      await showPicker(ctx, out, "model", signal);
      break;
    case "model": {
      if (!arg) {
        const r = await showPicker(ctx, out, "model", signal);
        if (r) return { exit: false, restart: r };
        break;
      }
      const r = await select(ctx, out, arg, "model", signal);
      if (r) return { exit: false, restart: r };
      break;
    }
    case "agent": {
      if (!arg) {
        const r = await showPicker(ctx, out, "orchestrator", signal);
        if (r) return { exit: false, restart: r };
        break;
      }
      const r = await select(ctx, out, arg, "orchestrator", signal);
      if (r) return { exit: false, restart: r };
      break;
    }
    case "tier":
      await showTier(ctx, out, signal);
      break;
    case "effort":
      setEffort(ctx, out, arg);
      break;
    case "audit":
      await showAudit(ctx, out, arg, signal);
      break;
    case "vault": {
      await vaultStatusSlash(ctx, out);
      break;
    }
    case "vault-context": {
      await vaultContextSlash(ctx, out);
      break;
    }
    case "vault-search": {
      await vaultSearchSlash(ctx, out, arg);
      break;
    }
    case "vault-recent": {
      await vaultRecentSlash(ctx, out, arg);
      break;
    }
    case "vault-project": {
      await vaultProjectSlash(ctx, out, arg);
      break;
    }
    case "vault-tag": {
      await vaultTagSlash(ctx, out, arg);
      break;
    }
    case "vault-tree": {
      await vaultTreeSlash(ctx, out);
      break;
    }
    case "workflow": {
      await workflowSlash(ctx, out);
      break;
    }
    case "workflow-templates": {
      await workflowTemplatesSlash(ctx, out);
      break;
    }
    case "workflow-template": {
      await workflowTemplateSlash(ctx, out, arg);
      break;
    }
    case "goal": {
      const parts = arg.split(/\s+/);
      const subcmd = parts[0] ?? "";
      const rest = parts.slice(1).join(" ");
      await handleGoal(ctx, out, subcmd.toLowerCase(), rest);
      break;
    }
    case "goals": {
      await handleGoals(ctx, out, arg);
      break;
    }
    case "memory": {
      const { cmdMemory } = await import("./memory.js");
      const args = arg.trim() ? arg.trim().split(/\s+/) : [];
      await cmdMemory(ctx, args, { out });
      break;
    }
    case "agents": {
      if (arg === "presets") await agentsSlash(ctx, out);
      else await cmdManagedAgents(ctx, ["list"], { out, err: out, signal, hooks: createAtsHooks({ output: text => { out.write(text); } }) });
      break;
    }
    case "agent-create": {
      await cmdManagedAgents(ctx, ["create", ...parts.slice(1)], { out, err: out, signal, hooks: createAtsHooks({ output: text => { out.write(text); } }) });
      break;
    }
    case "doctor": {
      const { cmdDoctor } = await import("./doctor.js");
      await cmdDoctor(ctx, arg.trim() ? arg.trim().split(/\s+/) : [], { out });
      break;
    }
    case "settings": {
      const { runSettingsCommand } = await import("./settings.js");
      const args = arg.trim() ? ["show", arg.trim()] : [];
      await runSettingsCommand(ctx, args, {}, { out, err: out });
      break;
    }
    case "voice": {
      const { runVoiceCommand } = await import("./voice.js");
      const args = arg.trim() ? arg.trim().split(/\s+/) : [];
      await runVoiceCommand(ctx, args, { out, err: out });
      break;
    }
    case "preview": {
      const { cmdPreview } = await import("./preview.js");
      const args = arg.trim() ? arg.trim().split(/\s+/) : ["status"];
      await cmdPreview(ctx, args, { out, err: out });
      break;
    }
    case "mcp": {
      const args = arg.trim() ? arg.trim().split(/\s+/) : [];
      if (args.length > 0) {
        const { cmdMcp } = await import("./mcp.js");
        await cmdMcp(ctx, args, { out });
        break;
      }

      if (!process.stdin.isTTY) {
        out.write("MCP manager needs an interactive terminal — run `aether mcp`.\n");
        break;
      }
      const { mcpFromRepl } = await import("./mcp.js");
      await mcpFromRepl(ctx);
      break;
    }
    case "delegate": {
      await delegateSlash(ctx, out, arg);
      break;
    }
    case "tree": {
      await treeSlash(ctx, out);
      break;
    }
    case "broadcast": {
      await broadcastSlash(ctx, out, arg);
      break;
    }
    case "gather": {
      await gatherSlash(ctx, out, arg);
      break;
    }
    case "photogen":
    case "frame": {
      await photogenSlash(ctx, out, arg, cmd === "frame");
      break;
    }
    case "re-frame": {
      await reframeSlash(ctx, out, arg);
      break;
    }
    case "videogen":
    case "sequence": {
      await videogenSlash(ctx, out, arg, cmd === "sequence");
      break;
    }
    case "animate": {
      await animateSlash(ctx, out, arg);
      break;
    }
    case "re-cut": {
      await recutSlash(ctx, out, arg);
      break;
    }
    case "output": {
      await outputSlash(ctx, out, arg);
      break;
    }
    case "storyboard": {
      await storyboardSlash(ctx, out, arg);
      break;
    }
    case "test-drive": {
      await testDriveSlash(ctx, out, arg);
      break;
    }
    case "bench": {
      await benchSlash(ctx, out, arg);
      break;
    }
    case "clear":
      out.write("\x1b[2J\x1b[H");
      break;
    case "queue":
    case "steer":
    case "btw":
    case "writing-plans":
    case "subagent-driven-execution":
    case "self-review":
    case "recon":
    case "plan":
    case "writing-skills":
    case "autonomous-execution":
    case "research":
    case "project-review":
    case "code-review":
      out.write(`/${cmd} is handled directly in the interactive REPL.\n`);
      break;
    case "pin":
      await pinSlash(ctx, out, arg, line);
      break;
    case "drop":
      await dropSlash(ctx, out, arg);
      break;
    case "snapshot":
      await snapshotSlash(ctx, out, arg);
      break;
    case "limit":
    case "token-budget": // alias — same handler, not a leftover duplicate
      await limitSlash(ctx, out, arg);
      break;
    case "audit-receipt":
      await auditReceiptSlash(ctx, out, arg);
      break;
    case "rollback":
      await rollbackSlash(ctx, out, arg);
      break;
    case "logs-view":
    case "logs": {
      out.write("\x1b[?25l"); // Hide cursor
      await runLogsViewer(out);
      break;
    }
    case "scaffold": {
      await scaffoldSlash(ctx, out, arg);
      break;
    }
    case "port": {
      await portSlash(ctx, out, arg);
      break;
    }
    case "purge": {
      await purgeSlash(ctx, out);
      break;
    }
    case "stage-diff": {
      await stageDiffSlash(ctx, out);
      break;
    }
    // The review → commit → pull request rail. `/review` used to be a prompt
    // rewrite asking the brain for a prose project review; that macro is still
    // here under `/project-review`, and the name now belongs to the surface
    // that shows the user their own changes.
    case "review": {
      await reviewSlash(ctx, out, arg);
      break;
    }
    case "ship": {
      await shipSlash(ctx, out, arg);
      break;
    }
    case "revert": {
      await revertSlash(ctx, out, arg);
      break;
    }
    case "add":
      await addSlash(ctx, out, arg);
      break;
    case "hud":
      await hudSlash(ctx, out, arg);
      break;
    default: {
      const near = suggestManifestCommand("slash", cmd);
      const hint = near ? `did you mean ${theme.cyan("/" + near)}?  ` : "";
      out.write(`unknown command: /${cmd}  ${hint}${theme.dim("(/help, or Tab to complete)")}\n`);
    }
  }
  return { exit: false };
}

/** Launch interactive picker, then show the standard warning + confirm. */
async function showPicker(
  ctx: AppContext,
  out: Writable,
  kind: Kind,
  signal?: AbortSignal,
): Promise<{ model?: string; agent?: string } | null> {
  const cat = await getCatalog(ctx, false, signal, out);
  const items = byKind(cat, kind);

  const picked = await pickModel(items, out);
  if (picked === undefined) {
    // pickModel hit an internal fault and already printed its own distinct
    // diagnostic — printing the generic "kept current session." below too
    // would show the same failure as two back-to-back, redundant lines.
    return null;
  }
  if (!picked) {
    // pickModel returned null — either cancelled (Esc) or non-TTY fallback.
    // If non-TTY, render a flat numbered list so the user can still /model <n>.
    if (!process.stdin.isTTY) {
      const current =
        kind === "model"
          ? ctx.flags.model ?? ctx.cfg.defaultModel ?? cat.default
          : ctx.flags.agent;
      out.write(`tier: ${cat.tier}\n`);
      items.forEach((m, i) => {
        const mark = m.id === current ? "›" : m.available ? " " : "🔒";
        const cap = m.monthly_uvt_cap != null ? `  cap ${m.monthly_uvt_cap}` : "";
        out.write(`${mark} ${String(i + 1).padStart(2)}. ${m.id}\t${m.label}${cap}\n`);
      });
      out.write(kind === "model" ? "switch: /model <n|id>\n" : "switch: /agent <n|id>\n");
    } else {
      out.write("kept current session.\n");
    }
    return null;
  }

  return confirmSwitch(ctx, out, picked, kind, cat.tier);
}

async function select(
  ctx: AppContext,
  out: Writable,
  arg: string,
  kind: Kind,
  signal?: AbortSignal,
): Promise<{ model?: string; agent?: string } | null> {
  if (!arg) {
    out.write(`usage: /${kind === "model" ? "model" : "agent"} <n|id>\n`);
    return null;
  }
  const cat = await getCatalog(ctx, false, signal, out);
  const item = resolveSelection(byKind(cat, kind), arg);
  if (!item) {
    out.write(`no such ${kind}: ${arg}\n`);
    return null;
  }
  return confirmSwitch(ctx, out, item, kind, cat.tier);
}

/** Shared by showPicker/select once a target item is resolved: lock check,
 * restart warning, and the y/N gate that produces the caller's restart signal. */
export async function confirmSwitch(
  ctx: AppContext,
  out: Writable,
  item: CatalogItem,
  kind: Kind,
  tier: string,
): Promise<{ model?: string; agent?: string } | null> {
  if (!item.available) {
    // Same dim styling + "check: /tier or `aether models`" pointer as
    // httpStatusHint(403) (errors.ts) — a tier lock reached via the picker
    // must read the same as the functionally identical 403 reached over the
    // wire, not as unstyled text with no next step. LOOP-06.
    out.write(theme.dim(`${item.id} is locked on tier ${tier} — check: /tier or \`aether models\`\n`));
    return null;
  }
  out.write(
    theme.dim(
      `⚠ Switching ${kind === "model" ? "model" : "orchestrator"} to ${item.label} will ` +
        `restart the session and clear context.\n`,
    ),
  );
  const ok = ctx.flags.yes || (await ctx.confirm("Continue? [y/N] "));
  if (!ok) {
    out.write("kept current session.\n");
    return null;
  }
  return kind === "model" ? { model: item.id } : { agent: item.id };
}

/** `/effort` — show the dial; `/effort <tier|1-5>` — set it. The tier persists
 * in the shared Aether config and rides TaskCommand.effort into the cloud
 * brain on every `aether code` run (same backend as AetherCloud; no wire
 * change). CODEPRO gets the full banner. */
function setEffort(ctx: AppContext, out: Writable, arg: string): void {
  if (!arg) {
    for (const l of renderEffortSlider(ctx.cfg.defaultEffort)) out.write(l + "\n");
    out.write(`set: /effort <${EFFORT_TIERS.join("|")}> (or 1-${EFFORT_TIERS.length})\n`);
    return;
  }
  const tier = normalizeEffort(arg);
  if (!tier) {
    out.write(`no such effort tier: ${arg}  (${EFFORT_TIERS.join(", ")})\n`);
    return;
  }
  ctx.cfg.defaultEffort = tier;
  saveConfig(ctx.cfg);
  if (tier === "CODEPRO") for (const l of renderCodeProArt()) out.write(l + "\n");
  for (const l of renderEffortSlider(tier)) out.write(l + "\n");
  out.write(`effort → ${tier}  (saved — drives your aether code runs)\n`);
}

async function showTier(ctx: AppContext, out: Writable, signal?: AbortSignal): Promise<void> {
  const cat = await getCatalog(ctx, false, signal, out);
  const models = byKind(cat, "model").filter((m) => m.available).length;
  const orch = byKind(cat, "orchestrator").filter((m) => m.available).length;
  out.write(
    `tier: ${cat.tier}   default: ${cat.default}   available: ${models} models, ${orch} orchestrators\n`,
  );
}

async function showAudit(ctx: AppContext, out: Writable, arg: string, signal?: AbortSignal): Promise<void> {
  const n = Number(arg);
  const limit = Number.isInteger(n) && n > 0 ? n : 10;
  const entries = await fetchTrail(ctx.api, { limit }, signal);
  if (entries.length === 0) {
    out.write("(no audit entries)\n");
    return;
  }
  for (const e of entries) {
    out.write(`${e.timestamp}\t${e.eventType}\t${e.commitmentHash ?? "-"}\t${e.orderId}\n`);
  }
}
