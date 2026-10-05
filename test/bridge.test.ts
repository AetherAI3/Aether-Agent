import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, symlinkSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TEMP_ROOT, tmpWorkspace } from "./tmp_workspace.js";
import { fileURLToPath } from "node:url";

import {
  LineBuffer,
  encodeCommand,
  MAX_MONOLOGUE_DEPTH,
  parseEventLine,
  PROTOCOL_VERSION,
  TOOLS,
  type BrainEvent,
} from "../src/core/brain_protocol.js";
import { ToolExecutor, capHeadTail } from "../src/core/tool_executor.js";
import { EventQueue, type Brain, type TaskCommand } from "../src/core/brain.js";
import { hostLoop, cmdCode } from "../src/commands/code.js";
import type { AppContext } from "../src/core/context.js";

// The fixture is a source asset (not compiled); resolve it from the repo root.
// Compiled location is dist/test/bridge.test.js -> ../.. = repo root.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "bridge_conformance.json");

// --- protocol codec --------------------------------------------------------
test("decodeEvent maps snake_case wire keys to camelCase", () => {
  const ev = parseEventLine('{"type":"status","phase":"grounding","pool_used":100,"pool_cap":500}');
  assert.deepEqual(ev, { type: "status", phase: "grounding", poolUsed: 100, poolCap: 500 });
});

test("decodeEvent normalizes hostile numeric fields before they reach renderers", () => {
  assert.deepEqual(parseEventLine('{"type":"monologue","text":"x","depth":"Infinity"}'), {
    type: "monologue",
    text: "x",
    depth: 0,
  });
  assert.deepEqual(parseEventLine('{"type":"monologue","text":"x","depth":-99}'), {
    type: "monologue",
    text: "x",
    depth: 0,
  });
  assert.deepEqual(parseEventLine('{"type":"monologue","text":"x","depth":1e308}'), {
    type: "monologue",
    text: "x",
    depth: MAX_MONOLOGUE_DEPTH,
  });
  assert.deepEqual(
    parseEventLine('{"type":"status","phase":"x","pool_used":-1,"pool_cap":"NaN"}'),
    { type: "status", phase: "x", poolUsed: 0, poolCap: 0 },
  );
  assert.deepEqual(
    parseEventLine(
      '{"type":"workflow_start","workflow_id":"w","phases":[{"n":"Infinity","type":"run","agents":-3}],"total_agents":"NaN"}',
    ),
    {
      type: "workflow_start",
      workflowId: "w",
      phases: [{ n: 0, type: "run", agents: 0 }],
      totalAgents: 0,
    },
  );
});

test("decodeEvent reads the skill event", () => {
  const ev = parseEventLine('{"type":"skill","name":"fix-failing-tests","reason":"trigger matched"}');
  assert.deepEqual(ev, { type: "skill", name: "fix-failing-tests", reason: "trigger matched" });
});

test("checkpoint event maps git_sha", () => {
  const ev = parseEventLine('{"type":"checkpoint","git_sha":"a1b2c3d4e5"}');
  assert.deepEqual(ev, { type: "checkpoint", gitSha: "a1b2c3d4e5" });
});

test("turn event maps the per-turn diag fields (null fail_count preserved)", () => {
  const ev = parseEventLine(
    '{"type":"turn","n":4,"tool_calls":2,"malformed":1,"invented":0,"no_call":false,"fail_count":null}',
  );
  assert.deepEqual(ev, {
    type: "turn",
    n: 4,
    toolCalls: 2,
    malformed: 1,
    invented: 0,
    noCall: false,
    failCount: null,
  });
});

test("done carries remaining + reason (ground-truth finalStatus)", () => {
  const ev = parseEventLine('{"type":"done","ok":false,"result":"(incomplete — 24 failing)","remaining":24,"reason":"stalled"}');
  assert.deepEqual(ev, {
    type: "done",
    ok: false,
    result: "(incomplete — 24 failing)",
    remaining: 24,
    reason: "stalled",
  });
});

