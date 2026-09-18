// outbox.ts — the durable half of the viewer host.
//
// The host publishes observation events to a broker it cannot rely on. The
// broker will be unreachable, slow, restarted mid-batch, or replaced by
// something pretending to be it, and none of that is allowed to affect the
// local session or to lose a viewer's view of it. This module owns the part
// that has to survive: what is queued, what has been proven stored, and what
// is safe to believe after a restart.
//
// THREE RULES, EACH ONE A TEST GROUP IN test/rc_outbox.test.ts
//
//  1. Sanitize BEFORE durable enqueue, never on the way out.
//     A payload that reaches disk unfiltered has already leaked: the file
//     outlives the process, gets copied into backups and support bundles, and
//     is read again by a future version of this code. So sanitizeRemotePayload
//     runs at enqueue and its refusal (null) means the event is dropped, not
//     stored-and-filtered-later. Nothing here can send an event that was not
//     sanitized, because nothing here stores one.
//
//  2. The cursor moves only on a complete typed acceptance receipt.
//     Delegated wholesale to rc/receipts.ts, which already encodes the five
//     things a receipt must prove and resolves every ambiguity toward
//     "preserve the batch". Re-sending a preserved batch is cheap and
//     self-correcting; dropping an event nobody stored is permanent.
//
//  3. Reloaded state is untrusted input (spec refit 13).
//     The file on disk is not this process's memory. It may have been edited,
//     truncated, copied from another machine, or written by an older build
//     with a weaker allowlist. So every entry is re-validated with the SAME
//     rules that applied before first enqueue -- schema, event type, allowlist,
//     bounds, digest, sequence monotonicity -- and anything that fails is
//     quarantined behind a counter `rc status` can show. A silently dropped
//     entry and a silently resent one are both worse than a visible number.
//
// WHY QUARANTINE RATHER THAN REPAIR
//
// A failing entry could often be "fixed" by re-sanitizing it and keeping the
// result. That would be wrong: the reason it fails is that its bytes are not
// what this host wrote, and an event whose provenance is unknown is exactly
// what a viewer must not be shown as if the host had produced it.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { digestOf } from "../device_runtime/canonical_json.js";
import { validateReceipts, type AppendResponse, type ReceiptOutcome } from "./receipts.js";
import { sanitizeRemotePayload } from "./redaction.js";
import { isViewerEventType, type ViewerEventType } from "./viewer_profile.js";

/** Pinned so an older file cannot be read as if it were this shape. */
export const RC_OUTBOX_SCHEMA = "aether.rc_outbox/1";

/** Spec §6.2 bounds: events per append, and the local queue ceiling. */
export const RC_MAX_BATCH = 32;
export const RC_MAX_OUTBOX_EVENTS = 1_000;

/** One sanitized event, durable. `payload` has already passed the allowlist. */
export interface PersistedEvent {
  host_event_id: string;
  event_type: ViewerEventType;
  payload: Record<string, unknown>;
  host_seq: number;
  created_at: string;
  payload_digest: string;
}

export interface OutboxRecord {
  schema: typeof RC_OUTBOX_SCHEMA;
  /** Binding fields — spec refit 8. Every request carries these. */
  session_id: string;
  project_ref: string;
  device_id: string;
  epoch: number;
  /** Needed to re-run path relativization identically after a restart. */
  project_root: string;
  /** Highest sequence the broker has proven it stored. */
  cursor: number;
  /** Next host sequence to issue. Monotonic, never reused. */
  next_seq: number;
  events: PersistedEvent[];
  /** Events discarded to stay inside the queue bound. Visible in status. */
  dropped: number;
  /** Entries refused on reload. Visible in status. Spec exit proof 12. */
  quarantined: number;
  /** Spec §5.4: written BEFORE the network revoke, cleared only after it. */
  revoke_pending: boolean;
}

export interface CreateOutboxOptions {
  session_id: string;
  project_ref: string;
  device_id: string;
  epoch: number;
  project_root: string;
}

export function createOutbox(options: CreateOutboxOptions): OutboxRecord {
  return {
    schema: RC_OUTBOX_SCHEMA,
    session_id: options.session_id,
    project_ref: options.project_ref,
    device_id: options.device_id,
    epoch: options.epoch,
    project_root: options.project_root,
    cursor: 0,
    next_seq: 1,
    events: [],
    dropped: 0,
    quarantined: 0,
    revoke_pending: false,
  };
}

// ── enqueue ─────────────────────────────────────────────────────────────────

/**
 * Sanitize `payload` and queue it. Returns false when the event is refused.
 *
 * A refusal is final by design: an unknown event type, an excluded one, a
 * payload with nothing allowlisted left, or a result over the frame bound.
 * Inventing a smaller payload to squeeze under the bound would ship a shape
 * nobody agreed on, so the event simply does not exist.
 */
export function enqueueEvent(
  record: OutboxRecord,
  eventType: string,
  payload: Record<string, unknown>,
): boolean {
  if (!isViewerEventType(eventType)) return false;
  const clean = sanitizeRemotePayload(eventType, payload, { projectRoot: record.project_root });
  if (!clean) return false;

  const event: PersistedEvent = {
    host_event_id: randomUUID(),
    event_type: eventType,
    payload: clean,
    host_seq: record.next_seq,
    created_at: new Date().toISOString(),
    payload_digest: digestOf(clean),
  };
  record.next_seq += 1;
  record.events.push(event);

  // Oldest-first eviction: a viewer joining late is better served by the most
  // recent picture than by the start of a session that has moved on. The count
  // is what makes the gap honest.
  while (record.events.length > RC_MAX_OUTBOX_EVENTS) {
    record.events.shift();
    record.dropped += 1;
  }
  return true;
}

