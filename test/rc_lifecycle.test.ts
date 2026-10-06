// RC start/revoke lifecycle (#227) — every interruption boundary of `rc start`
// and `rc off`, driven through the real command with a recording API stub.
//
// The rule under test is one sentence: RC is reported live only after a valid
// register, a valid attach, durable local state AND a receipted first append.
// Everything short of that is either pending (an outage: the queued opening
// events are durable and delivery resumes later) or rolled back (the Cloud
// session is revoked, and a durable pending-revoke tombstone remains when the
// revoke itself cannot be confirmed). No path may orphan a Cloud session, and
// no path may silently replace the only local record of one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { cmdRc, projectRefFor, rcOutboxPath, type RcCommandDeps } from "../src/commands/rc.js";
import { openRcCodingObserver } from "../src/commands/rc_observation.js";
import { hostLoop } from "../src/commands/code.js";
import { createOutbox, enqueueEvent, loadOutbox, saveOutbox, type OutboxRecord } from "../src/core/rc/outbox.js";
import { payloadDigest } from "../src/core/rc/receipts.js";
import type { AppContext } from "../src/core/context.js";
import type { CommandFlags } from "../src/core/command_dispatch.js";
import type { ApiClient } from "../src/core/transport.js";
import type { Brain, TaskCommand } from "../src/core/brain.js";
import type { ToolExecutor, ToolResult } from "../src/core/tool_executor.js";

const SESSION = "rs_" + "c".repeat(32);
const GRANT = "rsgt_" + "d".repeat(48);
const DEVICE = "dev-life";

type Answer = unknown;
type Route = (path: string, body: unknown) => Answer;

function httpError(status: number, detail?: unknown): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, detail });
}

function offline(): Error {
  return Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
}

function receiptsFor(body: unknown, from = 0): unknown {
  const events = (body as { events: Array<{ host_event_id: string; payload: Record<string, unknown> }> }).events;
  return {
    session_id: SESSION,
    receipts: events.map((event, index) => ({
      host_event_id: event.host_event_id,
      seq: from + index + 1,
      payload_digest: payloadDigest(event.payload),
    })),
  };
}

/** The Cloud's answers when nothing goes wrong. A test overrides one route. */
function healthy(path: string, body: unknown): Answer {
  if (path === "/remote/sessions") return { session_id: SESSION, state: "pending_host", device_id: DEVICE };
  if (path.endsWith("/host/attach")) return { session_id: SESSION, state: "live" };
  if (path.endsWith("/host/events")) return receiptsFor(body);
  if (path.endsWith("/host/heartbeat")) return { session_id: SESSION, state: "live" };
  if (path.endsWith("/grants")) {
    return {
      session_id: SESSION, purpose: "observe", device_id: (body as { device_id: string }).device_id,
      token: GRANT, expires_at: new Date(Date.now() + 300_000).toISOString(),
    };
  }
  if (path.endsWith("/revoke")) return { session_id: SESSION, state: "revoked" };
  return httpError(404, "Not Found");
}

interface Harness {
  dir: string;
  outboxPath: string;
  calls: string[];
  out: string[];
  err: string[];
  route: Route;
  persistCalls: number;
  run(sub: string, extra?: Partial<RcCommandDeps>): Promise<number>;
  saved(): OutboxRecord;
  cleanup(): void;
}

/**
 * One isolated config dir per test. `failPersist` makes the Nth (1-based) local
 * state write throw, or every write when it is "all": the disk failing at
 * exactly one boundary of the start sequence.
 */
