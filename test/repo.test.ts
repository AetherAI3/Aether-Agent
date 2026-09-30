import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseRepoSpec, cloneArgs, prCreateHint, refreshMirror } from "../src/core/repo.js";
import { defaultRunner, worktreeAddArgs, type Runner, type RunResult } from "../src/core/worktree.js";

test("parseRepoSpec accepts owner/name", () => {
  const s = parseRepoSpec("octocat/hello-world");
  assert.equal(s.owner, "octocat");
  assert.equal(s.name, "hello-world");
  assert.equal(s.full, "octocat/hello-world");
});

test("parseRepoSpec strips github URL forms and .git", () => {
  assert.equal(parseRepoSpec("https://github.com/octocat/hello-world.git").full, "octocat/hello-world");
  assert.equal(parseRepoSpec("git@github.com:octocat/hello-world").full, "octocat/hello-world");
  assert.equal(parseRepoSpec("octocat/hello-world/").full, "octocat/hello-world");
});

test("parseRepoSpec rejects junk", () => {
  assert.throws(() => parseRepoSpec("not-a-repo"), /expected owner\/name/);
  assert.throws(() => parseRepoSpec("a/b/c"), /expected owner\/name/);
  assert.throws(() => parseRepoSpec(""), /expected owner\/name/);
});

test("parseRepoSpec rejects argument-injection segments (leading dash, '.'/'..')", () => {
  assert.throws(() => parseRepoSpec("-x/y"), /may not start with '-'/);
  assert.throws(() => parseRepoSpec("x/-y"), /may not start with '-'/);
  assert.throws(() => parseRepoSpec("../y"), /'\.'\/'\.\.'/);
  assert.throws(() => parseRepoSpec("a/.."), /'\.'\/'\.\.'/);
  assert.throws(() => parseRepoSpec("./y"), /'\.'\/'\.\.'/);
  // Legit names containing dots/dashes (not leading) still parse.
  assert.equal(parseRepoSpec("my.org/my-repo.js").full, "my.org/my-repo.js");
});

test("cloneArgs uses gh when available, git otherwise", () => {
  const s = parseRepoSpec("octocat/hello-world");
  assert.deepEqual(cloneArgs(s, "/d", true), { cmd: "gh", args: ["repo", "clone", "octocat/hello-world", "/d"] });
  assert.deepEqual(cloneArgs(s, "/d", false), {
    cmd: "git",
    args: ["clone", "https://github.com/octocat/hello-world.git", "/d"],
  });
});

test("prCreateHint targets the repo + branch", () => {
  const hint = prCreateHint(parseRepoSpec("octocat/hello-world"), "aether/fix-1");
  assert.match(hint, /gh pr create -R octocat\/hello-world --head aether\/fix-1 --fill/);
});

// ── mirror freshness (SC-A2) ────────────────────────────────────────────────
// An existing --repo mirror must never be reused as-is. Before a task worktree
// branches off it, the mirror's remote is validated and the mirror is fetched
// through the user's own git/gh auth. When that cannot happen, the result says
// stale or unknown — never fresh.

