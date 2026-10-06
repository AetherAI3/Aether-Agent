// Issue #285 — repeated failed tool calls reach a bounded stop.
//
// The unit half pins the classifier, the canonical fingerprint and the budget
// arithmetic. The host half drives the REAL hostLoop (and the real OllamaBrain
// through its chat seam) with brains that never stop asking, and asserts on
// what actually happened: how many times the executor ran, how many times the
// operator was prompted, which call ids received results, and the terminal
// frame the loop produced. No assertion reads rendered prose to decide a stop.
//
// Semantics under test: an operation that has spent its class budget is first
// REFUSED (answered, not run, not prompted), and a request after that refusal
// STOPS the cycle. So a stuck model sees budget + 2 requests answered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  MAX_CONSECUTIVE_TOOL_FAILURES,
  TOOL_FAILURE_BUDGET,
  ToolFailureBudget,
  boundedGitRunner,
  canonicalJson,
  checkpointLines,
  checkpointRecord,
  classifyToolFailure,
  defaultToolFailureBudget,
  describeOperation,
  gitWorkspaceRevision,
  hostMayRetry,
  isReadOnlyShellCommand,
  operationKey,
  type ToolFailureCheckpoint,
  type ToolFailureDecision,
} from "../src/core/tool_failure_budget.js";
import {
  CodeTurnLifecycle,
  codeRunRecord,
  emitCodeTurnOutcome,
  hostLoop,
  verifyCodeTurn,
} from "../src/commands/code.js";
import { OllamaBrain } from "../src/core/brain_ollama.js";
import { ToolExecutor, type ToolResult } from "../src/core/tool_executor.js";
import type { BrainEvent } from "../src/core/brain_protocol.js";
import type { Brain, TaskCommand } from "../src/core/brain.js";
import type { ChatReply } from "../src/core/ollama.js";
import type { SkillRefusal } from "../src/core/skills/skill_errors.js";
import type { Runner } from "../src/core/worktree.js";

// ── fixtures ────────────────────────────────────────────────────────────────

type Call = { name: string; args: Record<string, unknown> };

/**
 * A brain that keeps asking. `plan` picks the next call from the index;
 * returning null ends with a clean `done`. Each call waits for its own
 * result, keyed by id, the way the real brains do.
 */
class LoopingBrain implements Brain {
  readonly results: Array<{ id: string; result: ToolResult }> = [];
  readonly emitted: string[] = [];
  closed = false;
  private readonly waiting = new Map<string, (result: ToolResult) => void>();

  constructor(
    private readonly plan: (index: number) => Call | null,
    private readonly max = 40,
  ) {}

  async *run(_task: TaskCommand): AsyncIterable<BrainEvent> {
    for (let index = 0; index < this.max && !this.closed; index += 1) {
      const call = this.plan(index);
      if (!call) break;
      const id = `call-${index}`;
      const reply = new Promise<ToolResult>((resolve) => this.waiting.set(id, resolve));
      this.emitted.push(id);
      yield { type: "tool_call", id, name: call.name, args: call.args };
      await reply;
    }
    if (!this.closed) yield { type: "done", ok: true, result: "done", remaining: 0, reason: "" };
  }

  sendToolResult(id: string, result: ToolResult): void {
    this.results.push({ id, result });
    const resolve = this.waiting.get(id);
    this.waiting.delete(id);
    resolve?.(result);
  }

  control(): { accepted: boolean; state: "closed" } {
    return { accepted: false, state: "closed" };
  }

  close(): void {
    this.closed = true;
    for (const [id, resolve] of this.waiting) {
      this.waiting.delete(id);
      resolve({ output: "[aborted]", exitCode: 130 });
    }
  }
}

/** An executor double: records every execution, answers from `respond`. */
class FakeExec {
  readonly executed: Call[] = [];
  configuredTestCommand = "";
  shellContext = "one-shot";
  shellCwd = ".";
  constructor(private readonly respond: (call: Call, attempt: number) => ToolResult | Promise<ToolResult>) {}
  async executeAsync(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.executed.push({ name, args });
    return this.respond({ name, args }, this.executed.length);
  }
}

function tempRoot(prefix = "aether-285-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function gitRoot(prefix: string): string | null {
  const root = tempRoot(prefix);
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    return root;
  } catch {
    return null;
  }
}

const task = (cwd: string): TaskCommand => ({ type: "task", text: "t", cwd, poolGb: 5 });

interface Driven {
  code: number;
  events: BrainEvent[];
  checkpoints: ToolFailureCheckpoint[];
  prompts: Call[];
}

async function drive(
  brain: Brain,
  exec: unknown,
  cwd: string,
  options: {
    approve?: boolean | ((call: Call) => boolean);
    signal?: AbortSignal;
    onResult?: (id: string, r: ToolResult) => void;
    skillGuard?: (tool: string) => SkillRefusal | null;
  } = {},
): Promise<Driven> {
  const events: BrainEvent[] = [];
  const checkpoints: ToolFailureCheckpoint[] = [];
  const prompts: Call[] = [];
  const approve = options.approve ?? true;
  const code = await hostLoop(
    brain,
    exec as ToolExecutor,
    (ev) => {
      events.push(ev);
    },
    task(cwd),
    options.onResult,
    async (call) => {
      prompts.push(call);
      return typeof approve === "function" ? approve(call) : approve;
    },
    options.skillGuard,
    {
      meaningfulProgressTimeoutMs: 0,
      ...(options.signal ? { signal: options.signal } : {}),
      onFailureCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    },
  );
  return { code, events, checkpoints, prompts };
}

function terminal(events: BrainEvent[]): Extract<BrainEvent, { type: "done" }> | undefined {
  return events.find((ev): ev is Extract<BrainEvent, { type: "done" }> => ev.type === "done");
}

function assertEveryCallAnsweredOnce(brain: LoopingBrain): void {
  assert.deepEqual(brain.results.map((entry) => entry.id), brain.emitted, "every emitted call id got exactly one result, in order");
}

