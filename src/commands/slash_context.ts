// In-REPL context-management slash commands: /pin /drop /snapshot /limit
// /token-budget /audit-receipt /purge. Split out of slash.ts (was 1807 lines)
// to keep each command group under the repo's ~800-line file convention.

import type { Writable } from "node:stream";
import type { AppContext } from "../core/context.js";
import { confineToWorkspace } from "../core/workspace_scope.js";
import { theme } from "../ui/theme.js";
import { box } from "../ui/box.js";
import {
  getRegistry, resetRegistry, saveSnapshot, loadSnapshot, listSnapshots,
  ContextRegistry, syncToBackend, loadFromBackend,
} from "../core/context_registry.js";
import { readCustodyLog, shortCustodyHash } from "../core/custody.js";
import { fetchTrail } from "../core/audit.js";
import type { AuditEntry } from "../core/audit.js";
import { openRunSession } from "../core/skills/run_session.js";
import { sanitizeForTransport } from "../core/skills/context_packet.js";
import { applyPromptMode } from "./prompt_modes.js";
import { parseOneTurnSkill } from "./one_turn_skill.js";
import type { AdmittedContext } from "../core/selected_context.js";

export interface ContextInspectorOptions {
  backend?: "local" | "cloud";
  explicitSkill?: string;
  noSkills?: boolean;
}

function showContext(out: Writable, heading: string, admitted: AdmittedContext): void {
  const d = admitted.descriptor;
  out.write(`${heading}\n`);
  out.write(`  mode: ${d.capability} · route: ${d.transport}\n`);
  out.write(`  execution workspace: ${JSON.stringify(d.executionRoot)}\n`);
  out.write(`  pin origin: ${d.originRoot ? JSON.stringify(d.originRoot) : "none"}\n`);
  out.write(`  assembled context: ${d.contextBytes}/${d.contextLimitBytes} bytes\n`);
  out.write(`  rules: ${d.rules.length ? "" : "none"}\n`);
  for (const rule of d.rules) out.write(`    ${JSON.stringify(rule.path)} · ${rule.digest} · ${rule.status}\n`);
  out.write(`  skills: ${d.skills.length ? "" : "none"}\n`);
  for (const skill of d.skills) out.write(`    ${skill.id} · ${skill.digest} · ${skill.invocation}\n`);
  out.write(`  selected files: ${d.files.length ? "" : "none"}\n`);
  for (const file of d.files) {
    const binding = file.executionPath ? ` · bound to ${JSON.stringify(file.executionPath)}` : "";
    const digest = file.digest ? ` · ${file.digest}` : "";
    out.write(`    ${JSON.stringify(file.path)} · ${file.status} · ${file.includedBytes}/${file.sourceBytes ?? "?"} bytes${digest}${binding}\n`);
    out.write(`      ${file.range ?? file.reason}\n`);
  }
}

