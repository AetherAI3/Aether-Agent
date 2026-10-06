// The final verification gate — ground truth, never the brain's self-report.
//
// The brain emits a `done` event with its own `ok`/`remaining`/`reason`, but a
// headless model can (and does) claim success while the tests are still red. So
// the HOST re-runs the test command itself after the loop and derives the run's
// terminal status from the real exit code. `done` is advisory: it only enriches a
// red result with the brain's breaker reason, and is never allowed to upgrade a red
// run to "ok". Extracted from cmdCode so it is unit-testable with a fake executor.
//
// Canonical: specs/aethercode_loop_fixes.md §12.1 (the kill-gate #1 instrument).

import type { RunOptions, ToolResult } from "./tool_executor.js";
import type { FinalStatus } from "./session_log.js";
import { redactInline } from "./redaction.js";

/** The subset of the brain's `done` event the gate consults. Advisory only. */
export interface BrainDone {
  ok: boolean;
  remaining: number;
  reason: string;
}

/** What the host runs to establish ground truth — a ToolExecutor, or a fake in tests. */
export interface VerifyRunner {
  // executeAsync, not execute: the shell-backed tools became asynchronous so a
  // timeout or Ctrl+C can reap the whole process tree. Naming the async method
  // here is deliberate — a fake that still implements the sync one will fail to
  // compile rather than quietly diverge from what production calls.
  executeAsync(name: string, args: Record<string, unknown>, options?: RunOptions): Promise<ToolResult>;
}

/**
 * What the host's own check actually did in this run. Distinct from the turn's
 * outcome: a model that failed and a test that failed are different facts, and
 * a check that never ran — or never finished — proves nothing either way.
 */
export type CheckState =
  | "passed" //        ran to completion and exited 0
  | "failed" //        ran to completion and exited non-zero
  | "timed_out" //     started, then killed at its deadline
  | "cancelled" //     started, then killed by the operator
  | "launch_failed" // the host could not start it
  | "not_run" //       never started: the turn ended first
  | "unconfigured"; // no --test-cmd, so there was nothing to run

/** The one verification reading every surface (footer, JSON, session record) renders. */
export interface CheckReading {
  state: CheckState;
  /** Exit code of a check that ran to completion; null for every other state. */
  exitCode: number | null;
  /** Failing count parsed from the HOST's output; null is unknown, never the brain's claim. */
  failing: number | null;
  /** Plain-language account of the reading, naming the command when one ran. */
  reason: string;
}

export interface VerifyOutcome {
  status: FinalStatus;
  /** Failing tests when not ok — parsed from the host run, else the brain's count. */
  remaining: number;
  /** The host test run's exit code (-1 when there was no gate to run). */
  exitCode: number;
  /** What the check actually did. `remaining` above is the gate's verdict input;
   * this is the evidence, and the only thing a surface may call "failing". */
  check: CheckReading;
}

/** A check that never started because the turn ended first. */
export function checkNotRun(reason: string): CheckReading {
  return { state: "not_run", exitCode: null, failing: null, reason };
}

const UNCONFIGURED: CheckReading = Object.freeze({
  state: "unconfigured",
  exitCode: null,
  failing: null,
  reason: "no --test-cmd was given, so nothing verified this run",
}) as CheckReading;

/** The host could not start the check at all (spawn failure). Status `error`,
 * exit 1: the same exit contract a failed verification has always had. */
export function verificationLaunchFailure(command: string, err: unknown): VerifyOutcome {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    status: "error",
    remaining: 0,
    exitCode: 1,
    check: {
      state: "launch_failed",
      exitCode: null,
      failing: null,
      reason: `${redactInline(command)} could not start: ${redactInline(detail)}`,
    },
  };
}

