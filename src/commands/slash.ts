// In-REPL slash commands (Claude-Code style). The interactive `aether` session
// routes any line starting with "/" here. Models + orchestrators come from the
// hosted GET /models catalog or the active Ollama installation. The route is
// chosen from the session backend; discovery never changes that backend.
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
import { commandInvocationStatus, findManifestCommand, suggestManifestCommand } from "./command_manifest.js";
import { printSlashHelp } from "./slash_help.js";
import { EFFORT_TIERS, normalizeEffort, renderEffortSlider, renderCodeProArt } from "../ui/effort.js";
import { saveConfig } from "../core/config.js";
import { handleGoalInput, handleGoals } from "./goals.js";
import { pickModel } from "../ui/model_picker.js";
import { isLocalModelId, localModelId, normalizeOllamaTag, ollamaTagFromId, resolveLocalModel } from "../core/local_ollama.js";
import { chooseBackend, type BackendPath } from "../core/backend.js";
import { normalizeOllamaHost } from "../core/ollama.js";
import { listInstalledOllamaModels, OllamaModelsError } from "../core/ollama_models.js";
import { runLogsViewer } from "../ui/logs_viewer.js";

import { pinSlash, dropSlash, contextSlash, snapshotSlash, limitSlash, auditReceiptSlash, purgeSlash, type ContextInspectorOptions } from "./slash_context.js";
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
  /** Console model switches wait for an explicit reviewed choice. */
  modelSwitch?: { model: string; label: string; contextWindow: number | null };
}

type Kind = "model" | "orchestrator";

// Catalog is cached per REPL session; a fresh session re-fetches.
let _catalog: CatalogResponse | null = null;

export function invalidateCatalog(): void { _catalog = null; }

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
    if (await activeBackend(ctx) === "local") return;
    await getCatalog(ctx, true);
  } catch {
    /* offline / token not ready — /models will retry lazily */
  }
}

function byKind(cat: CatalogResponse, kind: Kind): CatalogItem[] {
  return cat.models.filter((m) => m.kind === kind);
}

async function activeBackend(ctx: AppContext): Promise<BackendPath> {
  const pref = (process.env["AETHER_BACKEND"] || (ctx.flags.local ? "local" : ctx.cfg.backend) || "auto").trim();
  return chooseBackend(pref, pref === "local" ? false : Boolean(await ctx.tokens.get()));
}

function localEndpoint(): string {
  try { return normalizeOllamaHost(process.env["OLLAMA_HOST"]); }
  catch { return "configured OLLAMA_HOST"; }
}

function localCatalogError(ctx: AppContext, out: Writable, error: unknown): void {
  const endpoint = localEndpoint();
  const reason = error instanceof OllamaModelsError ? error.reason : "configuration";
  const nextStep = reason === "malformed" ? "Restart or update Ollama, then retry /models."
    : reason === "timeout" ? "Check OLLAMA_HOST and the server, then retry /models."
      : reason === "unreachable" ? "Start Ollama or check OLLAMA_HOST, then retry /models."
        : "Set OLLAMA_HOST to a valid Ollama URL, then retry /models.";
  const message = reason === "malformed" ? "Ollama returned invalid installed-model data"
    : reason === "timeout" ? "Ollama installed-model request timed out"
      : reason === "unreachable" ? "Cannot reach Ollama installed models"
        : "Invalid Ollama endpoint";
  if (ctx.flags.json) out.write(JSON.stringify({ schema: "aether.console-models/1", backend: "ollama", endpoint, ok: false, error: reason, nextStep }) + "\n");
  else out.write(`${message} at ${endpoint}. ${nextStep}\n`);
}

function localSelectionError(ctx: AppContext, out: Writable, endpoint: string, id: string, error: "invalid" | "not-installed", message: string, nextStep: string): void {
  if (ctx.flags.json) out.write(JSON.stringify({ schema: "aether.console-model-selection/1", backend: "ollama", endpoint, ok: false, id, error, nextStep }) + "\n");
  else out.write(`${message} ${nextStep}\n`);
}

async function getLocalCatalog(ctx: AppContext, signal?: AbortSignal): Promise<{ catalog: CatalogResponse; endpoint: string }> {
  const { endpoint, tags } = await listInstalledOllamaModels(process.env["OLLAMA_HOST"], signal);
  const explicit = isLocalModelId(ctx.flags.model) || ctx.flags.local === true ? ctx.flags.model : undefined;
  const selected = localModelId(resolveLocalModel(explicit, ctx.cfg.localModel ?? "", { allowBareExplicit: ctx.flags.local === true }));
  return {
    endpoint,
    catalog: {
      tier: "local-installed",
      default: selected,
      models: tags.map(tag => ({
        id: localModelId(tag), label: tag, kind: "model", provider: "ollama",
        context_window: null, tier_min: null, enabled: true, available: true,
        monthly_uvt_cap: null, is_default: localModelId(tag) === selected,
      })),
    },
  };
}

