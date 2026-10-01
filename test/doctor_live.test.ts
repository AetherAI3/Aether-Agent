import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../src/core/context.js";
import type { McpClient } from "../src/core/mcp.js";
import { LocalMcpStore } from "../src/core/mcp_store.js";
import type { RunResult, Runner } from "../src/core/worktree.js";
import type { HealthCheck, HealthReport } from "../src/core/health.js";
import { renderHealthReport } from "../src/core/health.js";
import {
  CLOUD_DOCTOR_CONTRACT_COMMIT,
  CLOUD_DOCTOR_PROBE_CONTENT,
  cloudDoctorCreateRequest,
  cloudDoctorEngineFrames,
} from "./fixtures/cloud_doctor_engine.js";
import {
  agentUnproven,
  branchFreshness,
  branchProbe,
  custodyProbe,
  githubProbe,
  liveReport,
  openerProbe,
  pickDoctorSafeTool,
  seqIsMonotonic,
  spendCheck,
  SpendLedger,
  type LiveOptions,
} from "../src/core/doctor_live.js";

const RUN_ID = "0198f4c2-0000-4000-8000-000000000001";
const LOCAL = "a".repeat(40);
const REMOTE = "b".repeat(40);

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "aether-live-"));
}

function find(report: HealthReport, id: string): HealthCheck {
  const check = report.checks.find((entry) => entry.id === id);
  assert.ok(check, `no check with id ${id}`);
  return check;
}

/** A Runner that answers from a table keyed by the argv it receives. */
function fakeRunner(table: Record<string, Partial<RunResult>>): Runner {
  return (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    for (const [pattern, result] of Object.entries(table)) {
      if (key.includes(pattern)) return { status: 0, stdout: "", stderr: "", ...result };
    }
    return { status: 1, stdout: "", stderr: "no match" };
  };
}

function sseBytes(frames: readonly Record<string, unknown>[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) {
        yield encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
      }
    },
  };
}

interface FakeServer {
  created?: Record<string, unknown>;
  frames?: Array<Record<string, unknown>>;
  closeFails?: boolean;
  catalog?: unknown;
}

interface Recorded {
  ctx: AppContext;
  posts: Array<{ path: string; body: unknown }>;
  deletes: string[];
}

function fakeCtx(server: FakeServer = {}, cwd = process.cwd()): Recorded {
  const posts: Array<{ path: string; body: unknown }> = [];
  const deletes: string[] = [];
  const ctx = {
    cfg: { baseUrl: "https://api.example.invalid" },
    flags: { cwd, json: false, audit: false, yes: false },
    tokens: { get: async (): Promise<string | null> => "SYNTHETIC-TOKEN" },
    api: {
      async getJson(): Promise<unknown> {
        return server.catalog ?? {
          models: [{ id: "sonnet", kind: "model", available: true }],
          tier: "pro",
          default: "sonnet",
        };
      },
      async postJson(path: string, body: unknown): Promise<unknown> {
        posts.push({ path, body });
        if (path.endsWith("/control")) throw new Error("doctor_control_unsupported");
        if (path.endsWith("/tool-results")) return { ok: true };
        return server.created ?? { session_id: "sess-0198f4c2" };
      },
      async deleteJson(path: string): Promise<unknown> {
        deletes.push(path);
        if (server.closeFails) throw new Error("close refused");
        return {};
      },
      async stream(): Promise<AsyncIterable<Uint8Array>> {
        return sseBytes(server.frames ?? []);
      },
    },
    confirm: async (): Promise<boolean> => false,
  } as unknown as AppContext;
  return { ctx, posts, deletes };
}

const SESSION_ID = "sess-0198f4c2";
const CLOUD_DOCTOR_FRAMES = cloudDoctorEngineFrames(SESSION_ID);

function emptyStore(): LocalMcpStore {
  return new LocalMcpStore(join(mkdtempSync(join(tmpdir(), "aether-live-mcp-")), "mcp.json"));
}

function deadClient(): McpClient {
  const fail = async (): Promise<never> => {
    throw new Error("broker unavailable");
  };
  return { listProviders: fail, listConnections: fail, listTools: fail } as unknown as McpClient;
}

