// diff_summary.ts — the checkout snapshot RC publishes as `diff_summary`.
//
// Paths come from `git status`. Line counts come from `git diff --numstat` for
// tracked paths and, for untracked files, from a bounded read of the worktree
// bytes that counts exactly what numstat would report once the file is added
// (diff_counts.ts countNewFileLines). Neither model output, prose, nor a diff
// body is read, and only paths and three integers leave this module.
//
// Cloud's display/1 contract REQUIRES files_changed, insertions and deletions.
// An omitted count is not "unknown" on the wire: it is a 400 that keeps the
// whole batch, and everything queued behind it, in the outbox. So every event
// returned here carries all three measured counts, and every state this module
// cannot measure returns null (no summary is published):
//
//   measured   a clean tree is 0/0/0; text changes carry git's own counts.
//   binary     a changed file with ZERO lines. git has no line count for a
//              binary file ("-" in numstat), but the file still changed.
//   untracked  every line an insertion, as git counts it once added.
//   unknown    a failed git read; a changed tracked path numstat did not
//              measure; an untracked file that is too large, external (a link
//              out of the checkout), unreadable, or filter-converted; or more
//              untracked files or bytes than the bounds allow. The WHOLE
//              snapshot is dropped. Leaving out just the uncountable path would
//              make the viewer's "N files changed" quietly false, and display/1
//              has no field that could say "partial".
//   refused    a path that is not project-relative (absolute, traversal, drive
//              qualified) or that Cloud would read as one (a leading "~", e.g.
//              an Office `~$lock.docx` at the root), or a project root that is
//              not the checkout toplevel. Nothing is produced, so nothing
//              reaches the durable outbox.
//
// `files` is a sample: a prefix of the sorted paths, bounded in count and in
// broker-measured bytes, while `files_changed` counts every path.

import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  countNewFileLines,
  defaultAsyncRunner,
  readCountAttributes,
  readDiffCountSnapshot,
  type AsyncRunner,
  type DiffCounts,
} from "../diff_counts.js";
import { parseStatusV2, STATUS_V2_ARGS, type ChangedFile } from "../review_state.js";
import { defaultRunner, type Runner } from "../worktree.js";
import { diffSummaryEvent, type RcProducedEvent } from "./producers.js";
import { brokerJsonBytes, isSafeRelativePath } from "./redaction.js";

/** More changed paths than this is not a snapshot worth measuring. */
const MAX_SNAPSHOT_PATHS = 100_000;
/** The wire bound on `files`; `files_changed` still counts every path. */
const MAX_LISTED_PATHS = 64;
/** Half the broker's 32 KiB frame, measured as the broker measures it, for the
 *  `files` sample: 64 long non-ASCII paths would otherwise overrun the frame. */
const MAX_LISTED_BYTES = 16 * 1024;

/**
 * The `files` sample: a prefix of the sorted paths, at most MAX_LISTED_PATHS
 * and MAX_LISTED_BYTES of broker-measured JSON. It was always a sample
 * (`files_changed` counts every path); this only keeps it inside one frame.
 */
function listedPaths(paths: readonly string[]): string[] {
  const listed: string[] = [];
  let bytes = 2; // the brackets
  for (const path of paths.slice(0, MAX_LISTED_PATHS)) {
    bytes += brokerJsonBytes(path) + (listed.length > 0 ? 1 : 0);
    if (bytes > MAX_LISTED_BYTES) break;
    listed.push(path);
  }
  return listed;
}

