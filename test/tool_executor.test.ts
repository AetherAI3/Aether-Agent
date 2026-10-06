import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpWorkspace } from "./tmp_workspace.js";
import { spawnSync } from "node:child_process";
import { ToolExecutor } from "../src/core/tool_executor.js";

const canSpawnGit = !spawnSync("git", ["--version"], { encoding: "utf8" }).error;

function initRepo(): string {
  const dir = tmpWorkspace("aether-gitcommit-");
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "hello\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

test("git_commit passes a message with shell metacharacters through unexecuted", async (t) => {
  if (!canSpawnGit) { t.skip("sandbox blocks child process spawning"); return; }
  const dir = initRepo();
  try {
    const exec = new ToolExecutor(dir);
    // Write through the tool, the way the agent does. The commit guard's
    // baseline is armed by the first mutating tool call, so a change made
    // behind the executor's back is (correctly) part of the baseline and would
    // not be a commit candidate.
    const prior = JSON.parse(exec.execute("read_file", { path: "a.txt" }).output);
    exec.execute("write_file", { path: "a.txt", content: "changed\n", expected_revision: prior.revision, replace_token: prior.replace_token });
    const r = exec.execute("git_commit", { message: 'fix "cap & retry" `whoami` $(id)' });
    assert.equal(r.exitCode, 0);
    const log = spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: dir, encoding: "utf8" });
    assert.equal(log.stdout.trim(), 'fix "cap & retry" `whoami` $(id)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git_commit with nothing staged reports it without a fabricated failure", async (t) => {
  if (!canSpawnGit) { t.skip("sandbox blocks child process spawning"); return; }
  const dir = initRepo();
  try {
    const exec = new ToolExecutor(dir);
    const r = exec.execute("git_commit", { message: "no-op" });
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /nothing new to commit/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run_tests with no explicit command and no configured testCmd does not default to pytest", async () => {
  // Regression for cac0399: an unset test_cmd must mean "unverifiable", never a
  // silent fallback to a real test runner. brain_protocol.ts's wire-encoding
  // default was fixed there; this covers the sibling default in ToolExecutor
  // itself, which is what actually executes brain-initiated run_tests calls.
  const dir = tmpWorkspace("aether-runtests-");
  try {
    const exec = new ToolExecutor(dir); // no testCmd passed — must NOT become "pytest -q"
    const r = await exec.executeAsync("run_tests", {});
    assert.doesNotMatch(r.output, /pytest/i, "must never silently run pytest when no test_cmd is configured");
    assert.notEqual(r.exitCode, 0, "an unverifiable run_tests call must not report success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run_tests still honors an explicit command even with no configured testCmd", async (t) => {
  const dir = tmpWorkspace("aether-runtests-explicit-");
  try {
    const exec = new ToolExecutor(dir);
    const r = await exec.executeAsync("run_tests", { command: process.platform === "win32" ? "exit 0" : "true" });
    if (/spawn error EPERM/.test(r.output)) { t.skip("sandbox blocks child process spawning"); return; }
    assert.equal(r.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run_tests honors a configured testCmd when the call omits an explicit command", async (t) => {
  const dir = tmpWorkspace("aether-runtests-cfg-");
  try {
    const exec = new ToolExecutor(dir, process.platform === "win32" ? "exit 0" : "true");
    const r = await exec.executeAsync("run_tests", {});
    if (/spawn error EPERM/.test(r.output)) { t.skip("sandbox blocks child process spawning"); return; }
    assert.equal(r.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the commit guard is armed by the first mutating tool, not by construction", async (t) => {
  // Constructing a ToolExecutor used to run two synchronous `git` calls, which
  // froze `aether agent` / `aether chat` before the first turn even in runs
  // that never committed. The baseline now comes from the first MUTATING tool
  // call. This asserts the whole ordering at once: construction does not arm
  // it, a read does not arm it, and the write does — so a change made behind
  // the executor's back before that point is baseline, not a commit candidate.
  if (!canSpawnGit) { t.skip("sandbox blocks child process spawning"); return; }
  const dir = initRepo();
  try {
    const exec = new ToolExecutor(dir);
    writeFileSync(join(dir, "a.txt"), "edited outside the agent\n");
    assert.equal(exec.execute("read_file", { path: "a.txt" }).exitCode, 0);

    const wrote = exec.execute("write_file", { path: "b.txt", content: "agent wrote this\n" });
    assert.equal(wrote.exitCode, 0);

    const r = exec.execute("git_commit", { message: "feat: only what the agent touched" });
    assert.equal(r.exitCode, 0, r.output);

    const named = spawnSync("git", ["show", "--name-only", "--pretty=format:", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    assert.deepEqual(named, ["b.txt"], "must commit the agent's write and not the out-of-band edit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git_commit surfaces a real failure instead of reporting the old HEAD as success", async (t) => {
  if (!canSpawnGit) { t.skip("sandbox blocks child process spawning"); return; }
  const dir = initRepo();
  try {
    const exec = new ToolExecutor(dir);
    const prior = JSON.parse(exec.execute("read_file", { path: "a.txt" }).output);
    exec.execute("write_file", { path: "a.txt", content: "changed again\n", expected_revision: prior.revision, replace_token: prior.replace_token });
    // Break the repo's ability to commit: a pre-commit hook that always fails.
    const hookPath = join(dir, ".git", "hooks", "pre-commit");
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
    spawnSync("chmod", ["+x", hookPath]);
    const before = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();

    const r = exec.execute("git_commit", { message: "should fail" });

    assert.notEqual(r.exitCode, 0, "a hook rejection must not report success");
    assert.ok(!r.output.includes(before) || r.exitCode !== 0, "must not silently report the prior HEAD as the new commit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
