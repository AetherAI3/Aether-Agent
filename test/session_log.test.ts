import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionLog, monologueLine } from "../src/core/session_log.js";
import { normalizeWorkspace } from "../src/core/workspace_scope.js";

const TS = "2026-06-04T08:30:00.000Z";

test("SessionLog writes events.jsonl, monologue.txt, and a manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "aether-log-"));
  try {
    const log = new SessionLog(
      { task: "fix tests", model: "qwen3-coder:30b", poolGb: 5, brain: "local", cwd: root },
      TS,
      root,
    );
    log.event({ type: "stage", name: "execute", face: "x" }, TS);
    log.event({ type: "skill", name: "fix-failing-tests", reason: "trigger matched" }, TS);
    log.event({ type: "tool_call", id: "c1", name: "run_tests", args: {} }, TS);
    log.toolResult("c1", { output: "[exit 0]\nok", exitCode: 0 }, TS);
    log.event({ type: "checkpoint", gitSha: "a1b2c3d4e5" }, TS);
    log.event({ type: "done", ok: true, result: "all green", remaining: 0, reason: "" }, TS);
    log.close("ok", TS, 0,
      { state: "passed", exitCode: 0, failing: 0, reason: "node check.cjs exited 0" },
      { version: 1, command: "node check.cjs", exitCode: 0, ranAt: TS, head: null, treeDigest: "a".repeat(64), remaining: 0 });

    // events.jsonl: one JSON object per line, ts stamped, tool_result recorded
    const lines = readFileSync(join(log.dir, "events.jsonl"), "utf8").trim().split("\n");
    const types = lines.map((l) => JSON.parse(l).type);
    assert.deepEqual(types, ["stage", "skill", "tool_call", "tool_result", "checkpoint", "done"]);
    assert.equal(JSON.parse(lines[0]!).ts, TS);

    // manifest: finalized with counts + status
    const manifest = JSON.parse(readFileSync(join(log.dir, "manifest.json"), "utf8"));
    assert.equal(manifest.task, "fix tests");
    assert.equal(manifest.brain, "local");
    assert.equal(manifest.finalStatus, "ok");
    assert.equal(manifest.toolCalls, 1);
    assert.equal(manifest.started, TS);
    assert.equal(manifest.ended, TS);
    assert.equal(manifest.cwd, normalizeWorkspace(root));
    assert.equal(manifest.verificationRecord.command, "node check.cjs");
    assert.equal(manifest.verificationRecord.treeDigest, "a".repeat(64));

    // monologue: human-readable, no status/telemetry noise
    const mono = readFileSync(join(log.dir, "monologue.txt"), "utf8");
    assert.match(mono, /\* execute/);
    assert.match(mono, /⌁ skill fix-failing-tests/);
    assert.match(mono, /checkpoint a1b2c3d4e5/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("monologueLine drops status and telemetry from the record tree", () => {
  assert.equal(monologueLine({ type: "status", phase: "reasoning", poolUsed: 1, poolCap: 2 }), null);
  assert.equal(
    monologueLine({ type: "telemetry", tokens: 1, tps: 1, ctxUsed: 1, ctxCap: 1, vram: 1 }),
    null,
  );
  assert.match(monologueLine({ type: "stage", name: "recon", face: "" }) ?? "", /recon/);
});


test("SessionLog redacts credentials and omits prompt, command, and memory content", () => {
  const root = mkdtempSync(join(tmpdir(), "aether-log-redact-"));
  try {
    const log = new SessionLog(
      { task: "secret task", model: "test", poolGb: 1, brain: "local", cwd: root },
      TS,
      root,
    );
    log.event({ type: "tool_call", id: "c1", name: "run_shell", args: {
      command: "curl -H 'Authorization: Bearer aek_super_secret'",
      content: "private prompt body",
      api_key: "aek_super_secret",
      path: "src/index.ts",
    } }, TS);
    log.event({ type: "memory", subtype: "extract", text: "private memory body", narrative: "private narrative", kind: "fact", confidence: 0.9 }, TS);
    log.close("ok", TS);
    const raw = readFileSync(join(log.dir, "events.jsonl"), "utf8");
    assert.doesNotMatch(raw, /aek_super_secret|private prompt body|private memory body|private narrative/);
    assert.match(raw, /omitted shell command/);
    assert.match(raw, /omitted memory narrative/);
    assert.match(raw, /"kind":"fact"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SessionLog keeps file paths readable — 'pat' must not swallow 'path'", () => {
  // Bare /pat/ matched path/PATH/patch/pattern, so every edited file in the
  // record read "[REDACTED]" and a session log could no longer say what a run
  // changed. Credential-shaped keys must still be redacted.
  const root = mkdtempSync(join(tmpdir(), "aether-log-path-"));
  try {
    const log = new SessionLog(
      { task: "t", model: "test", poolGb: 1, brain: "local", cwd: root },
      TS,
      root,
    );
    log.event({ type: "tool_call", id: "c1", name: "write_file", args: {
      path: "src/parse.ts",
      pattern: "^export",
      pat: "ghp_super_secret_value",
      gh_pat: "ghp_other_secret_value",
    } }, TS);
    log.close("ok", TS);
    const raw = readFileSync(join(log.dir, "events.jsonl"), "utf8");
    assert.match(raw, /src\/parse\.ts/);
    assert.match(raw, /\^export/);
    assert.doesNotMatch(raw, /ghp_super_secret_value|ghp_other_secret_value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
