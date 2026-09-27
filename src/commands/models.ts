// `aether models`            — list models + orchestrators (unified catalog)
// `aether models use <id>`   — set the local default model/orchestrator
// `aether agents`            — orchestrators only (filtered from the catalog)
//
// Source: GET /models (lib/plan_tiers.TIER_MATRIX SSOT). One list, `kind`
// distinguishes models from orchestrators. Locked (unavailable-on-tier) rows
// are shown with a lock so users see what an upgrade unlocks.
//
// Layout note: columns are padded by VISIBLE width, not string length. The
// marker column mixes "●" (one column) with "🔒" (two), and ids and labels vary
// in length, so the previous tab-separated rows drifted out of alignment the
// moment an id crossed a tab stop — putting the lock in a different place on
// every row, which is exactly where the eye needs it to be steady.

import type { AppContext } from "../core/context.js";
import type { CatalogItem, CatalogResponse } from "../types.js";
import { MODELS_PATH } from "../core/transport.js";
import { saveConfig } from "../core/config.js";
import { theme } from "../ui/theme.js";
import { visibleWidth } from "../ui/text.js";
import { resolveHostedModel } from "../core/local_ollama.js";
import { errorHint, errorMessage } from "../core/errors.js";
import { formatErrorLine } from "../ui/error_line.js";

async function liveCatalogue(ctx: AppContext): Promise<CatalogResponse | null> {
  if (!(await ctx.tokens.get())) {
    process.stderr.write(
      formatErrorLine("Not signed in", { hint: "run `aether auth login`, then `aether models`" }),
    );
    return null;
  }
  try {
    return await ctx.api.getJson<CatalogResponse>(MODELS_PATH);
  } catch (error) {
    process.stderr.write(formatErrorLine(errorMessage(error), { hint: errorHint(error, ctx.cfg.baseUrl) }));
    return null;
  }
}

export async function cmdModels(ctx: AppContext, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === "use") {
    const id = argv[1];
    if (!id || argv.length !== 2) {
      process.stderr.write("usage: aether models use <id>\n");
      return 2;
    }
    let hostedId: string;
    try {
      hostedId = resolveHostedModel(id);
    } catch (error) {
      process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
      return 2;
    }
    const cat = await liveCatalogue(ctx);
    if (!cat) return 1;
    const selected = cat.models.find((model) => model.id === hostedId);
    if (!selected) {
      process.stderr.write(`Model ${JSON.stringify(hostedId)} is not in the live catalogue. Run: aether models\n`);
      return 1;
    }
    if (!selected.available) {
      const tier = selected.tier_min ? ` (requires ${selected.tier_min})` : "";
      process.stderr.write(
        `Model ${JSON.stringify(hostedId)} is unavailable for this account${tier}. Run: aether models\n`,
      );
      return 1;
    }
    ctx.cfg.defaultModel = hostedId;
    try {
      saveConfig(ctx.cfg);
    } catch (error) {
      process.stderr.write(`Could not save the default model: ${errorMessage(error)}\n`);
      return 1;
    }
    process.stdout.write(`default model → ${hostedId}\n`);
    return 0;
  }

  const cat = await liveCatalogue(ctx);
  if (!cat) return 1;
  if (ctx.flags.json) {
    process.stdout.write(JSON.stringify(cat, null, 2) + "\n");
    return 0;
  }
  const activeDefault = ctx.cfg.defaultModel || cat.default;
  const models = cat.models.filter((m) => m.kind !== "orchestrator");
  const orchestrators = cat.models.filter((m) => m.kind === "orchestrator");

  process.stdout.write(renderHeader(cat.tier, activeDefault));
  if (models.length) process.stdout.write(renderGroup("MODELS", models, activeDefault));
  if (orchestrators.length) {
    process.stdout.write(renderGroup("ORCHESTRATORS", orchestrators, activeDefault));
  }
  process.stdout.write(renderLegend(cat.models, "aether models use <id>"));
  return 0;
}

