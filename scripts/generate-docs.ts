import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMAND_MANIFEST,
  validateCommandManifest,
  type CommandManifestEntry,
  type CommandSurface,
} from "../src/commands/command_manifest.js";
import { GLOBAL_FLAGS } from "../src/commands/cli_registry.js";
import { redactForBundle } from "../src/core/redaction.js";

export const PUBLIC_CATALOGUE_SCHEMA = "aether-cloud/public-model-projection@1" as const;
export const GENERATED_CATALOGUE_SCHEMA = "aether-agent/public-model-catalogue@2" as const;
export const CATALOGUE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export interface PublicCatalogueModel {
  id: string;
  label: string;
  provider: string;
  kind: "model" | "orchestrator";
  tierMin: "free" | "solo" | "pro" | "team";
  modality: "text" | "image" | "video" | "audio" | "multimodal" | "unknown";
  availability: "available" | "unavailable" | "unknown";
}

export interface PublicCatalogueSource {
  schema: typeof PUBLIC_CATALOGUE_SCHEMA;
  sourceVersion: string;
  generatedAt: string;
  digest: string;
  availabilitySemantics: "listed-not-entitled";
  scopeNote: string;
  models: readonly PublicCatalogueModel[];
}

export interface GeneratedCatalogue {
  schema: typeof GENERATED_CATALOGUE_SCHEMA;
  generatedAt: string;
  digest: string;
  source: { kind: "cloud-public-projection"; version: string; digest: string };
  availabilitySemantics: "listed-not-entitled";
  offlineFallback: boolean;
  scopeNote: string;
  models: readonly PublicCatalogueModel[];
}

export interface GeneratedOutput { path: string; content: string }
export interface GenerateDocsOptions {
  root: string;
  check?: boolean;
  commands?: readonly CommandManifestEntry[];
  catalogueSourceText?: string;
  catalogueLiveSourceText?: string;
}