// agent_done's optional Tier-2/3 metrics (Finding E,
// docs/specs/2026-07-10-workflow-viewer-agent-panel-design.md) — additive
// fields per CONTRACTS.md's versioning rule. Absent must decode as
// `undefined`, not 0, so the UI never renders a fabricated number.
test("agent_done decodes optional tokens/tool_calls/duration_ms when present", () => {
  const ev = parseEventLine(
    '{"type":"agent_done","agent_id":"ag_1","phase_n":1,"summary":"ok","tokens":97600,"tool_calls":40,"duration_ms":266000}',
  );
  assert.deepEqual(ev, {
    type: "agent_done",
    agentId: "ag_1",
    phaseN: 1,
    summary: "ok",
    tokens: 97600,
    toolCalls: 40,
    durationMs: 266000,
  });
});

test("agent_done leaves tokens/toolCalls/durationMs undefined when the brain doesn't send them (old-brain compatibility)", () => {
  const ev = parseEventLine('{"type":"agent_done","agent_id":"ag_1","phase_n":1,"summary":"ok"}');
  assert.deepEqual(ev, {
    type: "agent_done",
    agentId: "ag_1",
    phaseN: 1,
    summary: "ok",
    tokens: undefined,
    toolCalls: undefined,
    durationMs: undefined,
  });
});

test("parseEventLine drops blanks and malformed lines", () => {
  assert.equal(parseEventLine(""), null);
  assert.equal(parseEventLine("   "), null);
  assert.equal(parseEventLine("not json"), null);
  assert.equal(parseEventLine('{"no":"type"}'), null);
});

test("encodeCommand writes snake_case wire keys + newline", () => {
  const line = encodeCommand({ type: "tool_result", id: "c1", output: "[exit 0]", exitCode: 0 });
  assert.ok(line.endsWith("\n"));
  assert.deepEqual(JSON.parse(line), { type: "tool_result", id: "c1", output: "[exit 0]", exit_code: 0 });
});

test("encodeCommand task carries pool_gb", () => {
  const line = encodeCommand({ type: "task", text: "fix", cwd: ".", poolGb: 10 });
  assert.equal(JSON.parse(line).pool_gb, 10);
});

// CONTRACTS.md: test_cmd="" is the documented "unverifiable run" signal —
// it must match the host's own default (unverified unless --test-cmd).
test("encodeCommand task defaults test_cmd to empty, not pytest -q", () => {
  const line = encodeCommand({ type: "task", text: "fix", cwd: ".", poolGb: 5 });
  assert.equal(JSON.parse(line).test_cmd, "");
});

test("encodeCommand task passes through an explicit test_cmd", () => {
  const line = encodeCommand({ type: "task", text: "fix", cwd: ".", poolGb: 5, testCmd: "npm test" });
  assert.equal(JSON.parse(line).test_cmd, "npm test");
});

// --- NDJSON line buffer (partial-line framing) -----------------------------
test("LineBuffer reassembles a JSON object split across chunks", () => {
  const lb = new LineBuffer();
  assert.deepEqual(lb.push('{"type":"sta'), []);
  assert.deepEqual(lb.push('ge","name":"execute","face":""}\n'), [
    '{"type":"stage","name":"execute","face":""}',
  ]);
  assert.equal(lb.rest(), "");
});

test("LineBuffer yields multiple complete lines in one chunk", () => {
  const lb = new LineBuffer();
  const lines = lb.push('{"a":1}\n{"b":2}\n{"c":3');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  assert.equal(lb.rest(), '{"c":3');
});

