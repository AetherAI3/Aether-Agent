// diff_counts.ts — how much changed, per file, staged and unstaged.
//
// This is repository state, not presentation: "+312 −48" is the headline of a
// review screen, and two implementations of it would disagree the first time
// one of them forgot that a rename spans three NUL fields or that a binary file
// has no line count at all.
//
// It lives BESIDE readRepoState rather than inside it. readRepoState is
// synchronous by contract and every caller depends on that; counting lines wants
// to be async, and forcing an async path into a synchronous module is worse than
// the small separation it would avoid. So this module brings its own async
// runner and nothing else changes.
//
// The rule that shapes the types: a count that does not exist is null, and null
// renders as "?" rather than 0. A binary file has no line count. An untracked
// file is not in any diff, so it has none either. Printing 0 there would be a
// measurement nobody took.

import { spawn } from "node:child_process";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { GIT_GLOBAL_ARGS } from "./git_commit_guard.js";
import type { RunResult } from "./worktree.js";

/** The async twin of Runner. Same argv discipline: no shell, ever. */
export type AsyncRunner = (cmd: string, args: string[], cwd?: string) => Promise<RunResult>;

/** Default async runner over spawn. A missing binary reads as status 127, as Runner does. */
export function defaultAsyncRunner(): AsyncRunner {
  return (cmd, args, cwd) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd, shell: false });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", (error) => resolve({ status: 127, stdout: "", stderr: String(error) }));
      child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
    });
}

export interface SideCounts {
  /** Null means there is no count to give: binary, or nothing on this side. */
  additions: number | null;
  deletions: number | null;
}

export interface DiffCounts {
  path: string;
  staged: SideCounts;
  unstaged: SideCounts;
  /** True when git reported "-" for the counts, which is how it says binary. */
  binary: boolean;
  /** Set when this entry is a rename: where the content came from. */
  renamedFrom?: string;
}

const NONE: SideCounts = { additions: null, deletions: null };

/**
 * Parse `git diff --numstat -z`.
 *
 * Three shapes in one stream, and the rename is the one that breaks naive
 * parsers: an ordinary entry is `adds\tdels\tpath` in a single NUL-terminated
 * field, while a rename is `adds\tdels\t` followed by TWO further fields — the
 * old path, then the new one. Reading fields uniformly turns every rename into
 * two phantom entries with no counts.
 */
export function parseNumstat(raw: string): Array<{ additions: number | null; deletions: number | null; path: string; renamedFrom?: string }> {
  const fields = raw.split("\0");
  const rows: Array<{ additions: number | null; deletions: number | null; path: string; renamedFrom?: string }> = [];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const parts = field.split("\t");
    if (parts.length < 3) continue;
    const [adds, dels] = parts;
    // "-" is git saying the file is binary. It is not zero and must not become it.
    const additions = adds === "-" ? null : Number.parseInt(adds ?? "", 10);
    const deletions = dels === "-" ? null : Number.parseInt(dels ?? "", 10);
    const inline = parts.slice(2).join("\t");

    if (inline === "") {
      const from = fields[index + 1];
      const to = fields[index + 2];
      index += 2;
      if (!to) continue;
      const row: { additions: number | null; deletions: number | null; path: string; renamedFrom?: string } = {
        additions: Number.isNaN(additions as number) ? null : additions,
        deletions: Number.isNaN(deletions as number) ? null : deletions,
        path: to,
      };
      if (from) row.renamedFrom = from;
      rows.push(row);
      continue;
    }
    rows.push({
      additions: Number.isNaN(additions as number) ? null : additions,
      deletions: Number.isNaN(deletions as number) ? null : deletions,
      path: inline,
    });
  }
  return rows;
}

/** `git diff --numstat` argv for one side. Pure, so a test can assert the vector. */
export function numstatArgs(staged: boolean): string[] {
  return [...GIT_GLOBAL_ARGS, "diff", "--numstat", "-z", ...(staged ? ["--cached"] : []), "--no-color"];
}

/**
 * Count both sides in one pass, keyed by path.
 *
 * The two diffs are read concurrently: they are independent reads of the same
 * repository, and running them in series doubles the latency of the headline
 * number for no benefit. Neither writes anything.
 */
export async function readDiffCountSnapshot(run: AsyncRunner, root: string): Promise<{ counts: Map<string, DiffCounts>; complete: boolean }> {
  const [stagedRun, unstagedRun] = await Promise.all([
    run("git", ["-C", root, ...numstatArgs(true)], root),
    run("git", ["-C", root, ...numstatArgs(false)], root),
  ]);

  const counts = new Map<string, DiffCounts>();
  const absorb = (result: RunResult, side: "staged" | "unstaged"): void => {
    if (result.status !== 0) return; // a failed read leaves nulls, never zeros
    for (const row of parseNumstat(result.stdout)) {
      const existing = counts.get(row.path) ?? { path: row.path, staged: { ...NONE }, unstaged: { ...NONE }, binary: false };
      existing[side] = { additions: row.additions, deletions: row.deletions };
      if (row.additions === null && row.deletions === null) existing.binary = true;
      if (row.renamedFrom) existing.renamedFrom = row.renamedFrom;
      counts.set(row.path, existing);
    }
  };
  absorb(stagedRun, "staged");
  absorb(unstagedRun, "unstaged");
  return { counts, complete: stagedRun.status === 0 && unstagedRun.status === 0 };
}

