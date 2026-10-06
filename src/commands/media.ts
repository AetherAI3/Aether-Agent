// `aether image "<prompt>" [--model] [--aspect] [--count] [--4k] [--vector] [-i]`
// `aether video "<prompt>" [--model] [--duration] [--1080p] [--audio] [-i]`
// `aether image models`  /  `aether video models`
//
// Full control over image/video generation from the terminal.

import type { AppContext } from "../core/context.js";
import type { CatalogResponse } from "../types.js";
import { MODELS_PATH } from "../core/transport.js";
import { fail as coreFail } from "../core/errors.js";
import { hintFor } from "../core/error_hints.js";
import {
  filterMediaModels, resolveModelKey, autoRouteModel,
  buildMediaPrompt, dispatchGeneration, downloadMediaFile,
  ensureOutputDir, recordOutput, openOutput,
  IMAGE_SHORTCUTS, VIDEO_SHORTCUTS,
  type MediaKind, type MediaModel, type GenFlags, type GenResult,
} from "../core/vision.js";
import { theme } from "../ui/theme.js";
import { sanitizeTerm } from "../ui/text.js";
import { rcArtifactObserver } from "./rc_artifacts.js";
import { basename } from "node:path";
import { createInterface, type Interface } from "node:readline";

// ═════════════════════════════════════════════════════════════════════
// Entry points
// ═════════════════════════════════════════════════════════════════════

export async function cmdImage(ctx: AppContext, argv: string[]): Promise<number> {
  return mediaDispatch(ctx, argv, "image");
}

export async function cmdVideo(ctx: AppContext, argv: string[]): Promise<number> {
  return mediaDispatch(ctx, argv, "video");
}

async function mediaDispatch(ctx: AppContext, argv: string[], kind: MediaKind): Promise<number> {
  const sub = (argv[0] ?? "").toLowerCase();
  if (sub === "models" || sub === "list") return mediaModelsList(ctx, kind);
  if (sub === "interactive" || sub === "i") return mediaInteractive(ctx, kind);
  if (sub === "help" || sub === "") { printMediaHelp(kind); return 0; }

  const flags = parseFlags(argv.join(" "));
  const prompt = extractPrompt(argv);
  if (!prompt) {
    process.stderr.write(`usage: aether ${kind} "<prompt>" [flags]\n`);
    printMediaHelp(kind);
    return 2;
  }
  return mediaGenerate(ctx, prompt, kind, flags);
}

// ═════════════════════════════════════════════════════════════════════
// Flag parsing
// ═════════════════════════════════════════════════════════════════════

function parseFlags(raw: string): GenFlags {
  const flags: GenFlags = {};
  const parts = raw.split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const next = parts[i + 1] ?? "";
    if (p === "--model" && next) { flags.model = next; i++; }
    else if (p === "--aspect" && next) { flags.aspect = next; i++; }
    else if ((p === "--count" || p === "--batch") && next) { flags.count = parseInt(next, 10) || 1; i++; }
    else if (p === "--4k") { flags.fourK = true; }
    else if (p === "--vector") { flags.vector = true; }
    else if ((p === "--duration" || p === "--10s") && next) { flags.duration = parseInt(next, 10) || 10; i++; }
    else if (p === "--1080p") { flags.hd1080 = true; }
    else if (p === "--audio") { flags.audio = true; }
    else if (p === "--save-to-vault") { flags.saveToVault = true; }
    else if (p === "--ref" && next) { flags.ref = next; i++; }
    else if (p === "--open") { flags.open = true; }
  }
  return flags;
}

function extractPrompt(argv: string[]): string {
  const parts: string[] = [];
  for (const a of argv) { if (a.startsWith("--")) break; parts.push(a); }
  return parts.join(" ");
}

// ═════════════════════════════════════════════════════════════════════
// Model listing
// ═════════════════════════════════════════════════════════════════════

