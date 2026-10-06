// The kill-gate regression. The host's final status MUST come from a real test
// run, never the brain's self-report. These tests lock that contract shut so the
// old "trust done.ok" bug cannot return. See specs/aethercode_loop_fixes.md §12.1.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkNotRun,
  finalVerify,
  parseFailCount,
  verificationLaunchFailure,
  type BrainDone,
} from "../src/core/verify_gate.js";
import type { ToolResult } from "../src/core/tool_executor.js";

/** A scripted ToolExecutor stand-in that records its calls and returns a fixed result. */
function fakeExec(result: ToolResult) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    async executeAsync(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      calls.push({ name, args });
      return result;
    },
  };
}

const RED = (n: number): ToolResult => ({ output: `[exit 1]\n=== ${n} failed in 3.2s ===`, exitCode: 1 });
const GREEN: ToolResult = { output: "[exit 0]\n=== 24 passed in 3.2s ===", exitCode: 0 };

test("parseFailCount matches the brain regex (\\d+\\s+failed)", async () => {
  assert.equal(parseFailCount("[exit 1]\n=== 24 failed, 0 passed ==="), 24);
  assert.equal(parseFailCount("[exit 1]\n24  failed"), 24); // two spaces — the single-space regex missed this
  assert.equal(parseFailCount("[exit 0]\n=== 12 passed ==="), null);
  assert.equal(parseFailCount("segfault, no summary"), null);
});

// ── THE regression: the brain lies, the host catches it ─────────────────────
test("brain done.ok=true while host tests are RED → never ok", async () => {
  const exec = fakeExec(RED(1));
  const out = await finalVerify(exec, "pytest -q", { ok: true, remaining: 0, reason: "" });
  assert.notEqual(out.status, "ok"); // the old bug returned "ok" here
  assert.equal(out.status, "incomplete");
  assert.equal(out.remaining, 1);
  assert.equal(out.exitCode, 1);
});

test("24-bug corpus: brain self-reports ok but 24 still failing → incomplete, remaining 24", async () => {
  const exec = fakeExec(RED(24));
  const out = await finalVerify(exec, "pytest -q", { ok: true, remaining: 0, reason: "" });
  assert.equal(out.status, "incomplete");
  assert.equal(out.remaining, 24);
});

test("host GREEN → ok even if the brain gave up (host is authoritative)", async () => {
  const exec = fakeExec(GREEN);
  const out = await finalVerify(exec, "pytest -q", { ok: false, remaining: 24, reason: "stalled" });
  assert.equal(out.status, "ok");
  assert.equal(out.remaining, 0);
  assert.equal(out.exitCode, 0);
});

test("no test command → unverified, never ok (no ground truth to assert)", async () => {
  const exec = fakeExec(GREEN);
  const out = await finalVerify(exec, undefined, { ok: true, remaining: 0, reason: "" });
  assert.equal(out.status, "unverified");
  assert.equal(exec.calls.length, 0); // must NOT run anything when there is no gate
});

test("breaker reason is surfaced through a RED host (stalled/max-turns, not flat incomplete)", async () => {
  const stalled = await await finalVerify(fakeExec(RED(5)), "pytest -q", { ok: false, remaining: 5, reason: "stalled" });
  assert.equal(stalled.status, "stalled");
  const maxTurns = await await finalVerify(fakeExec(RED(2)), "pytest -q", { ok: false, remaining: 2, reason: "max-turns" });
  assert.equal(maxTurns.status, "max-turns");
});

test("RED with unparseable output falls back to the brain's remaining, not a -1 sentinel", async () => {
  const exec = fakeExec({ output: "[exit 1]\nsegfault, no summary line", exitCode: 1 });
  const out = await finalVerify(exec, "pytest -q", { ok: false, remaining: 7, reason: "" });
  assert.equal(out.status, "incomplete");
  assert.equal(out.remaining, 7);
});

test("null done (brain never reported) + RED → incomplete with the parsed count", async () => {
  const out = await await finalVerify(fakeExec(RED(3)), "pytest -q", null);
  assert.equal(out.status, "incomplete");
  assert.equal(out.remaining, 3);
});

test("the gate runs the host's own test command via run_tests", async () => {
  const exec = fakeExec(GREEN);
  finalVerify(exec, "pytest -q tests/unit", { ok: true, remaining: 0, reason: "" });
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0]?.name, "run_tests");
  assert.equal(exec.calls[0]?.args["command"], "pytest -q tests/unit");
});