function recordingRunner(table: Record<string, RunResult>): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(" ");
    for (const [pattern, result] of Object.entries(table)) {
      if (key.startsWith(pattern)) return result;
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const OK = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const mainTip = "a".repeat(40);
const mainAdvertisement = `ref: refs/heads/main\tHEAD\n${mainTip}\tHEAD\n`;
const freshResponses: Record<string, RunResult> = {
  "git -C /mirror remote get-url origin": OK("https://github.com/octocat/hello-world.git\n"),
  "git -C /mirror ls-remote --symref origin HEAD": OK(mainAdvertisement),
  "git -C /mirror rev-parse --verify refs/remotes/origin/main^{commit}": OK(`${mainTip}\n`),
};

test("an existing mirror is fetched, not silently reused", () => {
  const spec = parseRepoSpec("octocat/hello-world");
  const { run, calls } = recordingRunner(freshResponses);
  const result = refreshMirror(spec, "/mirror", run, { exists: true });
  assert.equal(result.freshness.state, "fresh");
  assert.deepEqual(calls.find((call) => call.includes("fetch")), [
    "git", "-C", "/mirror", "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main",
  ]);
  assert.equal(calls.some((call) => call.includes("FETCH_HEAD")), false);
});

test("a mirror pointing at a different repo is rejected, never used", () => {
  const spec = parseRepoSpec("octocat/hello-world");
  const { run } = recordingRunner({
    "git -C /mirror remote get-url origin": OK("https://github.com/somebody-else/other-repo.git\n"),
  });
  assert.throws(
    () => refreshMirror(spec, "/mirror", run, { exists: true }),
    /does not point at octocat\/hello-world/,
  );
});

test("a failed fetch reports unknown, never fresh", () => {
  const spec = parseRepoSpec("octocat/hello-world");
  const run: Runner = (_cmd, args) => {
    if (args.includes("fetch")) return { status: 1, stdout: "", stderr: "Could not resolve host: github.com" };
    if (args.includes("ls-remote")) return OK(mainAdvertisement);
    return OK("https://github.com/octocat/hello-world.git\n");
  };
  const result = refreshMirror(spec, "/mirror", run, { exists: true });
  assert.notEqual(result.freshness.state, "fresh");
  assert.equal(result.freshness.state, "unknown");
  assert.match(result.freshness.reason ?? "", /Could not resolve host/);
});

test("an offline or unauthorized default-branch lookup reports unknown", () => {
  const spec = parseRepoSpec("octocat/hello-world");
  const { run, calls } = recordingRunner({
    ...freshResponses,
    "git -C /mirror ls-remote --symref origin HEAD": {
      status: 128, stdout: "", stderr: "Authentication failed",
    },
  });
  const result = refreshMirror(spec, "/mirror", run, { exists: true });
  assert.equal(result.freshness.state, "unknown");
  assert.equal(result.freshness.remoteTip, null);
  assert.match(result.freshness.reason ?? "", /Authentication failed/);
  assert.equal(calls.some((call) => call.includes("fetch")), false);
});

test("refreshing a mirror never checks out, resets or cleans the user's tree", () => {
  const spec = parseRepoSpec("octocat/hello-world");
  const { run, calls } = recordingRunner(freshResponses);
  refreshMirror(spec, "/mirror", run, { exists: true });
  for (const mutation of ["checkout", "reset", "clean", "merge", "pull", "rebase"]) {
    assert.equal(
      calls.some((call) => call.includes(mutation)),
      false,
      `refresh must not run git ${mutation} on the user's mirror`,
    );
  }
});

test("no Aether credential is ever handed to git or gh", () => {
  const spec = parseRepoSpec("octocat/hello-world");
  const { run, calls } = recordingRunner(freshResponses);
  refreshMirror(spec, "/mirror", run, { exists: true });
  const flat = calls.flat().join(" ");
  for (const leak of ["aek_", "Authorization", "http.extraheader", "GIT_ASKPASS", "x-access-token"]) {
    assert.equal(flat.includes(leak), false, `credential material reached the git argv: ${leak}`);
  }
});

test("a fresh mirror reports the exact base commit a worktree would branch from", () => {
  const spec = parseRepoSpec("octocat/hello-world");
  const { run } = recordingRunner(freshResponses);
  const result = refreshMirror(spec, "/mirror", run, { exists: true });
  assert.equal(result.freshness.state, "fresh");
  assert.equal(result.freshness.remoteTip, mainTip);
});

test("an unadvertised default or unverifiable commit fails closed", () => {
  const spec = parseRepoSpec("octocat/hello-world");
  const cases: Record<string, RunResult>[] = [
    { ...freshResponses, "git -C /mirror ls-remote --symref origin HEAD": OK(`${mainTip}\tHEAD\n`) },
    { ...freshResponses, "git -C /mirror rev-parse --verify refs/remotes/origin/main^{commit}": OK("b".repeat(40)) },
  ];
  for (const responses of cases) {
    const { run } = recordingRunner(responses);
    const result = refreshMirror(spec, "/mirror", run, { exists: true });
    assert.equal(result.freshness.state, "unknown");
    assert.equal(result.freshness.remoteTip, null);
  }
});

test("a default branch switch during fetch fails closed", () => {
  const spec = parseRepoSpec("octocat/hello-world");
  let probes = 0;
  const { run: base } = recordingRunner(freshResponses);
  const run: Runner = (cmd, args) => {
    if (args.includes("ls-remote") && ++probes === 2) {
      return OK(`ref: refs/heads/feature\tHEAD\n${"b".repeat(40)}\tHEAD\n`);
    }
    return base(cmd, args);
  };
  const result = refreshMirror(spec, "/mirror", run, { exists: true });
  assert.equal(result.freshness.state, "unknown");
  assert.equal(result.freshness.remoteTip, null);
  assert.match(result.freshness.reason ?? "", /changed during refresh/);
});

test("a feature-checked-out mirror uses the remote default, including after it changes", (t) => {
  if (spawnSync("git", ["--version"], { encoding: "utf8" }).error) return t.skip("git not available");
  const root = mkdtempSync(join(tmpdir(), "aether-repo-default-"));
  t.after(() => {
    assert.equal(dirname(root), tmpdir());
    rmSync(root, { recursive: true, force: true });
  });
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const mirror = join(root, "mirror");
  mkdirSync(remote);
  mkdirSync(seed);

  const git = (cwd: string, ...args: string[]): string => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.name", "Test");
  git(seed, "config", "user.email", "test@example.invalid");
  writeFileSync(join(seed, "content.txt"), "main\n");
  git(seed, "add", "content.txt");
  git(seed, "commit", "-q", "-m", "main");
  const main = git(seed, "rev-parse", "HEAD");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main");
  git(seed, "switch", "-q", "-c", "feature");
  writeFileSync(join(seed, "content.txt"), "feature\n");
  git(seed, "commit", "-q", "-am", "feature");
  const feature = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "-q", "origin", "feature");
  git(root, "clone", "-q", remote, mirror);
  git(mirror, "switch", "-q", "-c", "feature", "--track", "origin/feature");
  git(mirror, "fetch", "-q", "origin");
  assert.equal(git(mirror, "rev-parse", "FETCH_HEAD"), feature, "the old implementation would select feature");

  // The fixture's origin is a local bare remote. Only its identity check is
  // substituted; all network/ref/fetch/worktree commands execute in real Git.
  const actual = defaultRunner();
  const run: Runner = (cmd, args, cwd) =>
    args.includes("get-url") ? OK("https://github.com/octocat/hello-world.git\n") : actual(cmd, args, cwd);
  const spec = parseRepoSpec("octocat/hello-world");
  const first = refreshMirror(spec, mirror, run, { exists: true });
  assert.equal(first.freshness.state, "fresh", first.freshness.reason);
  assert.equal(first.freshness.remoteTip, main, "the reported base must be main");
  const worktree = join(root, "worktree");
  git(root, ...worktreeAddArgs(mirror, "aether/test-default", worktree, first.freshness.remoteTip!));
  assert.equal(git(worktree, "rev-parse", "HEAD"), main, "the worktree must use the reported base");
  assert.equal(git(mirror, "rev-parse", "HEAD"), feature, "refresh must not move the mirror checkout");

  git(remote, "symbolic-ref", "HEAD", "refs/heads/feature");
  const second = refreshMirror(spec, mirror, run, { exists: true });
  assert.equal(second.freshness.state, "fresh", second.freshness.reason);
  assert.equal(second.freshness.remoteTip, feature, "a later run must use the new remote default");

  const offline: Runner = (cmd, args, cwd) =>
    args.includes("fetch") ? { status: 1, stdout: "", stderr: "fetch unavailable" } : run(cmd, args, cwd);
  const failed = refreshMirror(spec, mirror, offline, { exists: true });
  assert.equal(failed.freshness.state, "unknown");
  assert.equal(failed.freshness.remoteTip, null, "a stale tracking ref must not pass after fetch failure");
});