/** Metadata by default. Content requires an explicit local preview command. */
export async function contextSlash(ctx: AppContext, out: Writable, arg: string, options: ContextInspectorOptions = {}): Promise<void> {
  const registry = getRegistry();
  const command = arg.trim();
  if (!command) {
    if (registry.lastAdmitted) showContext(out, "Last admitted turn (frozen at admission):", registry.lastAdmitted);
    else out.write("Last admitted turn: none in this console.\n");
    out.write(`Next-draft preview: not resolved without a task (${registry.pins.length} pin${registry.pins.length === 1 ? "" : "s"} configured). Use /context next <task>.\n`);
    out.write("Use /context content <project-relative path> to preview an admitted local file.\n");
    return;
  }
  if (command === "next" || command === "content") {
    out.write(command === "next" ? "usage: /context next <task>\n" : "usage: /context content <project-relative path>\n");
    return;
  }
  if (command.startsWith("content ")) {
    const path = command.slice("content ".length).trim().replace(/\\/g, "/");
    const admitted = registry.lastAdmitted;
    if (!admitted) { out.write("No admitted turn is available for a local content preview.\n"); return; }
    const file = admitted.descriptor.files.find((entry) => entry.path === path && entry.status === "included");
    const content = admitted.contents.get(path);
    if (!file || content === undefined) { out.write(`No admitted local file content for ${JSON.stringify(path)}.\n`); return; }
    const bytes = Buffer.from(content, "utf8");
    const limit = 4096;
    const preview = sanitizeForTransport(bytes.subarray(0, limit).toString("utf8"));
    out.write(`Local content preview: ${JSON.stringify(path)} · ${file.digest} · first ${Math.min(bytes.length, limit)}/${bytes.length} UTF-8 bytes\n`);
    out.write(preview + (preview.endsWith("\n") ? "" : "\n"));
    if (bytes.length > limit) out.write("[preview clipped; admitted file was included in full]\n");
    return;
  }
  if (command.startsWith("next ")) {
    const rawTask = command.slice("next ".length);
    if (!rawTask.trim()) { out.write("usage: /context next <task>\n"); return; }
    const oneTurnSkill = parseOneTurnSkill(rawTask);
    if (oneTurnSkill?.kind === "usage") { out.write(oneTurnSkill.message + "\n"); return; }
    if (oneTurnSkill?.kind === "invoke" && options.noSkills) {
      out.write("Next-draft preview refused: /skill is unavailable while --no-skills is active.\n"); return;
    }
    if (oneTurnSkill?.kind === "invoke" && options.backend === "cloud") {
      out.write("Next-draft preview refused: /skill requires host-executed tools; switch to a local model.\n"); return;
    }
    const mode = oneTurnSkill ? { handled: false as const } : applyPromptMode(rawTask);
    if (mode.error) { out.write(mode.error + "\n"); return; }
    if (mode.capability === "planning" && options.backend === "cloud") {
      out.write("Next-draft preview refused: /plan cannot run on server-executed cloud chat. Use aether agent --planning.\n");
      return;
    }
    const prompt = oneTurnSkill?.kind === "invoke" ? oneTurnSkill.task : mode.handled ? mode.prompt! : rawTask;
    const opened = openRunSession({
      projectRoot: ctx.flags.cwd,
      prompt,
      selectedPins: registry.selectedPins(),
      selectedFileTransport: options.backend === "cloud" ? "unsupported" : "host",
      ...(mode.capability ? { capability: mode.capability } : {}),
      ...(oneTurnSkill?.kind === "invoke" ? { explicitSkill: oneTurnSkill.reference }
        : options.explicitSkill ? { explicitSkill: options.explicitSkill } : {}),
      ...(options.noSkills ? { noSkills: true } : {}),
      allowIncompleteInstructionDiscovery: options.backend === "cloud",
    });
    if (!opened.ok) { for (const line of opened.lines) out.write(line + "\n"); return; }
    showContext(out, "Next-draft preview (not admitted or sent):", opened.run.admittedContext());
    return;
  }
  out.write("usage: /context [next <task> | content <project-relative path>]\n");
}

// ── /pin ──────────────────────────────────────

export async function pinSlash(ctx: AppContext, out: Writable, arg: string, _line: string): Promise<void> {
  if (!arg.trim() || arg.trim() === "list" || arg.trim() === "ls") {
    const pins = getRegistry().pins;
    if (pins.length === 0) {
      out.write("(no pinned files — use /pin <path> [reason] to pin one)\n");
      return;
    }
    out.write(theme.cyan("📌  Pinned Context\n"));
    out.write(theme.dim("──────────────────────────────────────────────────────────────\n"));
    for (const p of pins) {
      out.write(`  ${theme.bold(p.label)}  ${theme.dim(p.path)}  ${theme.muted(p.reason)}\n`);
    }
    return;
  }

  const parts = arg.trim().split(/\s+/);
  const pth = parts[0]!;
  const reason = parts.slice(1).join(" ") || "pinned";

  const resolved = confineToWorkspace(ctx.flags.cwd, pth);
  const label = pth.split("/").pop() || pth;

  const entry = getRegistry().pin(resolved, label, reason, ctx.flags.cwd);
  out.write(`${theme.cyan("📌 pinned")} ${theme.bold(entry.label)}  ${theme.dim(entry.path)}  (${entry.reason})\n`);
  out.write(theme.dim("  Its bounded contents will be read from the task's execution checkout at turn admission; /context shows what was included.\n"));
  syncAfter(ctx);
}

