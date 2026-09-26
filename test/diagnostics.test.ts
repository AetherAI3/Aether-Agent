import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { cmdDoctor } from "../src/commands/doctor.js";
import type { AppContext } from "../src/core/context.js";
import {
  diagnosticReport,
  executeDiagnosticChecks,
  type DiagnosticCheckSpec,
} from "../src/core/diagnostics.js";
import type { McpClient } from "../src/core/mcp.js";
import { LocalMcpStore } from "../src/core/mcp_store.js";
import type { MemoryRoots } from "../src/core/memory.js";

const SECRET = "SENTINEL-doctor-never-exposes-this";

function setup(): {
  ctx: AppContext;
  roots: MemoryRoots;
  store: LocalMcpStore;
  client: McpClient;
  counters: { backend: number; broker: number };
} {
  const root = mkdtempSync(join(tmpdir(), "aether-doctor-"));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  mkdirSync(join(cwd, ".git"));
  const logs = join(root, "logs");
  const snapshots = join(root, "snapshots");
  mkdirSync(logs);
  mkdirSync(snapshots);
  const goals = join(root, "goals.json");
  writeFileSync(
    goals,
    JSON.stringify([
      {
        id: "legacy",
        title: SECRET,
        phases: [],
        status: "idle",
        createdAt: "2020-01-01T00:00:00.000Z",
      },
    ]),
  );
  const roots: MemoryRoots = {
    logs,
    snapshots,
    goals,
    history: join(root, "history"),
    legacyHistory: join(root, "legacy-history"),
  };
  writeFileSync(roots.legacyHistory, SECRET);
  const store = new LocalMcpStore(join(root, "mcp.json"));
  store.add({
    name: "docs",
    url: "https://mcp.example.test/sse?token=" + SECRET,
    transport: "http",
    authToken: SECRET,
  });
  const counters = { backend: 0, broker: 0 };
  const ctx = {
    cfg: { baseUrl: "https://api.example.test" },
    flags: { cwd, json: false, audit: false, yes: false },
    tokens: { get: async () => SECRET },
    api: {
      async getJson() {
        counters.backend += 1;
        return { models: [] };
      },
    },
    confirm: async () => false,
  } as unknown as AppContext;
  const client = {
    async listProviders() {
      counters.broker += 1;
      return [{ provider_id: "docs", display_name: "Docs", flow: "pat_paste" }];
    },
    async listConnections() {
      counters.broker += 1;
      return [{ provider_id: "docs", created_at: "t", updated_at: "t" }];
    },
    async listTools() {
      counters.broker += 1;
      return [{ name: "search" }];
    },
  } as unknown as McpClient;
  return { ctx, roots, store, client, counters };
}

function sink(): { out: Writable; text(): string } {
  const chunks: string[] = [];
  return {
    out: { write: (value: string) => (chunks.push(value), true) } as unknown as Writable,
    text: () => chunks.join(""),
  };
}

test("diagnostic executor preserves declaration order under concurrency", async () => {
  const spec = (id: string, delay: number): DiagnosticCheckSpec => ({
    id,
    category: "test",
    title: id,
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { configured: { state: "yes" as const, evidence: id }, severity: "info" as const };
    },
  });
  const checks = await executeDiagnosticChecks(
    [spec("first", 30), spec("second", 2), spec("third", 10)],
    3,
  );
  assert.deepEqual(checks.map((check) => check.id), ["first", "second", "third"]);
  assert.deepEqual(checks.map((check) => check.configured.state), ["yes", "yes", "yes"]);
  // An axis a check does not speak to defaults to not-checked, never to a pass.
  assert.deepEqual(checks.map((check) => check.verified.state), [
    "not-checked",
    "not-checked",
    "not-checked",
  ]);
});

test("fast doctor is local, ordered, fail-soft, and content-redacted", async () => {
  const { ctx, roots, store, client, counters } = setup();
  const report = await diagnosticReport(ctx, {
    dependencies: {
      now: "2026-07-10T00:00:00.000Z",
      memoryRoots: roots,
      mcpStore: store,
      mcpClient: client,
      outputDir: mkdtempSync(join(tmpdir(), "aether-doctor-media-")),
      timeoutMs: 50,
    },
  });
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.mode, "fast");
  assert.deepEqual(report.checks.map((check) => check.id), [
    "runtime.node",
    "workspace.directory",
    "workspace.git",
    "agent.transport",
    "auth.credential",
    "agent.catalog",
    "tools.schemas",
    "tools.gates",
    "memory.health",
    "mcp.registry",
    "mcp.broker",
    "persistence.local",
    "media.history",
    "opener.local",
    "github.connection",
    "custody.receipts",
    "actions.dispatch",
    "predator.readiness",

    "skills.index",

    "skills.lock",

    "skills.trust",

    "skills.evals",

    "instructions.graph",

    "instructions.conflicts",
  ]);
  // The whole point of fast mode: nothing remote was contacted, and the report
  // says so instead of implying otherwise.
  assert.deepEqual(counters, { backend: 0, broker: 0 });
  // Skill and instruction checks are filesystem-only: they must declare
  // reachable as n/a rather than borrowing a pass they never earned.
  for (const id of ["skills.index", "instructions.graph"]) {
    assert.equal(report.checks.find((check) => check.id === id)?.reachable.state, "na", id);
  }
  assert.equal(
    report.checks.find((check) => check.id === "agent.transport")?.reachable.state,
    "not-checked",
  );
  assert.equal(
    report.checks.find((check) => check.id === "agent.catalog")?.verified.state,
    "not-checked",
  );
  assert.equal(JSON.stringify(report).includes(SECRET), false);
  assert.match(
    report.checks.find((check) => check.id === "memory.health")?.configured.evidence ?? "",
    /never auto-injected/,
  );
});