function liveOpts(over: Partial<LiveOptions> = {}): LiveOptions {
  return {
    runId: RUN_ID,
    timeoutMs: 2_000,
    skipOpenerProbe: true,
    mcpClient: deadClient(),
    mcpStore: emptyStore(),
    runner: fakeRunner({}),
    ...over,
  };
}

// ── pure helpers ────────────────────────────────────────────────────

test("frame sequence must be strictly increasing", () => {
  assert.equal(seqIsMonotonic([1, 2, 3]), true);
  assert.equal(seqIsMonotonic([1]), true);
  assert.equal(seqIsMonotonic([]), true);
  assert.equal(seqIsMonotonic([1, 1]), false, "a replayed seq is not progress");
  assert.equal(seqIsMonotonic([3, 2]), false);
});

test("only a tool that declares itself readOnly AND doctorSafe may be called", () => {
  assert.equal(pickDoctorSafeTool([{ name: "search" }]), null);
  assert.equal(pickDoctorSafeTool([{ name: "search", readOnly: true }]), null);
  assert.equal(pickDoctorSafeTool([{ name: "wipe", doctorSafe: true }]), null);
  assert.equal(pickDoctorSafeTool([{ name: "ping", readOnly: true, doctorSafe: true }]), "ping");
});

test("an unproven doctor loop never treats unsupported coding controls as a check", () => {
  const checks = agentUnproven("server said no");
  assert.equal(checks.length, 5);
  for (const check of checks) {
    if (check.id === "agent.session.control") {
      assert.equal(check.verified.state, "na");
      assert.match(String(check.verified.evidence), /purpose="doctor" deliberately rejects/);
      continue;
    }
    assert.equal(check.verified.state, "not-checked", `${check.id} must not claim a pass`);
    assert.equal(check.reachable.state, "not-checked");
    assert.match(String(check.verified.evidence), /server said no/);
    assert.match(String(check.remediation), /non-billable doctor session/);
  }
});

// ── branch freshness (no fetch) ─────────────────────────────────────

test("branch freshness classifies every state without fetching", () => {
  const base = {
    "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
    "rev-parse HEAD": { stdout: `${LOCAL}\n` },
  };
  const at = (over: Record<string, Partial<RunResult>>): string =>
    branchFreshness(fakeRunner({ ...base, ...over }), ".").state;

  assert.equal(at({ "ls-remote": { stdout: `${LOCAL}\trefs/heads/main\n` } }), "current");
  assert.equal(at({ "ls-remote": { stdout: "" } }), "unpublished");
  assert.equal(at({ "ls-remote": { status: 1 } }), "unknown");
  // origin's tip is not in the local object store — say so, never fetch to find out.
  assert.equal(
    at({ "ls-remote": { stdout: `${REMOTE}\trefs/heads/main\n` }, "cat-file": { status: 1 } }),
    "unknown",
  );
  assert.equal(
    at({
      "ls-remote": { stdout: `${REMOTE}\trefs/heads/main\n` },
      "cat-file": { status: 0 },
      [`merge-base --is-ancestor ${REMOTE} ${LOCAL}`]: { status: 0 },
    }),
    "ahead",
  );
  assert.equal(
    at({
      "ls-remote": { stdout: `${REMOTE}\trefs/heads/main\n` },
      "cat-file": { status: 0 },
      [`merge-base --is-ancestor ${LOCAL} ${REMOTE}`]: { status: 0 },
    }),
    "behind",
  );
  assert.equal(
    at({ "ls-remote": { stdout: `${REMOTE}\trefs/heads/main\n` }, "cat-file": { status: 0 } }),
    "diverged",
  );
  assert.equal(
    branchFreshness(fakeRunner({ "rev-parse --abbrev-ref HEAD": { stdout: "HEAD\n" } }), ".").state,
    "detached",
  );
  assert.equal(branchFreshness(fakeRunner({}), ".").state, "unknown");
});