test("the gate forwards command cancellation and timeout controls to the test process", async () => {
  const controller = new AbortController();
  let observed: { signal?: AbortSignal; timeoutMs?: number } | undefined;
  const exec = {
    async executeAsync(
      _name: string,
      _args: Record<string, unknown>,
      options?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<ToolResult> {
      observed = options;
      return GREEN;
    },
  };
  await finalVerify(exec, "pytest -q", { ok: true, remaining: 0, reason: "" }, false, {
    signal: controller.signal,
    timeoutMs: 321,
  });
  assert.equal(observed?.signal, controller.signal);
  assert.equal(observed?.timeoutMs, 321);
});

// ── brain ERROR is distinct from brain DONE ─────────────────────────────────
// A `done` event means the brain finished its loop (its self-doubt on a green tree
// is overruled — that is a genuine success). An `error` event means the brain
// CRASHED mid-run; a coincidentally-green tree must NOT be reported as a clean
// success. (Regression guard: the gate used to mask this and exit 0.)
test("brain ERROR + host GREEN → error, never ok (a crashed run is not a success)", async () => {
  const exec = fakeExec(GREEN);
  const out = await finalVerify(exec, "pytest -q", { ok: false, remaining: 0, reason: "" }, true);
  assert.equal(out.status, "error");
  assert.notEqual(out.exitCode, 0);
});

test("brain ERROR + no test command → error (not unverified)", async () => {
  const out = await await finalVerify(fakeExec(GREEN), undefined, null, true);
  assert.equal(out.status, "error");
});

test("brain ERROR + host RED → error, with the parsed failing count", async () => {
  const out = await await finalVerify(fakeExec(RED(4)), "pytest -q", null, true);
  assert.equal(out.status, "error");
  assert.equal(out.remaining, 4);
});

test("brain DONE self-reporting failure on a green tree stays ok (errored defaults false)", async () => {
  // The intentional 'host is authoritative' rule — a COMPLETED brain, not a crash.
  const out = await await finalVerify(fakeExec(GREEN), "pytest -q", { ok: false, remaining: 9, reason: "stalled" });
  assert.equal(out.status, "ok");
});

// Type-level: BrainDone is the subset of the done event the gate consumes.
test("BrainDone shape is { ok, remaining, reason }", async () => {
  const d: BrainDone = { ok: false, remaining: 1, reason: "stalled" };
  assert.equal(d.reason, "stalled");
});

// ── #275: the check reading says what the host's check actually did ────────
// The outcome above is the gate's verdict; the reading is the evidence under
// it. Every surface (footer, JSON, session record) renders the reading, so a
// check that never ran, or never finished, can never be described as failing.

test("check reading: a green host check is passed, with the real exit code", async () => {
  const out = await finalVerify(fakeExec(GREEN), "pytest -q", null);
  assert.deepEqual(out.check, { state: "passed", exitCode: 0, failing: 0, reason: "pytest -q exited 0" });
});

test("check reading: a red host check is failed, with the HOST's count only", async () => {
  const out = await finalVerify(fakeExec(RED(2)), "pytest -q", { ok: true, remaining: 0, reason: "" });
  assert.deepEqual(out.check, { state: "failed", exitCode: 1, failing: 2, reason: "pytest -q exited 1" });
});

test("check reading: an unparseable red check has an unknown count, never the brain's claim", async () => {
  const exec = fakeExec({ output: "[exit 2]\nsegfault, no summary line", exitCode: 2 });
  const out = await finalVerify(exec, "npm test", { ok: false, remaining: 7, reason: "" });
  assert.equal(out.remaining, 7, "the gate's own remaining keeps its documented fallback");
  assert.deepEqual(out.check, { state: "failed", exitCode: 2, failing: null, reason: "npm test exited 2" });
});

test("check reading: no test command is unconfigured, and nothing runs", async () => {
  const exec = fakeExec(GREEN);
  const out = await finalVerify(exec, undefined, { ok: true, remaining: 3, reason: "" });
  assert.equal(exec.calls.length, 0);
  assert.equal(out.check.state, "unconfigured");
  assert.equal(out.check.exitCode, null);
  assert.equal(out.check.failing, null, "the brain's remaining is not a failing count");
  assert.match(out.check.reason, /--test-cmd/);
});

test("check reading: a crashed brain with no test command still did not run a check", async () => {
  const out = await finalVerify(fakeExec(GREEN), undefined, null, true);
  assert.equal(out.status, "error");
  assert.equal(out.check.state, "unconfigured");
});

test("check reading: a check killed at its deadline timed out — it did not fail", async () => {
  const exec = fakeExec({ output: "[timeout after 120s]\n.....", exitCode: 124 });
  const out = await finalVerify(exec, "npm test", null, false, { timeoutMs: 120_000 });
  assert.equal(out.exitCode, 124, "the exit code contract is unchanged");
  assert.deepEqual(out.check, {
    state: "timed_out",
    exitCode: null,
    failing: null,
    reason: "npm test did not finish within 120s",
  });
});

test("check reading: a check killed by the operator was cancelled — it did not fail", async () => {
  const exec = fakeExec({ output: "[aborted]\n12 failed", exitCode: 130 });
  const out = await finalVerify(exec, "npm test", null);
  assert.equal(out.exitCode, 130);
  assert.deepEqual(out.check, {
    state: "cancelled",
    exitCode: null,
    failing: null,
    reason: "npm test was cancelled before it finished",
  });
});

test("check reading: an abort that lands as the check exits still reads as cancelled", async () => {
  const controller = new AbortController();
  const exec = {
    async executeAsync(): Promise<ToolResult> {
      controller.abort();
      return GREEN;
    },
  };
  const out = await finalVerify(exec, "npm test", null, false, { signal: controller.signal });
  assert.equal(out.check.state, "cancelled");
});

test("check reading: a shell's not-found / not-executable exit is a completed red check, named", async () => {
  // The shell ran; a script whose inner tool is missing exits the same way, so
  // this is evidence about the tree, not a launch failure.
  for (const [exitCode, why] of [[127, /exited 127 \(command not found\)/], [126, /exited 126 \(command not executable\)/]] as const) {
    const out = await finalVerify(fakeExec({ output: "sh: 1: npx: not found", exitCode }), "npx jest", null);
    assert.equal(out.check.state, "failed");
    assert.equal(out.check.exitCode, exitCode);
    assert.match(out.check.reason, why);
    assert.equal(out.exitCode, exitCode, "the exit code contract is unchanged");
  }
});

test("check reading: a check that itself exits 124 or 130 completed — only the executor's kill is incomplete", async () => {
  // `timeout 60 npm test` exits 124; a script may exit 130 on its own. Neither
  // carries the executor's marker, and neither may hide a real red result.
  for (const exitCode of [124, 130]) {
    const out = await finalVerify(fakeExec({ output: "=== 2 failed ===", exitCode }), "npm test", null);
    assert.deepEqual(out.check, {
      state: "failed",
      exitCode,
      failing: 2,
      reason: `npm test exited ${exitCode}`,
    });
    assert.equal(out.exitCode, exitCode);
  }
});

test("check reading: the command is redacted before any surface can render it", async () => {
  const red = await finalVerify(fakeExec(RED(1)), "API_KEY=not-a-real-value npm test", null);
  assert.doesNotMatch(red.check.reason, /not-a-real-value/);
  assert.match(red.check.reason, /API_KEY=\[REDACTED\] npm test exited 1/);
  const launch = verificationLaunchFailure("TOKEN=abc123 npm test", new Error("spawn ENOENT"));
  assert.doesNotMatch(launch.check.reason, /abc123/);
});

test("verificationLaunchFailure records a check the host could not start", () => {
  const out = verificationLaunchFailure("npm test", new Error("spawn /bin/sh ENOENT"));
  assert.equal(out.status, "error");
  assert.equal(out.exitCode, 1);
  assert.equal(out.remaining, 0);
  assert.deepEqual(out.check, {
    state: "launch_failed",
    exitCode: null,
    failing: null,
    reason: "npm test could not start: spawn /bin/sh ENOENT",
  });
});

test("checkNotRun says the check never started and why", () => {
  assert.deepEqual(checkNotRun("the coding turn was cancelled first"), {
    state: "not_run",
    exitCode: null,
    failing: null,
    reason: "the coding turn was cancelled first",
  });
});
