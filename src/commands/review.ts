// `aether review` / `/review` — see what changed, choose what to keep, commit it.
//
// The command layer over core/review_state.ts (what changed),
// core/verification_record.ts (whether anything verified it) and
// core/review_actions.ts (stage / unstage / revert / commit). Nothing here
// re-derives repository state or re-implements a mutation: this file is the
// screen, the picker and the confirmations, and every mutating step is a call
// into review_actions.
//
// Three properties it exists to hold:
//
//  1. What is shown is what was measured. Line counts come from
//     `git diff --numstat -z` (review_counts.ts); a count git did not report
//     renders "?", never 0. The verification line is classifyVerification's
//     reason VERBATIM — there is no path here that upgrades "stale" to
//     "verified", and adding one would be the single worst change that could
//     be made to this file.
//  2. Nothing is destroyed that the preview did not name. Revert shows the
//     exact patch planRevert will discard, names the file, and only then asks.
//  3. Selection is explicit. `--files` naming a path that did not change is an
//     error that says which one, never a silent skip and never a silent
//     everything.

import type { Writable } from "node:stream";
import type { AppContext } from "../core/context.js";
import {
  applyRevert,
  commitSelected,
  planCommit,
  planRevert,
  readFileDiff,
  resolveSelection,
  stageFiles,
  stageHunks,
  suggestCommitMessage,
  unstageFiles,
  unstageHunks,
  type ActionResult,
  type FileDiff,
  type RevertPlan,
} from "../core/review_actions.js";
import { readRepoState, type ChangedFile, type RepoState } from "../core/review_state.js";
import {
  classifyVerification,
  readVerification,
  treeIdentity,
  type VerificationReading,
} from "../core/verification_record.js";
import { defaultRunner, type Runner } from "../core/worktree.js";
import { confirm, stdioPrompt, type PromptIO } from "../ui/interact.js";
import { theme } from "../ui/theme.js";
import {
  formatCount,
  formatTotals,
  readLineCounts,
  spawnAsyncRun,
  sumCounts,
  type AsyncRun,
  type LineCount,
} from "./review_counts.js";

export interface ReviewFlags {
  /** Comma- or space-separated paths. */
  files?: string | undefined;
  /** Comma-separated 1-based hunk indexes, for stage/unstage/revert on one file. */
  hunks?: string | undefined;
  message?: string | undefined;
  base?: string | undefined;
  /** --test-cmd: the verification command. Never assembled here; handed to the
   *  ToolExecutor, which is the same VerifyRunner `aether agent` uses. */
  testCmd?: string | undefined;
  all: boolean;
  yes: boolean;
  json: boolean;
  /** The declared authority boundary: --approve destructive. */
  approve?: string | undefined;
}

export interface ReviewDeps {
  run: Runner;
  runAsync: AsyncRun;
  cwd: string;
  out: Writable;
  io: PromptIO;
}

export function defaultReviewDeps(cwd: string, out: Writable): ReviewDeps {
  return { run: defaultRunner(), runAsync: spawnAsyncRun(), cwd, out, io: stdioPrompt() };
}

// ── the authority boundary ──────────────────────────────────────────────────
//
// `--yes` exists so a scripted run does not hang on a prompt. It must not
// therefore become the way work gets destroyed with nobody having said so.
// Discarding uncommitted work needs the action NAMED on the command line —
// `--approve destructive` — which cannot be inherited from a shell alias meant
// for something else and reads in a script as the sentence it is.

export type Authority = "read" | "index" | "commit" | "destructive" | "publish";

export const EXPLICIT_APPROVAL_REQUIRED: readonly Authority[] = ["destructive", "publish"];

export function needsExplicitApproval(authority: Authority): boolean {
  return EXPLICIT_APPROVAL_REQUIRED.includes(authority);
}

export function autoApproved(
  authority: Authority,
  flags: { yes: boolean; approve?: string | undefined },
): boolean {
  if (needsExplicitApproval(authority)) {
    return (flags.approve ?? "").trim().toLowerCase() === authority;
  }
  return flags.yes;
}

// ── parsing ─────────────────────────────────────────────────────────────────

