// `aether ship` / `/ship` — publish the head branch, then open a pull request.
//
// core/ship.ts has held a safe PR-creation core since commit #86 and nothing
// called it: a `--repo` run ended with `prCreateHint`, a printed gh incantation
// the user had to retype. This is the command that calls it.
//
// The command layer owns three things and delegates everything else:
//
//  1. THE CONFIRMATION SCREEN. Publishing puts work under the user's name, so
//     what is about to run is shown as argv VECTORS — one element per line, in
//     full, never abbreviated. A `$ gh pr create --title "…"` one-liner is
//     wrong twice: it implies a shell parses it, and a long or multi-line body
//     has to be elided to fit. The user cannot approve what they were not shown.
//  2. THE AUTHORITY BOUNDARY. `--yes` exists so a scripted run does not hang on
//     a prompt; it must not become the way work gets published with nobody
//     having said so. Publishing needs the action NAMED: `--approve publish`.
//  3. A gh argv ALLOWLIST at the last moment before a process starts. A
//     blacklist of dangerous words has to anticipate the attack; an allowlist
//     has to anticipate the feature, so `pr merge`, `--admin`, `--auto` and
//     `--squash` fail simply by not being on it.
//
// Everything about what may be pushed, where, and whether it is a fast-forward
// lives in core/publish.ts. Nothing here re-derives it, and nothing here can
// force, merge, or push a ref other than HEAD's own branch.

import type { Writable } from "node:stream";
import type { AppContext } from "../core/context.js";
import { readRepoState, type RepoState } from "../core/review_state.js";
import {
  planShip,
  publishHead,
  pushArgs,
  renderPublishPlan,
  validatePublish,
} from "../core/publish.js";
import {
  bindShipRecord,
  recordPublished,
  recordPullRequest,
  recordVerification,
  writeShipRecord,
} from "../core/ship_record.js";
import {
  classifyVerification,
  readVerification,
  treeIdentity,
  type VerificationReading,
} from "../core/verification_record.js";
import { openPullRequest, prCreateArgs, type ShipRequest } from "../core/ship.js";
import { getActiveGoal } from "../core/goals.js";
import { assertCurrentPrDraft, preparePrDraft, readPreparedPrDraft, type PreparedPrDraft } from "../core/pr_draft.js";
import type { RepoSpec } from "../core/repo.js";
import { defaultRunner, type Runner } from "../core/worktree.js";
import { confirm, stdioPrompt, type PromptIO } from "../ui/interact.js";
import { theme } from "../ui/theme.js";

export interface ShipFlags {
  title?: string | undefined;
  body?: string | undefined;
  draft?: boolean | undefined;
  draftFile?: string | undefined;
  base?: string | undefined;
  yes: boolean;
  json: boolean;
  approve?: string | undefined;
}

export interface ShipDeps {
  run: Runner;
  cwd: string;
  out: Writable;
  io: PromptIO;
}

export function defaultShipDeps(cwd: string, out: Writable): ShipDeps {
  return { run: defaultRunner(), cwd, out, io: stdioPrompt() };
}

export class UnsafeGhArgvError extends Error {}

/**
 * Whole-shape allowlist for gh. Three permitted shapes: the version probe, the
 * auth probe, and `pr create` followed by flag/value pairs from a fixed set.
 *
 * Only FLAG positions are checked. Values — the title and body, which a model
 * may have written — are never inspected: a title containing the word "merge"
 * is a title, and refusing it would be theatre. Their safety comes from being
 * argv elements, which core/ship.ts's canaries already prove.
 */
export const GH_PR_CREATE_FLAGS: readonly string[] = ["-R", "--head", "--title", "--body", "--base"];