// ── /drop ─────────────────────────────────────

export async function dropSlash(ctx: AppContext, out: Writable, arg: string): Promise<void> {
  if (!arg.trim()) {
    const registry = getRegistry();
    out.write("usage: /drop <path>    evict a file from memory context\n");
    out.write("  /drop src/core/old.ts\n");
    if (registry.pins.length > 0) {
      out.write("\n  Pinned files (use /pin list for details):\n");
      for (const p of registry.pins) {
        out.write(`    ${theme.dim(p.label)}\n`);
      }
    }
    if (registry.drops.length > 0) {
      out.write("\n  Recently dropped:\n");
      for (const d of registry.drops.slice(-5)) {
        out.write(`    ${theme.dim(d)}\n`);
      }
    }
    return;
  }

  const pth = arg.trim();
  const registry = getRegistry();
  const resolved = confineToWorkspace(registry.originWorkspace ?? ctx.flags.cwd, pth);
  const wasPinned = registry.isPinned(resolved);
  registry.drop(resolved);

  if (wasPinned) {
    out.write(`${theme.cyan("🗑  dropped")} ${theme.bold(pth)} — removed from pinned context\n`);
  } else {
    out.write(`${theme.cyan("🗑  evicted")} ${theme.dim(pth)}\n`);
    out.write(theme.dim("  (recorded in the drop list; explicit file-reading tools remain available)\n"));
  }
  syncAfter(ctx);
}

// ── /snapshot ─────────────────────────────────

export async function snapshotSlash(ctx: AppContext, out: Writable, arg: string): Promise<void> {
  const registry = getRegistry();
  const sub = arg.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

  if (sub === "resume" || sub === "load") {
    const id = arg.trim().split(/\s+/).slice(1).join(" ");
    if (!id) {
      // Try cloud backend first
      const cloudLoaded = await loadFromBackend(ctx.api, ctx.flags.cwd);
      if (cloudLoaded) {
        const reg = getRegistry();
        out.write(`${theme.cyan("☁ loaded from cloud")} ${theme.bold(reg.sessionLabel)}  (${reg.pins.length} pins, cap ${reg.uvtCap ?? "none"})\n`);
        out.write(theme.dim("  Use /pin list to see restored context.\n"));
        return;
      }
      const snaps = listSnapshots(ctx.flags.cwd);
      if (snaps.length === 0) {
        out.write("(no snapshots — use /snapshot to save one)\n");
        return;
      }
      out.write(theme.cyan("💾  Saved Snapshots\n"));
      out.write(theme.dim("──────────────────────────────────────────────────────────────\n"));
      for (const s of snaps) {
        const pinCnt = s.data.pins.length;
        const cap = s.data.uvtCap ? `  cap ${s.data.uvtCap} UVT` : "";
        out.write(`  ${theme.bold(s.id)}  ${theme.dim(s.data.createdAt)}  ${s.data.sessionLabel}  (${pinCnt} pins${cap})\n`);
      }
      out.write(theme.dim("\n  /snapshot resume <filename>   to restore a snapshot\n"));
      return;
    }
    const data = loadSnapshot(id);
    if (!data) {
      out.write(`no snapshot: ${id}  (use /snapshot to list)\n`);
      return;
    }
    const restored = ContextRegistry.fromSnapshot(data, ctx.flags.cwd);
    resetRegistry();
    Object.assign(getRegistry(), restored);
    out.write(`${theme.cyan("📂 restored")} ${theme.bold(data.sessionLabel)}  (${data.pins.length} pins, cap ${data.uvtCap ?? "none"})\n`);
    out.write(`  cwd: ${data.cwd}\n`);
    out.write(theme.dim("  Use /pin list to see restored context.\n"));
    return;
  }

  if (sub === "list" || sub === "ls") {
    const snaps = listSnapshots(ctx.flags.cwd);
    if (snaps.length === 0) {
      out.write("(no snapshots)\n");
      return;
    }
    out.write(theme.cyan("💾  Snapshots\n"));
    out.write(theme.dim("──────────────────────────────────────────────────────────────\n"));
    for (const s of snaps) {
      const pinCnt = s.data.pins.length;
      out.write(`  ${theme.bold(s.data.sessionLabel)}  ${theme.dim(s.data.createdAt)}  (${pinCnt} pins)\n`);
    }
    return;
  }

  const snapPath = saveSnapshot(registry, ctx.flags.cwd);
  const basename = snapPath.split("/").pop() || snapPath;
  out.write(`${theme.cyan("💾 snapshot saved")}  ${theme.bold(basename)}\n`);
  out.write(`  ${theme.dim(snapPath)}\n`);
  out.write(`  pins: ${registry.pins.length}   UVT cap: ${registry.uvtCap ?? "none"}   drops: ${registry.drops.length}\n`);
  out.write(theme.dim("  Resume with: /snapshot resume <filename>\n"));
  syncAfter(ctx);
}