/** Split `--files` on commas and whitespace. Empty entries are dropped. */
export function parseFileList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/[,\s]+/).map((part) => part.trim()).filter(Boolean))];
}

/** Split `--hunks 1,3,4`. Anything that is not a hunk number is an error. */
export function parseHunkList(raw: string | undefined): { hunks: number[]; error?: string } {
  const hunks: number[] = [];
  for (const part of parseFileList(raw)) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 1) return { hunks: [], error: `not a hunk number: ${part}` };
    hunks.push(value);
  }
  return { hunks };
}

/**
 * Turn --all / --files into a concrete path list, checked against what changed.
 * A name that matched nothing is reported by name: a typo that silently selects
 * nothing produces "done" with no work; a typo that silently selects everything
 * is worse.
 */
export function selectionFrom(state: RepoState, flags: ReviewFlags): { paths: string[]; error?: string } {
  if (flags.all && flags.files) return { paths: [], error: "--all and --files are mutually exclusive" };
  if (flags.all) return { paths: state.files.map((file) => file.path).sort() };
  const named = parseFileList(flags.files);
  if (named.length === 0) return { paths: [], error: "nothing selected — pass --files <paths> or --all" };
  const { unknown } = resolveSelection(state, named);
  if (unknown.length) return { paths: [], error: `not a changed path in this repository: ${unknown.join(", ")}` };
  return { paths: named.sort() };
}

// ── the screen ──────────────────────────────────────────────────────────────

/** staged / unstaged / staged + more / untracked / CONFLICT. */
export function stateOf(file: ChangedFile): string {
  if (file.unmerged) return "CONFLICT";
  if (file.untracked) return "untracked";
  if (file.staged && file.unstaged) return "staged + more";
  if (file.staged) return "staged";
  return "unstaged";
}

/**
 * How far ahead of the base the branch is. `null` means git did not report it,
 * and it is rendered "unknown" — a branch whose position nobody measured is not
 * a branch that is level with its base.
 */
export function aheadLine(state: RepoState): string {
  const base = state.base.branch ?? "an unresolved base";
  const ahead = state.aheadOfBase === null ? "unknown" : String(state.aheadOfBase);
  const behind = state.behindBase === null ? "unknown" : String(state.behindBase);
  const freshness = state.base.fetched ? "" : `  ${theme.dim(`(${state.base.reason ?? "base not fetched just now"})`)}`;
  return `${ahead} ahead of ${base}, ${behind} behind${freshness}`;
}

export interface ScreenOptions {
  counts: ReadonlyMap<string, LineCount>;
  verification: VerificationReading;
  title?: string;
}

/** The review screen: a checkbox per changed file, then measured totals. */
export function renderReview(
  state: RepoState,
  selected: ReadonlySet<string>,
  options: ScreenOptions,
): string {
  const head = state.head.detached ? "detached HEAD" : (state.head.branch ?? "an unborn branch");
  const lines = [`${theme.cyan(options.title ?? "Review changes")}  ${theme.dim(`(${head})`)}`];
  if (state.files.length === 0) {
    lines.push("  (working tree clean — nothing to review)");
    return lines.join("\n") + "\n";
  }
  const width = Math.max(...state.files.map((file) => file.path.length));
  state.files.forEach((file, index) => {
    const box = selected.has(file.path) ? "[x]" : "[ ]";
    const from = file.renamedFrom ? ` ${theme.dim(`(was ${file.renamedFrom})`)}` : "";
    const pad = " ".repeat(Math.max(0, width - file.path.length));
    lines.push(
      `  ${String(index + 1).padStart(2, " ")}. ${box} ${file.path}${pad}${from}  ` +
        `${formatCount(options.counts.get(file.path))}  ${theme.dim(stateOf(file))}`,
    );
  });
  const totals = sumCounts(state.files.map((file) => file.path), options.counts);
  lines.push("");
  lines.push(`  Changed: ${formatTotals(totals)}`);
  // classifyVerification's reason, verbatim. Nothing here re-words it, and
  // nothing here can turn a "stale" reading into a green one.
  lines.push(`  Tests:   ${options.verification.status} — ${options.verification.reason}`);
  lines.push(`  Branch:  ${aheadLine(state)}`);
  return lines.join("\n") + "\n";
}

