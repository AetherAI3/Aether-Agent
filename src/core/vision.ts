// src/core/vision.ts — media asset production engine
//
// Pure logic: model shortcuts, auto-routing, aspect ratios, prompt builder,
// download helpers with streaming fetch, output manager with persistent log.
// No terminal I/O. Every function wraps a single concept.

import { ApiClient, defaultStreamTimeoutMs } from "./transport.js";
import type { CatalogItem } from "../types.js";
import { createWriteStream, mkdirSync, readdirSync, statSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { openTarget, type OpenOutcome } from "./opener.js";
import {
  historyPaths,
  loadHistory,
  type HistoryState,
  type HistoryWarning,
  type MediaEntry,
  type MediaEntrySource,
} from "./media_history.js";
import {
  appendEntry,
  clearHistory,
  listEntries,
  resolveRef,
} from "./media_history_store.js";

// ═════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════

export const VISION_PREFIX = "vision_";

export type MediaKind = "image" | "video" | "3d";

export interface MediaModel {
  id: string;
  label: string;
  kind: MediaKind;
  provider: string | null;
  tier_min: string | null;
  available: boolean;
  enabled: boolean;
  monthly_uvt_cap: number | null;
}

export interface AspectRatio {
  value: string;
  display: string;
  w: number; h: number;
}

export interface GenFlags {
  model?: string;
  aspect?: string;
  count?: number;
  fourK?: boolean;
  vector?: boolean;
  duration?: number;
  hd1080?: boolean;
  audio?: boolean;
  saveToVault?: boolean;
  ref?: string;
  open?: boolean;
}

export interface GenResult {
  model: string;
  prompt: string;
  kind: MediaKind;
  filepath: string;
  filename: string;
  url: string;
  timestamp: string;
  flags: GenFlags;
  // storyboard fields (set during storyboard render)
  generated_frame_url?: string;
  generated_frame_path?: string;
}

export interface OutputEntry {
  /** Canonical identity. Never reused, never re-derived. */
  artifactId: string;
  /** Human-friendly monotonic alias — what `output open <n>` takes. */
  sequence: string;
  filename: string;
  filepath: string;
  model: string;
  prompt: string;
  kind: MediaKind;
  url: string;
  timestamp: string;
  size_bytes: number;
  /** "recovered" marks an entry rebuilt from disk, with unknown prompt/model. */
  source: MediaEntrySource;
}

export interface RecordedOutput {
  entry: OutputEntry;
  /** Set when the generation this appended to had to be recovered. */
  warning?: HistoryWarning;
}

export interface OutputListing {
  entries: OutputEntry[];
  state: HistoryState;
  warning?: HistoryWarning;
}

export type OutputLookup =
  | { status: "found"; entry: OutputEntry; warning?: HistoryWarning }
  | { status: "not-found"; warning?: HistoryWarning }
  | { status: "ambiguous"; candidates: OutputEntry[]; warning?: HistoryWarning };

export interface ChatGenResponse {
  response?: string; text?: string;
  media_url?: string; filename?: string;
}

export const ASPECT_RATIOS: Record<string, AspectRatio> = {
  "16_9": { value: "16_9", display: "16:9", w: 16, h: 9 },
  "9_16": { value: "9_16", display: "9:16", w: 9, h: 16 },
  "1_1":  { value: "1_1",  display: "1:1",  w: 1,  h: 1 },
  "3_4":  { value: "3_4",  display: "3:4",  w: 3,  h: 4 },
  "4_3":  { value: "4_3",  display: "4:3",  w: 4,  h: 3 },
};

// ═════════════════════════════════════════════════════════════════════
// Model shortcuts
// ═════════════════════════════════════════════════════════════════════

export const IMAGE_SHORTCUTS: Record<string, string> = {
  "nano":    "vision_nano_pro",
  "recraft": "vision_recraft",
  "edit":    "vision_gpt_image2",
};

export const VIDEO_SHORTCUTS: Record<string, string> = {
  "seedance": "vision_seedance",
  "veo":      "vision_veo31",
  "kling":    "vision_kling",
  "hvideo":   "vision_hunyuan_video",
};

export const MEDIA_3D_SHORTCUTS: Record<string, string> = {
  "3d": "vision_hunyuan3d",
};

export const ALL_SHORTCUTS: Record<string, string> = {
  ...IMAGE_SHORTCUTS, ...VIDEO_SHORTCUTS, ...MEDIA_3D_SHORTCUTS,
};

export function resolveModelKey(arg: string): string {
  return ALL_SHORTCUTS[arg.toLowerCase()] ?? arg;
}

export function mediaKind(id: string): MediaKind {
  if (id.includes("3d")) return "3d";
  if (IMAGE_SHORTCUTS[id] || id.includes("nano") || id.includes("recraft") || id.includes("image")) return "image";
  return "video";
}

// ═════════════════════════════════════════════════════════════════════
// Model discovery (from GET /models catalog)
// ═════════════════════════════════════════════════════════════════════

export function isVisionItem(item: CatalogItem): boolean {
  return item.kind === "model" && item.id.startsWith(VISION_PREFIX);
}

export function filterMediaModels(items: CatalogItem[], kind?: MediaKind): MediaModel[] {
  let filtered = items.filter(isVisionItem);
  if (kind) {
    if (kind === "image") filtered = filtered.filter(m => !m.id.includes("video") && !m.id.includes("3d"));
    else if (kind === "video") filtered = filtered.filter(m => m.id.includes("video"));
    else if (kind === "3d") filtered = filtered.filter(m => m.id.includes("3d"));
  }
  return filtered.map(m => ({
    id: m.id, label: m.label, kind: mediaKind(m.id),
    provider: m.provider, tier_min: m.tier_min,
    available: m.available, enabled: m.enabled,
    monthly_uvt_cap: m.monthly_uvt_cap,
  })).sort((a, b) => a.id.localeCompare(b.id));
}

// ═════════════════════════════════════════════════════════════════════
// Auto-model routing
// ═════════════════════════════════════════════════════════════════════

export function autoRouteModel(prompt: string, kind: MediaKind): string {
  const p = prompt.toLowerCase();
  if (kind === "video") {
    if (/talking|dialogue|narration|voice|speak/.test(p)) return "veo";
    if (/draft|quick|test|budget|cheap/.test(p)) return "kling";
    return "seedance";
  }
  if (/vector|logo|brand|icon|svg|design.system/.test(p)) return "recraft";
  if (/edit|fix|change|inpaint|modify|touch.up|retouch/.test(p)) return "edit";
  return "nano";
}

// ═════════════════════════════════════════════════════════════════════
// Prompt builder
// ═════════════════════════════════════════════════════════════════════

export function buildMediaPrompt(prompt: string, flags: GenFlags, _kind: MediaKind): string {
  const parts: string[] = [prompt];
  if (flags.aspect && ASPECT_RATIOS[flags.aspect]) {
    const ar = ASPECT_RATIOS[flags.aspect]!;
    parts.push(`[aspect ratio: ${ar.display}]`);
  }
  if (flags.fourK) parts.push("[4K resolution]");
  if (flags.vector) parts.push("[SVG vector output]");
  if (flags.duration) parts.push(`[${flags.duration}s video]`);
  if (flags.hd1080) parts.push("[1080p]");
  if (flags.audio) parts.push("[with native synchronized audio]");
  if (flags.ref) parts.push(`[reference image: ${flags.ref}]`);
  return parts.join(" ");
}

// ═════════════════════════════════════════════════════════════════════
// Generation dispatch
// ═════════════════════════════════════════════════════════════════════

export async function dispatchGeneration(
  api: ApiClient, prompt: string, modelKey: string, flags: GenFlags,
): Promise<ChatGenResponse> {
  // Same generation-class call as CHAT_PATH elsewhere (chat.ts/brain_cloud.ts/
  // client.ts) — media generation can legitimately run well past the 30s
  // default request timeout, so it opts into the same 120s stream-class bound
  // instead (undefined signal: this call isn't user-cancelable mid-flight).
  return api.postJson<ChatGenResponse>("/agent/chat", {
    query: prompt,
    forced_model_key: modelKey,
    media_mode: true,
    mode: "plan",
    ...(flags.ref ? { ref_image: flags.ref } : {}),
  }, undefined, defaultStreamTimeoutMs());
}

// ═════════════════════════════════════════════════════════════════════
// Download engine
// ═════════════════════════════════════════════════════════════════════

const OUTPUT_DIR = "./aether-output";

export function ensureOutputDir(): string {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  return OUTPUT_DIR;
}

function mediaExt(modelKey: string, kind: MediaKind): string {
  if (kind === "video") return ".mp4";
  if (kind === "3d") return ".glb";
  if (modelKey.includes("recraft") || modelKey.includes("vector")) return ".svg";
  return ".png";
}

export async function downloadMediaFile(
  api: ApiClient, url: string, destDir: string,
  modelKey: string, kind: MediaKind, label?: string,
): Promise<string> {
  // getBinary() attaches the same bearer token as every other authed call
  // (with the same refresh-on-401 retry) and, when a token is actually about
  // to be attached, fail-closes if `url` isn't a credential-safe transport —
  // an anonymous session or a non-loopback self-hosted media host has
  // nothing to leak, so that case shouldn't hard-fail the download.
  const resp = await api.getBinary(url);
  if (!resp.body) throw new Error("download failed: empty body");

  let filename = label ? label.replace(/[^a-zA-Z0-9._-]/g, "_") : undefined;
  if (!filename) {
    try { filename = basename(new URL(url).pathname); } catch { /* fallback */ }
  }
  if (!filename) filename = `${modelKey.replace("vision_", "")}_${Date.now()}${mediaExt(modelKey, kind)}`;

  const destPath = join(destDir, filename);
  await pipeline(resp.body as unknown as NodeJS.ReadableStream, createWriteStream(destPath));
  return destPath;
}

// ═════════════════════════════════════════════════════════════════════
// Output manager
// ═════════════════════════════════════════════════════════════════════

// Persistence, identity, recovery and locking all live in media_history*.ts.
// This section is the presentation adapter the media commands already speak.

function paths(): ReturnType<typeof historyPaths> {
  return historyPaths(OUTPUT_DIR);
}

function toOutputEntry(entry: MediaEntry): OutputEntry {
  return {
    artifactId: entry.artifactId,
    sequence: entry.sequence,
    filename: entry.displayName,
    filepath: entry.filePath,
    model: entry.model,
    prompt: entry.prompt,
    kind: entry.kind,
    url: entry.url,
    timestamp: entry.createdAt,
    size_bytes: entry.sizeBytes,
    source: entry.source,
  };
}

export interface RecordOptions {
  /** Told about the committed history entry (the RC artifact producer). */
  onCommitted?: (entry: MediaEntry) => void;
}

export function recordOutput(result: GenResult, options: RecordOptions = {}): RecordedOutput {
  // A missing file is not a reason to lose the record — the URL still
  // resolves the artifact, and 0 bytes reads as "size unknown".
  let size = 0;
  try {
    size = statSync(result.filepath).size;
  } catch {
    size = 0;
  }
  const appended = appendEntry(paths(), {
    kind: result.kind,
    displayName: result.filename,
    filePath: result.filepath,
    url: result.url,
    model: result.model,
    prompt: result.prompt,
    sizeBytes: size,
  }, { now: result.timestamp, onCommitted: options.onCommitted });
  const entry = toOutputEntry(appended.entry);
  return appended.warning ? { entry, warning: appended.warning } : { entry };
}

export function listOutput(limit = 10): OutputListing {
  const load = loadHistory(paths());
  const entries = listEntries(load.doc.entries, limit).map(toOutputEntry);
  return load.warning
    ? { entries, state: load.state, warning: load.warning }
    : { entries, state: load.state };
}

export function findOutput(ref: string): OutputLookup {
  const load = loadHistory(paths());
  const resolved = resolveRef(load.doc.entries, ref);
  const warning = load.warning ? { warning: load.warning } : {};
  if (resolved.status === "found") {
    return { status: "found", entry: toOutputEntry(resolved.entry), ...warning };
  }
  if (resolved.status === "ambiguous") {
    return { status: "ambiguous", candidates: resolved.candidates.map(toOutputEntry), ...warning };
  }
  return { status: "not-found", ...warning };
}

/**
 * Hand the artifact to the OS default handler. Prefers the local file and
 * falls back to the remote URL when the download is gone. Never throws — the
 * outcome is the return value so callers can report a refusal precisely.
 */
export function openOutput(entry: OutputEntry): OpenOutcome {
  if (entry.filepath) {
    const local = openTarget(entry.filepath);
    if (local.status !== "rejected") return local;
  }
  if (entry.url) return openTarget(entry.url);
  return { status: "rejected", detail: "artifact has no local file and no URL" };
}

export function clearOutput(): number {
  return clearHistory(paths());
}

// ═════════════════════════════════════════════════════════════════════
// Storyboard
// ═════════════════════════════════════════════════════════════════════

export interface StoryboardScene {
  index: number;
  shot_type: string;
  camera_movement: string;
  keyframe_prompt: string;
  animation_prompt: string;
  color_palette: string;
  lighting: string;
  duration_sec: number;
  transition: string;
  notes: string;
  generated_frame_url?: string;
  generated_frame_path?: string;
}

export interface Storyboard {
  id: string; title: string;
  source_type: "prompt" | "script_file";
  source: string; style: string;
  total_scenes: number; scenes: StoryboardScene[];
  created_at: string;
  status: "draft" | "keyframes_generated" | "animated" | "rendered";
}

const STORYBOARD_DIR = join(OUTPUT_DIR, "storyboards");

function sbPath(id: string): string { return join(STORYBOARD_DIR, `${id}.storyboard.json`); }

export function saveStoryboard(sb: Storyboard): void {
  if (!existsSync(STORYBOARD_DIR)) mkdirSync(STORYBOARD_DIR, { recursive: true });
  writeFileSync(sbPath(sb.id), JSON.stringify(sb, null, 2));
}

export function loadStoryboard(id: string): Storyboard | null {
  const p = sbPath(id);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

export function listStoryboards(): { id: string; title: string; scenes: number; status: string; created: string }[] {
  if (!existsSync(STORYBOARD_DIR)) return [];
  return readdirSync(STORYBOARD_DIR)
    .filter(f => f.endsWith(".storyboard.json"))
    .map(f => {
      const sb = loadStoryboard(f.replace(".storyboard.json", ""));
      return sb ? { id: sb.id, title: sb.title, scenes: sb.total_scenes, status: sb.status, created: sb.created_at } : null;
    })
    .filter(Boolean) as { id: string; title: string; scenes: number; status: string; created: string }[];
}

export function parseScenes(raw: string): StoryboardScene[] {
  const scenes: StoryboardScene[] = [];
  const blocks = raw.split(/SCENE \d+/i).filter(b => b.trim());
  let idx = 0;
  for (const block of blocks) {
    idx++;
    const hm = block.match(/^:?\s*(\w+)\s*\|\s*([\w-]+)/);
    const shotType = hm?.[1]?.toUpperCase() ?? "WIDE";
    const camera = hm?.[2]?.toLowerCase() ?? "static";
    const visual = extractField(block, "Visual");
    const motion = extractField(block, "Motion");
    const palette = extractField(block, "Palette") ?? "natural";
    const lighting = extractField(block, "Lighting") ?? "ambient";
    const duration = parseInt(extractField(block, "Duration") ?? "5", 10);
    const transition = extractField(block, "Transition") ?? "cut";
    const notes = extractField(block, "Notes") ?? "";
    if (!visual) continue;
    scenes.push({
      index: idx, shot_type: shotType, camera_movement: camera,
      keyframe_prompt: visual + ` [${palette} palette, ${lighting} lighting]`,
      animation_prompt: motion || `${camera} camera movement`,
      color_palette: palette, lighting,
      duration_sec: Math.min(30, Math.max(3, duration)),
      transition, notes,
    });
  }
  return scenes;
}

function extractField(block: string, field: string): string | undefined {
  const re = new RegExp(`${field}:\\s*(.+?)(?:\\n|$)`, "i");
  return block.match(re)?.[1]?.trim();
}

export interface StoryboardParseResult {
  title: string; style: string;
  scenes: StoryboardScene[];
  raw_llm_output: string;
}

export async function parseStoryboard(
  api: ApiClient, source: string, sourceType: "prompt" | "script_file",
  options?: { scenes?: number; style?: string },
): Promise<StoryboardParseResult> {
  const style = options?.style ?? "cinematic";
  const content = sourceType === "script_file" ? readFileSync(source, "utf-8") : source;
  // Same generation-class call as dispatchGeneration above — opt into the
  // 120s stream-class timeout, not the 30s request default.
  const resp = await api.postJson<ChatGenResponse>("/agent/chat", {
    query: `STORYBOARD REQUEST:\n\n${content}`,
    forced_model_key: "sonnet", mode: "plan",
  }, undefined, defaultStreamTimeoutMs());
  const raw = resp.response || resp.text || "";
  const scenes = parseScenes(raw);
  const title = sourceType === "prompt"
    ? source.slice(0, 60).replace(/\n/g, " ")
    : source.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "untitled";
  return { title, style, scenes, raw_llm_output: raw };
}
