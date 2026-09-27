// Repository + exact revision, reduced to the only two facts an observation is
// allowed to carry: a bare `owner/repo` NAME and a 40-hex HEAD sha.
//
// The raw git remote is deliberately never published. A remote URL can carry a
// credential (`https://user:ghp_…@github.com/o/r.git`), and it always carries a
// host — neither belongs in telemetry. So the remote is reduced to `owner/repo`
// and any candidate that still looks like a URL, a credential, or an absolute
// path is dropped to null rather than published.
//
// The probe is cached (60s) because the daemon samples every 12s and shelling
// out to git six times a minute for a value that changes on commit boundaries
// is pure waste. Everything is injectable so tests never need a checkout.

import { readRepoIdentity } from "../session_log.js";
import { defaultRunner, type Runner } from "../worktree.js";

export interface RepoFacts {
  name: string;
  revision: string;
}

export const REPO_PROBE_CACHE_MS = 60_000;

/** A 40-hex git object id, and nothing else. */
function cleanRevision(head: string | undefined): string | null {
  if (!head) return null;
  const v = head.trim();
  return /^[0-9a-f]{40}$/.test(v) ? v : null;
}

/**
 * Reduce a git remote to `owner/repo`. Returns null for anything that cannot be
 * reduced to exactly that shape — a local path remote, a remote with embedded
 * credentials that survive the strip, or a name with characters outside the
 * conservative set below.
 */
export function repoNameFromRemote(remote: string | undefined): string | null {
  if (!remote) return null;
  let v = remote.trim();
  if (!v) return null;
  // A credential-bearing remote is reduced like any other, but if the userinfo
  // cannot be cleanly removed we drop the whole value instead of guessing.
  v = v.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ""); // scheme
  v = v.replace(/^[^/@]*@/, ""); // userinfo (https) or user@host (scp-style ssh)
  v = v.replace(/^[^/:]+[:/]/, ""); // host + separator
  v = v.replace(/\.git$/, "").replace(/\/+$/, "");
  if (!v || v.includes("@") || v.includes(":") || v.includes("\\")) return null;
  const parts = v.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  // Keep only the last two segments: nested group paths collapse to owner/repo.
  const owner = parts[parts.length - 2]!;
  const repo = parts[parts.length - 1]!;
  const name = `${owner}/${repo}`;
  if (name.length > 200) return null;
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(name) ? name : null;
}

/**
 * Read `{name, revision}` for a checkout, or null when either half is unknown.
 * Both halves are required: a revision without a repo name is unattributable,
 * and a name without an exact revision is not "the exact revision" the contract
 * asks for.
 */
export function probeRepoFacts(cwd: string, run: Runner = defaultRunner()): RepoFacts | null {
  let identity: ReturnType<typeof readRepoIdentity>;
  try {
    identity = readRepoIdentity(cwd, run);
  } catch {
    return null;
  }
  if (!identity) return null;
  const name = repoNameFromRemote(identity.remote);
  const revision = cleanRevision(identity.head);
  if (!name || !revision) return null;
  return { name, revision };
}

/** A cached probe: at most one git shell-out per REPO_PROBE_CACHE_MS. */
export function makeRepoProbe(
  cwd: string,
  now: () => number = Date.now,
  run: Runner = defaultRunner(),
): () => RepoFacts | null {
  let cache: { at: number; value: RepoFacts | null } | null = null;
  return () => {
    const t = now();
    if (cache && t - cache.at < REPO_PROBE_CACHE_MS) return cache.value;
    const value = probeRepoFacts(cwd, run);
    cache = { at: t, value };
    return value;
  };
}
