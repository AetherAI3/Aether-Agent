// Repeated-failure budget for host-executed tool calls (issue #285).
//
// Every refused or failed tool result used to reset the host's progress
// deadline, so a model could spend its whole turn budget re-requesting the same
// invalid call, the same denied command, or the same unavailable operation —
// each under a fresh call id — without getting any closer to the goal.
//
// This module is the one place that:
//
//   1. CLASSIFIES a failed tool result (invalid arguments, permission refusal,
//      unavailable capability, stale file precondition, transient, unknown
//      mutation outcome, execution failure);
//   2. FINGERPRINTS the operation canonically (tool + validated arguments, so
//      key order and call ids never make a repeat look new). A failure the HOST
//      decided (skill policy, argument validation, an operator denial) is bound
//      to the operation alone: an unrelated edit does not reopen an operator's
//      "no". A failure the TOOL produced is also bound to the relevant state it
//      ran under (workspace revision, the target file's revision, the shell
//      context, the configured test command);
//   3. decides, BEFORE a repeat is executed or put in front of the operator,
//      whether the documented budget for that class is spent. The first spent
//      repeat is REFUSED — answered under its own call id, not executed, not
//      prompted, with the recovery spelled out for the model. Asking once more
//      after that refusal STOPS the cycle with a checkpoint naming the
//      operation, the reason, the attempt count, the preserved work and one
//      useful recovery choice. Refuse-then-stop means several identical calls
//      batched into one model reply cannot end a run before the model has
//      seen a single result, and every class gets a warning before the stop.
//
// What it deliberately does NOT do:
//   - deduplicate successful calls (a success clears the fingerprint);
//   - treat a nonzero exit as permanent (execution failures get the largest
//     budget, and any real state change resets the count);
//   - replay anything whose outcome is unknown (a timed-out mutation is
//     classified, never retried by the host);
//   - widen anything: a refusal or stop never substitutes a different or more
//     privileged action, and never suggests a broader permission mode.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { toolDefinition, type ToolSideEffect } from "./tool_registry.js";
import { redactInline } from "./redaction.js";
import type { BrainEvent } from "./brain_protocol.js";
import type { ToolResult } from "./tool_executor.js";
import type { Runner } from "./worktree.js";

export type ToolFailureClass =
  | "invalid_arguments"
  | "permission_refused"
  | "unavailable"
  | "stale_precondition"
  | "transient"
  | "unknown_outcome"
  | "execution_failure";

/** Where in the host pipeline the call was stopped or failed. */
export type ToolFailureOrigin = "policy" | "validation" | "approval" | "execution";

/**
 * How many times one canonical operation may FAIL (under unchanged relevant
 * state, for tool-produced failures) before the host refuses the next identical
 * request without running or prompting it. A request after that refusal stops
 * the cycle.
 *
 *   permission_refused 1 — the operator already answered.
 *   unavailable        1 — the capability will not appear by asking again.
 *   invalid_arguments  2 — one identical resend is tolerated (models do echo).
 *   stale_precondition 2 — re-read, then re-apply; a third stale write is a loop.
 *   unknown_outcome    2 — one deliberate replay of a timed-out mutation is
 *                          allowed; the host itself never replays it.
 *   transient          3 — temporary by nature (the host also retries a
 *                          read-only transient failure once on its own).
 *   execution_failure  3 — a failing command/test on an unchanged workspace.
 */
export const TOOL_FAILURE_BUDGET: Readonly<Record<ToolFailureClass, number>> = Object.freeze({
  permission_refused: 1,
  unavailable: 1,
  invalid_arguments: 2,
  stale_precondition: 2,
  unknown_outcome: 2,
  transient: 3,
  execution_failure: 3,
});

/** Consecutive failed or refused calls (of ANY operation) with no success in
 * between before the host stops the cycle. Catches a model that varies an
 * invalid call just enough that no single fingerprint repeats. */
export const MAX_CONSECUTIVE_TOOL_FAILURES = 8;

/** Host-side automatic retries for a transient failure of a read-only tool.
 * Mutating tools are never retried by the host. */