test("the branch comparison never runs a mutating git command", () => {
  const seen: string[] = [];
  const runner: Runner = (cmd, args) => {
    seen.push([cmd, ...args].join(" "));
    if (args.includes("--abbrev-ref")) return { status: 0, stdout: "main\n", stderr: "" };
    if (args.includes("ls-remote")) {
      return { status: 0, stdout: `${LOCAL}\trefs/heads/main\n`, stderr: "" };
    }
    return { status: 0, stdout: `${LOCAL}\n`, stderr: "" };
  };
  branchProbe(runner, ".");
  const forbidden = /\b(fetch|pull|push|merge|rebase|reset|checkout|clean|commit)\b/;
  for (const command of seen) {
    assert.equal(forbidden.test(command), false, `mutating git command: ${command}`);
  }
});

// ── gh identity ─────────────────────────────────────────────────────

test("github identity reports the login, and a missing gh is a warning not a failure", () => {
  const authed = githubProbe(
    fakeRunner({ "gh auth status": { stdout: "Logged in to github.com account synthetic-user" } }),
  );
  assert.equal(authed.verified.state, "yes");
  assert.match(String(authed.verified.evidence), /synthetic-user/);

  const missing = githubProbe(fakeRunner({}));
  assert.equal(missing.verified.state, "no");
  assert.equal(missing.severity, "warning");
  assert.match(String(missing.remediation), /gh auth login/);
});

// ── custody receipt round trip ──────────────────────────────────────

test("the receipt round trip persists, reads back, and de-duplicates a replay", () => {
  const dir = sandbox();
  const check = custodyProbe(dir, RUN_ID);
  assert.equal(check.verified.state, "yes");
  assert.match(String(check.verified.evidence), /de-duplicated/);
  assert.ok(existsSync(join(dir, "custody.jsonl")));
});

test("the receipt proof writes only inside its sandbox", () => {
  const dir = sandbox();
  custodyProbe(dir, RUN_ID);
  assert.deepEqual(readdirSync(dir), ["custody.jsonl"]);
});

// ── spend ledger ────────────────────────────────────────────────────

test("the ledger records billed frames and unclosed sessions", () => {
  const clean = new SpendLedger();
  clean.sessionOpened();
  clean.observe({ type: "done", seq: 1, uvt: 0, cents: 0, ok: true });
  clean.sessionClosed();
  assert.equal(clean.spent, false);
  assert.equal(clean.orphaned, 0);
  assert.equal(spendCheck(clean).verified.state, "yes");

  const billed = new SpendLedger();
  billed.observe({ type: "usage", seq: 1, uvt: 12, cents: 3 });
  assert.equal(billed.spent, true);
  const check = spendCheck(billed);
  assert.equal(check.verified.state, "no");
  assert.equal(check.severity, "error");
  assert.match(String(check.verified.evidence), /this run was billed/);

  const orphan = new SpendLedger();
  orphan.sessionOpened();
  assert.equal(orphan.orphaned, 1);
  assert.equal(spendCheck(orphan).severity, "error");
});

// ── opener ──────────────────────────────────────────────────────────

test("a headless session reports the opener skipped, never verified", async () => {
  const check = await openerProbe({ headless: true });
  assert.equal(check.verified.state, "not-checked");
  assert.match(String(check.verified.evidence), /headless/);
});

test("the opener proof passes only when the opened page calls back", async () => {
  // Stand in for a browser: load the page, then run what its script would run.
  // Fetching the page alone is deliberately NOT enough — the callback is the
  // evidence that something actually rendered.
  const browser = (_file: string, args: string[]): unknown => {
    void (async () => {
      const target = new URL(args[0]!);
      await fetch(target.href).catch(() => {});
      const nonce = target.searchParams.get("nonce");
      await fetch(new URL(`/cb?nonce=${nonce}`, target.origin).href).catch(() => {});
    })();
    return { on: (): void => {}, unref: (): void => {} };
  };

  const verified = await openerProbe({
    openerTimeoutMs: 5_000,
    openerOptions: {
      platform: "linux",
      env: { DISPLAY: ":0" } as NodeJS.ProcessEnv,
      spawnFn: browser as never,
    },
  });
  assert.equal(verified.verified.state, "yes");
  assert.match(String(verified.verified.evidence), /called back on loopback/);

  // A process that spawns but renders nothing is not a pass.
  const silent = await openerProbe({
    openerTimeoutMs: 300,
    openerOptions: {
      platform: "linux",
      env: { DISPLAY: ":0" } as NodeJS.ProcessEnv,
      spawnFn: (() => ({ on: (): void => {}, unref: (): void => {} })) as never,
    },
  });
  assert.equal(silent.verified.state, "no");
  assert.match(String(silent.verified.evidence), /nothing rendered/);
});

