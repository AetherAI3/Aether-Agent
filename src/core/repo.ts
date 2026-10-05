// Repo target — `aether agent --repo owner/name "<task>"`. Brings one of the
// user's GitHub repos local so an agent run (cloud-brain UVT-metered, or local)
// can work on it in an isolated worktree, Claude-Code style.
//
// Auth is the USER'S OWN GitHub auth, never a token from our backend: we shell
// `gh repo clone` (honours `gh auth login` / a gh PAT / GH_TOKEN), falling back
// to `git clone` (git credential manager) when the gh CLI isn't installed. No
// GitHub token ever leaves the Aether backend for this path. The Aether API
// only meters the cloud brain's reasoning (UVT); the repo bytes stay between
// the user's machine and GitHub.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultRunner, type Runner } from "./worktree.js";

export interface RepoSpec {
  owner: string;
  name: string;
  /** "owner/name" */
  full: string;
}

/** Parse "owner/name" or a github URL into a RepoSpec. Pure. Throws on junk. */
export function parseRepoSpec(spec: string): RepoSpec {
  const cleaned = spec
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "");
  const m = cleaned.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
  if (!m) throw new Error(`invalid repo "${spec}" — expected owner/name`);
  // The charset above still admits a leading "-" (parsed as a flag when handed to
  // gh/git as an argv element) and the path segments "."/"..". Reject both so a
  // crafted spec can't inject an option or a surprising path into the clone argv.
  const unsafe = (seg: string): boolean => seg.startsWith("-") || seg === "." || seg === "..";
  if (unsafe(m[1]!) || unsafe(m[2]!)) {
    throw new Error(`invalid repo "${spec}" — owner/name may not start with '-' or be '.'/'..'`);
  }
  return { owner: m[1]!, name: m[2]!, full: `${m[1]}/${m[2]}` };
}

/** Is the gh CLI on PATH? */
export function ghAvailable(): boolean {
  const r = spawnSync("gh", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

/**
 * Encode each segment separately so punctuation and case remain distinct on
 * both case-sensitive and case-insensitive filesystems. The prefix also keeps
 * Windows device names and trailing dots out of path components.
 */
function mirrorSegment(segment: string): string {
  return `x${Buffer.from(segment, "utf8").toString("hex")}`;
}

/** Local mirror dir for a new repo: ~/.aether-agent/repos/v2/<owner>/<name>. */
export function localMirrorDir(spec: RepoSpec, reposDir = join(homedir(), ".aether-agent", "repos")): string {
  return join(reposDir, "v2", mirrorSegment(spec.owner), mirrorSegment(spec.name));
}

/** Keep an existing flat mirror in place only when its origin identifies this repo. */
function mirrorDirFor(spec: RepoSpec, run: Runner, reposDir: string): string {
  const legacy = join(reposDir, `${spec.owner}-${spec.name}`);
  if (!existsSync(join(legacy, ".git"))) {
    return localMirrorDir(spec, reposDir);
  }
  const remote = run("git", ["-C", legacy, "remote", "get-url", "origin"]);
  if (remote.status !== 0) {
    throw new Error(`could not validate the origin of local mirror at ${legacy}: ${remote.stderr.trim() || "git remote get-url origin failed"}`);
  }
  let actual: string;
  try {
    actual = parseRepoSpec(remote.stdout.trim()).full;
  } catch {
    throw new Error(`local mirror at ${legacy} does not point at ${spec.full} — its origin is "${remote.stdout.trim()}"`);
  }
  return actual === spec.full ? legacy : localMirrorDir(spec, reposDir);
}

/** gh/git clone argv for a repo into `dir`. Pure (testable). */
export function cloneArgs(spec: RepoSpec, dir: string, useGh: boolean): { cmd: string; args: string[] } {
  return useGh
    ? { cmd: "gh", args: ["repo", "clone", spec.full, dir] }
    : { cmd: "git", args: ["clone", `https://github.com/${spec.full}.git`, dir] };
}

export interface RepoCheckout {
  /** How current the mirror is. Never assumed — always measured or reported unknown. */
  freshness: MirrorFreshness;
  /** Local git dir for the repo (the mirror). */
  dir: string;
  /** True when this call performed the clone (vs reusing an existing mirror). */
  cloned: boolean;
}

/**
 * Ensure the repo is cloned locally (using the user's gh/git auth) and return
 * its dir. Reuses an existing mirror. Throws with an actionable message on a
 * clone failure (private repo + no auth is the common case).
 */
export function ensureLocalClone(
  spec: RepoSpec,
  run: Runner = defaultRunner(),
  reposDir = join(homedir(), ".aether-agent", "repos"),
): RepoCheckout {
  const dir = mirrorDirFor(spec, run, reposDir);
  // A mirror that already exists is validated and fetched before anything
  // branches off it. Reusing it on the strength of its path alone is how a
  // task silently starts from a days-old tip.
  if (existsSync(join(dir, ".git"))) {
    const { freshness } = refreshMirror(spec, dir, run, { exists: true });
    return { dir, cloned: false, freshness };
  }
  const useGh = ghAvailable();
  const { cmd, args } = cloneArgs(spec, dir, useGh);
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) {
    const why = ((r.stderr ?? "") + (r.stdout ?? "")).trim() || `${cmd} clone failed`;
    const hint = useGh
      ? "check `gh auth status` (run `gh auth login`)"
      : "gh CLI not found — install it or set up git credentials for github.com";
    throw new Error(`could not clone ${spec.full}: ${why}\n  ${hint}`);
  }
  // A clone just came from the remote, so its tip is the remote tip by
  // construction. Read it back rather than asserting it.
  const tip = run("git", ["-C", dir, "rev-parse", "HEAD"]);
  return {
    dir,
    cloned: true,
    freshness: {
      state: "fresh",
      remoteTip: tip.status === 0 ? tip.stdout.trim() || null : null,
      checkedAt: new Date().toISOString(),
    },
  };
}


/** How current a local mirror is, relative to its GitHub remote. */
export type MirrorFreshnessState = "fresh" | "stale" | "unknown";

export interface MirrorFreshness {
  state: MirrorFreshnessState;
  /** Commit the remote default branch resolved to, when the fetch succeeded. */
  remoteTip: string | null;
  checkedAt: string;
  /** Why the state is not "fresh". Present whenever it is not. */
  reason?: string;
}

export interface MirrorResult {
  dir: string;
  freshness: MirrorFreshness;
}

/** `ls-remote --symref origin HEAD` is the remote's advertised default, not a local ref. */
function advertisedDefault(output: string): { branch: string; tip: string } | null {
  const branch = output.match(/^ref: (refs\/heads\/[^\t\r\n]+)\tHEAD$/m)?.[1];
  const tip = output.match(/^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})\tHEAD$/m)?.[1];
  return branch && tip ? { branch, tip: tip.toLowerCase() } : null;
}

