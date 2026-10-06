// RC tests producer — issue #219.
//
// The viewer's Tests panel is fed from exactly one kind of fact: what the
// host's own verifier proved, about which tree. Five groups:
//
//   1. The projection     — every verifier reading becomes a Cloud-valid tests
//                           frame carrying its own status and a fixed reason;
//                           the command, its output and the local reason never
//                           do.
//   2. The verifier       — the causes the projection reads are set by the
//                           verifier itself, and a run it cannot attribute to a
//                           tree (moved, unidentifiable, interrupted) is never
//                           a pass.
//   3. The coding gate    — `aether agent`'s final verification publishes
//                           through the run's RC observer (driven through
//                           code.ts verifyCodeTurnInCheckout, the post-loop
//                           path cmdCode runs): successful, failed, moved,
//                           interrupted, timed out, unable to start, and a
//                           broker that never answers delays nothing. A field the outbox
//                           sanitizer would rewrite is dropped; with the broker
//                           offline the reading and the run's own events all
//                           stay queued, and a review reading queued between
//                           them by another writer is not saved over.
//   4. The review rail    — `aether review verify` publishes the completed
//                           reading (a killed run is unknown, recorded nowhere);
//                           `aether review` publishes a stored one, including
//                           "stale" once the tree moves.
//   5. End to end         — a real `aether agent` turn (cmdCode) with a real
//                           test command delivers the tests frame after done.
//
// Every display frame that reaches a broker stub (or is left queued) here is
// checked against the Cloud display/1 contract — required keys from
// lib/remote_session/contracts.py, allowed keys from the shared fixture
// test/fixtures/rc-display-v1.json `payload_keys`: a frame the Cloud
// would 400 wedges the outbox, so a contract miss is a delivery failure, not a
// cosmetic one. The checker is local to this file on purpose (see the #229
// prerequisite spec: other lanes may add a shared helper).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { tmpWorkspace } from "./tmp_workspace.js";
import type { TokenStore } from "../src/core/auth.js";
import type { AppContext } from "../src/core/context.js";
import type { RunOptions, ToolResult } from "../src/core/tool_executor.js";
import { ApiClient } from "../src/core/transport.js";
import { CodeTurnLifecycle, cmdCode, verifyCodeTurnInCheckout } from "../src/commands/code.js";
import type { Runner, RunResult } from "../src/core/worktree.js";
import type { BrainDone, VerifyOutcome, VerifyRunner } from "../src/core/verify_gate.js";
import { testsEvent, type RcProducedEvent } from "../src/core/rc/producers.js";
import { createOutbox, enqueueEvent, saveOutbox } from "../src/core/rc/outbox.js";
import { payloadDigest } from "../src/core/rc/receipts.js";
import {
  VERIFICATION_RECORD_VERSION,
  classifyVerification,
  readVerification,
  treeIdentity,
  type TreeIdentity,
  type VerificationReading,
  type VerificationRecord,
} from "../src/core/verification_record.js";
import { readVerifierRun, verifyAndRecord } from "../src/core/verify_run.js";
import { openRcCodingObserver, type RcCodingObserver } from "../src/commands/rc_observation.js";
import {
  publishSkippedVerification,
  publishVerification,
  publishVerificationReading,
} from "../src/commands/rc_verification.js";
import { projectRefFor, rcOutboxPath } from "../src/commands/rc.js";
import { runReview, type ReviewDeps } from "../src/commands/review.js";
import { spawnAsyncRun } from "../src/commands/review_counts.js";

const haveGit = !spawnSync("git", ["--version"], { encoding: "utf8" }).error;
const SESSION = "rs_" + "a".repeat(32);
const SECRET_COMMAND = "npm test -- --token=cmd-secret-7f3a";
const SECRET_OUTPUT = "output-secret-91bc AETHER_TOKEN=env-secret-55de";

// ── the Cloud display/1 contract, for the tests frame ──────────────────────

const FIXTURE = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "rc-display-v1.json"),
  "utf8",
)) as { payload_keys: Record<string, string[]> };

/** RC_DISPLAY_REQUIRED_KEYS in AETHER-CLOUD lib/remote_session/contracts.py. */
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  plan: ["title", "status"],
  subagent: ["subagent_id", "status"],
  tool_activity: ["tool", "status"],
  diff_summary: ["files_changed", "insertions", "deletions"],
  tests: ["status"],
  ci: ["provider", "status"],
  pr_status: ["state"],
  artifact: ["artifact_id", "kind", "title"],
  preview: ["phase", "instance_id"],
  done: ["status"],
  error: ["code", "message"],
};
const COUNT_KEYS = new Set(["step", "total_steps", "files_changed", "insertions", "deletions", "passed", "failed", "skipped", "number"]);

/**
 * Null when the Cloud would accept this display/1 frame; otherwise why it
 * would 400 (`_validate_rc_display_payload`). session/presence frames are not
 * display/1 and are left to their own contract.
 */
function contractViolation(event: { event_type: string; payload: Record<string, unknown> }): string | null {
  if (event.event_type === "session" || event.event_type === "presence") return null;
  const allowedKeys = FIXTURE.payload_keys[event.event_type];
  const required = REQUIRED[event.event_type];
  if (!allowedKeys || !required) return `${event.event_type} is not a display/1 type`;
  const payload = event.payload;
  if (payload["projection_version"] !== "1") return "projection_version must be \"1\"";
  for (const key of required) {
    if (!(key in payload)) return `missing required key ${key}`;
    if (typeof payload[key] === "string" && payload[key] === "") return `${key} must not be empty`;
  }
  const allowed = new Set(allowedKeys);
  for (const [key, value] of Object.entries(payload)) {
    if (!allowed.has(key)) return `${key} is not an allowed ${event.event_type} key`;
    if (key === "projection_version") continue;
    if (key === "files") {
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length <= 512)) {
        return "files must be path identifiers";
      }
    } else if (COUNT_KEYS.has(key)) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return `${key} must be a bounded count`;
    } else if (typeof value !== "string" || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
      return `${key} must be a bounded single-line string`;
    }
  }
  return null;
}

function persisted(event: RcProducedEvent): Record<string, unknown> {
  const record = createOutbox({ session_id: SESSION, project_ref: "p", device_id: "d", epoch: 1, project_root: "/repo" });
  assert.equal(enqueueEvent(record, event.event_type, event.payload), true, "the sanitizer refused a tests frame");
  return record.events[0]!.payload;
}

