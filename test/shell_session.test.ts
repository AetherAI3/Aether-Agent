import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ShellSession, type ShellCommandEvent } from "../src/core/shell_session.js";
import { ToolExecutor } from "../src/core/tool_executor.js";
import { classifyConsoleInput } from "../src/commands/console_input.js";

const supported = process.platform === "linux" || process.platform === "darwin";
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
function workspace(git = false): { root: string; session: ShellSession; exec: ToolExecutor; events: ShellCommandEvent[]; close: () => void } {
  const root = mkdtempSync(join(tmpdir(), "aether-shell-"));
  mkdirSync(join(root, "subdir"));
  if (git) {
    for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.com"]]) {
      assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
    }
    writeFileSync(join(root, "base.txt"), "base");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-qm", "init"], { cwd: root });
  }
  const events: ShellCommandEvent[] = [];
  const session = new ShellSession(root, event => events.push(event));
  const exec = new ToolExecutor(root, undefined, { mode: "coding", shellSession: session });
  return { root, session, exec, events, close: () => { session.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("console classifier preserves shell type, multiline and literal leading !", () => {
  assert.deepEqual(classifyConsoleInput("  !cd subdir\nexport DEMO=hello  "), { kind: "shell", command: "cd subdir\nexport DEMO=hello" });
  assert.equal(classifyConsoleInput("!").kind, "error");
  assert.deepEqual(classifyConsoleInput(" \\!literal"), { kind: "chat", text: "!literal" });
  assert.deepEqual(classifyConsoleInput("hello!"), { kind: "chat", text: "hello!" });
  assert.deepEqual(classifyConsoleInput("/shell-reset"), { kind: "reset-shell" });
});

test("user and model commands share real cwd, exports/functions; file tools stay root-relative", { skip: !supported }, async () => {
  const w = workspace();
  try {
    assert.equal((await w.exec.runUserShell("cd subdir\nexport DEMO='hello world'\nf() { printf function; }")).exitCode, 0);
    const result = await w.exec.executeAsync("run_shell", { command: "pwd; printf '%s\\n' \"$DEMO\"; f" });
    assert.equal(result.exitCode, 0);
    assert.match(result.output, new RegExp(w.root + "/subdir"));
    assert.match(result.output, /hello world\nfunction/);
    assert.equal(w.session.cwd, join(w.root, "subdir"));
    assert.equal((await w.exec.executeAsync("write_file", { path: "root.txt", content: "root" })).exitCode, 0);
    assert.equal(readFileSync(join(w.root, "root.txt"), "utf8"), "root");
    assert.equal(existsSync(join(w.root, "subdir", "root.txt")), false);
    const ranged = await w.exec.executeAsync("read_file", { path: "root.txt", max_bytes: 4 });
    const digest = JSON.parse(ranged.output).sha256 as string;
    assert.equal((await w.exec.executeAsync("patch_file", {
      path: "root.txt", expected_sha256: digest, old_text: "root", new_text: "ROOT",
    })).exitCode, 0);
    assert.equal(readFileSync(join(w.root, "root.txt"), "utf8"), "ROOT");
    const listing = await w.exec.executeAsync("list_directory", { path: "." });
    assert.ok(JSON.parse(listing.output).entries.some((entry: { path: string }) => entry.path === "./root.txt"));
    assert.equal((await w.exec.executeAsync("read_file", { path: "../outside" })).exitCode, 1);
    assert.deepEqual(w.events.filter(e => e.state === "running").map(e => e.origin), ["user", "model"]);
    assert.equal(new Set(w.events.map(e => e.sessionId)).size, 1);
    assert.equal(new Set(w.events.map(e => e.commandId)).size, 2);
  } finally { w.close(); }
});

test("failed cd and symlink escapes leave cwd intact; explicit builtin escape loses session", { skip: !supported }, async () => {
  const w = workspace();
  const outside = mkdtempSync(join(tmpdir(), "aether-outside-"));
  try {
    symlinkSync(outside, join(w.root, "escape"));
    await w.exec.runUserShell("cd subdir");
    for (const command of ["cd missing", "cd ..; cd escape", `cd ${quote(outside)}`]) {
      assert.equal((await w.exec.runUserShell(command)).exitCode, 1);
    }
    assert.equal(w.session.cwd, w.root);
    const escaped = await w.exec.runUserShell(`builtin cd ${quote(outside)}`);
    assert.equal(escaped.exitCode, 1);
    assert.match(escaped.output, /outside approved workspace/);
    assert.equal(w.session.state, "lost");
  } finally { w.close(); rmSync(outside, { recursive: true, force: true }); }
});

test("simultaneous user/model commands and file writes serialize, output drains before completion", { skip: !supported }, async () => {
  const w = workspace();
  try {
    const a = w.exec.runUserShell("sleep 0.05; cd subdir; export ORDER=first; printf user");
    const b = w.exec.executeAsync("run_shell", { command: "printf '%s' \"$ORDER\"; pwd; printf stderr >&2" });
    const c = w.exec.executeAsync("write_file", { path: "serial.txt", content: "serial" });
    const [user, model, file] = await Promise.all([a, b, c]);
    assert.match(user.output, /user/);
    assert.match(model.output, /first/);
    assert.match(model.output, /subdir/);
    assert.match(model.output, /stderr/);
    assert.equal(file.exitCode, 0);
    assert.deepEqual(w.events.map(e => e.state), ["running", "completed", "running", "completed"]);
    const big = await w.exec.runUserShell("printf '%100000s' x; printf tail >&2");
    assert.equal(big.exitCode, 0);
    assert.ok(big.output.length <= 8020);
    const next = await w.exec.runUserShell("printf clean");
    assert.equal(next.output, "[exit 0]\nclean");
  } finally { w.close(); }
});

test("crash and cancellation lose state visibly, reap descendants, and never replay", { skip: !supported }, async () => {
  const w = workspace();
  try {
    await w.exec.runUserShell("export DEMO=old; cd subdir");
    const crashed = await w.exec.runUserShell("printf before-crash; kill -KILL $$");
    assert.equal(crashed.exitCode, 1);
    assert.match(crashed.output, /state lost/);
    assert.match(crashed.output, /before-crash/);
    assert.equal((await w.exec.runUserShell("touch replayed")).exitCode, 1);
    w.session.reset();
    assert.equal((await w.exec.runUserShell("printf '%s' \"${DEMO-unset}\"; pwd")).output, `[exit 0]\nunset${w.root}\n`);
    const abort = new AbortController();
    const pending = w.exec.runUserShell("sleep 0.5; touch late", { signal: abort.signal });
    setTimeout(() => abort.abort(), 30);
    const cancelled = await pending;
    assert.equal(cancelled.exitCode, 130);
    assert.equal(w.session.state, "lost");
    assert.equal((await w.exec.runUserShell("touch late")).exitCode, 1);
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(existsSync(join(w.root, "late")), false);
    assert.equal(existsSync(join(w.root, "subdir", "replayed")), false);
    w.session.reset();
    const timeout = await w.exec.runUserShell("sleep 1", { timeoutMs: 10 });
    assert.equal(timeout.exitCode, 124);
    assert.match(timeout.output, /timed out/);
  } finally { w.close(); }
});

test("queued cancellation and stale approvals execute nothing", { skip: !supported }, async () => {
  const w = workspace();
  try {
    const approval = w.exec.shellContext;
    await w.exec.runUserShell("cd subdir");
    const stale = await w.exec.executeAsync("run_shell", { command: "touch stale" }, { expectedShellContext: approval });
    assert.equal(stale.exitCode, 1);
    assert.match(stale.output, /fresh approval/);
    const a = w.exec.runUserShell("sleep 0.05");
    const abort = new AbortController();
    const b = w.exec.runUserShell("touch cancelled", { signal: abort.signal });
    abort.abort();
    await a;
    assert.equal((await b).exitCode, 130);
    assert.equal(existsSync(join(w.root, "subdir", "cancelled")), false);
  } finally { w.close(); }
});

test("reset invalidates queued commands; a fresh project/worktree never inherits exports", { skip: !supported }, async () => {
  const w = workspace();
  const other = workspace();
  try {
    await w.exec.runUserShell("export PROJECT=old; cd subdir");
    assert.equal((await other.exec.runUserShell("printf '%s' \"${PROJECT-unset}\"; pwd")).output, `[exit 0]\nunset${other.root}\n`);
    const a = w.exec.runUserShell("sleep 1");
    const b = w.exec.runUserShell("touch old-queue");
    await new Promise(resolve => setTimeout(resolve, 20));
    w.session.reset();
    assert.equal((await a).exitCode, 1);
    assert.equal((await b).exitCode, 1);
    assert.equal((await w.exec.runUserShell("pwd")).output, `[exit 0]\n${w.root}\n`);
    assert.equal(existsSync(join(w.root, "old-queue")), false);
  } finally { w.close(); other.close(); }
});

test("automatic commit excludes unrelated user edits and mixed files between turns", { skip: !supported }, async () => {
  const w = workspace(true);
  try {
    await w.exec.executeAsync("write_file", { path: "agent.txt", content: "agent" });
    await w.exec.executeAsync("write_file", { path: "mixed.txt", content: "agent" });
    await w.exec.runUserShell("printf user > user.txt; printf user >> mixed.txt");
    writeFileSync(join(w.root, "external.txt"), "external editor");
    writeFileSync(join(w.root, "agent.txt"), "external editor touched agent file");
    await w.exec.executeAsync("write_file", { path: "only-agent.txt", content: "owned" });
    await w.exec.executeAsync("write_file", { path: "mixed.txt", content: "model again" });
    const committed = await w.exec.executeAsync("git_commit", { message: "only own paths" });
    assert.equal(committed.exitCode, 0, committed.output);
    const paths = spawnSync("git", ["show", "--pretty=", "--name-only", "HEAD"], { cwd: w.root, encoding: "utf8" }).stdout.trim().split("\n");
    assert.deepEqual(paths, ["only-agent.txt"]);
    const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: w.root, encoding: "utf8" }).stdout;
    for (const file of ["mixed.txt", "user.txt", "external.txt", "agent.txt"]) assert.match(dirty, new RegExp(file));
  } finally { w.close(); }
});