export const TRANSIENT_READ_AUTO_RETRIES = 1;

/** Upper bound on one git probe. A slower probe reads as "unmeasured", which
 * never stops a run. */
export const WORKSPACE_PROBE_TIMEOUT_MS = 3_000;

const MAX_TEXT = 200;

export interface ToolCallShape {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** The relevant state a tool-produced failure is bound to. */
export type ToolStateProbe = (call: ToolCallShape) => string;

export interface PreservedWork {
  /** Tool calls in this cycle that succeeded. */
  readonly succeededCalls: number;
  /** Successful file edits and commits (write_file / patch_file / git_commit). */
  readonly edits: number;
  /** Successful run_shell commands — their effects, if any, also remain. */
  readonly shellRuns: number;
  /** Files successfully written or patched in this cycle, in first-seen order. */
  readonly filesChanged: readonly string[];
}

export interface ToolFailureCheckpoint {
  readonly kind: "repeated_tool_failure";
  /** Which bound fired. */
  readonly trigger: "same_operation" | "failure_streak";
  readonly tool: string;
  /** Bounded, redacted rendering of the operation that was stopped. */
  readonly operation: string;
  readonly failureClass: ToolFailureClass;
  /** First line of the last failure, bounded and redacted. */
  readonly reason: string;
  /** Failed or refused requests counted toward the bound that fired. */
  readonly attempts: number;
  readonly budget: number;
  readonly preserved: PreservedWork;
  /** One recovery choice the operator can act on. Never an escalation. */
  readonly recovery: string;
}

export type ToolFailureDecision =
  | { readonly action: "allow" }
  /** Answer with `result` under the call's id; do not prompt or execute. */
  | { readonly action: "refuse"; readonly result: ToolResult }
  /** Answer with `result`, then end the cycle with `checkpoint`. */
  | { readonly action: "stop"; readonly checkpoint: ToolFailureCheckpoint; readonly result: ToolResult };

interface FailureEntry {
  /** Host decisions (policy/validation/approval) are not state-bound. */
  readonly decided: boolean;
  /** State after the last failed execution ("" for decided failures). */
  readonly state: string;
  readonly count: number;
  /** Refusals delivered for this entry (each one a warning to the model). */
  readonly refused: number;
  /** Model round the last refusal was delivered in, when the brain says. */
  readonly refusedRound?: number;
  /** State epoch when the last refusal was delivered (edits and state-changing
   * shell runs advance it; reads do not). */
  readonly refusedAtEpoch: number;
  readonly cls: ToolFailureClass;
  readonly reason: string;
  readonly tool: string;
  readonly operation: string;
}

// ── classification ──────────────────────────────────────────────────────────

/**
 * Classify one tool result. Null means "not a failure this budget counts":
 * success, or a cancellation (which ends the turn through its own path).
 */
export function classifyToolFailure(
  name: string,
  result: ToolResult,
  origin: ToolFailureOrigin = "execution",
): ToolFailureClass | null {
  if (origin === "policy") return "unavailable";
  if (origin === "approval") return "permission_refused";
  if (origin === "validation") return "invalid_arguments";
  if (result.exitCode === 0) return null;
  const head = firstLine(result.output);
  if (result.exitCode === 130 && /^\[abort/i.test(head)) return null;

  if (/^\[tool \S+ rejected:/.test(head)) return "invalid_arguments";
  // patch_file reports through previewPatch ("[patch rejected: …]") and, once
  // executed, through execute()'s wrapper ("[tool patch_file error: …]").
  if (/^\[(patch rejected|tool patch_file error): conflict: file changed /.test(head)) return "stale_precondition";
  if (/^\[patch rejected:/.test(head)) return "invalid_arguments";
  if (
    /^\[tool patch_file error: (hunk does not match|ambiguous hunk|start_line|patch has no change|expected_sha256|patch target|binary patch target)/.test(
      head,
    )
  ) {
    return "invalid_arguments";
  }
  // The workspace path guard is a boundary, not a typo and not a prompt.
  if (
    /^\[tool \S+ error: (refusing path outside workspace|replacement target opened outside workspace)|^\[read_file opened outside workspace/.test(
      head,
    )
  ) {
    return "permission_refused";
  }
  // write_file replacement proof (#294): a moved target is stale; a missing
  // or wrong proof is an argument problem the model can correct.
  if (/^\[tool write_file error: (stale_revision|replacement target changed)/.test(head)) return "stale_precondition";
  if (
    /^\[tool write_file error: (file already exists|replacement requires|invalid replace_token|replacement target (exceeds|must be))/.test(
      head,
    )
  ) {
    return "invalid_arguments";
  }
  if (
    /^\[read_file stale_revision|^\[directory listing conflict|request fresh approval\]$|^\[checkout changed/.test(head)
  ) {
    return "stale_precondition";
  }
  if (/^\[read_file path changed while opening|^\[read conflict: file changed during read/.test(head)) {
    return "transient";
  }
  if (
    /^\[unknown tool|^\[no test_cmd configured|^\[no console shell session|^\[interactive terminal active|^\[read_file revision_unsupported|^\[tool \S+ is async — call executeAsync/.test(
      head,
    ) ||
    /^\[spawn error (ENOENT|EACCES)/.test(head)
  ) {
    return "unavailable";
  }
  if (/^\[local execution busy|^\[spawn error (EAGAIN|EMFILE|ENFILE|EBUSY)/.test(head)) return "transient";
  // Only the executor's own deadline. A command that itself exits 124 (e.g.
  // coreutils `timeout`) reported "[exit 124]" and is an ordinary failure.
  if (/^\[timeout after /.test(head)) {
    const effect = sideEffectOf(name);
    return effect === "read" || effect === "network" ? "transient" : "unknown_outcome";
  }
  if (/^\[spawn error/.test(head)) return "unknown_outcome";
  if (
    /^\[no such (file|directory)|^\[binary file|^\[invalid UTF-8|^\[offset beyond EOF|^\[start_line beyond EOF|^\[offset splits a UTF-8|exceeds (output )?budget|^\[invalid directory cursor|^\[empty shell command/.test(
      head,
    )
  ) {
    return "invalid_arguments";
  }
  return "execution_failure";
}

/** One recovery choice per class. Each is an operator action or a change of
 * plan — never a broader permission or an alternative privileged path. */
export function recoveryFor(cls: ToolFailureClass, tool: string, reason = ""): string {
  switch (cls) {
    case "invalid_arguments":
      return `correct the ${tool} arguments the host rejected (see reason), then resume with an instruction that names the fix`;
    case "permission_refused":
      return /outside workspace/.test(reason)
        ? `keep ${tool} inside the workspace — the path guard is not something an approval can lift`
        : `re-run and approve ${tool} when prompted if it is wanted, or steer the task to work without it`;
    case "unavailable":
      return `make ${tool} available to this run (configure it, or allow it in the active skill/policy), or continue without it`;
    case "stale_precondition":
      return `re-read the target to obtain its current revision, then re-apply the change against that revision`;
    case "transient":
      return `retry the run once the temporary condition clears; the failed attempts changed nothing`;
    case "unknown_outcome":
      return `inspect the workspace (git status / git diff) before retrying — the last ${tool} effect is unknown and was not replayed`;
    case "execution_failure":
      return `change the code or the command before running ${tool} again — it failed identically on an unchanged workspace`;
  }
}

// ── canonical operation + state ─────────────────────────────────────────────

/** Stable JSON: sorted keys, so argument order never makes a repeat look new. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 8) return '"…"';
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map((item) => canonicalJson(item, depth + 1)).join(",") + "]";
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => JSON.stringify(key) + ":" + canonicalJson((value as Record<string, unknown>)[key], depth + 1));
  return "{" + entries.join(",") + "}";
}

/**
 * The canonical key of an operation, as a fixed-size digest (a write_file
 * binding can carry a megabyte of content; the table never stores it).
 *  - policy refusals are keyed by tool name alone: the policy refuses the tool,
 *    whatever its arguments, so a different argument is not a different answer;
 *  - a validated call uses the host's own approval binding;
 *  - anything else uses the stable JSON of the raw arguments.
 */
export function operationKey(call: ToolCallShape, opts: { policy?: boolean; binding?: string } = {}): string {
  const material = opts.policy
    ? `policy\0${call.name}`
    : opts.binding
      ? `call\0${opts.binding}`
      : `raw\0${call.name}\0${canonicalJson(call.args)}`;
  return createHash("sha256").update(material).digest("hex");
}

/** Bounded, redacted, one-line rendering of an operation for humans and logs. */
export function describeOperation(call: ToolCallShape): string {
  const args = call.args;
  const primary =
    typeof args["command"] === "string"
      ? args["command"]
      : typeof args["path"] === "string"
        ? args["path"]
        : typeof args["url"] === "string"
          ? args["url"]
          : typeof args["query"] === "string"
            ? args["query"]
            : Object.keys(args).length === 0
              ? "(no arguments)"
              : canonicalJson(args);
  return bounded(`${call.name} ${primary}`);
}

/**
 * A git runner for the workspace probe: bounded in time and output, never
 * takes the index lock, never starts an fsmonitor daemon.
 */
export function boundedGitRunner(timeoutMs = WORKSPACE_PROBE_TIMEOUT_MS): Runner {
  return (cmd, args, cwd) => {
    const r = spawnSync(cmd, ["-c", "core.fsmonitor=false", "--no-optional-locks", ...args], {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    if (r.error) return { status: 127, stdout: "", stderr: String(r.error) };
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

/**
 * Digest of the git working tree from ONE `git status --porcelain=v2
 * --branch` call: HEAD (`branch.oid`) plus every changed path and that path's
 * stat. Porcelain alone would miss a second edit to an already-modified file.
 *
 * Null only for "not a git work tree". Any other failure — git missing, too
 * slow, an error — THROWS, so the caller reads the state as unmeasured (and
 * therefore changed) instead of as a constant that could freeze a count.
 */
export function gitWorkspaceRevision(run: Runner, root: string): string | null {
  const status = run(
    "git",
    ["-C", root, "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"],
    root,
  );
  if (status.status !== 0) {
    if (status.status === 128 && /not a git repository/i.test(status.stderr)) return null;
    throw new Error(`workspace revision unmeasured (git status ${status.status})`);
  }
  const hash = createHash("sha256");
  const records = status.stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) continue;
    if (record.startsWith("# ")) {
      if (record.startsWith("# branch.oid ")) hash.update(record);
      continue;
    }
    const path = porcelainV2Path(record);
    // A rename/copy record is followed by its original path as its own record.
    if (record.startsWith("2 ")) index += 1;
    hash.update("\0" + record + "\0" + (path === null ? "" : statToken(resolve(root, path))));
  }
  return hash.digest("hex");
}

/** The path field of one porcelain v2 record, or null for an unknown shape. */
function porcelainV2Path(record: string): string | null {
  const fieldsBeforePath: Record<string, number> = { "1": 8, "2": 9, u: 10, "?": 1, "!": 1 };
  const skip = fieldsBeforePath[record[0] ?? ""];
  if (skip === undefined) return null;
  let at = 0;
  for (let field = 0; field < skip; field += 1) {
    at = record.indexOf(" ", at);
    if (at < 0) return null;
    at += 1;
  }
  return record.slice(at) || null;
}

const READ_ONLY_COMMANDS = new Set([
  "ls", "dir", "cat", "type", "head", "tail", "pwd", "echo", "wc", "which", "where", "file", "stat",
  "du", "df", "tree", "grep", "rg", "find", "env", "printenv", "whoami", "date", "uname",
]);
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "blame", "rev-parse", "ls-files", "grep"]);

/**
 * True only for a single, simple command that cannot change the workspace or
 * environment: no chaining, pipes, redirection or substitution, and a program
 * from a short read-only list. Anything else — including anything unknown —
 * is treated as possibly changing state.
 */
export function isReadOnlyShellCommand(command: string): boolean {
  const text = command.trim();
  if (!text || /[;&|<>`\n\r]|\$\(/.test(text)) return false;
  const words = text.split(/\s+/);
  const program = words[0]!.replace(/^.*[\\/]/, "").toLowerCase();
  if (program === "git") return READ_ONLY_GIT.has(words[1] ?? "");
  if (program === "find") return !words.some((word) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(word));
  return READ_ONLY_COMMANDS.has(program);
}

export interface WorkspaceProbeSources {
  readonly root: string;
  /** Shell session identity + cwd; a reset or `cd` is a state change. */
  readonly shellContext?: () => string | undefined;
  /** Capability identity (e.g. configured test command). */
  readonly capability?: () => string;
  /** Workspace revision; null when it cannot be measured. */
  readonly workspaceRevision?: () => string | null;
}

/**
 * The default relevant-state probe: workspace revision for shell/git calls,
 * the target file's revision for path-bearing calls, the shell context, and
 * the configured capabilities. Read-only: it stats, it never reads content.
 * Outside git the workspace part is the constant "no-git": only the epoch
 * (successful edits and state-changing shell runs), the shell context and file
 * stats remain. A revision that cannot be measured throws, and the budget reads
 * a throwing probe as a changed state.
 */
export function workspaceStateProbe(sources: WorkspaceProbeSources): ToolStateProbe {
  return (call) => {
    const parts: string[] = [sources.capability?.() ?? ""];
    const effect = sideEffectOf(call.name);
    if (effect === "shell" || effect === "git") {
      parts.push(sources.shellContext?.() ?? "", sources.workspaceRevision?.() ?? "no-git");
    }
    const path = call.args["path"];
    if (typeof path === "string" && path.length > 0 && path.length <= 4096) {
      parts.push(statToken(isAbsolute(path) ? path : resolve(sources.root, path)));
    }
    return parts.join("\0");
  };
}

// ── the budget ──────────────────────────────────────────────────────────────

export interface ToolFailureBudgetOptions {
  /** Relevant-state probe for tool-produced failures. Default: epoch only. */
  readonly probe?: ToolStateProbe;
  readonly budgets?: Partial<Record<ToolFailureClass, number>>;
  readonly maxConsecutiveFailures?: number;
}

/**
 * Per-turn tracker. One instance per host loop; it never outlives the turn.
 *
 * Call order per tool_call: `check()` before any prompt or execution, and act
 * on its decision; then, once a real result exists, `record()`. Refuse and
 * stop decisions carry the result to deliver under the SAME call id, so every
 * call still receives exactly one result.
 */
export class ToolFailureBudget {
  private readonly probe: ToolStateProbe;
  private readonly budgets: Readonly<Record<ToolFailureClass, number>>;
  private readonly maxStreak: number;
  private readonly failures = new Map<string, FailureEntry>();
  /** State measured just before an execution of a key that has failed before. */
  private readonly preState = new Map<string, string>();
  private epoch = 0;
  private streak = 0;
  private lastFailure: { cls: ToolFailureClass; reason: string; tool: string; round?: number } | null = null;
  private round: number | undefined;
  private succeeded = 0;
  private edits = 0;
  private shellRuns = 0;
  private readonly files: string[] = [];
  private unmeasured = 0;
  private static readonly MAX_ENTRIES = 256;
  private static readonly MAX_FILES = 64;

  constructor(options: ToolFailureBudgetOptions = {}) {
    this.probe = options.probe ?? (() => "");
    this.budgets = { ...TOOL_FAILURE_BUDGET, ...(options.budgets ?? {}) };
    this.maxStreak = options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_TOOL_FAILURES;
  }

  /**
   * Tell the budget which model reply the next call came from (see
   * Brain.modelRound). Undefined means unknown: every call is its own round.
   */
  noteModelRound(round: number | undefined): void {
    this.round = round;
  }

  get preserved(): PreservedWork {
    return { succeededCalls: this.succeeded, edits: this.edits, shellRuns: this.shellRuns, filesChanged: [...this.files] };
  }

  /**
   * Decide, before prompting or executing, what happens to this request.
   * NOT idempotent: a refusal is recorded as delivered. Call it exactly once
   * per tool_call, and deliver whatever it returns.
   */
  check(key: string, call: ToolCallShape): ToolFailureDecision {
    const round = this.round;
    this.preState.delete(key);
    const entry = this.failures.get(key);
    if (entry) {
      let unchanged = entry.decided;
      if (!entry.decided) {
        const pre = this.stateOf(call);
        this.preState.set(key, pre);
        unchanged = pre === entry.state;
      }
      if (!unchanged) {
        // The relevant state moved since the last failure: a genuine retry.
        this.failures.delete(key);
      } else {
        const budget = this.budgets[entry.cls];
        if (entry.count >= budget) {
          // Warn (refuse) when no refusal was delivered yet, or when the turn
          // changed something real (an edit, a state-changing shell run) since
          // the last one: a request made after real work is a new question, not
          // the same loop. Reads in between are not progress.
          if (entry.refused === 0 || entry.refusedAtEpoch !== this.epoch) {
            this.failures.set(key, { ...entry, refused: entry.refused + 1, refusedRound: round, refusedAtEpoch: this.epoch });
            this.streak += 1;
            return { action: "refuse", result: this.refusal(entry) };
          }
          // Same model reply as the refusal: the model has not seen it yet.
          if (round !== undefined && entry.refusedRound === round) {
            return { action: "refuse", result: this.refusal(entry) };
          }
          return this.stop("same_operation", entry.cls, entry.reason, entry.tool, describeOperation(call), entry.count + entry.refused, budget);
        }
      }
    }
    // The streak stops only once the model has seen the failures that built
    // it (a later round); within one batched reply the calls still run.
    const last = this.lastFailure;
    if (this.streak >= this.maxStreak && last && !(round !== undefined && last.round === round)) {
      return this.stop("failure_streak", last.cls, last.reason, last.tool, describeOperation(call), this.streak, this.maxStreak);
    }
    return { action: "allow" };
  }

  /** Record the result actually delivered for a call. Returns its class. */
  record(key: string, call: ToolCallShape, result: ToolResult, origin: ToolFailureOrigin = "execution"): ToolFailureClass | null {
    const pre = this.preState.get(key);
    this.preState.delete(key);
    const cls = classifyToolFailure(call.name, result, origin);
    if (cls === null) {
      if (result.exitCode === 0) this.noteSuccess(key, call);
      return null;
    }
    const decided = origin !== "execution";
    // Bound to the state AFTER this attempt. The next attempt compares its own
    // pre-execution state with it, so a failing command that rewrites files
    // itself (snapshots, lockfiles) does not look like progress.
    const state = decided ? "" : this.stateOf(call);
    const reason = bounded(firstLine(result.output));
    const prior = this.failures.get(key);
    const repeat =
      prior !== undefined &&
      prior.decided === decided &&
      // Without a pre-execution reading (record() called with no check()),
      // fall back to comparing the post-execution states.
      (decided || (pre ?? state) === prior.state);
    const count = repeat ? prior!.count + 1 : 1;
    if (!prior && this.failures.size >= ToolFailureBudget.MAX_ENTRIES) {
      const oldest = this.failures.keys().next().value;
      if (oldest !== undefined) this.failures.delete(oldest);
    }
    this.failures.set(key, {
      decided,
      state,
      count,
      refused: 0,
      refusedAtEpoch: this.epoch,
      cls,
      reason,
      tool: call.name,
      operation: describeOperation(call),
    });
    this.streak += 1;
    this.lastFailure = { cls, reason, tool: call.name, ...(this.round !== undefined ? { round: this.round } : {}) };
    return cls;
  }

  /**
   * A note appended to a REPEATED failure so the model sees the bound coming.
   * The first failure of an operation is delivered byte-for-byte.
   */
  repeatNote(key: string): string | null {
    const notes: string[] = [];
    const entry = this.failures.get(key);
    if (entry && entry.count >= 2) {
      const left = Math.max(0, this.budgets[entry.cls] - entry.count);
      notes.push(
        `[host: this identical ${entry.tool} call has failed ${entry.count} times ` +
          `(${label(entry.cls)}) with nothing relevant changed; ` +
          (left === 0 ? "the next identical request will be refused" : `${left} identical attempt${left === 1 ? "" : "s"} left`) +
          ` — change the arguments or the approach]`,
      );
    }
    if (this.streak >= this.maxStreak - 2) {
      notes.push(
        `[host: ${this.streak} tool calls in a row have failed; after ${this.maxStreak} the run stops — ` +
          `step back and try a different approach]`,
      );
    }
    return notes.length ? notes.join("\n") : null;
  }

  private refusal(entry: FailureEntry): ToolResult {
    return {
      output:
        `[host refused repeat: ${entry.operation} already failed ${entry.count} time${entry.count === 1 ? "" : "s"} ` +
        `(${label(entry.cls)}: ${entry.reason}) with nothing relevant changed; not executed and not re-prompted. ` +
        `Requesting it again stops this run. To recover: ${recoveryFor(entry.cls, entry.tool, entry.reason)}]`,
      exitCode: 1,
    };
  }

  private noteSuccess(key: string, call: ToolCallShape): void {
    this.failures.delete(key);
    this.streak = 0;
    this.succeeded += 1;
    const effect = sideEffectOf(call.name);
    if (effect === "write" || effect === "git") {
      this.edits += 1;
      this.epoch += 1;
      const path = call.args["path"];
      if (effect === "write" && typeof path === "string") {
        const shown = bounded(path);
        if (!this.files.includes(shown) && this.files.length < ToolFailureBudget.MAX_FILES) this.files.push(shown);
      }
    } else if (call.name === "run_shell") {
      // A shell command can change what git cannot see (installed packages, a
      // started service, ignored files), so its success is a state change —
      // unless it is a plain read-only command (`ls`, `git diff`, …), which
      // would otherwise let a model alternate it with a failing command forever.
      this.shellRuns += 1;
      const command = call.args["command"];
      if (typeof command !== "string" || !isReadOnlyShellCommand(command)) this.epoch += 1;
    }
  }

  private stateOf(call: ToolCallShape): string {
    let probed: string;
    try {
      probed = this.probe(call);
    } catch {
      // A probe that cannot measure must not freeze a count: an unmeasurable
      // state is treated as changed, so the model is never stopped on a guess.
      this.unmeasured += 1;
      probed = `unmeasured:${this.unmeasured}`;
    }
    return `${this.epoch}\0${probed}`;
  }

  private stop(
    trigger: ToolFailureCheckpoint["trigger"],
    cls: ToolFailureClass,
    reason: string,
    tool: string,
    operation: string,
    attempts: number,
    budget: number,
  ): ToolFailureDecision {
    const checkpoint: ToolFailureCheckpoint = {
      kind: "repeated_tool_failure",
      trigger,
      tool,
      operation,
      failureClass: cls,
      reason,
      attempts,
      budget,
      preserved: this.preserved,
      recovery: recoveryFor(cls, tool, reason),
    };
    const result: ToolResult = {
      output:
        `[host stopped repeated failure: ${operation} — ${attempts} failed or refused attempt${attempts === 1 ? "" : "s"} ` +
        `(${label(cls)}) with nothing relevant changed; not executed and not re-prompted]`,
      exitCode: 1,
    };
    return { action: "stop", checkpoint, result };
  }
}

// ── rendering ───────────────────────────────────────────────────────────────

/** One line for a footer or a terminal `done` frame. */
export function checkpointSummary(cp: ToolFailureCheckpoint): string {
  const why =
    cp.trigger === "same_operation"
      ? `${cp.operation} failed or was refused ${cp.attempts}× (${label(cp.failureClass)}) with nothing relevant changed`
      : `${cp.attempts} tool calls failed in a row (stopped at: ${cp.operation})`;
  return `stopped repeated tool failure: ${why}`;
}

/** The full checkpoint: operation, reason, attempts, preserved work, recovery. */
export function checkpointLines(cp: ToolFailureCheckpoint): string[] {
  const kept = cp.preserved;
  const files = kept.filesChanged.length
    ? ` (${kept.filesChanged.slice(0, 5).join(", ")}${kept.filesChanged.length > 5 ? `, +${kept.filesChanged.length - 5} more` : ""})`
    : "";
  const shell = kept.shellRuns > 0 ? `, ${kept.shellRuns} shell command${kept.shellRuns === 1 ? "" : "s"} run` : "";
  return [
    "⏹ checkpoint — repeated tool failure stopped",
    `  operation  ${cp.operation}`,
    `  reason     ${label(cp.failureClass)}: ${cp.reason || "(no detail)"}`,
    `  attempts   ${cp.attempts} failed or refused (bound ${cp.budget}${cp.trigger === "failure_streak" ? " consecutive failures" : " for this class"})`,
    `  preserved  ${kept.succeededCalls} successful call${kept.succeededCalls === 1 ? "" : "s"}: ` +
      `${kept.edits} edit${kept.edits === 1 ? "" : "s"} kept in the workspace${files}${shell}; nothing was rolled back`,
    `  next       ${cp.recovery}`,
  ];
}

/** Machine record for --json consumers (snake_case, like the outcome record). */
export function checkpointRecord(cp: ToolFailureCheckpoint): Record<string, unknown> {
  return {
    kind: cp.kind,
    trigger: cp.trigger,
    tool: cp.tool,
    operation: cp.operation,
    failure_class: cp.failureClass,
    reason: cp.reason,
    attempts: cp.attempts,
    budget: cp.budget,
    preserved: {
      succeeded_calls: cp.preserved.succeededCalls,
      edits: cp.preserved.edits,
      shell_runs: cp.preserved.shellRuns,
      files_changed: [...cp.preserved.filesChanged],
    },
    recovery: cp.recovery,
  };
}

/**
 * The `done` reason a host stop carries. "no-progress" is an existing breaker
 * (verify_gate BREAKERS, session_log FinalStatus), so a red check after a stop
 * files as no-progress rather than as a plain incomplete run.
 */
export const TOOL_FAILURE_STOP_REASON = "no-progress";

/** The terminal frame a host stop emits through the normal event path, so the
 * renderer, the session log and the lifecycle all see the run end once. */
export function checkpointDoneEvent(cp: ToolFailureCheckpoint): Extract<BrainEvent, { type: "done" }> {
  return { type: "done", ok: false, result: checkpointSummary(cp), remaining: 0, reason: TOOL_FAILURE_STOP_REASON };
}

/**
 * The production budget for a host-executed loop rooted at `root`: the git
 * working tree (when there is one), the target file, the shell context and the
 * configured test command are the relevant state of a tool-produced failure.
 * The git probe runs only for a shell/git call that failed or is a repeat of
 * one that failed — never for successes or host decisions.
 */
export function defaultToolFailureBudget(
  root: string,
  exec: { readonly shellContext?: string; readonly configuredTestCommand?: string },
  run: Runner = boundedGitRunner(),
): ToolFailureBudget {
  return new ToolFailureBudget({
    probe: workspaceStateProbe({
      root,
      shellContext: () => exec.shellContext,
      capability: () => exec.configuredTestCommand ?? "",
      workspaceRevision: () => gitWorkspaceRevision(run, root),
    }),
  });
}

/** Whether the host may transparently retry this failure once more itself.
 * Only read-only tools, only transient failures — never a mutation. */
export function hostMayRetry(name: string, cls: ToolFailureClass | null): boolean {
  return cls === "transient" && sideEffectOf(name) === "read";
}

// ── helpers ─────────────────────────────────────────────────────────────────

function label(cls: ToolFailureClass): string {
  return cls.replace(/_/g, " ");
}

function sideEffectOf(name: string): ToolSideEffect | null {
  return toolDefinition(name)?.sideEffect ?? null;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.trim();
}

function bounded(text: string): string {
  // Model-controlled text reaches the operator's terminal: neutralize C0/C1
  // controls, line/paragraph separators and format (bidi) characters, redact
  // secret-shaped values, cap the length.
  const clean = redactInline(text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\p{Cf}]/gu, " ")).trim();
  return clean.length > MAX_TEXT ? clean.slice(0, MAX_TEXT - 1) + "…" : clean;
}

function statToken(abs: string): string {
  try {
    const stat = lstatSync(abs, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return "absent";
  }
}
