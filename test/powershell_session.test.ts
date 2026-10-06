import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsoleShell, classifyConsoleInput } from "../src/commands/console_input.js";
import { ShellSession, type ShellCommandEvent } from "../src/core/shell_session.js";
import { discoverShellProfiles } from "../src/core/shell_profiles.js";
import { ToolExecutor } from "../src/core/tool_executor.js";
import { toolCallBinding } from "../src/core/tool_approval.js";

const windows = process.platform === "win32";
const ps = windows ? discoverShellProfiles().find(item => item.profile === "powershell") : undefined;
const windowsPowerShell = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

test("shell profile parser and unavailable PowerShell guidance", () => {
  assert.deepEqual(classifyConsoleInput("/shell-profile list"), { kind: "profile", action: "list" });
  assert.deepEqual(classifyConsoleInput("/shell-profile use powershell"), { kind: "profile", action: "use", profile: "powershell" });
  assert.deepEqual(classifyConsoleInput("/shell-profile use cmd"), { kind: "profile", action: "use", profile: "cmd" });
  assert.equal(classifyConsoleInput("/shell-profile use bash").kind, "error");
  const missing = discoverShellProfiles("win32", exe => exe.toLowerCase().includes("cmd")
    ? { lines: ["Microsoft Windows [Version fixture]"], reason: null }
    : { lines: [], reason: "not installed" });
  assert.equal(missing[0]?.ready, true);
  assert.equal(missing[1]?.ready, false);
  assert.match(missing[1]!.reason!, /Install PowerShell 7/);
});

test("Windows PowerShell retains native cwd, exports and functions for user and approved model commands", { skip: !windows || !ps?.ready }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-ps-ü-"));
  mkdirSync(join(root, "space ü"));
  const events: ShellCommandEvent[] = [];
  const session = new ShellSession(root, event => events.push(event), "powershell", ps!.executable!);
  const exec = new ToolExecutor(root, undefined, { mode: "coding", shellSession: session });
  const prior = process.env["AETHER_TEST_SECRET_TOKEN"];
  process.env["AETHER_TEST_SECRET_TOKEN"] = "never-inherited-282";
  try {
    const first = await exec.runUserCommand("Set-Location -LiteralPath 'space ü'; $env:AETHER_LOCAL_282='hello world'; function Get-Fixture282 { 'function survives' }");
    assert.equal(first.exitCode, 0, first.output);
    const second = await exec.runUserCommand("Write-Output (Get-Location).Path; Write-Output $env:AETHER_LOCAL_282; Get-Fixture282; Write-Output 'quoted one two'");
    assert.equal(second.exitCode, 0, second.output);
    assert.match(second.output, /space ü/);
    assert.match(second.output, /hello world/);
    assert.match(second.output, /function survives/);
    assert.match(second.output, /quoted one two/);
    const model = { command: "Write-Output (Get-Location).Path; Write-Output $env:AETHER_LOCAL_282; Get-Fixture282; Write-Output $env:AETHER_TEST_SECRET_TOKEN" };
    const approval = exec.shellContext;
    const third = await exec.executeAsync("run_shell", model, {
      expectedShellContext: approval, expectedToolCall: toolCallBinding("run_shell", model) ?? undefined,
    });
    assert.equal(third.exitCode, 0, third.output);
    assert.match(third.output, /space ü[\s\S]*hello world[\s\S]*function survives/);
    assert.doesNotMatch(third.output, /never-inherited-282/);
    assert.equal(session.cwd.toLowerCase(), join(root, "space ü").toLowerCase());
    assert.deepEqual(events.filter(event => event.state === "running").map(event => event.origin), ["user", "user", "model"]);
    assert.ok(events.every(event => event.profile === "powershell" && event.sessionId === session.id));
    assert.ok(events.filter(event => event.state === "completed").every(event => event.exitCode === 0 && event.cwd.includes("space ü")));
    const stale = await exec.executeAsync("run_shell", { command: "Write-Output STALE" }, { expectedShellContext: approval });
    assert.equal(stale.exitCode, 1);
    assert.match(stale.output, /fresh approval/);
  } finally {
    session.close();
    await new Promise(resolve => setTimeout(resolve, 700));
    rmSync(root, { recursive: true, force: true });
    if (prior === undefined) delete process.env["AETHER_TEST_SECRET_TOKEN"];
    else process.env["AETHER_TEST_SECRET_TOKEN"] = prior;
  }
});