/** Every hunk of one file, numbered, printed in full. Nothing is truncated. */
export function renderHunks(file: FileDiff): string {
  if (file.binary) return `  ${file.path} is binary — it has no hunks to select.\n`;
  if (file.hunks.length === 0) return `  ${file.path} has no hunks in this half of the diff.\n`;
  const lines: string[] = [`  ${theme.bold(file.path)} — ${file.hunks.length} hunk(s)`];
  for (const hunk of file.hunks) {
    lines.push(`  ${theme.cyan(`hunk ${hunk.index}`)}  +${hunk.additions} -${hunk.deletions}`);
    for (const line of [hunk.header, ...hunk.lines]) {
      if (line.startsWith("+")) lines.push("    " + theme.green(line));
      else if (line.startsWith("-")) lines.push("    " + theme.red(line));
      else lines.push("    " + theme.dim(line));
    }
  }
  return lines.join("\n") + "\n";
}

// ── reading ─────────────────────────────────────────────────────────────────

export interface ReviewRead {
  state: RepoState;
  counts: Map<string, LineCount>;
  verification: VerificationReading;
}

export async function readReview(
  deps: ReviewDeps,
  options: { base?: string | undefined } = {},
): Promise<ReviewRead | { error: string }> {
  const state = readRepoState(deps.run, deps.cwd, options.base ? { base: options.base } : {});
  if (!state.ok) return { error: state.reason };
  const counts = await readLineCounts(deps.runAsync, state.root);
  const verification = classifyVerification(readVerification(state.root), treeIdentity(deps.run, state.root));
  return { state, counts, verification };
}

// ── destructive: revert ─────────────────────────────────────────────────────

/**
 * Discard uncommitted work in exactly the selected files.
 *
 * planRevert returns the exact patch it would discard; that patch is printed in
 * full, the file is named, and only then is the question asked. applyRevert
 * re-reads the diff and refuses if the file moved between the preview and the
 * answer — so an approval can never be spent on content that no longer exists.
 */
export async function revertSelected(
  deps: ReviewDeps,
  state: RepoState,
  flags: ReviewFlags,
  paths: readonly string[],
  hunks: readonly number[] | null,
): Promise<ActionResult[]> {
  const plans: RevertPlan[] = [];
  const results: ActionResult[] = [];
  for (const path of paths) {
    const planned = planRevert(deps.run, state, path, hunks);
    if ("ok" in planned) {
      results.push(planned);
      continue;
    }
    plans.push(planned);
  }
  if (plans.length === 0) return results;

  deps.out.write(
    `${theme.yellow("!")} About to DISCARD uncommitted work in ${plans.length} file(s). This cannot be undone by git.\n`,
  );
  for (const plan of plans) {
    deps.out.write(`\n  ${theme.bold(plan.path)} — restores to ${plan.restoresTo}\n`);
    // The whole patch, not a preview of it. The user cannot approve what they
    // were not shown, and this is the content that disappears.
    for (const line of plan.preview.split("\n")) {
      if (line === "") continue;
      if (line.startsWith("+")) deps.out.write("    " + theme.green(line) + "\n");
      else if (line.startsWith("-")) deps.out.write("    " + theme.red(line) + "\n");
      else deps.out.write("    " + theme.dim(line) + "\n");
    }
  }
  deps.out.write(theme.dim(`\n  Files not named above are not touched.\n`));

  const approved =
    autoApproved("destructive", flags) ||
    (await confirm(deps.io, `Discard the changes shown in ${plans.map((p) => p.path).join(", ")}?`, {
      default: false,
    }));
  if (!approved) {
    results.push({
      ok: false,
      paths: [],
      message:
        "cancelled — nothing was discarded." +
        (flags.yes && !flags.approve
          ? "\n  (--yes does not approve a destructive action; pass --approve destructive)"
          : ""),
    });
    return results;
  }
  for (const plan of plans) results.push(applyRevert(deps.run, state, plan));
  return results;
}

// ── the non-interactive rail ────────────────────────────────────────────────

