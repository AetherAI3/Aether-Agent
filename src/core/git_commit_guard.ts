import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitRunner {
  run(args: string[]): GitRunResult;
}

/**
 * Options prefixed to EVERY git invocation this runner makes.
 *
 * `--no-optional-locks` is not cosmetic. Without it a plain `git status`
 * rewrites the user's index as a side effect of being read, so merely starting
 * the agent mutates the repository and can lose a race with the user's own git
 * process in the same worktree. Inspection must be inspection.
 * `core.literalPathspecs` keeps a path that happens to begin with `:` from
 * being reinterpreted as pathspec magic.
 */
export const GIT_GLOBAL_ARGS: readonly string[] = [
  "--no-optional-locks",
  "--literal-pathspecs",
  "-c",
  "core.literalPathspecs=true",
];

/**
 * The pathspec appended to the dirty-worktree probe.
 *
 * `git status` reports the WHOLE repository, not the directory it runs in.
 * Unbounded, the probe is O(entire repository) even when the agent's workspace
 * is one small directory inside it, and `--untracked-files=all` turns that into
 * an enumeration of every untracked path individually. The guard only ever
 * stages paths inside the workspace, so bounding the probe to the workspace
 * subtree removes work that could never have produced a candidate.
 */
export const WORKSPACE_PATHSPEC: readonly string[] = ["--", "."];

/** `git status` probe: dirty paths in the workspace subtree, NUL-delimited. */
export const STATUS_PROBE: readonly string[] = [
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
  ...WORKSPACE_PATHSPEC,
];

/** A commit consumes the ENTIRE index, including staged paths outside a nested
 * workspace. Inspect all staged paths so unrelated user work cannot be swept in. */
export const STAGED_PROBE: readonly string[] = [
  "diff",
  "--cached",
  "--name-only",
  "-z",
];

export class SpawnGitRunner implements GitRunner {
  private repoRoot: string | null = null;
  constructor(private readonly cwd: string) {}

  run(args: string[]): GitRunResult {
    // Porcelain names are repo-relative even when cwd is a workspace subtree.
    // Candidate staging/reset/drift checks must use that same path base.
    let argv = args;
    const separator = args.indexOf("--");
    if (["add", "reset", "diff"].includes(args[0] ?? "") && separator >= 0 && args[separator + 1] !== ".") {
      if (!this.repoRoot) {
        const root = spawnSync("git", [...GIT_GLOBAL_ARGS, "rev-parse", "--show-toplevel"], { cwd: this.cwd, encoding: "utf8" });
        if (root.status !== 0) return { ok: false, stdout: "", stderr: "unable to resolve git root", exitCode: 1 };
        this.repoRoot = root.stdout.trim();
      }
      argv = [...args.slice(0, separator + 1), ...args.slice(separator + 1).map(path => resolve(this.repoRoot!, path))];
    }
    const result = spawnSync("git", [...GIT_GLOBAL_ARGS, ...argv], {
      cwd: this.cwd,
      shell: false,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error) {
      return {
        ok: false,
        stdout: "",
        stderr: result.error.message,
        exitCode: 1,
      };
    }
    const exitCode = result.status ?? 1;
    return {
      ok: exitCode === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode,
    };
  }
}

export function parsePorcelainPaths(raw: string): string[] {
  const fields = raw.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ") continue;
    const code = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return [...new Set(paths)].sort();
}

export function parseNulPaths(raw: string): string[] {
  return [...new Set(raw.split("\0").filter(Boolean))].sort();
}

export interface GitCommitPlan {
  ok: boolean;
  candidates: string[];
  reason?: string;
}

export function planGitCommit(
  initialDirty: Iterable<string>,
  initialStaged: Iterable<string>,
  currentDirty: Iterable<string>,
  currentStaged: Iterable<string>,
): GitCommitPlan {
  const baseline = new Set(initialDirty);
  const initialIndex = [...new Set(initialStaged)];
  if (initialIndex.length) {
    return { ok: false, candidates: [], reason: "pre-existing staged changes" };
  }
  const staged = [...new Set(currentStaged)];
  if (staged.length) {
    return { ok: false, candidates: [], reason: "unexpected staged changes" };
  }
  const candidates = [...new Set(currentDirty)]
    .filter((path) => !baseline.has(path))
    .sort();
  if (candidates.length > 1000) {
    return { ok: false, candidates: [], reason: "more than 1000 new paths" };
  }
  return { ok: true, candidates };
}

function samePaths(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((path, index) => path === b[index]);
}

export interface GitCommitResult {
  output: string;
  exitCode: number;
}

/**
 * Staging guard for the `git_commit` tool.
 *
 * Constructing the guard takes the "already dirty before the agent touched
 * anything" baseline, so construction must happen BEFORE the run's first
 * workspace mutation — it cannot be deferred all the way to the first
 * `git_commit` call. At that point the baseline would equal the current state,
 * the set difference in `planGitCommit` would be empty for every commit, and
 * the tool would become an unconditional no-op. The owner (`ToolExecutor`)
 * therefore constructs the guard lazily on the first MUTATING tool call rather
 * than at CLI start: still before anything can have changed, but off the
 * startup path and never paid at all by a run that only reads.
 */
export class GitCommitGuard {
  private readonly initialDirty: string[];
  private readonly initialStaged: string[];
  private readonly initError: string | null;