/**
 * Validate and refresh an existing mirror before anything branches off it.
 *
 * Three properties this function exists to guarantee:
 *
 *  1. The directory really is the repo that was asked for. The mirror path is
 *     derived from the slug alone, so any directory sitting at that path would
 *     otherwise be accepted as "octocat/hello-world" on the strength of its name.
 *  2. The mirror is fetched, so a task worktree does not branch off a tip that
 *     was current days ago.
 *  3. When step 2 cannot happen — offline, auth expired, remote gone — the
 *     result says so. It never degrades to "fresh" as a convenience.
 *
 * Read-only with respect to the user's working tree: it fetches into the object
 * store and reads refs. It never checks out, resets, merges, pulls or cleans.
 *
 * Auth is the user's own git/gh configuration, inherited from the environment.
 * No Aether credential is passed, and none is available to this function.
 */
export function refreshMirror(
  spec: RepoSpec,
  dir: string,
  run: Runner,
  options: { exists: boolean; now?: string },
): MirrorResult {
  const checkedAt = options.now ?? new Date().toISOString();
  const unknown = (reason: string): MirrorResult => ({
    dir,
    freshness: { state: "unknown", remoteTip: null, checkedAt, reason },
  });
  if (!options.exists) {
    return unknown("no local mirror yet");
  }

  const remote = run("git", ["-C", dir, "remote", "get-url", "origin"]);
  if (remote.status !== 0) {
    return unknown(remote.stderr.trim() || "could not read the mirror's origin remote");
  }
  // parseRepoSpec already normalizes https/ssh/.git/trailing-slash forms, so
  // comparing through it avoids a second, subtly different URL parser.
  let actual: string;
  try {
    actual = parseRepoSpec(remote.stdout.trim()).full;
  } catch {
    throw new Error(
      `local mirror at ${dir} does not point at ${spec.full} — its origin is "${remote.stdout.trim()}"`,
    );
  }
  if (actual !== spec.full) {
    throw new Error(`local mirror at ${dir} does not point at ${spec.full} — its origin is ${actual}`);
  }

  const advertised = run("git", ["-C", dir, "ls-remote", "--symref", "origin", "HEAD"]);
  if (advertised.status !== 0) {
    return unknown((advertised.stderr || advertised.stdout).trim() || "could not query the remote default branch");
  }
  const defaultBranch = advertisedDefault(advertised.stdout);
  if (!defaultBranch) return unknown("remote did not advertise a default branch and commit");

  // Fetch the advertised branch into its exact tracking ref. A plain fetch's
  // FETCH_HEAD can instead follow the mirror's checked-out feature branch.
  const trackingRef = `refs/remotes/origin/${defaultBranch.branch.slice("refs/heads/".length)}`;
  const fetched = run("git", ["-C", dir, "fetch", "--no-tags", "origin", `+${defaultBranch.branch}:${trackingRef}`]);
  if (fetched.status !== 0) {
    return unknown((fetched.stderr || fetched.stdout).trim() || "git fetch failed");
  }

  const tip = run("git", ["-C", dir, "rev-parse", "--verify", `${trackingRef}^{commit}`]);
  const remoteTip = tip.status === 0 ? tip.stdout.trim().toLowerCase() : "";
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(remoteTip) || remoteTip !== defaultBranch.tip) {
    return unknown("fetched default branch commit does not match the remote's advertised commit");
  }

  // A default-branch switch (or force push) during the fetch must not make an
  // already obsolete base look fresh. The next run can retry the new default.
  const confirmed = run("git", ["-C", dir, "ls-remote", "--symref", "origin", "HEAD"]);
  if (confirmed.status !== 0) {
    return unknown((confirmed.stderr || confirmed.stdout).trim() || "could not confirm the remote default branch");
  }
  const currentDefault = advertisedDefault(confirmed.stdout);
  if (!currentDefault || currentDefault.branch !== defaultBranch.branch || currentDefault.tip !== remoteTip) {
    return unknown("remote default branch changed during refresh; retry");
  }
  return { dir, freshness: { state: "fresh", remoteTip, checkedAt } };
}

/** One-line "open a PR" footer for a finished repo run. Pure. */
export function prCreateHint(spec: RepoSpec, branch: string): string {
  return `  open a PR:  gh pr create -R ${spec.full} --head ${branch} --fill\n`;
}
