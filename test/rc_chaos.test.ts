// RC-02 integration proofs — tenancy, fencing, hostile input, and outage.
//
// The other RC suites are unit-level against a stateless stub. This one stands
// up an in-process broker that MODELS the Cloud's actual rules — ownership,
// device binding, event-id/digest conflict, reachability — so the host can be
// driven through the failure modes that only appear when the far side
// remembers things.
//
// Five groups, one per remaining exit proof:
//
//   1. Cross-tenant isolation   — exit proof 8
//   2. Epoch / session fencing  — exit proof 8
//   3. Hostile control corpus   — exit proof 7
//   4. Prolonged broker outage  — exit proof 10
//   5. Receipt faults           — exit proof 11
//
// Nothing here opens a socket: the broker is an object.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApiClient } from "../src/core/transport.js";
import { flushOutbox, retryDelayMs, revokeHost, type RcHostDeps } from "../src/core/rc/host.js";
import {
  createOutbox,
  enqueueEvent,
  loadOutbox,
  saveOutbox,
  type OutboxRecord,
} from "../src/core/rc/outbox.js";
import { sanitizeRemotePayload } from "../src/core/rc/redaction.js";
import {
  FORBIDDEN_VIEWER_TERMS,
  VIEWER_CAPABILITIES,
  VIEWER_EVENT_TYPES,
  ViewerProfileViolation,
  assertViewerManifest,
  isViewerEventType,
} from "../src/core/rc/viewer_profile.js";

const PROJECT_ROOT = "/repo";
const SESSION_A = "rs_" + "a".repeat(32);
const SESSION_B = "rs_" + "b".repeat(32);

function sandbox(): string {
  return join(mkdtempSync(join(tmpdir(), "aether-rc-chaos-")), "outbox.json");
}

function httpError(status: number, detail?: unknown): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, detail });
}

// ── the in-process broker ───────────────────────────────────────────────────

interface BrokerSession {
  owner: string;
  device: string;
  state: "active" | "revoked";
  seq: number;
  /** host_event_id -> payload digest, so a reused id with new bytes conflicts. */
  seen: Map<string, string>;
}

/**
 * A broker that remembers. Models the four Cloud rules that matter here:
 *
 *  - a session is owned, and a caller who is not the owner gets the SAME 404
 *    as for a session that does not exist, so nothing leaks whether it exists;
 *  - only the registered device may append;
 *  - a repeated host_event_id with different bytes is a typed 409;
 *  - a revoked session accepts nothing.
 */
class FakeBroker {
  readonly sessions = new Map<string, BrokerSession>();
  outage = false;
  requests = 0;

  create(id: string, owner: string, device: string): void {
    this.sessions.set(id, { owner, device, state: "active", seq: 0, seen: new Map() });
  }

  revoke(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.state = "revoked";
  }

  /** An ApiClient bound to one acting account. */
  as(actor: string): ApiClient {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const broker = this;
    return {
      async postJson(path: string, body: unknown) {
        broker.requests += 1;
        if (broker.outage) throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
        return broker.route(actor, path, body);
      },
      async getJson() {
        broker.requests += 1;
        if (broker.outage) throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
        return [];
      },
    } as unknown as ApiClient;
  }

  private route(actor: string, path: string, body: unknown): unknown {
    const match = /^\/remote\/sessions\/([^/]+)(\/.*)?$/.exec(path);
    if (!match) throw httpError(404);
    const id = decodeURIComponent(match[1]!);
    const session = this.sessions.get(id);

    // The load-bearing line for exit proof 8: unknown and not-yours are the
    // same answer. Anything else is an existence oracle.
    if (!session || session.owner !== actor) throw httpError(404, "session not found");

    const suffix = match[2] ?? "";
    if (suffix === "/revoke") {
      session.state = "revoked";
      return { session_id: id, state: "revoked" };
    }
    if (session.state !== "active") throw httpError(409, "session not appendable");

    const payload = body as { device_id?: string; events?: Array<Record<string, unknown>> };
    if (payload.device_id !== session.device) throw httpError(404, "session not found");
    if (suffix === "/host/heartbeat") return { session_id: id, state: session.state };
    if (suffix !== "/host/events") throw httpError(404);

    const receipts: Array<Record<string, unknown>> = [];
    for (const event of payload.events ?? []) {
      const eventId = String(event["host_event_id"]);
      const digest = JSON.stringify(event["payload"]);
      const previous = session.seen.get(eventId);
      if (previous !== undefined && previous !== digest) {
        throw httpError(409, { error: "event_conflict", host_event_id: eventId });
      }
      if (previous !== undefined) {
        receipts.push({ host_event_id: eventId, seq: session.seq, duplicate: true });
        continue;
      }
      session.seq += 1;
      session.seen.set(eventId, digest);
      receipts.push({ host_event_id: eventId, seq: session.seq });
    }
    return { session_id: id, receipts };
  }
}

