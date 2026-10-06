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
export const RC_MAX_OBSERVED_WORKERS = 1_000;

export interface ObservedWorker {
  status: string;
  summary: string;
}

/**
 * How far `rc start` got, durably. Spec #227: a session is reported live only
 * after register, attach, durable local state AND a receipted first append.
 *
 *   ""            no session
 *   "registered"  the Cloud created the session; attach has not succeeded.
 *                 Nothing may publish from this record — `rc off` revokes it.
 *   "attached"    this host owns the session and the opening events are
 *                 queued, but the Cloud has not yet proven it stored them.
 *                 Delivery may continue (that is what confirms it), but no
 *                 surface may call the session live.
 *   "confirmed"   the first append was receipted. Only now is it live.
 */
export type RcStartPhase = "" | "registered" | "attached" | "confirmed";

/**
 * Why a persisted outbox could not be trusted (spec #227).
 *
 * A file that exists but cannot be read, parsed, or recognised is NOT the same
 * as no file. It may be the only record of a live Cloud session, so it is
 * surfaced as an explicit condition rather than silently replaced by a blank
 * record that the next `saveOutbox` would write over it.
 */
export interface OutboxRecovery {
  reason: "unreadable" | "unparseable" | "incompatible";
  /** A session id recovered from the damaged bytes, when one is legible. */
  session_id: string | null;
}

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
  /** Last published worker state, retained after receipts to dedupe replayed trees. */
  observed_workers: Record<string, ObservedWorker>;
  /** Durable progress of `rc start`; see RcStartPhase. */
  start_phase: RcStartPhase;
  /**
   * In memory only, never persisted: set when the file on disk could not be
   * trusted. A record carrying it is a blank stand-in, and saveOutbox refuses
   * to write it over the bytes it stands in for.
   */
  recovery?: OutboxRecovery;
}

export interface CreateOutboxOptions {
  session_id: string;
  project_ref: string;
  device_id: string;
  epoch: number;
  project_root: string;
  /** Defaults to "attached" for a record with a session, "" without one. */
  start_phase?: RcStartPhase;
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
    observed_workers: Object.create(null) as Record<string, ObservedWorker>,
    start_phase: options.start_phase ?? (options.session_id ? "attached" : ""),
  };
}

/**
 * Whether this record may publish for `projectRoot` right now.
 *
 * The single predicate every publisher shares, so "is there an active RC
 * session for this project" has one answer: a session this host attached to,
 * not revoked, read from a trustworthy file, for the same working tree.
 */
export function isPublishable(record: OutboxRecord, projectRoot: string): boolean {
  return Boolean(record.session_id) && !record.revoke_pending && !record.recovery &&
    (record.start_phase === "attached" || record.start_phase === "confirmed") &&
    record.project_root === projectRoot;
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

/**
 * Codes Windows reports while ANOTHER handle holds the file — a concurrent
 * reader in another process, an antivirus scan, an indexer — and that clear
 * within milliseconds. Every RC writer renames over the same file, so these
 * are routine there, and none of them says anything about the record itself.
 */
const TRANSIENT_FS_CODES: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "EACCES", "EAGAIN"]);
const TRANSIENT_FS_ATTEMPTS = 4;
const TRANSIENT_FS_PAUSE_MS = 10;

function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run one synchronous file step, retrying briefly while it fails with a
 * transient lock (#227). Bounded: at most 60 ms of waiting in total, and any
 * other error — or a lock that never clears — is thrown to the caller.
 */
export function retryTransientFs<T>(
  step: () => T,
  attempts: number = TRANSIENT_FS_ATTEMPTS,
  wait: (ms: number) => void = pauseSync,
): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return step();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (attempt >= attempts || typeof code !== "string" || !TRANSIENT_FS_CODES.has(code)) throw error;
      wait(TRANSIENT_FS_PAUSE_MS * attempt);
    }
  }
}

/**
 * Atomic, owner-only write. A partially written outbox is a corrupt outbox.
 *
 * Refuses a record that stands in for state that could not be read (#227):
 * writing it would replace what may be the only record of a live Cloud
 * session with a blank. Recovery goes through `aether rc off`, which revokes
 * what it can identify and sets the damaged bytes aside rather than over them.
 */
