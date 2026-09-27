// Bounded, read-only discovery of instruction files.
//
// Reads only well-known paths inside the project root (plus the user-level
// Aether instruction file), never follows a symlink out of the project, never
// fetches includes, and caps file size and source count honestly.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { configDir } from "../config.js";
import { SKILL_BOUNDS } from "../skills/skill_bounds.js";
import type { InstructionSource, InstructionSourceKind } from "./instruction_types.js";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface ReadOutcome {
  content?: string;
  status: "ok" | "truncated" | "invalid-encoding";
  sizeBytes: number;
  reason?: string;
}

/** UTF-8 read with byte cap; a replacement-char-dense file is treated as binary. */
function readInstructionFile(path: string): ReadOutcome {
  let bytes: Buffer;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return { status: "invalid-encoding", sizeBytes: 0, reason: "not a regular file" };
    bytes = readFileSync(path);
  } catch {
    return { status: "invalid-encoding", sizeBytes: 0, reason: "unreadable" };
  }
  if (bytes.includes(0)) return { status: "invalid-encoding", sizeBytes: bytes.length, reason: "binary content" };
  const truncated = bytes.length > SKILL_BOUNDS.maxInstructionFileBytes;
  const slice = truncated ? bytes.subarray(0, SKILL_BOUNDS.maxInstructionFileBytes) : bytes;
  const text = slice.toString("utf8");
  const replacementDensity = (text.match(/�/g)?.length ?? 0) / Math.max(1, text.length);
  if (replacementDensity > 0.01) return { status: "invalid-encoding", sizeBytes: bytes.length, reason: "invalid encoding" };
  return { content: text, status: truncated ? "truncated" : "ok", sizeBytes: bytes.length };
}

/** True when `path`'s real location stays inside the real project root. */
function staysInside(projectRoot: string, path: string): boolean {
  try {
    const realRoot = realpathSync(projectRoot);
    const real = realpathSync(path);
    return real === realRoot || real.startsWith(realRoot + sep);
  } catch {
    return false;
  }
}

interface DiscoveredFile {
  kind: InstructionSourceKind;
  path: string;
  scopeDir: string;
  globs: readonly string[] | null;
  warnings: string[];
}