// ── full live run ───────────────────────────────────────────────────

test("a server that will not confirm a non-billable session is closed, not driven", async () => {
  // No purpose/billable echo — the old server. Nothing may be spent.
  const { ctx, posts, deletes } = fakeCtx({ created: { session_id: "sess-legacy" } });
  const report = await liveReport(ctx, liveOpts());

  assert.equal(report.mode, "live");
  for (const id of ["agent.frames", "agent.tool.roundtrip"]) {
    assert.equal(find(report, id).verified.state, "not-checked");
  }
  assert.equal(find(report, "agent.session.control").verified.state, "na");
  assert.match(
    String(find(report, "agent.session").verified.evidence),
    /non-billable doctor session/,
  );
  assert.equal(deletes.length, 1, "the unconfirmed session was closed immediately");
  assert.equal(
    posts.some((p) => p.path.endsWith("/control")),
    false,
    "no control was issued",
  );
  assert.equal(find(report, "spend.none").verified.state, "yes");
});

test("the create request carries the doctor purpose and a zero spend ceiling", async () => {
  const { ctx, posts } = fakeCtx({ created: { session_id: "sess-legacy" } });
  await liveReport(ctx, liveOpts());
  const create = posts.find((p) => p.path === "/agent/dev/sessions");
  assert.ok(create);
  assert.deepEqual(create.body, cloudDoctorCreateRequest(RUN_ID));
});

test("the live catalogue probe accepts the production envelope and legacy array", async () => {
  for (const catalog of [
    { models: [{ id: "sonnet", kind: "model", available: true }], tier: "pro", default: "sonnet" },
    [{ id: "sonnet", kind: "model", available: true }],
  ]) {
    const { ctx } = fakeCtx({ catalog });
    const report = await liveReport(ctx, liveOpts());
    const result = find(report, "agent.catalog");
    assert.equal(result.verified.state, "yes");
    assert.match(String(result.verified.evidence), /1 catalog item\(s\), 1 available/);
  }
});

test("the live catalogue probe names an invalid envelope instead of inventing zero models", async () => {
  const { ctx } = fakeCtx({ catalog: { tier: "pro", default: "sonnet" } });
  const report = await liveReport(ctx, liveOpts());
  const result = find(report, "agent.catalog");
  assert.equal(result.verified.state, "no");
  assert.equal(result.severity, "error");
  assert.match(String(result.verified.evidence), /invalid \/models response shape/);
  assert.doesNotMatch(String(result.verified.evidence), /0 catalog item/);
});

test("the exact Cloud doctor engine fixture completes its sandboxed write/read probe", async () => {
  const { ctx, posts, deletes } = fakeCtx({
    created: { session_id: SESSION_ID, purpose: "doctor", billable: false },
    frames: CLOUD_DOCTOR_FRAMES,
  });
  const report = await liveReport(ctx, liveOpts());

  assert.equal(find(report, "agent.session").verified.state, "yes");
  assert.equal(find(report, "agent.frames").verified.state, "yes");
  assert.match(String(find(report, "agent.frames").verified.evidence), /seq 1\.\.8/);
  assert.equal(find(report, "agent.session.control").verified.state, "na");
  assert.equal(find(report, "agent.tool.roundtrip").verified.state, "yes");
  assert.equal(find(report, "agent.session.close").verified.state, "yes");
  assert.equal(find(report, "spend.none").verified.state, "yes");

  assert.equal(CLOUD_DOCTOR_CONTRACT_COMMIT, "66eb07505684af2482669aede9af5da5ccfac04e");
  assert.deepEqual(
    posts.filter((p) => p.path.endsWith("/tool-results")).map((p) => p.body),
    [
      {
        tool_call_id: `doctor:write_file:${SESSION_ID.slice(0, 8)}`,
        status: "ok",
        exit_code: 0,
        output: CLOUD_DOCTOR_PROBE_CONTENT,
      },
      {
        tool_call_id: `doctor:read_file:${SESSION_ID.slice(0, 8)}`,
        status: "ok",
        exit_code: 0,
        output: CLOUD_DOCTOR_PROBE_CONTENT,
      },
    ],
  );
  assert.equal(posts.some((p) => p.path.endsWith("/control")), false);
  assert.equal(deletes.length, 1);
});