/** Feed `check` then (when allowed) `record`, the order the hosts use. */
function attempt(budget: ToolFailureBudget, call: Call, result: ToolResult, origin: "execution" | "approval" | "validation" | "policy" = "execution"): ToolFailureDecision {
  const key = operationKey(call);
  const decision = budget.check(key, call);
  if (decision.action === "allow") budget.record(key, call, result, origin);
  return decision;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const policyRefusal = { code: "skill_tool_not_declared", detail: "run_shell is not declared by the active skill" } as unknown as SkillRefusal;

// ── classification ──────────────────────────────────────────────────────────

test("classifier maps host and executor failure texts onto the issue's classes", () => {
  const fail = (output: string, exitCode = 1): ToolResult => ({ output, exitCode });
  const cases: Array<[string, ToolResult, ReturnType<typeof classifyToolFailure>]> = [
    ["read_file", fail("[tool read_file rejected: missing required argument path]"), "invalid_arguments"],
    ["read_file", fail("[no such file: missing.ts]"), "invalid_arguments"],
    ["patch_file", fail("[patch rejected: hunk does not match]"), "invalid_arguments"],
    ["patch_file", fail("[tool patch_file error: hunk does not match]"), "invalid_arguments"],
    ["patch_file", fail("[patch rejected: conflict: file changed since read (current sha256 ab)]"), "stale_precondition"],
    ["patch_file", fail("[tool patch_file error: conflict: file changed while patch was staged]"), "stale_precondition"],
    ["read_file", fail("[read_file stale_revision: a.ts; restart from offset 0]"), "stale_precondition"],
    ["list_directory", fail("[directory listing conflict: path or contents changed; restart pagination]"), "stale_precondition"],
    ["run_shell", fail("[tool refused: arguments changed after approval; request fresh approval]"), "stale_precondition"],
    ["run_tests", fail("[no test_cmd configured — unverifiable]"), "unavailable"],
    ["nope", fail("[unknown tool: nope]"), "unavailable"],
    ["run_shell", fail("[spawn error ENOENT: spawn sh ENOENT]", 127), "unavailable"],
    ["read_file", fail("[read conflict: file changed during read: a.ts]"), "transient"],
    ["read_file", fail("[tool read_file error: refusing path outside workspace: ../x]"), "permission_refused"],
    ["read_file", fail("[read_file opened outside workspace: ../x]"), "permission_refused"],
    ["run_shell", fail("[timeout after 5s]\npartial", 124), "unknown_outcome"],
    ["write_file", fail("[timeout after 5s]", 124), "unknown_outcome"],
    ["run_shell", fail("[exit 1]\nboom"), "execution_failure"],
    ["run_tests", fail("[exit 2]\n3 failed"), "execution_failure"],
    // A command's own exit 124 (coreutils `timeout`) is an ordinary failure.
    ["run_shell", fail("[exit 124]\n", 124), "execution_failure"],
    // A filename that merely contains "conflict" is not a stale precondition.
    ["patch_file", fail("[tool patch_file error: hunk does not match in conflict.ts]"), "invalid_arguments"],
  ];
  for (const [name, result, expected] of cases) {
    assert.equal(classifyToolFailure(name, result), expected, `${name}: ${result.output}`);
  }
  assert.equal(classifyToolFailure("read_file", { output: "ok", exitCode: 0 }), null, "success is not a failure");
  assert.equal(classifyToolFailure("run_shell", { output: "[aborted]\n", exitCode: 130 }), null, "cancellation is not counted");
  assert.equal(classifyToolFailure("run_shell", { output: "x", exitCode: 1 }, "approval"), "permission_refused");
  assert.equal(classifyToolFailure("write_file", { output: "x", exitCode: 1 }, "policy"), "unavailable");
  assert.equal(classifyToolFailure("read_file", { output: "x", exitCode: 1 }, "validation"), "invalid_arguments");
});

test("classifier reads the REAL executor's failure output, not only hand-written strings", async () => {
  const root = tempRoot();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "existing.txt"), "kept\n");
  const exec = new ToolExecutor(root, "");
  try {
    const cases: Array<[string, Record<string, unknown>, ReturnType<typeof classifyToolFailure>]> = [
      ["read_file", { path: "missing.ts" }, "invalid_arguments"],
      ["read_file", {}, "invalid_arguments"],
      ["list_directory", { path: "missing-dir" }, "invalid_arguments"],
      ["read_file", { path: "../outside.txt" }, "permission_refused"],
      ["run_tests", {}, "unavailable"],
      // Replacing an existing file without a complete-read proof (#294).
      ["write_file", { path: "existing.txt", content: "clobber" }, "invalid_arguments"],
    ];
    for (const [name, args, expected] of cases) {
      const result = await exec.executeAsync(name, args);
      assert.notEqual(result.exitCode, 0, `${name} ${JSON.stringify(args)} fails: ${result.output}`);
      assert.equal(classifyToolFailure(name, result), expected, `${name}: ${result.output}`);
    }
  } finally {
    exec.close();
  }
});

test("only read-only transient failures may be retried by the host; a mutation never", () => {
  assert.equal(hostMayRetry("read_file", "transient"), true);
  assert.equal(hostMayRetry("list_directory", "transient"), true);
  assert.equal(hostMayRetry("run_shell", "transient"), false);
  assert.equal(hostMayRetry("write_file", "transient"), false);
  assert.equal(hostMayRetry("run_shell", "unknown_outcome"), false);
  assert.equal(hostMayRetry("read_file", "execution_failure"), false);
});

test("the canonical fingerprint ignores argument order and is a fixed-size digest", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  const one = operationKey({ name: "read_file", args: { path: "a", max_lines: 5 } });
  assert.equal(one, operationKey({ name: "read_file", args: { max_lines: 5, path: "a" } }));
  assert.notEqual(one, operationKey({ name: "read_file", args: { path: "b", max_lines: 5 } }));
  assert.equal(
    operationKey({ name: "write_file", args: { path: "a" } }, { policy: true }),
    operationKey({ name: "write_file", args: { path: "z" } }, { policy: true }),
    "a policy refusal is about the tool, not its arguments",
  );
  const big = operationKey({ name: "write_file", args: {} }, { binding: "x".repeat(1_000_000) });
  assert.match(big, /^[0-9a-f]{64}$/, "a megabyte binding is never stored as a key");
});

test("the rendered operation is bounded, redacted and terminal-safe", () => {
  const shown = describeOperation({ name: "run_shell", args: { command: "curl -H 'Authorization: Bearer abc.def.ghi' token=s3cr3t " + "x".repeat(400) } });
  assert.ok(!shown.includes("abc.def.ghi"), shown);
  assert.ok(!shown.includes("s3cr3t"), shown);
  assert.ok(shown.length <= 200, `bounded: ${shown.length}`);
  const bidi = describeOperation({ name: "run_shell", args: { command: "echo \u202Egnp.exe\u202C \x1b[31mred\n" } });
  assert.doesNotMatch(bidi, /[\u202A-\u202E\u2066-\u2069\x1b\n]/u, JSON.stringify(bidi));
  assert.equal(describeOperation({ name: "read_file", args: {} }), "read_file (no arguments)");
});

// ── the budget, in isolation ────────────────────────────────────────────────

const invalid: ToolResult = { output: "[tool read_file rejected: missing required argument path]", exitCode: 1 };