function record(sessionId: string, device: string, events = 2): OutboxRecord {
  const out = createOutbox({
    session_id: sessionId,
    project_ref: "p",
    device_id: device,
    epoch: 1,
    project_root: PROJECT_ROOT,
  });
  for (let i = 0; i < events; i++) {
    enqueueEvent(out, "plan", { step: i, total_steps: events, title: `s${i}`, status: "running" });
  }
  return out;
}

function deps(api: ApiClient, path: string): RcHostDeps {
  return { api, outboxPath: path, projectRoot: PROJECT_ROOT };
}

// ── 1. Cross-tenant isolation ───────────────────────────────────────────────

test("account B cannot append into account A's session", async () => {
  const broker = new FakeBroker();
  broker.create(SESSION_A, "user-a", "dev-a");

  const outcome = await flushOutbox(
    deps(broker.as("user-b"), sandbox()),
    record(SESSION_A, "dev-a"),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, "RC_SESSION_NOT_FOUND");
  assert.equal(broker.sessions.get(SESSION_A)!.seq, 0, "a foreign append must store nothing");
});

test("a foreign session is indistinguishable from one that does not exist", async () => {
  // An error that says "forbidden" for a real object and "not found" for an
  // absent one is an existence oracle: it lets somebody enumerate other
  // people's sessions one guess at a time.
  const broker = new FakeBroker();
  broker.create(SESSION_A, "user-a", "dev-a");
  const api = broker.as("user-b");

  const foreign = await flushOutbox(deps(api, sandbox()), record(SESSION_A, "dev-a"));
  const absent = await flushOutbox(deps(api, sandbox()), record(SESSION_B, "dev-a"));
  assert.equal(foreign.ok, false);
  assert.equal(absent.ok, false);
  if (!foreign.ok && !absent.ok) {
    assert.equal(foreign.code, absent.code);
    assert.equal(foreign.detail, absent.detail);
  }
});

test("the right account with the wrong device is refused", async () => {
  const broker = new FakeBroker();
  broker.create(SESSION_A, "user-a", "dev-a");
  const outcome = await flushOutbox(
    deps(broker.as("user-a"), sandbox()),
    record(SESSION_A, "dev-b"),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, "RC_SESSION_NOT_FOUND");
  assert.equal(broker.sessions.get(SESSION_A)!.seq, 0);
});

// ── 2. Epoch / session fencing ──────────────────────────────────────────────

test("a stale host cannot append into the session that replaced it", async () => {
  const broker = new FakeBroker();
  broker.create(SESSION_A, "user-a", "dev-a");
  const stale = record(SESSION_A, "dev-a");

  broker.revoke(SESSION_A);
  broker.create(SESSION_B, "user-a", "dev-a"); // the replacement

  const outcome = await flushOutbox(deps(broker.as("user-a"), sandbox()), stale);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, "RC_SESSION_TERMINAL");
  assert.equal(broker.sessions.get(SESSION_B)!.seq, 0, "nothing leaked into the new session");
});

test("a receipt from a restarted sequence cannot advance the cursor", async () => {
  // A replacement session numbers from 1 again. A host that accepted those
  // numbers against a cursor it had already advanced would drop events the new
  // broker never stored.
  const broker = new FakeBroker();
  broker.create(SESSION_A, "user-a", "dev-a");
  const path = sandbox();
  const out = record(SESSION_A, "dev-a", 3);
  await flushOutbox(deps(broker.as("user-a"), path), out);
  assert.equal(out.cursor, 3);

  broker.create(SESSION_B, "user-a", "dev-a");
  out.session_id = SESSION_B;
  enqueueEvent(out, "plan", { title: "after", status: "running" });
  const outcome = await flushOutbox(deps(broker.as("user-a"), path), out);

  assert.equal(outcome.ok, false, "a restarted sequence must not be accepted as progress");
  if (!outcome.ok) assert.equal(outcome.code, "RC_RECEIPTS_UNPROVEN");
  assert.equal(out.cursor, 3, "the cursor moved neither forward nor back");
  assert.equal(out.events.length, 1, "the unproven event is preserved, not dropped");
});

