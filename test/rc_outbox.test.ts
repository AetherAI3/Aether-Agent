// RC-02 outbox — the durable half of the viewer host.
//
// Four groups, ordered by what a mistake costs:
//
//   1. Nothing unsanitized ever reaches disk      — §6.3, refit 11
//   2. The cursor moves only on proof             — §5.3, exit proof 11
//   3. Reloaded state is untrusted input          — refit 9/13, exit proof 12
//   4. Bounds and drops are visible, never silent — §6.2
//
// Every fixture is synthetic. The credential-shaped literals exist to be
// asserted ABSENT from what gets persisted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RC_MAX_BATCH,
  RC_MAX_OUTBOX_EVENTS,
  RC_OUTBOX_SCHEMA,
  commitReceipts,
  createOutbox,
  enqueueEvent,
  loadOutbox,
  saveOutbox,
  takeBatch,
  type OutboxRecord,
} from "../src/core/rc/outbox.js";

const SESSION = "rs_" + "a".repeat(32);
const DEVICE = "dev-1";
const PROJECT_ROOT = "/work/proj";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "aether-rc-outbox-"));
}

function fresh(): { record: OutboxRecord; path: string } {
  const path = join(sandbox(), "outbox.json");
  return {
    record: createOutbox({
      session_id: SESSION,
      project_ref: "proj",
      device_id: DEVICE,
      epoch: 1,
      project_root: PROJECT_ROOT,
    }),
    path,
  };
}

/** Enqueue n well-formed `plan` events. */
function fill(record: OutboxRecord, n: number): void {
  for (let i = 0; i < n; i++) {
    enqueueEvent(record, "plan", {
      step: i,
      total_steps: n,
      title: `step ${i}`,
      status: "running",
    });
  }
}

/** The receipt shape the Cloud append route actually returns. */
function receiptsFor(
  record: OutboxRecord,
  batch: readonly { host_event_id: string }[],
  from: number,
): { session_id: string; receipts: Array<Record<string, unknown>> } {
  return {
    session_id: record.session_id,
    receipts: batch.map((event, i) => ({ host_event_id: event.host_event_id, seq: from + i + 1 })),
  };
}

// ── 1. Nothing unsanitized ever reaches disk ────────────────────────────────

test("an event is sanitized before it is enqueued, not on the way out", () => {
  const { record } = fresh();
  const accepted = enqueueEvent(record, "plan", {
    step: 1,
    total_steps: 2,
    title: "deploy",
    status: "running",
    // None of these are on `plan`'s allowlist.
    env: { AWS_SECRET_ACCESS_KEY: "AKIAIOSFODNN7EXAMPLE" },
    authorization: "Bearer sk-not-a-real-token-000000000000",
  });
  assert.equal(accepted, true);
  const stored = JSON.stringify(record.events[0]);
  assert.doesNotMatch(stored, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(stored, /sk-not-a-real-token/);
  assert.doesNotMatch(stored, /authorization/i);
  assert.deepEqual(Object.keys(record.events[0]!.payload).sort(), [
    "status",
    "step",
    "title",
    "total_steps",
  ]);
});

test("an event type outside the viewer profile is refused outright", () => {
  const { record } = fresh();
  // `transcript` is in the frozen v1 vocabulary but excluded from the viewer
  // profile; it must not become sendable by going through the outbox.
  assert.equal(enqueueEvent(record, "transcript", { text: "hello" }), false);
  assert.equal(enqueueEvent(record, "shell", { cmd: "ls" }), false);
  assert.equal(record.events.length, 0);
});

test("an event with nothing safe left is refused rather than sent empty", () => {
  const { record } = fresh();
  assert.equal(enqueueEvent(record, "plan", { env: { A: "b" }, stdout: "x" }), false);
  assert.equal(record.events.length, 0);
});

test("each event carries a monotonic host sequence and a digest of its own bytes", () => {
  const { record } = fresh();
  fill(record, 3);
  assert.deepEqual(
    record.events.map((e) => e.host_seq),
    [1, 2, 3],
  );
  for (const event of record.events) {
    assert.match(event.payload_digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(event.host_event_id, /^[0-9a-f-]{36}$/);
  }
  // Distinct payloads must not share a digest, or dedupe collapses them.
  assert.equal(new Set(record.events.map((e) => e.payload_digest)).size, 3);
});

test("the persisted file is owner-only and round-trips exactly", () => {
  const { record, path } = fresh();
  fill(record, 2);
  saveOutbox(path, record);
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
  const reloaded = loadOutbox(path, PROJECT_ROOT);
  assert.equal(reloaded.quarantined, 0);
  assert.deepEqual(reloaded.events, record.events);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).schema, RC_OUTBOX_SCHEMA);
});

