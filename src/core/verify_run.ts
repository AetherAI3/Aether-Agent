// verify_run.ts — the writer for verification_record.ts.
//
// A stored verification is only worth reading if something stores one, and the
// class of defect this repository keeps finding is the field that exists with
// nothing writing it. This is that writer, and it is the ONLY one: the rail
// reads a verification through classifyVerification and writes one through
// here, so there is a single place where "verified" can be created and a single
// set of conditions under which it can be.
//
// The condition that matters is attribution. A test run takes time, and a
// working tree can move while it runs — the agent writes another file, the user
// saves in their editor. The result is then true of a tree that no longer
// exists, and nobody can say which one it was true of. So the tree is
// identified before AND after the run, and a run whose tree moved underneath it
// is reported as unattributable rather than recorded. It is the same rule
// classifyVerification enforces on read, applied at the moment of writing so a
// misleading record is never created in the first place.
//
// The command itself is executed by the caller's VerifyRunner — the same
// interface verify_gate.ts uses, and the same ToolExecutor in production. No
// command string is assembled or interpreted here.

import { parseFailCount, readCheck, type CheckReading, type VerifyRunner } from "./verify_gate.js";
import type { RunOptions, ToolResult } from "./tool_executor.js";
import {
  VERIFICATION_RECORD_VERSION,
  classifyVerification,
  treeIdentity,
  writeVerification,
  type TreeIdentity,
  type VerificationReading,
  type VerificationRecord,
} from "./verification_record.js";
import type { Runner } from "./worktree.js";

export interface VerifyRunResult {
  reading: VerificationReading;
  /** The record that was written, or null when none was. */
  written: VerificationRecord | null;
  /** The raw output of the run, for the caller to render or discard. */
  output: string;
  exitCode: number;
  /** False when the check never ran to completion (no command, killed at its
   * deadline, or cancelled) — as opposed to a completed run whose tree moved. */
  completed: boolean;
}

export interface VerifyRunOptions {
  now?: string;
  /** Cancellation and deadline for the check process, forwarded unchanged. */
  run?: RunOptions;
}

/** A check that ended without a result of its own: cancelled, or killed at its deadline. */
export type RunInterruption = "interrupted" | "timed_out";

/**
 * Whether the executor ended the check rather than the check ending itself.
 *
 * Read from the CheckReading every surface renders (verify_gate readCheck),
 * which trusts the executor's own markers and an aborted signal — never an
 * exit code alone. `timeout 60 npm test` exiting 124, or a script exiting 130
 * by itself, is a completed red check, and is attributed and recorded as one.
 */
export function checkInterruption(check: CheckReading): RunInterruption | null {
  if (check.state === "cancelled") return "interrupted";
  if (check.state === "timed_out") return "timed_out";
  return null;
}

export interface ReadRunOptions {
  /** ISO time the record would carry. */
  now: string;
  /** Set when the command did not finish on its own (checkInterruption). */
  interruption?: RunInterruption | null;
  /** The check reading's own account of that interruption, so the review rail
   *  and the agent footer word it alike; a plain sentence otherwise. */
  interruptionReason?: string;
}

/**
 * What one host test run proved, and about which tree — WITHOUT recording it.
 *
 * verifyAndRecord writes what this returns, and the coding run's final gate
 * and `aether review verify` both run through verifyAndRecord — so the reading
 * recorded for the review rail is the reading an RC viewer is shown
 * (commands/rc_verification.ts). The rules, checked in this order:
 *
 *  1. interrupted or timed out → "unknown". The exit code is the executor's
 *     verdict on a killed process, not the test suite's, so it is not a
 *     trustworthy exit code — even when it happens to be 0.
 *  2. a tree identity that is missing or incomplete → "unknown". Two blind
 *     digests compare equal whatever happened in between.
 *  3. the tree moved between the identities → "unknown".
 *  4. otherwise the record is built from the AFTER identity and read back
 *     through classifyVerification, the same reader a later `aether review`
 *     uses, so the status shown now and in ten minutes come from one place.
 */
