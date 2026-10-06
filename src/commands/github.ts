// `aether github <status|connect|disconnect|pr|checks|ci|workflow|action>`
//
// Two halves, one command tree, and the boundary between them is the point of
// this file:
//
//   status / connect / disconnect — link your GitHub account to Aether.
//     Unchanged. The web-canonical install flow: connect opens the GitHub App
//     install page in your browser, you pick repos and approve, the CLI polls
//     until it lands. No GitHub token is ever stored locally.
//
//   pr / checks / ci / workflow / action — the Cloud Action Rail.
//     ALWAYS Aether Cloud custody: the backend's GitHub App, a just-in-time
//     token scoped to one repository, and an ActionRun that leaves a receipt.
//     Nothing here invokes a local `gh` binary or touches your own GitHub
//     session, and there is no fallback between the two — a silent fallback is
//     how someone believes they published under one identity and actually
//     published under another.
//
// Mutations follow prepare -> preview -> approve -> execute -> receipt. You
// cannot execute one without the exact stored plan AND that action's exact
// approval phrase. `--yes` is not authority here, and deliberately still isn't.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { AppContext } from "../core/context.js";
import { openBrowser } from "../core/browser.js";
import { fail as coreFail, errorMessage } from "../core/errors.js";
import {
  getGithubStatus,
  startGithubConnect,
  disconnectGithub,
  pollUntilConnected,
  type GithubStatus,
} from "../core/github.js";
import {
  ACTION_APPROVALS,
  EXIT_OK,
  EXIT_USAGE,
  RailRefusal,
  type ActionPlan,
  checkApproval,
  envelope,
  execute as railExecute,
  exitCodeFor,
  getAction,
  getPullRequest,
  listChecks,
  listPullRequests,
  prepare as railPrepare,
  renderPlan,
  renderReceipt,
} from "../core/action_rail.js";
import { publishActionReceipt } from "../core/rc/action_receipts.js";
import { projectRefFor, rcOutboxPath } from "./rc.js";

export interface GithubOpts {
  noBrowser?: boolean;
  json?: boolean;
}

/** A PR body may be long, but it is not unbounded. */
const MAX_BODY_BYTES = 60_000;

export async function cmdGithub(
  ctx: AppContext,
  argv: string[],
  opts: GithubOpts = {},
): Promise<number> {
  const sub = (argv[0] ?? "status").toLowerCase();
  switch (sub) {
    case "status":
      return githubStatus(ctx);
    case "connect":
      return githubConnect(ctx, opts);
    case "disconnect":
      return githubDisconnect(ctx);
    case "pr":
      return railPr(ctx, argv.slice(1), opts);
    case "checks":
      return railChecks(ctx, argv.slice(1), opts);
    case "ci":
      return railCi(ctx, argv.slice(1), opts);
    case "workflow":
      return railWorkflow(ctx, argv.slice(1), opts);
    case "action":
      return railAction(ctx, argv.slice(1), opts);
    case "help":
      printGithubHelp();
      return EXIT_OK;
    default:
      process.stderr.write(`unknown: aether github ${sub}\n`);
      printGithubHelp();
      return EXIT_USAGE;
  }
}

function printGithubHelp(): void {
  process.stdout.write(
    [
      "Account link (local):",
      "  aether github status      Show whether your GitHub account is linked",
      "  aether github connect     Link GitHub (opens the App install page in your browser)",
      "  aether github disconnect  Unlink GitHub (uninstalls the App)",
      "",
      "Cloud actions (Aether Cloud custody — the backend's GitHub App, never your local gh):",
      "  aether github pr list --repo <owner/name>",
      "  aether github pr view <number> --repo <owner/name>",
      "  aether github pr prepare --repo <owner/name> --head <ref> [--base <ref>]",
      "                           --title <text> --body-file <path> [--draft]",
      "  aether github pr create --plan <plan_id> --approve create-draft-pr",
      "  aether github pr update --plan <plan_id> --approve update-pr",
      "  aether github checks --repo <owner/name> --pr <number>",
      "  aether github ci rerun --plan <plan_id> --approve rerun-failed-checks",
      "  aether github workflow dispatch --plan <plan_id> --approve dispatch-workflow",
      "  aether github action view <action_id>",
      "",
      "Mutations require the exact plan and that action's exact --approve value.",
      "This tree cannot merge, force-push, push to a base branch, delete branches,",
      "administer a repository, or read or write secrets.",
      "",
    ].join("\n"),
  );
}