test("a spent operation is refused once without running, and stopped on the request after", () => {
  const budget = new ToolFailureBudget();
  const call = { name: "read_file", args: {} };
  for (let i = 1; i <= TOOL_FAILURE_BUDGET.invalid_arguments; i += 1) {
    assert.equal(attempt(budget, call, invalid, "validation").action, "allow", `attempt ${i} is allowed`);
  }
  const refused = attempt(budget, call, invalid, "validation");
  assert.equal(refused.action, "refuse");
  if (refused.action === "refuse") {
    assert.match(refused.result.output, /not executed and not re-prompted/);
    assert.match(refused.result.output, /Requesting it again stops this run/);
    assert.match(refused.result.output, /To recover: correct the read_file arguments/);
  }
  const stopped = attempt(budget, call, invalid, "validation");
  assert.equal(stopped.action, "stop");
  if (stopped.action !== "stop") return;
  assert.equal(stopped.checkpoint.attempts, 3, "two failures and one refused repeat");
  assert.equal(stopped.checkpoint.failureClass, "invalid_arguments");
  assert.equal(stopped.result.exitCode, 1);

  const corrected = { name: "read_file", args: { path: "a.ts" } };
  assert.equal(budget.check(operationKey(corrected), corrected).action, "allow", "a corrected argument is a new operation");
});

test("successful calls are never deduplicated and a success clears the failure", () => {
  const budget = new ToolFailureBudget();
  const call = { name: "read_file", args: { path: "a.ts" } };
  for (let i = 0; i < 50; i += 1) assert.equal(attempt(budget, call, { output: "content", exitCode: 0 }).action, "allow");
  attempt(budget, call, invalid);
  attempt(budget, call, { output: "content", exitCode: 0 });
  attempt(budget, call, invalid);
  attempt(budget, call, invalid);
  assert.equal(budget.check(operationKey(call), call).action, "refuse", "only the failures after the success count");
});

test("a change in relevant state resets the count; an unmeasurable state never stops", () => {
  let state = "r1";
  const budget = new ToolFailureBudget({ probe: () => state });
  const call = { name: "run_tests", args: { command: "npm test" } };
  const red: ToolResult = { output: "[exit 1]\n1 failed", exitCode: 1 };
  for (let i = 0; i < TOOL_FAILURE_BUDGET.execution_failure; i += 1) attempt(budget, call, red);
  assert.equal(budget.check(operationKey(call), call).action, "refuse", "same state: refused");
  state = "r2";
  assert.equal(budget.check(operationKey(call), call).action, "allow", "edited workspace: genuine progress allowed");

  const blind = new ToolFailureBudget({
    probe: () => {
      throw new Error("cannot measure");
    },
    maxConsecutiveFailures: 1_000,
  });
  for (let i = 0; i < 10; i += 1) assert.equal(attempt(blind, call, red).action, "allow", "never stopped on a guess about state");
});

test("a failing command that rewrites files itself does not look like progress", () => {
  // The command changes state DURING its own execution (a snapshot file, a
  // lockfile); nothing changes between attempts. Comparing each attempt's
  // pre-state with the previous post-state still sees a repeat.
  let state = 0;
  const budget = new ToolFailureBudget({ probe: () => `s${state}` });
  const call = { name: "run_tests", args: { command: "npm test -- -u" } };
  const key = operationKey(call);
  const outcomes: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const decision = budget.check(key, call);
    outcomes.push(decision.action);
    if (decision.action !== "allow") {
      if (decision.action === "stop") break;
      continue;
    }
    state += 1; // the failing run itself rewrote a file
    budget.record(key, call, { output: "[exit 1]\n1 failed", exitCode: 1 });
  }
  assert.deepEqual(outcomes, ["allow", "allow", "allow", "refuse", "stop"]);
});

test("a successful edit or shell command is a state change; host decisions are not", () => {
  const budget = new ToolFailureBudget();
  const tests = { name: "run_tests", args: { command: "npm test" } };
  const red: ToolResult = { output: "[exit 1]", exitCode: 1 };
  for (let i = 0; i < 3; i += 1) attempt(budget, tests, red);
  assert.equal(budget.check(operationKey(tests), tests).action, "refuse");

  const edit = { name: "write_file", args: { path: "src/a.ts", content: "x" } };
  attempt(budget, edit, { output: "[wrote src/a.ts · 1 bytes]", exitCode: 0 });
  assert.equal(budget.check(operationKey(tests), tests).action, "allow", "re-running tests after an edit stays valid");

  for (let i = 0; i < 3; i += 1) attempt(budget, tests, red);
  attempt(budget, { name: "run_shell", args: { command: "npm install" } }, { output: "[exit 0]", exitCode: 0 });
  assert.equal(budget.check(operationKey(tests), tests).action, "allow", "an environment change (npm install) is progress");

  // An operator "no" is bound to the operation, not to the workspace: an
  // unrelated edit does not put the same request in front of them again.
  const push = { name: "run_shell", args: { command: "git push --force" } };
  attempt(budget, push, { output: "[denied: run_shell not approved by user]", exitCode: 1 }, "approval");
  attempt(budget, edit, { output: "[wrote src/a.ts · 1 bytes]", exitCode: 0 });
  assert.equal(budget.check(operationKey(push), push).action, "refuse");
  assert.deepEqual(budget.preserved, { succeededCalls: 3, edits: 2, shellRuns: 1, filesChanged: ["src/a.ts"] });
});

test("a consecutive-failure streak stops a model that varies its invalid call", () => {
  const budget = new ToolFailureBudget();
  for (let i = 0; i < MAX_CONSECUTIVE_TOOL_FAILURES; i += 1) {
    const call = { name: "read_file", args: { path: `missing-${i}.ts` } };
    assert.equal(attempt(budget, call, { output: `[no such file: missing-${i}.ts]`, exitCode: 1 }).action, "allow");
  }
  const next = { name: "read_file", args: { path: "missing-next.ts" } };
  const decision = budget.check(operationKey(next), next);
  assert.equal(decision.action, "stop");
  if (decision.action === "stop") {
    assert.equal(decision.checkpoint.trigger, "failure_streak");
    assert.equal(decision.checkpoint.attempts, MAX_CONSECUTIVE_TOOL_FAILURES);
    assert.equal(decision.checkpoint.operation, "read_file missing-next.ts", "names the call actually stopped");
  }
});