// ── /limit ────────────────────────────────────

/** Fire-and-forget backend sync. Never blocks the REPL. */
function syncAfter(ctx: AppContext): void {
  void syncToBackend(ctx.api, ctx.flags.cwd).catch(() => {});
}

function renderUvtBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const color = pct > 80 ? theme.muted : pct > 50 ? theme.dim : theme.cyan;
  return color("[" + "█".repeat(filled) + "░".repeat(empty) + "]");
}

export async function limitSlash(ctx: AppContext, out: Writable, arg: string): Promise<void> {
  const registry = getRegistry();

  if (!arg.trim()) {
    const current = registry.uvtCap;
    const status = registry.usageStatus();
    const observed = registry.uvtObserved;
    // "spent: 0" used to print whether the session had cost nothing or whether
    // no usage frame had ever arrived. Those are different answers, and only
    // one of them is a measurement.
    const spentLabel =
      status === "local-unmetered"
        ? "LOCAL — not metered by Aether"
        : observed == null
          ? "unknown — the server has reported no usage yet"
          : String(observed);
    if (current == null) {
      out.write(`UVT cap: none (uncapped)   observed: ${spentLabel}\n`);
    } else if (observed == null || status !== "observed") {
      out.write(`UVT cap: ${theme.bold(String(current))}   observed: ${spentLabel}\n`);
      out.write(theme.dim("  the cap cannot trip until the server reports usage.\n"));
    } else {
      const remaining = Math.max(0, current - observed);
      const pct = current > 0 ? Math.round((observed / current) * 100) : 0;
      out.write(
        `UVT cap: ${theme.bold(String(current))}   observed: ${observed}   remaining: ${remaining}  ${renderUvtBar(pct, 20)}\n`,
      );
    }
    out.write(theme.dim("  /limit <amount>    set cap (e.g., /limit 50000)\n"));
    out.write(theme.dim("  /limit off         remove cap\n"));
    return;
  }

  if (arg.trim().toLowerCase() === "off" || arg.trim().toLowerCase() === "none") {
    registry.uvtCap = null;
    out.write(theme.cyan("UVT cap removed — session is uncapped.\n"));
    return;
  }

  const n = Number(arg.trim());
  if (!Number.isFinite(n) || n <= 0) {
    out.write(`invalid: ${arg} — use a positive number (e.g., /limit 50000)\n`);
    return;
  }

  registry.setUvtCap(Math.floor(n));
  // The old wording promised the agent would "pause and ask permission".
  // Nothing enforced the cap at all, so that was never true. State what now
  // actually happens, and be explicit that this is not a billing control.
  out.write(`${theme.cyan("⚡ UVT cap set")}  ${theme.bold(String(Math.floor(n)))}\n`);
  out.write(
    theme.dim(
      "  no further turn will START once the server-reported spend reaches it.\n" +
        "  a turn already in flight may still complete and be billed.\n" +
        "  this is a local stop only — your plan and balance are unchanged.\n",
    ),
  );
  syncAfter(ctx);
}

