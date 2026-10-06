import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AppContext } from "../src/core/context.js";
import { getGoalForWorkspace, newGoal, newPhase, upsertGoal } from "../src/core/goals.js";
import { acceptedScopeDigest, goalRunLockPath, isPublicationToolCall, newGoalPhaseRun } from "../src/core/goal_run.js";
import { runSavedGoalPhase, controlSavedGoalPhase, type GoalCodeRunner } from "../src/commands/goal_run.js";
import { handleGoal } from "../src/commands/goals.js";
import { readCheck, type CheckReading } from "../src/core/verify_gate.js";
import { verifyAndRecord } from "../src/core/verify_run.js";
import { readVerification } from "../src/core/verification_record.js";
import { defaultRunner, repoRoot } from "../src/core/worktree.js";
import type { CodeRunFinished, CodeRunStarted } from "../src/commands/code.js";
import { CodeTurnLifecycle, hostLoop, verifyCodeTurn } from "../src/commands/code.js";
import { ToolExecutor } from "../src/core/tool_executor.js";
import type { Brain, TaskCommand } from "../src/core/brain.js";
import { recordingRunner, type VerifyRunResult } from "../src/core/verify_run.js";

const CHECK = "node check.cjs";

function scenario(criteria = [`${CHECK} passes`]) {
  const base = mkdtempSync(join(tmpdir(), "goal-run-"));
  const root = join(base, "repo");
  mkdirSync(root);
  const old = {
    goals: process.env["AETHER_GOALS_FILE"], config: process.env["AETHER_CONFIG_DIR"], logs: process.env["AETHER_LOG_DIR"],
  };
  process.env["AETHER_GOALS_FILE"] = join(base, "goals.json");
  process.env["AETHER_CONFIG_DIR"] = join(base, "config");
  process.env["AETHER_LOG_DIR"] = join(base, "logs");
  spawnSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "parser.txt"), "broken\n");
  writeFileSync(join(root, "check.cjs"), "const fs=require('fs'); process.exit(fs.existsSync('fixed.txt')||fs.readFileSync('parser.txt','utf8').includes('fixed')?0:1);\n");
  const goal = newGoal("Fix the existing parser", root);
  const phase = newPhase(1, "Repair parser", "Use the existing parser file");
  phase.completionCriteria = criteria;
  goal.phases = [phase];
  goal.plan = { state: "accepted", source: "repository", stack: ["Node.js"], relevantFiles: ["parser.txt"], checks: [CHECK], instructions: [], assumptions: [], constraints: ["do not publish"], verification: { state: "known", check: CHECK }, acceptedAt: new Date().toISOString() };
  upsertGoal(goal);
  let output = "";
  const out = new Writable({ write(chunk, _encoding, next) { output += chunk.toString(); next(); } });
  const ctx = { flags: { cwd: root, json: false, yes: false, audit: false }, confirm: async () => true } as unknown as AppContext;
  return {
    root, goal, ctx, out, output: () => output,
    saved: () => getGoalForWorkspace(goal.id, root)!,
    cleanup: () => {
      for (const [key, value] of Object.entries(old)) {
        const env = key === "goals" ? "AETHER_GOALS_FILE" : key === "config" ? "AETHER_CONFIG_DIR" : "AETHER_LOG_DIR";
        if (value === undefined) delete process.env[env]; else process.env[env] = value;
      }
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function fakeHost(root: string, mode: "green" | "red" | "stale" | "skipped" | "auth" | "refused" | "missing" = "green", sessionName = "fixture"): { run: GoalCodeRunner; calls: () => number; checks: () => number } {
  let calls = 0;
  let checks = 0;
  const run: GoalCodeRunner = async (_ctx, task, opts, workspaceRun) => {
    calls++;
    assert.match(task, /Run only phase phase-\d/);
    assert.match(task, /do not publish/);
    assert.equal(opts.workspaceMode, "current");
    assert.equal(opts.forbidPublication, true);
    assert.equal(opts.testCmd, CHECK);
    const started: CodeRunStarted = { sessionId: `${sessionName}-${calls}`, turnId: `turn-${calls}`, workspace: root, model: "fixture-model", checkCommand: CHECK };
    await opts.runObserver!.started(started);
    if (mode === "green" || mode === "stale" || mode === "refused" || mode === "missing") writeFileSync(join(root, "parser.txt"), "fixed\n");
    let check: CheckReading = { state: "not_run", exitCode: null, failing: null, reason: "host check did not run" };
    let recordedCheck: CodeRunFinished["recordedCheck"] = null;
    if (mode !== "skipped" && mode !== "auth") {
      const result = await verifyAndRecord({ async executeAsync() {
        checks++;
        const child = spawnSync(process.execPath, ["check.cjs"], { cwd: root, encoding: "utf8" });
        return { output: (child.stdout ?? "") + (child.stderr ?? ""), exitCode: child.status ?? 1 };
      } }, workspaceRun, repoRoot(workspaceRun, root)!, CHECK);
      check = readCheck(CHECK, { output: result.output, exitCode: result.exitCode }, false);
      recordedCheck = { reading: result.reading, written: result.written };
      if (mode === "stale") writeFileSync(join(root, "parser.txt"), "changed after check\n");
    }
    const state = mode === "auth" ? "failed" : mode === "red" ? "failed" : "succeeded";
    const finished = {
      ...started, touchedFiles: mode === "green" || mode === "stale" ? ["parser.txt"] : [], verification: null, recordedCheck,
      hostRefusals: mode === "refused" ? ["[denied: write_file not approved by user]"] : mode === "missing" ? ["[unknown tool: required_helper]"] : [],
      report: { outcome: { state, exitCode: state === "succeeded" ? 0 : 1, message: mode === "auth" ? "HTTP 401 authentication refused" : "host turn ended" }, check, cause: null },
    } as CodeRunFinished;
    await opts.runObserver!.finished(finished);
    return state === "succeeded" ? 0 : 1;
  };
  return { run, calls: () => calls, checks: () => checks };
}

test("one accepted phase runs in its workspace and completes only with a fresh host receipt", async () => {
  const s = scenario();
  try {
    const host = fakeHost(s.root);
    await runSavedGoalPhase(s.ctx, s.out, s.goal.id, false, { codeRunner: host.run });
    const phase = s.saved().phases[0]!;
    assert.equal(host.calls(), 1);
    assert.equal(host.checks(), 1);
    assert.equal(phase.run?.state, "complete", JSON.stringify(phase.run));
    assert.equal(phase.completionMethod, "verified");
    assert.equal(phase.run?.sessionId, "fixture-1");
    assert.equal(phase.run?.turnId, "turn-1");
    assert.equal(phase.run?.model, "fixture-model");
    assert.equal(phase.run?.check?.state, "passed");
    assert.equal(phase.run?.verification?.status, "verified");
    assert.notEqual(phase.run?.baseline?.digest, phase.run?.resulting?.digest);
    assert.deepEqual(phase.run?.touchedFiles, ["parser.txt"]);
    await runSavedGoalPhase(s.ctx, s.out, s.goal.id, false, { codeRunner: host.run });
    assert.equal(host.calls(), 1, "a completed phase is never replayed");
  } finally { s.cleanup(); }
});

test("goal runs reserve publication for the separate ship action", () => {
  assert.equal(isPublicationToolCall("run_shell", { command: "git push origin main" }), true);
  assert.equal(isPublicationToolCall("run_shell", { command: "aether ship" }), true);
  assert.equal(isPublicationToolCall("run_shell", { command: "npm test" }), false);
  assert.equal(isPublicationToolCall("write_file", { path: "README.md", content: "git push" }), false);
});

test("a coding fixture executes a real host file tool and final check for the saved phase", async () => {
  const s = scenario();
  let toolReplies = 0;
  const run: GoalCodeRunner = async (_ctx, task, opts, workspaceRun) => {
    const correlation: CodeRunStarted = { sessionId: "host-fixture", turnId: "host-turn", workspace: s.root, model: "fixture-brain", checkCommand: CHECK };
    await opts.runObserver!.started(correlation);
    const brain: Brain = {
      run: (_task: TaskCommand) => (async function* () {
        yield { type: "tool_call" as const, id: "create-fix", name: "write_file", args: { path: "fixed.txt", content: "fixed\n" } };
        yield { type: "done" as const, ok: true, result: "finished", remaining: 0, reason: "" };
      })(),
      sendToolResult: (_id, result) => { toolReplies++; assert.equal(result.exitCode, 0); },
      control: () => {}, close: () => {},
    };
    const exec = new ToolExecutor(s.root, CHECK, { mode: "coding" });
    const turn = new CodeTurnLifecycle(task);
    const command: TaskCommand = { type: "task", text: task, cwd: s.root, poolGb: 5, testCmd: CHECK };
    try {
      await hostLoop(brain, exec, (event) => { turn.observe(event); }, command, undefined, async () => true, undefined, { signal: opts.signal, failureBudget: false });
      let captured: VerifyRunResult | null = null;
      const root = repoRoot(workspaceRun, s.root)!;
      const verified = await verifyCodeTurn(turn, recordingRunner(exec, workspaceRun, root, result => { captured = result; }), {
        testCmd: CHECK, signal: opts.signal!, timeoutMs: 15_000,
      });
      const recordedCheck = captured ? { reading: (captured as VerifyRunResult).reading, written: (captured as VerifyRunResult).written } : null;
      await opts.runObserver!.finished({ ...correlation, touchedFiles: ["fixed.txt"], report: verified.report, verification: verified.verification, recordedCheck });
      return verified.report.outcome.exitCode;
    } finally { exec.close(); }
  };
  try {
    await runSavedGoalPhase(s.ctx, s.out, s.goal.id, false, { codeRunner: run });
    assert.equal(toolReplies, 1);
    assert.equal(existsSync(join(s.root, "fixed.txt")), true);
    assert.equal(s.saved().phases[0]?.run?.state, "complete", s.output());
    assert.equal(s.saved().phases[0]?.run?.verification?.status, "verified");
  } finally { s.cleanup(); }
});

test("the next phase waits for a separate explicit run action", async () => {
  const s = scenario();
  try {
    const goal = s.saved();
    const next = newPhase(2, "Verify the parser repair", "Run the existing check again");
    next.completionCriteria = [`${CHECK} passes`];
    goal.phases.push(next);
    upsertGoal(goal);
    const host = fakeHost(s.root);
    await runSavedGoalPhase(s.ctx, s.out, goal.id, false, { codeRunner: host.run });
    assert.equal(host.calls(), 1);
    assert.equal(s.saved().phases[0]?.status, "complete");
    assert.equal(s.saved().phases[1]?.status, "pending");
    assert.equal(s.saved().status, "idle");
    await runSavedGoalPhase(s.ctx, s.out, goal.id, false, { codeRunner: host.run });
    assert.equal(host.calls(), 2);
    assert.equal(s.saved().phases[1]?.status, "complete");
    assert.equal(s.saved().status, "complete");
  } finally { s.cleanup(); }
});

test("manual completion is labeled separately and never certifies a check", async () => {
  const s = scenario();
  try {
    await handleGoal(s.ctx, s.out, "start", s.goal.id);
    assert.equal(s.saved().status, "manual");
    await handleGoal(s.ctx, s.out, "complete", "phase-1");
    assert.equal(s.saved().phases[0]?.completionMethod, "manual");
    assert.equal(s.saved().phases[0]?.run, undefined);
    assert.match(s.output(), /does not certify tests/);
  } finally { s.cleanup(); }
});

test("editing an accepted phase invalidates its earlier verification receipt", async () => {
  const s = scenario();
  try {
    await runSavedGoalPhase(s.ctx, s.out, s.goal.id, false, { codeRunner: fakeHost(s.root).run });
    assert.equal(s.saved().phases[0]?.run?.state, "complete");
    await handleGoal(s.ctx, s.out, "edit", s.goal.id);
    await handleGoal(s.ctx, s.out, "phase", "title 1 Repair parser with a different scope");
    await handleGoal(s.ctx, s.out, "save", "");
    assert.equal(s.saved().phases[0]?.run, undefined);
    assert.equal(s.saved().phases[0]?.runHistory?.[0]?.state, "complete");
    assert.equal(s.saved().phases[0]?.status, "pending");
    assert.equal(s.saved().status, "idle");
  } finally { s.cleanup(); }
});

test("red, skipped, stale, and free-form criteria never become host-verified completion", async () => {
  for (const [mode, criteria, expected] of [
    ["red", [`${CHECK} passes`], "failed"],
    ["skipped", [`${CHECK} passes`], "verification_pending"],
    ["stale", [`${CHECK} passes`], "verification_pending"],
    ["green", ["Parser behavior is correct"], "verification_pending"],
    ["green", [`${CHECK} passes and no new dependencies`], "verification_pending"],
  ] as const) {
    const s = scenario([...criteria]);
    try {
      await runSavedGoalPhase(s.ctx, s.out, s.goal.id, false, { codeRunner: fakeHost(s.root, mode).run });
      assert.equal(s.saved().phases[0]?.run?.state, expected, mode);
      assert.notEqual(s.saved().phases[0]?.completionMethod, "verified", mode);
    } finally { s.cleanup(); }
  }
});

test("auth refusal records a blocked checkpoint without a completed phase", async () => {
  const s = scenario();
  try {
    await runSavedGoalPhase(s.ctx, s.out, s.goal.id, false, { codeRunner: fakeHost(s.root, "auth").run });
    assert.equal(s.saved().phases[0]?.run?.state, "blocked");
    assert.match(s.saved().phases[0]?.run?.reason ?? "", /401/);
    assert.equal(s.saved().phases[0]?.run?.sessionId, "fixture-1");
  } finally { s.cleanup(); }
});

test("an unknown accepted check leaves the coding result verification pending", async () => {
  const s = scenario();
  try {
    const goal = s.saved();
    goal.plan!.verification = { state: "unresolved", check: null };
    upsertGoal(goal);
    const run: GoalCodeRunner = async (_ctx, _task, opts) => {
      assert.equal(opts.testCmd, undefined);
      const correlation: CodeRunStarted = { sessionId: "no-check", turnId: "no-check-turn", workspace: s.root, model: "fixture", checkCommand: null };
      await opts.runObserver!.started(correlation);
      await opts.runObserver!.finished({ ...correlation, touchedFiles: [], recordedCheck: null, verification: null, report: {
        outcome: { state: "incomplete", exitCode: 1, message: "no host check" },
        check: { state: "unconfigured", exitCode: null, failing: null, reason: "no accepted check was configured" }, cause: null,
      } } as unknown as CodeRunFinished);
      return 1;
    };
    await runSavedGoalPhase(s.ctx, s.out, goal.id, false, { codeRunner: run });
    assert.equal(s.saved().phases[0]?.run?.state, "verification_pending");
    assert.match(s.saved().phases[0]?.run?.reason ?? "", /no accepted check/);
  } finally { s.cleanup(); }
});

test("permission refusal or missing host tool blocks completion even when the check is green", async () => {
  for (const mode of ["refused", "missing"] as const) {
    const s = scenario();
    try {
      await runSavedGoalPhase(s.ctx, s.out, s.goal.id, false, { codeRunner: fakeHost(s.root, mode).run });
      assert.equal(s.saved().phases[0]?.run?.state, "blocked");
      assert.match(s.saved().phases[0]?.run?.reason ?? "", /host refused a tool/);
    } finally { s.cleanup(); }
  }
});

test("resume carries the prior session and receipts without replaying host tools", async () => {
  const s = scenario();
  try {
    await runSavedGoalPhase(s.ctx, s.out, s.goal.id, false, { codeRunner: fakeHost(s.root, "auth").run });
    const next = fakeHost(s.root, "green", "resumed");
    const resume: GoalCodeRunner = async (ctx, task, opts, runner) => {
      assert.equal(opts.resume, "fixture-1");
      return next.run(ctx, task, opts, runner);
    };
    await runSavedGoalPhase(s.ctx, s.out, s.goal.id, true, { codeRunner: resume });
    assert.equal(next.calls(), 1);
    assert.equal(s.saved().phases[0]?.run?.state, "complete");
    assert.equal(s.saved().phases[0]?.run?.sessionId, "resumed-1");
    assert.equal(s.saved().phases[0]?.runHistory?.[0]?.state, "blocked");
    assert.equal(s.saved().phases[0]?.runHistory?.[0]?.sessionId, "fixture-1");
  } finally { s.cleanup(); }
});

test("resume refuses a workspace changed after its checkpoint", async () => {
  const s = scenario();
  try {
    await runSavedGoalPhase(s.ctx, s.out, s.goal.id, false, { codeRunner: fakeHost(s.root, "auth").run });
    writeFileSync(join(s.root, "parser.txt"), "user changed this after the checkpoint\n");
    let calls = 0;
    await runSavedGoalPhase(s.ctx, s.out, s.goal.id, true, { codeRunner: async () => { calls++; return 0; } });
    assert.equal(calls, 0);
    assert.equal(s.saved().phases[0]?.run?.state, "blocked");
    assert.match(s.saved().phases[0]?.run?.reason ?? "", /workspace changed since the checkpoint/);
  } finally { s.cleanup(); }
});

test("a second console cannot start the same live phase", async () => {
  const s = scenario();
  let unblock!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const run: GoalCodeRunner = async (_ctx, _task, opts) => {
    calls++;
    await opts.runObserver!.started({ sessionId: "pending", turnId: "turn-pending", workspace: s.root, model: "fixture", checkCommand: CHECK });
    started();
    await gate;
    return 1;
  };
  try {
    const first = runSavedGoalPhase(s.ctx, s.out, s.goal.id, false, { codeRunner: run });
    await ready;
    await runSavedGoalPhase(s.ctx, s.out, s.goal.id, false, { codeRunner: run });
    assert.equal(calls, 1);
    assert.match(s.output(), /already has a live or unreconciled run/);
    unblock();
    await first;
    assert.equal(s.saved().phases[0]?.run?.state, "blocked");
  } finally { unblock(); s.cleanup(); }
});

test("pause and cancel abort the real run and keep session checkpoints", async () => {
  for (const action of ["pause", "cancel"] as const) {
    const s = scenario();
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const run: GoalCodeRunner = async (_ctx, _task, opts) => {
      const correlation: CodeRunStarted = { sessionId: `${action}-session`, turnId: `${action}-turn`, workspace: s.root, model: "fixture", checkCommand: CHECK };
      await opts.runObserver!.started(correlation);
      ready();
      await new Promise<void>(resolve => opts.signal!.addEventListener("abort", () => resolve(), { once: true }));
      await opts.runObserver!.finished({ ...correlation, touchedFiles: [], verification: null, recordedCheck: null, report: {
        outcome: { state: "cancelled", exitCode: 130, message: `operator ${action}` },
        check: { state: "not_run", exitCode: null, failing: null, reason: "cancelled before check" }, cause: `operator ${action}`,
      } } as unknown as CodeRunFinished);
      return 130;
    };
    try {
      const inFlight = runSavedGoalPhase(s.ctx, s.out, s.goal.id, false, { codeRunner: run, controlPollMs: 10 });
      await started;
      controlSavedGoalPhase(s.ctx, s.out, action, s.goal.id);
      await inFlight;
      assert.equal(s.saved().phases[0]?.run?.state, action === "pause" ? "paused" : "cancelled");
      assert.equal(s.saved().phases[0]?.run?.sessionId, `${action}-session`);
      assert.equal(s.saved().status, "paused");
    } finally { s.cleanup(); }
  }
});

test("restart reconciliation consumes a finished session without replaying its tools", async () => {
  const s = scenario();
  try {
    writeFileSync(join(s.root, "parser.txt"), "fixed\n");
    const runner = defaultRunner();
    await verifyAndRecord({ async executeAsync() { return { output: "", exitCode: 0 }; } }, runner, repoRoot(runner, s.root)!, CHECK);
    const goal = s.saved();
    const phase = goal.phases[0]!;
    const prior = newGoalPhaseRun(goal, phase, s.root);
    prior.startedAt = "2020-01-01T00:00:00.000Z";
    prior.sessionId = "finished-session";
    prior.turnId = "finished-turn";
    prior.acceptedScopeDigest = acceptedScopeDigest(goal, phase);
    phase.run = prior;
    goal.status = "running";
    goal.activePhaseId = phase.id;
    upsertGoal(goal);
    const session = join(process.env["AETHER_LOG_DIR"]!, "finished-session");
    mkdirSync(session, { recursive: true });
    const record = readVerification(repoRoot(runner, s.root)!)!;
    writeFileSync(join(session, "manifest.json"), JSON.stringify({ cwd: s.root, ended: new Date().toISOString(), finalStatus: "ok", verification: { state: "passed", exitCode: 0, reason: `${CHECK} exited 0` }, verificationRecord: record }));
    const lock = goalRunLockPath(process.env["AETHER_GOALS_FILE"]!, goal.id, phase.id);
    mkdirSync(join(lock, ".."), { recursive: true });
    writeFileSync(lock, JSON.stringify({ attemptId: prior.attemptId, pid: 99999999, host: hostname(), startedAt: prior.startedAt }));
    let calls = 0;
    await runSavedGoalPhase(s.ctx, s.out, goal.id, true, { codeRunner: async () => { calls++; return 0; } });
    assert.equal(calls, 0, JSON.stringify(s.saved().phases[0]?.run));
    assert.equal(s.saved().phases[0]?.run?.state, "complete");
    assert.match(s.output(), /no tools replayed/);
  } finally { s.cleanup(); }
});