test("a restart cannot resurrect a revoked host", async () => {
  const broker = new FakeBroker();
  broker.create(SESSION_A, "user-a", "dev-a");
  const path = sandbox();
  const live = record(SESSION_A, "dev-a");
  saveOutbox(path, live);

  broker.outage = true; // the Cloud cannot confirm
  const outcome = await revokeHost(deps(broker.as("user-a"), path), live);
  assert.equal(outcome.ok, false);

  // What a fresh process would load.
  const reloaded = loadOutbox(path, PROJECT_ROOT);
  assert.equal(reloaded.revoke_pending, true, "the tombstone survives the restart");
  assert.equal(reloaded.events.length, 0, "nothing queued survives an off");
});

// ── 3. Hostile control corpus ───────────────────────────────────────────────

/**
 * Every shape somebody might use to turn observation into control.
 *
 * Casing, spacing, separators and Unicode look-alikes are included because the
 * Cloud's own tokenizer bug was exactly this: `emergency_stop` read as one
 * opaque word matched nothing.
 */
const HOSTILE_CORPUS: readonly string[] = [
  "run rm -rf /",
  "terminal",
  "open a shell",
  "exec",
  "/bin/sh -c whoami",
  "tool_call",
  "invoke tool",
  "pause",
  "resume",
  "emergency_stop",
  "emergencyStop",
  "EMERGENCY-STOP",
  "Emergency Stop",
  "checkpoint",
  "cancel",
  "kill -9 1234",
  "process 4242",
  '{"action":"execute","cmd":"whoami"}',
  '{"type":"command","payload":{"steer":true}}',
  "sendCommand",
  "send_command",
  "SEND_COMMAND",
  "controller",
  "keyboard",
  "stdin",
  "clipboard",
  "submit",
  "approve",
  "еxec", // Cyrillic small letter ie — a look-alike, not the ASCII word
  "e​xec", // zero-width space
];

test("no hostile string can become a viewer route, tool or manifest entry", () => {
  // Entries carrying control vocabulary must be refused outright. The
  // look-alike and zero-width cases are expected NOT to match the word list —
  // that is the honest result of a word-boundary tokenizer, and precisely why
  // such strings can only ever be inert text, never an identifier.
  let refused = 0;
  for (const entry of HOSTILE_CORPUS) {
    try {
      assertViewerManifest([entry], "hostile");
    } catch (error) {
      assert.ok(error instanceof ViewerProfileViolation);
      refused += 1;
    }
  }
  assert.ok(refused >= 20, `expected the corpus to be largely refused, got ${refused}`);
});

test("replaying the corpus creates no capability and no new event type", () => {
  // The corpus is data. After every entry has been through the sanitizer the
  // viewer surface must be exactly what it was: one capability, thirteen event
  // types, no controller role.
  const before = { caps: [...VIEWER_CAPABILITIES], types: [...VIEWER_EVENT_TYPES] };
  for (const entry of HOSTILE_CORPUS) {
    assert.equal(isViewerEventType(entry), false, `${entry} must not be an event type`);
    for (const type of VIEWER_EVENT_TYPES) {
      sanitizeRemotePayload(
        type,
        { title: entry, summary: entry, status: entry },
        { projectRoot: PROJECT_ROOT },
      );
    }
  }
  assert.deepEqual([...VIEWER_CAPABILITIES], before.caps);
  assert.deepEqual([...VIEWER_EVENT_TYPES], before.types);
  assert.equal(VIEWER_CAPABILITIES.length, 1);
  assert.equal(VIEWER_CAPABILITIES[0], "observe");
});

test("hostile text that survives is inert, in an allowlisted field, and bounded", () => {
  // The viewer profile permits redacted text in `summary`. That text staying
  // readable is fine; what must never happen is it arriving under a key that
  // MEANS something, or unbounded.
  const out = createOutbox({
    session_id: SESSION_A,
    project_ref: "p",
    device_id: "dev-a",
    epoch: 1,
    project_root: PROJECT_ROOT,
  });
  for (const entry of HOSTILE_CORPUS) {
    enqueueEvent(out, "tool_activity", {
      tool: "t",
      status: "started",
      summary: entry,
      // Every one of these is a key a control channel would need.
      command: entry,
      exec: entry,
      stdin: entry,
      cmd: entry,
      action: entry,
      pid: 4242,
    });
  }
  assert.ok(out.events.length > 0, "nothing was queued — this guard would be vacuous");
  for (const event of out.events) {
    const keys = Object.keys(event.payload);
    for (const forbidden of ["command", "exec", "stdin", "cmd", "action", "pid"]) {
      assert.ok(!keys.includes(forbidden), `${forbidden} survived into a viewer payload`);
    }
    const summary = event.payload["summary"];
    if (typeof summary === "string") assert.ok(summary.length <= 1024);
  }
});