  constructor(private readonly runner: GitRunner) {
    const dirty = runner.run([...STATUS_PROBE]);
    const staged = runner.run([...STAGED_PROBE]);
    this.initialDirty = dirty.ok ? parsePorcelainPaths(dirty.stdout) : [];
    this.initialStaged = staged.ok ? parseNulPaths(staged.stdout) : [];
    this.initError = dirty.ok && staged.ok ? null : "not a usable git repository";
  }

  commit(message: string, ownedPaths?: ReadonlySet<string>): GitCommitResult {
    if (this.initError) return { output: "[git_commit refused: " + this.initError + "]", exitCode: 1 };

    const dirty = this.runner.run([...STATUS_PROBE]);
    const staged = this.runner.run([...STAGED_PROBE]);
    if (!dirty.ok || !staged.ok) {
      return { output: "[git_commit refused: unable to inspect repository state]", exitCode: 1 };
    }
    const plan = planGitCommit(
      this.initialDirty,
      this.initialStaged,
      parsePorcelainPaths(dirty.stdout),
      parseNulPaths(staged.stdout),
    );
    if (!plan.ok) return { output: "[git_commit refused: " + plan.reason + "]", exitCode: 1 };
    if (ownedPaths) plan.candidates = plan.candidates.filter(path => ownedPaths.has(path));
    if (!plan.candidates.length) return { output: "[nothing new to commit]", exitCode: 0 };

    const added = this.runner.run(["add", "-A", "--", ...plan.candidates]);
    if (!added.ok) return { output: "[git_commit add failed: " + added.stderr.trim() + "]", exitCode: added.exitCode };

    const after = this.runner.run([...STAGED_PROBE]);
    const stagedAfter = after.ok ? parseNulPaths(after.stdout) : [];
    if (!after.ok || !samePaths(stagedAfter, plan.candidates)) {
      this.runner.run(["reset", "-q", "HEAD", "--", ...plan.candidates]);
      return { output: "[git_commit refused: staged set verification failed]", exitCode: 1 };
    }
    // The index must still match the worktree immediately before commit. This
    // closes the stage-then-swap window for a concurrent writer or hook.
    const drift = this.runner.run(["diff", "--quiet", "--", ...plan.candidates]);
    if (!drift.ok) {
      this.runner.run(["reset", "-q", "HEAD", "--", ...plan.candidates]);
      return { output: "[git_commit refused: worktree changed after staging]", exitCode: 1 };
    }

    const committed = this.runner.run(["commit", "-q", "-m", message]);
    if (!committed.ok) {
      this.runner.run(["reset", "-q", "HEAD", "--", ...plan.candidates]);
      return {
        output: "[git_commit failed: " + (committed.stderr.trim() || committed.stdout.trim()) + "]",
        exitCode: committed.exitCode,
      };
    }
    const revision = this.runner.run(["rev-parse", "--short", "HEAD"]);
    const sha = revision.ok ? revision.stdout.trim() : "";
    return {
      output: "[exit 0]\ncommitted " + plan.candidates.length + " path(s)" + (sha ? "\n" + sha : ""),
      exitCode: 0,
    };
  }
}
