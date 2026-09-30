import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cmdCode, prepareWorkspace } from "../src/commands/code.js";
import type { AppContext } from "../src/core/context.js";
import type { PromptIO } from "../src/ui/interact.js";
import type { Runner, RunResult } from "../src/core/worktree.js";

function ctxWith(cwd: string, yes = false): AppContext {
  return { cfg: {}, api: {}, tokens: {}, flags: { json: false, audit: false, yes, cwd } } as unknown as AppContext;
}

function io(answers: string[], tty = true): PromptIO & { notes: string[] } {
  const notes: string[] = [];
  let i = 0;
  return {
    tty,
    notes,
    note: (l: string): void => void notes.push(l),
    question: (): Promise<string> => Promise.resolve(answers[i++] ?? ""),
  };
}

const okR = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const failR = (): RunResult => ({ status: 1, stdout: "", stderr: "" });

test("repo gate: non-TTY without --yes proceeds in place with zero side effects", async () => {
  const calls: string[][] = [];
  const run: Runner = (c, a) => (calls.push([c, ...a]), failR());
  const res = await prepareWorkspace(ctxWith("/some/dir"), "task", io([], false), run);
  assert.equal(res.proceed, true);
  assert.equal(res.cwd, resolve("/some/dir"));
  assert.equal(calls.length, 0, "no git/gh calls in a pipe/CI run");
});

test("repo gate: yes + gh authed + git repo -> real isolated worktree + account link", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-gate-"));
  const prev = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = dir;
  try {
    const run: Runner = (_c, args) => {
      if (args.includes("--show-toplevel")) return okR("/home/u/proj\n");
      if (args.includes("--is-inside-work-tree")) return okR("true\n");
      if (args.includes("auth")) return okR("Logged in to github.com account octocat");
      if (args.includes("worktree")) return okR();
      return failR();
    };
    const prompts = io(["y"]);
    const res = await prepareWorkspace(ctxWith("/home/u/proj"), "fix the bug", prompts, run);
    assert.equal(res.proceed, true);
    assert.ok(res.cwd.includes("proj-fix-the-bug"), `worktree path: ${res.cwd}`);
    assert.ok(prompts.notes.some((n) => /octocat linked/.test(n)), "linked the gh account");
    assert.ok(prompts.notes.some((n) => /ready/.test(n)), "announced the worktree");
  } finally {
    if (prev === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repo gate: 'no' then a blank directory cancels the run", async () => {
  const run: Runner = (_c, args) => (args.includes("--show-toplevel") ? okR("/r\n") : failR());
  const prompts = io(["n", ""]);
  const res = await prepareWorkspace(ctxWith("/r"), "t", prompts, run);
  assert.equal(res.proceed, false);
  assert.ok(prompts.notes.some((n) => /standing down/.test(n)));
});

test("repo gate: yes + gh NOT authed -> confirm-only, in place, with a gh nudge", async () => {
  const run: Runner = (_c, args) => (args.includes("--show-toplevel") ? okR("/home/u/proj\n") : failR());
  const prompts = io(["y"]);
  const res = await prepareWorkspace(ctxWith("/home/u/proj"), "t", prompts, run);
  assert.equal(res.proceed, true);
  assert.equal(res.cwd, "/home/u/proj");
  assert.ok(prompts.notes.some((n) => /gh auth login/.test(n)));
});

test("repo gate: --yes auto-confirms without prompting (gh authed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-gate-"));
  const prev = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = dir;
  try {
    let asked = 0;
    const run: Runner = (_c, args) => {
      if (args.includes("--show-toplevel")) return okR("/home/u/proj\n");
      if (args.includes("--is-inside-work-tree")) return okR("true\n");
      if (args.includes("auth")) return okR("Logged in to github.com account ci-bot");
      if (args.includes("worktree")) return okR();
      return failR();
    };
    const prompts: PromptIO = {
      tty: false,
      note: (): void => {},
      question: (): Promise<string> => ((asked += 1), Promise.resolve("")),
    };
    const res = await prepareWorkspace(ctxWith("/home/u/proj", true), "ship it", prompts, run);
    assert.equal(res.proceed, true);
    assert.equal(asked, 0, "--yes never prompts");
    assert.ok(res.cwd.includes("proj-ship-it"));
  } finally {
    if (prev === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repo gate: failed automatic worktree aborts under non-TTY --yes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-gate-"));
  const prev = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = dir;
  try {
    let asked = 0;
    let worktreeAttempts = 0;
    const run: Runner = (_c, args) => {
      if (args.includes("--show-toplevel")) return okR("/home/u/proj\n");
      if (args.includes("--is-inside-work-tree")) return okR("true\n");
      if (args.includes("auth")) return okR("Logged in to github.com");
      if (args.includes("worktree")) {
        worktreeAttempts += 1;
        return { status: 1, stdout: "", stderr: "permission denied" };
      }
      return failR();
    };
    const prompts: PromptIO & { notes: string[] } = {
      tty: false,
      notes: [],
      note(line): void { this.notes.push(line); },
      question: (): Promise<string> => ((asked += 1), Promise.resolve("")),
    };
    const res = await prepareWorkspace(ctxWith("/home/u/proj", true), "fix the bug", prompts, run);
    assert.equal(worktreeAttempts, 5);
    assert.equal(asked, 0, "--yes must not turn failed isolation into in-place consent");
    assert.equal(res.proceed, false, "the coding brain must not start on the original checkout");
    assert.match(res.error ?? "", /permission denied/);
    assert.ok(prompts.notes.some((n) => /permission denied/.test(n)), "show the Git failure");
    assert.ok(!prompts.notes.some((n) => /working in place/.test(n)), "do not announce an unsafe fallback");
  } finally {
    if (prev === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code command: failed automatic worktree exits nonzero before the coding task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-gate-"));
  const prev = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = dir;
  try {
    let worktreeAttempts = 0;
    const run: Runner = (_c, args) => {
      if (args.includes("--show-toplevel")) return okR("/home/u/proj\n");
      if (args.includes("--is-inside-work-tree")) return okR("true\n");
      if (args.includes("auth")) return okR("Logged in to github.com");
      if (args.includes("worktree")) {
        worktreeAttempts += 1;
        return { status: 1, stdout: "", stderr: "permission denied" };
      }
      return failR();
    };
    const exit = await cmdCode(
      ctxWith("/home/u/proj", true),
      "fix the bug",
      { local: true, pool: 5, quiet: true, noLog: true },
      run,
    );
    assert.equal(worktreeAttempts, 5);
    assert.equal(exit, 1, "a failed isolation attempt must report a failed command");
  } finally {
    if (prev === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