/** Bounds on reading untracked files. Exceeding any one is an unknown state. */
export interface CheckoutCountLimits {
  maxUntrackedFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_CHECKOUT_COUNT_LIMITS: Readonly<CheckoutCountLimits> = Object.freeze({
  maxUntrackedFiles: 1_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
});

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Same directory, however each side was spelled (8.3 names, drive case, links). */
function sameLocation(left: string, right: string): boolean {
  const [a, b] = [canonical(left), canonical(right)];
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Sum numstat over the tracked paths status reported, or null when a changed
 * path has no measurement at all.
 *
 * Renames are matched whichever command detected them: a numstat row under
 * the destination also measures its origin, and when numstat split a rename
 * that status paired (diff.renames=false) the origin's own deletion row counts.
 */
function trackedTotals(
  files: readonly ChangedFile[],
  counts: ReadonlyMap<string, DiffCounts>,
): { additions: number; deletions: number } | null {
  const measuredOrigins = new Set([...counts.values()].flatMap((entry) => entry.renamedFrom ? [entry.renamedFrom] : []));
  const rows = new Set<string>();
  for (const file of files) {
    if (file.untracked) continue;
    if (counts.has(file.path)) rows.add(file.path);
    else if (!measuredOrigins.has(file.path)) return null;
    if (file.renamedFrom && counts.has(file.renamedFrom)) rows.add(file.renamedFrom);
  }
  let additions = 0;
  let deletions = 0;
  for (const path of rows) {
    const entry = counts.get(path)!;
    // A side git reported as binary ("-") has no line count and adds zero.
    for (const side of [entry.staged, entry.unstaged]) {
      additions += side.additions ?? 0;
      deletions += side.deletions ?? 0;
    }
  }
  return { additions, deletions };
}

/** Lines the untracked files add, or null when any one cannot be counted. */
async function untrackedAdditions(
  projectRoot: string,
  paths: readonly string[],
  runAsync: AsyncRunner,
  limits: Readonly<CheckoutCountLimits>,
): Promise<number | null> {
  if (paths.length === 0) return 0;
  if (paths.length > limits.maxUntrackedFiles) return null;
  const attributes = await readCountAttributes(runAsync, projectRoot, paths);
  if (!attributes) return null;
  let realRoot: string;
  try {
    realRoot = await realpath(projectRoot);
  } catch {
    return null;
  }
  let additions = 0;
  let spent = 0;
  // Serial on purpose: a checkout may live on a slow disk, and the total byte
  // budget is what bounds this work, not parallelism.
  for (const path of paths) {
    const attribute = attributes.get(path);
    if (!attribute) return null;
    const allowance = Math.max(0, Math.min(limits.maxFileBytes, limits.maxTotalBytes - spent));
    const count = await countNewFileLines(realRoot, path, attribute, allowance);
    spent += count.bytesRead;
    if (count.kind === "unknown") return null;
    if (count.kind === "text") additions += count.additions;
  }
  return additions;
}

/**
 * Measure the checkout at `projectRoot` as one display/1 diff_summary, or
 * return null when there is no complete measurement to publish.
 */
export async function checkoutDiffSummary(
  projectRoot: string,
  run: Runner = defaultRunner(),
  runAsync: AsyncRunner = defaultAsyncRunner(),
  limits: Partial<CheckoutCountLimits> = {},
): Promise<RcProducedEvent | null> {
  const bounds: Readonly<CheckoutCountLimits> = { ...DEFAULT_CHECKOUT_COUNT_LIMITS, ...limits };
  const top = run("git", ["--no-optional-locks", "-C", projectRoot, "rev-parse", "--show-toplevel"], projectRoot);
  if (top.status !== 0 || !sameLocation(top.stdout.trim(), projectRoot)) return null;

  const status = run("git", ["--no-optional-locks", "-C", projectRoot, ...STATUS_V2_ARGS], projectRoot);
  if (status.status !== 0) return null;
  const files = parseStatusV2(status.stdout).files;
  const paths = [...new Set(files.map((file) => file.path))].sort();
  // Refuse the whole snapshot: counts for one set of paths beside a filtered
  // list of another would give the viewer a misleading summary.
  if (paths.length > MAX_SNAPSHOT_PATHS || paths.some((path) => !isSafeRelativePath(path))) return null;

  const snapshot = await readDiffCountSnapshot(runAsync, projectRoot);
  if (!snapshot.complete) return null;
  const tracked = trackedTotals(files, snapshot.counts);
  if (!tracked) return null;
  const untracked = await untrackedAdditions(
    projectRoot,
    files.filter((file) => file.untracked).map((file) => file.path),
    runAsync,
    bounds,
  );
  if (untracked === null) return null;

  const additions = tracked.additions + untracked;
  const deletions = tracked.deletions;
  if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions)) return null;
  const event = diffSummaryEvent({ additions, deletions, uncounted: [] }, listedPaths(paths));
  return { ...event, payload: { ...event.payload, files_changed: paths.length } };
}