// ── 2. The cursor moves only on proof ───────────────────────────────────────

test("a complete ordered batch advances the cursor and clears those events", () => {
  const { record } = fresh();
  fill(record, 3);
  const batch = takeBatch(record);
  const outcome = commitReceipts(record, batch, receiptsFor(record, batch, 0));
  assert.equal(outcome.ok, true);
  assert.equal(record.cursor, 3);
  assert.equal(record.events.length, 0);
});

test("a partial receipt list preserves the whole batch and moves nothing", () => {
  const { record } = fresh();
  fill(record, 3);
  const batch = takeBatch(record);
  const short = receiptsFor(record, batch, 0);
  short.receipts.pop();
  const outcome = commitReceipts(record, batch, short);
  assert.equal(outcome.ok, false);
  assert.equal(record.cursor, 0);
  assert.equal(record.events.length, 3, "an unacknowledged event must not be dropped");
});

test("a stale sequence at or below the cursor preserves the batch", () => {
  const { record } = fresh();
  fill(record, 2);
  const first = takeBatch(record);
  commitReceipts(record, first, receiptsFor(record, first, 0));
  assert.equal(record.cursor, 2);

  fill(record, 1);
  const second = takeBatch(record);
  // A broker replaying seq 1 would make the host drop an event it never stored.
  const replayed = {
    session_id: SESSION,
    receipts: [{ host_event_id: second[0]!.host_event_id, seq: 1 }],
  };
  assert.equal(commitReceipts(record, second, replayed).ok, false);
  assert.equal(record.cursor, 2);
  assert.equal(record.events.length, 1);
});