async function mediaModelsList(ctx: AppContext, kind: MediaKind): Promise<number> {
  try {
    const cat = await ctx.api.getJson<CatalogResponse>(MODELS_PATH);
    const models = filterMediaModels(cat.models, kind);
    if (ctx.flags.json) { process.stdout.write(JSON.stringify(models, null, 2) + "\n"); return 0; }
    const icon = kind === "video" ? "🎬" : "🖼";
    process.stdout.write(`\n${icon}  ${kind.toUpperCase()} MODELS\n\n`);
    for (const m of models) {
      const mark = m.id === ctx.cfg.defaultModel ? theme.iceBlue("*") : " ";
      const lock = m.available ? " " : "🔒";
      const cap = m.monthly_uvt_cap != null ? `  cap ${m.monthly_uvt_cap.toLocaleString()}` : "";
      const prov = m.provider ? theme.dim(` (${m.provider})`) : "";
      const shortcuts = Object.entries(kind === "image" ? IMAGE_SHORTCUTS : VIDEO_SHORTCUTS)
        .filter(([, v]) => v === m.id).map(([k]) => k).join(", ");
      const alias = shortcuts ? theme.dim(` [${shortcuts}]`) : "";
      process.stdout.write(`${mark} ${lock} ${m.id}  ${m.label}${prov}${alias}${cap}\n`);
    }
    process.stdout.write("\n");
    return 0;
  } catch (err) { return fail(err); }
}

// ═════════════════════════════════════════════════════════════════════
// Interactive guided mode
// ═════════════════════════════════════════════════════════════════════

async function mediaInteractive(ctx: AppContext, kind: MediaKind): Promise<number> {
  const icon = kind === "video" ? "🎬" : "🖼";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const write = (s: string) => { process.stdout.write(s); };

  write(theme.iceBlue(`\n${icon}  Aether ${kind === "video" ? "Video" : "Image"} Generation\n\n`));

  const cat = await ctx.api.getJson<CatalogResponse>(MODELS_PATH);
  const models = filterMediaModels(cat.models, kind).filter(m => m.available);
  write("Available models:\n\n");
  for (let i = 0; i < models.length; i++) {
    const m = models[i]!;
    const shortcut = Object.entries(kind === "image" ? IMAGE_SHORTCUTS : VIDEO_SHORTCUTS)
      .find(([, v]) => v === m.id)?.[0];
    write(`  ${i + 1}. ${m.label}${shortcut ? theme.dim(` (${shortcut})`) : ""}\n`);
  }
  write("\n");

  write(theme.dim(`Select model [1-${models.length}] or type shortcut: `));
  const modelInput = await read(rl);
  const modelKey = resolveModelShortcut(modelInput, models, kind);
  write(`  → model: ${modelKey ? modelKey : "auto"}\n\n`);

  write(theme.dim("Prompt: "));
  const prompt = await read(rl);
  if (!prompt) { process.stderr.write("no prompt entered\n"); rl.close(); return 1; }

  const resOpts = kind === "video" ? ["720p (default)", "1080p", "4K"] : ["standard", "4K"];
  write(theme.dim(`Resolution [${resOpts.join(" / ")}]: `));
  const res = (await read(rl)).toLowerCase();

  write(theme.dim("Count [1-10]: "));
  const cnt = parseInt(await read(rl), 10) || 1;
  write("\n");

  let audio = false;
  if (kind === "video") {
    write(theme.dim("Native audio? [y/N]: "));
    audio = /^y(es)?$/i.test(await read(rl));
  }

  rl.close();

  const flags: GenFlags = {
    model: modelKey, count: Math.min(10, Math.max(1, cnt)),
    fourK: res.includes("4k"), hd1080: res.includes("1080"), audio,
  };
  return mediaGenerate(ctx, prompt, kind, flags);
}

function read(rl: Interface): Promise<string> {
  return new Promise(resolve => { rl.once("line", (line: string) => { rl.pause(); resolve(line.trim()); }); });
}

function resolveModelShortcut(input: string, models: MediaModel[], _kind: MediaKind): string | undefined {
  const n = parseInt(input, 10);
  if (!isNaN(n) && n >= 1 && n <= models.length) return models[n - 1]?.id;
  const resolved = resolveModelKey(input);
  if (models.some(m => m.id === resolved)) return resolved;
  return undefined;
}

