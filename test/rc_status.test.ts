// RC status, exposure and viewers (#226) — authoritative Cloud state, never a
// claim inferred from a local file.
//
// The rule under test: `rc status`, `rc exposure` and `rc viewers` ask the
// Cloud's owner-scoped GET /remote/sessions/{id}/status with a short bound. A
// verified answer is shown as what it is (live, reconnecting, offline, revoked,
// expired, closed, pending); anything else — a timeout, an outage, a Cloud that
// does not have the route yet, a refusal, an answer that does not verify — is
// an explicit UNKNOWN. "active" needs both the local receipted proof and the
// Cloud saying live. No output, human or JSON, carries a credential, a grant
// token, a private path, or an event payload.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { cmdRc, projectRefFor, rcOutboxPath, type RcCommandDeps } from "../src/commands/rc.js";
import { enqueueEvent, loadOutbox, saveOutbox, type OutboxRecord } from "../src/core/rc/outbox.js";
import { producerCoverage } from "../src/core/rc/producers.js";
import { payloadDigest } from "../src/core/rc/receipts.js";
import { RequestTimeoutError } from "../src/core/errors.js";
import type { AppContext } from "../src/core/context.js";
import type { CommandFlags } from "../src/core/command_dispatch.js";
import type { ApiClient } from "../src/core/transport.js";

const SESSION = "rs_" + "5".repeat(32);
const GRANT = "rsgt_" + "6".repeat(48);
const DEVICE = "dev-status";
const CANARY = "canary-payload-title-7f3";
const STATUS_PATH = `/remote/sessions/${SESSION}/status`;

type Answer = unknown;

function httpError(status: number, detail?: unknown): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, body: detail === undefined ? undefined : { detail } });
}

function offline(): Error {
  return Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
}

function statusBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "aether.remote_session_status.v1",
    session_id: SESSION,
    state: "live",
    expires_at: "2026-10-07T12:00:00Z",
    revoked_at: null,
    last_seq: 2,
    host_last_heartbeat_at: "2026-10-06T11:59:58.123456Z",
    observer_count: 2,
    observer_cap: 8,
    ...over,
  };
}

function healthy(path: string, body: unknown): Answer {
  if (path === "/remote/sessions") return { session_id: SESSION, state: "pending_host", device_id: DEVICE };
  if (path.endsWith("/host/attach")) return { session_id: SESSION, state: "live" };
  if (path.endsWith("/host/events")) {
    const events = (body as { events: Array<{ host_event_id: string; payload: Record<string, unknown> }> }).events;
    return {
      session_id: SESSION,
      receipts: events.map((event, index) => ({
        host_event_id: event.host_event_id, seq: index + 1, payload_digest: payloadDigest(event.payload),
      })),
    };
  }
  if (path.endsWith("/grants")) {
    return {
      session_id: SESSION, purpose: "observe", device_id: (body as { device_id: string }).device_id,
      token: GRANT, expires_at: new Date(Date.now() + 300_000).toISOString(),
    };
  }
  if (path.endsWith("/revoke")) return { session_id: SESSION, state: "revoked" };
  if (path === STATUS_PATH) return statusBody();
  return httpError(404, "Not Found");
}

