// worktree.ts — two complementary worktree flows that both isolate a coding
// run in a fresh `git worktree`, for different entry points:
//
//  1. Flag-driven (createWorktree / worktreeBranch / mergeHint): `aether agent
//     --worktree "<task>"` (or --repo, which implies it). One flag, zero
//     ceremony — throws with an actionable message on failure. Worktrees live
//     under worktreesRoot(), OUTSIDE the repo, so they never pollute
//     `git status`.
//
//  2. Gate-driven (createGatedWorktree + the gh helpers): the 2.0 "are you
//     working in this repo?" confirm gate (commands/code_support.ts owns the
//     prompt). When `gh` is authenticated, the gate upgrades itself to a real
//     isolated worktree on a fresh `aether/<slug>` branch automatically —
//     no flag required. Every external process call goes through an injected
//     Runner so this half is unit-testable with a fake and can avoid ALL side
//     effects in non-interactive (pipe / CI / test) runs. Also owns the local
//     gh<->Aether account-link record (configDir()/gh-link.json); the
//     server-side bind is the website's job and is deliberately not
//     fabricated here.
//
// Both flows share slugify() (one branch-naming convention: `aether/<slug>`)
// but otherwise don't overlap, so they're kept in one file rather than two
// near-identical ones.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { configDir } from "./config.js";

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run an external command (argv form, no shell — safe with spaces in paths). */
export type Runner = (cmd: string, args: string[], cwd?: string) => RunResult;