export async function cmdAgents(ctx: AppContext): Promise<number> {
  const cat = await liveCatalogue(ctx);
  if (!cat) return 1;
  const orchestrators = cat.models.filter((m) => m.kind === "orchestrator");
  if (ctx.flags.json) {
    process.stdout.write(JSON.stringify(orchestrators, null, 2) + "\n");
    return 0;
  }
  const activeDefault = ctx.cfg.defaultModel || cat.default;
  process.stdout.write(renderHeader(cat.tier, activeDefault));
  if (orchestrators.length) {
    process.stdout.write(renderGroup("ORCHESTRATORS", orchestrators, activeDefault));
  }
  process.stdout.write(renderLegend(orchestrators, "aether agent <id>"));
  return 0;
}

// ── rendering ───────────────────────────────────────────────────────────────

/** Pad to `w` VISIBLE columns. Styled text and wide glyphs both pad correctly. */
export function padVisible(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - visibleWidth(s)));
}

/** 128000 -> "128k", 1000000 -> "1M". Long digit runs read as noise in a column. */
export function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`.replace(".0M", "M");
  if (n >= 1_000) return `${Math.round(n / 100) / 10}k`.replace(".0k", "k");
  return String(n);
}

function renderHeader(tier: string, activeDefault: string): string {
  return (
    "\n  " +
    theme.dim("tier ") + theme.bold(theme.cyan(tier)) +
    theme.dim("   default ") + theme.bold(activeDefault) +
    "\n"
  );
}

function renderGroup(title: string, items: CatalogItem[], activeDefault: string): string {
  // Size every column to its widest cell, so nothing truncates and nothing drifts.
  const idW = Math.max(...items.map((m) => visibleWidth(m.id)), 4);
  const provW = Math.max(...items.map((m) => visibleWidth(m.provider ?? "")), 0);
  const labelW = Math.max(...items.map((m) => visibleWidth(m.label)), 0);

  const rows = items.map((m) => {
    const isDefault = m.id === activeDefault;
    // The marker occupies two columns in every state, so the id column starts at
    // the same offset whether or not the row is locked.
    const marker = isDefault ? theme.cyan("● ") : m.available ? "  " : "🔒";
    const id = isDefault ? theme.bold(theme.cyan(m.id)) : m.available ? m.id : theme.dim(m.id);
    const meta = [
      padVisible(theme.dim(m.provider ?? ""), provW),
      padVisible(m.available ? m.label : theme.dim(m.label), labelW),
      m.context_window != null ? theme.dim(compactNumber(m.context_window)) : "",
    ];
    // A locked row has to answer two things: what unlocks it, and what you get
    // for unlocking it. The second used to be missing — `monthly_uvt_cap`
    // answers for the CALLER's tier, so on a locked row it is null by
    // construction, and the number that argues for upgrading was absent from
    // the only row that needed it. `unlock_uvt_cap` is the cap at `tier_min`.
    const gate = !m.available && m.tier_min ? theme.yellow(`needs ${m.tier_min}`) : "";
    const capValue = m.available ? m.monthly_uvt_cap : m.unlock_uvt_cap;
    const cap = capValue != null ? theme.dim(`cap ${compactNumber(capValue)}`) : "";
    const trailing = [gate, cap].filter(Boolean).join(theme.dim(" · "));
    return `  ${marker} ${padVisible(id, idW)}  ${meta.join("  ")}  ${trailing}`.trimEnd();
  });

  return `\n  ${theme.iceBlue(title)}\n${rows.join("\n")}\n`;
}

function renderLegend(items: CatalogItem[], useHint: string): string {
  const locked = items.filter((m) => !m.available).length;
  const parts = [theme.cyan("●") + theme.dim(" default")];
  if (locked) parts.push("🔒" + theme.dim(` ${locked} locked on your tier`));
  return `\n  ${parts.join(theme.dim("  ·  "))}\n  ${theme.dim(useHint)}\n\n`;
}