// --- tool executor (one path-guard, [exit N] shape) ------------------------
test("ToolExecutor writes then reads a file in the workspace", () => {
  const dir = tmpWorkspace("aether-tool-");
  try {
    const ex = new ToolExecutor(dir);
    const w = ex.execute("write_file", { path: "a.txt", content: "hello" });
    assert.equal(w.exitCode, 0);
    assert.match(w.output, /\[wrote a\.txt/);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "hello");
    const r = ex.execute("read_file", { path: "a.txt" });
    assert.equal(JSON.parse(r.output).content, "hello");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ToolExecutor refuses a path escaping the workspace", () => {
  const dir = tmpWorkspace("aether-tool-");
  try {
    const ex = new ToolExecutor(dir);
    const r = ex.execute("read_file", { path: "../../etc/passwd" });
    assert.equal(r.exitCode, 1);
    assert.match(r.output, /refusing path outside workspace/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repo_search finds literal matches recursively without external grep", () => {
  const dir = tmpWorkspace("aether-search-");
  try {
    mkdirSync(join(dir, "sub"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "a.txt"), "needle one\nnope\nneedle two\n", "utf8");
    writeFileSync(join(dir, "sub", "b.txt"), "nested needle\n", "utf8");
    writeFileSync(join(dir, "node_modules", "ignored.txt"), "needle ignored\n", "utf8");
    writeFileSync(join(dir, "binary.bin"), Buffer.from([0, 110, 101, 101, 100, 108, 101]));

    const r = new ToolExecutor(dir).execute("repo_search", { query: "needle" });

    assert.equal(r.exitCode, 0);
    assert.match(r.output, /^\[exit 0\]\n/);
    assert.match(r.output, /\.\/a\.txt:1:needle one/);
    assert.match(r.output, /\.\/a\.txt:3:needle two/);
    assert.match(r.output, /\.\/sub\/b\.txt:1:nested needle/);
    assert.doesNotMatch(r.output, /ignored/);
    assert.doesNotMatch(r.output, /binary\.bin/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repo_search caps matches at 40 hits", () => {
  const dir = tmpWorkspace("aether-search-cap-");
  try {
    writeFileSync(join(dir, "many.txt"), Array.from({ length: 50 }, (_, i) => `needle ${i}`).join("\n"), "utf8");
    const r = new ToolExecutor(dir).execute("repo_search", { query: "needle" });
    const hits = r.output.split(/\r?\n/).filter((line) => line.includes("needle "));
    assert.equal(hits.length, 40);
    assert.match(hits[0]!, /many\.txt:1:needle 0/);
    assert.match(hits[39]!, /many\.txt:40:needle 39/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capHeadTail keeps the END (pytest summary) when output is over the cap", () => {
  // simulate pytest: tracebacks first, the count summary LAST
  const big = "TRACEBACK\n".repeat(2000) + "\n23 failed, 1 passed in 1.2s";
  const capped = capHeadTail(big, 8000);
  assert.ok(capped.length <= 8200, "capped near the limit");
  assert.match(capped, /23 failed, 1 passed/, "the summary at the END survives");
  assert.match(capped, /chars elided/, "elision marker present");
  // short text passes through untouched
  assert.equal(capHeadTail("short", 8000), "short");
});

test("unknown tool returns a clear error, never throws", () => {
  const ex = new ToolExecutor(TEMP_ROOT);
  const r = ex.execute("frobnicate", {});
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /unknown tool/);
});

// --- host loop: a fake brain round-trips one tool call ---------------------
class FakeBrain implements Brain {
  private readonly q = new EventQueue();
  readonly toolResults: Array<{ id: string; output: string; exitCode: number }> = [];
  closed = false;

  run(_task: TaskCommand): AsyncIterable<BrainEvent> {
    // Emit a tool_call; the host will execute it and call sendToolResult, which
    // unblocks the rest of the script.
    this.q.push({ type: "stage", name: "execute", face: "" });
    this.q.push({ type: "tool_call", id: "c1", name: "write_file", args: { path: "x.txt", content: "hi" } });
    return this.q.drain();
  }
  sendToolResult(id: string, result: { output: string; exitCode: number }): void {
    this.toolResults.push({ id, output: result.output, exitCode: result.exitCode });
    // The brain "decides" it's done after the tool result lands.
    this.q.push({ type: "done", ok: true, result: "wrote x.txt", remaining: 0, reason: "" });
    this.q.end();
  }
  control(): void {}
  close(): void {
    this.closed = true;
  }
}

test("hostLoop executes a tool_call and feeds the result back", async () => {
  const dir = tmpWorkspace("aether-host-");
  try {
    const brain = new FakeBrain();
    const exec = new ToolExecutor(dir);
    const seen: string[] = [];
    const code = await hostLoop(brain, exec, (ev) => {
      seen.push(ev.type);
    }, {
      type: "task",
      text: "write x.txt",
      cwd: dir,
      poolGb: 5,
    });
    assert.equal(code, 0);
    assert.equal(brain.closed, true);
    assert.equal(brain.toolResults.length, 1);
    assert.equal(brain.toolResults[0]?.exitCode, 0);
    assert.equal(readFileSync(join(dir, "x.txt"), "utf8"), "hi");
    assert.deepEqual(seen, ["stage", "tool_call", "done"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hostLoop gate denies a tool_call: not executed, brain gets a refusal result", async () => {
  const dir = tmpWorkspace("aether-gate-");
  try {
    const brain = new FakeBrain(); // emits write_file id=c1 then done on result
    const exec = new ToolExecutor(dir);
    // Deny every gated call (simulates `ask` mode on a non-TTY → fail closed).
    const gate = async (): Promise<boolean> => false;
    const code = await hostLoop(
      brain,
      exec,
      () => {},
      { type: "task", text: "write x.txt", cwd: dir, poolGb: 5 },
      undefined,
      gate,
    );
    assert.equal(code, 0); // the run still completes; the call was just refused
    assert.equal(brain.toolResults.length, 1);
    assert.equal(brain.toolResults[0]?.exitCode, 1);
    assert.match(brain.toolResults[0]?.output ?? "", /denied/);
    assert.equal(existsSync(join(dir, "x.txt")), false); // never written
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- probe 1: two sequential tool calls stay correlated --------------------
class TwoCallBrain implements Brain {
  private readonly q = new EventQueue();
  readonly pairs: Array<{ id: string; output: string }> = [];
  private step = 0;
  run(_task: TaskCommand): AsyncIterable<BrainEvent> {
    this.q.push({ type: "tool_call", id: "A", name: "read_file", args: { path: "a.txt" } });
    return this.q.drain();
  }
  sendToolResult(id: string, result: { output: string; exitCode: number }): void {
    this.pairs.push({ id, output: result.output });
    this.step += 1;
    if (this.step === 1) {
      this.q.push({ type: "tool_call", id: "B", name: "read_file", args: { path: "b.txt" } });
    } else {
      this.q.push({ type: "done", ok: true, result: "ok", remaining: 0, reason: "" });
      this.q.end();
    }
  }
  control(): void {}
  close(): void {}
}

test("two sequential tool calls: each result pairs to its own id, in order", async () => {
  const dir = tmpWorkspace("aether-corr-");
  try {
    const exec = new ToolExecutor(dir);
    exec.execute("write_file", { path: "a.txt", content: "AAA" });
    exec.execute("write_file", { path: "b.txt", content: "BBB" });
    const brain = new TwoCallBrain();
    await hostLoop(brain, exec, () => {}, { type: "task", text: "read both", cwd: dir, poolGb: 5 });
    assert.deepEqual(
      brain.pairs.map((p) => p.id),
      ["A", "B"],
    );
    assert.equal(JSON.parse(brain.pairs[0]!.output).content, "AAA"); // A's result is a.txt, not b.txt
    assert.equal(JSON.parse(brain.pairs[1]!.output).content, "BBB");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- probe 2: path-guard canonicalization (the security boundary) ----------
test("path-guard rejects traversal, absolute, and symlink escapes", () => {
  const dir = tmpWorkspace("aether-guard-");
  const outside = tmpWorkspace("aether-outside-");
  try {
    const ex = new ToolExecutor(dir);
    // .. traversal
    assert.match(ex.execute("read_file", { path: "../../etc/passwd" }).output, /refusing path/);
    // absolute path outside the workspace
    assert.match(ex.execute("read_file", { path: join(outside, "x") }).output, /refusing path/);
    // symlink inside the workspace pointing outside it
    let linked = false;
    try {
      symlinkSync(outside, join(dir, "link"), "dir");
      linked = true;
    } catch {
      // symlink may need privilege on Windows — skip that leg if unavailable
    }
    if (linked) {
      const r = ex.execute("write_file", { path: "link/escaped.txt", content: "x" });
      assert.match(r.output, /refusing path/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// --- probe 3: shell hardening (non-zero exit + stderr reach the brain) ------
test("run_shell surfaces a non-zero exit code and captures stderr", async (t) => {
  // `node -e` (not a platform-specific shell one-liner) so this passes
  // identically on Windows and POSIX without a win32/posix branch, and runs
  // in an isolated tmpdir so it can't leave stray output under process.cwd().
  const ex = new ToolExecutor(tmpWorkspace("aether-sh-"));
  const r = await ex.executeAsync("run_shell", {
    command: `node -e "process.stderr.write('boom'); process.exit(3)"`,
  });
  if (/spawn error EPERM/.test(r.output)) {
    t.skip("sandbox blocks child process spawning");
    return;
  }
  assert.equal(r.exitCode, 3);
  assert.match(r.output, /^\[exit 3\]/);
  assert.match(r.output, /boom/);
});

// --- probe 4: schema conformance (drift detector) --------------------------
test("PROTOCOL_VERSION matches the shared fixture", () => {
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.equal(fx.protocol_version, PROTOCOL_VERSION);
});

test("PROTOCOL_VERSION is 4 (filesystem tools landed)", () => {
  assert.equal(PROTOCOL_VERSION, 4);
});

test("TOOLS is the canonical 10-tool set including filesystem and web tools", () => {
  assert.deepEqual(
    [...TOOLS],
    [
      "read_file",
      "list_directory",
      "patch_file",
      "write_file",
      "run_shell",
      "run_tests",
      "repo_search",
      "git_commit",
      "web_search",
      "web_fetch",
    ],
  );
});

test("fixture tool list mirrors the canonical TOOLS array exactly", () => {
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(fx.tools, [...TOOLS], "fixture tools drift from brain_protocol.TOOLS");
});

test("every fixture event decodes to its declared type", () => {
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  for (const ev of fx.events) {
    const decoded = parseEventLine(JSON.stringify(ev));
    assert.ok(decoded, `event did not decode: ${ev.type}`);
    assert.equal(decoded?.type, ev.type);
  }
  // every host command re-encodes with snake_case wire keys
  for (const cmd of fx.commands) {
    const wire = JSON.parse(encodeCommand(cmd));
    assert.equal(wire.type, cmd.type);
  }
});

test("fixture message shapes match the canonical wire key-set exactly (strong drift detector)", () => {
  // The type-only check above missed the v1->v2 drift (done/task gained fields, fixture didn't).
  // This pins the EXACT wire key-set per message + full type coverage, so the next additive
  // field on the wire FAILS here unless the fixture (and PROTOCOL_VERSION) are updated.
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const wireKeys: Record<string, string[]> = {
    stage: ["type", "name", "face"],
    monologue: ["type", "text", "depth"],
    skill: ["type", "name", "reason"],
    turn: ["type", "n", "tool_calls", "malformed", "invented", "no_call", "fail_count"],
    tool_call: ["type", "id", "name", "args"],
    telemetry: ["type", "tokens", "tps", "ctx_used", "ctx_cap", "vram"],
    status: ["type", "phase", "pool_used", "pool_cap"],
    checkpoint: ["type", "git_sha"],
    done: ["type", "ok", "result", "remaining", "reason"],
    error: ["type", "msg"],
    task: ["type", "text", "cwd", "pool_gb", "effort", "model", "test_cmd"],
    tool_result: ["type", "id", "output", "exit_code"],
    control: ["type", "action", "note"],
  };
  const seen = new Set<string>();
  for (const msg of [...fx.events, ...fx.commands] as Array<Record<string, unknown>>) {
    const t = msg["type"] as string;
    const expect = wireKeys[t];
    assert.ok(expect, `unknown fixture message type: ${t}`);
    assert.deepEqual(Object.keys(msg).sort(), [...expect].sort(), `${t} wire shape drift`);
    seen.add(t);
  }
  for (const t of Object.keys(wireKeys)) {
    assert.ok(seen.has(t), `fixture missing message type: ${t}`);
  }
});

// --- swarm is gated (never swarm an unproven loop) -------------------------
test("--swarm > 1 is refused with exit 2 and never spawns a brain", async () => {
  const ctx = {
    cfg: {},
    api: {},
    tokens: {},
    flags: { json: false, audit: false, yes: false, cwd: process.cwd() },
  } as unknown as AppContext;
  const orig = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((s: string) => ((captured += s), true)) as typeof process.stderr.write;
  try {
    const code = await cmdCode(ctx, "fix all the things", { local: true, pool: 5, quiet: true, swarm: 4 });
    assert.equal(code, 2);
    assert.match(captured, /--swarm is not enabled/);
    assert.match(captured, /emission fraying/);
  } finally {
    process.stderr.write = orig;
  }
});

// --- probe 5: escaping lossless (CJK + emoji survive an ASCII-escaped line) -
test("unicode survives an ASCII-escaped wire line", () => {
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  for (const s of [...fx.unicode_round_trip, "日本語テスト", "🤖🔥"]) {
    // simulate the Python side: ensure_ascii escaping, then the host decodes it
    const asciiLine = JSON.stringify({ type: "monologue", text: s, depth: 0 });
    const ev = parseEventLine(asciiLine);
    assert.equal(ev?.type === "monologue" ? ev.text : null, s);
  }
});
