import { test } from "node:test";
import assert from "node:assert/strict";
import { runSummary, fmtDuration, type RunSummaryInput } from "../src/commands/code_support.js";
import type { TurnTerminalState } from "../src/core/turn_lifecycle.js";
import type { CheckReading } from "../src/core/verify_gate.js";
import { stripAnsi } from "../src/ui/theme.js";

const PASSED: CheckReading = { state: "passed", exitCode: 0, failing: 0, reason: "npm test exited 0" };
const failed = (failing: number | null, exitCode = 1): CheckReading => ({
  state: "failed",
  exitCode,
  failing,
  reason: `npm test exited ${exitCode}`,
});
const NOT_RUN: CheckReading = {
  state: "not_run",
  exitCode: null,
  failing: null,
  reason: "the coding turn ended before host verification",
};
const UNCONFIGURED: CheckReading = {
  state: "unconfigured",
  exitCode: null,
  failing: null,
  reason: "no --test-cmd was given",
};

function report(
  state: TurnTerminalState,
  check: CheckReading,
  cause: string | null = null,
  hint: string | null = null,
): RunSummaryInput {
  return { outcome: { state, hint }, check, cause };
}

const line = (input: RunSummaryInput, files = 4, secs = 192): string => stripAnsi(runSummary(input, files, secs));

test("fmtDuration reads like a stopwatch", () => {
  assert.equal(fmtDuration(45), "45s");
  assert.equal(fmtDuration(60), "1m00s");
  assert.equal(fmtDuration(192), "3m12s");
  assert.equal(fmtDuration(-3), "0s");
});

test("ok summary: verdict, blast radius, clock", () => {
  assert.equal(line(report("succeeded", PASSED)), "✓ ok · 4 files changed · tests green · 3m12s");
  assert.equal(line(report("succeeded", PASSED), 1, 45), "✓ ok · 1 file changed · tests green · 45s");
});

test("a completed red check surfaces the host's failing-test count", () => {
  assert.equal(line(report("incomplete", failed(2))), "✗ incomplete · 2 tests failing · 4 files changed · 3m12s");
  assert.equal(line(report("incomplete", failed(1)), 3, 60), "✗ incomplete · 1 test failing · 3 files changed · 1m00s");
});

test("a completed red check with no parseable count says the check failed, not that tests fail", () => {
  assert.equal(
    line(report("incomplete", failed(null, 2)), 3, 60),
    "✗ incomplete · check failed (exit 2) · 3 files changed · 1m00s",
  );
});

test("unverified summary explains how to become verified", () => {
  const s = line(report("incomplete", UNCONFIGURED), 2, 30);
  assert.ok(s.startsWith("— unverified · 2 files changed · 30s"), s);
  assert.match(s, /--test-cmd/);
});

// ── #275 regression: the reported reproduction ─────────────────────────────
// runSummary("incomplete", 0, 0, 12) used to print "✗ incomplete · tests failing
// · 0 files changed · 12s" for a run whose check never started. A footer is now
// rendered from the turn outcome plus what the check actually did.
test("#275: a run that ended before verification never claims tests are failing", () => {
  for (const state of ["incomplete", "failed", "cancelled", "timed_out"] as const) {
    const s = line(report(state, NOT_RUN, "the turn ended first"), 0, 12);
    assert.doesNotMatch(s, /failing/, s);
    assert.match(s, /verification not run/, s);
  }
});

test("cancellation before verification names the cancellation", () => {
  assert.equal(
    line(report("cancelled", NOT_RUN, "coding turn interrupted by SIGINT"), 0, 12),
    "■ cancelled · coding turn interrupted by SIGINT · verification not run · 0 files changed · 12s",
  );
});

test("a model stream timeout names the timeout and its next step", () => {
  assert.equal(
    line(
      report(
        "timed_out",
        NOT_RUN,
        "stream timed out after 120s with no data",
        "retry the prompt or run `aether doctor` to inspect connectivity",
      ),
      1,
      130,
    ),
    "✗ timed out · stream timed out after 120s with no data · verification not run · 1 file changed · 2m10s" +
      "  ⤷ retry the prompt or run `aether doctor` to inspect connectivity",
  );
});

test("an auth refusal names the refusal even when no --test-cmd was given", () => {
  const s = line(
    report("failed", UNCONFIGURED, "HTTP 401: unauthorized", "session expired or invalid — run `aether auth login` to sign in again"),
    0,
    3,
  );
  assert.equal(
    s,
    "✗ failed · HTTP 401: unauthorized · verification not run · 0 files changed · 3s" +
      "  ⤷ session expired or invalid — run `aether auth login` to sign in again",
  );
});

test("a failed turn whose check still ran reports both facts without conflating them", () => {
  assert.equal(
    line(report("failed", PASSED, "brain exploded")),
    "✗ failed · brain exploded · tests green · 4 files changed · 3m12s",
  );
  assert.equal(
    line(report("incomplete", failed(3), "connection ended before the coding brain delivered a terminal frame")),
    "✗ incomplete · connection ended before the coding brain delivered a terminal frame · 3 tests failing · 4 files changed · 3m12s",
  );
});

test("a check that timed out, was cancelled, or could not start is never failing", () => {
  const timedOut: CheckReading = {
    state: "timed_out",
    exitCode: null,
    failing: null,
    reason: "npm test did not finish within 120s",
  };
  assert.equal(
    line(report("timed_out", timedOut)),
    "✗ timed out · verification: npm test did not finish within 120s · 4 files changed · 3m12s",
  );
  const cancelled: CheckReading = {
    state: "cancelled",
    exitCode: null,
    failing: null,
    reason: "npm test was cancelled before it finished",
  };
  assert.equal(
    line(report("cancelled", cancelled)),
    "■ cancelled · verification: npm test was cancelled before it finished · 4 files changed · 3m12s",
  );
  const launch: CheckReading = {
    state: "launch_failed",
    exitCode: null,
    failing: null,
    reason: "npm test could not start: spawn ENOENT",
  };
  assert.equal(
    line(report("failed", launch)),
    "✗ failed · verification: npm test could not start: spawn ENOENT · 4 files changed · 3m12s",
  );
});

test("a long cause is clipped so the footer stays one line", () => {
  const s = line(report("failed", NOT_RUN, "x".repeat(400)));
  assert.ok(s.length < 200, s);
  assert.match(s, /…/);
});

test("a long worded cause is clipped at a word boundary", () => {
  const cause = "turn stalled after 120s with no meaningful progress; ".repeat(4);
  const s = line(report("timed_out", NOT_RUN, cause));
  const clippedCause = s.split(" · ")[1]!;
  assert.match(clippedCause, /\S…$/);
  assert.ok(cause.startsWith(clippedCause.slice(0, -1)), clippedCause);
  assert.match(clippedCause.slice(0, -1), /(progress;|turn|stalled|after|120s|with|no|meaningful)$/);
});

test("server text in a cause cannot inject terminal control sequences", () => {
  const s = runSummary(report("failed", NOT_RUN, "bad\x1b]0;pwned\x07 news"), 0, 1);
  assert.doesNotMatch(s, /\x1b\]0;pwned/);
});