const COMMAND_MARKERS = [
  "<!-- GENERATED-COMMAND-REFERENCE:START -->",
  "<!-- GENERATED-COMMAND-REFERENCE:END -->",
] as const;
const CATALOGUE_MARKERS = [
  "<!-- MODEL-CATALOGUE:START -->",
  "<!-- MODEL-CATALOGUE:END -->",
] as const;
const ID = /^[a-z0-9][a-z0-9._-]*$/;
const PROVIDER = /^(?:unknown|[A-Za-z0-9][A-Za-z0-9 .&+-]*)$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const SECRET = /(?:\b(?:aek_|gh[opusr]_|github_pat_|npm_|pypi-|glpat-|xox[baprs]-)[A-Za-z0-9._-]{8,}|\bsk-[A-Za-z0-9_-]{8,}|\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]+|\bAIza[A-Za-z0-9_-]{20,}|\b(?:AKIA|ASIA)[A-Z0-9]{16})/i;
const GENERIC_CREDENTIAL = /\b[A-Za-z0-9_-]*(?:token|password|passwd|secret|api[-_]?key|authorization|credential|cookie|private[-_]?key|pat)[A-Za-z0-9_-]*\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;]+)/i;
const PRIVATE_NETWORK = /(?:\b(?:localhost|0\.0\.0\.0|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?\b|\b[A-Za-z0-9.-]+\.internal\b|(?:^|[^A-Za-z0-9])(?:::1|(?:f[cd][0-9a-f]{0,2}|fe[89ab][0-9a-f]?):[0-9a-f:]*[0-9a-f])(?:$|[^A-Za-z0-9]))/i;
const INTERNAL_ROUTE = /\/(?:api\/)?internal(?:\/|\b)/i;
const PRICING_ASSERTION = /(?:[$€£]\s*\d|\b(?:usd|eur|gbp)\b|\b(?:price|pricing|costs?|rates?)\b[^.\n]{0,40}\b(?:token|request|image|video|month|hour)\b|\b\d+(?:\.\d+)?\s*(?:cents?|pence)\s+(?:per|\/)\s+(?:token|request|image|video|month|hour)\b)/i;
const MARKDOWN_INJECTION = /(?:<\/?[A-Za-z][^>]*>|\[[^\]\n]*\]\([^)]*\)|!\[|`|\*|__|(?:^|[\s(])_[^_\n]+_(?=$|[\s).,;:!?])|^\s{0,3}#{1,6}(?:\s|$))/m;
const COMMAND_PLACEHOLDERS = new Set([
  "command", "connect|status|disconnect", "desc|view|start|pause|resume|cancel|complete|note",
  "element", "file", "guidance", "id", "id|all", "lang", "login|status|token|refresh|logout",
  "model", "msg", "n", "name", "neo|kronus", "note", "n|id", "order-id", "path", "prompt",
  "q", "subcommand", "tag", "target", "task", "title", "topic", "type", "uvt",
]);

export function normalizeEol(value: string): string { return value.replace(/\r\n?/g, "\n"); }

function maskCommandPlaceholders(value: string): string | undefined {
  let cursor = 0;
  let masked = "";
  while (cursor < value.length) {
    const open = value.indexOf("<", cursor);
    const strayClose = value.indexOf(">", cursor);
    if (strayClose >= 0 && (open < 0 || strayClose < open)) return undefined;
    if (open < 0) return `${masked}${value.slice(cursor)}`;
    masked += value.slice(cursor, open);
    const close = value.indexOf(">", open + 1);
    if (close < 0) return undefined;
    const placeholder = value.slice(open + 1, close);
    if (!COMMAND_PLACEHOLDERS.has(placeholder)) return undefined;
    // A safe word preserves token boundaries. Deleting a multi-character
    // placeholder could join two fragments into fresh markup (for example,
    // `<scr<name>ipt>`), which is not a safe sanitization strategy.
    masked += "placeholder";
    cursor = close + 1;
  }
  return masked;
}

function validatePublicString(value: unknown, label: string, options: { markdown?: boolean; commandArgs?: boolean } = {}): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  if (CONTROL.test(value)) throw new Error(`${label} contains control characters`);
  // Reuse the repository's canonical exported-artifact redactor as a detector,
  // then add provider-token shapes that are intentionally more catalogue-specific.
  // Errors name only the field so rejected credential values never reach logs.
  if (redactForBundle(value, {}) !== value || SECRET.test(value) || GENERIC_CREDENTIAL.test(value)) throw new Error(`${label} contains credential-shaped content`);
  if (PRIVATE_NETWORK.test(value) || INTERNAL_ROUTE.test(value)) throw new Error(`${label} contains an internal route`);
  if (PRICING_ASSERTION.test(value)) throw new Error(`${label} contains a pricing assertion`);
  const markdownInput = options.commandArgs ? maskCommandPlaceholders(value) : value;
  if (options.markdown && (markdownInput === undefined || MARKDOWN_INJECTION.test(markdownInput))) throw new Error(`${label} contains markdown injection`);
  return value.trim();
}

function validateCommandPublicContent(commands: readonly CommandManifestEntry[]): void {
  for (const [index, entry] of commands.entries()) {
    const label = `command ${index}`;
    validatePublicString(entry.section, `${label} section`, { markdown: true });
    validatePublicString(entry.summary, `${label} summary`, { markdown: true });
    if (entry.args !== undefined) validatePublicString(entry.args, `${label} args`, { markdown: true, commandArgs: true });
    validatePublicString(entry.docs.usage, `${label} usage`, { markdown: true, commandArgs: true });
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex")}`;
}