test("the checkpoint names operation, reason, attempts, preserved work and one recovery choice", () => {
  const budget = new ToolFailureBudget();
  attempt(budget, { name: "patch_file", args: { path: "src/a.ts" } }, { output: "[patched src/a.ts · sha256 00]", exitCode: 0 });
  attempt(budget, { name: "run_shell", args: { command: "ls" } }, { output: "[exit 0]", exitCode: 0 });
  const call = { name: "run_shell", args: { command: "rm -rf build" } };
  attempt(budget, call, { output: "[denied: run_shell not approved by user]", exitCode: 1 }, "approval");
  assert.equal(budget.check(operationKey(call), call).action, "refuse");
  const decision = budget.check(operationKey(call), call);
  assert.equal(decision.action, "stop");
  if (decision.action !== "stop") return;
  const cp = decision.checkpoint;
  assert.equal(cp.operation, "run_shell rm -rf build");
  assert.equal(cp.failureClass, "permission_refused");
  assert.equal(cp.reason, "[denied: run_shell not approved by user]");
  assert.equal(cp.attempts, 2);
  assert.deepEqual(cp.preserved, { succeededCalls: 2, edits: 1, shellRuns: 1, filesChanged: ["src/a.ts"] });
  assert.match(cp.recovery, /approve run_shell when prompted|steer the task/);
  assert.doesNotMatch(cp.recovery, /--yes|permissionMode|skip/, "a refusal never suggests a broader permission");

  const lines = checkpointLines(cp).join("\n");
  for (const fragment of ["operation  run_shell rm -rf build", "attempts   2 failed or refused", "1 edit kept", "src/a.ts", "1 shell command run", "next       "]) {
    assert.ok(lines.includes(fragment), `checkpoint shows ${JSON.stringify(fragment)}:\n${lines}`);
  }
  const record = checkpointRecord(cp);
  assert.equal(record["failure_class"], "permission_refused");
  assert.equal(record["attempts"], 2);
  assert.deepEqual(record["preserved"], { succeeded_calls: 2, edits: 1, shell_runs: 1, files_changed: ["src/a.ts"] });
});

test("the path-guard refusal's recovery does not pretend an approval could lift it", () => {
  const budget = new ToolFailureBudget();
  const call = { name: "read_file", args: { path: "../secrets" } };
  attempt(budget, call, { output: "[tool read_file error: refusing path outside workspace: ../secrets]", exitCode: 1 });
  budget.check(operationKey(call), call);
  const decision = budget.check(operationKey(call), call);
  assert.equal(decision.action, "stop");
  if (decision.action === "stop") {
    assert.match(decision.checkpoint.recovery, /inside the workspace/);
    assert.doesNotMatch(decision.checkpoint.recovery, /approve/);
  }
});

test("the git workspace revision sees a second edit; the git probe is bounded and lock-free", () => {
  const root = gitRoot("aether-285-git-");
  if (!root) return;
  const seen: string[][] = [];
  const spy: Runner = (cmd, args, cwd) => {
    seen.push(args);
    return boundedGitRunner()(cmd, args, cwd);
  };
  writeFileSync(join(root, "a.txt"), "one\n");
  const first = gitWorkspaceRevision(spy, root);
  assert.ok(first, "a git work tree is measurable");
  assert.equal(gitWorkspaceRevision(spy, root), first, "stable when nothing changed");
  writeFileSync(join(root, "a.txt"), "two, longer\n");
  assert.notEqual(gitWorkspaceRevision(spy, root), first, "an edit to an already-changed file is seen");
  assert.equal(gitWorkspaceRevision(boundedGitRunner(), tempRoot("aether-285-nogit-")), null, "outside git: unmeasured");
  assert.equal(seen.length, 3, "one git process per probe (HEAD comes from --branch)");
  // A probe that cannot finish in time is UNMEASURED (it throws), never a
  // constant that could freeze a count — and never a hang.
  assert.throws(() => gitWorkspaceRevision(boundedGitRunner(1), root), /unmeasured/);

  // Rename records carry a second path; a later edit of the renamed file is seen.
  execFileSync("git", ["add", "a.txt"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "a"], { cwd: root });
  execFileSync("git", ["mv", "a.txt", "b.txt"], { cwd: root });
  const renamed = gitWorkspaceRevision(boundedGitRunner(), root);
  writeFileSync(join(root, "b.txt"), "renamed and edited, longer\n");
  assert.notEqual(gitWorkspaceRevision(boundedGitRunner(), root), renamed);
});

test("a git probe that times out or errors never stops a run", () => {
  const unmeasurable: Runner = () => ({ status: 127, stdout: "", stderr: "spawnSync git ETIMEDOUT" });
  const budget = defaultToolFailureBudget(tempRoot(), { shellContext: "s", configuredTestCommand: "" }, unmeasurable);
  const tests = { name: "run_shell", args: { command: "npm test" } };
  for (let i = 0; i < 6; i += 1) {
    assert.equal(attempt(budget, tests, { output: "[exit 1]", exitCode: 1 }).action, "allow", `attempt ${i + 1}`);
  }
});

test("read-only shell commands are recognized narrowly; anything else may change state", () => {
  for (const command of ["ls -la", "git status", "git diff HEAD", "cat package.json", "rg foo src", "find . -name '*.ts'", "/bin/ls"]) {
    assert.equal(isReadOnlyShellCommand(command), true, command);
  }
  for (const command of ["npm install", "git checkout main", "ls > out.txt", "cat a | tee b", "ls; rm -rf x", "echo $(touch x)", "find . -delete", "git stash", "make"]) {
    assert.equal(isReadOnlyShellCommand(command), false, command);
  }
});

test("a decided refusal is warned again, not stopped, when real work happened in between (reads do not count)", () => {
  const budget = new ToolFailureBudget();
  const push = { name: "run_shell", args: { command: "git push --force" } };
  attempt(budget, push, { output: "[denied]", exitCode: 1 }, "approval");
  assert.equal(budget.check(operationKey(push), push).action, "refuse");
  attempt(budget, { name: "read_file", args: { path: "a" } }, { output: "content", exitCode: 0 });
  attempt(budget, { name: "write_file", args: { path: "a", content: "x" } }, { output: "[wrote a]", exitCode: 0 });
  assert.equal(budget.check(operationKey(push), push).action, "refuse", "a re-ask after real work is a new question");
  attempt(budget, { name: "read_file", args: { path: "a" } }, { output: "content", exitCode: 0 });
  const decision = budget.check(operationKey(push), push);
  assert.equal(decision.action, "stop", "a read in between is not progress");
  if (decision.action === "stop") assert.equal(decision.checkpoint.attempts, 3);
});

