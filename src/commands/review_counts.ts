// review_counts.ts — how many lines actually changed, per file.
//
// core/review_state.ts answers "which paths changed and in which half"; its
// ChangedFile deliberately carries no line counts. The review screen needs
// them, so they are read here, and read the way the mission requires:
//
//  * ASYNC. The command it replaces (/stage-diff) called execSync three times,
//    which freezes the REPL's key loop for the length of a `git diff` on a big
//    repository. Nothing on this path blocks the event loop.
//  * MACHINE-READABLE. The old code ran `git diff --stat` and recovered the
//    numbers with a regex over the human summary line. `--stat` is a rendering:
//    it abbreviates paths, it is width-dependent, and a binary file's columns
//    are not numbers at all — the old regex turned those into 0.
//  * BOTH HALVES. The old code read `git diff` only, so anything already staged
//    was invisible to a command whose whole job is "show me what I am about to
//    commit". Staged and unstaged are summed here.
//
// A count git did not report stays `null` all the way to the renderer, which
// prints "?". Zero is a claim; null is the truth.

import { spawn } from "node:child_process";
import { GIT_GLOBAL_ARGS } from "../core/git_commit_guard.js";
import type { RunResult } from "../core/worktree.js";

/** Async twin of core/worktree.ts's Runner. Same argv-array discipline. */
export type AsyncRun = (cmd: string, args: readonly string[], cwd?: string) => Promise<RunResult>;

/** Default async runner. `shell: false` is stated rather than assumed. */
export function spawnAsyncRun(): AsyncRun {
  return (cmd, args, cwd) =>
    new Promise<RunResult>((resolve) => {
      // AsyncRun accepts no input. Use the null device for stdin so a child
      // exiting before this process resumes cannot leave a broken write pipe.
      const child = spawn(cmd, [...args], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (err: Error) => resolve({ status: 127, stdout, stderr: err.message }));
      child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
    });
}

export interface LineCount {
  /** null = git reported "-" (binary), or did not report this path at all. */
  added: number | null;
  deleted: number | null;
}

export const UNKNOWN: LineCount = { added: null, deleted: null };

/**
 * Parse `git diff --numstat -z`.
 *
 * Ordinary record:  `12\t3\tsrc/a.ts\0`
 * Rename record:    `12\t3\t\0old/path\0new/path\0`  — the path field is empty
 *                   and the two real paths follow as their own NUL fields.
 *
 * The `-z` form exists so a path containing a tab, a newline or a quote
 * survives intact; the plain form C-quotes such paths and would have to be
 * unescaped by hand.
 */
export function parseNumstatZ(raw: string): Map<string, LineCount> {
  const out = new Map<string, LineCount>();
  const fields = raw.split("\0");
  const count = (value: string): number | null => (value === "-" ? null : Number.parseInt(value, 10));
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(field);
    if (!match) continue;
    const added = count(match[1]!);
    const deleted = count(match[2]!);
    if (match[3] === "") {
      const newPath = fields[index + 2];
      index += 2;
      if (!newPath) continue;
      out.set(newPath, { added, deleted });
    } else {
      out.set(match[3]!, { added, deleted });
    }
  }
  return out;
}

/** Add two counts. Either side being unknown makes the sum unknown. */
export function addCounts(left: LineCount | undefined, right: LineCount | undefined): LineCount {
  if (!left) return right ?? UNKNOWN;
  if (!right) return left;
  return {
    added: left.added === null || right.added === null ? null : left.added + right.added,
    deleted: left.deleted === null || right.deleted === null ? null : left.deleted + right.deleted,
  };
}

/**
 * Line counts for every path git can report one for, summing the staged half
 * and the unstaged half. Untracked files are absent by construction — git has
 * no blob for them — so they come back unknown rather than as a fabricated 0.
 */
export async function readLineCounts(run: AsyncRun, root: string): Promise<Map<string, LineCount>> {
  const argv = (cached: boolean): string[] => [
    ...GIT_GLOBAL_ARGS,
    "-C",
    root,
    "diff",
    ...(cached ? ["--cached"] : []),
    "--numstat",
    "-z",
  ];
  const [staged, unstaged] = await Promise.all([run("git", argv(true), root), run("git", argv(false), root)]);
  const merged = new Map<string, LineCount>();
  for (const source of [staged, unstaged]) {
    if (source.status !== 0) continue;
    for (const [path, count] of parseNumstatZ(source.stdout)) {
      merged.set(path, addCounts(merged.get(path), count));
    }
  }
  return merged;
}

/** `+12 -3`, or `+? -?` where git reported no number. Never `+0 -0` for unknown. */
export function formatCount(count: LineCount | undefined): string {
  const one = (value: number | null | undefined, sign: string): string =>
    value === null || value === undefined ? `${sign}?` : `${sign}${value}`;
  return `${one(count?.added, "+")} ${one(count?.deleted, "-")}`;
}

export interface Totals {
  files: number;
  added: number;
  deleted: number;
  /**
   * The paths git reported no counts for — named, not merely counted.
   * "3 files unknown" tells the reader a total is incomplete; naming logo.png
   * tells them WHICH work the total excludes, which is the thing they can act
   * on. The count is kept as a derived convenience.
   */
  unknownPaths: string[];
}

export const unknownCount = (totals: Totals): number => totals.unknownPaths.length;

export function sumCounts(paths: readonly string[], counts: ReadonlyMap<string, LineCount>): Totals {
  let added = 0;
  let deleted = 0;
  const unknownPaths: string[] = [];
  for (const path of paths) {
    const count = counts.get(path);
    if (!count || count.added === null || count.deleted === null) {
      unknownPaths.push(path);
      if (count?.added != null) added += count.added;
      if (count?.deleted != null) deleted += count.deleted;
      continue;
    }
    added += count.added;
    deleted += count.deleted;
  }
  return { files: paths.length, added, deleted, unknownPaths };
}

/** The "Changed: …" line. When anything is unmeasured, it says so out loud. */
export function formatTotals(totals: Totals): string {
  const noun = totals.files === 1 ? "file" : "files";
  const base = `${totals.files} ${noun}, +${totals.added} -${totals.deleted}`;
  if (totals.unknownPaths.length === 0) return base;
  const unit = totals.unknownPaths.length === 1 ? "file" : "files";
  // The excluded paths are named. A reader who sees a total that is short by an
  // unnamed amount has no way to find out what is missing from it.
  return `${base}, plus ${totals.unknownPaths.length} ${unit} whose counts git did not report (${totals.unknownPaths.join(", ")})`;
}