export function saveOutbox(path: string, record: OutboxRecord): void {
  if (record.recovery) {
    throw new Error("refusing to overwrite RC state that could not be read; run `aether rc off`");
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    retryTransientFs(() => renameSync(tmp, path));
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

/** A session id shape narrow enough that salvage can never lift arbitrary text. */
const SALVAGEABLE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The session id damaged bytes still legibly name, or null.
 *
 * Only an id is salvaged, never events or counters: an id is what `rc off`
 * needs to revoke the Cloud session, and nothing else in a file we could not
 * parse is trustworthy enough to act on.
 */
function salvageSessionId(parsed: unknown, raw: string): string | null {
  const fromObject = isPlainObject(parsed) ? parsed["session_id"] : undefined;
  const candidate = typeof fromObject === "string"
    ? fromObject
    : /"session_id"\s*:\s*"([^"\\]{1,128})"/.exec(raw)?.[1];
  return candidate && SALVAGEABLE_SESSION_ID.test(candidate) ? candidate : null;
}

function recoveryStandIn(projectRoot: string, recovery: OutboxRecovery): OutboxRecord {
  const record = blank(projectRoot);
  record.recovery = recovery;
  return record;
}

/**
 * Read the outbox at `path`, refusing to trust any part of it.
 *
 * A MISSING file is a fresh empty outbox. A file that exists but is
 * unreadable, unparseable or of another schema is different (#227): it may
 * be the only record of a live Cloud session. It still loads as an empty,
 * unpublishable record — RC failing to reload never stops a local session —
 * but one carrying an explicit `recovery` condition, which saveOutbox refuses
 * to write over and which `rc start` refuses to start past.
 */
export function loadOutbox(path: string, projectRoot: string): OutboxRecord {
  let raw: string;
  try {
    raw = retryTransientFs(() => readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return blank(projectRoot);
    return recoveryStandIn(projectRoot, { reason: "unreadable", session_id: null });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return recoveryStandIn(projectRoot, { reason: "unparseable", session_id: salvageSessionId(undefined, raw) });
  }
  if (!isPlainObject(parsed) || parsed["schema"] !== RC_OUTBOX_SCHEMA) {
    return recoveryStandIn(projectRoot, { reason: "incompatible", session_id: salvageSessionId(parsed, raw) });
  }

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
  const observed = parsed["observed_workers"];
  if (isPlainObject(observed)) {
    for (const [id, value] of Object.entries(observed).slice(0, RC_MAX_OBSERVED_WORKERS)) {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id) || !isPlainObject(value)) continue;
      if (typeof value["status"] !== "string" || typeof value["summary"] !== "string") continue;
      if (value["status"].length > 32 || value["summary"].length > 128) continue;
      record.observed_workers[id] = { status: value["status"], summary: value["summary"] };
    }
  }

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
  record.start_phase = startPhaseOf(parsed["start_phase"], record);
  return record;
}

/**
 * The persisted start phase, or the most a legacy file can prove.
 *
 * A record written before start progress was tracked was saved after attach
 * and before its first flush, so it is "attached" unless a receipted cursor
 * shows the first append landed. Never "confirmed" on the file's say-so alone.
 */
function startPhaseOf(value: unknown, record: OutboxRecord): RcStartPhase {
  if (!record.session_id) return "";
  if (value === "registered" || value === "attached") return value;
  // "confirmed" is believed only alongside the receipted cursor that proves it.
  return record.cursor > 0 ? "confirmed" : "attached";
}

/**
 * Move damaged state out of the way without destroying it (#227).
 *
 * Used only by `rc off` after it has done what it can with the salvaged
 * session id. The bytes are renamed beside the original rather than deleted,
 * so a support investigation can still read them, and a fresh start is no
 * longer blocked by them. Returns false when the file could not be moved.
 */
export function setAsideOutbox(path: string, now: number = Date.now()): boolean {
  try {
    renameSync(path, `${path}.unreadable-${now}`);
    return true;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === "ENOENT";
  }
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
