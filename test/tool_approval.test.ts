import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostLoop } from "../src/commands/code.js";
import { runLocalTurn } from "../src/commands/chat.js";
import { CloudBrain } from "../src/core/brain_cloud.js";
import { ApiClient } from "../src/core/transport.js";
import type { Brain, TaskCommand } from "../src/core/brain.js";
import type { BrainEvent } from "../src/core/brain_protocol.js";
import type { AppContext } from "../src/core/context.js";
import type { TokenStore } from "../src/core/auth.js";
import { ToolExecutor, type ToolResult } from "../src/core/tool_executor.js";
import { ToolFailureBudget, operationKey } from "../src/core/tool_failure_budget.js";
import {
  MAX_DENIAL_FEEDBACK_BYTES,
  bindToolApprovalVerdict,
  boundedDenialFeedback,
  deniedToolResult,
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

test("patch approval prompt contains the exact affected diff", () => {
  const prepared = prepareToolApproval("patch_file", {
    path: "space é.txt", expected_sha256: "a".repeat(64), old_text: "before", new_text: "after",
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const preview = '--- "space é.txt"\n+++ "space é.txt"\n@@ line 1, column 1 @@\n- "before"\n+ "after"';
  const review = formatToolApprovalReview("patch_file", prepared.args, "/cwd", "/root", preview);
  assert.match(review, /Affected diff/);
  assert.ok(review.includes('- "before"\n+ "after"'));
  assert.ok(review.indexOf("Affected diff") < review.indexOf("Run this exact tool call"));
});

test("shared gate shows the whole command and denial does not execute", async () => {
  const prepared = prepareToolApproval("run_shell", { command: longCommand });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  let reviewed = "";
  let executed = 0;
  const approved = await requestToolApproval({
    callId: "reviewed",
    name: "run_shell", args: prepared.args, permissionMode: "ask", autoApply: false,
    yes: false, isTty: true, shellCwd: "/cwd", fileRoot: "/root",
    confirm: async (text) => { reviewed = text; return false; },
    onDeny: () => assert.fail("TTY must prompt"),
  });
  if (approved.approved) executed++;
  assert.equal(executed, 0);
  assert.ok(reviewed.includes("SUFFIX_AFTER_200"));
  assert.match(reviewed, /optional one-call instruction/);

  let prompted = false;
  const nonTty = await requestToolApproval({
    callId: "non-tty",
    name: "run_shell", args: prepared.args, permissionMode: "ask", autoApply: false,
    yes: false, isTty: false, shellCwd: "/cwd", fileRoot: "/root",
    confirm: async () => { prompted = true; return true; }, onDeny: () => {},
  });
  assert.deepEqual(nonTty, { callId: "non-tty", approved: false });
  assert.equal(prompted, false);
  const preapproved = await requestToolApproval({
    callId: "preapproved",
    name: "run_shell", args: prepared.args, permissionMode: "ask", autoApply: false,
    yes: true, isTty: false, shellCwd: "/cwd", fileRoot: "/root",
    confirm: async () => { prompted = true; return false; },
    feedback: async () => assert.fail("--yes cannot request denial feedback"), onDeny: () => {},
  });
  assert.deepEqual(preapproved, { callId: "preapproved", approved: true });
  assert.equal(prompted, false);
});

test("a declined call carries one bounded instruction under its original ID", async () => {
  const prepared = prepareToolApproval("run_tests", { command: "npm test" });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const verdict = await requestToolApproval({
    callId: "call-42", name: "run_tests", args: prepared.args,
    permissionMode: "ask", autoApply: false, yes: false, isTty: true,
    shellCwd: ".", fileRoot: ".", confirm: async () => false,
    feedback: async () => "Use the offline unit suite.", onDeny: () => assert.fail("interactive"),
  });
  assert.deepEqual(verdict, { callId: "call-42", approved: false, feedback: "Use the offline unit suite." });
  assert.match(deniedToolResult("run_tests", verdict).output, /Operator instruction for this denied call: Use the offline unit suite\./);
  assert.deepEqual(bindToolApprovalVerdict("other-call", verdict), { callId: "other-call", approved: false });
  assert.deepEqual(bindToolApprovalVerdict("call-42", { callId: "call-42", approved: true, feedback: "should disappear" }),
    { callId: "call-42", approved: true });
  assert.equal(boundedDenialFeedback(" "), null);
  assert.equal(Buffer.byteLength(boundedDenialFeedback("é".repeat(400))!, "utf8"), MAX_DENIAL_FEEDBACK_BYTES);
  assert.equal(boundedDenialFeedback("!echo ok\n/clear\x1b[2J"), "!echo ok /clear[2J");
});

test("denial feedback does not reset or widen the repeated-failure budget", () => {
  const call = { name: "run_shell", args: { command: "echo denied" } };
  const key = operationKey(call);
  const budget = new ToolFailureBudget({ budgets: { permission_refused: 1 } });
  budget.noteModelRound(1);
  assert.equal(budget.check(key, call).action, "allow");
  budget.record(key, call, deniedToolResult(call.name, { callId: "first", approved: false, feedback: "Try offline." }), "approval");
  budget.noteModelRound(2);
  const repeated = budget.check(key, call);
  assert.equal(repeated.action, "refuse");
  if (repeated.action === "refuse") assert.doesNotMatch(repeated.result.output, /Try offline/);
  budget.noteModelRound(3);
  assert.equal(budget.check(key, call).action, "stop");
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
  ids: string[] = [];
  constructor(private readonly name: string, private readonly args: Record<string, unknown>) {}
  run(_task: TaskCommand): AsyncIterable<BrainEvent> {
    const name = this.name;
    const args = this.args;
    return (async function* (): AsyncGenerator<BrainEvent> {
      yield { type: "tool_call", id: "one", name, args };
      yield { type: "done", ok: true, result: "done", remaining: 0, reason: "" };
    })();
  }
  sendToolResult(id: string, result: ToolResult): void { this.ids.push(id); this.results.push(result); }
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

test("host loop delivers denial feedback once for one call ID, even if the event repeats", async () => {
  const events: BrainEvent[] = [
    { type: "tool_call", id: "repeat-id", name: "run_shell", args: { command: "echo never" } },
    { type: "tool_call", id: "repeat-id", name: "run_shell", args: { command: "echo never" } },
    { type: "done", ok: true, result: "done", remaining: 0, reason: "" },
  ];
  const delivered: Array<{ id: string; result: ToolResult }> = [];
  const brain = {
    run: async function* () { for (const event of events) yield event; },
    sendToolResult: (id: string, result: ToolResult) => { delivered.push({ id, result }); },
    control() {}, close() {},
  } as unknown as Brain;
  let executions = 0;
  let reviews = 0;
  const exec = { executeAsync: async () => { executions++; return { output: "unexpected", exitCode: 0 }; } } as unknown as ToolExecutor;
  await hostLoop(brain, exec, () => {}, { type: "task", text: "test", cwd: ".", poolGb: 5 }, undefined,
    async ({ id }) => { reviews++; return { callId: id, approved: false, feedback: "Use the offline unit suite." }; },
    undefined, { failureBudget: false });
  assert.equal(executions, 0);
  assert.equal(reviews, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.id, "repeat-id");
  assert.equal(delivered[0]?.result.output.match(/Use the offline unit suite\./g)?.length, 1);
});

test("local chat returns declined feedback under the same call without running it", async () => {
  const priorTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  try {
    const brain = new OneToolBrain("run_shell", { command: "echo never" });
    let executions = 0;
    let feedbackPrompts = 0;
    const ctx = {
      cfg: { permissionMode: "ask", autoApply: false },
      flags: { cwd: process.cwd(), yes: false, json: true },
      confirm: async () => false,
      approvalFeedback: async () => { feedbackPrompts++; return "Use the offline unit suite."; },
    } as unknown as AppContext;
    await runLocalTurn(ctx, "test", undefined, { brain, exec: { executeAsync: async () => {
      executions++;
      return { output: "unexpected", exitCode: 0 };
    } } });
    assert.equal(executions, 0);
    assert.equal(feedbackPrompts, 1);
    assert.equal(brain.results.length, 1);
    assert.deepEqual(brain.ids, ["one"]);
    assert.match(brain.results[0]!.output, /Operator instruction for this denied call: Use the offline unit suite\./);
  } finally {
    if (priorTty) Object.defineProperty(process.stdin, "isTTY", priorTty);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
});

test("hosted dev-session receives the same one-call denial result and never runs the tool", async () => {
  const posts: Record<string, unknown>[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/agent/dev/sessions")) {
      return Response.json({ session_id: "approval-hosted", protocol_version: 1 });
    }
    if (url.endsWith("/tool-results")) {
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({});
    }
    if (url.includes("/stream")) {
      const frames = [
        { type: "tool_call", seq: 1, tool_call_id: "hosted-id", name: "run_shell", args: { command: "echo never" } },
        { type: "done", seq: 2, ok: true },
      ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("");
      return new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({});
  }) as typeof fetch;
  const token = { get: async () => "aek_fixture" } as unknown as TokenStore;
  const api = new ApiClient("https://example.invalid", token);
  (api as unknown as { fetchImpl: typeof fetch }).fetchImpl = fetchImpl;
  const priorFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  let executions = 0;
  const exec = { executeAsync: async () => { executions++; return { output: "unexpected", exitCode: 0 }; } } as unknown as ToolExecutor;
  try {
    const brain = new CloudBrain(api, undefined, { requireLocalAuthority: true });
    await hostLoop(brain, exec, () => {}, { type: "task", text: "test", cwd: process.cwd(), poolGb: 5 }, undefined,
      async ({ id }) => ({ callId: id, approved: false, feedback: "Use the offline unit suite." }),
      undefined, { failureBudget: false });
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  } finally { globalThis.fetch = priorFetch; }
  assert.equal(executions, 0);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.["tool_call_id"], "hosted-id");
  assert.equal(posts[0]?.["exit_code"], 1);
  assert.match(String(posts[0]?.["output"]), /Operator instruction for this denied call: Use the offline unit suite\./);
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
