// #275 — the `aether agent` end-of-run path: final verification, the canonical
// turn outcome, and every surface that reports them.
//
// These drive verifyCodeTurn and codeRunRecord, the two functions cmdCode calls
// after the host loop returns, so the mapping under test is the command's own.
// Each scenario asserts that the human footer, the JSON outcome, and the session
// manifest agree about BOTH facts: why the turn ended, and what the host's check
// actually did. A check that never ran — or never finished — is never failing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodeTurnLifecycle, codeRunRecord, emitCodeTurnOutcome, verifyCodeTurn } from "../src/commands/code.js";
import { runSummary, type CodeRunReport } from "../src/commands/code_support.js";
import {
  HttpError,
  MeaningfulProgressTimeoutError,
  ModelOutputLimitError,
  StreamIncompleteError,
} from "../src/core/errors.js";
import { SessionLog } from "../src/core/session_log.js";
import type { RunOptions, ToolResult } from "../src/core/tool_executor.js";
import type { VerifyOutcome } from "../src/core/verify_gate.js";
import { stripAnsi } from "../src/ui/theme.js";

const TS = "2026-10-05T12:00:00.000Z";
const RED = (n: number): ToolResult => ({ output: `[exit 1]\n=== ${n} failed in 3.2s ===`, exitCode: 1 });
const GREEN: ToolResult = { output: "[exit 0]\n=== 24 passed in 3.2s ===", exitCode: 0 };

type Script = (options: RunOptions | undefined) => Promise<ToolResult> | ToolResult;

function fakeExec(script: Script) {
  const calls: string[] = [];
  return {
    calls,
    async executeAsync(_name: string, args: Record<string, unknown>, options?: RunOptions): Promise<ToolResult> {
      calls.push(String(args["command"]));
      return script(options);
    },
  };
}

function doneTurn(remaining = 0): CodeTurnLifecycle {
  const turn = new CodeTurnLifecycle("fix it", { id: "turn-275" });
  turn.observe({ type: "stage", name: "execute", face: "" });
  turn.observe({ type: "done", ok: true, result: "claimed", remaining, reason: "" });
  return turn;
}

interface Surfaces {
  report: CodeRunReport;
  verification: VerifyOutcome | null;
  footer: string;
  json: Record<string, unknown>;
  manifest: Record<string, unknown>;
}

