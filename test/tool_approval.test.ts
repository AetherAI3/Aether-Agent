import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostLoop } from "../src/commands/code.js";
import { runLocalTurn } from "../src/commands/chat.js";
import type { Brain, TaskCommand } from "../src/core/brain.js";
import type { BrainEvent } from "../src/core/brain_protocol.js";
import type { AppContext } from "../src/core/context.js";
import { ToolExecutor, type ToolResult } from "../src/core/tool_executor.js";
import {
  formatToolApprovalReview,
  prepareToolApproval,
  requestToolApproval,
  terminalSafeReview,
} from "../src/core/tool_approval.js";
import { tmpWorkspace } from "./tmp_workspace.js";

const longCommand = `echo "${"quoted words ".repeat(19)}" && echo SUFFIX_AFTER_200`;

test("full long and multiline shell commands are reviewable with origin and cwd", () => {
  assert.ok(longCommand.indexOf("SUFFIX_AFTER_200") > 200);
  const command = `${longCommand}\necho second line`;
  const prepared = prepareToolApproval("run_shell", { command });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const review = formatToolApprovalReview("run_shell", prepared.args, "/actual/cwd", "/file/root");
  assert.match(review, /Model-requested tool approval/);
  assert.match(review, /Shell cwd: \/actual\/cwd/);
  assert.match(review, /File root: \/file\/root/);
  assert.ok(review.includes(longCommand));
  assert.match(review, /2 \| echo second line/);
  assert.ok(review.indexOf("SUFFIX_AFTER_200") > 200);
});

test("terminal controls and bidi controls render as inert visible escapes", () => {
  const unsafe = "echo before\x1b[2J\x1b]52;c;attack\x07\b\t\r\u202e\u200bafter";
  const rendered = terminalSafeReview(unsafe);
  assert.ok(rendered.includes("\\x1b[2J"));
  assert.ok(rendered.includes("\\x1b]52;c;attack\\x07"));
  assert.ok(rendered.includes("\\x08\\t\\r\\u202e\\u200b"));
  assert.doesNotMatch(rendered, /[\x00-\x1f\x7f-\x9f\u2028\u2029\p{Cf}]/u);
  assert.equal(terminalSafeReview("/path\nspoofed origin", false), "/path\\nspoofed origin");
  assert.notEqual(terminalSafeReview("\\x1b"), terminalSafeReview("\x1b"));
});

test("shared gate shows the whole command and denial does not execute", async () => {
  const prepared = prepareToolApproval("run_shell", { command: longCommand });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  let reviewed = "";
  let executed = 0;
  const approved = await requestToolApproval({
    name: "run_shell", args: prepared.args, permissionMode: "ask", autoApply: false,
    yes: false, isTty: true, shellCwd: "/cwd", fileRoot: "/root",
    confirm: async (text) => { reviewed = text; return false; },
    onDeny: () => assert.fail("TTY must prompt"),
  });
  if (approved) executed++;
  assert.equal(executed, 0);
  assert.ok(reviewed.includes("SUFFIX_AFTER_200"));

  let prompted = false;
  const nonTty = await requestToolApproval({
    name: "run_shell", args: prepared.args, permissionMode: "ask", autoApply: false,
    yes: false, isTty: false, shellCwd: "/cwd", fileRoot: "/root",
    confirm: async () => { prompted = true; return true; }, onDeny: () => {},
  });
  assert.equal(nonTty, false);
  assert.equal(prompted, false);
  const preapproved = await requestToolApproval({
    name: "run_shell", args: prepared.args, permissionMode: "ask", autoApply: false,
    yes: true, isTty: false, shellCwd: "/cwd", fileRoot: "/root",
    confirm: async () => { prompted = true; return false; }, onDeny: () => {},
  });
  assert.equal(preapproved, true);
  assert.equal(prompted, false);
});

test("configured run_tests command is the exact reviewed and executed command", () => {
  const fallback = `${longCommand}\necho configured suffix`;
  const prepared = prepareToolApproval("run_tests", {}, fallback);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.args["command"], fallback);
  const review = formatToolApprovalReview("run_tests", prepared.args, "/cwd", "/root");
  assert.ok(review.includes(longCommand));
  assert.match(review, /2 \| echo configured suffix/);
  assert.equal(prepareToolApproval("run_tests", { command: "echo explicit" }, fallback).ok, true);
  assert.equal(prepareToolApproval("run_shell", { command: 7 }).ok, false);
});