/** Parse the minimal Cursor .mdc frontmatter we support: a `globs:` line. */
export function parseCursorGlobs(content: string): { globs: readonly string[] | null; warnings: string[]; body: string } {
  const warnings: string[] = [];
  if (!content.startsWith("---")) return { globs: null, warnings, body: content };
  const end = content.indexOf("\n---", 3);
  if (end < 0) return { globs: null, warnings: ["unterminated frontmatter — rule applied to whole project"], body: content };
  const frontmatter = content.slice(3, end);
  const body = content.slice(end + 4);
  const globLine = frontmatter.split("\n").map((line) => line.trim()).find((line) => line.startsWith("globs:"));
  if (!globLine) return { globs: null, warnings, body };
  const value = globLine.slice("globs:".length).trim();
  if (!value) return { globs: null, warnings, body };
  if (value.startsWith("[") || value.includes("{")) {
    // YAML flow lists / brace expansion are outside the supported subset.
    warnings.push("unsupported globs syntax '" + value.slice(0, 40) + "' — rule NOT applied (would otherwise apply globally)");
    return { globs: [], warnings, body };
  }
  const globs = value.split(",").map((glob) => glob.trim()).filter((glob) => glob.length > 0);
  for (const glob of globs) {
    if (!/^[\w@./*?-]+$/.test(glob)) {
      warnings.push("unsupported glob '" + glob + "' — rule NOT applied");
      return { globs: [], warnings, body };
    }
  }
  return { globs: globs.length ? globs : null, warnings, body };
}

/** Locate nested AGENTS.md files with explicit work and wall-clock limits. */
function findNestedAgents(projectRoot: string): { paths: string[]; complete: boolean; reason: string } {
  const found: string[] = [];
  const skip = new Set(["node_modules", "dist", "build", "vendor", "target", ".git"]);
  const started = performance.now();
  let directories = 0;
  let entriesSeen = 0;
  let reason = "";
  const overBudget = (): boolean => {
    if (reason) return true;
    if (performance.now() - started >= SKILL_BOUNDS.maxNestedInstructionScanMs) {
      reason = `nested AGENTS.md scan exceeded ${SKILL_BOUNDS.maxNestedInstructionScanMs} ms`;
      return true;
    }
    if (directories >= SKILL_BOUNDS.maxNestedInstructionDirectories) {
      reason = `nested AGENTS.md scan reached ${SKILL_BOUNDS.maxNestedInstructionDirectories} directories`;
      return true;
    }
    return false;
  };
  const walk = (dir: string, depth: number): void => {
    if (depth > SKILL_BOUNDS.maxNestedInstructionDepth) return;
    if (overBudget()) return;
    directories++;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // A single directory can contain tens of thousands of names. Do not sort
    // or stat any of them when the remaining entry budget cannot cover it.
    // The readdirSync call itself is one synchronous filesystem operation; the
    // incomplete marker below makes this limit explicit to callers.
    if (entriesSeen + entries.length > SKILL_BOUNDS.maxNestedInstructionEntries) {
      reason = `nested AGENTS.md scan reached ${SKILL_BOUNDS.maxNestedInstructionEntries} entries`;
      return;
    }
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (overBudget()) return;
      entriesSeen++;
      if (entry.name.startsWith(".") || skip.has(entry.name) || !entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      let isDirectory = false;
      try {
        isDirectory = lstatSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) {
        const nested = join(full, "AGENTS.md");
        if (existsSync(nested)) found.push(nested);
        walk(full, depth + 1);
      }
    }
  };
  walk(projectRoot, 1);
  return { paths: found, complete: !reason, reason };
}

export function discoverInstructionSources(projectRoot: string): {
  sources: InstructionSource[];
  skipped: { path: string; reason: string }[];
  nestedScanComplete: boolean;
} {
  const root = resolve(projectRoot);
  const candidates: DiscoveredFile[] = [];

  const addIfPresent = (kind: InstructionSourceKind, path: string, scopeDir = ""): void => {
    if (existsSync(path)) candidates.push({ kind, path, scopeDir, globs: null, warnings: [] });
  };

  addIfPresent("aether-project", join(root, ".aether", "instructions.md"));
  addIfPresent("agents-root", join(root, "AGENTS.md"));
  const nestedScan = findNestedAgents(root);
  for (const nested of nestedScan.paths) {
    const scopeDir = relative(root, join(nested, "..")).split(sep).join("/");
    candidates.push({ kind: "agents-nested", path: nested, scopeDir, globs: null, warnings: [] });
  }
  addIfPresent("aether-user", join(configDir(), "instructions.md"));
  addIfPresent("claude", join(root, "CLAUDE.md"));
  addIfPresent("gemini", join(root, "GEMINI.md"));
  addIfPresent("copilot", join(root, ".github", "copilot-instructions.md"));

  const cursorRules = join(root, ".cursor", "rules");
  if (existsSync(cursorRules)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(cursorRules).filter((entry) => entry.endsWith(".mdc")).sort();
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      candidates.push({ kind: "cursor-rule", path: join(cursorRules, entry), scopeDir: "", globs: null, warnings: [] });
    }
  }

  const sources: InstructionSource[] = [];
  const skipped: { path: string; reason: string }[] = [];
  if (!nestedScan.complete) {
    skipped.push({
      path: "**/AGENTS.md",
      reason: nestedScan.reason + "; nested project rules may be missing — start in a smaller project directory",
    });
  }

  for (const candidate of candidates) {
    if (sources.length >= SKILL_BOUNDS.maxInstructionSources) {
      skipped.push({ path: candidate.path, reason: "instruction source cap (" + SKILL_BOUNDS.maxInstructionSources + ") reached" });
      continue;
    }
    const insideProject = candidate.kind === "aether-user" || staysInside(root, candidate.path);
    if (!insideProject) {
      skipped.push({ path: candidate.path, reason: "symlink escapes the project root" });
      continue;
    }
    const read = readInstructionFile(candidate.path);
    if (read.content == null) {
      skipped.push({ path: candidate.path, reason: read.reason ?? "unreadable" });
      continue;
    }
    let content = read.content;
    let globs: readonly string[] | null = candidate.globs;
    const warnings = [...candidate.warnings];
    let parseStatus: InstructionSource["parseStatus"] = read.status === "truncated" ? "truncated" : "ok";
    if (read.status === "truncated") warnings.push("file exceeds " + SKILL_BOUNDS.maxInstructionFileBytes + " bytes — truncated");
    if (candidate.kind === "cursor-rule") {
      const parsed = parseCursorGlobs(content);
      content = parsed.body;
      globs = parsed.globs;
      warnings.push(...parsed.warnings);
      if (parsed.globs !== null && parsed.globs.length === 0) parseStatus = "unsupported-syntax";
    }
    const displayPath = candidate.kind === "aether-user"
      ? candidate.path
      : relative(root, candidate.path).split(sep).join("/");
    sources.push({
      kind: candidate.kind,
      path: candidate.path,
      displayPath,
      scopeDir: candidate.scopeDir,
      globs,
      sha256: sha256(content),
      sizeBytes: read.sizeBytes,
      content,
      parseStatus,
      warnings,
    });
  }

  return { sources, skipped, nestedScanComplete: nestedScan.complete };
}