// ═════════════════════════════════════════════════════════════════════
// Generation + batch
// ═════════════════════════════════════════════════════════════════════

async function mediaGenerate(ctx: AppContext, prompt: string, kind: MediaKind, flags: GenFlags): Promise<number> {
  const modelKey = flags.model ? resolveModelKey(flags.model) : autoRouteModel(prompt, kind);
  const fullPrompt = buildMediaPrompt(prompt, flags, kind);
  const count = Math.min(10, Math.max(1, flags.count ?? 1));
  const outdir = ensureOutputDir();

  process.stdout.write(theme.dim(`generating ${count} ${kind}(s) with ${modelKey}: "${prompt}"\n\n`));

  for (let i = 0; i < count; i++) {
    try {
      const vp = count > 1 ? `${fullPrompt} [variant ${i + 1} of ${count}]` : fullPrompt;
      process.stdout.write(theme.dim(`[${i + 1}/${count}] `));
      const resp = await dispatchGeneration(ctx.api, vp, modelKey, flags);
      const text = resp.response || resp.text || "";
      if (resp.media_url) {
        process.stdout.write(theme.dim("downloading...\n"));
        const filepath = await downloadMediaFile(ctx.api, resp.media_url, outdir, modelKey, kind, resp.filename);
        const result: GenResult = {
          model: modelKey, prompt: vp, kind, filepath, filename: basename(filepath),
          url: resp.media_url, timestamp: new Date().toISOString(), flags,
        };
        const { entry, warning } = recordOutput(result, { onCommitted: rcArtifactObserver(ctx) });
        if (warning) process.stderr.write(theme.dim(`  ⚠  ${warning.message}\n`));
        // resp.media_url and resp.text/response below are server-controlled
        // (an LLM generation response) — sanitized before hitting the
        // terminal, same as every other server-supplied string in this flow
        // (see sanitizeServerText's own doc comment in transport.ts).
        process.stdout.write(
          `  ${theme.iceBlue("↓")} #${entry.sequence}  ${entry.filename}\n` +
          `  ${theme.dim(`url: ${sanitizeTerm(resp.media_url)}`)}\n\n`
        );
        if (flags.open) {
          const outcome = openOutput(entry);
          if (outcome.status !== "spawned") {
            process.stderr.write(theme.dim(`  could not open: ${outcome.detail}\n`));
          }
        }
      } else {
        process.stdout.write(theme.dim("  no media URL in response\n"));
        process.stdout.write(theme.dim(`  ${sanitizeTerm(text.slice(0, 200))}\n`));
      }
    } catch (err) {
      // LOOP-01 round 2: dispatchGeneration()/downloadMediaFile() already
      // throw a classified HttpError (401/402/403/5xx) — this used to print
      // only the raw message with no actionable next step at all. Sanitized:
      // a raw fetch()-level failure on a hostile media_url can otherwise
      // carry attacker-controlled bytes straight from err.message.
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`✗ ${sanitizeTerm(msg)}\n`);
      const hint = hintFor(err);
      if (hint) process.stdout.write(theme.dim(`  ⤷ ${hint}\n`));
    }
  }
  process.stdout.write(theme.dim(`\noutput: ${outdir}/\nview: aether output\n`));
  process.stdout.write(theme.dim("open:  aether output open <n>\n\n"));
  return 0;
}

// ═════════════════════════════════════════════════════════════════════
// Help
// ═════════════════════════════════════════════════════════════════════

function printMediaHelp(kind: MediaKind): void {
  const v = kind === "video";
  process.stdout.write([
    v ? 'aether video "<prompt>" [--model] [--duration] [--1080p] [--audio] [--i]'
      : 'aether image "<prompt>" [--model] [--aspect] [--count] [--4k] [--vector] [--i]',
    `aether ${kind} models                List ${kind} models`,
    `aether ${kind} interactive            Step-through guided picker`,
    "aether output               Show recent 10 generations",
    "",
  ].join("\n"));
}

// See vault.ts's identical fix for why hintFor() replaces the hardcoded hint.
function fail(err: unknown): number {
  return coreFail(err, hintFor(err) ?? undefined);
}