test("executor refuses changed arguments and cwd after approval", async () => {
  const dir = tmpWorkspace("aether-approval-binding-");
  try {
    const exec = new ToolExecutor(dir);
    const prepared = prepareToolApproval("write_file", { path: "approved.txt", content: "approved" });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const context = exec.shellContext;
    const changed = await exec.executeAsync("write_file", { path: "changed.txt", content: "changed" }, {
      expectedShellContext: context, expectedToolCall: prepared.binding,
    });
    assert.equal(changed.exitCode, 1);
    assert.match(changed.output, /arguments changed after approval/);
    assert.equal(existsSync(join(dir, "changed.txt")), false);
    const stale = await exec.executeAsync("write_file", prepared.args, {
      expectedShellContext: `${context}changed`, expectedToolCall: prepared.binding,
    });
    assert.equal(stale.exitCode, 1);
    assert.match(stale.output, /session\/cwd changed after approval/);
    assert.equal(existsSync(join(dir, "approved.txt")), false);
    const allowed = await exec.executeAsync("write_file", prepared.args, {
      expectedShellContext: context, expectedToolCall: prepared.binding,
    });
    assert.equal(allowed.exitCode, 0);
    assert.equal(readFileSync(join(dir, "approved.txt"), "utf8"), "approved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approved long command executes its distinguishing suffix", async (t) => {
  const dir = tmpWorkspace("aether-approval-suffix-");
  try {
    const exec = new ToolExecutor(dir);
    const prepared = prepareToolApproval("run_shell", { command: longCommand });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const review = formatToolApprovalReview("run_shell", prepared.args, exec.shellCwd, dir);
    assert.ok(review.includes("SUFFIX_AFTER_200"));
    const result = await exec.executeAsync("run_shell", prepared.args, {
      expectedShellContext: exec.shellContext, expectedToolCall: prepared.binding,
    });
    if (/spawn error EPERM/.test(result.output)) { t.skip("sandbox blocks child process spawning"); return; }
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("SUFFIX_AFTER_200"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

class OneToolBrain implements Brain {
  results: ToolResult[] = [];
  constructor(private readonly name: string, private readonly args: Record<string, unknown>) {}
  run(_task: TaskCommand): AsyncIterable<BrainEvent> {
    const name = this.name;
    const args = this.args;
    return (async function* (): AsyncGenerator<BrainEvent> {
      yield { type: "tool_call", id: "one", name, args };
      yield { type: "done", ok: true, result: "done", remaining: 0, reason: "" };
    })();
  }
  sendToolResult(_id: string, result: ToolResult): void { this.results.push(result); }
  control(): void {}
  close(): void {}
}

test("coding host loop denial never calls the executor", async () => {
  const brain = new OneToolBrain("run_shell", { command: longCommand });
  let executions = 0;
  const exec = { executeAsync: async (): Promise<ToolResult> => {
    executions++;
    return { output: "unexpected", exitCode: 0 };
  } } as unknown as ToolExecutor;
  const task: TaskCommand = { type: "task", text: "test", cwd: ".", poolGb: 5 };
  await hostLoop(brain, exec, () => {}, task, undefined, async () => false);
  assert.equal(executions, 0);
  assert.equal(brain.results.length, 1);
  assert.equal(brain.results[0]?.exitCode, 1);
});

test("local chat executes the validated snapshot with an argument binding", async () => {
  const brain = new OneToolBrain("run_shell", { command: longCommand });
  let seenArgs: Record<string, unknown> | undefined;
  let seenBinding: string | undefined;
  const ctx = {
    cfg: { permissionMode: "skip", autoApply: true },
    flags: { cwd: process.cwd(), yes: false, json: true },
    confirm: async () => assert.fail("skip mode must not prompt"),
  } as unknown as AppContext;
  await runLocalTurn(ctx, "test", undefined, {
    brain,
    exec: { executeAsync: async (_name, args, options) => {
      seenArgs = args;
      seenBinding = options?.expectedToolCall;
      return { output: "ok", exitCode: 0 };
    } },
  });
  assert.equal(seenArgs?.["command"], longCommand);
  const prepared = prepareToolApproval("run_shell", { command: longCommand });
  assert.equal(prepared.ok, true);
  if (prepared.ok) assert.equal(seenBinding, prepared.binding);
});

test("local chat refuses an unapproved model command without a TTY", async (t) => {
  if (process.stdin.isTTY) { t.skip("this test requires a non-TTY input"); return; }
  const brain = new OneToolBrain("run_shell", { command: longCommand });
  let executions = 0;
  const ctx = {
    cfg: { permissionMode: "ask", autoApply: false },
    flags: { cwd: process.cwd(), yes: false, json: true },
    confirm: async () => assert.fail("non-TTY must not prompt"),
  } as unknown as AppContext;
  await runLocalTurn(ctx, "test", undefined, {
    brain,
    exec: { executeAsync: async () => {
      executions++;
      return { output: "unexpected", exitCode: 0 };
    } },
  });
  assert.equal(executions, 0);
  assert.equal(brain.results[0]?.exitCode, 1);
});