function assertCloudAccepts(event: RcProducedEvent): Record<string, unknown> {
  const payload = persisted(event);
  assert.equal(contractViolation({ event_type: event.event_type, payload }), null, JSON.stringify(payload));
  return payload;
}

const RECORD: VerificationRecord = {
  version: VERIFICATION_RECORD_VERSION,
  command: SECRET_COMMAND,
  exitCode: 0,
  ranAt: "2026-10-05T10:00:00.000Z",
  head: "a".repeat(40),
  treeDigest: "digest-1",
  remaining: null,
};

function reading(fields: Partial<VerificationReading> & Pick<VerificationReading, "status">): VerificationReading {
  return { reason: `${SECRET_COMMAND} said ${SECRET_OUTPUT}`, record: null, ...fields };
}

// ── 1. the projection ───────────────────────────────────────────────────────

test("every verifier reading reaches the viewer with its own status and a fixed reason", () => {
  const cases: Array<[VerificationReading, string, string]> = [
    [reading({ status: "verified", cause: "exit_zero", record: RECORD }), "verified", "Verification passed"],
    // `remaining` is a regex hit on raw test output (verify_gate parseFailCount),
    // not a measured tally, so it is never published — not even as prose.
    [reading({ status: "failed", cause: "exit_nonzero", record: { ...RECORD, exitCode: 1, remaining: 3 } }),
      "failed", "Verification failed: exit code 1"],
    [reading({ status: "failed", cause: "exit_nonzero", record: { ...RECORD, exitCode: 2 } }),
      "failed", "Verification failed: exit code 2"],
    [reading({ status: "stale", cause: "head_moved", record: RECORD }),
      "stale", "Verification is stale: HEAD moved since it ran"],
    [reading({ status: "stale", cause: "tree_changed", record: RECORD }),
      "stale", "Verification is stale: the working tree changed since it ran"],
    [reading({ status: "unknown", cause: "not_verified" }),
      "unknown", "Verification unavailable: nothing has verified this working tree"],
    [reading({ status: "unknown", cause: "unsupported_record" }),
      "unknown", "Verification unavailable: the stored record is from an unsupported version"],
    [reading({ status: "unknown", cause: "no_command" }),
      "unknown", "Verification unavailable: no test runner is configured"],
    [reading({ status: "unknown", cause: "tree_moved_during_run" }),
      "unknown", "Verification unavailable: the working tree changed while it ran"],
    [reading({ status: "unknown", cause: "unattributed" }),
      "unknown", "Verification unavailable: the working tree could not be identified"],
    [reading({ status: "unknown", cause: "interrupted" }),
      "unknown", "Verification unavailable: interrupted before it finished"],
    [reading({ status: "unknown", cause: "timed_out" }),
      "unknown", "Verification unavailable: timed out before it finished"],
    [reading({ status: "unknown", cause: "launch_failed" }),
      "unknown", "Verification unavailable: the check could not start"],
    [reading({ status: "unknown", cause: "skipped" }),
      "unknown", "Verification unavailable: the run ended before verification"],
  ];
  for (const [input, status, summary] of cases) {
    const payload = assertCloudAccepts(testsEvent(input));
    assert.equal(payload["status"], status);
    assert.equal(payload["summary"], summary);
    for (const count of ["passed", "failed", "skipped"]) {
      assert.equal(payload[count], undefined, `${status}: a count nobody measured must not appear as ${count}`);
    }
  }
});

test("the command, its output and the local reason never reach the frame", () => {
  for (const status of ["verified", "failed", "stale", "unknown"] as const) {
    const payload = assertCloudAccepts(testsEvent(reading({
      status,
      ...(status === "verified" ? { cause: "exit_zero" as const } : status === "failed" ? { cause: "exit_nonzero" as const } : {}),
      record: { ...RECORD, exitCode: status === "verified" ? 0 : 1 },
    })));
    assert.doesNotMatch(JSON.stringify(payload), /cmd-secret|output-secret|env-secret|npm test/);
  }
});

test("a cause that does not belong to the status never decorates it", () => {
  // The status is the claim; a mismatched cause must not be able to soften or
  // contradict it ("Verification passed: exit code 1" would be both).
  const cases: Array<[VerificationReading, string]> = [
    [reading({ status: "verified", cause: "exit_nonzero", record: { ...RECORD, exitCode: 1 } }), "Verification passed"],
    [reading({ status: "failed", cause: "exit_zero", record: RECORD }), "Verification failed"],
    [reading({ status: "unknown", cause: "exit_zero", record: RECORD }), "Verification unavailable"],
    [reading({ status: "stale", cause: "interrupted" }), "Verification is stale"],
    [reading({ status: "unknown" }), "Verification unavailable"],
  ];
  for (const [input, summary] of cases) assert.equal(assertCloudAccepts(testsEvent(input))["summary"], summary);
});

test("a failed reading shows no number it cannot vouch for", () => {
  const odd: Array<[Partial<VerificationRecord>, string]> = [
    [{ exitCode: Number.NaN }, "Verification failed"],
    [{ exitCode: 1.5 }, "Verification failed"],
    [{ exitCode: 1, remaining: -2 }, "Verification failed: exit code 1"],
    [{ exitCode: 1, remaining: 2.5 }, "Verification failed: exit code 1"],
    [{ exitCode: 1, remaining: 7 }, "Verification failed: exit code 1"],
  ];
  for (const [fields, summary] of odd) {
    const payload = assertCloudAccepts(testsEvent(reading({
      status: "failed", cause: "exit_nonzero", record: { ...RECORD, ...fields },
    })));
    assert.equal(payload["summary"], summary);
  }
  assert.equal(
    assertCloudAccepts(testsEvent(reading({ status: "failed", cause: "exit_nonzero", record: null })))["summary"],
    "Verification failed",
  );
});

// ── 2. the verifier sets the causes ─────────────────────────────────────────