test("a control-shaped event type is refused before it can be queued", () => {
  const out = createOutbox({
    session_id: SESSION_A,
    project_ref: "p",
    device_id: "dev-a",
    epoch: 1,
    project_root: PROJECT_ROOT,
  });
  for (const type of ["command", "exec", "control", "transcript", "emergency_stop"]) {
    assert.equal(enqueueEvent(out, type, { status: "x" }), false, `${type} was queued`);
  }
  assert.equal(out.events.length, 0);
});

test("the forbidden-term list still covers the deferred controller registry", () => {
  // If somebody prunes this set, the corpus tests above quietly weaken.
  for (const term of ["pause", "resume", "checkpoint", "emergency", "stop", "control", "shell"]) {
    assert.ok(FORBIDDEN_VIEWER_TERMS.has(term), `${term} fell out of the forbidden set`);
  }
});

// ── 4. Prolonged broker outage ──────────────────────────────────────────────

test("ninety seconds of outage costs no events and no busy loop", async () => {
  // The outage is driven on a VIRTUAL clock rather than by sleeping ninety real
  // seconds. Wall-clock waiting would prove less, not more: what has to be
  // shown is that the host makes a bounded number of attempts on the 1-60s
  // backoff schedule rather than spinning, and a simulated clock measures that
  // exactly while a real one measures the CI machine's load.
  const broker = new FakeBroker();
  broker.create(SESSION_A, "user-a", "dev-a");
  const path = sandbox();
  const out = record(SESSION_A, "dev-a", 5);
  saveOutbox(path, out);

  broker.outage = true;
  const OUTAGE_MS = 90_000;
  let elapsed = 0;
  let attempts = 0;
  while (elapsed < OUTAGE_MS) {
    attempts += 1;
    const outcome = await flushOutbox(deps(broker.as("user-a"), path), out);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.code, "RC_BROKER_UNREACHABLE");
    elapsed += retryDelayMs(attempts, () => 0.5);
  }

  // Backoff doubles from 1s, so ninety seconds is single digits of attempts.
  // Anything near a hundred would be a hot loop against a dead broker.
  assert.ok(attempts <= 12, `${attempts} attempts in 90s is a busy retry loop`);
  assert.equal(out.events.length, 5, "an outage must not cost events");
  assert.equal(out.cursor, 0, "no cursor movement without a receipt");
  assert.equal(loadOutbox(path, PROJECT_ROOT).cursor, 0);

  // Recovery: the same preserved batch goes out, and the broker stores it.
  broker.outage = false;
  const recovered = await flushOutbox(deps(broker.as("user-a"), path), out);
  assert.equal(recovered.ok, true);
  assert.equal(out.cursor, 5);
  assert.equal(broker.sessions.get(SESSION_A)!.seq, 5);
});

test("a duplicate id after recovery is deduped, not stored twice", async () => {
  const broker = new FakeBroker();
  broker.create(SESSION_A, "user-a", "dev-a");
  const path = sandbox();
  const out = record(SESSION_A, "dev-a", 3);
  const ids = out.events.map((event) => event.host_event_id);

  await flushOutbox(deps(broker.as("user-a"), path), out);
  assert.equal(broker.sessions.get(SESSION_A)!.seq, 3);

  // A host that never saw the receipt resends the identical events.
  const resend = record(SESSION_A, "dev-a", 0);
  resend.events = ids.map((id, i) => ({
    host_event_id: id,
    event_type: "plan" as const,
    payload: { step: i, total_steps: 3, title: `s${i}`, status: "running" },
    host_seq: i + 1,
    created_at: "2026-09-07T00:00:00.000Z",
    payload_digest: "sha256:" + "0".repeat(64),
  }));
  await flushOutbox(deps(broker.as("user-a"), path), resend);
  assert.equal(broker.sessions.get(SESSION_A)!.seen.size, 3, "a resent id must not create a new event");
});

