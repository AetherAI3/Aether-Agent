// A checkout snapshot for RC. Paths come from Git status; line counts come
// only from Git numstat. Neither model output nor a human-readable diff is read.
import { resolve } from "node:path";
import { defaultAsyncRunner, readDiffCountSnapshot, totalCounts, type AsyncRunner } from "../diff_counts.js";
import { parseStatusV2, STATUS_V2_ARGS } from "../review_state.js";
import { defaultRunner, type Runner } from "../worktree.js";
import { diffSummaryEvent, type RcProducedEvent } from "./producers.js";
import { isSafeRelativePath } from "./redaction.js";

export async function checkoutDiffSummary(
  projectRoot: string,
  run: Runner = defaultRunner(),
  runAsync: AsyncRunner = defaultAsyncRunner(),
): Promise<RcProducedEvent | null> {
  const root = run("git", ["--no-optional-locks", "-C", projectRoot, "rev-parse", "--show-toplevel"], projectRoot);
  if (root.status !== 0 || resolve(root.stdout.trim()) !== resolve(projectRoot)) return null;

  const status = run("git", ["--no-optional-locks", "-C", projectRoot, ...STATUS_V2_ARGS], projectRoot);
  if (status.status !== 0) return null;
  const paths = [...new Set(parseStatusV2(status.stdout).files.map((file) => file.path))].sort();
  // Refuse the whole snapshot: publishing counts for one set of paths and a
  // filtered list for another would give the viewer a misleading summary.
  if (paths.some((path) => !isSafeRelativePath(path)) || paths.length > 100_000) return null;

  const snapshot = await readDiffCountSnapshot(runAsync, projectRoot);
  const total = totalCounts(snapshot.counts, paths);
  const event = diffSummaryEvent(total, paths.slice(0, 64));
  event.payload["files_changed"] = paths.length;
  // A failed side, binary or untracked path has no complete line count. The
  // schema has optional counts, so omission is the honest unknown state.
  if (!snapshot.complete || total.uncounted.length || paths.some((path) => snapshot.counts.get(path)?.binary) ||
      !Number.isSafeInteger(total.additions) || !Number.isSafeInteger(total.deletions)) {
    delete event.payload["insertions"];
    delete event.payload["deletions"];
  }
  return event;
}
