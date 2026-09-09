// RC-02 host transport — what the host says to the broker, and what it
// believes when the broker misbehaves.
//
// Four groups, ordered by what a mistake costs:
//
//   1. Outbound only, and nothing but observation  — §4, exit proofs 2 and 14
//   2. Broker failure degrades observation only    — §4.3, exit proof 10
//   3. Every ambiguous answer preserves the batch  — §5.3, exit proof 11
//   4. Revoke is local-first, server-final         — §5.4, exit proof 13
//
// No socket is opened and no request leaves the process: the ApiClient is a
// recording stub throughout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ApiClient } from "../src/core/transport.js";
import {
  RC_HOST_SCHEMA,
  RcError,
  attachHost,
  flushOutbox,
  heartbeatHost,
  registerSession,
  retryDelayMs,
  revokeHost,
  type RcHostDeps,
} from "../src/core/rc/host.js";
import {
  createOutbox,
  enqueueEvent,
  loadOutbox,
  saveOutbox,
  type OutboxRecord,
} from "../src/core/rc/outbox.js";

const SESSION = "rs_" + "b".repeat(32);
const DEVICE = "dev-1";
const PROJECT_ROOT = "/work/proj";

const REPO = {
  repo: "AetherAI3/aether-agent",
  branch: "main",
  base_commit: "0".repeat(40),
  dirty_file_count: 0,
};

interface Call {
  path: string;
  body: unknown;
}

/** An ApiClient stand-in. `answer` decides each response, or returns an Error
 *  to be thrown — the shape ApiClient uses for a non-2xx. */
function fakeApi(answer: (path: string, body: unknown) => unknown): ApiClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async postJson(path: string, body: unknown) {
      calls.push({ path, body });
      const result = answer(path, body);
      if (result instanceof Error) throw result;
      return result;
    },
    async getJson(path: string) {
      calls.push({ path, body: undefined });
      const result = answer(path, undefined);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as ApiClient & { calls: Call[] };
}

function httpError(status: number, detail?: unknown): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, detail });
}

function sandbox(): string {
  return join(mkdtempSync(join(tmpdir(), "aether-rc-host-")), "outbox.json");
}

function deps(api: ApiClient, outboxPath: string): RcHostDeps {
  return { api, outboxPath, projectRoot: PROJECT_ROOT };
}

function seeded(n = 2): OutboxRecord {
  const record = createOutbox({
    session_id: SESSION,
    project_ref: "proj",
    device_id: DEVICE,
    epoch: 1,
    project_root: PROJECT_ROOT,
  });
  for (let i = 0; i < n; i++) {
    enqueueEvent(record, "plan", { step: i, total_steps: n, title: `s${i}`, status: "running" });
  }
  return record;
}

/** Receipts matching whatever the host actually sent, from `from`+1 upward. */
function echoReceipts(from = 0) {
  return (_path: string, body: unknown): unknown => ({
    session_id: SESSION,
    receipts: (body as { events: Array<{ host_event_id: string }> }).events.map((e, i) => ({
      host_event_id: e.host_event_id,
      seq: from + i + 1,
    })),
  });
}

// ── 1. Outbound only, and nothing but observation ───────────────────────────