test("shutdown is possible while the broker is unreachable", async () => {
  const broker = new FakeBroker();
  broker.create(SESSION_A, "user-a", "dev-a");
  const path = sandbox();
  const out = record(SESSION_A, "dev-a", 4);
  saveOutbox(path, out);

  broker.outage = true;
  const outcome = await revokeHost(deps(broker.as("user-a"), path), out);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, "RC_REVOKE_UNCONFIRMED");
  // Off locally is the point: publication stopped even though the Cloud could
  // not be told.
  assert.equal(out.events.length, 0);
  assert.equal(loadOutbox(path, PROJECT_ROOT).revoke_pending, true);
});

// ── 5. Receipt faults ───────────────────────────────────────────────────────

test("an id reused with different bytes is a typed conflict, not a silent replace", async () => {
  const broker = new FakeBroker();
  broker.create(SESSION_A, "user-a", "dev-a");
  const path = sandbox();
  const out = record(SESSION_A, "dev-a", 1);
  await flushOutbox(deps(broker.as("user-a"), path), out);

  const reusedId = [...broker.sessions.get(SESSION_A)!.seen.keys()][0]!;
  const conflicting = record(SESSION_A, "dev-a", 0);
  conflicting.events = [
    {
      host_event_id: reusedId,
      event_type: "plan",
      payload: { title: "different bytes", status: "running" },
      host_seq: 99,
      created_at: "2026-09-07T00:00:00.000Z",
      payload_digest: "sha256:" + "1".repeat(64),
    },
  ];
  const outcome = await flushOutbox(deps(broker.as("user-a"), path), conflicting);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, "RC_EVENT_ID_CONFLICT");
});

test("every receipt fault preserves the batch", async () => {
  // One table, so a new fault shape is one row rather than a test somebody
  // forgets to write. Each answer is wrong in a different way, and every one
  // must leave the queue exactly as it was.
  const faults: Array<[string, (ids: string[]) => unknown]> = [
    ["malformed body", () => ({})],
    ["receipts not an array", () => ({ receipts: "nope" })],
    ["partial list", (ids) => ({ receipts: [{ host_event_id: ids[0], seq: 1 }] })],
    [
      "duplicate receipt",
      (ids) => ({
        receipts: [
          { host_event_id: ids[0], seq: 1 },
          { host_event_id: ids[0], seq: 2 },
        ],
      }),
    ],
    [
      "wrong event id",
      (ids) => ({
        receipts: [
          { host_event_id: ids[0], seq: 1 },
          { host_event_id: "not-ours", seq: 2 },
        ],
      }),
    ],
    [
      "reversed sequences",
      (ids) => ({
        receipts: [
          { host_event_id: ids[0], seq: 2 },
          { host_event_id: ids[1], seq: 1 },
        ],
      }),
    ],
    [
      "stale sequence at the cursor",
      (ids) => ({
        receipts: [
          { host_event_id: ids[0], seq: 0 },
          { host_event_id: ids[1], seq: 1 },
        ],
      }),
    ],
    [
      "explicit rejection",
      (ids) => ({
        receipts: [
          { host_event_id: ids[0], seq: 1 },
          { host_event_id: ids[1], rejected: true },
        ],
      }),
    ],
    [
      "digest for different bytes",
      (ids) => ({
        receipts: [
          { host_event_id: ids[0], seq: 1, payload_digest: "sha256:" + "9".repeat(64) },
          { host_event_id: ids[1], seq: 2 },
        ],
      }),
    ],
  ];

  for (const [name, answer] of faults) {
    const out = record(SESSION_A, "dev-a", 2);
    const ids = out.events.map((event) => event.host_event_id);
    const api = {
      async postJson() {
        return answer(ids);
      },
      async getJson() {
        return [];
      },
    } as unknown as ApiClient;

    const outcome = await flushOutbox(deps(api, sandbox()), out);
    assert.equal(outcome.ok, false, `${name} was accepted as proof`);
    assert.equal(out.cursor, 0, `${name} moved the cursor`);
    assert.equal(out.events.length, 2, `${name} dropped events`);
  }
});

test("an omitted optional digest does not stall a host, per the real Cloud contract", async () => {
  // The Cloud append route returns {host_event_id, seq, duplicate} with no
  // digest. Treating its absence as a fault would stall every real host.
  const broker = new FakeBroker();
  broker.create(SESSION_A, "user-a", "dev-a");
  const out = record(SESSION_A, "dev-a", 2);
  const outcome = await flushOutbox(deps(broker.as("user-a"), sandbox()), out);
  assert.equal(outcome.ok, true);
  assert.equal(out.cursor, 2);
});