test("fast doctor distinguishes the absent Actions surface from read-only Drive readiness", async () => {
  const { ctx, roots, store, client } = setup();
  const report = await diagnosticReport(ctx, {
    dependencies: { memoryRoots: roots, mcpStore: store, mcpClient: client },
  });
  const actions = report.checks.find((entry) => entry.id === "actions.dispatch");
  assert.equal(actions?.verified.state, "na");
  assert.match(String(actions?.verified.evidence), /this build has no/);
  const drive = report.checks.find((entry) => entry.id === "predator.readiness");
  assert.equal(drive?.configured.state, "yes");
  assert.equal(drive?.reachable.state, "not-checked");
  assert.equal(drive?.verified.state, "not-checked");
  assert.match(String(drive?.verified.evidence), /aether mcp doctor drive/);
});

test("fast doctor contacts nothing even when --deep is passed", async () => {
  const { ctx, roots, store, client, counters } = setup();
  const captured = sink();
  const code = await cmdDoctor(ctx, ["--deep"], {
    out: captured.out,
    dependencies: { memoryRoots: roots, mcpStore: store, mcpClient: client },
  });
  assert.equal(code, 0);
  assert.deepEqual(counters, { backend: 0, broker: 0 }, "--deep stayed read-only");
  // --deep must keep meaning what it meant, and point at the new mode.
  assert.match(captured.text(), /--deep is the read-only report \(unchanged\)/);
  assert.match(captured.text(), /aether doctor --live/);
});

test("a hanging backend cannot stall the fast report", async () => {
  const { ctx, roots, store } = setup();
  ctx.api = { getJson: async () => new Promise(() => {}) } as unknown as AppContext["api"];
  const hanging = {
    listProviders: async () => new Promise(() => {}),
    listConnections: async () => new Promise(() => {}),
    listTools: async () => new Promise(() => {}),
  } as unknown as McpClient;
  const started = Date.now();
  const report = await diagnosticReport(ctx, {
    dependencies: { memoryRoots: roots, mcpStore: store, mcpClient: hanging, timeoutMs: 50 },
  });

  // What must hold is that the report CAME BACK and told the truth about the
  // probes it could not complete. The previous assertion was a 500ms wall-clock
  // budget, which measured the machine rather than the behaviour: a loaded CI
  // runner blows it even when the 50ms timeout fired exactly as designed
  // (observed on windows-latest at 689ms, and locally at 1818ms under full-suite
  // load while passing in isolation at 82ms).
  assert.equal(report.mode, "fast");

  // A probe fed by one of the hanging clients must never come back claiming it
  // verified anything. Named explicitly rather than filtered on an axis: local
  // checks like workspace.git legitimately verify here, because nothing about
  // them touches the backend that is hanging.
  const BACKEND_FED = ["agent.transport", "auth.credential", "agent.catalog", "mcp.broker"];
  const probed = report.checks.filter((check) => BACKEND_FED.includes(check.id));
  assert.equal(probed.length, BACKEND_FED.length, "every backend-fed check should be present in the report");
  for (const check of probed) {
    assert.notEqual(check.verified.state, "yes", `${check.id} cannot be verified against a hanging backend`);
  }

  // Still bound the wall clock, but as a hang detector rather than a stopwatch.
  // The failure this guards against is an unbounded await, which never returns
  // at all; any finite margin distinguishes that from a slow runner.
  assert.ok(
    Date.now() - started < 30_000,
    "the fast report must be bounded by its own timeout, not by the backend",
  );
});

test("--live renders the live report, never the fast one relabelled", async () => {
  const { ctx, roots, store, client } = setup();
  const captured = sink();
  await cmdDoctor(ctx, ["--live", "--no-ui"], {
    out: captured.out,
    dependencies: { memoryRoots: roots, mcpStore: store, mcpClient: client },
    liveOptions: { timeoutMs: 500, mcpStore: store, mcpClient: client, skipOpenerProbe: true },
  });
  const text = captured.text();
  assert.match(text, /Aether doctor v2 \(live\)/);
  // The fast-mode footer must not appear on a live run.
  assert.equal(text.includes("Remote reachability is not checked in fast mode"), false);
  assert.match(text, /spend\.none/);
  assert.equal(text.includes(SECRET), false);
});

test("--live and --fix are refused together rather than half-applied", async () => {
  const { ctx } = setup();
  const captured = sink();
  assert.equal(await cmdDoctor(ctx, ["--live", "--fix"], { out: captured.out }), 2);
  assert.match(captured.text(), /separate modes/);
});

test("doctor command supports JSON and rejects unknown arguments", async () => {
  const { ctx, roots, store, client } = setup();
  ctx.flags.json = true;
  const captured = sink();
  const code = await cmdDoctor(ctx, [], {
    out: captured.out,
    dependencies: {
      memoryRoots: roots,
      mcpStore: store,
      mcpClient: client,
      now: "2026-07-10T00:00:00.000Z",
      outputDir: mkdtempSync(join(tmpdir(), "aether-doctor-json-")),
    },
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(captured.text());
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.mode, "fast");
  assert.equal(parsed.generatedAt, "2026-07-10T00:00:00.000Z");
  assert.equal(captured.text().includes(SECRET), false);

  const bad = sink();
  assert.equal(await cmdDoctor(ctx, ["surprise"], { out: bad.out }), 2);
  assert.match(bad.text(), /usage/);
});