test("model rounds: repeats inside one reply are refused, never stopped; the next reply stops", () => {
  const budget = new ToolFailureBudget();
  const call = { name: "run_shell", args: { command: "make" } };
  budget.noteModelRound(1);
  attempt(budget, call, { output: "[denied]", exitCode: 1 }, "approval");
  const inBatch = [1, 2, 3, 4].map(() => budget.check(operationKey(call), call).action);
  assert.deepEqual(inBatch, ["refuse", "refuse", "refuse", "refuse"], "the model has seen no result yet");
  budget.noteModelRound(2);
  assert.equal(budget.check(operationKey(call), call).action, "stop", "the model saw the refusal and asked again");
});

test("the streak warns the model first and names the failing tool's recovery", () => {
  const budget = new ToolFailureBudget();
  let lastNote: string | null = null;
  for (let i = 0; i < MAX_CONSECUTIVE_TOOL_FAILURES; i += 1) {
    const call = { name: "run_tests", args: { command: `npm test -- ${i}` } };
    attempt(budget, call, { output: "[exit 1]\n1 failed", exitCode: 1 });
    lastNote = budget.repeatNote(operationKey(call));
    if (i < MAX_CONSECUTIVE_TOOL_FAILURES - 3) assert.equal(lastNote, null, `no streak note yet at ${i + 1}`);
  }
  assert.match(lastNote ?? "", /8 tool calls in a row have failed; after 8 the run stops/);
  const next = { name: "read_file", args: { path: "x" } };
  const decision = budget.check(operationKey(next), next);
  assert.equal(decision.action, "stop");
  if (decision.action === "stop") {
    assert.equal(decision.checkpoint.tool, "run_tests", "recovery is about the tool that kept failing");
    assert.match(decision.checkpoint.recovery, /run_tests/);
  }
});

test("the default budget probes git only for failed shell/git calls, never for successes or host decisions", () => {
  const root = gitRoot("aether-285-probe-");
  if (!root) return;
  let probes = 0;
  const runner: Runner = (cmd, args, cwd) => {
    probes += 1;
    return boundedGitRunner()(cmd, args, cwd);
  };
  const budget = defaultToolFailureBudget(root, { shellContext: "s", configuredTestCommand: "" }, runner);
  const shell = { name: "run_shell", args: { command: "npm test" } };
  for (let i = 0; i < 20; i += 1) attempt(budget, shell, { output: "[exit 0]", exitCode: 0 });
  attempt(budget, shell, { output: "[denied]", exitCode: 1 }, "approval");
  attempt(budget, { name: "read_file", args: { path: "a" } }, { output: "[no such file: a]", exitCode: 1 });
  assert.equal(probes, 0, "successes, decisions and non-shell failures never spawn git");
  attempt(budget, { name: "run_shell", args: { command: "make" } }, { output: "[exit 2]", exitCode: 2 });
  assert.ok(probes > 0, "a failed shell call is measured");
});

test("defaultToolFailureBudget: an operator edit to the repository lets a failing command run again", () => {
  const root = gitRoot("aether-285-default-");
  if (!root) return;
  const budget = defaultToolFailureBudget(root, { shellContext: "s", configuredTestCommand: "" });
  const tests = { name: "run_tests", args: { command: "npm test" } };
  for (let i = 0; i < 3; i += 1) attempt(budget, tests, { output: "[exit 1]", exitCode: 1 });
  assert.equal(budget.check(operationKey(tests), tests).action, "refuse");
  writeFileSync(join(root, "new.ts"), "export {}\n");
  assert.equal(budget.check(operationKey(tests), tests).action, "allow", "an edited repository is genuine progress");
});

// ── through the real hostLoop ───────────────────────────────────────────────

test("hostLoop: a brain repeating the same invalid call is refused, then stopped — never executed", async () => {
  const root = tempRoot();
  const brain = new LoopingBrain(() => ({ name: "read_file", args: {} }));
  const exec = new FakeExec(() => ({ output: "should not run", exitCode: 0 }));
  const run = await drive(brain, exec, root);

  assert.equal(run.code, 1);
  assert.equal(exec.executed.length, 0, "an invalid call never reaches the executor");
  assert.equal(run.prompts.length, 0, "an invalid call never reaches the operator");
  assert.equal(brain.emitted.length, TOOL_FAILURE_BUDGET.invalid_arguments + 2, "fail, fail, refuse, stop");
  assertEveryCallAnsweredOnce(brain);
  assert.equal(run.checkpoints.length, 1);
  assert.equal(run.checkpoints[0]!.failureClass, "invalid_arguments");
  assert.equal(run.checkpoints[0]!.attempts, 3);
  const done = terminal(run.events);
  assert.ok(done, "the stop is delivered through the normal terminal frame");
  assert.equal(done!.ok, false);
  assert.equal(done!.reason, "no-progress");
  assert.match(done!.result, /read_file \(no arguments\) failed or was refused 3×/);
  const outputs = brain.results.map((r) => r.result.output);
  assert.ok(outputs[0]!.startsWith("[tool read_file rejected:") && !outputs[0]!.includes("[host"), "first failure delivered as-is");
  assert.match(outputs[1]!, /the next identical request will be refused/, "the model was warned");
  assert.match(outputs[2]!, /^\[host refused repeat: .*Requesting it again stops this run/);
  assert.match(outputs[3]!, /^\[host stopped repeated failure/);
  assert.equal(brain.closed, true);
});

test("hostLoop: a denied action is prompted once, never re-prompted, never executed", async () => {
  const root = tempRoot();
  const brain = new LoopingBrain(() => ({ name: "run_shell", args: { command: "rm -rf /tmp/x" } }));
  const exec = new FakeExec(() => ({ output: "ran", exitCode: 0 }));
  const run = await drive(brain, exec, root, { approve: false });

  assert.equal(run.prompts.length, 1, "exactly one approval prompt for the same denied action");
  assert.equal(exec.executed.length, 0, "the denied action never ran");
  assert.equal(brain.emitted.length, 3, "denied, refused, stopped");
  assertEveryCallAnsweredOnce(brain);
  assert.equal(run.checkpoints[0]!.failureClass, "permission_refused");
  assert.doesNotMatch(JSON.stringify(run.checkpoints[0]), /--yes|permissionMode/, "no escalation is offered");
});

test("hostLoop: an unrelated edit after a denial does not put the denied action in front of the operator again", async () => {
  const root = tempRoot();
  const plan: Call[] = [
    { name: "run_shell", args: { command: "git push --force" } },
    { name: "write_file", args: { path: "notes.txt", content: "x" } },
    { name: "run_shell", args: { command: "git push --force" } },
    { name: "run_shell", args: { command: "git push --force" } },
  ];
  const brain = new LoopingBrain((index) => plan[index] ?? null);
  const exec = new FakeExec(() => ({ output: "[wrote notes.txt]", exitCode: 0 }));
  const run = await drive(brain, exec, root, { approve: (call) => call.name !== "run_shell" });
  assert.equal(run.prompts.filter((call) => call.name === "run_shell").length, 1);
  assert.deepEqual(exec.executed.map((c) => c.name), ["write_file"]);
  assert.equal(run.checkpoints.length, 1);
  assert.equal(run.checkpoints[0]!.preserved.edits, 1, "the edit is reported as preserved");
});

test("hostLoop: a denied action does not unlock a different, more privileged one", async () => {
  const root = tempRoot();
  const plan = ["rm -rf build", "sudo rm -rf build", "rm -rf build", "rm -rf build"];
  const brain = new LoopingBrain((index) => (index < plan.length ? { name: "run_shell", args: { command: plan[index] } } : null));
  const exec = new FakeExec(() => ({ output: "ran", exitCode: 0 }));
  const run = await drive(brain, exec, root, { approve: false });
  assert.deepEqual(run.prompts.map((c) => c.args["command"]), ["rm -rf build", "sudo rm -rf build"], "the alternative went through the gate like any call");
  assert.equal(exec.executed.length, 0, "nothing ran without approval");
  assert.equal(run.checkpoints.length, 1, "the original denied action was then refused and stopped");
});

test("hostLoop: several identical calls batched in ONE model reply do not end the run before the model sees a result", async () => {
  const root = tempRoot();
  let chats = 0;
  const brain = new OllamaBrain({
    chat: async (): Promise<ChatReply> => {
      chats += 1;
      if (chats > 1) return { role: "assistant", content: "ok, I will work without the shell" } as unknown as ChatReply;
      return {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "a", function: { name: "run_shell", arguments: '{"command":"make"}' } },
          { id: "b", function: { name: "run_shell", arguments: '{"command":"make"}' } },
        ],
      } as unknown as ChatReply;
    },
  });
  const exec = new FakeExec(() => ({ output: "ran", exitCode: 0 }));
  // Both the skill-policy path and the operator-denial path.
  const policy = await drive(brain, exec, root, { skillGuard: (tool) => (tool === "run_shell" ? policyRefusal : null) });
  assert.equal(policy.checkpoints.length, 0, "a batch is answered, not stopped");
  assert.equal(terminal(policy.events)!.ok, true, "the model adapted after seeing the results");
  assert.equal(chats, 2);
  assert.equal(exec.executed.length, 0);

  chats = 0;
  const brain2 = new OllamaBrain({
    chat: async (): Promise<ChatReply> => {
      chats += 1;
      if (chats > 1) return { role: "assistant", content: "fine" } as unknown as ChatReply;
      return {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "a", function: { name: "run_shell", arguments: '{"command":"make"}' } },
          { id: "b", function: { name: "run_shell", arguments: '{"command":"make"}' } },
        ],
      } as unknown as ChatReply;
    },
  });
  const denied = await drive(brain2, exec, root, { approve: false });
  assert.equal(denied.checkpoints.length, 0);
  assert.equal(denied.prompts.length, 1, "the batched duplicate was refused without a second prompt");
});