/** Run the post-loop path exactly as cmdCode does and read back every surface. */
async function finish(
  turn: CodeTurnLifecycle,
  exec: ReturnType<typeof fakeExec>,
  testCmd: string | undefined,
  controller = new AbortController(),
  onLaunchError: (err: unknown) => void = () => {},
): Promise<Surfaces> {
  const { report, verification } = await verifyCodeTurn(turn, exec, {
    testCmd,
    signal: controller.signal,
    timeoutMs: 120_000,
    onLaunchError,
  });

  let jsonLine = "";
  emitCodeTurnOutcome(report, true, (chunk) => {
    jsonLine += chunk;
  });

  const root = mkdtempSync(join(tmpdir(), "aether-275-"));
  try {
    const log = new SessionLog(
      { task: "fix it", model: "", poolGb: 5, brain: "local", cwd: root },
      TS,
      root,
      () => undefined,
    );
    const record = codeRunRecord(report, verification);
    log.close(record.finalStatus, TS, record.remaining, record.verification);
    const manifest = JSON.parse(readFileSync(join(log.dir, "manifest.json"), "utf8")) as Record<string, unknown>;
    return {
      report,
      verification,
      footer: stripAnsi(runSummary(report, 1, 12)),
      json: JSON.parse(jsonLine) as Record<string, unknown>,
      manifest,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The surfaces must agree with the canonical report, field for field. */
function assertAgreement(s: Surfaces): void {
  assert.equal(s.json["state"], s.report.outcome.state, "JSON state is the turn outcome");
  const jsonCheck = s.json["verification"] as Record<string, unknown>;
  assert.deepEqual(jsonCheck, {
    state: s.report.check.state,
    exit_code: s.report.check.exitCode,
    failing: s.report.check.failing,
    reason: s.report.check.reason,
  });
  const manifestCheck = s.manifest["verification"] as Record<string, unknown>;
  assert.equal(manifestCheck["state"], s.report.check.state, "session record carries the same check reading");
  assert.equal(manifestCheck["exitCode"], s.report.check.exitCode);
  assert.equal(manifestCheck["failing"], s.report.check.failing);
  if (s.report.check.state !== "failed") {
    assert.doesNotMatch(s.footer, /failing|check failed/, "only a completed red check is failing");
    assert.equal("remaining" in s.manifest, false, "no failing count is recorded for a check that did not fail");
  }
}

test("missing verification: no --test-cmd runs nothing and says unverified everywhere", async () => {
  const exec = fakeExec(() => GREEN);
  const s = await finish(doneTurn(3), exec, undefined);
  assert.deepEqual(exec.calls, []);
  assert.equal(s.report.outcome.state, "incomplete");
  assert.equal(s.report.check.state, "unconfigured");
  assert.match(s.footer, /^— unverified · 1 file changed · 12s/);
  assert.equal(s.manifest["finalStatus"], "unverified");
  assert.equal("remaining" in s.manifest, false, "the brain's self-reported 3 is not a failing count");
  assertAgreement(s);
});

test("passed verification: the only path to succeeded, and every surface says so", async () => {
  const s = await finish(doneTurn(), fakeExec(() => GREEN), "npm test");
  assert.equal(s.report.outcome.state, "succeeded");
  assert.equal(s.report.check.state, "passed");
  assert.equal(s.footer, "✓ ok · 1 file changed · tests green · 12s");
  assert.equal(s.manifest["finalStatus"], "ok");
  assert.equal(s.verification?.exitCode, 0);
  assertAgreement(s);
});

test("failed verification: a completed red check reports the host's count everywhere", async () => {
  const s = await finish(doneTurn(), fakeExec(() => RED(2)), "npm test");
  assert.equal(s.report.outcome.state, "incomplete");
  assert.equal(s.report.check.state, "failed");
  assert.equal(s.footer, "✗ incomplete · 2 tests failing · 1 file changed · 12s");
  assert.match(s.report.outcome.message, /2 tests failing/);
  assert.equal(s.manifest["finalStatus"], "incomplete");
  assert.equal(s.manifest["remaining"], 2);
  assert.equal(s.verification?.exitCode, 1, "exit code contract unchanged");
  assertAgreement(s);
});

test("failed verification without a parseable count says the check failed, never a guessed count", async () => {
  const s = await finish(doneTurn(9), fakeExec(() => ({ output: "Error: cannot find module", exitCode: 2 })), "npm test");
  assert.equal(s.footer, "✗ incomplete · check failed (exit 2) · 1 file changed · 12s");
  assert.equal(s.report.check.failing, null);
  assert.equal("remaining" in s.manifest, false, "the brain's 9 is never recorded as the failing count");
  assertAgreement(s);
});

test("timed-out verification: the check's deadline is named — not a model stream timeout", async () => {
  const s = await finish(doneTurn(), fakeExec(() => ({ output: "[timeout after 120s]\n", exitCode: 124 })), "npm test");
  assert.equal(s.report.outcome.state, "timed_out");
  assert.equal(s.report.check.state, "timed_out");
  assert.doesNotMatch(s.report.outcome.message, /stream/, s.report.outcome.message);
  assert.equal(s.report.outcome.message, "host verification: npm test did not finish within 120s");
  assert.match(s.report.outcome.hint ?? "", /AETHER_AGENT_PROGRESS_TIMEOUT_MS/);
  assert.match(s.footer, /^✗ timed out · verification: npm test did not finish within 120s/);
  assert.equal(s.manifest["finalStatus"], "timed-out");
  assert.equal(s.verification?.exitCode, 124, "exit code contract unchanged");
  assertAgreement(s);
});

test("cancelled verification: Ctrl+C during the check is a cancellation, not a red run", async () => {
  const controller = new AbortController();
  const exec = fakeExec(() => {
    controller.abort(new DOMException("coding turn interrupted by SIGINT", "AbortError"));
    return { output: "[aborted]\n", exitCode: 130 };
  });
  const s = await finish(doneTurn(), exec, "npm test", controller);
  assert.equal(s.report.outcome.state, "cancelled");
  assert.equal(s.report.check.state, "cancelled");
  assert.match(s.footer, /^■ cancelled · verification: npm test was cancelled before it finished/);
  assert.equal(s.manifest["finalStatus"], "cancelled");
  assert.equal(s.verification?.exitCode, 130);
  assertAgreement(s);
});

test("cancelled before verification: nothing runs and the footer says verification not run", async () => {
  const controller = new AbortController();
  const turn = new CodeTurnLifecycle("fix it", { id: "turn-cancel" });
  turn.observe({ type: "stage", name: "execute", face: "" });
  const interrupted = new DOMException("coding turn interrupted by SIGINT", "AbortError");
  controller.abort(interrupted);
  turn.noteThrown(interrupted);
  const exec = fakeExec(() => RED(5));
  const s = await finish(turn, exec, "npm test", controller);
  assert.deepEqual(exec.calls, [], "a cancelled turn never starts the check");
  assert.equal(s.verification, null);
  assert.equal(s.report.outcome.state, "cancelled");
  assert.equal(s.report.check.state, "not_run");
  assert.equal(
    s.footer,
    "■ cancelled · coding turn interrupted by SIGINT · verification not run · 1 file changed · 12s",
  );
  assert.equal(s.manifest["finalStatus"], "cancelled");
  assertAgreement(s);
});

test("a cancellation landing after the brain finished but before the check is a cancellation", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("coding turn interrupted by SIGTERM", "AbortError"));
  const exec = fakeExec(() => GREEN);
  const s = await finish(doneTurn(), exec, "npm test", controller);
  assert.deepEqual(exec.calls, [], "the check never starts once the operator has cancelled");
  assert.equal(s.report.outcome.state, "cancelled");
  assert.equal(s.report.check.state, "not_run");
  assert.match(s.footer, /^■ cancelled · coding turn interrupted by SIGTERM · verification not run/);
  assertAgreement(s);
});

test("model timeout: the stream deadline is named and verification is not run", async () => {
  const turn = new CodeTurnLifecycle("fix it", { id: "turn-model-timeout" });
  turn.observe({ type: "monologue", text: "thinking about it", depth: 0 });
  turn.noteThrown(new MeaningfulProgressTimeoutError(120_000));
  const exec = fakeExec(() => GREEN);
  const s = await finish(turn, exec, "npm test");
  assert.deepEqual(exec.calls, []);
  assert.equal(s.report.outcome.state, "timed_out");
  assert.match(s.footer, /^✗ timed out · turn stalled after 120s with no meaningful progress\b.* · verification not run/);
  assert.equal(s.manifest["finalStatus"], "timed-out");
  assertAgreement(s);
});

test("model output limit: the limit is named, with its next step, and verification is not run", async () => {
  const turn = new CodeTurnLifecycle("fix it", { id: "turn-output-limit" });
  turn.observe({ type: "monologue", text: "a very long answer", depth: 0 });
  turn.noteThrown(new ModelOutputLimitError(1024));
  const exec = fakeExec(() => GREEN);
  const s = await finish(turn, exec, "npm test");
  assert.deepEqual(exec.calls, []);
  assert.equal(s.report.outcome.state, "failed");
  assert.match(s.report.outcome.message, /model output exceeded 1024 bytes/);
  assert.match(s.report.outcome.hint ?? "", /narrower prompt/);
  assert.match(s.footer, /^✗ failed · model output exceeded 1024 bytes.* · verification not run/);
  assertAgreement(s);
});

test("auth refusal: the HTTP status is named with the sign-in step", async () => {
  const turn = new CodeTurnLifecycle("fix it", { id: "turn-401" });
  turn.noteThrown(new HttpError(401, "unauthorized"));
  const s = await finish(turn, fakeExec(() => GREEN), undefined);
  assert.equal(s.report.outcome.state, "failed");
  assert.match(s.report.outcome.message, /unauthorized/);
  assert.match(s.report.outcome.hint ?? "", /aether auth login/);
  assert.equal(s.report.outcome.retryable, true);
  assert.match(s.footer, /^✗ failed · unauthorized · verification not run · .*⤷ session expired/);
  assertAgreement(s);
});

test("model refusal frame: the brain's reason leads, and a check that ran is reported as it ran", async () => {
  const turn = new CodeTurnLifecycle("fix it", { id: "turn-refusal" });
  turn.observe({ type: "error", msg: "model refused: request violates the usage policy" });
  const s = await finish(turn, fakeExec(() => RED(4)), "npm test");
  assert.equal(s.report.outcome.state, "failed");
  assert.equal(s.report.check.state, "failed");
  assert.equal(
    s.footer,
    "✗ failed · model refused: request violates the usage policy · 4 tests failing · 1 file changed · 12s",
  );
  assertAgreement(s);
});

test("a brain error frame carrying an HTTP status gets that status's next step", async () => {
  const turn = new CodeTurnLifecycle("fix it", { id: "turn-402" });
  turn.observe({ type: "error", msg: "402 Payment Required: out of UVT balance" });
  const s = await finish(turn, fakeExec(() => GREEN), undefined);
  assert.match(s.report.outcome.hint ?? "", /UVT/);
  assert.equal(s.report.outcome.retryable, true);
  assertAgreement(s);
});

test("incomplete EOF: the dropped connection is named, not a test diagnosis", async () => {
  const turn = new CodeTurnLifecycle("fix it", { id: "turn-eof" });
  turn.observe({ type: "monologue", text: "partial", depth: 0 });
  turn.noteIncompleteEof();
  const s = await finish(turn, fakeExec(() => GREEN), undefined);
  assert.equal(s.report.outcome.state, "incomplete");
  assert.equal(
    s.footer.split("  ⤷")[0],
    "✗ incomplete · connection ended before the coding brain delivered a terminal frame · verification not run · 1 file changed · 12s",
  );
  assertAgreement(s);
});

test("an incomplete stream thrown by the transport is incomplete, as in chat", async () => {
  const turn = new CodeTurnLifecycle("fix it", { id: "turn-stream-incomplete" });
  turn.noteThrown(new StreamIncompleteError());
  const s = await finish(turn, fakeExec(() => GREEN), undefined);
  assert.equal(s.report.outcome.state, "incomplete");
  assert.match(s.report.outcome.message, /connection ended before the server finished responding/);
  assertAgreement(s);
});

test("verification launch failure: names the check that could not start", async () => {
  const launchErrors: unknown[] = [];
  const exec = fakeExec(() => {
    throw new Error("spawn /bin/sh ENOENT");
  });
  const s = await finish(doneTurn(), exec, "npm test", new AbortController(), (err) => launchErrors.push(err));
  assert.equal(launchErrors.length, 1);
  assert.equal(s.report.outcome.state, "failed");
  assert.equal(s.report.check.state, "launch_failed");
  assert.equal(s.report.outcome.message, "host verification: npm test could not start: spawn /bin/sh ENOENT");
  assert.doesNotMatch(s.report.outcome.message, /before final verification/);
  assert.match(s.footer, /^✗ failed · verification: npm test could not start: spawn \/bin\/sh ENOENT/);
  assert.equal(s.manifest["finalStatus"], "error");
  assert.equal(s.verification?.exitCode, 1, "exit code contract unchanged");
  assertAgreement(s);
});

test("command not found (exit 127) is a red check named as such, keeping its exit code", async () => {
  const s = await finish(doneTurn(), fakeExec(() => ({ output: "sh: 1: jest: not found", exitCode: 127 })), "jest");
  assert.equal(s.report.check.state, "failed");
  assert.equal(s.report.outcome.state, "incomplete");
  assert.match(s.report.outcome.message, /jest exited 127 \(command not found\)/);
  assert.equal(s.footer, "✗ incomplete · check failed (exit 127) · 1 file changed · 12s");
  assert.equal(s.verification?.exitCode, 127);
  assertAgreement(s);
});

test("a brain error outranks a check that then timed out — the turn's cause is never hidden", async () => {
  const turn = new CodeTurnLifecycle("fix it", { id: "turn-error-then-timeout" });
  turn.observe({ type: "error", msg: "brain exploded" });
  const s = await finish(turn, fakeExec(() => ({ output: "[timeout after 120s]\n", exitCode: 124 })), "npm test");
  assert.equal(s.report.outcome.state, "failed", "the old contract: an errored turn is failed, exit 1");
  assert.equal(s.report.check.state, "timed_out", "the check reading still says what the check did");
  assert.equal(s.verification?.exitCode, 1);
  assert.match(s.footer, /^✗ failed · brain exploded · verification: npm test did not finish within 120s/);
  assertAgreement(s);
});

test("an operator cancellation during the check still wins over an earlier brain error", async () => {
  const controller = new AbortController();
  const turn = new CodeTurnLifecycle("fix it", { id: "turn-error-then-cancel" });
  turn.observe({ type: "error", msg: "brain exploded" });
  const exec = fakeExec(() => {
    controller.abort(new DOMException("coding turn interrupted by SIGINT", "AbortError"));
    return { output: "[aborted]\n", exitCode: 130 };
  });
  const s = await finish(turn, exec, "npm test", controller);
  assert.equal(s.report.outcome.state, "cancelled");
  assertAgreement(s);
});

test("a cancellation before the check never overwrites an earlier brain error", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("coding turn interrupted by SIGINT", "AbortError"));
  const turn = new CodeTurnLifecycle("fix it", { id: "turn-error-then-sigint" });
  turn.observe({ type: "error", msg: "401 unauthorized" });
  const exec = fakeExec(() => GREEN);
  const s = await finish(turn, exec, "npm test", controller);
  assert.deepEqual(exec.calls, [], "an aborted command starts no check");
  assert.equal(s.report.outcome.state, "failed", "the real cause stands");
  assert.match(s.report.outcome.message, /401 unauthorized/);
  assert.equal(s.report.check.state, "not_run");
  assertAgreement(s);
});

test("the test command is redacted in the JSON outcome and the footer", async () => {
  const s = await finish(doneTurn(), fakeExec(() => RED(1)), "TOKEN=abc123 npm test");
  assert.doesNotMatch(JSON.stringify(s.json), /abc123/);
  assert.doesNotMatch(s.footer, /abc123/);
  assert.doesNotMatch(JSON.stringify(s.manifest), /abc123/);
  assertAgreement(s);
});

test("the report is settled once: a second verifyCodeTurn neither reruns the check nor rewrites it", async () => {
  const turn = doneTurn();
  const first = await verifyCodeTurn(turn, fakeExec(() => GREEN), {
    testCmd: "npm test",
    signal: new AbortController().signal,
    timeoutMs: 1000,
  });
  const rerun = fakeExec(() => RED(3));
  const second = await verifyCodeTurn(turn, rerun, {
    testCmd: "npm test",
    signal: new AbortController().signal,
    timeoutMs: 1000,
  });
  assert.deepEqual(rerun.calls, []);
  assert.deepEqual(second.report, first.report);
});