export async function readDiffCounts(run: AsyncRunner, root: string): Promise<Map<string, DiffCounts>> {
  return (await readDiffCountSnapshot(run, root)).counts;
}

export interface CountTotal {
  additions: number;
  deletions: number;
  /** Paths that had no countable diff — binary, or untracked. Named, not silently dropped. */
  uncounted: string[];
}

/**
 * Total across a set of paths.
 *
 * Uncounted paths are RETURNED rather than skipped. A total of "+312 −48" over
 * a selection that also contained two binaries is true of the countable part
 * only, and the screen has to be able to say so.
 */
export function totalCounts(counts: Map<string, DiffCounts>, paths: readonly string[]): CountTotal {
  let additions = 0;
  let deletions = 0;
  const uncounted: string[] = [];
  for (const path of paths) {
    const entry = counts.get(path);
    if (!entry) {
      uncounted.push(path);
      continue;
    }
    const sides = [entry.staged, entry.unstaged];
    const countable = sides.filter((side) => side.additions !== null || side.deletions !== null);
    if (!countable.length) {
      uncounted.push(path);
      continue;
    }
    for (const side of countable) {
      additions += side.additions ?? 0;
      deletions += side.deletions ?? 0;
    }
  }
  return { additions, deletions, uncounted: uncounted.sort() };
}

// ── untracked files: what git WOULD count once the file is added ──────────────
//
// An untracked file is in no diff, so numstat never names it, and the review
// screen above rightly prints "?" for it. A remote summary of a checkout cannot
// leave it out, though: three new source files reported as "+0" is a
// measurement nobody took. So this measures exactly what `git add` followed by
// `git diff --cached --numstat` would report — every line an insertion, binary
// files no lines at all — WITHOUT touching the index: the worktree bytes are
// read directly, under hard bounds, and anything git would transform first
// (clean filters, working-tree-encoding) is reported as unknown rather than
// approximated from the raw bytes.

/** git's buffer_is_binary(): a NUL within the first 8000 bytes means binary. */
export const GIT_BINARY_PROBE_BYTES = 8000;
const READ_CHUNK_BYTES = 64 * 1024;
/** Path characters per check-attr call: inside the Windows 32,767-char command
 *  line with room left for the git path, fixed arguments and argv quoting. */
export const CHECK_ATTR_ARGV_CHARS = 24_000;
const COUNT_ATTRIBUTES = ["diff", "filter", "working-tree-encoding"] as const;

/** The gitattributes that decide how git would count a new file. */
export interface CountAttributes {
  /** `diff` set forces text, unset (or the `binary` macro) forces binary;
   *  anything else — unspecified or a named driver — uses git's content probe. */
  diff: "text" | "binary" | "auto";
  /** A clean filter or working-tree-encoding: git counts converted bytes, not these. */
  converted: boolean;
}