/** An OllamaBrain whose model returns the given replies in order, then a final answer. */
function scriptedOllama(replies: Array<Array<{ name: string; args: string }>>): { brain: OllamaBrain; chats: () => number } {
  let chats = 0;
  const brain = new OllamaBrain({
    chat: async (): Promise<ChatReply> => {
      const calls = replies[chats];
      chats += 1;
      if (!calls) return { role: "assistant", content: "done differently" } as unknown as ChatReply;
      return {
        role: "assistant",
        content: "",
        tool_calls: calls.map((call, index) => ({ id: `r${chats}-${index}`, function: { name: call.name, arguments: call.args } })),
      } as unknown as ChatReply;
    },
  });
  return { brain, chats: () => chats };
}

test("hostLoop: a batch of 3–4 identical refused calls in ONE reply is answered, not stopped", async () => {
  const root = tempRoot();
  const make = { name: "run_shell", args: '{"command":"make"}' };
  const policy = scriptedOllama([[make, make, make]]);
  const exec = new FakeExec(() => ({ output: "ran", exitCode: 0 }));
  const underPolicy = await drive(policy.brain, exec, root, { skillGuard: (tool) => (tool === "run_shell" ? policyRefusal : null) });
  assert.equal(underPolicy.checkpoints.length, 0);
  assert.equal(terminal(underPolicy.events)!.ok, true, "the model saw all three results and adapted");

  const bad = { name: "read_file", args: "{}" };
  const invalidBatch = scriptedOllama([[bad, bad, bad, bad]]);
  const run = await drive(invalidBatch.brain, exec, root);
  assert.equal(run.checkpoints.length, 0, "fail, fail, refuse, refuse — still the same reply");
  assert.equal(exec.executed.length, 0);

  // …but the model asking again in its NEXT reply after seeing the refusal stops.
  const persistent = scriptedOllama([[bad, bad, bad], [bad]]);
  const stopped = await drive(persistent.brain, exec, root);
  assert.equal(stopped.checkpoints.length, 1);
  assert.equal(persistent.chats(), 2, "no model request after the stop");
});

test("hostLoop: a 9-call batch of different failures is not stopped mid-reply; the streak stops the next reply", async () => {
  const root = tempRoot();
  const batch = Array.from({ length: 9 }, (_, index) => ({ name: "read_file", args: JSON.stringify({ path: `guess-${index}.ts` }) }));
  const script = scriptedOllama([batch, [{ name: "read_file", args: '{"path":"guess-final.ts"}' }]]);
  const exec = new FakeExec((call) => ({ output: `[no such file: ${String(call.args["path"])}]`, exitCode: 1 }));
  const run = await drive(script.brain, exec, root);
  assert.equal(exec.executed.length, 9, "the whole batch ran");
  assert.equal(run.checkpoints.length, 1);
  assert.equal(run.checkpoints[0]!.trigger, "failure_streak");
  assert.equal(run.checkpoints[0]!.operation, "read_file guess-final.ts");
});

test("hostLoop: alternating a failing test with a read-only shell command is still bounded", async () => {
  const root = tempRoot();
  const exec = new FakeExec((call) =>
    call.name === "run_shell" ? { output: "[exit 0]\nfile list", exitCode: 0 } : { output: "[exit 1]\n1 failed", exitCode: 1 },
  );
  const brain = new LoopingBrain((index) =>
    index % 2 === 0 ? { name: "run_tests", args: { command: "npm test" } } : { name: "run_shell", args: { command: "ls -la" } },
  );
  const run = await drive(brain, exec, root);
  assert.equal(run.checkpoints.length, 1, "`ls` changes nothing, so the identical red run is a repeat");
  assert.equal(exec.executed.filter((c) => c.name === "run_tests").length, TOOL_FAILURE_BUDGET.execution_failure);
});