// ToolExecutor's own markers for a process IT killed. Exit codes alone cannot
// say that: `timeout 60 npm test` exits 124 and a script may exit 130 on its
// own — both are completed checks, and reading them as a timeout or a
// cancellation would hide a real red result.
const EXECUTOR_TIMEOUT = /^\[timeout after (\d+)s\]/;
const EXECUTOR_ABORT = /^\[aborted/;

/** Shell conventions worth naming in a failed check's reason. Still "failed":
 * the shell ran, and a script whose inner tool is missing exits the same way. */
const SHELL_EXIT_NOTES: Readonly<Record<number, string>> = { 126: "command not executable", 127: "command not found" };

/**
 * Read one host check result. Only a process the executor itself killed —
 * at its deadline, or on the operator's cancellation — is an incomplete check;
 * every other exit is a completed one. The command is redacted once here, so
 * every surface that renders the reason renders the same safe text.
 */
export function readCheck(command: string, result: ToolResult, aborted: boolean): CheckReading {
  const label = redactInline(command);
  if (aborted || (result.exitCode === 130 && EXECUTOR_ABORT.test(result.output))) {
    return { state: "cancelled", exitCode: null, failing: null, reason: `${label} was cancelled before it finished` };
  }
  const deadline = result.exitCode === 124 ? EXECUTOR_TIMEOUT.exec(result.output) : null;
  if (deadline) {
    return { state: "timed_out", exitCode: null, failing: null, reason: `${label} did not finish within ${deadline[1]}s` };
  }
  if (result.exitCode === 0) {
    return { state: "passed", exitCode: 0, failing: 0, reason: `${label} exited 0` };
  }
  const note = SHELL_EXIT_NOTES[result.exitCode];
  return {
    state: "failed",
    exitCode: result.exitCode,
    failing: parseFailCount(result.output),
    reason: `${label} exited ${result.exitCode}${note ? ` (${note})` : ""}`,
  };
}

/** Brain breaker reasons we surface through a red host (richer than flat "incomplete"). */
const BREAKERS = new Set<FinalStatus>(["stalled", "no-progress", "max-turns"]);

/** Pytest-style "<n> failed" if present, else null. Matches the brain's
 * `kernel.parse_fail_count` EXACTLY (`\d+\s+failed`) so host and brain agree on the
 * count — a single-space regex misses "24  failed" / a wrapped summary line. */
export function parseFailCount(output: string): number | null {
  const m = output.match(/(\d+)\s+failed/);
  return m ? parseInt(m[1]!, 10) : null;
}

/**
 * Derive the run's terminal status from the host's OWN final test run.
 *  - brain crashed (`errored`) → "error" (a crashed run is never a trustworthy
 *      success — a coincidentally-green tree must not be reported as "ok").
 *  - no test command  → "unverified" (cannot assert; never "ok"); nothing is run.
 *  - host tests green → "ok" (even if the brain COMPLETED and self-doubted — a
 *      `done.ok=false` on a green tree is genuine success; the host is authoritative).
 *  - host tests red   → the brain's breaker reason if it set one, else "incomplete";
 *                       remaining = the parsed fail count, else the brain's remaining.
 *
 * `errored` is true when the brain emitted an `error` event (vs a `done`). It is
 * distinct from `done.ok=false`: a completed-but-failing brain is overruled by a
 * green host, but a CRASHED brain is not — its run never reached a clean end.
 */
export async function finalVerify(
  exec: VerifyRunner,
  testCmd: string | undefined,
  done: BrainDone | null,
  errored = false,
  options: RunOptions = {},
): Promise<VerifyOutcome> {
  if (!testCmd) {
    return errored
      ? { status: "error", remaining: done?.remaining ?? 0, exitCode: 1, check: UNCONFIGURED }
      : { status: "unverified", remaining: done?.remaining ?? 0, exitCode: -1, check: UNCONFIGURED };
  }
  const verify = await exec.executeAsync("run_tests", { command: testCmd }, options);
  const check = readCheck(testCmd, verify, options.signal?.aborted === true);
  const remaining = parseFailCount(verify.output) ?? done?.remaining ?? 0;
  // A crashed brain is never "ok", even on a green tree; we still run the gate so
  // the failing count (if any) is logged.
  if (errored) {
    return {
      status: "error",
      remaining: verify.exitCode === 0 ? (done?.remaining ?? 0) : remaining,
      exitCode: 1,
      check,
    };
  }
  if (verify.exitCode === 0) {
    return { status: "ok", remaining: 0, exitCode: 0, check };
  }
  const status: FinalStatus =
    done && BREAKERS.has(done.reason as FinalStatus) ? (done.reason as FinalStatus) : "incomplete";
  return { status, remaining, exitCode: verify.exitCode || 1, check };
}