// ── /audit-receipt ────────────────────────────

export async function auditReceiptSlash(ctx: AppContext, out: Writable, arg: string): Promise<void> {
  const nArg = Number(arg);
  const limit = Number.isInteger(nArg) && nArg > 0 ? Math.min(nArg, 100) : 20;

  const custody = readCustodyLog(limit);
  let serverEntries: AuditEntry[] = [];
  try {
    serverEntries = await fetchTrail(ctx.api, { limit });
  } catch {
    /* offline — local custody is enough */
  }

  out.write(theme.cyan("🧾  Audit Receipt\n"));
  out.write(theme.dim("──────────────────────────────────────────────────────────────\n"));

  const H_TIME = 26;
  const H_ORDER = 14;
  const H_EVENT = 14;
  const H_COMMIT = 14;
  const H_PATH = 20;

  const header =
    "time".padEnd(H_TIME) +
    "order_id".padEnd(H_ORDER) +
    "event".padEnd(H_EVENT) +
    "commitment".padEnd(H_COMMIT) +
    "path";
  out.write(theme.bold("  " + header) + "\n");
  out.write(theme.dim("  " + "─".repeat(H_TIME + H_ORDER + H_EVENT + H_COMMIT + H_PATH)) + "\n");

  for (const c of custody) {
    const ts = c.received_at != null ? new Date(c.received_at).toISOString().padEnd(H_TIME) : "—".padEnd(H_TIME);
    const oid = (String(c.order_id ?? "—")).slice(0, H_ORDER - 1).padEnd(H_ORDER);
    const evt = "chat_turn".padEnd(H_EVENT);
    const comm = shortCustodyHash(c.commitment).slice(0, H_COMMIT - 1).padEnd(H_COMMIT);
    // Client-held chat custody has a deliberately closed shape and no path.
    const pathCol = "—".padEnd(H_PATH);
    out.write(`  ${theme.dim(ts)}${oid}${theme.cyan(evt)}${theme.dim(comm)}${pathCol}\n`);
  }

  for (const e of serverEntries) {
    const ts = String(e.timestamp).padEnd(H_TIME);
    const oid = e.orderId.slice(0, H_ORDER - 1).padEnd(H_ORDER);
    const evt = e.eventType.padEnd(H_EVENT);
    const comm = (e.commitmentHash ?? "—").slice(0, H_COMMIT - 1).padEnd(H_COMMIT);
    const pathCol = (e.path ?? "—").slice(0, H_PATH - 1).padEnd(H_PATH);
    out.write(`  ${theme.dim(ts)}${theme.dim(oid)}${theme.muted(evt)}${theme.dim(comm)}${pathCol}\n`);
  }

  const totalEntries = custody.length + serverEntries.length;
  const uvtTotal = getRegistry().uvtSpent;
  const boxContent = [
    "",
    `  Total entries: ${totalEntries}`,
    `  UVT spent:     ${uvtTotal}`,
    `  UVT cap:       ${getRegistry().uvtCap ?? "none"}`,
    "",
    "  Export proof:  aether receipt <order_id>",
    "  Full log:      /logs-view",
    "",
  ];
  out.write("\n" + box(boxContent, { width: 60 }) + "\n");
}

// ── /purge ─────────────────────────────────────

export async function purgeSlash(_ctx: AppContext, out: Writable): Promise<void> {
  const registry = getRegistry();
  const { clearedPins, removedFiles } = registry.purge();

  // Reset the registry completely
  resetRegistry();

  // Clear screen
  out.write("\x1b[2J\x1b[H");

  const lines: string[] = [];
  if (clearedPins > 0) lines.push(`${clearedPins} pinned files`);
  if (removedFiles > 0) lines.push(`${removedFiles} temp files`);
  lines.push("UVT cap reset");
  lines.push("context flushed");

  out.write(`${theme.cyan("🧹 purged")}  ${lines.join(" · ")}\n`);
  out.write(theme.dim("  Session goal preserved. Agent memory reset to lean baseline.\n"));
}