const USAGE =
  "usage: aether review [subcommand]\n" +
  "  aether review                                 show what changed\n" +
  "  aether review stage    --files a,b | --all    stage the selection\n" +
  "  aether review stage    --files a --hunks 1,3  stage only those hunks of one file\n" +
  "  aether review unstage  --files a,b | --all    unstage the selection\n" +
  "  aether review revert   --files a,b            DISCARD work (needs --approve destructive)\n" +
  '  aether review commit   --files a,b -m "msg"   commit exactly the selection\n' +
  "  aether review diff     --files a              full diff, every hunk numbered\n" +
  "\n  Then: aether ship — publish the branch and open a pull request.\n";

const say = (out: Writable, result: ActionResult): void => {
  out.write(`${result.ok ? theme.cyan("✔") : "✗"} ${result.message}\n`);
};

export async function runReview(
  ctx: AppContext,
  deps: ReviewDeps,
  sub: string,
  flags: ReviewFlags,
): Promise<number> {
  const read = await readReview(deps, { base: flags.base });
  if ("error" in read) {
    deps.out.write(`✗ ${read.error}\n`);
    return 1;
  }
  const { state, counts, verification } = read;

  if (flags.json) {
    deps.out.write(
      JSON.stringify(
        {
          root: state.root,
          head: state.head,
          base: state.base,
          aheadOfBase: state.aheadOfBase,
          behindBase: state.behindBase,
          verification: { status: verification.status, reason: verification.reason },
          files: state.files.map((file) => ({
            ...file,
            counts: counts.get(file.path) ?? { added: null, deleted: null },
          })),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  if (sub === "" || sub === "show") {
    const preselected = new Set(state.files.filter((file) => file.staged).map((file) => file.path));
    deps.out.write(renderReview(state, preselected, { counts, verification }));
    if (state.files.length === 0) return 0;
    if (deps.io.tty && !flags.yes) return interactiveReview(ctx, deps, state, preselected);
    deps.out.write("\n" + theme.dim(USAGE));
    return 0;
  }
  if (sub === "help") {
    deps.out.write(USAGE);
    return 0;
  }

  if (sub === "verify") {
    // The ONLY way this command layer can produce a verification is
    // verifyAndRecord — the single writer. No command string is assembled
    // here: the ToolExecutor is the same VerifyRunner `aether agent` uses,
    // and it decides how the command runs. A run whose working tree moved
    // underneath it records nothing and reads back "unknown".
    const { ToolExecutor } = await import("../core/tool_executor.js");
    const { verifyAndRecord } = await import("../core/verify_run.js");
    const command = (flags.testCmd ?? "").trim();
    const runner = new ToolExecutor(state.root, command);
    const result = await verifyAndRecord(
      runner,
      deps.run,
      state.root,
      command,
    );
    deps.out.write(result.output.endsWith("\n") ? result.output : result.output + "\n");
    deps.out.write(`  Tests:   ${result.reading.status} — ${result.reading.reason}\n`);
    if (!result.written) {
      deps.out.write(
        theme.dim(
          result.completed
            ? "  nothing was recorded — this run cannot be attributed to a working tree.\n"
            : "  nothing was recorded — the check did not run to completion.\n",
        ),
      );
    }
    return result.reading.status === "verified" ? 0 : 1;
  }
  const selection = selectionFrom(state, flags);
  if (selection.error) {
    deps.out.write(`✗ ${selection.error}\n${sub === "diff" ? "" : USAGE}`);
    return 2;
  }
  const { hunks, error } = parseHunkList(flags.hunks);
  if (error) {
    deps.out.write(`✗ ${error}\n`);
    return 2;
  }
  const oneFile = (): string | null => (selection.paths.length === 1 ? selection.paths[0]! : null);

  switch (sub) {
    case "diff": {
      for (const path of selection.paths) {
        for (const staged of [true, false]) {
          const file = readFileDiff(deps.run, state, path, staged);
          if (file && (file.hunks.length || file.binary)) {
            deps.out.write(`${theme.dim(staged ? "staged" : "unstaged")}:\n${renderHunks(file)}`);
          }
        }
      }
      return 0;
    }
    case "stage":
    case "unstage": {
      if (hunks.length) {
        const path = oneFile();
        if (!path) {
          deps.out.write("✗ --hunks applies to exactly one file — pass a single --files path\n");
          return 2;
        }
        const result =
          sub === "stage"
            ? stageHunks(deps.run, state, path, hunks)
            : unstageHunks(deps.run, state, path, hunks);
        say(deps.out, result);
        return result.ok ? 0 : 1;
      }
      const result =
        sub === "stage"
          ? stageFiles(deps.run, state, selection.paths)
          : unstageFiles(deps.run, state, selection.paths);
      say(deps.out, result);
      return result.ok ? 0 : 1;
    }
    case "revert": {
      if (hunks.length && !oneFile()) {
        deps.out.write("✗ --hunks applies to exactly one file — pass a single --files path\n");
        return 2;
      }
      const results = await revertSelected(deps, state, flags, selection.paths, hunks.length ? hunks : null);
      for (const result of results) say(deps.out, result);
      return results.every((result) => result.ok) ? 0 : 1;
    }
    case "commit": {
      const plan = planCommit(state, selection.paths);
      if (!plan.ok) {
        deps.out.write(`✗ ${plan.reason ?? "the commit was refused"}\n`);
        if (plan.unrelatedStaged.length) {
          deps.out.write(
            theme.dim(`  unstage it first:  aether review unstage --files ${plan.unrelatedStaged.join(",")}\n`),
          );
        }
        return 1;
      }
      const message = (flags.message ?? "").trim() || suggestCommitMessage(plan.paths);
      if (!flags.message) {
        deps.out.write(theme.dim(`  no -m given; using the suggested subject: ${message}\n`));
      }
      const result = commitSelected(deps.run, state, plan, message);
      say(deps.out, result);
      if (result.ok && result.revision) deps.out.write(theme.dim(`  ${result.revision.slice(0, 8)}\n`));
      return result.ok ? 0 : 1;
    }
    default:
      deps.out.write(`✗ unknown subcommand: ${sub}\n${USAGE}`);
      return 2;
  }
}

// ── the interactive layer ───────────────────────────────────────────────────

const KEYS =
  "  1 3 5  toggle rows   a all   n none   d <n> diff\n" +
  "  s [<n> <hunks>] stage   u [<n> <hunks>] unstage   r revert   c commit   p publish + PR   q quit\n";

/**
 * A line-oriented loop, not a raw-mode key grabber.
 *
 * Raw mode has to own the terminal, which fights the REPL `/review` is called
 * from, and it makes every behaviour reachable only by synthesising keypresses.
 * Every branch below calls the same exported function the non-interactive
 * subcommand calls, so one set of tests covers both surfaces.
 */
export async function interactiveReview(
  ctx: AppContext,
  deps: ReviewDeps,
  initial: RepoState,
  preselected: ReadonlySet<string>,
): Promise<number> {
  let state = initial;
  const selected = new Set(preselected);
  const paths = (): string[] => [...selected].sort();
  const row = (token: string): ChangedFile | null => {
    const index = Number(token);
    if (!Number.isInteger(index) || index < 1 || index > state.files.length) return null;
    return state.files[index - 1] ?? null;
  };

  for (;;) {
    deps.out.write(KEYS);
    const line = (await deps.io.question("review> ")).trim();
    if (line === "") continue;
    const [verb = "", ...rest] = line.split(/\s+/);

    if (verb === "q" || verb === "quit" || verb === "exit") return 0;
    if (verb === "a") {
      for (const file of state.files) selected.add(file.path);
    } else if (verb === "n") {
      selected.clear();
    } else if (/^\d+$/.test(verb)) {
      for (const token of [verb, ...rest]) {
        const file = row(token);
        if (!file) {
          deps.out.write(`✗ no row ${token}\n`);
          continue;
        }
        if (selected.has(file.path)) selected.delete(file.path);
        else selected.add(file.path);
      }
    } else if (verb === "d") {
      const file = row(rest[0] ?? "");
      if (!file) {
        deps.out.write("✗ usage: d <row>\n");
        continue;
      }
      for (const staged of [true, false]) {
        const diff = readFileDiff(deps.run, state, file.path, staged);
        if (diff && (diff.hunks.length || diff.binary)) {
          deps.out.write(`${theme.dim(staged ? "staged" : "unstaged")}:\n${renderHunks(diff)}`);
        }
      }
      deps.out.write(theme.dim(`  stage some of them:  s ${rest[0]} 1,3\n`));
      continue;
    } else if (verb === "s" || verb === "u") {
      const stage = verb === "s";
      if (rest.length >= 2) {
        const file = row(rest[0] ?? "");
        const { hunks, error } = parseHunkList(rest.slice(1).join(","));
        if (!file || error) {
          deps.out.write(`✗ usage: ${verb} <row> <hunk,hunk>\n`);
          continue;
        }
        say(
          deps.out,
          stage
            ? stageHunks(deps.run, state, file.path, hunks)
            : unstageHunks(deps.run, state, file.path, hunks),
        );
      } else if (paths().length === 0) {
        deps.out.write("✗ nothing selected\n");
      } else {
        say(
          deps.out,
          stage ? stageFiles(deps.run, state, paths()) : unstageFiles(deps.run, state, paths()),
        );
      }
    } else if (verb === "r") {
      if (paths().length === 0) deps.out.write("✗ nothing selected\n");
      else {
        const results = await revertSelected(
          deps,
          state,
          { all: false, yes: false, json: false },
          paths(),
          null,
        );
        for (const result of results) say(deps.out, result);
      }
    } else if (verb === "c") {
      if (paths().length === 0) {
        deps.out.write("✗ nothing selected\n");
      } else {
        const plan = planCommit(state, paths());
        if (!plan.ok) {
          deps.out.write(`✗ ${plan.reason ?? "the commit was refused"}\n`);
        } else {
          const suggested = suggestCommitMessage(plan.paths);
          deps.out.write(theme.dim(`  suggested: ${suggested}\n`));
          const typed = (await deps.io.question("commit message> ")).trim();
          say(deps.out, commitSelected(deps.run, state, plan, typed || suggested));
        }
      }
    } else if (verb === "p") {
      const { runShip } = await import("./ship.js");
      const code = await runShip(ctx, { run: deps.run, cwd: deps.cwd, out: deps.out, io: deps.io }, { yes: false, json: false });
      if (code === 0) return 0;
    } else {
      deps.out.write(`✗ unknown: ${verb}\n`);
    }

    const refreshed = await readReview(deps, {});
    if ("error" in refreshed) {
      deps.out.write(`✗ ${refreshed.error}\n`);
      return 1;
    }
    state = refreshed.state;
    for (const path of [...selected]) {
      if (!state.files.some((file) => file.path === path)) selected.delete(path);
    }
    deps.out.write(
      "\n" + renderReview(state, selected, { counts: refreshed.counts, verification: refreshed.verification }),
    );
  }
}

// ── entry points ────────────────────────────────────────────────────────────

export async function cmdReview(ctx: AppContext, rest: string[], flags: ReviewFlags): Promise<number> {
  return runReview(ctx, defaultReviewDeps(ctx.flags.cwd, process.stdout), (rest[0] ?? "").trim(), flags);
}

/** `/review` inside the REPL — the same rail, writing to the REPL's stream. */
export async function reviewSlash(ctx: AppContext, out: Writable, arg: string): Promise<void> {
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const valueOf = (name: string): string | undefined => {
    const at = parts.indexOf(name);
    return at >= 0 ? parts[at + 1] : undefined;
  };
  const sub = parts[0] && !parts[0].startsWith("--") ? parts[0] : "";
  await runReview(ctx, defaultReviewDeps(ctx.flags.cwd, out), sub, {
    all: parts.includes("--all"),
    yes: false,
    json: false,
    ...(valueOf("--files") !== undefined ? { files: valueOf("--files") } : {}),
    ...(valueOf("--hunks") !== undefined ? { hunks: valueOf("--hunks") } : {}),
    ...(valueOf("-m") !== undefined ? { message: valueOf("-m") } : {}),
    ...(valueOf("--approve") !== undefined ? { approve: valueOf("--approve") } : {}),
  });
}