test("an explicit rejection preserves the batch and is reported, not swallowed", () => {
  const { record } = fresh();
  fill(record, 1);
  const batch = takeBatch(record);
  const outcome = commitReceipts(record, batch, {
    session_id: SESSION,
    receipts: [{ host_event_id: batch[0]!.host_event_id, rejected: true, reason: "redaction" }],
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, "explicitly_rejected");
  assert.equal(record.events.length, 1);
});

test("a malformed body preserves the batch", () => {
  const { record } = fresh();
  fill(record, 1);
  const batch = takeBatch(record);
  assert.equal(commitReceipts(record, batch, {} as never).ok, false);
  assert.equal(commitReceipts(record, batch, { receipts: "nope" } as never).ok, false);
  assert.equal(record.events.length, 1);
});

test("a batch is capped at the append bound", () => {
  const { record } = fresh();
  fill(record, RC_MAX_BATCH + 5);
  assert.equal(takeBatch(record).length, RC_MAX_BATCH);
});

// ── 3. Reloaded state is untrusted input ────────────────────────────────────

function writeRaw(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
}

test("a poisoned entry is quarantined behind a visible counter, never resent", () => {
  const { record, path } = fresh();
  fill(record, 2);
  saveOutbox(path, record);

  const raw = JSON.parse(readFileSync(path, "utf8"));
  // Exactly the kind of entry a corrupted or tampered file would carry: a key
  // that was never on the allowlist, smuggled in after sanitization.
  raw.events[0].payload.authorization = "Bearer sk-smuggled-000000000000000000";
  writeRaw(path, raw);

  const reloaded = loadOutbox(path, PROJECT_ROOT);
  assert.equal(reloaded.quarantined, 1);
  assert.equal(reloaded.events.length, 1);
  assert.doesNotMatch(JSON.stringify(reloaded.events), /sk-smuggled/);
});

test("an entry whose digest does not match its bytes is quarantined", () => {
  const { record, path } = fresh();
  fill(record, 2);
  saveOutbox(path, record);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  raw.events[1].payload_digest = `sha256:${"0".repeat(64)}`;
  writeRaw(path, raw);

  const reloaded = loadOutbox(path, PROJECT_ROOT);
  assert.equal(reloaded.quarantined, 1);
  assert.deepEqual(
    reloaded.events.map((e) => e.host_seq),
    [1],
  );
});

test("an excluded event type that reaches disk is quarantined on reload", () => {
  const { record, path } = fresh();
  fill(record, 1);
  saveOutbox(path, record);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  raw.events[0].event_type = "transcript";
  writeRaw(path, raw);
  const reloaded = loadOutbox(path, PROJECT_ROOT);
  assert.equal(reloaded.quarantined, 1);
  assert.equal(reloaded.events.length, 0);
});

test("a wrong or missing schema yields an empty outbox rather than a trusted one", () => {
  const path = join(sandbox(), "outbox.json");
  writeRaw(path, { schema: "something.else/9", events: [{}] });
  const reloaded = loadOutbox(path, PROJECT_ROOT);
  assert.equal(reloaded.events.length, 0);
  assert.equal(reloaded.schema, RC_OUTBOX_SCHEMA);
});

test("unparseable or absent state loads as a fresh outbox, not a crash", () => {
  const dir = sandbox();
  const missing = join(dir, "nope.json");
  assert.equal(loadOutbox(missing, PROJECT_ROOT).events.length, 0);
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ not json", "utf8");
  assert.equal(loadOutbox(broken, PROJECT_ROOT).events.length, 0);
});

test("reloaded sequences that run backwards are quarantined", () => {
  const { record, path } = fresh();
  fill(record, 3);
  saveOutbox(path, record);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  raw.events[2].host_seq = 1; // duplicate of the first
  writeRaw(path, raw);
  const reloaded = loadOutbox(path, PROJECT_ROOT);
  assert.equal(reloaded.quarantined, 1);
  assert.deepEqual(
    reloaded.events.map((e) => e.host_seq),
    [1, 2],
  );
});

test("a reloaded cursor above next_seq is repaired rather than trusted", () => {
  const { record, path } = fresh();
  fill(record, 1);
  saveOutbox(path, record);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  raw.cursor = 9_999; // would make every future receipt look stale
  writeRaw(path, raw);
  const reloaded = loadOutbox(path, PROJECT_ROOT);
  assert.ok(reloaded.cursor < reloaded.next_seq, "cursor must not exceed the sequence issued");
});

// ── 4. Bounds and drops are visible ─────────────────────────────────────────

test("overflow drops the oldest event and counts it where status can show it", () => {
  const { record } = fresh();
  fill(record, RC_MAX_OUTBOX_EVENTS + 3);
  assert.equal(record.events.length, RC_MAX_OUTBOX_EVENTS);
  assert.equal(record.dropped, 3);
  // Oldest-first: the surviving window ends at the newest event.
  assert.equal(record.events.at(-1)!.host_seq, RC_MAX_OUTBOX_EVENTS + 3);
});

test("an oversize payload is refused, not truncated into a new shape", () => {
  // 64 list items x the 1 KiB per-string bound is the only way to exceed the
  // 32 KiB frame after sanitization; single strings are capped long before.
  const { record } = fresh();
  const accepted = enqueueEvent(record, "diff_summary", {
    files: Array.from({ length: 64 }, () => "x".repeat(1024)),
  });
  assert.equal(accepted, false);
  assert.equal(record.events.length, 0);
});

test("revoke_pending is persisted and survives a reload", () => {
  const { record, path } = fresh();
  record.revoke_pending = true;
  saveOutbox(path, record);
  assert.equal(loadOutbox(path, PROJECT_ROOT).revoke_pending, true);
});
