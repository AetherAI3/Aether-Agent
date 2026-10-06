// The end-to-end rail canary: edit → select → stage → commit → publish → PR.
//
// This is the test the ship rail was missing. Everything below runs against a
// REAL git repository with a REAL bare remote, driven through the actual
// `aether review` / `aether ship` entry points. What it asserts is what ended
// up on disk and in refs — the index git reports, the file content git holds,
// the ref that appeared on the remote, and the exact argv handed to gh — not
// the prose printed around any of it.
//
// gh is faked at the Runner seam rather than on PATH by default: Node refuses
// to spawn a `.cmd`/`.bat` shim without a shell (the CVE-2024-27980 fix), so a
// PATH shim is not portable to Windows. The last test in this file does put a
// real executable `gh` on PATH and drives the default deps, and is skipped on
// win32 — so the PATH form is proven where it can be.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AppContext } from "../src/core/context.js";
import type { PromptIO } from "../src/ui/interact.js";
import type { RunResult, Runner } from "../src/core/worktree.js";
import { defaultRunner } from "../src/core/worktree.js";
import { readRepoState } from "../src/core/review_state.js";
import { runReview, type ReviewDeps } from "../src/commands/review.js";
import { parseShipSlashArgs, runShip, shipSlash, type ShipDeps } from "../src/commands/ship.js";
import { CLI_PARSE_OPTIONS } from "../src/commands/cli_registry.js";
import { splitSlashCommand } from "../src/commands/slash.js";
import { spawnAsyncRun } from "../src/commands/review_counts.js";
import { TEMP_ROOT } from "./tmp_workspace.js";

const PR_URL = "https://github.com/octocat/hello-world/pull/42";

const ctx = { flags: { cwd: "", yes: false, json: false } } as unknown as AppContext;

function sink(): { out: PassThrough; text: () => string } {
  const chunks: string[] = [];
  const out = new PassThrough();
  out.on("data", (chunk) => chunks.push(String(chunk)));
  return { out, text: () => chunks.join("") };
}

function io(answers: string[], tty = false): PromptIO {
  const queue = [...answers];
  return { tty, note: () => {}, question: async () => queue.shift() ?? "" };
}

/** Run git for real, in `dir`, and fail loudly — a silently failed setup step
 *  produces a test that passes for the wrong reason. */