/** The next events to send, oldest first, bounded by the append limit. */
export function takeBatch(record: OutboxRecord, max: number = RC_MAX_BATCH): PersistedEvent[] {
  return record.events.slice(0, Math.max(0, Math.min(max, RC_MAX_BATCH)));
}

/**
 * Apply a broker response. On proof, advance the cursor and drop exactly the
 * acknowledged events; on anything else, change nothing at all.
 */
export function commitReceipts(
  record: OutboxRecord,
  batch: readonly PersistedEvent[],
  response: AppendResponse,
): ReceiptOutcome {
  const outcome = validateReceipts(response, batch, record.cursor);
  if (!outcome.ok) return outcome;

  const acknowledged = new Set(batch.map((event) => event.host_event_id));
  record.events = record.events.filter((event) => !acknowledged.has(event.host_event_id));
  record.cursor = outcome.highestSeq;
  return outcome;
}

// ── persistence ─────────────────────────────────────────────────────────────

/** Atomic, owner-only write. A partially written outbox is a corrupt outbox. */
export function saveOutbox(path: string, record: OutboxRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(tmp, path);
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // Preserve the original write failure rather than the cleanup's.
    }
    throw error;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Re-validate one reloaded entry against the rules that applied at enqueue.
 *
 * The digest is checked twice on purpose: once that the stored digest matches
 * the stored bytes (catches a tampered digest), and once that re-sanitizing
 * the stored payload reproduces it exactly (catches bytes added AFTER
 * sanitization, which is what a smuggled key looks like).
 */
function revalidate(raw: unknown, projectRoot: string): PersistedEvent | null {
  if (!isPlainObject(raw)) return null;
  const { host_event_id, event_type, payload, host_seq, created_at, payload_digest } = raw;

  if (typeof host_event_id !== "string" || !host_event_id) return null;
  if (typeof event_type !== "string" || !isViewerEventType(event_type)) return null;
  if (!isPlainObject(payload)) return null;
  if (typeof host_seq !== "number" || !Number.isSafeInteger(host_seq) || host_seq < 1) return null;
  if (typeof created_at !== "string" || Number.isNaN(Date.parse(created_at))) return null;
  if (typeof payload_digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(payload_digest)) {
    return null;
  }
  if (digestOf(payload) !== payload_digest) return null;

  const resanitized = sanitizeRemotePayload(event_type, payload, { projectRoot });
  if (!resanitized || digestOf(resanitized) !== payload_digest) return null;

  return { host_event_id, event_type, payload, host_seq, created_at, payload_digest };
}

/**
 * Read the outbox at `path`, refusing to trust any part of it.
 *
 * A missing, unreadable, unparseable or wrong-schema file yields a fresh empty
 * outbox rather than an exception: RC failing to reload is not allowed to stop
 * a local session, and empty is the safe reading of "we cannot tell what was
 * queued".
 */
export function loadOutbox(path: string, projectRoot: string): OutboxRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return blank(projectRoot);
  }
  if (!isPlainObject(parsed) || parsed["schema"] !== RC_OUTBOX_SCHEMA) return blank(projectRoot);

  const record = blank(projectRoot);
  record.session_id = typeof parsed["session_id"] === "string" ? parsed["session_id"] : "";
  record.project_ref = typeof parsed["project_ref"] === "string" ? parsed["project_ref"] : "";
  record.device_id = typeof parsed["device_id"] === "string" ? parsed["device_id"] : "";
  record.epoch = finiteInt(parsed["epoch"], 0);
  record.project_root =
    typeof parsed["project_root"] === "string" ? parsed["project_root"] : projectRoot;
  record.dropped = finiteInt(parsed["dropped"], 0);
  record.quarantined = finiteInt(parsed["quarantined"], 0);
  record.revoke_pending = parsed["revoke_pending"] === true;

  const rawEvents = Array.isArray(parsed["events"]) ? parsed["events"] : [];
  let lastSeq = 0;
  for (const raw of rawEvents.slice(0, RC_MAX_OUTBOX_EVENTS)) {
    const event = revalidate(raw, record.project_root);
    // Sequences must strictly increase in file order. A repeated or decreasing
    // one means the file was reordered or spliced, and accepting it would let
    // a stale receipt look current.
    if (!event || event.host_seq <= lastSeq) {
      record.quarantined += 1;
      continue;
    }
    lastSeq = event.host_seq;
    record.events.push(event);
  }
  // Anything past the bound is a drop, and counted as one.
  record.quarantined += Math.max(0, rawEvents.length - RC_MAX_OUTBOX_EVENTS);

  // next_seq must sit above every sequence actually present, whatever the file
  // claimed, or a reissued sequence would collide with a queued event.
  record.next_seq = Math.max(finiteInt(parsed["next_seq"], 1), lastSeq + 1, 1);
  // A cursor above the sequences ever issued would make every future receipt
  // look stale and stall the host permanently. Repair rather than trust.
  record.cursor = Math.min(finiteInt(parsed["cursor"], 0), record.next_seq - 1);
  return record;
}

function blank(projectRoot: string): OutboxRecord {
  return createOutbox({
    session_id: "",
    project_ref: "",
    device_id: "",
    epoch: 0,
    project_root: projectRoot,
  });
}