test("classifyVerification names the cause of every status it returns", () => {
  const here = { head: RECORD.head, digest: RECORD.treeDigest };
  assert.equal(classifyVerification(null, here).cause, "not_verified");
  assert.equal(classifyVerification({ ...RECORD, version: 99 }, here).cause, "unsupported_record");
  assert.equal(classifyVerification(RECORD, { ...here, head: "b".repeat(40) }).cause, "head_moved");
  assert.equal(classifyVerification(RECORD, { ...here, digest: "digest-2" }).cause, "tree_changed");
  assert.equal(classifyVerification(RECORD, here).cause, "exit_zero");
  assert.equal(classifyVerification({ ...RECORD, exitCode: 1 }, here).cause, "exit_nonzero");
});

test("a stored pass is never read back as verified on a tree that could not be identified", () => {
  // A blind digest hashes the same placeholder before and after any edit, so
  // matching one proves nothing about the tree in front of us — on read, just
  // as readVerifierRun refuses it on write.
  const blind = { head: RECORD.head, digest: RECORD.treeDigest, complete: false };
  const read = classifyVerification(RECORD, blind);
  assert.equal(read.status, "unknown");
  assert.equal(read.cause, "unattributed");
  assert.equal(classifyVerification({ ...RECORD, exitCode: 1 }, blind).status, "unknown");
  // HEAD is still readable on its own, so a moved HEAD is still honestly stale.
  assert.equal(classifyVerification(RECORD, { ...blind, head: "b".repeat(40) }).cause, "head_moved");
});

const STILL: TreeIdentity = { head: "a".repeat(40), digest: "d1", complete: true };

test("an interrupted or timed-out run proves nothing, even on a still tree with exit 0", () => {
  for (const interruption of ["interrupted", "timed_out"] as const) {
    const { reading: result, record } = readVerifierRun("npm test", { exitCode: 0, output: "" }, STILL, STILL, {
      now: RECORD.ranAt,
      interruption,
    });
    assert.equal(result.status, "unknown");
    assert.equal(result.cause, interruption);
    assert.equal(record, null, "an interrupted run is never recorded");
  }
});

test("a run on a tree that moved, or could not be identified, is never a pass", () => {
  const moved = readVerifierRun("npm test", { exitCode: 0, output: "" }, STILL, { ...STILL, digest: "d2" }, { now: RECORD.ranAt });
  assert.equal(moved.reading.status, "unknown");
  assert.equal(moved.reading.cause, "tree_moved_during_run");
  assert.equal(moved.record, null);

  for (const [before, after] of [
    [{ ...STILL, complete: false }, STILL],
    [STILL, { ...STILL, complete: false }],
    [null, STILL],
    [STILL, null],
  ] as Array<[TreeIdentity | null, TreeIdentity | null]>) {
    const blind = readVerifierRun("npm test", { exitCode: 0, output: "" }, before, after, { now: RECORD.ranAt });
    assert.equal(blind.reading.status, "unknown");
    assert.equal(blind.reading.cause, "unattributed");
    assert.equal(blind.record, null);
  }

  const green = readVerifierRun("npm test", { exitCode: 0, output: "24 passed" }, STILL, STILL, { now: RECORD.ranAt });
  assert.equal(green.reading.status, "verified");
  assert.equal(green.record?.treeDigest, "d1");
  const red = readVerifierRun("npm test", { exitCode: 1, output: "3 failed" }, STILL, STILL, { now: RECORD.ranAt });
  assert.equal(red.reading.status, "failed");
  assert.equal(red.record?.remaining, 3);
});

function gitRunner(dir: string): Runner {
  return (cmd, args, cwd) => {
    const result = spawnSync(cmd, args, { cwd: cwd ?? dir, encoding: "utf8" });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" } as RunResult;
  };
}