// --- account link (unchanged) ----------------------------------------------

function renderStatus(s: GithubStatus): string {
  if (!s.connected) return "GitHub: not linked.\n  Run: aether github connect\n";
  const scope = s.repo_selection === "all" ? "all repos" : "selected repos";
  const who = s.login ? ` (${s.login}${s.account_type ? `, ${s.account_type}` : ""})` : "";
  return `GitHub: ✓ linked${who}\n  scope: ${scope}\n`;
}

async function githubStatus(ctx: AppContext): Promise<number> {
  try {
    const s = await getGithubStatus(ctx.api);
    process.stdout.write(renderStatus(s));
    return s.connected ? 0 : 1;
  } catch (err) {
    return coreFail(err, "are you logged in? run: aether auth login");
  }
}

async function githubConnect(ctx: AppContext, opts: GithubOpts): Promise<number> {
  let installUrl: string;
  try {
    installUrl = await startGithubConnect(ctx.api);
  } catch (err) {
    process.stderr.write(`✗ could not start GitHub connect: ${errorMessage(err)}\n`);
    return 1;
  }
  process.stdout.write(`\nTo link GitHub, open:\n  ${installUrl}\n\n`);
  if (!opts.noBrowser) openBrowser(installUrl);
  process.stdout.write("Pick your repos and approve in the browser…\n");
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  try {
    const s = await pollUntilConnected(ctx.api, sleep);
    process.stdout.write(`✓ GitHub linked${s.login ? ` (${s.login})` : ""}.\n`);
    return 0;
  } catch (err) {
    return coreFail(err);
  }
}

async function githubDisconnect(ctx: AppContext): Promise<number> {
  try {
    await disconnectGithub(ctx.api);
    process.stdout.write("GitHub unlinked.\n");
    return 0;
  } catch (err) {
    return coreFail(err);
  }
}

// --- flag parsing -----------------------------------------------------------

const VALUELESS_FLAGS = new Set(["draft", "json", "yes", "y", "watch"]);

/**
 * Parse `--name value` pairs into typed data.
 *
 * A value is taken verbatim, whatever it looks like. `--title --force` yields
 * the string "--force", not a flag: the caller asked for a title and a title is
 * what they get. Nothing downstream re-parses it, so a value containing
 * newlines, quotes, `$(...)`, or a Windows path stays an inert string in a JSON
 * body. Same reason src/core/review_actions.ts refuses raw path strings — a
 * crafted value should be an impossible input, not a sanitising problem.
 */
export function parseFlags(argv: string[]): {
  flags: Record<string, string>;
  bools: Set<string>;
  positional: string[];
} {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (VALUELESS_FLAGS.has(name)) {
      bools.add(name);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined) {
      // A trailing `--title` with nothing after it is a usage error, not an
      // empty title. Recorded empty so the caller reports it explicitly.
      flags[name] = "";
      continue;
    }
    flags[name] = next;
    index += 1;
  }
  return { flags, bools, positional };
}

export function planCommandHint(actionType: string): string {
  switch (actionType) {
    case "aether.github.pr.create":
      return "pr create";
    case "aether.github.pr.update":
      return "pr update";
    case "aether.github.ci.rerun_failed":
      return "ci rerun";
    case "aether.github.workflow.dispatch":
      return "workflow dispatch";
    default:
      return "action view";
  }
}

function readBodyFile(path: string): string {
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw new RailRefusal(
      "INVALID_ARGUMENT",
      `--body-file exceeds ${MAX_BODY_BYTES} bytes`,
      EXIT_USAGE,
    );
  }
  return raw;
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (value === undefined || value === "") {
    throw new RailRefusal("INVALID_ARGUMENT", `--${name} is required`, EXIT_USAGE);
  }
  return value;
}

function projectId(ctx: AppContext, flags: Record<string, string>): string {
  const explicit = flags["project"];
  if (explicit) return explicit;
  const fromCtx = (ctx as unknown as { projectId?: string }).projectId;
  if (fromCtx) return fromCtx;
  throw new RailRefusal(
    "INVALID_ARGUMENT",
    "--project <project_id> is required (no project bound to this session)",
    EXIT_USAGE,
  );
}