test("Windows PowerShell cancellation, crash, timeout and reset discard state without replay", { skip: !windows || !ps?.ready }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-ps-recovery-"));
  const session = new ShellSession(root, undefined, "powershell", ps!.executable!);
  const exec = new ToolExecutor(root, undefined, { mode: "coding", shellSession: session });
  try {
    await exec.runUserCommand("$env:AETHER_LOCAL_282='old'");
    const abort = new AbortController();
    const pending = exec.runUserCommand("Start-Sleep -Seconds 30; New-Item -ItemType File -Path should-not-exist", { signal: abort.signal });
    setTimeout(() => abort.abort(), 150);
    const cancelled = await pending;
    assert.equal(cancelled.exitCode, 130, cancelled.output);
    assert.equal(session.state, "lost");
    assert.equal((await exec.runUserCommand("Write-Output NEVER")).exitCode, 1);
    session.reset();
    const fresh = await exec.runUserCommand("Write-Output $env:AETHER_LOCAL_282; Write-Output ready");
    assert.equal(fresh.exitCode, 0);
    assert.doesNotMatch(fresh.output, /old/);
    const timed = await exec.runUserCommand("Start-Sleep -Seconds 30", { timeoutMs: 100 });
    assert.equal(timed.exitCode, 124, timed.output);
    assert.equal(session.state, "lost");
    session.reset();
    const crashed = await exec.runUserCommand("exit 7");
    assert.equal(crashed.exitCode, 1, crashed.output);
    assert.match(crashed.output, /state lost/);
    session.reset();
    assert.equal((await exec.runUserCommand("Write-Output reset-ok")).exitCode, 0);
  } finally { session.close(); await new Promise(resolve => setTimeout(resolve, 700)); rmSync(root, { recursive: true, force: true }); }
});

test("Windows PowerShell 5 compatibility and bounded output isolate the next command", { skip: !windows || !existsSync(windowsPowerShell) }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-ps-v5-"));
  const session = new ShellSession(root, undefined, "powershell", windowsPowerShell);
  const exec = new ToolExecutor(root, undefined, { mode: "coding", shellSession: session });
  try {
    assert.equal((await exec.runUserCommand("$env:AETHER_LOCAL_282='v5'; function Get-Fixture282 { 'works ü' }")).exitCode, 0);
    const shared = await exec.runUserCommand("Write-Output $env:AETHER_LOCAL_282; Get-Fixture282; Write-Output 'quoted one two'");
    assert.equal(shared.exitCode, 0, shared.output);
    assert.match(shared.output, /v5[\s\S]*works ü[\s\S]*quoted one two/);
    const large = await exec.runUserCommand("Write-Output ('x' * 100000); Write-Output FINAL_282");
    assert.equal(large.exitCode, 0);
    assert.match(large.output, /UTF-8 bytes elided/);
    assert.ok(large.output.endsWith("FINAL_282\r\n"));
    const next = await exec.runUserCommand("Write-Output CLEAN_282");
    assert.equal(next.exitCode, 0);
    assert.doesNotMatch(next.output, /FINAL_282/);
    assert.match(next.output, /CLEAN_282/);
  } finally { session.close(); await new Promise(resolve => setTimeout(resolve, 700)); rmSync(root, { recursive: true, force: true }); }
});

test("Windows console profile switch preserves cmd compatibility and invalidates old approval context", { skip: !windows || !ps?.ready }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-ps-profile-"));
  mkdirSync(join(root, "nested"));
  let output = "";
  const shell = new ConsoleShell(root, text => { output += text; }, true);
  try {
    const before = shell.exec.shellContext;
    assert.equal(shell.profileCommand({ kind: "profile", action: "use", profile: "powershell" }), true);
    assert.notEqual(shell.exec.shellContext, before);
    await shell.run("Set-Location nested; $env:AETHER_LOCAL_282='persist'");
    assert.match(shell.prompt(), /powershell.*nested/);
    assert.equal(shell.profileCommand({ kind: "profile", action: "use", profile: "cmd" }), true);
    assert.match(shell.prompt(), /cmd/);
    assert.notEqual(shell.exec.shellContext, before);
    assert.equal(shell.session.cwd, root);
    const beforeReset = shell.exec.shellContext;
    await shell.run({ kind: "reset-shell" });
    assert.notEqual(shell.exec.shellContext, beforeReset);
    await shell.run("cd nested");
    assert.equal(shell.session.cwd, root, "cmd remains one-shot");
    await shell.run("echo %AETHER_LOCAL_282%");
    assert.doesNotMatch(output, /\"output\":\"\[exit 0\][^\"]*persist/);
  } finally { shell.close(); await new Promise(resolve => setTimeout(resolve, 700)); rmSync(root, { recursive: true, force: true }); }
});