function gitRepo(prefix: string): { dir: string; run: Runner; write: (path: string, body: string) => void } {
  const dir = tmpWorkspace(prefix);
  const run = gitRunner(dir);
  const git = (...args: string[]): void => {
    const result = run("git", ["-C", dir, ...args]);
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  return { dir, run, write: (path, body) => writeFileSync(join(dir, path), body, "utf8") };
}

test("real git: a tree identity says whether it could see the whole tree", (t) => {
  if (!haveGit) return t.skip("git not available");
  const repo = gitRepo("aether-rc219-identity-");
  assert.equal(treeIdentity(repo.run, repo.dir).complete, true);

  const unborn = tmpWorkspace("aether-rc219-unborn-");
  gitRunner(unborn)("git", ["-C", unborn, "init", "-q", "-b", "main"]);
  writeFileSync(join(unborn, "new.txt"), "x\n");
  assert.equal(treeIdentity(gitRunner(unborn), unborn).complete, true, "an unborn branch is a readable tree");

  const plain = tmpWorkspace("aether-rc219-plain-");
  assert.equal(treeIdentity(gitRunner(plain), plain).complete, false, "a directory git cannot read is not identified");

  // `git diff HEAD` failing on a born branch is the blind spot: spawnSync's
  // 1 MiB default buffer turns a large diff into ENOBUFS, and the digest would
  // otherwise hash the same "(diff failed)" text before and after any edit.
  const failingDiff: Runner = (cmd, args, cwd) =>
    args.includes("diff") ? { status: 127, stdout: "", stderr: "ENOBUFS" } : repo.run(cmd, args, cwd);
  assert.equal(treeIdentity(failingDiff, repo.dir).complete, false);
  const failingHash: Runner = (cmd, args, cwd) =>
    args.includes("hash-object") ? { status: 128, stdout: "", stderr: "denied" } : repo.run(cmd, args, cwd);
  repo.write("untracked.txt", "u\n");
  assert.equal(treeIdentity(failingHash, repo.dir).complete, false);
});

function inTempConfig<T>(body: () => Promise<T>): Promise<T> {
  const home = tmpWorkspace("aether-rc219-config-");
  const previous = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = home;
  return body().finally(() => {
    if (previous === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = previous;
  });
}

test("real git: verifyAndRecord records nothing about a tree it could not identify", async (t) => {
  if (!haveGit) return t.skip("git not available");
  await inTempConfig(async () => {
    const repo = gitRepo("aether-rc219-blind-");
    const blind: Runner = (cmd, args, cwd) =>
      args.includes("diff") ? { status: 127, stdout: "", stderr: "ENOBUFS" } : repo.run(cmd, args, cwd);
    const exec: VerifyRunner = { executeAsync: async () => ({ output: "24 passed", exitCode: 0 }) };
    const result = await verifyAndRecord(exec, blind, repo.dir, "npm test");
    assert.equal(result.reading.status, "unknown");
    assert.equal(result.reading.cause, "unattributed");
    assert.equal(result.written, null);
    assert.equal(readVerification(repo.dir), null);
  });
});

// ── 3. the coding run's final gate ──────────────────────────────────────────

interface Broker {
  api: ApiClient;
  tests: Array<Record<string, unknown>>;
  rejected: string[];
  bodies: string[];
  /** Resolves once `count` tests frames have been accepted. */
  testsArrived(count?: number): Promise<void>;
}

/** A broker stub that applies the Cloud contract and answers with real receipts. */
function broker(options: { hang?: boolean } = {}): Broker {
  const tests: Array<Record<string, unknown>> = [];
  const rejected: string[] = [];
  const bodies: string[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  let seq = 0;
  const api = {
    postJson: async (_path: string, body: { events: Array<{
      host_event_id: string; event_type: string; payload: Record<string, unknown>;
    }> }) => {
      if (options.hang) return new Promise(() => {});
      bodies.push(JSON.stringify(body));
      for (const event of body.events) {
        const violation = contractViolation(event);
        if (violation) {
          rejected.push(violation);
          throw Object.assign(new Error(`RC_EVENT_REJECTED: ${violation}`), { status: 400 });
        }
      }
      for (const event of body.events) if (event.event_type === "tests") tests.push(event.payload);
      for (const waiter of waiters.filter((w) => tests.length >= w.count)) waiter.resolve();
      return {
        session_id: SESSION,
        receipts: body.events.map((event) => ({
          host_event_id: event.host_event_id,
          seq: ++seq,
          payload_digest: payloadDigest(event.payload),
        })),
      };
    },
  } as unknown as ApiClient;
  return {
    api,
    tests,
    rejected,
    bodies,
    testsArrived: (count = 1) => new Promise<void>((resolveWait, reject) => {
      if (tests.length >= count) return resolveWait();
      const timer = setTimeout(() => reject(new Error(`only ${tests.length} tests frames arrived`)), 5_000);
      waiters.push({ count, resolve: () => { clearTimeout(timer); resolveWait(); } });
    }),
  };
}

/** An active RC session for `root`, with its outbox OUTSIDE the tree under test. */
function activeSession(root: string, path: string = join(tmpWorkspace("aether-rc219-outbox-"), "outbox.json")): string {
  const record = createOutbox({
    session_id: SESSION,
    project_ref: projectRefFor(resolve(root)),
    device_id: "dev-1",
    epoch: 1,
    project_root: resolve(root),
  });
  enqueueEvent(record, "session", { state: "live" });
  saveOutbox(path, record);
  return path;
}

function observerFor(root: string, api: ApiClient): { observer: RcCodingObserver; outbox: string } {
  const outbox = activeSession(root);
  const observer = openRcCodingObserver(root, api, outbox);
  assert.ok(observer, "a seeded session must open an observer");
  return { observer, outbox };
}

/** A gate executor returning a fixed result, optionally doing something mid-run. */
function gateExec(result: ToolResult, during?: (options: RunOptions) => Promise<void> | void): VerifyRunner & { calls: number } {
  const exec = {
    calls: 0,
    executeAsync: async (_name: string, _args: Record<string, unknown>, options: RunOptions = {}) => {
      exec.calls += 1;
      await during?.(options);
      return result;
    },
  };
  return exec;
}

/**
 * `aether agent`'s post-loop path, driven without a brain: a turn that ended
 * the way `done` / `errored` say, then the host's check exactly as cmdCode
 * runs it (code.ts verifyCodeTurnInCheckout) — recorded through the review
 * rail in a git checkout (#275), published through `observer` (#219). Any
 * verification record lands in a throwaway config dir.
 */
function codingGate(
  observer: RcCodingObserver | null,
  exec: VerifyRunner,
  run: Runner,
  root: string,
  testCmd: string | undefined,
  done: BrainDone | null,
  errored: boolean,
  options: RunOptions = {},
  onLaunchError?: (err: unknown) => void,
): Promise<VerifyOutcome> {
  return inTempConfig(async () => {
    const turn = new CodeTurnLifecycle("fix it", { id: "turn-rc219" });
    if (errored) turn.observe({ type: "error", msg: "the coding brain crashed" });
    else if (done) turn.observe({ type: "done", ok: done.ok, result: "", remaining: done.remaining, reason: done.reason });
    const { verification } = await verifyCodeTurnInCheckout(turn, exec, { run, cwd: root }, observer, {
      testCmd,
      signal: options.signal ?? new AbortController().signal,
      timeoutMs: options.timeoutMs ?? 60_000,
      ...(onLaunchError ? { onLaunchError } : {}),
    });
    assert.ok(verification, "a turn that reached its gate settles with a verification");
    return verification;
  });
}

function assertNothingPrivate(outbox: string, b: Broker): void {
  const text = readFileSync(outbox, "utf8") + b.bodies.join("\n");
  assert.doesNotMatch(text, /cmd-secret|output-secret|env-secret|npm test/);
}

test("coding gate: a green run on a still tree publishes verified, and nothing it printed", async (t) => {
  if (!haveGit) return t.skip("git not available");
  const repo = gitRepo("aether-rc219-gate-green-");
  const b = broker();
  const { observer, outbox } = observerFor(repo.dir, b.api);
  const outcome = await codingGate(observer, gateExec({ output: SECRET_OUTPUT + " 24 passed", exitCode: 0 }),
    repo.run, repo.dir, SECRET_COMMAND, null, false);
  assert.equal(outcome.status, "ok", "the local gate's verdict is unchanged");
  await b.testsArrived();
  assert.deepEqual(b.rejected, []);
  assert.deepEqual(b.tests, [{ projection_version: "1", status: "verified", summary: "Verification passed" }]);
  await observer.drain();
  assertNothingPrivate(outbox, b);
});

test("coding gate: a red run publishes failed with its real exit code", async (t) => {
  if (!haveGit) return t.skip("git not available");
  const repo = gitRepo("aether-rc219-gate-red-");
  const b = broker();
  const { observer, outbox } = observerFor(repo.dir, b.api);
  const outcome = await codingGate(observer, gateExec({ output: SECRET_OUTPUT + " 3 failed", exitCode: 1 }),
    repo.run, repo.dir, SECRET_COMMAND, { ok: true, remaining: 0, reason: "" }, false);
  assert.equal(outcome.status, "incomplete");
  await b.testsArrived();
  assert.deepEqual(b.rejected, []);
  assert.equal(b.tests[0]?.["status"], "failed");
  assert.equal(b.tests[0]?.["summary"], "Verification failed: exit code 1");
  assert.equal(b.tests[0]?.["failed"], undefined, "the parsed \"3 failed\" is output, not a measured count");
  await observer.drain();
  assertNothingPrivate(outbox, b);
});

test("coding gate: a crashed brain does not hide what the tests themselves reported", async (t) => {
  // finalVerify folds a crashed brain into exitCode 1 for the run's verdict.
  // The Tests panel reports the test run, so it reads the run's own exit code.
  if (!haveGit) return t.skip("git not available");
  const repo = gitRepo("aether-rc219-gate-crash-");
  const b = broker();
  const { observer } = observerFor(repo.dir, b.api);
  const outcome = await codingGate(observer, gateExec({ output: "24 passed", exitCode: 0 }),
    repo.run, repo.dir, "npm test", null, true);
  assert.equal(outcome.status, "error", "a crashed brain is still never ok");
  await b.testsArrived();
  assert.equal(b.tests[0]?.["status"], "verified");
});

test("coding gate: a tree that moves while the tests run is published as unknown, never verified", async (t) => {
  if (!haveGit) return t.skip("git not available");
  const repo = gitRepo("aether-rc219-gate-moved-");
  const b = broker();
  const { observer } = observerFor(repo.dir, b.api);
  await codingGate(observer, gateExec({ output: "24 passed", exitCode: 0 }, () => repo.write("a.txt", "edited\n")),
    repo.run, repo.dir, "npm test", null, false);
  await b.testsArrived();
  assert.deepEqual(b.rejected, []);
  assert.equal(b.tests[0]?.["status"], "unknown");
  assert.equal(b.tests[0]?.["summary"], "Verification unavailable: the working tree changed while it ran");
});

test("coding gate: an interrupted run is published as unknown, not as a failure", async (t) => {
  if (!haveGit) return t.skip("git not available");
  const repo = gitRepo("aether-rc219-gate-abort-");
  const b = broker();
  const { observer } = observerFor(repo.dir, b.api);
  const abort = new AbortController();
  // The executor resolves 130 when its signal fires, exactly as ToolExecutor does.
  const exec = gateExec({ output: "[aborted]\n" + SECRET_OUTPUT, exitCode: 130 }, async (options) => {
    assert.equal(options.signal, abort.signal, "the caller's signal reaches the test run");
    abort.abort();
  });
  const outcome = await codingGate(observer, exec, repo.run, repo.dir, "npm test", null, false,
    { signal: abort.signal, timeoutMs: 60_000 });
  assert.equal(outcome.exitCode, 130, "the local gate still reports the interruption");
  await b.testsArrived();
  assert.equal(b.tests[0]?.["status"], "unknown");
  assert.equal(b.tests[0]?.["summary"], "Verification unavailable: interrupted before it finished");
});

test("coding gate: a timed-out run is published as unknown", async (t) => {
  if (!haveGit) return t.skip("git not available");
  const repo = gitRepo("aether-rc219-gate-timeout-");
  const b = broker();
  const { observer } = observerFor(repo.dir, b.api);
  await codingGate(observer, gateExec({ output: "[timeout after 60s]", exitCode: 124 }),
    repo.run, repo.dir, "npm test", null, false);
  await b.testsArrived();
  assert.equal(b.tests[0]?.["summary"], "Verification unavailable: timed out before it finished");
});

test("coding gate: a directory git cannot identify is never published as verified", async () => {
  const plain = tmpWorkspace("aether-rc219-gate-plain-");
  const b = broker();
  const { observer } = observerFor(plain, b.api);
  await codingGate(observer, gateExec({ output: "24 passed", exitCode: 0 }),
    gitRunner(plain), plain, "npm test", null, false);
  await b.testsArrived();
  assert.equal(b.tests[0]?.["status"], "unknown");
  assert.equal(b.tests[0]?.["summary"], "Verification unavailable: the working tree could not be identified");
});

test("coding gate: with no test command the reading says so, and nothing runs", async () => {
  const plain = tmpWorkspace("aether-rc219-gate-nocmd-");
  const b = broker();
  const { observer } = observerFor(plain, b.api);
  const exec = gateExec({ output: "", exitCode: 0 });
  const outcome = await codingGate(observer, exec, gitRunner(plain), plain, undefined, null, false);
  assert.equal(outcome.status, "unverified");
  assert.equal(exec.calls, 0);
  await b.testsArrived();
  assert.equal(b.tests[0]?.["summary"], "Verification unavailable: no test runner is configured");
});

test("coding gate: a run that ended before verification says so", async () => {
  const plain = tmpWorkspace("aether-rc219-gate-skipped-");
  const b = broker();
  const { observer } = observerFor(plain, b.api);
  publishSkippedVerification(observer);
  publishSkippedVerification(null); // no session: nothing to do, nothing thrown
  await b.testsArrived();
  assert.equal(b.tests[0]?.["status"], "unknown");
  assert.equal(b.tests[0]?.["summary"], "Verification unavailable: the run ended before verification");
});

test("coding gate: without an RC session the gate costs nothing extra", async () => {
  let identityCalls = 0;
  const run: Runner = () => { identityCalls += 1; return { status: 0, stdout: "", stderr: "" }; };
  const exec = gateExec({ output: "24 passed", exitCode: 0 });
  const outcome = await codingGate(null, exec, run, "/nowhere", "npm test", null, false);
  // #275 added the check reading to the gate's outcome; nothing else changed.
  assert.deepEqual(outcome, {
    status: "ok",
    remaining: 0,
    exitCode: 0,
    check: { state: "passed", exitCode: 0, failing: 0, reason: "npm test exited 0" },
  });
  assert.equal(exec.calls, 1);
  // The one call is the review rail's checkout probe (#275), which finds no
  // checkout here: no tree identity is computed when nothing will be published.
  assert.equal(identityCalls, 1, "no tree identity is computed when nothing will be published");

  // RC reads the reading the gate already made, so a session adds no git work.
  const plain = tmpWorkspace("aether-rc219-gate-free-");
  const { observer } = observerFor(plain, broker().api);
  identityCalls = 0;
  await codingGate(observer, gateExec({ output: "24 passed", exitCode: 0 }), run, plain, "npm test", null, false);
  assert.equal(identityCalls, 1, "an RC session adds no git call to the gate");
});

test("coding gate: a broker that never answers delays nothing and keeps the frame durable", async (t) => {
  if (!haveGit) return t.skip("git not available");
  const repo = gitRepo("aether-rc219-gate-hang-");
  const b = broker({ hang: true });
  const { observer, outbox } = observerFor(repo.dir, b.api);
  const gate = codingGate(observer, gateExec({ output: "24 passed", exitCode: 0 }),
    repo.run, repo.dir, "npm test", null, false);
  let guard: ReturnType<typeof setTimeout> | undefined;
  const raced = await Promise.race([
    gate.then(() => "done"),
    new Promise((r) => { guard = setTimeout(() => r("late"), 2_000); }),
  ]);
  if (guard) clearTimeout(guard);
  assert.equal(raced, "done");
  const queued = JSON.parse(readFileSync(outbox, "utf8")) as { events: Array<{ event_type: string; payload: Record<string, unknown> }> };
  const frame = queued.events.find((event) => event.event_type === "tests");
  assert.ok(frame, "the reading is persisted before any upload is attempted");
  assert.equal(contractViolation(frame), null);
});

test("coding gate: a broken observer never changes the gate's verdict", async (t) => {
  if (!haveGit) return t.skip("git not available");
  const repo = gitRepo("aether-rc219-gate-broken-");
  const broken: RcCodingObserver = {
    projectRoot: repo.dir,
    feed: () => { throw new Error("feed"); },
    publish: () => { throw new Error("publish"); },
    publishDiff: () => Promise.reject(new Error("publishDiff")),
    drain: () => Promise.reject(new Error("drain")),
  };
  const outcome = await codingGate(broken, gateExec({ output: "1 failed", exitCode: 1 }),
    repo.run, repo.dir, "npm test", null, false);
  assert.equal(outcome.status, "incomplete");
  assert.equal(outcome.exitCode, 1);
});

test("a frame field the outbox sanitizer would rewrite is dropped, never sent rewritten", async () => {
  // The sanitizer replaces a secret env value, the project root or the home
  // directory wherever it appears. A rewritten summary is a different sentence
  // and a rewritten status is a different claim, so neither is sent: the
  // summary is dropped, and without its status the reading is not sent at all.
  const plain = tmpWorkspace("aether-rc219-exact-");
  const KEY = "RC219_PROBE_TOKEN";
  const previous = process.env[KEY];
  try {
    const b = broker();
    const { observer, outbox } = observerFor(plain, b.api);
    process.env[KEY] = "Verification";
    publishVerification(observer, reading({ status: "verified", cause: "exit_zero", record: RECORD }));
    await b.testsArrived(1);
    await observer.drain();
    assert.deepEqual(b.tests[0], { projection_version: "1", status: "verified" });

    process.env[KEY] = "verified";
    publishVerification(observer, reading({ status: "verified", cause: "exit_zero", record: RECORD }));
    publishVerification(observer, reading({ status: "failed", cause: "exit_nonzero", record: { ...RECORD, exitCode: 2 } }));
    await b.testsArrived(2);
    await observer.drain();
    assert.deepEqual(b.tests, [
      { projection_version: "1", status: "verified" },
      { projection_version: "1", status: "failed", summary: "Verification failed: exit code 2" },
    ], "a reading whose status would be rewritten is not published at all");
    assert.deepEqual(b.rejected, []);
    assert.doesNotMatch(readFileSync(outbox, "utf8") + b.bodies.join("\n"), /REDACTED/);
  } finally {
    if (previous === undefined) delete process.env[KEY];
    else process.env[KEY] = previous;
  }
});

/** A broker that cannot be reached: every append fails before any receipt. */
function offlineApi(): ApiClient & { attempts: number } {
  const api = {
    attempts: 0,
    postJson: async () => {
      api.attempts += 1;
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    },
  };
  return api as unknown as ApiClient & { attempts: number };
}

function queued(outbox: string): Array<{ event_type: string; payload: Record<string, unknown> }> {
  return (JSON.parse(readFileSync(outbox, "utf8")) as {
    events: Array<{ event_type: string; payload: Record<string, unknown> }>;
  }).events;
}

const STAGE = { type: "stage", name: "build", face: "" } as const;
const DONE = { type: "done", ok: true, result: "", remaining: 0, reason: "" } as const;

test("offline broker: the gate's reading and the run's own events all stay queued", async (t) => {
  if (!haveGit) return t.skip("git not available");
  const repo = gitRepo("aether-rc219-offline-run-");
  const api = offlineApi();
  const outbox = activeSession(repo.dir);
  const observer = openRcCodingObserver(repo.dir, api, outbox)!;
  observer.feed(STAGE);
  await observer.drain();
  await codingGate(observer, gateExec({ output: "24 passed", exitCode: 0 }),
    repo.run, repo.dir, "npm test", null, false);
  observer.feed(DONE);
  await observer.drain();
  assert.ok(api.attempts > 0, "delivery was attempted and failed");
  const events = queued(outbox);
  assert.deepEqual(events.map((event) => event.event_type), ["session", "plan", "tests", "done"]);
  for (const event of events) assert.equal(contractViolation(event), null);
});

test("offline broker: a review reading queued between a run's events is not overwritten", async () => {
  // Two writers of one outbox: a coding run's observer, and a standalone
  // `aether review` (another terminal, or `/review` in the same REPL process).
  // Each holds a record in memory; the observer must not save its older copy
  // over the reading the review queued.
  const plain = tmpWorkspace("aether-rc219-writers-");
  const api = offlineApi();
  const outbox = activeSession(plain);
  const coding = openRcCodingObserver(plain, api, outbox)!;
  coding.feed(STAGE);
  await coding.drain();

  await publishVerificationReading(api, plain, reading({ status: "stale", cause: "tree_changed", record: RECORD }), outbox);
  assert.deepEqual(queued(outbox).map((event) => event.event_type), ["session", "plan", "tests"]);

  coding.feed(DONE);
  await coding.drain();
  const events = queued(outbox);
  assert.deepEqual(events.map((event) => event.event_type), ["session", "plan", "tests", "done"]);
  assert.equal(events[2]?.payload["status"], "stale");
});

test("coding gate: a check that cannot start still reaches its caller, and an honest unknown is queued", async (t) => {
  // #275: a gate whose command cannot start no longer throws into cmdCode; the
  // error reaches verifyCodeTurn's onLaunchError and the check settles as
  // launch_failed. The viewer is told exactly that — never a pass or a fail.
  if (!haveGit) return t.skip("git not available");
  const repo = gitRepo("aether-rc219-gate-throw-");
  const b = broker();
  const { observer } = observerFor(repo.dir, b.api);
  const exec: VerifyRunner = { executeAsync: async () => { throw new Error("spawn exploded"); } };
  const launchErrors: unknown[] = [];
  const outcome = await codingGate(observer, exec, repo.run, repo.dir, "npm test", null, false, {}, (err) => {
    launchErrors.push(err);
  });
  assert.match(String(launchErrors[0]), /spawn exploded/);
  assert.equal(outcome.check.state, "launch_failed");
  await b.testsArrived();
  assert.equal(b.tests[0]?.["status"], "unknown");
  assert.equal(b.tests[0]?.["summary"], "Verification unavailable: the check could not start");
});

// ── 4. the review rail ──────────────────────────────────────────────────────

function reviewDeps(dir: string): ReviewDeps {
  const out = new PassThrough();
  out.resume();
  return { run: gitRunner(dir), runAsync: spawnAsyncRun(), cwd: dir, out, io: { tty: false, note: () => {}, question: async () => "" } };
}

function reviewCtx(dir: string, api: ApiClient): AppContext {
  return { api, flags: { cwd: dir, yes: false, json: false } } as unknown as AppContext;
}

/** A real test command, run by the real ToolExecutor, carrying a marker that must stay local. */
const NODE_EXIT = (code: number): string => `node -e "process.exit(${code})" marker-cmd-secret-7f3a`;

test("review verify: a completed run publishes its reading; an edit then makes `aether review` publish stale", async (t) => {
  if (!haveGit) return t.skip("git not available");
  await inTempConfig(async () => {
    const repo = gitRepo("aether-rc219-review-");
    const b = broker();
    const outbox = activeSession(repo.dir, rcOutboxPath(projectRefFor(resolve(repo.dir))));

    const green = await runReview(reviewCtx(repo.dir, b.api), reviewDeps(repo.dir), "verify", {
      testCmd: NODE_EXIT(0), all: false, yes: false, json: false,
    });
    assert.equal(green, 0);
    await b.testsArrived(1);
    assert.equal(b.tests[0]?.["status"], "verified");

    const red = await runReview(reviewCtx(repo.dir, b.api), reviewDeps(repo.dir), "verify", {
      testCmd: NODE_EXIT(3), all: false, yes: false, json: false,
    });
    assert.equal(red, 1);
    await b.testsArrived(2);
    assert.equal(b.tests[1]?.["status"], "failed");
    assert.equal(b.tests[1]?.["summary"], "Verification failed: exit code 3");

    repo.write("a.txt", "edited after verification\n");
    assert.equal(await runReview(reviewCtx(repo.dir, b.api), reviewDeps(repo.dir), "show", {
      all: false, yes: false, json: false,
    }), 0);
    await b.testsArrived(3);
    assert.equal(b.tests[2]?.["status"], "stale");
    assert.equal(b.tests[2]?.["summary"], "Verification is stale: the working tree changed since it ran");

    assert.deepEqual(b.rejected, []);
    assert.doesNotMatch(readFileSync(outbox, "utf8") + b.bodies.join("\n"), /marker-cmd-secret|process\.exit/);
  });
});

test("review verify: a test command that itself exits 124 or 130 completed, and is published as failed", async (t) => {
  // #275: only the executor's own markers make a check incomplete. A suite (or
  // `timeout 60 npm test`) that exits 124/130 by itself is a completed red
  // check: recorded, and shown to the viewer as failed with its exit code.
  if (!haveGit) return t.skip("git not available");
  for (const code of [130, 124] as const) {
    await inTempConfig(async () => {
      const repo = gitRepo(`aether-rc219-review-selfexit-${code}-`);
      const b = broker();
      activeSession(repo.dir, rcOutboxPath(projectRefFor(resolve(repo.dir))));
      assert.equal(await runReview(reviewCtx(repo.dir, b.api), reviewDeps(repo.dir), "verify", {
        testCmd: NODE_EXIT(code), all: false, yes: false, json: false,
      }), 1);
      await b.testsArrived(1);
      assert.deepEqual(b.tests[0], {
        projection_version: "1", status: "failed", summary: `Verification failed: exit code ${code}`,
      });
      // It was recorded: `aether review` reads the stored failure back.
      assert.equal(await runReview(reviewCtx(repo.dir, b.api), reviewDeps(repo.dir), "show", {
        all: false, yes: false, json: false,
      }), 0);
      await b.testsArrived(2);
      assert.equal(b.tests[1]?.["status"], "failed");
      assert.deepEqual(b.rejected, []);
    });
  }
});

test("review rail: a run the executor killed is unknown, and nothing is recorded", async (t) => {
  // The executor's own verdict on a run it killed — "[aborted]" / "[timeout
  // after Ns]" — is never a test result: unknown, recorded nowhere, and the
  // review publish path shows the viewer exactly that.
  if (!haveGit) return t.skip("git not available");
  for (const [result, summary] of [
    [{ output: "[aborted]\n", exitCode: 130 }, "Verification unavailable: interrupted before it finished"],
    [{ output: "[timeout after 60s]\n", exitCode: 124 }, "Verification unavailable: timed out before it finished"],
  ] as const) {
    await inTempConfig(async () => {
      const repo = gitRepo(`aether-rc219-review-killed-${result.exitCode}-`);
      const b = broker();
      const outbox = activeSession(repo.dir, rcOutboxPath(projectRefFor(resolve(repo.dir))));
      const exec: VerifyRunner = { executeAsync: async () => ({ ...result }) };
      const verified = await verifyAndRecord(exec, repo.run, repo.dir, NODE_EXIT(0));
      assert.equal(verified.written, null);
      assert.equal(verified.completed, false);
      assert.equal(readVerification(repo.dir), null);
      await publishVerificationReading(b.api, repo.dir, verified.reading, outbox);
      await b.testsArrived(1);
      assert.deepEqual(b.tests[0], { projection_version: "1", status: "unknown", summary });
      assert.deepEqual(b.rejected, []);
    });
  }
});

test("review verify: with no test command nothing ran, so nothing is published", async (t) => {
  // The stored reading still describes the tree; an attempt that ran nothing
  // must not replace it on the viewer with "unknown".
  if (!haveGit) return t.skip("git not available");
  await inTempConfig(async () => {
    const repo = gitRepo("aether-rc219-review-nocmd-");
    const b = broker();
    const outbox = activeSession(repo.dir, rcOutboxPath(projectRefFor(resolve(repo.dir))));
    assert.equal(await runReview(reviewCtx(repo.dir, b.api), reviewDeps(repo.dir), "verify", {
      testCmd: "  ", all: false, yes: false, json: false,
    }), 1);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(queued(outbox).some((event) => event.event_type === "tests"), false);
    assert.deepEqual(b.tests, []);
  });
});

test("review show: with nothing stored there is no reading to publish", async (t) => {
  if (!haveGit) return t.skip("git not available");
  await inTempConfig(async () => {
    const repo = gitRepo("aether-rc219-review-empty-");
    const b = broker();
    const outbox = activeSession(repo.dir, rcOutboxPath(projectRefFor(resolve(repo.dir))));
    assert.equal(await runReview(reviewCtx(repo.dir, b.api), reviewDeps(repo.dir), "show", {
      all: false, yes: false, json: false,
    }), 0);
    await new Promise((r) => setTimeout(r, 50));
    const queued = JSON.parse(readFileSync(outbox, "utf8")) as { events: Array<{ event_type: string }> };
    assert.equal(queued.events.some((event) => event.event_type === "tests"), false);
    assert.deepEqual(b.tests, []);
  });
});

// ── 5. end to end through `aether agent` ────────────────────────────────────

interface WireEvent { host_event_id: string; event_type: string; payload: Record<string, unknown> }

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(body),
    json: async () => body,
    body: null,
  } as unknown as Response;
}

test("aether agent: the host's final verification reaches the viewer as a tests frame", async (t) => {
  // The real cmdCode: a granted cloud dev session whose brain reports done, a
  // REAL test command run by the real ToolExecutor in a real git checkout, the
  // RC observer opened from the real config-dir outbox, and a broker stub that
  // applies the Cloud contract to every frame it is handed.
  if (!haveGit) return t.skip("git not available");
  await inTempConfig(async () => {
    const repo = gitRepo("aether-rc219-agent-");
    const outbox = activeSession(repo.dir, rcOutboxPath(projectRefFor(resolve(repo.dir))));
    const received: WireEvent[] = [];
    const rejected: string[] = [];
    let seq = 0;
    let arrived = (): void => {};
    const testsArrived = new Promise<void>((r) => { arrived = r; });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/agent/dev/sessions")) {
        return jsonResponse({ session_id: "devs_ok", protocol_version: 1, model: "kimi_k3" });
      }
      if (url.includes("/remote/sessions/") && url.endsWith("/host/events")) {
        const body = JSON.parse(String(init?.body)) as { events: WireEvent[] };
        for (const event of body.events) {
          const violation = contractViolation(event);
          if (violation) rejected.push(violation);
        }
        received.push(...body.events);
        if (body.events.some((event) => event.event_type === "tests")) arrived();
        return jsonResponse({
          session_id: SESSION,
          receipts: body.events.map((event) => ({
            host_event_id: event.host_event_id,
            seq: ++seq,
            payload_digest: payloadDigest(event.payload),
          })),
        });
      }
      const bytes = new TextEncoder().encode(
        `data: ${JSON.stringify({ type: "done", seq: 1, ok: true, uvt: 1, cents: 0 })}\n\n`,
      );
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: (async function* (): AsyncIterable<Uint8Array> { yield bytes; })(),
      } as unknown as Response;
    }) as typeof globalThis.fetch;
    const tokens = { get: async () => "aek_t" } as unknown as TokenStore;
    const ctx = {
      cfg: { backend: "cloud", permissionMode: "ask" },
      api: new ApiClient("https://stub.test", tokens),
      tokens,
      confirm: async () => false,
      flags: { json: false, audit: false, yes: false, cwd: repo.dir, model: "kimi_k3" },
    } as unknown as AppContext;

    const realFetch = globalThis.fetch;
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    let printed = "";
    let guard: ReturnType<typeof setTimeout> | undefined;
    globalThis.fetch = fetchImpl;
    process.stdout.write = ((chunk: unknown) => ((printed += String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => ((printed += String(chunk)), true)) as typeof process.stderr.write;
    try {
      const code = await cmdCode(ctx, "fix it", { local: false, pool: 5, quiet: true, noLog: true, testCmd: NODE_EXIT(0) });
      assert.equal(code, 0, printed);
      await Promise.race([
        testsArrived,
        new Promise<never>((_r, reject) => { guard = setTimeout(() => reject(new Error("no tests frame")), 10_000); }),
      ]);
    } finally {
      if (guard) clearTimeout(guard);
      globalThis.fetch = realFetch;
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }

    assert.deepEqual(rejected, []);
    const tests = received.filter((event) => event.event_type === "tests");
    assert.deepEqual(tests.map((event) => event.payload),
      [{ projection_version: "1", status: "verified", summary: "Verification passed" }]);
    const order = received.map((event) => event.event_type);
    assert.ok(order.indexOf("done") < order.indexOf("tests"), "the brain's turn ends before the host verdict");
    assert.doesNotMatch(readFileSync(outbox, "utf8") + JSON.stringify(received), /marker-cmd-secret|process\.exit/);
  });
});

test("review verify: without an RC session nothing is published and the verdict is unchanged", async (t) => {
  if (!haveGit) return t.skip("git not available");
  await inTempConfig(async () => {
    const repo = gitRepo("aether-rc219-review-off-");
    let calls = 0;
    const api = { postJson: async () => { calls += 1; throw new Error("unexpected upload"); } } as unknown as ApiClient;
    assert.equal(await runReview(reviewCtx(repo.dir, api), reviewDeps(repo.dir), "verify", {
      testCmd: NODE_EXIT(0), all: false, yes: false, json: false,
    }), 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls, 0);
  });
});