test("a session the server bills is reported as an error, not a footnote", async () => {
  const { ctx } = fakeCtx({
    created: { session_id: "sess-0198f4c2", purpose: "doctor", billable: false },
    frames: [
      { type: "session", seq: 1, sessionId: "sess-0198f4c2", protocolVersion: 1 },
      { type: "done", seq: 2, uvt: 42, cents: 7, ok: true },
    ],
  });
  const report = await liveReport(ctx, liveOpts());
  const spend = find(report, "spend.none");
  assert.equal(spend.verified.state, "no");
  assert.equal(spend.severity, "error");
  assert.match(String(spend.verified.evidence), /this run was billed/);
});

test("an out-of-order frame fails the sequence proof", async () => {
  const { ctx } = fakeCtx({
    created: { session_id: "sess-0198f4c2", purpose: "doctor", billable: false },
    frames: [
      { type: "session", seq: 5, sessionId: "sess-0198f4c2", protocolVersion: 1 },
      { type: "done", seq: 2, uvt: 0, cents: 0, ok: true },
    ],
  });
  const report = await liveReport(ctx, liveOpts());
  assert.equal(find(report, "agent.frames").verified.state, "no");
  assert.equal(find(report, "agent.frames").severity, "error");
});

test("doctor purpose never issues pause, resume, or steer", async () => {
  const { ctx } = fakeCtx({
    created: { session_id: SESSION_ID, purpose: "doctor", billable: false },
    frames: CLOUD_DOCTOR_FRAMES,
  });
  const report = await liveReport(ctx, liveOpts());
  const control = find(report, "agent.session.control");
  assert.equal(control.verified.state, "na");
  assert.equal(control.severity, "info");
  assert.match(String(control.verified.evidence), /not part of the zero-spend probe/);
});

test("a session that will not close is an orphan, and says so", async () => {
  const { ctx } = fakeCtx({
    created: { session_id: "sess-0198f4c2", purpose: "doctor", billable: false },
    frames: CLOUD_DOCTOR_FRAMES,
    closeFails: true,
  });
  const report = await liveReport(ctx, liveOpts());
  assert.equal(find(report, "agent.session.close").verified.state, "no");
  const spend = find(report, "spend.none");
  assert.equal(spend.verified.state, "no");
  assert.match(String(spend.verified.evidence), /session\(s\) left open/);
});

test("a broker with no doctor-safe tool is reachable but unproven", async () => {
  const client = {
    listProviders: async () => [{ provider_id: "docs", display_name: "Docs", flow: "pat_paste" }],
    listConnections: async () => [{ provider_id: "docs", created_at: "t", updated_at: "t" }],
    listTools: async () => [{ name: "search" }],
  } as unknown as McpClient;
  const { ctx } = fakeCtx({ created: { session_id: "s" } });
  const report = await liveReport(ctx, liveOpts({ mcpClient: client }));
  const mcp = find(report, "mcp.broker");
  assert.equal(mcp.reachable.state, "yes");
  assert.equal(mcp.verified.state, "not-checked");
  assert.match(String(mcp.verified.evidence), /readOnly \+ doctorSafe/);
});

test("a declared doctor-safe MCP tool is still unverified without an invocation route", async () => {
  const client = {
    listProviders: async () => [{ provider_id: "docs", display_name: "Docs", flow: "pat_paste" }],
    listConnections: async () => [{ provider_id: "docs", created_at: "t", updated_at: "t" }],
    listTools: async () => [{ name: "synthetic-health", readOnly: true, doctorSafe: true }],
  } as unknown as McpClient;
  const { ctx } = fakeCtx({ created: { session_id: "s" } });
  const report = await liveReport(ctx, liveOpts({ mcpClient: client }));
  const mcp = find(report, "mcp.broker");
  assert.equal(mcp.reachable.state, "yes");
  assert.equal(mcp.verified.state, "not-checked");
  assert.match(String(mcp.verified.evidence), /listing a tool is not execution proof/);
});

