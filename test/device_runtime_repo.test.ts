import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRepoProbe, probeRepoFacts, repoNameFromRemote } from "../src/core/device_runtime/repo_probe.js";
import type { Runner } from "../src/core/worktree.js";

const SHA = "1234567890abcdef1234567890abcdef12345678";

interface CountingRunner {
  run: Runner;
  /** How many times git was actually shelled out to. */
  calls: () => number;
}

/** A runner that answers the three git probes readRepoIdentity makes. */
function gitRunner(remote: string | null, head: string | null, branch = "main"): CountingRunner {
  let calls = 0;
  const run: Runner = (_cmd, args) => {
    calls += 1;
    const key = args.join(" ");
    if (key === "remote get-url origin") return reply(remote);
    if (key === "rev-parse HEAD") return reply(head);
    if (key === "rev-parse --abbrev-ref HEAD") return reply(branch);
    return { status: 1, stdout: "", stderr: "" };
  };
  return { run, calls: () => calls };
}

function reply(value: string | null): { status: number; stdout: string; stderr: string } {
  return value === null ? { status: 128, stdout: "", stderr: "not a repo" } : { status: 0, stdout: `${value}\n`, stderr: "" };
}

test("a remote reduces to a bare owner/repo", () => {
  assert.equal(repoNameFromRemote("https://github.com/AetherAI3/aether-agent.git"), "AetherAI3/aether-agent");
  assert.equal(repoNameFromRemote("git@github.com:AetherAI3/aether-agent.git"), "AetherAI3/aether-agent");
  assert.equal(repoNameFromRemote("ssh://git@github.com/AetherAI3/aether-agent"), "AetherAI3/aether-agent");
  assert.equal(repoNameFromRemote("https://gitlab.example.com/group/sub/proj.git"), "sub/proj");
});

test("a CREDENTIAL-bearing remote never publishes its credential", () => {
  for (const remote of [
    "https://user:ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/AetherAI3/aether-agent.git",
    "https://ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB@github.com/AetherAI3/aether-agent.git",
    "https://x-access-token:secret@github.com/AetherAI3/aether-agent",
  ]) {
    const name = repoNameFromRemote(remote);
    assert.equal(name, "AetherAI3/aether-agent");
    assert.equal(/ghp_|secret|@|:/.test(name ?? ""), false, `${remote} leaked through`);
  }
});

test("a remote that cannot be reduced is dropped, not guessed", () => {
  assert.equal(repoNameFromRemote(undefined), null);
  assert.equal(repoNameFromRemote(""), null);
  assert.equal(repoNameFromRemote("C:\\Users\\me\\repos\\thing"), null);
  assert.equal(repoNameFromRemote("/home/me/repos/thing"), "repos/thing"); // still a bare name, no path root
  assert.equal(repoNameFromRemote("https://github.com/single"), null);
  assert.equal(repoNameFromRemote("https://github.com/own er/re po"), null);
});

test("both halves are required — a name without an exact revision is not published", () => {
  assert.deepEqual(probeRepoFacts("/ws", gitRunner("https://github.com/o/r.git", SHA).run), {
    name: "o/r",
    revision: SHA,
  });
  // No remote, or a non-sha HEAD (a detached tag name, an error string), is null.
  assert.equal(probeRepoFacts("/ws", gitRunner(null, SHA).run), null);
  assert.equal(probeRepoFacts("/ws", gitRunner("https://github.com/o/r.git", null).run), null);
  assert.equal(probeRepoFacts("/ws", gitRunner("https://github.com/o/r.git", "HEAD").run), null);
  assert.equal(probeRepoFacts("/ws", gitRunner("https://github.com/o/r.git", "v1.2.3").run), null);
});

test("a runner that throws yields null rather than crashing the sample loop", () => {
  const boom: Runner = () => {
    throw new Error("git is not installed");
  };
  assert.equal(probeRepoFacts("/ws", boom), null);
});

test("the probe is cached so a 12s sample cadence does not shell out every tick", () => {
  const git = gitRunner("https://github.com/o/r.git", SHA);
  let clock = 0;
  const probe = makeRepoProbe("/ws", () => clock, git.run);
  assert.deepEqual(probe(), { name: "o/r", revision: SHA });
  const afterFirst = git.calls();
  clock = 30_000;
  probe();
  probe();
  assert.equal(git.calls(), afterFirst, "a cached probe must not re-run git");
  clock = 120_000; // past the cache window
  probe();
  assert.ok(git.calls() > afterFirst, "the cache must expire");
});