test("hostLoop: a skill-policy refusal repeated across replies is refused, then stopped", async () => {
  const root = tempRoot();
  const brain = new LoopingBrain(() => ({ name: "run_shell", args: { command: "make" } }));
  const exec = new FakeExec(() => ({ output: "ran", exitCode: 0 }));
  const run = await drive(brain, exec, root, { skillGuard: (tool) => (tool === "run_shell" ? policyRefusal : null) });
  assert.equal(exec.executed.length, 0);
  assert.equal(run.prompts.length, 0, "a policy refusal never reaches the operator");
  assert.equal(brain.emitted.length, 3);
  assert.equal(run.checkpoints[0]!.failureClass, "unavailable");
  assert.match(brain.results[0]!.result.output, /^\[refused by host policy: skill_tool_not_declared\]/);
});

test("hostLoop: an unavailable capability is bounded; a refreshed capability allows the identical call", async () => {
  const root = tempRoot();
  const exec: FakeExec = new FakeExec(() =>
    exec.shellContext === "live"
      ? { output: "[exit 0]\nok", exitCode: 0 }
      : { output: "[no console shell session]", exitCode: 1 },
  );
  // Identical binding every time; only the capability (the shell session) changes.
  const brain = new LoopingBrain((index) => {
    if (index === 1) exec.shellContext = "live";
    return index < 3 ? { name: "run_shell", args: { command: "pwd" } } : null;
  });
  const refreshed = await drive(brain, exec, root);
  assert.equal(refreshed.checkpoints.length, 0, "a refreshed capability is genuine progress");
  assert.equal(exec.executed.length, 3);

  const stuckExec = new FakeExec(() => ({ output: "[no test_cmd configured — unverifiable]", exitCode: 1 }));
  const stuck = await drive(new LoopingBrain(() => ({ name: "run_tests", args: {} })), stuckExec, root);
  assert.equal(stuckExec.executed.length, TOOL_FAILURE_BUDGET.unavailable);
  assert.equal(stuck.checkpoints[0]!.failureClass, "unavailable");
});