interface Harness {
  dir: string;
  outboxPath: string;
  calls: string[];
  out: string[];
  err: string[];
  route: (path: string, body: unknown) => Answer;
  run(sub: string, extra?: Partial<RcCommandDeps> & { json?: boolean }): Promise<number>;
  cleanup(): void;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "aether-rc-status-"));
  const prior = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = join(dir, "config");
  const root = resolve(dir);
  const h: Harness = {
    dir: root,
    outboxPath: rcOutboxPath(projectRefFor(root)),
    calls: [],
    out: [],
    err: [],
    route: healthy,
    async run(sub, extra = {}) {
      const answer = async (method: string, path: string, body: unknown): Promise<unknown> => {
        h.calls.push(`${method} ${path}`);
        const result = await h.route(path, body);
        if (result instanceof Error) throw result;
        return result;
      };
      const api = {
        postJson: (path: string, body: unknown) => answer("POST", path, body),
        getJson: (path: string) => answer("GET", path, undefined),
      } as unknown as ApiClient;
      const json = extra.json ?? false;
      const ctx = { api, flags: { cwd: root, json } } as unknown as AppContext;
      const flags = { str: () => undefined } as unknown as CommandFlags;
      return cmdRc(ctx, [sub], flags, {
        cwd: root,
        enrollment: () => ({ device_id: DEVICE, display_name: "laptop" }),
        repo: () => ({ repo: "fixture", branch: "main", base_commit: "0".repeat(40), dirty_file_count: 0 }),
        connector: () => null,
        browser: () => null,
        out: (text: string) => void h.out.push(text),
        err: (text: string) => void h.err.push(text),
        isTTY: false,
        columns: undefined,
        json,
        ...extra,
      });
    },
    cleanup() {
      if (prior === undefined) delete process.env["AETHER_CONFIG_DIR"];
      else process.env["AETHER_CONFIG_DIR"] = prior;
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

/** A started, confirmed session with one queued event and nonzero counters. */
async function started(h: Harness, mutate: (record: OutboxRecord) => void = () => {}): Promise<void> {
  assert.equal(await h.run("start"), 0);
  const record = loadOutbox(h.outboxPath, h.dir);
  assert.ok(enqueueEvent(record, "plan", { projection_version: "1", title: CANARY, status: "running" }));
  record.dropped = 3;
  record.quarantined = 1;
  mutate(record);
  saveOutbox(h.outboxPath, record);
  h.calls.length = 0;
  h.out.length = 0;
  h.err.length = 0;
}

const stdout = (h: Harness): string => h.out.join("");

// ── the Cloud is asked, and its answer shown ─────────────────────────────────

test("status asks the Cloud and shows real expiry, receipts, counters, observers and exposure", async () => {
  const h = harness();
  try {
    await started(h);
    assert.equal(await h.run("status"), 0);
    assert.deepEqual(h.calls, [`GET ${STATUS_PATH}`], "one owner-scoped status read, nothing else");
    const text = stdout(h);
    assert.match(text, /Host state\s+active/);
    assert.match(text, /Cloud\s+live/);
    assert.match(text, /expires\s+2026-10-07T12:00:00Z/);
    assert.match(text, /last heartbeat\s+2026-10-06T11:59:58\.123456Z/);
    assert.match(text, /observers\s+2 \/ 8/);
    assert.match(text, /Last receipt\s+seq 2 \(Cloud last seq 2\)/);
    assert.match(text, /Outbox\s+1 queued \/ 3 dropped \/ 1 quarantined/);
    const produced = producerCoverage().produced;
    assert.match(text, new RegExp(`Exposed now\\s+${produced.join(", ")}`));
    assert.doesNotMatch(text, /not checked|unknown/);
  } finally {
    h.cleanup();
  }
});

test("every Cloud state is distinguished, and only live plus a local receipt is active", async () => {
  const cases: Array<[string, RegExp]> = [
    ["host_reconnecting", /Host state\s+reconnecting/],
    ["host_offline", /Host state\s+offline/],
    ["revoked", /Host state\s+revoked/],
    ["expired", /Host state\s+expired/],
    ["closed", /Host state\s+closed/],
    ["pending_host", /Host state\s+pending/],
  ];
  for (const [state, expected] of cases) {
    const h = harness();
    try {
      await started(h);
      h.route = (path, body) => (path === STATUS_PATH
        ? statusBody({ state, revoked_at: state === "revoked" ? "2026-10-06T12:01:00Z" : null })
        : healthy(path, body));
      assert.equal(await h.run("status"), 0);
      assert.match(stdout(h), expected, state);
      assert.doesNotMatch(stdout(h), /Host state\s+active/, `${state} must never read as active`);
      const terminal = state === "revoked" || state === "expired" || state === "closed";
      assert.equal(/Exposed now\s+nothing/.test(stdout(h)), terminal, `${state}: exposure ends only with the session`);
    } finally {
      h.cleanup();
    }
  }
});

test("a Cloud that says live is not enough without the local receipted proof", async () => {
  const h = harness();
  try {
    await started(h, (record) => {
      record.start_phase = "attached";
      record.cursor = 0;
    });
    assert.equal(await h.run("status"), 0);
    assert.match(stdout(h), /Host state\s+pending/);
    assert.doesNotMatch(stdout(h), /Host state\s+active/);
  } finally {
    h.cleanup();
  }
});

// ── unknown is explicit, never active ───────────────────────────────────────

const UNKNOWN_CASES: Array<[string, (path: string, body: unknown) => Answer, RegExp]> = [
  ["an unreachable broker", () => offline(), /unknown \(broker unreachable\)/],
  ["a transport timeout", () => new RequestTimeoutError(3_000), /unknown \(timed out\)/],
  ["a Cloud without the status route", () => httpError(404, "Not Found"), /unknown \(this Cloud does not report session status\)/],
  ["remote sessions disabled", () => httpError(403, "remote sessions disabled"), /unknown \(remote sessions are disabled on this Cloud\)/],
  ["a rate limit", () => httpError(429), /unknown \(rate limited\)/],
  ["a wrong schema", () => statusBody({ schema_version: "aether.remote_session_status.v9" }), /unknown \(the Cloud's answer could not be verified\)/],
  ["another session's answer", () => statusBody({ session_id: "rs_" + "7".repeat(32) }), /could not be verified/],
  ["an unknown state", () => statusBody({ state: "superlive" }), /could not be verified/],
  ["a malformed expiry", () => statusBody({ expires_at: "tomorrow; rm -rf /" }), /could not be verified/],
  ["a negative count", () => statusBody({ observer_count: -1 }), /could not be verified/],
];

for (const [name, answer, expected] of UNKNOWN_CASES) {
  test(`${name} is an explicit unknown, never active`, async () => {
    const h = harness();
    try {
      await started(h);
      h.route = (path, body) => (path === STATUS_PATH ? answer(path, body) : healthy(path, body));
      assert.equal(await h.run("status"), 0, "status still reports what it knows");
      const text = stdout(h);
      assert.match(text, /Host state\s+unknown/);
      assert.match(text, expected);
      assert.doesNotMatch(text, /Host state\s+active/);
      assert.match(text, /observers\s+unknown/);
      assert.match(text, /expires\s+unknown/);
      assert.doesNotMatch(text, /superlive|rm -rf/, "an unverified broker string is never printed");
    } finally {
      h.cleanup();
    }
  });
}

test("a Cloud that never answers is cut off by the short status bound", async () => {
  const h = harness();
  try {
    await started(h);
    h.route = (path, body) => (path === STATUS_PATH ? new Promise(() => {}) : healthy(path, body));
    const began = Date.now();
    assert.equal(await h.run("status", { statusTimeoutMs: 50 }), 0);
    assert.ok(Date.now() - began < 2_000, "status must not hang on the broker");
    assert.match(stdout(h), /Host state\s+unknown \(Cloud status unavailable: timed out/);
  } finally {
    h.cleanup();
  }
});

test("a session the Cloud does not have for this account is named, not called active", async () => {
  const h = harness();
  try {
    await started(h);
    h.route = (path, body) => (path === STATUS_PATH ? httpError(404, "session not found") : healthy(path, body));
    assert.equal(await h.run("status"), 0);
    assert.match(stdout(h), /Host state\s+not-found/);
    assert.match(stdout(h), /aether rc off/);
    assert.match(stdout(h), /Exposed now\s+nothing/);
  } finally {
    h.cleanup();
  }
});

// ── local-only states never ask, and never claim ────────────────────────────

test("a pending revoke is reported as such without a status read", async () => {
  const h = harness();
  try {
    await started(h);
    h.route = (path, body) => (path.endsWith("/revoke") ? offline() : healthy(path, body));
    assert.equal(await h.run("off"), 1);
    h.calls.length = 0;
    h.out.length = 0;
    assert.equal(await h.run("status"), 0);
    assert.ok(!h.calls.includes(`GET ${STATUS_PATH}`));
    assert.match(stdout(h), /Host state\s+pending-revoke/);
    assert.match(stdout(h), /Exposed now\s+nothing/);
  } finally {
    h.cleanup();
  }
});

test("with nothing running there is nothing to ask and nothing exposed", async () => {
  const h = harness();
  try {
    assert.equal(await h.run("status"), 0);
    assert.deepEqual(h.calls, []);
    assert.match(stdout(h), /Host state\s+off/);
    assert.match(stdout(h), /Exposed now\s+nothing/);
  } finally {
    h.cleanup();
  }
});

// ── viewers and exposure ────────────────────────────────────────────────────

test("viewers shows the observer count against the cap from the Cloud", async () => {
  const h = harness();
  try {
    await started(h);
    h.route = (path, body) => (path === STATUS_PATH ? statusBody({ observer_count: 3, observer_cap: 8 }) : healthy(path, body));
    assert.equal(await h.run("viewers"), 0);
    assert.match(stdout(h), /observers\s+3 \/ 8/);
    assert.match(stdout(h), /No terminal or tool control/);
  } finally {
    h.cleanup();
  }
});

test("viewers that cannot ask the Cloud say unknown and exit non-zero, never zero observers", async () => {
  const h = harness();
  try {
    await started(h);
    h.route = (path, body) => (path === STATUS_PATH ? offline() : healthy(path, body));
    assert.equal(await h.run("viewers"), 1);
    assert.match(stdout(h), /observers\s+unknown \(broker unreachable\)/);
    assert.doesNotMatch(stdout(h), /observers\s+0/);
  } finally {
    h.cleanup();
  }
});

test("exposure lists what is exposed now and the authoritative observer count", async () => {
  const h = harness();
  try {
    await started(h);
    assert.equal(await h.run("exposure"), 0);
    assert.deepEqual(h.calls, [`GET ${STATUS_PATH}`]);
    assert.match(stdout(h), /Host state\s+active/);
    assert.match(stdout(h), /Exposed now\s+session/);
    assert.match(stdout(h), /observers\s+2 \/ 8/);
  } finally {
    h.cleanup();
  }
});

// ── what the output may never carry ─────────────────────────────────────────

test("JSON status carries Cloud state and counters but no credential, grant, path or payload", async () => {
  const h = harness();
  try {
    await started(h);
    for (const sub of ["status", "exposure", "viewers"]) {
      h.out.length = 0;
      assert.equal(await h.run(sub, { json: true }), 0, sub);
      const text = stdout(h);
      const data = JSON.parse(text) as Record<string, unknown>;
      assert.equal(data["host_state"], "active", sub);
      assert.equal(data["outbox_pending"], 1);
      assert.equal(data["outbox_dropped"], 3);
      assert.equal(data["outbox_quarantined"], 1);
      assert.equal(data["acked_seq"], 2);
      assert.deepEqual(data["cloud"], {
        checked: true,
        status: "known",
        state: "live",
        expires_at: "2026-10-07T12:00:00Z",
        revoked_at: null,
        last_seq: 2,
        host_last_heartbeat_at: "2026-10-06T11:59:58.123456Z",
        observer_count: 2,
        observer_cap: 8,
      });
      assert.deepEqual(data["exposed_categories"], producerCoverage().produced);
      assert.equal(data["exposure_confirmed"], true);
      assert.equal(data["observer"], null, "a status read never replays an invitation");
      for (const forbidden of [GRANT, "rsgt_", CANARY, h.dir, h.dir.replace(/\\/g, "\\\\"), "token", "secret"]) {
        assert.ok(!text.includes(forbidden), `${sub} JSON carried ${forbidden}`);
      }
    }
    h.out.length = 0;
    assert.equal(await h.run("status"), 0);
    for (const forbidden of [GRANT, "rsgt_", CANARY, h.dir]) {
      assert.ok(!stdout(h).includes(forbidden), `human status carried ${forbidden}`);
    }
  } finally {
    h.cleanup();
  }
});

test("JSON status during an outage says unknown with a reason, never active", async () => {
  const h = harness();
  try {
    await started(h);
    h.route = (path, body) => (path === STATUS_PATH ? offline() : healthy(path, body));
    assert.equal(await h.run("status", { json: true }), 0);
    const data = JSON.parse(stdout(h)) as {
      host_state: string; cloud: Record<string, unknown>; exposed_categories: string[]; exposure_confirmed: boolean;
    };
    assert.equal(data.host_state, "unknown");
    assert.deepEqual(data.cloud, { checked: true, status: "unknown", reason: "unreachable" });
    // Still publishing locally, so the categories are listed — but as what WOULD
    // reach a viewer, not as something the Cloud confirmed is being shown.
    assert.deepEqual(data.exposed_categories, producerCoverage().produced);
    assert.equal(data.exposure_confirmed, false);
    h.out.length = 0;
    assert.equal(await h.run("status"), 0);
    assert.match(stdout(h), /Exposed now\s+.*\(once delivered; not confirmed by the Cloud\)/);
  } finally {
    h.cleanup();
  }
});

test("a pending session's exposure is never stated as confirmed", async () => {
  const h = harness();
  try {
    await started(h, (record) => {
      record.start_phase = "attached";
      record.cursor = 0;
    });
    assert.equal(await h.run("exposure", { json: true }), 0);
    const data = JSON.parse(stdout(h)) as { host_state: string; exposure_confirmed: boolean };
    assert.equal(data.host_state, "pending");
    assert.equal(data.exposure_confirmed, false);
    h.out.length = 0;
    assert.equal(await h.run("exposure"), 0);
    assert.match(stdout(h), /Exposed now\s+.*not confirmed by the Cloud/);
  } finally {
    h.cleanup();
  }
});