export function assertSafeGhArgv(argv: readonly string[]): void {
  const shape = argv.join(" ");
  if (shape === "--version" || shape === "auth status") return;
  if (argv[0] !== "pr" || argv[1] !== "create") {
    throw new UnsafeGhArgvError(`refusing a gh invocation that is not \`pr create\`: gh ${shape}`);
  }
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index]!;
    if (!GH_PR_CREATE_FLAGS.includes(flag)) {
      throw new UnsafeGhArgvError(`refusing an unpermitted gh pr create flag: ${flag}`);
    }
    if (index + 1 >= argv.length) throw new UnsafeGhArgvError(`gh flag ${flag} has no value`);
  }
}

/** `--yes` never approves publishing. The action must be named: --approve publish. */
export function publishAutoApproved(flags: { yes: boolean; approve?: string | undefined }): boolean {
  return (flags.approve ?? "").trim().toLowerCase() === "publish";
}

// ── the confirmation screen ─────────────────────────────────────────────────

export interface PlannedCommand {
  cmd: string;
  args: string[];
}

/** Render one command as its argv VECTOR, one element per line, in full. */
export function renderArgvVector(command: PlannedCommand, indent = "    "): string {
  const width = String(Math.max(command.args.length - 1, 0)).length;
  const lines = [`${indent}${command.cmd}`];
  command.args.forEach((value, index) => {
    const label = `${indent}  argv[${String(index).padStart(width, " ")}]  `;
    const parts = value.split("\n");
    lines.push(label + (parts[0] ?? ""));
    for (const extra of parts.slice(1)) lines.push(" ".repeat(label.length) + extra);
  });
  return lines.join("\n");
}

/**
 * The two commands, in the order they run.
 *
 * `setUpstream` is computed exactly as publishHead computes it — from whether
 * the branch already has an upstream — so the screen shows the vector that will
 * actually run rather than a plausible one.
 */
export function plannedCommands(state: RepoState, request: ShipRequest): PlannedCommand[] {
  const remote = state.remote?.name ?? "(none)";
  const branch = state.head.branch ?? "(detached)";
  return [
    { cmd: "git", args: pushArgs(remote, branch, state.head.upstream === null) },
    { cmd: "gh", args: prCreateArgs(request) },
  ];
}

export function renderShipConfirm(
  state: RepoState,
  request: ShipRequest,
  verification: VerificationReading,
): string {
  const ahead = state.aheadOfBase === null ? "unknown" : String(state.aheadOfBase);
  const lines = [
    "  About to publish a branch and open a pull request",
    "",
    `  repository   ${request.spec.full}`,
    // renderPublishPlan states the remote, the PUSH destination, the branch and
    // the commit — and calls out a remote that fetches from one place and
    // pushes to another, which is the case a fetch-URL-only screen gets wrong.
    ...renderPublishPlan(state).trimEnd().split("\n"),
    "",
    `  base branch  ${request.base ?? "(repository default)"}`,
    `  commits      ${ahead} ahead of ${state.base.branch ?? "an unresolved base"}`,
    `  title        ${request.title}`,
    `  body         ${request.body.split("\n").join("\n               ")}`,
    // classifyVerification's own words. Nothing in this command re-words them,
    // and nothing in it can upgrade a stale or unknown reading to verified.
    `  verified     ${verification.status} — ${verification.reason}`,
    "",
    "  These 2 commands run, exactly as shown:",
    "",
  ];
  plannedCommands(state, request).forEach((command, index) => {
    lines.push(`  ${index + 1}.`);
    lines.push(renderArgvVector(command));
    lines.push("");
  });
  lines.push("  Each element above is one argv entry. No shell parses any of it.");
  lines.push("  This publishes one branch and opens a pull request.");
  lines.push("  It does not merge, it does not force-push, and it does not touch the base branch.");
  return lines.join("\n") + "\n";
}

// ── the command ─────────────────────────────────────────────────────────────