function harness(options: { route?: Route; failPersist?: number | "all"; json?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "aether-rc-life-"));
  const prior = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = join(dir, "config");
  const root = resolve(dir);
  const h: Harness = {
    dir: root,
    outboxPath: rcOutboxPath(projectRefFor(root)),
    calls: [],
    out: [],
    err: [],
    route: options.route ?? healthy,
    persistCalls: 0,
    async run(sub, extra = {}) {
      const api = {
        async postJson(path: string, body: unknown) {
          h.calls.push(`POST ${path}`);
          const answer = h.route(path, body);
          if (answer instanceof Error) throw answer;
          return answer;
        },
        async getJson(path: string) {
          h.calls.push(`GET ${path}`);
          const answer = h.route(path, undefined);
          if (answer instanceof Error) throw answer;
          return answer;
        },
      } as unknown as ApiClient;
      const ctx = { api, flags: { cwd: root, json: options.json ?? false } } as unknown as AppContext;
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
        json: options.json ?? false,
        persist: (path: string, record: OutboxRecord) => {
          h.persistCalls += 1;
          if (options.failPersist === "all" || options.failPersist === h.persistCalls) {
            throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
          }
          saveOutbox(path, record);
        },
        ...extra,
      });
    },
    saved() {
      return loadOutbox(h.outboxPath, root);
    },
    cleanup() {
      if (prior === undefined) delete process.env["AETHER_CONFIG_DIR"];
      else process.env["AETHER_CONFIG_DIR"] = prior;
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

function stdout(h: Harness): string {
  return h.out.join("");
}

function stderr(h: Harness): string {
  return h.err.join("");
}

function revokes(h: Harness): string[] {
  return h.calls.filter((call) => call.endsWith("/revoke"));
}

// ── start: live only on proof ───────────────────────────────────────────────

test("start reports active only after register, attach, durable state and a receipted first append", async () => {
  const h = harness();
  try {
    assert.equal(await h.run("start"), 0);
    // Order is the contract: the observer link is minted only after the
    // opening batch was receipted.
    assert.deepEqual(h.calls, [
      "POST /remote/sessions",
      `POST /remote/sessions/${SESSION}/host/attach`,
      `POST /remote/sessions/${SESSION}/host/events`,
      `POST /remote/sessions/${SESSION}/grants`,
    ]);
    const record = h.saved();
    assert.equal(record.session_id, SESSION);
    assert.equal(record.start_phase, "confirmed");
    assert.equal(record.cursor, 2, "both opening events were proven stored");
    assert.equal(record.events.length, 0);
    assert.match(stdout(h), /Host state\s+active/);
  } finally {
    h.cleanup();
  }
});

test("an outage on the first append is pending, not live, and exits non-zero", async () => {
  const h = harness({
    route: (path, body) => (path.endsWith("/host/events") ? offline() : healthy(path, body)),
  });
  try {
    assert.notEqual(await h.run("start"), 0, "an unconfirmed start must not exit 0");
    assert.doesNotMatch(stdout(h), /Host state\s+active/);
    assert.match(stdout(h), /Host state\s+pending/);
    assert.match(stderr(h), /RC_BROKER_UNREACHABLE/);
    assert.equal(revokes(h).length, 0, "an outage is not a reason to revoke");
    assert.ok(!h.calls.some((call) => call.endsWith("/grants")), "no observer link for an unconfirmed session");
    // The opening events are durable, so delivery resumes on the next run.
    const record = h.saved();
    assert.equal(record.session_id, SESSION);
    assert.equal(record.start_phase, "attached");
    assert.equal(record.events.length, 2);
    assert.equal(record.revoke_pending, false);
  } finally {
    h.cleanup();
  }
});

test("a JSON start during an outage reports pending, never active", async () => {
  const h = harness({
    json: true,
    route: (path, body) => (path.endsWith("/host/events") ? httpError(429) : healthy(path, body)),
  });
  try {
    assert.notEqual(await h.run("start"), 0);
    const data = JSON.parse(stdout(h)) as { host_state: string; observer: unknown; session_id: string };
    assert.equal(data.host_state, "pending");
    assert.equal(data.observer, null);
    assert.equal(data.session_id, SESSION);
  } finally {
    h.cleanup();
  }
});

test("a later successful flush confirms a pending start", async () => {
  let down = true;
  const h = harness({
    route: (path, body) => (down && path.endsWith("/host/events") ? offline() : healthy(path, body)),
  });
  try {
    assert.notEqual(await h.run("start"), 0);
    down = false;
    assert.equal(await h.run("link"), 0);
    assert.equal(h.saved().start_phase, "confirmed");
  } finally {
    h.cleanup();
  }
});

// ── start: rollback at each boundary ────────────────────────────────────────

test("an attach failure revokes the registered session and leaves nothing live", async () => {
  const h = harness({
    route: (path, body) => (path.endsWith("/host/attach") ? httpError(409, "host already attached") : healthy(path, body)),
  });
  try {
    assert.equal(await h.run("start"), 1);
    assert.deepEqual(revokes(h), [`POST /remote/sessions/${SESSION}/revoke`]);
    assert.ok(!h.calls.some((call) => call.endsWith("/host/events")));
    assert.match(stderr(h), /RC_HOST_CONFLICT/);
    assert.match(stderr(h), /revoked/i);
    assert.doesNotMatch(stdout(h), /active/);
    const record = h.saved();
    assert.equal(record.session_id, "");
    assert.equal(record.revoke_pending, false);
  } finally {
    h.cleanup();
  }
});

test("an attach failure with the Cloud unreachable leaves a durable pending-revoke tombstone", async () => {
  let down = true;
  const h = harness({
    route: (path, body) =>
      down && (path.endsWith("/host/attach") || path.endsWith("/revoke")) ? offline() : healthy(path, body),
  });
  try {
    assert.equal(await h.run("start"), 1);
    assert.match(stderr(h), /RC_REVOKE_UNCONFIRMED/);
    const record = h.saved();
    assert.equal(record.session_id, SESSION, "the tombstone keeps the id it must still revoke");
    assert.equal(record.revoke_pending, true);
    assert.equal(record.events.length, 0);

    // The very next rc command retries the revoke, and only a confirmation
    // clears local state.
    down = false;
    h.calls.length = 0;
    assert.equal(await h.run("status"), 0);
    assert.deepEqual(revokes(h), [`POST /remote/sessions/${SESSION}/revoke`]);
    assert.equal(h.saved().revoke_pending, false);
    assert.equal(h.saved().session_id, "");
  } finally {
    h.cleanup();
  }
});

test("a pending revoke that still cannot be confirmed keeps the tombstone and blocks start", async () => {
  const h = harness({
    route: (path, body) => (path.endsWith("/host/attach") || path.endsWith("/revoke") ? offline() : healthy(path, body)),
  });
  try {
    assert.equal(await h.run("start"), 1);
    h.calls.length = 0;
    assert.equal(await h.run("start"), 1);
    assert.equal(revokes(h).length, 1, "the retry happened");
    assert.ok(!h.calls.includes("POST /remote/sessions"), "no second session while the first is unrevoked");
    assert.equal(h.saved().revoke_pending, true);
  } finally {
    h.cleanup();
  }
});

test("a local write failure right after register rolls the Cloud session back", async () => {
  const h = harness({ failPersist: 1 });
  try {
    assert.equal(await h.run("start"), 1);
    assert.ok(!h.calls.some((call) => call.endsWith("/host/attach")), "nothing proceeds without durable state");
    assert.deepEqual(revokes(h), [`POST /remote/sessions/${SESSION}/revoke`]);
    assert.match(stderr(h), /RC_STATE_UNWRITABLE/);
    assert.doesNotMatch(stdout(h), /active/);
  } finally {
    h.cleanup();
  }
});

test("a local write failure after attach rolls back before any event is sent", async () => {
  const h = harness({ failPersist: 2 });
  try {
    assert.equal(await h.run("start"), 1);
    assert.ok(!h.calls.some((call) => call.endsWith("/host/events")));
    assert.deepEqual(revokes(h), [`POST /remote/sessions/${SESSION}/revoke`]);
    assert.match(stderr(h), /RC_STATE_UNWRITABLE/);
    assert.equal(h.saved().session_id, "");
  } finally {
    h.cleanup();
  }
});

test("a failure to persist the first receipt rolls back instead of claiming live", async () => {
  const h = harness({ failPersist: 3 });
  try {
    assert.equal(await h.run("start"), 1);
    assert.deepEqual(revokes(h), [`POST /remote/sessions/${SESSION}/revoke`]);
    assert.ok(!h.calls.some((call) => call.endsWith("/grants")));
    assert.match(stderr(h), /RC_STATE_UNWRITABLE/);
    assert.doesNotMatch(stdout(h), /active/);
  } finally {
    h.cleanup();
  }
});

test("with no writable state at all the Cloud revoke still runs, and nothing claims success", async () => {
  const h = harness({ failPersist: "all" });
  try {
    assert.equal(await h.run("start"), 1);
    assert.deepEqual(revokes(h), [`POST /remote/sessions/${SESSION}/revoke`]);
    assert.match(stderr(h), /RC_STATE_UNWRITABLE/);
    assert.equal(existsSync(h.outboxPath), false);
  } finally {
    h.cleanup();
  }
});

test("a terminal answer to the first append rolls back rather than wedging the outbox", async () => {
  const h = harness({
    route: (path, body) =>
      path.endsWith("/host/events") ? httpError(400, { error: "event_contract_invalid" }) : healthy(path, body),
  });
  try {
    assert.equal(await h.run("start"), 1);
    assert.deepEqual(revokes(h), [`POST /remote/sessions/${SESSION}/revoke`]);
    assert.match(stderr(h), /RC_EVENT_REJECTED/);
    assert.equal(h.saved().session_id, "");
  } finally {
    h.cleanup();
  }
});

test("a register answer without a session id is refused and nothing is recorded", async () => {
  const h = harness({
    route: (path, body) => (path === "/remote/sessions" ? { state: "pending_host" } : healthy(path, body)),
  });
  try {
    assert.equal(await h.run("start"), 1);
    assert.ok(!h.calls.some((call) => call.endsWith("/host/attach")));
    assert.equal(existsSync(h.outboxPath), false);
  } finally {
    h.cleanup();
  }
});

test("a start interrupted after register is named as such and is revocable", async () => {
  const h = harness();
  try {
    mkdirSync(dirname(h.outboxPath), { recursive: true });
    saveOutbox(h.outboxPath, createOutbox({
      session_id: SESSION, project_ref: projectRefFor(h.dir), device_id: DEVICE,
      epoch: 1, project_root: h.dir, start_phase: "registered",
    }));
    assert.equal(await h.run("start"), 1);
    assert.match(stderr(h), /did not finish/);
    assert.match(stderr(h), /aether rc off/);
    assert.equal(await h.run("off"), 0);
    assert.deepEqual(revokes(h), [`POST /remote/sessions/${SESSION}/revoke`]);
  } finally {
    h.cleanup();
  }
});

// ── unreadable state is a recovery condition ────────────────────────────────

function writeDamaged(h: Harness, text: string): void {
  mkdirSync(dirname(h.outboxPath), { recursive: true });
  writeFileSync(h.outboxPath, text, "utf8");
}

const TRUNCATED = `{\n  "schema": "aether.rc_outbox/1",\n  "session_id": "${SESSION}",\n  "project_ref": "x",\n  "events": [ {`;

test("an unreadable saved state blocks start, names `aether rc off`, and is never overwritten", async () => {
  const h = harness();
  try {
    writeDamaged(h, TRUNCATED);
    assert.equal(await h.run("start"), 1);
    assert.match(stderr(h), /RC_STATE_UNREADABLE/);
    assert.match(stderr(h), /aether rc off/);
    assert.ok(!h.calls.includes("POST /remote/sessions"), "no second session over an unreadable first");
    assert.equal(readFileSync(h.outboxPath, "utf8"), TRUNCATED, "the only record of a session is untouched");
  } finally {
    h.cleanup();
  }
});

test("state from an incompatible version is a recovery condition too", async () => {
  const h = harness();
  try {
    const future = JSON.stringify({ schema: "aether.rc_outbox/9", session_id: SESSION });
    writeDamaged(h, future);
    assert.equal(await h.run("start"), 1);
    assert.match(stderr(h), /RC_STATE_UNREADABLE/);
    assert.equal(readFileSync(h.outboxPath, "utf8"), future);
  } finally {
    h.cleanup();
  }
});

test("rc off revokes the session an unreadable state names, then sets the state aside", async () => {
  const h = harness();
  try {
    writeDamaged(h, TRUNCATED);
    assert.equal(await h.run("off"), 0);
    assert.deepEqual(revokes(h), [`POST /remote/sessions/${SESSION}/revoke`]);
    assert.equal(existsSync(h.outboxPath), false);
    const aside = readdirSync(dirname(h.outboxPath)).filter((name) => name.includes(".unreadable-"));
    assert.equal(aside.length, 1, "the damaged bytes are preserved, not deleted");
    // Resolved: a fresh start is allowed again.
    h.calls.length = 0;
    assert.equal(await h.run("start"), 0);
    assert.ok(h.calls.includes("POST /remote/sessions"));
  } finally {
    h.cleanup();
  }
});

test("rc off on unreadable state with the Cloud down changes nothing", async () => {
  const h = harness({ route: (path, body) => (path.endsWith("/revoke") ? offline() : healthy(path, body)) });
  try {
    writeDamaged(h, TRUNCATED);
    assert.equal(await h.run("off"), 1);
    assert.match(stderr(h), /RC_REVOKE_UNCONFIRMED/);
    assert.equal(readFileSync(h.outboxPath, "utf8"), TRUNCATED);
  } finally {
    h.cleanup();
  }
});

test("state that cannot be READ is an I/O condition: never set aside, never treated as revoked", async () => {
  // Unparseable bytes are proven damage; a read that fails (a lock, an access
  // error) proves nothing about the record, which may name a live session.
  const h = harness();
  try {
    mkdirSync(h.outboxPath, { recursive: true }); // reading it fails with EISDIR
    assert.equal(await h.run("start"), 1);
    assert.match(stderr(h), /RC_STATE_UNREADABLE/);
    assert.match(stderr(h), /could not be read/);
    assert.ok(!h.calls.includes("POST /remote/sessions"), "no second session over a record nobody could read");
    h.err.length = 0;
    assert.equal(await h.run("off"), 1);
    assert.equal(revokes(h).length, 0);
    assert.match(stderr(h), /RC_STATE_UNREADABLE/);
    assert.doesNotMatch(stdout(h), /RC is off/);
    assert.ok(existsSync(h.outboxPath), "the unread record was left exactly where it was");
    const aside = readdirSync(dirname(h.outboxPath)).filter((name) => name.includes(".unreadable-"));
    assert.equal(aside.length, 0);
  } finally {
    h.cleanup();
  }
});

test("rc off on state that names no session sets it aside without claiming a Cloud revoke", async () => {
  const h = harness();
  try {
    writeDamaged(h, "\u0000\u0001 not json at all");
    assert.equal(await h.run("off"), 1);
    assert.equal(revokes(h).length, 0);
    assert.match(stderr(h), /RC_REVOKE_UNCONFIRMED/);
    assert.doesNotMatch(stdout(h), /revoked\./);
    assert.equal(existsSync(h.outboxPath), false);
  } finally {
    h.cleanup();
  }
});

// ── revoke is never claimed before the Cloud confirms it ────────────────────

test("an unconfirmed rc off says so and never prints that the session was revoked", async () => {
  const h = harness();
  try {
    assert.equal(await h.run("start"), 0);
    h.route = (path, body) => (path.endsWith("/revoke") ? offline() : healthy(path, body));
    h.out.length = 0;
    assert.equal(await h.run("off"), 1);
    assert.doesNotMatch(stdout(h), /revoked/);
    assert.match(stderr(h), /RC_REVOKE_UNCONFIRMED/);
    assert.equal(h.saved().revoke_pending, true);
    assert.equal(h.saved().events.length, 0, "publication is off locally");
  } finally {
    h.cleanup();
  }
});

test("only the Cloud's own 'session not found' counts as gone; any other 404 is unconfirmed", async () => {
  const h = harness();
  try {
    assert.equal(await h.run("start"), 0);
    // A proxy or a deployment without the route answers 404 "Not Found": the
    // session may still be live, so nothing may be called revoked.
    h.route = (path, body) => (path.endsWith("/revoke") ? httpError(404, "Not Found") : healthy(path, body));
    h.out.length = 0;
    assert.equal(await h.run("off"), 1);
    assert.match(stderr(h), /RC_REVOKE_UNCONFIRMED/);
    assert.doesNotMatch(stdout(h), /revoked/);
    assert.equal(h.saved().revoke_pending, true, "the tombstone stays until the Cloud confirms");
    assert.equal(h.saved().session_id, SESSION);

    // The Cloud's own answer for a session it no longer has does settle it.
    h.route = (path, body) => (path.endsWith("/revoke") ? httpError(404, "session not found") : healthy(path, body));
    assert.equal(await h.run("off"), 0);
    assert.equal(h.saved().revoke_pending, false);
    assert.equal(h.saved().session_id, "");
  } finally {
    h.cleanup();
  }
});

test("rc off with nothing running leaves no tombstone and never blocks the next start", async () => {
  const h = harness();
  try {
    assert.equal(await h.run("off"), 0);
    assert.equal(revokes(h).length, 0, "there was nothing to revoke");
    assert.equal(h.saved().revoke_pending, false, "a tombstone naming no session would block every later start");
    h.err.length = 0;
    assert.equal(await h.run("start"), 0);
    assert.doesNotMatch(stderr(h), /RC_REVOKE_UNCONFIRMED/);
    assert.equal(h.saved().start_phase, "confirmed");
  } finally {
    h.cleanup();
  }
});

test("a stale tombstone that names no session is cleared without claiming a Cloud revocation", async () => {
  const h = harness();
  try {
    mkdirSync(dirname(h.outboxPath), { recursive: true });
    const stale = createOutbox({ session_id: "", project_ref: "", device_id: "", epoch: 0, project_root: h.dir });
    stale.revoke_pending = true;
    saveOutbox(h.outboxPath, stale);
    assert.equal(await h.run("status"), 0);
    assert.equal(revokes(h).length, 0);
    assert.doesNotMatch(stderr(h), /confirmed revocation/, "nothing was revoked, so nothing may be claimed");
    assert.equal(h.saved().revoke_pending, false);
    assert.equal(await h.run("start"), 0);
  } finally {
    h.cleanup();
  }
});

test("rc off whose local marker cannot be written still revokes in the Cloud and says what is true", async () => {
  const h = harness();
  try {
    assert.equal(await h.run("start"), 0);
    h.calls.length = 0;
    h.out.length = 0;
    const unwritable = (): void => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    assert.equal(await h.run("off", { persist: unwritable }), 1);
    // The Cloud revoke is what keeps publication off when the local marker
    // cannot: a later run's host is refused by a revoked session.
    assert.deepEqual(revokes(h), [`POST /remote/sessions/${SESSION}/revoke`]);
    assert.match(stderr(h), /RC_STATE_UNWRITABLE/);
    assert.match(stderr(h), /Cloud confirmed revocation/);
    assert.doesNotMatch(stderr(h), /will not resume automatically/, "the active record is still on disk");
    assert.doesNotMatch(stdout(h), /RC is off/);
  } finally {
    h.cleanup();
  }
});

test("rc off with neither a writable marker nor a reachable Cloud says RC is not off", async () => {
  const h = harness();
  try {
    assert.equal(await h.run("start"), 0);
    h.route = (path, body) => (path.endsWith("/revoke") ? offline() : healthy(path, body));
    h.out.length = 0;
    const unwritable = (): void => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    assert.equal(await h.run("off", { persist: unwritable }), 1);
    assert.match(stderr(h), /RC_REVOKE_UNCONFIRMED/);
    assert.match(stderr(h), /NOT off/);
    assert.doesNotMatch(stderr(h), /will not resume automatically/);
    assert.doesNotMatch(stdout(h), /revoked/);
    assert.equal(h.saved().revoke_pending, false, "nothing local changed, and nothing claims it did");
  } finally {
    h.cleanup();
  }
});

test("link into a session the Cloud no longer accepts says so, never 'pending' or 'running'", async () => {
  for (const queued of [true, false]) {
    const h = harness();
    try {
      assert.equal(await h.run("start"), 0);
      if (queued) {
        const record = h.saved();
        record.events = [];
        saveOutbox(h.outboxPath, record);
        const fresh = h.saved();
        // One queued event, so link's delivery attempt meets the refusal first.
        assert.ok(enqueueEvent(fresh, "plan", { projection_version: "1", title: "later", status: "running" }));
        saveOutbox(h.outboxPath, fresh);
      }
      h.route = (path, body) =>
        path.endsWith("/host/events") || path.endsWith("/grants")
          ? httpError(409, "session not appendable")
          : healthy(path, body);
      h.err.length = 0;
      assert.equal(await h.run("link"), 1);
      assert.match(stderr(h), /RC_SESSION_TERMINAL/, `queued=${queued}`);
      assert.match(stderr(h), /aether rc off/, `queued=${queued}`);
      assert.doesNotMatch(stderr(h), /still pending|RC is running/, `queued=${queued}`);
    } finally {
      h.cleanup();
    }
  }
});

test("a second start over a pending session calls it pending, not running", async () => {
  const h = harness({
    route: (path, body) => (path.endsWith("/host/events") ? offline() : healthy(path, body)),
  });
  try {
    assert.notEqual(await h.run("start"), 0);
    h.err.length = 0;
    h.calls.length = 0;
    assert.equal(await h.run("start"), 1);
    assert.ok(!h.calls.includes("POST /remote/sessions"), "never a second session");
    assert.doesNotMatch(stderr(h), /already running/);
    assert.match(stderr(h), /not live yet/);
    assert.match(stderr(h), /aether rc off/);
  } finally {
    h.cleanup();
  }
});

// ── the local coding run is never affected ──────────────────────────────────

const task: TaskCommand = { type: "task", text: "t", cwd: ".", poolGb: 5 };
const exec = { executeAsync: async (): Promise<ToolResult> => ({ output: "", exitCode: 0 }) } as unknown as ToolExecutor;

function brain(): Brain {
  return {
    async *run() {
      yield { type: "stage", name: "build", face: "" };
      yield { type: "done", ok: true, result: "", remaining: 0, reason: "" };
    },
    sendToolResult() {},
    control() {},
    close() {},
  };
}

test("an unreadable or half-started RC state opens no observer and the coding run finishes", async () => {
  const h = harness();
  try {
    let calls = 0;
    const api = { postJson: () => { calls += 1; throw new Error("unexpected"); } } as unknown as ApiClient;

    writeDamaged(h, TRUNCATED);
    assert.equal(openRcCodingObserver(h.dir, api, h.outboxPath), null);

    saveOutbox(h.outboxPath, createOutbox({
      session_id: SESSION, project_ref: projectRefFor(h.dir), device_id: DEVICE,
      epoch: 1, project_root: h.dir, start_phase: "registered",
    }));
    assert.equal(openRcCodingObserver(h.dir, api, h.outboxPath), null, "an unattached session never publishes");

    assert.equal(await hostLoop(brain(), exec, () => {}, task), 0);
    assert.equal(calls, 0);
  } finally {
    h.cleanup();
  }
});