export function readVerifierRun(
  command: string,
  result: { exitCode: number; output: string },
  before: TreeIdentity | null,
  after: TreeIdentity | null,
  options: ReadRunOptions,
): { reading: VerificationReading; record: VerificationRecord | null } {
  if (options.interruption) {
    const ended = options.interruption === "timed_out" ? "timed out" : "was interrupted";
    const why = options.interruptionReason ?? `${command} ${ended} before it finished`;
    return {
      reading: {
        status: "unknown",
        reason: `${why} — nothing was verified`,
        record: null,
        cause: options.interruption,
      },
      record: null,
    };
  }
  if (!before || !after || before.complete === false || after.complete === false) {
    return {
      reading: {
        status: "unknown",
        reason: `the working tree could not be identified around ${command} — the result cannot be attributed to any tree`,
        record: null,
        cause: "unattributed",
      },
      record: null,
    };
  }
  if (before.digest !== after.digest || before.head !== after.head) {
    return {
      reading: {
        status: "unknown",
        reason: `the working tree changed while ${command} was running — the result describes no tree that exists`,
        record: null,
        cause: "tree_moved_during_run",
      },
      record: null,
    };
  }
  const record: VerificationRecord = {
    version: VERIFICATION_RECORD_VERSION,
    command,
    exitCode: result.exitCode,
    ranAt: options.now,
    head: after.head,
    treeDigest: after.digest,
    remaining: parseFailCount(result.output),
  };
  return { reading: classifyVerification(record, after), record };
}

/**
 * Run the verification command and record what it proved, about which tree.
 *
 * Returns the reading the rail should display. Five outcomes, and none of them
 * is a guess:
 *
 *  - the tree held still and the command exited 0 → "verified", recorded;
 *  - the tree held still and it did not          → "failed", recorded;
 *  - the check never completed (the executor killed it at its deadline, or
 *    it was cancelled) → "unknown", NOT recorded: the exit code is the
 *    executor's verdict, not the suite's, so an earlier record about the
 *    same tree stands;
 *  - the tree moved while it ran                 → "unknown", NOT recorded,
 *    with a reason saying the run cannot be attributed to any tree;
 *  - the tree could not be fully identified      → "unknown", NOT recorded,
 *    because an equal pair of blind digests proves nothing held still.
 */
export async function verifyAndRecord(
  exec: VerifyRunner,
  run: Runner,
  root: string,
  command: string,
  options: VerifyRunOptions = {},
): Promise<VerifyRunResult> {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      reading: { status: "unknown", reason: "no verification command is configured", record: null, cause: "no_command" },
      written: null,
      output: "",
      exitCode: -1,
      completed: false,
    };
  }

  const before = treeIdentity(run, root);
  const result = await exec.executeAsync("run_tests", { command: trimmed }, options.run);
  const after = treeIdentity(run, root);

  // Whether the check completed is the CheckReading the agent footer renders
  // (#275); only a completed check on one still, fully identified tree yields
  // a record. readVerifierRun returns null for every other case and nothing
  // is written, so there is no misleading record to classify later.
  const check = readCheck(trimmed, result, options.run?.signal?.aborted === true);
  const interruption = checkInterruption(check);
  const { reading, record } = readVerifierRun(trimmed, result, before, after, {
    now: options.now ?? new Date().toISOString(),
    interruption,
    interruptionReason: check.reason,
  });
  if (record) writeVerification(root, record);
  return {
    reading,
    written: record,
    output: result.output,
    exitCode: result.exitCode,
    completed: interruption === null,
  };
}

/**
 * A VerifyRunner that records every check it runs through verifyAndRecord, so
 * the result `aether agent` reports is the result `aether review` reads back —
 * with the same attribution and staleness rules, from the same single writer.
 * The caller still receives the raw result and classifies it itself;
 * `onResult` hands it the recorded result too — its reading feeds the RC
 * Tests panel (#219), and its reading and written record are the tree-bound
 * receipt a saved-goal phase run keeps (#299).
 */
export function recordingRunner(
  exec: VerifyRunner,
  run: Runner,
  root: string,
  onResult?: (result: VerifyRunResult) => void,
): VerifyRunner {
  return {
    async executeAsync(_name: string, args: Record<string, unknown>, options?: RunOptions): Promise<ToolResult> {
      const command = typeof args["command"] === "string" ? args["command"] : "";
      const result = await verifyAndRecord(exec, run, root, command, options ? { run: options } : {});
      onResult?.(result);
      return { output: result.output, exitCode: result.exitCode };
    },
  };
}