test("branch/worktree switches reset shell and commit baseline; session root cannot be swapped", { skip: !supported }, async () => {
  const w = workspace(true);
  const worktree = join(tmpdir(), `aether-shell-worktree-${Date.now()}`);
  try {
    await w.exec.runUserShell("cd subdir; export PROJECT=old");
    const switched = await w.exec.runUserShell("git switch -c new-project");
    assert.equal(switched.exitCode, 0);
    assert.match(switched.output, /shell cwd\/environment\/functions reset/);
    assert.equal(w.session.cwd, w.root);
    assert.equal((await w.exec.runUserShell("printf '%s' \"${PROJECT-unset}\"; pwd")).output, `[exit 0]\nunset${w.root}\n`);
    assert.equal(spawnSync("git", ["worktree", "add", "-b", "isolated", worktree], { cwd: w.root }).status, 0);
    const isolated = new ShellSession(worktree);
    const exec = new ToolExecutor(worktree, undefined, { mode: "coding", shellSession: isolated });
    try {
      assert.equal((await exec.runUserShell("printf '%s' \"${PROJECT-unset}\"; pwd")).output, `[exit 0]\nunset${worktree}\n`);
      assert.throws(() => new ToolExecutor(w.root, undefined, { mode: "coding", shellSession: isolated }), /belong/);
    } finally { isolated.close(); }
    spawnSync("git", ["switch", "new-project"], { cwd: w.root });
    const context = w.exec.shellContext;
    spawnSync("git", ["switch", "-c", "external-switch"], { cwd: w.root });
    const refused = await w.exec.executeAsync("run_shell", { command: "touch should-not-run" }, { expectedShellContext: context });
    assert.equal(refused.exitCode, 1);
    assert.match(refused.output, /checkout changed/);
    assert.equal(existsSync(join(w.root, "should-not-run")), false);
  } finally { w.close(); rmSync(worktree, { recursive: true, force: true }); }
});

