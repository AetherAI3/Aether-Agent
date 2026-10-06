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

import { parseFailCount, readCheck, type VerifyRunner } from "./verify_gate.js";
import type { RunOptions, ToolResult } from "./tool_executor.js";
import {
  VERIFICATION_RECORD_VERSION,
  classifyVerification,
  treeIdentity,
  writeVerification,
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

/**
 * Run the verification command and record what it proved, about which tree.
 *
 * Returns the reading the rail should display. Four outcomes, and none of them
 * is a guess:
 *
 *  - the tree held still and the command exited 0 → "verified", recorded;
 *  - the tree held still and it did not          → "failed", recorded;
 *  - the tree moved while it ran                 → "unknown", NOT recorded,
 *    with a reason saying the run cannot be attributed to any tree;
 *  - the check never completed (killed at its deadline or cancelled)
 *    → "unknown", NOT recorded: it proves nothing about the tree, so an
 *    earlier record about the same tree stands.
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
      reading: { status: "unknown", reason: "no verification command is configured", record: null },
      written: null,
      output: "",
      exitCode: -1,
      completed: false,
    };
  }

  const before = treeIdentity(run, root);
  const result = await exec.executeAsync("run_tests", { command: trimmed }, options.run);
  const after = treeIdentity(run, root);

  const check = readCheck(trimmed, result, options.run?.signal?.aborted === true);
  if (check.state !== "passed" && check.state !== "failed") {
    return {
      reading: { status: "unknown", reason: `${check.reason} — nothing was verified`, record: null },
      written: null,
      output: result.output,
      exitCode: result.exitCode,
      completed: false,
    };
  }

  if (before.digest !== after.digest || before.head !== after.head) {
    return {
      reading: {
        status: "unknown",
        reason: `the working tree changed while ${trimmed} was running — the result describes no tree that exists`,
        record: null,
      },
      written: null,
      output: result.output,
      exitCode: result.exitCode,
      completed: true,
    };
  }

  const record: VerificationRecord = {
    version: VERIFICATION_RECORD_VERSION,
    command: trimmed,
    exitCode: result.exitCode,
    ranAt: options.now ?? new Date().toISOString(),
    head: after.head,
    treeDigest: after.digest,
    remaining: parseFailCount(result.output),
  };
  writeVerification(root, record);

  // Classified through the same function a later read would use, so the status
  // shown now and the status shown in ten minutes come from one implementation.
  return {
    reading: classifyVerification(record, after),
    written: record,
    output: result.output,
    exitCode: result.exitCode,
    completed: true,
  };
}

/**
 * A VerifyRunner that records every check it runs through verifyAndRecord, so
 * the result `aether agent` reports is the result `aether review` reads back —
 * with the same attribution and staleness rules, from the same single writer.
 * The caller still receives the raw result and classifies it itself.
 */
export function recordingRunner(exec: VerifyRunner, run: Runner, root: string, onResult?: (result: VerifyRunResult) => void): VerifyRunner {
  return {
    async executeAsync(_name: string, args: Record<string, unknown>, options?: RunOptions): Promise<ToolResult> {
      const command = typeof args["command"] === "string" ? args["command"] : "";
      const result = await verifyAndRecord(exec, run, root, command, options ? { run: options } : {});
      onResult?.(result);
      return { output: result.output, exitCode: result.exitCode };
    },
  };
}