test("a hanging live-doctor MCP provider is aborted at the shared lifecycle bound", async () => {
  const observed: AbortSignal[] = [];
  const hang = (options?: { signal?: AbortSignal }): Promise<never> => {
    const signal = options?.signal;
    assert.ok(signal, "doctor forwards a cancellation signal into the MCP client");
    observed.push(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("SYNTHETIC-SHOULD-NOT-LEAK")), { once: true });
    });
  };
  const client = {
    listProviders: hang,
    listConnections: hang,
    listTools: hang,
  } as unknown as McpClient;
  const { ctx } = fakeCtx({ created: { session_id: "s" } });
  const report = await liveReport(ctx, liveOpts({ mcpClient: client, timeoutMs: 20 }));
  const mcp = find(report, "mcp.broker");
  assert.equal(mcp.reachable.state, "no");
  assert.ok(observed.length >= 2);
  assert.ok(observed.every((signal) => signal.aborted), "every in-flight MCP request was aborted");
  assert.doesNotMatch(JSON.stringify(mcp), /SYNTHETIC-SHOULD-NOT-LEAK/);
});

test("signed out means the agent loop is unproven, not failed", async () => {
  const { ctx, posts } = fakeCtx();
  (ctx as unknown as { tokens: { get: () => Promise<string | null> } }).tokens = {
    get: async () => null,
  };
  const report = await liveReport(ctx, liveOpts());
  assert.equal(find(report, "auth.credential").verified.state, "no");
  assert.equal(find(report, "agent.session").verified.state, "not-checked");
  assert.equal(
    posts.some((p) => p.path === "/agent/dev/sessions"),
    false,
    "no session was created",
  );
});

test("live doctor reports registry and DM gates separately in human and JSON output", async () => {
  const { ctx } = fakeCtx();
  (ctx.api as unknown as { getJson: (path: string) => Promise<unknown> }).getJson = async (path) => {
    if (path.endsWith("/readiness")) return {
      schema_version: "aether.terminal-readiness/1", required_contract: "aether.managed-agents/1.1",
      registry: { state: "enabled", code: "READY", reason: "Ready", remedy: "None" },
      dm: { state: "disabled", code: "DM_DISABLED", reason: "Disabled", remedy: "Enable DMs" },
      model_uvt: { state: "disabled", code: "ADMISSION_DISABLED", reason: "Disabled", remedy: "Enable admission" },
    };
    return { models: [{ id: "sonnet", kind: "model", available: true }], tier: "pro", default: "sonnet" };
  };
  const report = await liveReport(ctx, liveOpts());
  assert.equal(find(report, "online.terminal.registry").verified.state, "yes");
  assert.equal(find(report, "online.terminal.dm").verified.evidence, "DM_DISABLED");
  assert.equal(find(report, "online.terminal.model_uvt").verified.evidence, "ADMISSION_DISABLED");
  assert.match(JSON.stringify(report), /DM_DISABLED/);
  assert.match(renderHealthReport(report), /DM_DISABLED/);
});

test("a live run leaves no doctor sandbox behind", async () => {
  const runId = randomUUID();
  const prefix = `aether-doctor-${runId.slice(0, 8)}-`;
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith(prefix));
  const { ctx } = fakeCtx({
    created: { session_id: "sess-0198f4c2", purpose: "doctor", billable: false },
    frames: CLOUD_DOCTOR_FRAMES,
  });
  await liveReport(ctx, liveOpts({ runId }));
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith(prefix));
  assert.deepEqual(after, before, "the doctor sandbox was not cleaned up");
});

test("a live report never leaks the stored credential", async () => {
  const { ctx } = fakeCtx({
    created: { session_id: "sess-0198f4c2", purpose: "doctor", billable: false },
    frames: CLOUD_DOCTOR_FRAMES,
  });
  const report = await liveReport(ctx, liveOpts());
  assert.equal(JSON.stringify(report).includes("SYNTHETIC-TOKEN"), false);
});