function argvChunks(paths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const path of paths) {
    if (current.length && chars + path.length + 1 > CHECK_ATTR_ARGV_CHARS) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(path);
    chars += path.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Read the counting attributes for each path, honouring .gitattributes,
 * info/attributes and core.attributesFile exactly as git would.
 *
 * Null when git cannot answer for every path: an attribute nobody read is an
 * unknown, and a caller that treated it as "unspecified" would misreport a
 * `-diff` file's lines.
 */
export async function readCountAttributes(
  run: AsyncRunner,
  root: string,
  paths: readonly string[],
): Promise<Map<string, CountAttributes> | null> {
  const attributes = new Map<string, CountAttributes>();
  for (const chunk of argvChunks(paths)) {
    const result = await run("git", ["-C", root, ...GIT_GLOBAL_ARGS, "check-attr", "-z", ...COUNT_ATTRIBUTES, "--", ...chunk], root);
    if (result.status !== 0) return null;
    // -z output is `path NUL attribute NUL value NUL`, path-major in argv order.
    const fields = result.stdout.split("\0");
    for (const [index, path] of chunk.entries()) {
      let entry: CountAttributes = { diff: "auto", converted: false };
      for (const [offset, name] of COUNT_ATTRIBUTES.entries()) {
        const at = (index * COUNT_ATTRIBUTES.length + offset) * 3;
        if (fields[at] !== path || fields[at + 1] !== name) return null;
        const value = fields[at + 2] ?? "";
        entry = name === "diff"
          ? { ...entry, diff: value === "set" ? "text" : value === "unset" ? "binary" : "auto" }
          : { ...entry, converted: entry.converted || (value !== "unspecified" && value !== "unset") };
      }
      attributes.set(path, entry);
    }
  }
  return attributes;
}

export type NewFileCount =
  | { kind: "text"; additions: number; bytesRead: number }
  | { kind: "binary"; bytesRead: number }
  | { kind: "unknown"; reason: "converted" | "not_regular" | "external" | "too_large" | "unreadable"; bytesRead: number };

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function countNewlines(view: Buffer): number {
  let lines = 0;
  for (let at = view.indexOf(0x0a); at !== -1; at = view.indexOf(0x0a, at + 1)) lines += 1;
  return lines;
}

/**
 * Read an open regular file of `size` bytes and count it as git would: binary
 * when `probeText` and a NUL falls in the first GIT_BINARY_PROBE_BYTES, else
 * newline-terminated lines plus a final unterminated one.
 */
async function scanNewFile(handle: FileHandle, size: number, maxBytes: number, probeText: boolean): Promise<NewFileCount> {
  if (size > maxBytes) {
    if (!probeText) return { kind: "unknown", reason: "too_large", bytesRead: 0 };
    // Too large to count, but git's own binary probe is bounded: a NUL there
    // makes it binary (no lines) whatever the size.
    const probe = Buffer.alloc(GIT_BINARY_PROBE_BYTES);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    return probe.subarray(0, bytesRead).includes(0)
      ? { kind: "binary", bytesRead }
      : { kind: "unknown", reason: "too_large", bytesRead };
  }

  const chunk = Buffer.alloc(Math.max(1, Math.min(READ_CHUNK_BYTES, maxBytes + 1)));
  let bytesRead = 0;
  let lines = 0;
  let last = 0x0a;
  for (;;) {
    const { bytesRead: n } = await handle.read(chunk, 0, chunk.length, bytesRead);
    if (n === 0) break;
    const view = chunk.subarray(0, n);
    if (probeText && bytesRead < GIT_BINARY_PROBE_BYTES &&
        view.subarray(0, GIT_BINARY_PROBE_BYTES - bytesRead).includes(0)) {
      return { kind: "binary", bytesRead: bytesRead + n };
    }
    bytesRead += n;
    // The file grew past the bound while it was being read.
    if (bytesRead > maxBytes) return { kind: "unknown", reason: "too_large", bytesRead };
    lines += countNewlines(view);
    last = view[n - 1]!;
  }
  // git counts a final line without a newline as a line.
  return { kind: "text", additions: lines + (last === 0x0a ? 0 : 1), bytesRead };
}

/**
 * Count one untracked file the way git's numstat would once it is added.
 *
 * `realRoot` must already be the canonical (realpath) checkout root, and
 * `path` a git-reported, project-relative path. The file is never followed out
 * of the checkout: a symlink or junction is not a regular file here, and a
 * regular file whose real location is outside `realRoot` (a linked parent
 * directory, which Git for Windows walks into) is "external". At most
 * `maxBytes` are read, plus a bounded binary probe for a file too large to
 * count. Nothing is written and the index is never touched.
 *
 * Binary files have no line count in git ("-" in numstat), so they are
 * reported as binary and contribute zero lines — the same as a tracked binary.
 */
export async function countNewFileLines(
  realRoot: string,
  path: string,
  attributes: CountAttributes,
  maxBytes: number,
): Promise<NewFileCount> {
  if (attributes.converted) return { kind: "unknown", reason: "converted", bytesRead: 0 };
  const full = join(realRoot, ...path.split("/"));
  let handle: FileHandle | undefined;
  try {
    if (!(await lstat(full)).isFile()) return { kind: "unknown", reason: "not_regular", bytesRead: 0 };
    if (!isInside(realRoot, await realpath(full))) return { kind: "unknown", reason: "external", bytesRead: 0 };
    if (attributes.diff === "binary") return { kind: "binary", bytesRead: 0 };
    handle = await open(full, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) return { kind: "unknown", reason: "not_regular", bytesRead: 0 };
    return await scanNewFile(handle, stat.size, maxBytes, attributes.diff === "auto");
  } catch {
    return { kind: "unknown", reason: "unreadable", bytesRead: 0 };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** One file's counts, for a list row. Unknown prints as "?" and never as 0. */
export function renderCounts(entry: DiffCounts | undefined): string {
  if (!entry) return "?";
  if (entry.binary) return "binary";
  const additions = (entry.staged.additions ?? 0) + (entry.unstaged.additions ?? 0);
  const deletions = (entry.staged.deletions ?? 0) + (entry.unstaged.deletions ?? 0);
  return `+${additions} −${deletions}`;
}
