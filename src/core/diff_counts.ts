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

/** One file's counts, for a list row. Unknown prints as "?" and never as 0. */
export function renderCounts(entry: DiffCounts | undefined): string {
  if (!entry) return "?";
  if (entry.binary) return "binary";
  const additions = (entry.staged.additions ?? 0) + (entry.unstaged.additions ?? 0);
  const deletions = (entry.staged.deletions ?? 0) + (entry.unstaged.deletions ?? 0);
  return `+${additions} −${deletions}`;
}