test("hostLoop: a stale patch is bounded; a changed file revision lets it through again", async () => {
  const root = tempRoot();
  writeFileSync(join(root, "a.txt"), "hello\n");
  const real = new ToolExecutor(root);
  let executions = 0;
  const counted = new Proxy(real, {
    get(target, property) {
      if (property === "executeAsync") {
        return (...args: Parameters<ToolExecutor["executeAsync"]>) => {
          executions += 1;
          return target.executeAsync(...args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const stale = { name: "patch_file", args: { path: "a.txt", expected_sha256: sha("stale\n"), old_text: "hello", new_text: "bye" } };
  try {
    const run = await drive(new LoopingBrain(() => stale), counted, root);
    assert.equal(executions, TOOL_FAILURE_BUDGET.stale_precondition, "the stale write was attempted, then refused and stopped");
    assert.equal(run.checkpoints[0]!.failureClass, "stale_precondition");
    assert.match(run.checkpoints[0]!.recovery, /re-read/);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "hello\n", "a stale patch never wrote");

    // The file changes between attempts (an operator edit): every repeat is
    // under a new revision, so none is refused, and the corrected digest applies.
    executions = 0;
    let revision = 0;
    const moving = new LoopingBrain((index) => {
      if (index < 4) return stale;
      if (index === 4) {
        const current = readFileSync(join(root, "a.txt"), "utf8");
        return { name: "patch_file", args: { path: "a.txt", expected_sha256: sha(current), old_text: "hello", new_text: "bye" } };
      }
      return null;
    });
    const progressed = await drive(moving, counted, root, {
      onResult: () => {
        revision += 1;
        if (revision < 5) writeFileSync(join(root, "a.txt"), `hello\n${"#".repeat(revision)}\n`);
      },
    });
    assert.equal(progressed.checkpoints.length, 0, "a changed file revision is genuine progress");
    assert.equal(executions, 5);
    assert.match(readFileSync(join(root, "a.txt"), "utf8"), /^bye\n/);
  } finally {
    real.close();
  }
});

test("hostLoop: re-running failed tests after each edit stays valid; unchanged re-runs are bounded", async () => {
  const root = tempRoot();
  writeFileSync(join(root, "impl.txt"), "broken\n");
  const exec = new FakeExec((call) => {
    if (call.name === "write_file") {
      writeFileSync(join(root, String(call.args["path"])), String(call.args["content"]));
      return { output: `[wrote ${String(call.args["path"])}]`, exitCode: 0 };
    }
    const fixed = readFileSync(join(root, "impl.txt"), "utf8").trim() === "fixed";
    return fixed ? { output: "[exit 0]\nall green", exitCode: 0 } : { output: "[exit 1]\n1 failed", exitCode: 1 };
  });
  const tests = { name: "run_tests", args: { command: "npm test" } };
  // Five red runs, each followed by a (still wrong) edit, then the real fix.
  const brain = new LoopingBrain((index) => {
    if (index >= 12) return null;
    if (index % 2 === 1) return { name: "write_file", args: { path: "impl.txt", content: index === 11 ? "fixed\n" : `attempt ${index}\n` } };
    return tests;
  });
  const progressed = await drive(brain, exec, root);
  assert.equal(progressed.checkpoints.length, 0, "every re-run followed an edit");
  assert.equal(exec.executed.filter((c) => c.name === "run_tests").length, 6);

  const execAgain = new FakeExec(() => ({ output: "[exit 1]\n1 failed", exitCode: 1 }));
  const stuck = await drive(new LoopingBrain(() => tests), execAgain, root);
  assert.equal(execAgain.executed.length, TOOL_FAILURE_BUDGET.execution_failure, "nonzero exits get a real budget, not one shot");
  assert.equal(stuck.checkpoints[0]!.failureClass, "execution_failure");
  assert.equal(stuck.checkpoints[0]!.attempts, 4);
});

test("hostLoop: a transient read is retried once by the host under the same call id", async () => {
  const root = tempRoot();
  const exec = new FakeExec((_call, attemptNo) =>
    attemptNo === 1 ? { output: "[read conflict: file changed during read: a.ts]", exitCode: 1 } : { output: "content", exitCode: 0 },
  );
  const brain = new LoopingBrain((index) => (index === 0 ? { name: "read_file", args: { path: "a.ts" } } : null));
  const run = await drive(brain, exec, root);
  assert.equal(exec.executed.length, 2, "one transparent host retry");
  assert.deepEqual(brain.results.map((r) => r.result), [{ output: "content", exitCode: 0 }], "one result, the retried one");
  assert.equal(run.checkpoints.length, 0);
});

test("hostLoop: an unknown mutation outcome is never replayed by the host", async () => {
  const root = tempRoot();
  const exec = new FakeExec(() => ({ output: "[timeout after 5s]\npartial", exitCode: 124 }));
  const brain = new LoopingBrain(() => ({ name: "run_shell", args: { command: "npm install" } }));
  const run = await drive(brain, exec, root);
  assert.equal(exec.executed.length, TOOL_FAILURE_BUDGET.unknown_outcome, "one execution per model request, no host replay");
  assert.equal(run.checkpoints[0]!.failureClass, "unknown_outcome");
  assert.match(run.checkpoints[0]!.recovery, /inspect the workspace/);
});

test("hostLoop: cancellation ends the turn as a cancellation, never as a failure checkpoint", async () => {
  const root = tempRoot();
  const abort = new AbortController();
  const exec = new FakeExec((_call, attemptNo) => {
    if (attemptNo === 2) abort.abort(new DOMException("coding turn interrupted by SIGINT", "AbortError"));
    return { output: "[exit 1]\nboom", exitCode: 1 };
  });
  const brain = new LoopingBrain(() => ({ name: "run_shell", args: { command: "false" } }));
  const checkpoints: ToolFailureCheckpoint[] = [];
  await assert.rejects(
    hostLoop(brain, exec as unknown as ToolExecutor, () => {}, task(root), undefined, async () => true, undefined, {
      meaningfulProgressTimeoutMs: 0,
      signal: abort.signal,
      onFailureCheckpoint: (cp) => checkpoints.push(cp),
    }),
    (err: unknown) => (err as Error).name === "AbortError",
  );
  assert.equal(exec.executed.length, 2);
  assert.equal(checkpoints.length, 0);
  assert.equal(brain.closed, true);
});

test("hostLoop: identical successful calls are never deduplicated", async () => {
  const root = tempRoot();
  const exec = new FakeExec(() => ({ output: "content", exitCode: 0 }));
  const brain = new LoopingBrain((index) => (index < 30 ? { name: "read_file", args: { path: "a.ts" } } : null));
  const run = await drive(brain, exec, root);
  assert.equal(exec.executed.length, 30);
  assert.equal(run.checkpoints.length, 0);
  assert.equal(terminal(run.events)!.ok, true);
});

test("hostLoop: failureBudget:false preserves the old unbounded behaviour for embedders", async () => {
  const root = tempRoot();
  const brain = new LoopingBrain(() => ({ name: "read_file", args: {} }), 10);
  await hostLoop(
    brain,
    new FakeExec(() => ({ output: "", exitCode: 0 })) as unknown as ToolExecutor,
    () => {},
    task(root),
    undefined,
    async () => true,
    undefined,
    { meaningfulProgressTimeoutMs: 0, failureBudget: false },
  );
  assert.equal(brain.emitted.length, 10);
});

// ── the real OllamaBrain under its 24-turn ceiling ──────────────────────────

test("OllamaBrain: a model stuck on one invalid call is stopped by the host far below its turn cap", async () => {
  const root = tempRoot();
  let chats = 0;
  const brain = new OllamaBrain({
    chat: async (): Promise<ChatReply> => {
      chats += 1;
      return {
        role: "assistant",
        content: "",
        tool_calls: [{ id: `tc-${chats}`, function: { name: "read_file", arguments: "{}" } }],
      } as unknown as ChatReply;
    },
  });
  const exec = new FakeExec(() => ({ output: "should not run", exitCode: 0 }));
  const run = await drive(brain, exec, root);
  assert.equal(chats, 4, "two failures, one refused repeat, the stop — not 24 model turns");
  assert.equal(exec.executed.length, 0);
  assert.equal(run.checkpoints[0]!.failureClass, "invalid_arguments");
  assert.equal(terminal(run.events)!.reason, "no-progress");
});

test("OllamaBrain: denied permission is prompted once even though each request has a fresh call id", async () => {
  const root = tempRoot();
  let chats = 0;
  const brain = new OllamaBrain({
    chat: async (): Promise<ChatReply> => {
      chats += 1;
      return {
        role: "assistant",
        content: "",
        tool_calls: [{ id: `fresh-${chats}`, function: { name: "run_shell", arguments: '{"command":"git push --force"}' } }],
      } as unknown as ChatReply;
    },
  });
  const exec = new FakeExec(() => ({ output: "ran", exitCode: 0 }));
  const run = await drive(brain, exec, root, { approve: false });
  assert.equal(run.prompts.length, 1);
  assert.equal(exec.executed.length, 0);
  assert.equal(chats, 3, "denied, refused, stopped — and no model request after the stop");
});

// ── the settled coding outcome ──────────────────────────────────────────────

test("a stopped coding turn settles incomplete even on a green check, and files as no-progress", async () => {
  const root = tempRoot();
  const turn = new CodeTurnLifecycle("t");
  await hostLoop(
    new LoopingBrain(() => ({ name: "read_file", args: {} })),
    new FakeExec(() => ({ output: "", exitCode: 0 })) as unknown as ToolExecutor,
    (ev) => {
      turn.observe(ev);
    },
    task(root),
    undefined,
    async () => true,
    undefined,
    { meaningfulProgressTimeoutMs: 0, onFailureCheckpoint: (cp) => turn.noteFailureCheckpoint(cp) },
  );
  assert.ok(turn.hasTerminalFrame);
  const green = new FakeExec(() => ({ output: "[exit 0]\nok", exitCode: 0 }));
  const { report, verification } = await verifyCodeTurn(turn, green as never, {
    testCmd: "npm test",
    signal: new AbortController().signal,
    timeoutMs: 5_000,
  });
  assert.equal(green.executed.length, 1, "the preserved work was still checked");
  assert.equal(report.check.state, "passed");
  assert.equal(report.outcome.state, "incomplete", "a green tree does not turn a stop into a success");
  assert.match(report.cause ?? "", /stopped repeated tool failure/);
  assert.match(report.outcome.hint ?? "", /correct the read_file arguments/);
  assert.equal(report.stopped?.failureClass, "invalid_arguments");
  assert.equal(codeRunRecord(report, verification).finalStatus, "no-progress");

  const lines: string[] = [];
  emitCodeTurnOutcome(report, true, (line) => lines.push(line));
  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  const checkpoint = record["checkpoint"] as Record<string, unknown>;
  assert.equal(checkpoint["failure_class"], "invalid_arguments");
  assert.equal(checkpoint["attempts"], 3);
  assert.equal(typeof checkpoint["recovery"], "string");
});