export function parseCatalogue(text: string, now = Date.now()): PublicCatalogueSource {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("public catalogue source is not valid JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("public catalogue source must be an object");
  const source = value as Partial<PublicCatalogueSource>;
  const sourceKeys = new Set(["schema", "sourceVersion", "generatedAt", "digest", "availabilitySemantics", "scopeNote", "models"]);
  const unexpectedSourceKeys = Object.keys(source).filter((key) => !sourceKeys.has(key));
  if (unexpectedSourceKeys.length) throw new Error(`public catalogue source contains unsupported fields: ${unexpectedSourceKeys.join(", ")}`);
  if (source.schema !== PUBLIC_CATALOGUE_SCHEMA) throw new Error(`public catalogue source must use schema ${PUBLIC_CATALOGUE_SCHEMA}`);
  const sourceVersion = validatePublicString(source.sourceVersion, "public catalogue sourceVersion");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sourceVersion)) throw new Error("public catalogue sourceVersion is invalid");
  if (typeof source.generatedAt !== "string") throw new Error("public catalogue source has an invalid generatedAt timestamp");
  validatePublicString(source.generatedAt, "public catalogue generatedAt");
  const generated = Date.parse(source.generatedAt);
  if (!Number.isFinite(generated) || new Date(generated).toISOString() !== source.generatedAt) throw new Error("public catalogue source has an invalid generatedAt timestamp");
  if (generated > now + 5 * 60_000) throw new Error("public catalogue generatedAt is materially in the future");
  if (now - generated > CATALOGUE_MAX_AGE_MS) throw new Error("public catalogue projection is stale");
  if (source.availabilitySemantics !== "listed-not-entitled") throw new Error("public catalogue availability semantics are invalid");
  if (typeof source.digest !== "string" || !DIGEST.test(source.digest)) throw new Error("public catalogue projection digest is invalid");
  validatePublicString(source.scopeNote, "public catalogue scopeNote", { markdown: true });
  if (!Array.isArray(source.models) || source.models.length === 0) throw new Error("public catalogue refresh is empty; last-known-good outputs were preserved");
  const ids = new Set<string>();
  for (const [index, item] of source.models.entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error(`public catalogue model ${index} must be an object`);
    const model = item as Partial<PublicCatalogueModel>;
    const modelKeys = new Set(["id", "label", "provider", "kind", "tierMin", "modality", "availability"]);
    const unexpectedModelKeys = Object.keys(model).filter((key) => !modelKeys.has(key));
    if (unexpectedModelKeys.length) throw new Error(`public catalogue model ${index} contains unsupported fields: ${unexpectedModelKeys.join(", ")}`);
    if (typeof model.id !== "string") throw new Error(`public catalogue model ${index} has an invalid id`);
    validatePublicString(model.id, `public catalogue model ${index} id`);
    if (!ID.test(model.id) || model.id === "model") throw new Error(`public catalogue model ${index} has an invalid or generic id`);
    if (ids.has(model.id)) throw new Error(`public catalogue contains duplicate model id ${model.id}`);
    ids.add(model.id);
    validatePublicString(model.label, `public catalogue model ${model.id} label`, { markdown: true });
    if (typeof model.provider !== "string") throw new Error(`public catalogue model ${model.id} has an invalid provider`);
    validatePublicString(model.provider, `public catalogue model ${model.id} provider`, { markdown: true });
    if (!PROVIDER.test(model.provider)) throw new Error(`public catalogue model ${model.id} has an invalid provider`);
    if (model.kind !== "model" && model.kind !== "orchestrator") throw new Error(`public catalogue model ${model.id} has an invalid kind`);
    if (!(["free", "solo", "pro", "team"] as const).includes(model.tierMin as "free")) throw new Error(`public catalogue model ${model.id} has an invalid tierMin`);
    if (!(["text", "image", "video", "audio", "multimodal", "unknown"] as const).includes(model.modality as "text")) throw new Error(`public catalogue model ${model.id} has an invalid modality`);
    if (!(["available", "unavailable", "unknown"] as const).includes(model.availability as "available")) throw new Error(`public catalogue model ${model.id} has an invalid availability state`);
  }
  const { digest: _digest, generatedAt: _generatedAt, ...content } = source as PublicCatalogueSource;
  if (sha256(content) !== source.digest) throw new Error("public catalogue projection digest does not match its canonical content");
  return source as PublicCatalogueSource;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|<>])/g, "\\$1").replace(/\s+/g, " ").trim();
}
function inlineCode(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  const longest = Math.max(0, ...[...clean.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${longest ? " " : ""}${clean}${longest ? " " : ""}${fence}`;
}
function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function flagUsage(name: string, spec: { type: "boolean" | "string"; short?: string; multiple?: boolean }): string {
  const long = `--${name}${spec.type === "string" ? ` <value>${spec.multiple ? "…" : ""}` : ""}`;
  return spec.short ? `-${spec.short}, ${long}` : long;
}

export function renderCommandReference(commands: readonly CommandManifestEntry[]): string {
  // Content validation must precede structural manifest validation: the latter's
  // diagnostics can quote malformed usage strings, while public-doc rejection
  // must never echo a credential-bearing mutation.
  validateCommandPublicContent(commands);
  const errors = validateCommandManifest(commands, { reservedShellFlags: GLOBAL_FLAGS });
  if (errors.length) throw new Error(`command manifest is invalid: ${errors.join("; ")}`);
  const visible = commands.filter((entry) => !entry.hidden && entry.docs.visible);
  if (!visible.some((entry) => entry.surface === "shell") || !visible.some((entry) => entry.surface === "slash")) {
    throw new Error("command manifest must expose at least one shell and one slash command");
  }
  const digest = sha256(commands);
  const lines = [
    "<!-- GENERATED FILE: run `npm run docs:generate`; do not edit by hand. -->",
    `<!-- manifest-digest: ${digest} -->`,
    "# Generated command reference",
    "",
    "This reference is generated from the validated, versioned command manifest. Availability is evaluated at runtime; a listed command may still require authentication, a hosted capability, or local tooling.",
    "",
    "Global shell flags accepted by the manifest:",
    "",
    [...new Set(visible.filter((entry) => entry.surface === "shell").flatMap((entry) => entry.acceptedGlobalFlags))]
      .filter((flag) => flag !== "swarm")
      .sort()
      .map((flag) => inlineCode(`--${flag}`))
      .join(", "),
    "",
  ];
  for (const surface of ["shell", "slash"] as const satisfies readonly CommandSurface[]) {
    lines.push(`## ${surface === "shell" ? "Shell commands" : "Interactive slash commands"}`, "");
    const sections = [...new Set(visible.filter((entry) => entry.surface === surface).map((entry) => entry.section))];
    for (const section of sections) {
      lines.push(`### ${escapeMarkdown(section)}`, "");
      for (const entry of visible.filter((candidate) => candidate.surface === surface && candidate.section === section)) {
        lines.push(`#### ${inlineCode(entry.docs.usage)}`, "", escapeMarkdown(entry.summary), "");
        const metadata = [
          `Permission: ${inlineCode(entry.permissionClass)}`,
          `Availability: ${inlineCode(entry.availability.state)}`,
          `Telemetry: ${inlineCode(entry.telemetryName)}`,
        ];
        if (entry.aliases.length) metadata.push(`Aliases: ${entry.aliases.map((alias) => inlineCode(`${surface === "slash" ? "/" : "aether "}${alias}`)).join(", ")}`);
        if (entry.availability.capabilityRequirements.length) metadata.push(`Requires: ${entry.availability.capabilityRequirements.map(inlineCode).join(", ")}`);
        lines.push(metadata.join(" · "), "");
        const owned = Object.entries(entry.ownedFlags);
        if (owned.length) {
          lines.push("Command flags:", "");
          for (const [name, spec] of owned) lines.push(`- ${inlineCode(flagUsage(name, spec))}`);
          lines.push("");
        }
      }
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function generatedCatalogue(source: PublicCatalogueSource, offlineFallback: boolean): GeneratedCatalogue {
  const models = [...source.models].map((model) => ({ ...model })).sort((a, b) => a.id.localeCompare(b.id));
  const catalogue = {
    schema: GENERATED_CATALOGUE_SCHEMA,
    generatedAt: source.generatedAt,
    source: { kind: "cloud-public-projection" as const, version: source.sourceVersion, digest: source.digest },
    availabilitySemantics: source.availabilitySemantics,
    offlineFallback,
    scopeNote: source.scopeNote,
    models,
  };
  return { ...catalogue, digest: sha256(catalogue) };
}

export function renderCatalogueMarkdown(catalogue: GeneratedCatalogue): string {
  const lines = [
    "<!-- GENERATED FILE: run `npm run docs:generate`; do not edit by hand. -->",
    `<!-- catalogue-digest: ${catalogue.digest} -->`,
    "# Public model catalogue snapshot",
    "",
    escapeMarkdown(catalogue.scopeNote),
    "",
    `- Snapshot time: ${inlineCode(catalogue.generatedAt)}`,
    `- Source: Cloud public projection ${inlineCode(catalogue.source.version)}`,
    `- Source digest: ${inlineCode(catalogue.source.digest)}`,
    `- Availability: ${inlineCode(catalogue.availabilitySemantics)}`,
    `- Offline fallback snapshot: ${catalogue.offlineFallback ? "yes" : "no"}`,
    `- Digest: ${inlineCode(catalogue.digest)}`,
    "",
    "| Model | ID | Provider | Modality | Tier | Availability |",
    "|---|---|---|---|---|---|",
    ...catalogue.models.map((model) => `| ${escapeMarkdown(model.label)} | ${inlineCode(model.id)} | ${escapeMarkdown(model.provider)} | ${escapeMarkdown(model.modality)} | ${escapeMarkdown(model.tierMin)} | ${escapeMarkdown(model.availability)} |`),
    "",
    "Runtime availability is account-scoped. Use `aether models` while signed in for the authoritative live result. This snapshot contains no prices, spend caps, internal routes, or credentials.",
  ];
  return `${lines.join("\n")}\n`;
}

export function renderCatalogueHtml(catalogue: GeneratedCatalogue): string {
  const providers = [...new Set(catalogue.models.map((model) => model.provider))].sort();
  const modalities = ["text", "image", "video", "audio", "multimodal", "unknown"] as const;
  const tiers = ["free", "solo", "pro", "team"] as const;
  const availabilityStates = ["available", "unavailable", "unknown"] as const;
  const cards = catalogue.models.map((model) => `
      <article class="card" data-search="${escapeHtml(`${model.label} ${model.id} ${model.provider} ${model.kind} ${model.modality} ${model.tierMin} ${model.availability}`.toLowerCase())}" data-provider="${escapeHtml(model.provider)}" data-modality="${model.modality}" data-tier="${model.tierMin}" data-availability="${model.availability}">
        <h2>${escapeHtml(model.label)}</h2><p><code>${escapeHtml(model.id)}</code></p>
        <dl><div><dt>Provider</dt><dd>${escapeHtml(model.provider)}</dd></div><div><dt>Modality</dt><dd>${model.modality}</dd></div><div><dt>Minimum documented tier</dt><dd>${model.tierMin}</dd></div><div><dt>Availability</dt><dd>${model.availability}</dd></div></dl>
      </article>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="aether-agent docs generator"><title>Aether Agent public model catalogue</title>
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.5}body{max-width:72rem;margin:auto;padding:clamp(1rem,4vw,3rem);background:#0c1018;color:#eef2ff}a{color:#8bd5ff}.lede{max-width:70ch}.meta{color:#bac4d8}.controls{display:none;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.75rem;margin:2rem 0}.controls label{display:grid;gap:.3rem}.controls label:first-child{grid-column:span 2}input,select{font:inherit;padding:.65rem;border:1px solid #65708a;border-radius:.45rem;background:#151c2a;color:inherit}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr));gap:1rem}.card{border:1px solid #3c465b;border-radius:.8rem;padding:1rem;background:#141b29}.card h2{margin:.1rem 0}.card p{margin:.2rem 0 1rem}dl{margin:0}dl div{display:flex;justify-content:space-between;gap:1rem;border-top:1px solid #30394b;padding:.4rem 0}dt{color:#bac4d8}dd{margin:0;text-align:right}body[data-enhanced] .controls{display:grid}.hidden{display:none}@media(max-width:38rem){body[data-enhanced] .controls{grid-template-columns:1fr}.controls label:first-child{grid-column:auto}dl div{display:block}dd{text-align:left}}@media(prefers-reduced-motion:no-preference){.card{transition:opacity .15s}}</style></head>
<body><main><h1>Public model catalogue snapshot</h1><p class="lede">${escapeHtml(catalogue.scopeNote)}</p>
<p class="meta">Snapshot: <time datetime="${catalogue.generatedAt}">${catalogue.generatedAt}</time> · Cloud source: ${escapeHtml(catalogue.source.version)} · Source digest: <code>${catalogue.source.digest}</code> · Catalogue digest: <code>${catalogue.digest}</code> · Offline fallback: ${catalogue.offlineFallback ? "yes" : "no"}</p>
<p>This page is useful without JavaScript. Runtime availability is account-scoped; use <code>aether models</code> while signed in for the authoritative live result. No prices or spend caps are asserted here.</p>
<form class="controls" role="search" onsubmit="return false"><label>Search<input id="q" type="search" autocomplete="off" placeholder="Model, ID, or provider"></label><label>Provider<select id="provider"><option value="">All providers</option>${providers.map((item) => `<option>${escapeHtml(item)}</option>`).join("")}</select></label><label>Modality<select id="modality"><option value="">All modalities</option>${modalities.map((item) => `<option>${item}</option>`).join("")}</select></label><label>Tier<select id="tier"><option value="">All tiers</option>${tiers.map((item) => `<option>${item}</option>`).join("")}</select></label><label>Availability<select id="availability"><option value="">All availability states</option>${availabilityStates.map((item) => `<option>${item}</option>`).join("")}</select></label></form>
<p id="status" aria-live="polite"></p><section class="grid" aria-label="Documented catalogue models">${cards}
</section><noscript><p>Search and filters require JavaScript; every catalogue entry remains visible above.</p></noscript></main>
<script>document.body.dataset.enhanced="";const q=document.querySelector("#q"),filters=["provider","modality","tier","availability"].map(id=>document.querySelector("#"+id)),s=document.querySelector("#status"),cards=[...document.querySelectorAll(".card")];function apply(){const needle=q.value.trim().toLowerCase();let shown=0;for(const card of cards){const visible=(!needle||card.dataset.search.includes(needle))&&filters.every(filter=>!filter.value||card.dataset[filter.id]===filter.value);card.classList.toggle("hidden",!visible);if(visible)shown++}s.textContent=shown+" of "+cards.length+" entries shown"}q.addEventListener("input",apply);for(const filter of filters)filter.addEventListener("change",apply);apply();</script></body></html>\n`;
}

function replaceBounded(text: string, markers: readonly [string, string], body: string, path: string): string {
  const normalized = normalizeEol(text);
  const start = normalized.indexOf(markers[0]);
  const end = normalized.indexOf(markers[1]);
  if (start < 0 || end <= start || normalized.indexOf(markers[0], start + 1) >= 0 || normalized.indexOf(markers[1], end + 1) >= 0) throw new Error(`${path} must contain exactly one ordered ${markers[0]} marker pair`);
  return `${normalized.slice(0, start + markers[0].length)}\n${body.trim()}\n${normalized.slice(end)}`;
}

export function buildGeneratedOutputs(options: GenerateDocsOptions): GeneratedOutput[] {
  const root = resolve(options.root);
  const commands = options.commands ?? COMMAND_MANIFEST;
  const fallbackText = normalizeEol(options.catalogueSourceText ?? readFileSync(join(root, "docs", "model-catalogue", "catalogue.source.json"), "utf8"));
  let source: PublicCatalogueSource;
  let offlineFallback = options.catalogueSourceText === undefined;
  if (options.catalogueLiveSourceText !== undefined) {
    try { source = parseCatalogue(normalizeEol(options.catalogueLiveSourceText)); offlineFallback = false; }
    catch { source = parseCatalogue(fallbackText); offlineFallback = true; }
  } else source = parseCatalogue(fallbackText);
  const catalogue = generatedCatalogue(source, offlineFallback);
  const commandReference = renderCommandReference(commands);
  const commandsDoc = readFileSync(join(root, "COMMANDS.md"), "utf8");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const commandBody = "The complete manifest-derived reference is [docs/generated/commands.md](docs/generated/commands.md). Regenerate it with `npm run docs:generate`; verify drift with `npm run docs:check`.";
  const catalogueBody = `A dated, sanitized ${catalogue.offlineFallback ? "offline fallback " : ""}snapshot is available as [HTML](docs/model-catalogue/index.html), [JSON](docs/model-catalogue/catalogue.json), and [Markdown](docs/generated/model-catalogue.md). It was generated at \`${catalogue.generatedAt}\` from Cloud public projection \`${catalogue.source.version}\` with verified digest \`${catalogue.source.digest}\`. Listed availability is not an account entitlement; use \`aether models\` while signed in.`;
  const json = `${JSON.stringify(catalogue, null, 2)}\n`;
  return [
    { path: "docs/generated/commands.md", content: commandReference },
    { path: "docs/generated/model-catalogue.md", content: renderCatalogueMarkdown(catalogue) },
    { path: "docs/model-catalogue/catalogue.json", content: json },
    { path: "docs/model-catalogue/index.html", content: renderCatalogueHtml(catalogue) },
    { path: "COMMANDS.md", content: replaceBounded(commandsDoc, COMMAND_MARKERS, commandBody, "COMMANDS.md") },
    { path: "README.md", content: replaceBounded(readme, CATALOGUE_MARKERS, catalogueBody, "README.md") },
  ];
}

function writeAtomically(root: string, outputs: readonly GeneratedOutput[]): void {
  const staged: { path: string; temp: string; prior: string | null }[] = [];
  try {
    for (const output of outputs) {
      const path = join(root, output.path); mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.docs-tmp-${process.pid}`;
      writeFileSync(temp, output.content, "utf8");
      staged.push({ path, temp, prior: existsSync(path) ? readFileSync(path, "utf8") : null });
    }
    for (const item of staged) renameSync(item.temp, item.path);
  } catch (error) {
    for (const item of staged) {
      if (existsSync(item.temp)) rmSync(item.temp, { force: true });
      if (item.prior !== null && (!existsSync(item.path) || readFileSync(item.path, "utf8") !== item.prior)) writeFileSync(item.path, item.prior, "utf8");
      if (item.prior === null && existsSync(item.path)) rmSync(item.path, { force: true });
    }
    throw error;
  }
}

export function generateDocumentation(options: GenerateDocsOptions): GeneratedOutput[] {
  const root = resolve(options.root);
  const outputs = buildGeneratedOutputs({ ...options, root });
  if (options.check) {
    const drift = outputs.filter((output) => !existsSync(join(root, output.path)) || normalizeEol(readFileSync(join(root, output.path), "utf8")) !== normalizeEol(output.content)).map((output) => output.path);
    if (drift.length) throw new Error(`generated documentation drift: ${drift.join(", ")}; run npm run docs:generate`);
  } else writeAtomically(root, outputs);
  return outputs;
}

function main(): void {
  const root = process.cwd();
  const check = process.argv.slice(2).includes("--check");
  const outputs = generateDocumentation({ root, check });
  const verb = check ? "checked" : "generated";
  process.stdout.write(`${verb} ${outputs.length} documentation outputs\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) main();