function emit(opts: GithubOpts, human: string, machine: object): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(machine)}\n`);
    return;
  }
  process.stdout.write(human);
}

function emitRefusal(
  opts: GithubOpts,
  command: string,
  refusal: RailRefusal,
  plan: ActionPlan | null,
): number {
  const machine = envelope({
    command,
    status:
      refusal.code === "AUTH_ASSURANCE_REQUIRED" ? "authorization_required" : "error",
    plan,
    error: {
      schema: "aether.error/1",
      code: refusal.code,
      message: refusal.message,
      retryable: false,
    },
  });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(machine)}\n`);
  } else {
    if (plan) process.stdout.write(renderPlan(plan));
    process.stderr.write(`✗ ${refusal.message}\n`);
  }
  return refusal.exitCode;
}

/** Turn any thrown value into a stable exit, never a stack trace on stdout. */
function handleThrown(opts: GithubOpts, command: string, err: unknown): number {
  if (err instanceof RailRefusal) return emitRefusal(opts, command, err, null);
  const body = err as { code?: string } | undefined;
  const code = typeof body?.code === "string" ? body.code : "PROVIDER_UNAVAILABLE";
  const refusal = new RailRefusal(code, errorMessage(err), exitCodeFor(code));
  return emitRefusal(opts, command, refusal, null);
}

// --- rail: reads ------------------------------------------------------------

async function railPr(
  ctx: AppContext,
  argv: string[],
  opts: GithubOpts,
): Promise<number> {
  const action = (argv[0] ?? "list").toLowerCase();
  const { flags, bools, positional } = parseFlags(argv.slice(1));
  try {
    switch (action) {
      case "list": {
        const data = await listPullRequests(ctx.api, {
          project_id: projectId(ctx, flags),
          repository: requireFlag(flags, "repo"),
        });
        emit(
          opts,
          `${JSON.stringify(data, null, 2)}\n`,
          envelope({ command: "github.pr.list", data }),
        );
        return EXIT_OK;
      }
      case "view": {
        const number = Number(positional[0]);
        if (!Number.isInteger(number) || number < 1) {
          throw new RailRefusal(
            "INVALID_ARGUMENT",
            "pull request number is required",
            EXIT_USAGE,
          );
        }
        const data = await getPullRequest(ctx.api, {
          project_id: projectId(ctx, flags),
          repository: requireFlag(flags, "repo"),
          number,
        });
        emit(
          opts,
          `${JSON.stringify(data, null, 2)}\n`,
          envelope({ command: "github.pr.get", data }),
        );
        return EXIT_OK;
      }
      case "prepare":
        return doPrepare(ctx, "aether.github.pr.create", flags, bools, opts);
      case "create":
        return doExecute(ctx, flags, opts, "github.pr.create");
      case "update":
        return doExecute(ctx, flags, opts, "github.pr.update");
      default:
        process.stderr.write(`unknown: aether github pr ${action}\n`);
        return EXIT_USAGE;
    }
  } catch (err) {
    return handleThrown(opts, `github.pr.${action}`, err);
  }
}

async function railChecks(
  ctx: AppContext,
  argv: string[],
  opts: GithubOpts,
): Promise<number> {
  const { flags } = parseFlags(argv);
  try {
    const number = Number(requireFlag(flags, "pr"));
    if (!Number.isInteger(number) || number < 1) {
      throw new RailRefusal(
        "INVALID_ARGUMENT",
        "--pr must be a pull request number",
        EXIT_USAGE,
      );
    }
    const data = await listChecks(ctx.api, {
      project_id: projectId(ctx, flags),
      repository: requireFlag(flags, "repo"),
      number,
    });
    emit(
      opts,
      `${JSON.stringify(data, null, 2)}\n`,
      envelope({ command: "github.checks.list", data }),
    );
    return EXIT_OK;
  } catch (err) {
    return handleThrown(opts, "github.checks.list", err);
  }
}

async function railCi(
  ctx: AppContext,
  argv: string[],
  opts: GithubOpts,
): Promise<number> {
  const action = (argv[0] ?? "").toLowerCase();
  const { flags, bools } = parseFlags(argv.slice(1));
  try {
    if (action === "prepare") {
      return doPrepare(ctx, "aether.github.ci.rerun_failed", flags, bools, opts);
    }
    if (action === "rerun") {
      return doExecute(ctx, flags, opts, "github.ci.rerun");
    }
    process.stderr.write(`unknown: aether github ci ${action}\n`);
    return EXIT_USAGE;
  } catch (err) {
    return handleThrown(opts, `github.ci.${action}`, err);
  }
}