export async function runShip(_ctx: AppContext, deps: ShipDeps, flags: ShipFlags): Promise<number> {
  let state = readRepoState(deps.run, deps.cwd, flags.base ? { base: flags.base } : {});
  if (state.ok && !flags.base && !state.base.revision) {
    // A newly cloned checkout may have origin/main but no origin/HEAD symbolic
    // ref yet. Resolve an existing common base before requiring a bound draft.
    for (const candidate of ["main", "master"]) {
      const resolved = readRepoState(deps.run, deps.cwd, { base: candidate });
      if (resolved.ok && resolved.base.revision && resolved.head.branch !== candidate) { state = resolved; break; }
    }
  }
  if (!state.ok) {
    deps.out.write(`✗ ${state.reason}\n`);
    return 1;
  }
  // Decided before any screen is drawn, so a confirmation is never rendered for
  // an action that was never going to be allowed.
  const refusal = validatePublish(state);
  if (refusal) {
    deps.out.write(`✗ ${refusal}\n`);
    return 1;
  }
  const unmerged = state.files.filter((file) => file.unmerged).map((file) => file.path);
  if (unmerged.length) {
    deps.out.write(`✗ unresolved conflicts: ${unmerged.join(", ")} — resolve them before shipping\n`);
    return 1;
  }
  if (state.aheadOfBase === 0) {
    deps.out.write(
      `✗ ${state.head.branch} has no commits ${state.base.branch ?? "the base"} does not — nothing to open a pull request about\n`,
    );
    return 1;
  }

  const verification = classifyVerification(readVerification(state.root), treeIdentity(deps.run, state.root));
  const scope = getActiveGoal(state.root);
  let generated: PreparedPrDraft;
  let edited: PreparedPrDraft | undefined;
  try {
    generated = preparePrDraft(deps.run, state, verification, scope);
    if (flags.draftFile) {
      edited = readPreparedPrDraft(flags.draftFile);
      assertCurrentPrDraft(edited, generated);
    }
  } catch (error) {
    deps.out.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (flags.draft) {
    deps.out.write(JSON.stringify({ ...generated, title: flags.title ?? edited?.title ?? generated.title, body: flags.body ?? edited?.body ?? generated.body }, null, 2) + "\n");
    return 0;
  }

  const planned = planShip(state, {
    title: flags.title ?? edited?.title ?? generated.title,
    body: flags.body ?? edited?.body ?? generated.body,
    ...(flags.base ? { base: flags.base } : {}),
    // Only a verification that actually reads "verified" is stated on the pull
    // request. A stale or unknown reading is shown to the user on the screen
    // below, and is never turned into a claim in the PR body.
    ...(verification.status === "verified" ? { verification: verification.reason } : {}),
  });
  if ("ok" in planned) {
    deps.out.write(`✗ ${planned.reason}\n`);
    if (!flags.title) {
      deps.out.write(theme.dim("  give a title with --title or edit an exported PR draft.\n"));
    }
    return 1;
  }
  try {
    assertSafeGhArgv(prCreateArgs(planned));
  } catch (err) {
    deps.out.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (flags.json) {
    deps.out.write(
      JSON.stringify(
        {
          repo: planned.spec.full,
          head: planned.head,
          base: planned.base ?? null,
          remote: state.remote?.name ?? null,
          pushUrl: state.remote?.pushUrl ?? null,
          aheadOfBase: state.aheadOfBase,
          verification: { status: verification.status, reason: verification.reason },
          draftBinding: generated.binding,
          title: planned.title,
          body: planned.body,
          commands: plannedCommands(state, planned),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  deps.out.write(renderShipConfirm(state, planned, verification));
  if (state.files.length) {
    // Publishing pushes commits. Uncommitted work is in no commit, so it is not
    // going anywhere — said plainly rather than left to be discovered.
    deps.out.write(
      `\n  ${theme.yellow("note")} ${state.files.length} file(s) have uncommitted changes and are NOT included:\n` +
        state.files.map((file) => `    ${file.path}\n`).join(""),
    );
  }

  const approved =
    publishAutoApproved(flags) ||
    (await confirm(deps.io, "\nPublish this branch and open the pull request?", { default: false }));
  if (!approved) {
    deps.out.write("cancelled — nothing was published.\n");
    if (flags.yes && !flags.approve) {
      deps.out.write(
        theme.dim("  --yes does not approve publishing. Pass --approve publish to authorise it in a script.\n"),
      );
    }
    return 1;
  }

  // Approval was for this exact base/head and evidence. Re-read after the
  // prompt, before any push, so a changed branch cannot publish a stale draft.
  try {
    const freshState = readRepoState(deps.run, deps.cwd, { base: state.base.branch ?? undefined });
    if (!freshState.ok) throw new Error(freshState.reason);
    const freshVerification = classifyVerification(readVerification(freshState.root), treeIdentity(deps.run, freshState.root));
    assertCurrentPrDraft(generated, preparePrDraft(deps.run, freshState, freshVerification, getActiveGoal(freshState.root)));
  } catch (error) {
    deps.out.write(`✗ ${error instanceof Error ? error.message : String(error)} — nothing was published.\n`);
    return 1;
  }

  let record = bindShipRecord(state);
  if (record) {
    record = recordVerification(record, {
      status: verification.status,
      command: verification.record?.command ?? null,
      exitCode: verification.record?.exitCode ?? null,
    });
  }

  const published = publishHead(deps.run, state);
  if (!published.ok) {
    deps.out.write(`✗ push failed: ${published.reason}\n`);
    if (published.hint) deps.out.write(theme.dim(`  ${published.hint}\n`));
    return 1;
  }
  if (record) {
    record = recordPublished(record);
    writeShipRecord(record);
  }
  deps.out.write(`${theme.cyan("✔")} published ${published.branch} to ${published.remote}\n`);

  // gh runs in the repository root and inherits the user's own gh session. No
  // env is set here, and no Aether credential exists in this process to leak.
  const gh: Runner = (cmd, args) => deps.run(cmd, args, state.root);
  const opened = openPullRequest(planned, gh);
  if (!opened.ok) {
    deps.out.write(`✗ ${opened.reason}\n`);
    if (opened.hint) deps.out.write(theme.dim(`  ${opened.hint}\n`));
    // The branch IS published even though the pull request is not open. Saying
    // so is the difference between a user retrying safely and a user believing
    // nothing happened.
    deps.out.write(theme.dim("  the branch is published; only the pull request step failed.\n"));
    return 1;
  }
  if (record) {
    const withPr = recordPullRequest(record, opened.url);
    if (withPr) writeShipRecord(withPr);
  }
  deps.out.write(`${theme.cyan("✔")} PR opened: ${opened.url}\n`);
  if (process.env["AETHER_PROJECT_MEMORY_RECEIPTS_ENABLED"] === "1") {
    const { memoryFooter } = await import("../core/project_memory/receipt.js");
    deps.out.write((await memoryFooter(_ctx)) + "\n");
  }
  return 0;
}

export async function cmdShip(ctx: AppContext, _rest: string[], flags: ShipFlags): Promise<number> {
  return runShip(ctx, defaultShipDeps(ctx.flags.cwd, process.stdout), flags);
}

export const SHIP_SLASH_USAGE =
  'usage: /ship [--pr-draft] [--draft-file <path>] [--title <text>] [--body <text>] [--base <branch>] [--approve publish] [--yes] [--json] [--help]';

interface SlashWord { value: string; quoted: boolean }

/** Split REPL input into argv without invoking a shell or expanding any text. */
function shipSlashWords(input: string): SlashWord[] {
  const words: SlashWord[] = [];
  let value = "";
  let active = false;
  let quoted = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (char === "\\" && quote !== "'") {
      const next = input[index + 1];
      if (next === undefined) throw new Error("trailing escape");
      // Escapes quote characters, backslashes and whitespace. Other escapes
      // remain literal, including Windows paths and shell-looking text.
      if (next === "\\" || next === '"' || next === "'" || next === "$" || next === "`" || /\s/u.test(next) || (quote === null && next === "-")) {
        value += next;
        index++;
        quoted = true;
      } else {
        value += char;
      }
      active = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      else value += char;
      active = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
      active = true;
    } else if (/\s/u.test(char)) {
      if (active) words.push({ value, quoted });
      value = "";
      active = false;
      quoted = false;
    } else {
      value += char;
      active = true;
    }
  }
  if (quote !== null) throw new Error("unterminated quote");
  if (active) words.push({ value, quoted });
  return words;
}

/** Parse exactly the options `/ship` can pass to the shared ship rail. */
export function parseShipSlashArgs(arg: string): ShipFlags | "help" {
  const words = shipSlashWords(arg);
  const flags: ShipFlags = { yes: false, json: false };
  const seen = new Set<string>();
  const valued = new Set(["--title", "--body", "--base", "--approve", "--draft-file"]);
  const boolean = new Set(["--yes", "--json", "--help", "--pr-draft"]);
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    const equal = word.value.indexOf("=");
    const name = equal < 0 ? word.value : word.value.slice(0, equal);
    if (!name.startsWith("-") || (word.quoted && equal < 0)) throw new Error(`unexpected argument: ${word.value}`);
    if (!valued.has(name) && !boolean.has(name)) throw new Error(`unsupported option: ${name}`);
    if (seen.has(name)) throw new Error(`duplicate option: ${name}`);
    seen.add(name);
    if (boolean.has(name)) {
      if (equal >= 0) throw new Error(`${name} does not take a value`);
      if (name === "--yes") flags.yes = true;
      if (name === "--json") flags.json = true;
      if (name === "--pr-draft") flags.draft = true;
      continue;
    }
    const next = equal < 0 ? words[++index] : { value: word.value.slice(equal + 1), quoted: word.quoted };
    if (!next || !next.value.trim() || (equal < 0 && next.value.startsWith("-") && !next.quoted)) {
      throw new Error(`${name} needs a value`);
    }
    if (name === "--title") flags.title = next.value;
    if (name === "--body") flags.body = next.value;
    if (name === "--base") flags.base = next.value;
    if (name === "--approve") flags.approve = next.value;
    if (name === "--draft-file") flags.draftFile = next.value;
  }
  if (seen.has("--help")) {
    if (seen.size !== 1) throw new Error("--help must be used alone");
    return "help";
  }
  return flags;
}

/** `/ship` inside the REPL. The optional deps also keep wrapper tests offline. */
export async function shipSlash(ctx: AppContext, out: Writable, arg: string, deps?: ShipDeps): Promise<void> {
  let flags: ShipFlags | "help";
  try {
    flags = parseShipSlashArgs(arg);
  } catch (error) {
    out.write(`✗ ${error instanceof Error ? error.message : String(error)}\n${SHIP_SLASH_USAGE}\n`);
    return;
  }
  if (flags === "help") {
    out.write(`${SHIP_SLASH_USAGE}\n`);
    return;
  }
  await runShip(ctx, deps ?? defaultShipDeps(ctx.flags.cwd, out), flags);
}

/**
 * The tail of a `--repo` agent run.
 *
 * Replaces the printed `prCreateHint` with an actual offer: on a terminal it
 * asks, and on a yes it runs the same rail `aether ship` runs. A pipe/CI run
 * still gets a line it can act on, but the command it names now exists.
 */
export async function offerShip(
  ctx: AppContext,
  out: Writable,
  spec: RepoSpec,
  /** The run's isolated worktree — NOT ctx.flags.cwd, which is the mirror. */
  dir: string,
  branch: string,
): Promise<void> {
  const deps = defaultShipDeps(dir, out);
  const byHand = `  open a pull request:  cd ${dir} && aether ship   (branch ${branch} → ${spec.full})\n`;
  if (!deps.io.tty || ctx.flags.json) {
    out.write(byHand);
    return;
  }
  const wanted = await confirm(deps.io, `\nOpen a pull request for ${branch}?`, { default: false });
  if (!wanted) {
    out.write(byHand);
    return;
  }
  await runShip(ctx, deps, { yes: false, json: false });
}