/**
 * Comments removed, so the guard below reads CODE.
 *
 * The modules it checks explain in prose why they must not open a socket, and
 * that prose necessarily names the very tokens being forbidden. Scanning raw
 * text would make documenting the rule a violation of it. The tradeoff is that
 * a `//` inside a string literal truncates that line early; for a
 * forbidden-substring scan that can only ever hide a call written after a URL
 * on the same line, which no formatter in this repository would produce.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

test("no RC module opens a listening socket", () => {
  // Exit proof 14. §4.1 is "the host opens no listening socket and binds no
  // port", and the cheapest way for that to stop being true is somebody adding
  // a small local server for convenience. Source-read, the same technique the
  // device-secret guard uses, because a runtime assertion only covers the
  // paths a test happens to walk.
  const rcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "core", "rc");
  const files = readdirSync(rcDir).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0, "no RC modules found — this guard would be vacuous");
  for (const name of files) {
    const code = withoutComments(readFileSync(join(rcDir, name), "utf8"));
    for (const forbidden of ["createServer", "node:net", "node:http", ".listen(", "Bun.serve"]) {
      assert.ok(!code.includes(forbidden), `src/core/rc/${name} must not reference ${forbidden}`);
    }
  }
});

test("the socket guard would actually catch a violation", () => {
  // A guard that strips comments could strip everything; this pins that a real
  // call still trips it, so the test above cannot pass vacuously.
  assert.ok(withoutComments("const s = createServer();").includes("createServer"));
  assert.ok(!withoutComments("// createServer is forbidden here").includes("createServer"));
});

test("register sends identifiers only, on the host route, and binds the device", async () => {
  const api = fakeApi(() => ({ session_id: SESSION, state: "active", device_id: DEVICE }));
  const session = await registerSession(deps(api, sandbox()), {
    project_ref: "proj",
    device_id: DEVICE,
    session_name: "my session",
    repo: REPO,
  });
  assert.equal(session.session_id, SESSION);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0]!.path, "/remote/sessions");
  assert.deepEqual(Object.keys(api.calls[0]!.body as object).sort(), [
    "device_id",
    "project_ref",
    "repo",
    "session_name",
  ]);
});

test("an append carries only the three wire fields, never the local bookkeeping", async () => {
  // host_seq, created_at and payload_digest are the host's own state. Sending
  // them would invite a broker to echo or reorder against values it does not
  // own, and the Cloud request model does not declare them.
  const record = seeded(2);
  const api = fakeApi(echoReceipts());
  await flushOutbox(deps(api, sandbox()), record);

  const body = api.calls[0]!.body as { device_id: string; events: Array<Record<string, unknown>> };
  assert.equal(api.calls[0]!.path, `/remote/sessions/${SESSION}/host/events`);
  assert.equal(body.device_id, DEVICE);
  for (const event of body.events) {
    assert.deepEqual(Object.keys(event).sort(), ["event_type", "host_event_id", "payload"]);
  }
});

test("attach never takes over an existing host", async () => {
  // §4 keeps exactly one exclusive host. A 409 means somebody else owns this
  // session, and the only correct response is to stop.
  const api = fakeApi(() => httpError(409, "host already attached"));
  await assert.rejects(
    () => attachHost(deps(api, sandbox()), SESSION, DEVICE),
    (err: unknown) => err instanceof RcError && err.code === "RC_HOST_CONFLICT",
  );
});

test("a heartbeat reports the session state and touches nothing else", async () => {
  const api = fakeApi(() => ({ session_id: SESSION, state: "active" }));
  const state = await heartbeatHost(deps(api, sandbox()), SESSION, DEVICE);
  assert.equal(state, "active");
  assert.equal(api.calls[0]!.path, `/remote/sessions/${SESSION}/host/heartbeat`);
  assert.deepEqual(api.calls[0]!.body, { device_id: DEVICE });
});

// ── 2. Broker failure degrades observation only ─────────────────────────────

test("an unreachable broker preserves the queue and reports a typed failure", async () => {
  const record = seeded(3);
  const api = fakeApi(() => new Error("ECONNREFUSED"));
  const outcome = await flushOutbox(deps(api, sandbox()), record);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, "RC_BROKER_UNREACHABLE");
  assert.equal(record.events.length, 3, "a broker outage must not cost events");
  assert.equal(record.cursor, 0);
});

test("rate limiting and a terminal session are distinct typed codes", async () => {
  const limited = await flushOutbox(deps(fakeApi(() => httpError(429)), sandbox()), seeded(1));
  assert.equal(limited.ok, false);
  if (!limited.ok) assert.equal(limited.code, "RC_RATE_LIMITED");

  const closed = await flushOutbox(
    deps(fakeApi(() => httpError(409, "session not appendable")), sandbox()),
    seeded(1),
  );
  assert.equal(closed.ok, false);
  if (!closed.ok) assert.equal(closed.code, "RC_SESSION_TERMINAL");
});

test("an id reused with different bytes is the event-conflict code, not a retry", async () => {
  const api = fakeApi(() => httpError(409, { error: "event_conflict", host_event_id: "x" }));
  const outcome = await flushOutbox(deps(api, sandbox()), seeded(1));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, "RC_EVENT_ID_CONFLICT");
});

test("retry backoff is exponential, bounded to 60s, and jittered", () => {
  // Fixed rng, so the shape is asserted rather than the randomness.
  const low = (): number => 0;
  const high = (): number => 0.999;
  assert.ok(retryDelayMs(1, low) >= 1_000);
  assert.ok(retryDelayMs(1, high) < 2_000);
  assert.ok(retryDelayMs(4, low) > retryDelayMs(1, high));
  for (const attempt of [10, 20, 50]) {
    assert.ok(retryDelayMs(attempt, high) <= 60_000, `attempt ${attempt} exceeded the 60s cap`);
  }
  // Jitter must actually vary, or a fleet of hosts reconnects in lockstep.
  assert.notEqual(retryDelayMs(3, low), retryDelayMs(3, high));
});

test("a flush with an empty queue is a no-op that makes no request", async () => {
  const api = fakeApi(() => ({ receipts: [] }));
  const outcome = await flushOutbox(deps(api, sandbox()), seeded(0));
  assert.equal(outcome.ok, true);
  assert.equal(api.calls.length, 0);
});

// ── 3. Every ambiguous answer preserves the batch ────────────────────────────

test("a successful flush advances the cursor and persists it", async () => {
  const path = sandbox();
  const record = seeded(2);
  const outcome = await flushOutbox(deps(fakeApi(echoReceipts()), path), record);
  assert.equal(outcome.ok, true);
  assert.equal(record.cursor, 2);
  // Durability is the point: a crash after the receipt must not resend.
  assert.equal(loadOutbox(path, PROJECT_ROOT).cursor, 2);
});

test("a partial receipt list preserves the batch and reports it unproven", async () => {
  const record = seeded(3);
  const api = fakeApi((_p, body) => ({
    receipts: (body as { events: Array<{ host_event_id: string }> }).events
      .slice(0, 2)
      .map((e, i) => ({ host_event_id: e.host_event_id, seq: i + 1 })),
  }));
  const outcome = await flushOutbox(deps(api, sandbox()), record);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.code, "RC_RECEIPTS_UNPROVEN");
    // The operator has to be able to say WHY the cursor did not move, and the
    // reason has to name the batch rather than a bare failure word.
    assert.match(outcome.detail, /acknowledge|batch/i);
  }
  assert.equal(record.events.length, 3);
  assert.equal(record.cursor, 0);
});

// ── 4. Revoke is local-first, server-final ──────────────────────────────────

test("revoke_pending is durable BEFORE the network call, not after", async () => {
  const path = sandbox();
  const record = seeded(1);
  saveOutbox(path, record);
  let pendingAtRequest: boolean | null = null;
  const api = fakeApi(() => {
    // Read the file the way a crash at this instant would leave it.
    pendingAtRequest = JSON.parse(readFileSync(path, "utf8")).revoke_pending;
    return { session_id: SESSION, state: "revoked" };
  });
  await revokeHost(deps(api, path), record);
  assert.equal(pendingAtRequest, true, "a crash mid-revoke must not look like a live host");
});

test("an offline revoke stays off, keeps the tombstone, and refuses auto-resume", async () => {
  const path = sandbox();
  const record = seeded(1);
  saveOutbox(path, record);
  const api = fakeApi(() => new Error("ECONNREFUSED"));

  const outcome = await revokeHost(deps(api, path), record);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, "RC_REVOKE_UNCONFIRMED");

  // The tombstone survives, so the next start refuses to resume silently.
  const reloaded = loadOutbox(path, PROJECT_ROOT);
  assert.equal(reloaded.revoke_pending, true);
  assert.equal(record.events.length, 0, "publication stops immediately, before the network");
});

test("a confirmed revoke clears local state", async () => {
  const path = sandbox();
  const record = seeded(2);
  saveOutbox(path, record);
  const api = fakeApi(() => ({ session_id: SESSION, state: "revoked" }));
  const outcome = await revokeHost(deps(api, path), record);
  assert.equal(outcome.ok, true);
  const reloaded = loadOutbox(path, PROJECT_ROOT);
  assert.equal(reloaded.revoke_pending, false);
  assert.equal(reloaded.events.length, 0);
  assert.equal(reloaded.session_id, "");
});

test("the host schema is pinned so a consumer can branch on it", () => {
  assert.equal(RC_HOST_SCHEMA, "aether.cli.rc/1");
});