async function railWorkflow(
  ctx: AppContext,
  argv: string[],
  opts: GithubOpts,
): Promise<number> {
  const action = (argv[0] ?? "").toLowerCase();
  const { flags, bools } = parseFlags(argv.slice(1));
  try {
    if (action === "prepare") {
      return doPrepare(ctx, "aether.github.workflow.dispatch", flags, bools, opts);
    }
    if (action === "dispatch") {
      return doExecute(ctx, flags, opts, "github.workflow.dispatch");
    }
    process.stderr.write(`unknown: aether github workflow ${action}\n`);
    return EXIT_USAGE;
  } catch (err) {
    return handleThrown(opts, `github.workflow.${action}`, err);
  }
}

async function railAction(
  ctx: AppContext,
  argv: string[],
  opts: GithubOpts,
): Promise<number> {
  const action = (argv[0] ?? "view").toLowerCase();
  const { positional } = parseFlags(argv.slice(1));
  try {
    if (action !== "view" && action !== "watch") {
      process.stderr.write(`unknown: aether github action ${action}\n`);
      return EXIT_USAGE;
    }
    const actionId = positional[0];
    if (!actionId) {
      throw new RailRefusal("INVALID_ARGUMENT", "action id is required", EXIT_USAGE);
    }
    const data = await getAction(ctx.api, actionId);
    emit(
      opts,
      `${JSON.stringify(data, null, 2)}\n`,
      envelope({ command: `github.action.${action}`, data }),
    );
    return EXIT_OK;
  } catch (err) {
    return handleThrown(opts, `github.action.${action}`, err);
  }
}

// --- rail: prepare and execute ---------------------------------------------

async function doPrepare(
  ctx: AppContext,
  actionType: string,
  flags: Record<string, string>,
  bools: Set<string>,
  opts: GithubOpts,
): Promise<number> {
  const inputs: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(flags)) {
    if (name === "project" || name === "body-file") continue;
    inputs[name.replace(/-/g, "_")] = value;
  }
  if (flags["body-file"]) inputs["body"] = readBodyFile(flags["body-file"]);
  if (bools.has("draft")) inputs["draft"] = true;

  const plan = await railPrepare(ctx.api, {
    project_id: projectId(ctx, flags),
    action_type: actionType,
    inputs,
  });

  emit(
    opts,
    `${renderPlan(plan)}\nTo run it:\n  aether github ${planCommandHint(actionType)} ` +
      `--plan ${plan.plan_id} --approve ${ACTION_APPROVALS[actionType]}\n\n`,
    envelope({
      command: "github.pr.prepare",
      status: "prepared",
      project_id: plan.project_id,
      plan,
    }),
  );
  return EXIT_OK;
}

async function doExecute(
  ctx: AppContext,
  flags: Record<string, string>,
  opts: GithubOpts,
  command: string,
): Promise<number> {
  const planId = requireFlag(flags, "plan");
  // Re-read the stored plan rather than trusting anything passed alongside
  // --plan. The approval binds the SERVER's bytes; a caller-supplied digest
  // would let the two disagree about what is being approved.
  const plan = (await getAction(ctx.api, planId)) as ActionPlan;

  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const refusal = checkApproval(plan, flags["approve"], { interactive });
  if (refusal) return emitRefusal(opts, command, refusal, plan);

  const result = await railExecute(ctx.api, {
    plan_id: plan.plan_id,
    action_digest: plan.action_digest,
    approve: flags["approve"]!,
  });

  emit(
    opts,
    renderReceipt(result.receipt),
    envelope({
      command,
      status: "executed",
      project_id: plan.project_id,
      plan,
      receipt: result.receipt,
    }),
  );
  publishReceiptToRc(ctx, plan, result.receipt);
  return EXIT_OK;
}

/**
 * The receipt hook for an active RC session (#220). Runs after the receipt is
 * printed, queues the CI/PR projection durably and starts its upload without
 * awaiting it: a viewer can never delay or change a Cloud action's result.
 */
function publishReceiptToRc(ctx: AppContext, plan: ActionPlan, receipt: unknown): void {
  try {
    const root = resolve(ctx.flags.cwd);
    publishActionReceipt(ctx.api, root, rcOutboxPath(projectRefFor(root)), receipt, plan);
  } catch {
    // RC publication is best-effort by contract.
  }
}