export function splitSlashCommand(line: string): { cmd: string; arg: string } {
  const input = line.slice(1).trim();
  const separator = input.search(/\s/u);
  const cmd = (separator < 0 ? input : input.slice(0, separator)).toLowerCase();
  // Keep the argument text intact. /ship parses quoting and may contain a
  // literal newline in a quoted PR body; splitting here would corrupt it.
  const arg = separator < 0 ? "" : input.slice(separator).trim();
  return { cmd, arg };
}

export async function handleSlash(
  ctx: AppContext,
  line: string,
  out: Writable,
  signal?: AbortSignal,
  contextOptions: ContextInspectorOptions = {},
): Promise<SlashResult> {
  const { cmd, arg } = splitSlashCommand(line);

  const manifestEntry = findManifestCommand("slash", cmd);
  if (manifestEntry?.sessionScope === "managed-agent"
      && commandInvocationStatus(manifestEntry, "coding") === "unsupported") {
    out.write(`/${cmd} is available in a managed agent chat. Open one with aether agent chat <id>, then use /${cmd}.\n`);
    return { exit: false };
  }

  switch (cmd) {
    case "terminal":
    case "terminal-attach":
    case "terminal-stop":
    case "terminal-status":
      out.write("Interactive terminal commands belong to the local coding console; Linux/Python 3 and a TTY are required.\n");
      break;
    case "shell-reset":
      out.write("/shell-reset belongs to the local coding console; submit it there to discard shell state.\n");
      break;
    case "shell-profile":
      out.write("/shell-profile belongs to the local coding console; use it there to inspect or switch the shell profile.\n");
      break;
    case "exit":
    case "quit":
      return { exit: true };
    case "help":
    case "":
      printSlashHelp(out, arg);
      break;
    case "auth":
      out.write("/auth status|login|continue|new|draft is available in the interactive coding console.\n");
      break;
    case "browser":
    case "ats":
      // Reached only if the shared manifest scope gate above changes.
      break;
    case "models": {
      const r = await showPicker(ctx, out, "model", signal);
      if (r?.model) return { exit: false, modelSwitch: { model: r.model, label: r.label ?? r.model, contextWindow: r.contextWindow ?? null } };
      break;
    }
    case "model": {
      if (!arg) {
        const r = await showPicker(ctx, out, "model", signal);
        if (r) return { exit: false, ...(r.model ? { modelSwitch: { model: r.model, label: r.label ?? r.model, contextWindow: r.contextWindow ?? null } } : { restart: r }) };
        break;
      }
      const r = await select(ctx, out, arg, "model", signal);
      if (r) return { exit: false, ...(r.model ? { modelSwitch: { model: r.model, label: r.label ?? r.model, contextWindow: r.contextWindow ?? null } } : { restart: r }) };
      break;
    }
    case "switch":
      out.write("/switch continue|fresh|cancel|brief|edit is available at an idle coding console after /model.\n");
      break;
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
      await handleGoalInput(ctx, out, arg);
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
      await cmdManagedAgents(ctx, ["create", ...(arg ? arg.split(/\s+/u) : [])], { out, err: out, signal, hooks: createAtsHooks({ output: text => { out.write(text); } }) });
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
    case "shell-result":
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
    case "context":
      await contextSlash(ctx, out, arg, { ...contextOptions, backend: await activeBackend(ctx) });
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
): Promise<{ model?: string; agent?: string; label?: string; contextWindow?: number | null } | null> {
  const local = kind === "model" && await activeBackend(ctx) === "local";
  let cat: CatalogResponse;
  let endpoint: string | null = null;
  if (local) {
    try {
      const result = await getLocalCatalog(ctx, signal);
      cat = result.catalog;
      endpoint = result.endpoint;
    } catch (error) { localCatalogError(ctx, out, error); return null; }
  } else cat = await getCatalog(ctx, false, signal, out);
  const items = byKind(cat, kind);

  if (local && items.length === 0) {
    const nextStep = "Run aether local pull <tag> --yes, then retry /models.";
    if (ctx.flags.json) out.write(JSON.stringify({ schema: "aether.console-models/1", backend: "ollama", endpoint, ok: false, error: "empty", models: [], nextStep }) + "\n");
    else out.write(`No Ollama models are installed at ${endpoint}. ${nextStep}\n`);
    return null;
  }

  const current = kind === "model"
    ? (local ? cat.default : (ctx.flags.model ?? ctx.cfg.defaultModel ?? cat.default))
    : ctx.flags.agent;
  if (!process.stdin.isTTY || (out as Writable & { isTTY?: boolean }).isTTY === false ||
      (out === process.stdout && !process.stdout.isTTY) || ctx.flags.json) {
    if (ctx.flags.json) {
      out.write(JSON.stringify({ schema: "aether.console-models/1", backend: local ? "ollama" : "hosted", ...(endpoint ? { endpoint } : {}), ok: true, selected: current ?? null,
        models: items.map((m, i) => ({ index: i + 1, id: m.id, label: m.label, available: m.available })) }) + "\n");
    } else {
      out.write(local ? `installed Ollama models at ${endpoint}:\n` : `tier: ${cat.tier}\n`);
      items.forEach((m, i) => {
        const mark = m.id === current ? ">" : m.available ? " " : "locked";
        const cap = m.monthly_uvt_cap != null ? `  cap ${m.monthly_uvt_cap}` : "";
        out.write(`${mark} ${String(i + 1).padStart(2)}. ${m.id}\t${m.label}${cap}\n`);
      });
      out.write(kind === "model" ? (local ? "switch: /model <tag|n|id>\n" : "switch: /model <n|id>\n") : "switch: /agent <n|id>\n");
    }
    return null;
  }

  const picked = await pickModel(items, out, current);
  if (picked === undefined) {
    // pickModel hit an internal fault and already printed its own distinct
    // diagnostic — printing the generic "kept current session." below too
    // would show the same failure as two back-to-back, redundant lines.
    return null;
  }
  if (!picked) {
    out.write("kept current session.\n");
    return null;
  }

  if (local) {
    try {
      const latest = await getLocalCatalog(ctx, signal);
      if (!latest.catalog.models.some(item => item.id === picked.id)) {
        out.write(`Ollama model ${picked.id} disappeared from ${latest.endpoint}. Run /models to refresh the installed list.\n`);
        return null;
      }
    } catch (error) { localCatalogError(ctx, out, error); return null; }
  }

  return confirmSwitch(ctx, out, picked, kind, cat.tier);
}

async function select(
  ctx: AppContext,
  out: Writable,
  arg: string,
  kind: Kind,
  signal?: AbortSignal,
): Promise<{ model?: string; agent?: string; label?: string; contextWindow?: number | null } | null> {
  if (!arg) {
    out.write(`usage: /${kind === "model" ? "model" : "agent"} <n|id>\n`);
    return null;
  }
  const local = kind === "model" && (await activeBackend(ctx) === "local" || isLocalModelId(arg));
  if (local) {
    let result: Awaited<ReturnType<typeof getLocalCatalog>>;
    try { result = await getLocalCatalog(ctx, signal); }
    catch (error) { localCatalogError(ctx, out, error); return null; }
    const items = result.catalog.models;
    if (items.length === 0) {
      localSelectionError(ctx, out, result.endpoint, arg, "not-installed", `Ollama model ${JSON.stringify(arg)} is not installed at ${result.endpoint}; the installed list is empty.`, "Run aether local pull <tag> --yes, then retry /model.");
      return null;
    }
    let id = arg;
    if (!/^\d+$/.test(arg)) {
      try {
        const tag = isLocalModelId(arg) ? ollamaTagFromId(arg) : normalizeOllamaTag(arg);
        if (!tag) throw new Error("invalid tag");
        id = localModelId(tag);
      } catch {
        localSelectionError(ctx, out, result.endpoint, arg, "invalid", `Invalid Ollama model ${JSON.stringify(arg)}.`, "Run /models to see installed tags.");
        return null;
      }
    }
    const item = resolveSelection(items, id);
    if (!item) {
      localSelectionError(ctx, out, result.endpoint, arg, "not-installed", `Ollama model ${JSON.stringify(arg)} is not installed at ${result.endpoint}.`, "Run /models to refresh the installed list.");
      return null;
    }
    if (ctx.flags.json) out.write(JSON.stringify({ schema: "aether.console-model-selection/1", backend: "ollama", endpoint: result.endpoint, id: item.id, tag: ollamaTagFromId(item.id), status: "pending-review" }) + "\n");
    return confirmSwitch(ctx, out, item, kind, result.catalog.tier);
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
): Promise<{ model?: string; agent?: string; label?: string; contextWindow?: number | null } | null> {
  if (!item.available) {
    // Same dim styling + "check: /tier or `aether models`" pointer as
    // httpStatusHint(403) (errors.ts) — a tier lock reached via the picker
    // must read the same as the functionally identical 403 reached over the
    // wire, not as unstyled text with no next step. LOOP-06.
    out.write(theme.dim(`${item.id} is locked on tier ${tier} — check: /tier or \`aether models\`\n`));
    return null;
  }
  if (kind === "model") {
    // The console displays a bounded, editable continuation brief before the
    // user chooses continue, fresh, or cancel. No model call occurs here.
    return { model: item.id, label: item.label, contextWindow: item.context_window };
  }
  out.write(
    theme.dim(
      `⚠ Switching orchestrator to ${item.label} will ` +
        `restart the session and clear context.\n`,
    ),
  );
  const ok = ctx.flags.yes || (await ctx.confirm("Continue? [y/N] "));
  if (!ok) {
    out.write("kept current session.\n");
    return null;
  }
  return { agent: item.id };
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
  saveConfig({ ...ctx.cfg, defaultEffort: tier });
  ctx.cfg.defaultEffort = tier;
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