/** Default runner over spawnSync. ENOENT (binary missing) reads as status 127. */
export function defaultRunner(): Runner {
  return (cmd, args, cwd) => {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
    if (r.error) return { status: 127, stdout: "", stderr: String(r.error) };
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

// ── gh authentication ───────────────────────────────────────────────────────
export interface GhStatus {
  /** Is `gh` installed AND logged in? */
  authed: boolean;
  /** The GitHub login, when it can be parsed from `gh auth status`. */
  user?: string;
  /** The host (github.com or an enterprise host), when parseable. */
  host?: string;
}

/**
 * Probe `gh auth status`. Exit 0 = authenticated. We parse the login + host from
 * the human-readable output (stderr on most gh versions), tolerating both the
 * modern "account <user>" and older "as <user>" phrasings. Never throws.
 */
export function ghAuthStatus(run: Runner): GhStatus {
  const r = run("gh", ["auth", "status"]);
  if (r.status !== 0) return { authed: false };
  const text = `${r.stdout}\n${r.stderr}`;
  const user = /\baccount\s+(\S+)/i.exec(text)?.[1] ?? /\bas\s+(\S+)/i.exec(text)?.[1];
  const host = /Logged in to (\S+)/i.exec(text)?.[1];
  const status: GhStatus = { authed: true };
  if (user) status.user = user;
  if (host) status.host = host;
  return status;
}

// ── git repo probing ─────────────────────────────────────────────────────────
/** Is `cwd` inside a git work tree? */
export function isGitRepo(run: Runner, cwd: string): boolean {
  const r = run("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], cwd);
  return r.status === 0 && r.stdout.trim() === "true";
}

/** The repo's top-level directory, or null if `cwd` is not in a git repo. */
export function repoRoot(run: Runner, cwd: string): string | null {
  const r = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], cwd);
  if (r.status !== 0) return null;
  const top = r.stdout.trim();
  return top.length ? top : null;
}

// ── slug ─────────────────────────────────────────────────────────────────────
/** Turn a free-text task into a short, branch-safe slug. Deterministic + pure.
 *  Shared by both worktree flows below — one branch-naming convention. */
export function slugify(task: string, max = 32): string {
  const s = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return s || "task";
}

// ── flow 1: flag-driven worktree (--worktree / --repo) ─────────────────────
export interface Worktree {
  /** Absolute path the agent runs in (the new worktree). */
  dir: string;
  /** The new branch checked out there. */
  branch: string;
  /** The repo the worktree was cut from. */
  repoRoot: string;
}

/** Where flag-driven worktrees are parked. Override with AETHER_WORKTREES_DIR
 *  (tests). Deliberately OUTSIDE the repo so they never dirty `git status`. */
export function worktreesRoot(): string {
  const base = process.env["AETHER_WORKTREES_DIR"];
  return base ?? join(homedir(), ".aether-agent", "worktrees");
}

/** Build the auto branch name: `aether/<slug>-<id>`. Pure (id injected). */
export function worktreeBranch(task: string, id: string): string {
  return `aether/${slugify(task)}-${id}`;
}

/** git args to add a worktree on a new branch off current HEAD. Pure. */
export function worktreeAddArgs(
  repoRoot: string,
  branch: string,
  dir: string,
  startRevision?: string,
): string[] {
  // git fetch updates remote refs and FETCH_HEAD; it does NOT move the mirror's
  // checked-out HEAD. Without an explicit start point, `worktree add` branches
  // off whatever the mirror already had — which can be days behind the tip the
  // run just reported fetching. The revision goes last: git reads the final
  // positional as the start point.
  const argv = ["-C", repoRoot, "worktree", "add", "-b", branch, dir];
  return startRevision ? [...argv, startRevision] : argv;
}

/** Resolve the repo root for `cwd`, or null if not inside a git repo.
 *  Thin wrapper over repoRoot()/defaultRunner() — flow 1 doesn't take an
 *  injected Runner (see the file header), so it can't call repoRoot() directly. */
export function repoRootOf(cwd: string): string | null {
  return repoRoot(defaultRunner(), cwd);
}

/**
 * Create a worktree for `task` off `cwd`'s repo. Returns the worktree to run in.
 * Throws with an actionable message if `cwd` isn't a git repo or git fails.
 * `id` is injected (default: short base-36 timestamp) so tests are deterministic.
 */
export function createWorktree(cwd: string, task: string, id?: string, startRevision?: string): Worktree {
  const repoRoot = repoRootOf(cwd);
  if (!repoRoot) {
    throw new Error("--worktree needs a git repo (run `git init` first, or drop the flag)");
  }
  const safeId = id ?? Date.now().toString(36);
  const branch = worktreeBranch(task, safeId);
  const dir = join(worktreesRoot(), branch.replace(/\//g, "-"));
  const r = spawnSync("git", worktreeAddArgs(repoRoot, branch, dir, startRevision), { encoding: "utf8" });
  if (r.status !== 0) {
    const why = ((r.stderr ?? "") + (r.stdout ?? "")).trim() || "git worktree add failed";
    throw new Error(`could not create worktree: ${why}`);
  }
  return { dir, branch, repoRoot };
}

/** One-line "what now" footer shown after a --worktree/--repo run. Pure. */
export function mergeHint(wt: Worktree): string {
  return (
    `\n  worktree: ${wt.dir}  (branch ${wt.branch})\n` +
    `  merge it:   git -C ${wt.repoRoot} merge ${wt.branch}\n` +
    `  discard it: git -C ${wt.repoRoot} worktree remove ${wt.dir} && git -C ${wt.repoRoot} branch -D ${wt.branch}\n`
  );
}

// ── flow 2: gate-driven worktree (the 2.0 repo-confirm gate) ───────────────
/** Where gate-driven worktrees live — OUTSIDE the repo, so they never dirty it.
 *  Kept separate from worktreesRoot() (flow 1) since this half is gh-gated and
 *  namespaced under the Aether config dir rather than the home dir directly. */
export function worktreeBase(): string {
  return join(configDir(), "worktrees");
}

export interface WorktreeResult {
  ok: boolean;
  /** Absolute path of the new worktree (when ok). */
  path?: string;
  /** The branch checked out in it, e.g. "aether/fix-tests" (when ok). */
  branch?: string;
  /** Failure detail (when !ok). */
  error?: string;
}

/**
 * Create a real isolated worktree for `root` on a fresh `aether/<slug>` branch,
 * for the gh-gated repo-confirm flow (code_support.ts's prepareWorkspace()).
 * Never throws — unlike flow 1's createWorktree(), a failure is returned to
 * the caller, which aborts the coding command. The worktree lives under
 * worktreeBase(). On a branch/path collision it retries with a numeric suffix.
 */
export function createGatedWorktree(
  run: Runner,
  root: string,
  slug: string,
  base: string = worktreeBase(),
): WorktreeResult {
  try {
    mkdirSync(base, { recursive: true });
  } catch (err) {
    return { ok: false, error: `cannot create worktree base: ${String(err)}` };
  }
  const repoName = basename(root) || "repo";
  let lastErr = "";
  for (let n = 0; n < 5; n++) {
    const suffix = n === 0 ? slug : `${slug}-${n + 1}`;
    const branch = `aether/${suffix}`;
    const path = join(base, `${repoName}-${suffix}`);
    if (existsSync(path)) {
      lastErr = `path exists: ${path}`;
      continue;
    }
    const r = run("git", ["-C", root, "worktree", "add", path, "-b", branch]);
    if (r.status === 0) return { ok: true, path, branch };
    lastErr = (r.stderr || r.stdout || `git exited ${r.status}`).trim();
  }
  return { ok: false, error: lastErr || "could not create worktree" };
}

// ── gh <-> Aether account link (local record) ─────────────────────────────────
export interface GhLink {
  gh_user: string;
  host: string;
  linked_at: string;
}

/** Path of the local link record. */
export function ghLinkPath(): string {
  return join(configDir(), "gh-link.json");
}

/**
 * Record (locally) which GitHub account is linked to this Aether terminal session.
 * Best-effort: a write failure is swallowed (linking is a convenience, never a
 * gate). The server-side bind to the Aether account is performed by the website
 * during `gh auth` consent and is intentionally not invented here.
 */
export function linkGhAccount(
  user: string,
  host = "github.com",
  now: () => string = () => new Date().toISOString(),
): GhLink | null {
  const link: GhLink = { gh_user: user, host, linked_at: now() };
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(ghLinkPath(), JSON.stringify(link, null, 2) + "\n", "utf8");
    return link;
  } catch {
    return null;
  }
}

/** Read the local gh<->Aether link record, or null if none / unreadable. */
export function readGhLink(): GhLink | null {
  try {
    const raw = readFileSync(ghLinkPath(), "utf8");
    const obj = JSON.parse(raw) as Partial<GhLink>;
    if (obj && typeof obj.gh_user === "string") {
      return { gh_user: obj.gh_user, host: obj.host ?? "github.com", linked_at: obj.linked_at ?? "" };
    }
  } catch {
    /* no record / unreadable — not linked */
  }
  return null;
}