function git(dir: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

interface Fixture {
  repo: string;
  remote: string;
  config: string;
  cleanup(): void;
}

/**
 * A repository on a feature branch, with `main` already on a bare remote so
 * there is a real base to be ahead of, and an isolated AETHER_CONFIG_DIR so the
 * verification and ship records land in the fixture rather than in the
 * developer's real config directory.
 */
function repoFixture(): Fixture {
  const root = mkdtempSync(join(TEMP_ROOT, "aether-rail-"));
  const repo = join(root, "work");
  // The bare repo lives under a directory literally named github.com, so
  // githubSpec() resolves it to octocat/hello-world while every push is a real
  // push to a real repository on disk. Forward slashes because githubSpec
  // matches `github.com[/:]` and a Windows backslash path would not.
  const remote = join(root, "github.com", "octocat", "hello-world.git").split("\\").join("/");
  const config = join(root, "config");
  mkdirSync(repo);
  mkdirSync(config);
  mkdirSync(join(root, "github.com", "octocat"), { recursive: true });

  spawnSync("git", ["init", "--bare", "--initial-branch=main", remote], { encoding: "utf8" });
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.email", "rail@example.invalid");
  git(repo, "config", "user.name", "Rail Test");
  git(repo, "config", "commit.gpgsign", "false");
  // Windows checkouts default to autocrlf=true, which would make every content
  // assertion below compare CRLF against the LF the test wrote.
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "kept.ts"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
  writeFileSync(join(repo, "other.ts"), "alpha\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "chore: base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "origin", "main");
  git(repo, "checkout", "-b", "feature/rail");

  const previous = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = config;
  return {
    repo,
    remote,
    config,
    cleanup(): void {
      if (previous === undefined) delete process.env["AETHER_CONFIG_DIR"];
      else process.env["AETHER_CONFIG_DIR"] = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Real git, faked gh. Records every argv either binary was handed. */
function railRunner(gh: (args: string[]) => RunResult): { run: Runner; calls: string[][] } {
  const real = defaultRunner();
  const calls: string[][] = [];
  const run: Runner = (cmd, args, cwd) => {
    calls.push([cmd, ...args]);
    if (cmd === "gh") return gh(args);
    return real(cmd, args, cwd);
  };
  return { run, calls };
}

const okGh = (args: string[]): RunResult => {
  if (args[0] === "pr" && args[1] === "create") return { status: 0, stdout: `${PR_URL}\n`, stderr: "" };
  return { status: 0, stdout: "", stderr: "" };
};

const reviewDeps = (fixture: Fixture, run: Runner, out: PassThrough, answers: string[] = []): ReviewDeps => ({
  run,
  runAsync: spawnAsyncRun(),
  cwd: fixture.repo,
  out,
  io: io(answers),
});

const shipDeps = (fixture: Fixture, run: Runner, out: PassThrough, answers: string[] = []): ShipDeps => ({
  run,
  cwd: fixture.repo,
  out,
  io: io(answers),
});

const stagedPaths = (repo: string): string[] =>
  git(repo, "diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();

const remoteBranches = (remote: string): string[] =>
  spawnSync("git", ["-C", remote, "for-each-ref", "--format=%(refname)", "refs/heads"], { encoding: "utf8" })
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();

test("/ship rejects malformed or unsupported input before any git, push, PR, or confirmation call", async () => {
  const cases: Array<[string, RegExp]> = [
    ["--title", /--title needs a value/],
    ["--title --base main", /--title needs a value/],
    ['--title "unterminated', /unterminated quote/],
    ["--title hello\\", /trailing escape/],
    ["--body-file proposal.md", /unsupported option: --body-file/],
    ["--title first --title second", /duplicate option: --title/],
    ["--json --json", /duplicate option: --json/],
    ["--title good stray", /unexpected argument: stray/],
    ["--title=", /--title needs a value/],
    ["--yes=true", /--yes does not take a value/],
  ];
  for (const [arg, message] of cases) {
    const out = sink();
    let calls = 0;
    let prompts = 0;
    const deps: ShipDeps = {
      run: () => { calls++; throw new Error("git or gh must not run"); },
      cwd: "unused",
      out: out.out,
      io: { tty: true, note: () => {}, question: async () => { prompts++; return "y"; } },
    };
    await shipSlash(ctx, out.out, arg, deps);
    assert.match(out.text(), message, arg);
    assert.match(out.text(), /usage: \/ship/, arg);
    assert.equal(calls, 0, arg);
    assert.equal(prompts, 0, arg);
  }
});

test("/ship handles escaped spaces, equals values, and help without running Git", async () => {
  assert.deepEqual(parseShipSlashArgs('--title=Fix\\ auth\\ and\\ model\\ picker --base="main"'), {
    yes: false, json: false, title: "Fix auth and model picker", base: "main",
  });
  assert.deepEqual(parseShipSlashArgs('--title "C:\\work\\file $(id)"'), {
    yes: false, json: false, title: "C:\\work\\file $(id)",
  });
  const out = sink();
  await shipSlash(ctx, out.out, "--help", {
    run: () => { throw new Error("Git must not run for help"); },
    cwd: "unused", out: out.out, io: io([]),
  });
  assert.match(out.text(), /--title.*--body.*--base.*--approve.*--yes.*--json/);
  assert.equal(out.text().includes("--body-file"), false);
});

test("/ship and CLI preserve the same quoted Unicode, newlines, and literal shell-looking argv", async () => {
  const fixture = repoFixture();
  try {
    writeFileSync(join(fixture.repo, "kept.ts"), "changed\n");
    git(fixture.repo, "commit", "-am", "fix: source");
    const title = 'Fix auth and model picker — "safe" $(whoami) `whoami`';
    const body = "line one\nline two ☃ $HOME $(id) `id`";
    const slashArg = '--title "Fix auth and model picker — \\"safe\\" $(whoami) `whoami`" ' +
      "--body 'line one\nline two ☃ $HOME $(id) `id`' --base main";
    assert.deepEqual(splitSlashCommand(`/ship ${slashArg}`), { cmd: "ship", arg: slashArg });
    const cli = parseArgs({
      args: ["ship", "--title", title, "--body", body, "--base", "main", "--approve", "publish"],
      allowPositionals: true,
      strict: true,
      options: CLI_PARSE_OPTIONS,
    });
    assert.deepEqual(cli.positionals, ["ship"]);
    assert.equal(cli.values["title"], title);
    assert.equal(cli.values["body"], body);
    const parsed = parseShipSlashArgs(slashArg);
    assert.notEqual(parsed, "help");
    assert.equal((parsed as { title?: string }).title, cli.values["title"]);
    assert.equal((parsed as { body?: string }).body, cli.values["body"]);

    const { run, calls } = railRunner(okGh);
    const preview = sink();
    await shipSlash(ctx, preview.out, `${slashArg} --json`, shipDeps(fixture, run, preview.out));
    const planned = JSON.parse(preview.text()) as { commands: Array<{ cmd: string; args: string[] }> };
    const plannedGh = planned.commands.find((command) => command.cmd === "gh")!.args;
    assert.equal(plannedGh[plannedGh.indexOf("--title") + 1], title);
    assert.equal(plannedGh[plannedGh.indexOf("--body") + 1], body);
    assert.equal(calls.some((call) => call[0] === "gh" || call.includes("push")), false);

    const published = sink();
    await shipSlash(ctx, published.out, `${slashArg} --approve publish`, shipDeps(fixture, run, published.out));
    const created = calls.find((call) => call[0] === "gh" && call[1] === "pr" && call[2] === "create");
    assert.ok(created, published.text());
    assert.deepEqual(created.slice(1), plannedGh);
    assert.match(published.text(), /Fix auth and model picker/);
    assert.match(published.text(), /PR opened:/);
  } finally {
    fixture.cleanup();
  }
});

// ── the whole rail ──────────────────────────────────────────────────────────

test("the whole rail: edit → select → stage → commit → publish → PR", async () => {
  const fixture = repoFixture();
  try {
    writeFileSync(join(fixture.repo, "kept.ts"), "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n");
    writeFileSync(join(fixture.repo, "other.ts"), "beta\n");
    writeFileSync(join(fixture.repo, "scratch.log"), "not for the commit\n");

    const { run, calls } = railRunner(okGh);

    // 1. stage exactly one of the three changed paths.
    const staged = sink();
    assert.equal(
      await runReview(ctx, reviewDeps(fixture, run, staged.out), "stage", {
        files: "kept.ts",
        all: false,
        yes: false,
        json: false,
      }),
      0,
    );
    assert.deepEqual(stagedPaths(fixture.repo), ["kept.ts"], "only the selected path is in the index");

    // 2. commit it. The other two must stay out of the commit entirely.
    const committed = sink();
    assert.equal(
      await runReview(ctx, reviewDeps(fixture, run, committed.out), "commit", {
        files: "kept.ts",
        message: "fix: keep the kept one",
        all: false,
        yes: false,
        json: false,
      }),
      0,
    );
    const inCommit = git(fixture.repo, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean);
    assert.deepEqual(inCommit, ["kept.ts"], "the commit contains exactly what was selected");
    assert.equal(git(fixture.repo, "log", "-1", "--format=%s").trim(), "fix: keep the kept one");

    // 3. ship. Approved through the declared authority boundary.
    const shipped = sink();
    const code = await runShip(ctx, shipDeps(fixture, run, shipped.out), {
      yes: false,
      json: false,
      approve: "publish",
    });
    assert.equal(code, 0, shipped.text());

    // The ref really arrived on the real remote, and it is the ONLY branch that
    // moved — main is still the base commit it was pushed at.
    assert.deepEqual(remoteBranches(fixture.remote), ["refs/heads/feature/rail", "refs/heads/main"]);
    const pushedTip = spawnSync("git", ["-C", fixture.remote, "rev-parse", "refs/heads/feature/rail"], {
      encoding: "utf8",
    }).stdout.trim();
    assert.equal(pushedTip, git(fixture.repo, "rev-parse", "HEAD").trim());
    const remoteMain = spawnSync("git", ["-C", fixture.remote, "rev-parse", "refs/heads/main"], {
      encoding: "utf8",
    }).stdout.trim();
    assert.equal(remoteMain, git(fixture.repo, "rev-parse", "main").trim(), "the base branch was not touched");

    // The pull request was opened with the exact argv, and the URL was reported.
    const create = calls.find((call) => call[0] === "gh" && call.includes("create"));
    assert.ok(create, "gh pr create was never invoked");
    assert.equal(create![create!.indexOf("--head") + 1], "feature/rail");
    assert.equal(create![create!.indexOf("--title") + 1], "fix: keep the kept one");
    // A plain substring check, not a RegExp built from the URL. Escaping a URL
    // into a pattern is the wrong tool for "this exact text was printed": the
    // escape set is easy to get wrong — this one missed backslashes, which is
    // what CodeQL flagged as js/incomplete-sanitization — and a missed
    // metacharacter silently WIDENS what the assertion accepts rather than
    // narrowing it. There is no pattern to match here: PR_URL is a constant and
    // the test wants it back verbatim.
    // Exact-token equality, not includes(): a substring test over a URL reads
    // to CodeQL as js/incomplete-url-substring-sanitization, and it is also the
    // weaker assertion — "https://evil.example/https://github.com/..." would
    // satisfy it. The URL must be printed as its own whitespace-delimited token.
    assert.ok(
      shipped.text().split(/\s+/).some((token) => token === PR_URL),
      `the pull request URL was never reported verbatim: ${shipped.text()}`,
    );
  } finally {
    fixture.cleanup();
  }
});

// ── refusals, proven against real refs ──────────────────────────────────────

test("nothing in the rail ever merges, forces, or pushes another ref", async () => {
  const fixture = repoFixture();
  try {
    writeFileSync(join(fixture.repo, "kept.ts"), "changed\n");
    const { run, calls } = railRunner(okGh);
    const out = sink();
    await runReview(ctx, reviewDeps(fixture, run, out.out), "commit", {
      files: "kept.ts",
      message: "fix: a change",
      all: false,
      yes: false,
      json: false,
    });
    await runShip(ctx, shipDeps(fixture, run, out.out), { yes: false, json: false, approve: "publish" });

    const flat = calls.map((call) => call.join(" "));
    for (const forbidden of [
      "--force",
      "--force-with-lease",
      "--mirror",
      "--delete",
      "--tags",
      "--follow-tags",
      "push --all",
      "pr merge",
      "--admin",
      "--auto",
      "--squash",
    ]) {
      assert.equal(
        flat.some((line) => line.includes(forbidden)),
        false,
        `the rail must never issue ${forbidden}\n${flat.join("\n")}`,
      );
    }
    // Exactly one push, and its refspec names the head branch on both sides.
    const pushes = calls.filter((call) => call.includes("push"));
    assert.equal(pushes.length, 1, "the rail pushes once");
    assert.ok(
      pushes[0]!.includes("refs/heads/feature/rail:refs/heads/feature/rail"),
      `refspec was ${pushes[0]!.join(" ")}`,
    );
  } finally {
    fixture.cleanup();
  }
});

test("--yes alone does not publish; the branch never reaches the remote", async () => {
  const fixture = repoFixture();
  try {
    writeFileSync(join(fixture.repo, "kept.ts"), "changed\n");
    git(fixture.repo, "commit", "-am", "fix: a change");
    const { run, calls } = railRunner(okGh);
    const out = sink();

    const code = await runShip(ctx, shipDeps(fixture, run, out.out), { yes: true, json: false });
    assert.equal(code, 1);
    // The assertions that matter are absences: no push argv, no gh process at
    // all, and no new ref on the remote. A warning string proves nothing —
    // it can be printed by code that published anyway.
    assert.equal(
      calls.some((call) => call.includes("push")),
      false,
      "an unapproved ship must not push",
    );
    assert.equal(
      calls.some((call) => call[0] === "gh"),
      false,
      "an unapproved ship must not spawn gh at all — not even the auth probe",
    );
    assert.deepEqual(remoteBranches(fixture.remote), ["refs/heads/main"], "nothing new reached the remote");
    assert.match(out.text(), /--approve publish/);

    // …and the same run with the action NAMED does publish and does open it.
    const approvedOut = sink();
    const approved = railRunner(okGh);
    assert.equal(
      await runShip(ctx, shipDeps(fixture, approved.run, approvedOut.out), {
        yes: false,
        json: false,
        approve: "publish",
      }),
      0,
      approvedOut.text(),
    );
    assert.equal(approved.calls.some((call) => call.includes("push")), true);
    assert.equal(
      approved.calls.some((call) => call[0] === "gh" && call.includes("create")),
      true,
      "--approve publish is the thing that opens the pull request",
    );
    assert.deepEqual(remoteBranches(fixture.remote), ["refs/heads/feature/rail", "refs/heads/main"]);
  } finally {
    fixture.cleanup();
  }
});

test("a revert discards only the selected file, and leaves the others on disk", async () => {
  const fixture = repoFixture();
  try {
    writeFileSync(join(fixture.repo, "kept.ts"), "discard me\n");
    writeFileSync(join(fixture.repo, "other.ts"), "keep me\n");
    const { run } = railRunner(okGh);
    const out = sink();

    const code = await runReview(ctx, reviewDeps(fixture, run, out.out), "revert", {
      files: "kept.ts",
      all: false,
      yes: true,
      json: false,
      approve: "destructive",
    });
    assert.equal(code, 0, out.text());
    assert.equal(
      readFileSync(join(fixture.repo, "kept.ts"), "utf8"),
      "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
      "the selected file went back to its committed content",
    );
    assert.equal(
      readFileSync(join(fixture.repo, "other.ts"), "utf8"),
      "keep me\n",
      "a file the user did not select must not be touched",
    );
    // The confirmation named the file and showed the content being discarded.
    assert.match(out.text(), /kept\.ts/);
    assert.match(out.text(), /discard me/);
    assert.equal(/other\.ts/.test(out.text()), false, "an unselected file is not even mentioned as at risk");
  } finally {
    fixture.cleanup();
  }
});

test("--yes alone does not revert; the file keeps its edits", async () => {
  const fixture = repoFixture();
  try {
    writeFileSync(join(fixture.repo, "kept.ts"), "still here\n");
    const { run } = railRunner(okGh);
    const out = sink();
    const code = await runReview(ctx, reviewDeps(fixture, run, out.out), "revert", {
      files: "kept.ts",
      all: false,
      yes: true,
      json: false,
    });
    assert.equal(code, 1);
    assert.equal(readFileSync(join(fixture.repo, "kept.ts"), "utf8"), "still here\n");
    assert.match(out.text(), /--approve destructive/);
  } finally {
    fixture.cleanup();
  }
});

test("hunk selection stages one hunk and leaves the rest of the file unstaged", async () => {
  const fixture = repoFixture();
  try {
    // Two edits far enough apart to be separate hunks.
    writeFileSync(join(fixture.repo, "kept.ts"), "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n");
    const { run } = railRunner(okGh);
    const out = sink();

    const code = await runReview(ctx, reviewDeps(fixture, run, out.out), "stage", {
      files: "kept.ts",
      hunks: "1",
      all: false,
      yes: false,
      json: false,
    });
    assert.equal(code, 0, out.text());

    // The INDEX carries the first edit and not the second; the worktree carries
    // both. That is the whole point of a hunk selection, and it is a fact about
    // git objects rather than about what was printed.
    const indexContent = git(fixture.repo, "show", ":kept.ts");
    assert.match(indexContent, /^ONE$/m, "the selected hunk is staged");
    assert.equal(/^TEN$/m.test(indexContent), false, "the unselected hunk is NOT staged");
    assert.match(readFileSync(join(fixture.repo, "kept.ts"), "utf8"), /^TEN$/m, "the worktree still has both edits");
  } finally {
    fixture.cleanup();
  }
});

test("a commit refuses while the index holds work the user did not select", async () => {
  const fixture = repoFixture();
  try {
    writeFileSync(join(fixture.repo, "kept.ts"), "mine\n");
    writeFileSync(join(fixture.repo, "other.ts"), "someone else's\n");
    git(fixture.repo, "add", "other.ts");
    const before = git(fixture.repo, "rev-parse", "HEAD").trim();

    const { run } = railRunner(okGh);
    const out = sink();
    const code = await runReview(ctx, reviewDeps(fixture, run, out.out), "commit", {
      files: "kept.ts",
      message: "fix: only mine",
      all: false,
      yes: false,
      json: false,
    });
    assert.equal(code, 1);
    assert.equal(git(fixture.repo, "rev-parse", "HEAD").trim(), before, "no commit was created");
    assert.match(out.text(), /other\.ts/, "the refusal names the unselected staged path");
  } finally {
    fixture.cleanup();
  }
});

test("shipping a detached HEAD is refused before anything is pushed", async () => {
  const fixture = repoFixture();
  try {
    git(fixture.repo, "checkout", "--detach", "HEAD");
    const { run, calls } = railRunner(okGh);
    const out = sink();
    const code = await runShip(ctx, shipDeps(fixture, run, out.out), { yes: false, json: false, approve: "publish" });
    assert.equal(code, 1);
    assert.match(out.text(), /detached/);
    assert.equal(calls.some((call) => call.includes("push")), false);
  } finally {
    fixture.cleanup();
  }
});

test("shipping a branch with no commits of its own is refused", async () => {
  const fixture = repoFixture();
  try {
    // feature/rail is level with main: nothing to open a pull request about.
    const state = readRepoState(defaultRunner(), fixture.repo, { base: "main" });
    assert.equal(state.ok && state.aheadOfBase, 0);
    const { run, calls } = railRunner(okGh);
    const out = sink();
    const code = await runShip(ctx, shipDeps(fixture, run, out.out), {
      yes: false,
      json: false,
      base: "main",
      approve: "publish",
    });
    assert.equal(code, 1);
    assert.match(out.text(), /nothing to open a pull request about/);
    assert.equal(calls.some((call) => call.includes("push")), false);
  } finally {
    fixture.cleanup();
  }
});

test("a gh that is not signed in is reported, and the branch is still published", async () => {
  const fixture = repoFixture();
  try {
    writeFileSync(join(fixture.repo, "kept.ts"), "changed\n");
    git(fixture.repo, "commit", "-am", "fix: a change");
    const { run } = railRunner((args) =>
      args.join(" ") === "auth status"
        ? { status: 1, stdout: "", stderr: "not logged in" }
        : { status: 0, stdout: "", stderr: "" },
    );
    const out = sink();
    const code = await runShip(ctx, shipDeps(fixture, run, out.out), { yes: false, json: false, approve: "publish" });
    assert.equal(code, 1);
    assert.match(out.text(), /not signed in/);
    // The push happened, so saying "nothing happened" would be false.
    assert.deepEqual(remoteBranches(fixture.remote), ["refs/heads/feature/rail", "refs/heads/main"]);
    assert.match(out.text(), /the branch is published/);
  } finally {
    fixture.cleanup();
  }
});

test("the verification line is never green for a tree nobody verified", async () => {
  const fixture = repoFixture();
  try {
    writeFileSync(join(fixture.repo, "kept.ts"), "changed\n");
    git(fixture.repo, "commit", "-am", "fix: a change");
    const { run } = railRunner(okGh);
    const out = sink();
    await runShip(ctx, shipDeps(fixture, run, out.out), { yes: false, json: true });
    const parsed = JSON.parse(out.text()) as { verification: { status: string; reason: string } };
    assert.equal(parsed.verification.status, "unknown");
    assert.match(parsed.verification.reason, /nothing has verified this working tree/);
  } finally {
    fixture.cleanup();
  }
});

// ── the PATH form, where the platform allows it ─────────────────────────────

test(
  "the default deps find gh on PATH and hand it the same argv",
  { skip: process.platform === "win32" ? "Node will not spawn a .cmd shim without a shell" : false },
  async () => {
    const fixture = repoFixture();
    const previousPath = process.env["PATH"];
    try {
      writeFileSync(join(fixture.repo, "kept.ts"), "changed\n");
      git(fixture.repo, "commit", "-am", "fix: a change");

      const bin = join(fixture.repo, "..", "bin");
      mkdirSync(bin, { recursive: true });
      const log = join(bin, "gh-argv.log");
      const shim = join(bin, "gh");
      writeFileSync(
        shim,
        `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}"\nprintf -- '---\\n' >> "${log}"\n` +
          `case "$1$2" in prcreate) echo "${PR_URL}" ;; esac\nexit 0\n`,
        "utf8",
      );
      chmodSync(shim, 0o755);
      process.env["PATH"] = `${bin}:${previousPath ?? ""}`;

      const out = sink();
      const { defaultShipDeps } = await import("../src/commands/ship.js");
      const deps = { ...defaultShipDeps(fixture.repo, out.out), io: io([]) };
      const code = await runShip(ctx, deps, { yes: false, json: false, approve: "publish" });
      assert.equal(code, 0, out.text());

      const recorded = readFileSync(log, "utf8").split("---\n").filter((block) => block.trim());
      const create = recorded.map((block) => block.split("\n").filter(Boolean)).find((argv) => argv[1] === "create");
      assert.ok(create, `gh pr create never reached the shim:\n${recorded.join("|")}`);
      assert.equal(create![0], "pr");
      assert.equal(create![create!.indexOf("--head") + 1], "feature/rail");
      assert.equal(create!.includes("--force"), false);
      assert.equal(create!.includes("merge"), false);
    } finally {
      if (previousPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previousPath;
      fixture.cleanup();
    }
  },
);