test("shell credentials/rc environment never comes from the parent; exports stay local", { skip: !supported }, async () => {
  const prior = process.env["AETHER_TEST_SECRET_TOKEN"];
  process.env["AETHER_TEST_SECRET_TOKEN"] = "fixture-only-secret";
  const w = workspace();
  try {
    const result = await w.exec.runUserShell("printf '%s' \"${AETHER_TEST_SECRET_TOKEN-unset}\"; export LOCAL_ONLY=yes");
    assert.equal(result.output, "[exit 0]\nunset");
    assert.equal(process.env["LOCAL_ONLY"], undefined);
  } finally {
    if (prior === undefined) delete process.env["AETHER_TEST_SECRET_TOKEN"]; else process.env["AETHER_TEST_SECRET_TOKEN"] = prior;
    w.close();
  }
});

test("nested workspace commits use repo-relative names and refuse staged user paths anywhere in the index", { skip: !supported }, async () => {
  const w = workspace(true);
  const nested = new ToolExecutor(join(w.root, "subdir"));
  try {
    assert.equal(nested.execute("write_file", { path: "agent.txt", content: "owned" }).exitCode, 0);
    writeFileSync(join(w.root, "outside.txt"), "user");
    spawnSync("git", ["add", "outside.txt"], { cwd: w.root });
    const refused = nested.execute("git_commit", { message: "must not sweep outside index" });
    assert.equal(refused.exitCode, 1);
    assert.match(refused.output, /unexpected staged/);
    spawnSync("git", ["reset", "--", "outside.txt"], { cwd: w.root });
    const committed = nested.execute("git_commit", { message: "own nested path" });
    assert.equal(committed.exitCode, 0, committed.output);
    assert.equal(spawnSync("git", ["show", "--pretty=", "--name-only", "HEAD"], { cwd: w.root, encoding: "utf8" }).stdout.trim(), "subdir/agent.txt");
  } finally { w.close(); }
});
