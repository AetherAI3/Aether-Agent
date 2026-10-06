// host.ts — the outbound transport for the RC-02 viewer host.
//
// This is the only module in src/core/rc that talks to the network, and it
// talks in exactly one direction. It calls the Cloud's host routes; nothing
// calls it. There is no socket, no port, no poll for inbound work, and no
// place for one to be added later without test/rc_host.test.ts going red --
// that guard reads this directory's source for `createServer`, `node:net`,
// `node:http` and `.listen(`, because §4.1 is a property of the code, not of
// whichever paths a runtime test happens to walk.
//
// WHAT THE HOST AUTHENTICATES WITH
//
// Nothing of its own. Every route here is authenticated by the ordinary Aether
// session token ApiClient already holds, and the Cloud has no host-credential
// issuance to call: there is no `host_secret_ref` because there is no host
// secret. The specification's §5.2 custody sequence describes a surface that
// was never built Cloud-side, and minting a local credential to satisfy it
// would CREATE the very thing that section exists to protect -- another secret
// at rest. So "no raw credential on disk" holds by construction here, and
// identity is read through loadEnrollmentMetadata(), the projection that
// cannot return either of the enrolment record's two secret fields at all.
//
// That last sentence is deliberately worded around those field names rather
// than quoting them: test/rc_viewer_host.test.ts greps this directory's raw
// source for them, and it is right to stay that strict -- a guard that has to
// reason about which mentions are "only a comment" is a guard with an
// exception, and exceptions are what get argued into existence later.
//
// WHY EVERY FAILURE IS TYPED
//
// The ways a flush fails need different responses: an outage should be retried
// with backoff, a rate limit should back off harder, a terminal session should
// stop the host entirely, and an event-id conflict is a bug that retrying will
// never fix. A caller that has to grep an English string to tell those apart
// will eventually get it wrong, and wrong here means either a hot retry loop
// against a dead session or a host that gives up on a broker that was busy.

import type { ApiClient } from "../transport.js";
import { existsSync } from "node:fs";
import { commitReceipts, loadOutbox, saveOutbox, takeBatch, type OutboxRecord } from "./outbox.js";
import { describeRejection, type AppendResponse } from "./receipts.js";

/** Stable envelope name for anything this module surfaces to a caller. */
export const RC_HOST_SCHEMA = "aether.cli.rc/1";

/**
 * Machine-readable outcomes. Stable strings: a script or a UI branches on
 * these, so a value is added rather than renamed.
 */
export type RcCode =
  /** No enrolled device, so RC cannot name the machine it publishes from. */
  | "RC_NOT_ENROLLED"
  /** The session is gone, or this device is not its host. */
  | "RC_SESSION_NOT_FOUND"
  /** Another host already owns this session. Never a takeover. */
  | "RC_HOST_CONFLICT"
  /** The session is revoked, expired or closed: stop, do not retry. */
  | "RC_SESSION_TERMINAL"
  /** The broker could not be reached at all. Retry with backoff. */
  | "RC_BROKER_UNREACHABLE"
  /** The broker asked us to slow down. Back off harder. */
  | "RC_RATE_LIMITED"
  /** The account is not permitted to use the remote surface. */
  | "RC_NOT_AUTHORIZED"
  /** One host_event_id was reused with different bytes. Retrying cannot fix it. */
  | "RC_EVENT_ID_CONFLICT"
  /** The broker answered, but not with proof the batch was stored. */
  | "RC_RECEIPTS_UNPROVEN"
  /** The broker rejected the request body outright. */
  | "RC_EVENT_REJECTED"
  /** Local publication stopped, but Cloud revocation is unconfirmed. */
  | "RC_REVOKE_UNCONFIRMED"
  /** Persisted RC state exists but cannot be read or recognised. Run `rc off`. */
  | "RC_STATE_UNREADABLE"
  /** Local RC state could not be written, so nothing may claim to be live. */
  | "RC_STATE_UNWRITABLE";

/**
 * Codes after which retrying the same request cannot help: the session is
 * gone or not ours, or the broker refused the bytes themselves. A host that
 * sees one stops; it never loops on it. Everything else (unreachable, rate
 * limited, an unproven receipt) is transient and retried with backoff.
 */
const TERMINAL_CODES: ReadonlySet<RcCode> = new Set<RcCode>([
  "RC_SESSION_NOT_FOUND",
  "RC_HOST_CONFLICT",
  "RC_SESSION_TERMINAL",
  "RC_NOT_AUTHORIZED",
  "RC_EVENT_ID_CONFLICT",
  "RC_EVENT_REJECTED",
  "RC_STATE_UNREADABLE",
  "RC_STATE_UNWRITABLE",
]);

export function isTerminalRcCode(code: RcCode): boolean {
  return TERMINAL_CODES.has(code);
}

/** A typed transport failure. `detail` is composed locally, never echoed. */
export class RcError extends Error {
  constructor(
    readonly code: RcCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "RcError";
  }
}

export interface RcHostDeps {
  api: ApiClient;
  /** Where the durable outbox for this project lives. */
  outboxPath: string;
  /** Anchors path relativization so reloads sanitize identically. */
  projectRoot: string;
  /** Durable writer; defaults to saveOutbox. Injected only to fail a write on purpose. */
  persist?: (path: string, record: OutboxRecord) => void;
}

function persistOf(deps: RcHostDeps): (path: string, record: OutboxRecord) => void {
  return deps.persist ?? saveOutbox;
}

/** Write durably, reporting failure as a value: RC failures never throw into a caller's run. */
export function persistRecord(deps: RcHostDeps, record: OutboxRecord): boolean {
  try {
    persistOf(deps)(deps.outboxPath, record);
    return true;
  } catch {
    return false;
  }
}

/** Identifiers only — never file contents. Mirrors Cloud's RepoSummaryV1. */
export interface RepoSummary {
  repo: string;
  branch: string;
  base_commit: string;
  dirty_file_count: number;
}

export interface RegisterOptions {
  project_ref: string;
  device_id: string;
  session_name: string;
  repo: RepoSummary;
}

/** The subset of the Cloud session a host needs. Extra fields are ignored. */
export interface RemoteSessionSummary {
  session_id: string;
  state: string;
  device_id?: string;
  session_name?: string;
  expires_at?: string;
}

/** One-time observer invitation. Never put this response in the durable outbox. */
export interface ObserverGrant {
  session_id: string;
  purpose: "observe";
  device_id: string;
  token: string;
  expires_at: string;
}

export async function mintObserverGrant(
  deps: RcHostDeps,
  sessionId: string,
  observerId: string,
): Promise<ObserverGrant> {
  try {
    const grant = await deps.api.postJson<ObserverGrant>(
      `/remote/sessions/${encodeURIComponent(sessionId)}/grants`,
      { purpose: "observe", device_id: observerId },
      undefined,
      REQUEST_TIMEOUT_MS,
    );
    if (grant.session_id !== sessionId || grant.purpose !== "observe" ||
        grant.device_id !== observerId || !/^rsgt_[0-9a-f]{48}$/.test(grant.token) ||
        !Number.isFinite(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= Date.now()) {
      throw new RcError("RC_RECEIPTS_UNPROVEN", "the broker returned an invalid observer grant");
    }
    return grant;
  } catch (error) {
    if (error instanceof RcError) throw error;
    rethrow(error);
  }
}

export type FlushOutcome =
  | { ok: true; sent: number; cursor: number }
  | { ok: false; code: RcCode; detail: string };

// ── error classification ────────────────────────────────────────────────────

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/** The server's `detail`, flattened for MATCHING only. Never printed: a
 *  broker-authored string does not belong in a terminal.
 *
 *  ApiClient's HttpError carries the parsed response at `body`, so FastAPI's
 *  discriminator is `body.detail`; a bare `detail` is accepted too. */
export function detailText(error: unknown): string {
  const carrier = error as { detail?: unknown; body?: unknown } | null;
  const body = carrier?.body;
  const detail = carrier?.detail ??
    (body && typeof body === "object" ? (body as { detail?: unknown }).detail : undefined);
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    const inner = (detail as { error?: unknown }).error;
    if (typeof inner === "string") return inner;
  }
  return "";
}

/**
 * Map a thrown ApiClient error onto a code.
 *
 * Three different 409s share a status and mean different things, so the
 * server's own discriminator decides: `event_conflict` is the payload-bound id
 * collision, "host already attached" is the exclusive-host rule, and anything
 * else on 409 is a session that can no longer take appends.
 */
export function classifyRcError(error: unknown): { code: RcCode; detail: string } {
  const status = statusOf(error);
  const detail = detailText(error);

  if (status === null) {
    return {
      code: "RC_BROKER_UNREACHABLE",
      detail: "the remote-session broker could not be reached",
    };
  }
  if (status === 401 || status === 403) {
    return { code: "RC_NOT_AUTHORIZED", detail: "this account may not use the remote surface" };
  }
  if (status === 404) {
    return {
      code: "RC_SESSION_NOT_FOUND",
      detail: "the session does not exist, or this device is not its host",
    };
  }
  if (status === 429) {
    return { code: "RC_RATE_LIMITED", detail: "the broker is rate limiting this host" };
  }
  if (status === 409) {
    if (detail.includes("event_conflict")) {
      return { code: "RC_EVENT_ID_CONFLICT", detail: "an event id was reused with different bytes" };
    }
    if (detail.includes("host already attached")) {
      return {
        code: "RC_HOST_CONFLICT",
        detail: "another host is already attached to this session",
      };
    }
    return { code: "RC_SESSION_TERMINAL", detail: "the session no longer accepts events" };
  }
  if (status === 400) {
    return { code: "RC_EVENT_REJECTED", detail: "the broker rejected the request body" };
  }
  return { code: "RC_BROKER_UNREACHABLE", detail: `the broker answered ${status}` };
}

function rethrow(error: unknown): never {
  const { code, detail } = classifyRcError(error);
  throw new RcError(code, detail);
}

// ── retry pacing ────────────────────────────────────────────────────────────

const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 60_000;

/**
 * Exponential backoff, 1 s to 60 s, with jitter (spec §6.1).
 *
 * The jitter is not decoration. Every host that lost the same broker
 * reconnects on the same schedule, so an un-jittered fleet returns as one
 * synchronized wave and knocks over the thing it was waiting for. `rng` is
 * injected so a test asserts the shape rather than the randomness.
 */
export function retryDelayMs(attempt: number, rng: () => number = Math.random): number {
  const step = Math.max(1, Math.min(attempt, 32));
  const base = Math.min(RETRY_BASE_MS * 2 ** (step - 1), RETRY_CAP_MS);
  // Cap AFTER jitter, or the cap itself becomes a synchronization point.
  return Math.min(RETRY_CAP_MS, Math.round(base + rng() * base * 0.5));
}

// ── host routes ─────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 10_000;

function sessionPath(sessionId: string, suffix: string): string {
  return `/remote/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

/** Create the session. Identifiers only; the repo summary carries no content. */
export async function registerSession(
  deps: RcHostDeps,
  options: RegisterOptions,
): Promise<RemoteSessionSummary> {
  let session: RemoteSessionSummary;
  try {
    session = await deps.api.postJson<RemoteSessionSummary>(
      "/remote/sessions",
      {
        project_ref: options.project_ref,
        device_id: options.device_id,
        session_name: options.session_name,
        repo: options.repo,
      },
      undefined,
      REQUEST_TIMEOUT_MS,
    );
  } catch (error) {
    rethrow(error);
  }
  // Every later step addresses the session by this id, and `rc off` revokes
  // by it. An answer without a usable one cannot be recorded or rolled back.
  if (typeof session?.session_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(session.session_id)) {
    throw new RcError("RC_RECEIPTS_UNPROVEN", "the broker did not return a usable session id");
  }
  return session;
}

/** Claim the single exclusive host slot. A 409 is final, never a takeover. */
export async function attachHost(
  deps: RcHostDeps,
  sessionId: string,
  deviceId: string,
): Promise<RemoteSessionSummary> {
  try {
    return await deps.api.postJson<RemoteSessionSummary>(
      sessionPath(sessionId, "/host/attach"),
      { device_id: deviceId },
      undefined,
      REQUEST_TIMEOUT_MS,
    );
  } catch (error) {
    rethrow(error);
  }
}

/** Renew the session TTL and learn its current state. */
export async function heartbeatHost(
  deps: RcHostDeps,
  sessionId: string,
  deviceId: string,
): Promise<string> {
  try {
    const response = await deps.api.postJson<{ state?: unknown }>(
      sessionPath(sessionId, "/host/heartbeat"),
      { device_id: deviceId },
      undefined,
      REQUEST_TIMEOUT_MS,
    );
    return typeof response?.state === "string" ? response.state : "unknown";
  } catch (error) {
    rethrow(error);
  }
}

/**
 * Send one bounded batch and advance the cursor only if the answer proves it.
 *
 * On every failure the record is left exactly as it was, so the next attempt
 * resends the same events. That is the deliberate direction: the broker
 * dedupes on host_event_id, so a duplicate costs a round trip, while a batch
 * dropped on an unproven answer is gone for good.
 */
export async function flushOutbox(deps: RcHostDeps, record: OutboxRecord): Promise<FlushOutcome> {
  const batch = takeBatch(record);
  if (batch.length === 0) return { ok: true, sent: 0, cursor: record.cursor };
  const before = existsSync(deps.outboxPath) ? loadOutbox(deps.outboxPath, deps.projectRoot) : null;
  if (before?.recovery) {
    return { ok: false, code: "RC_STATE_UNREADABLE", detail: "local RC state could not be read" };
  }
  if (before?.revoke_pending) {
    return { ok: false, code: "RC_SESSION_TERMINAL", detail: "local RC session was revoked" };
  }

  let response: AppendResponse;
  try {
    response = await deps.api.postJson<AppendResponse>(
      sessionPath(record.session_id, "/host/events"),
      {
        device_id: record.device_id,
        // Exactly the wire fields. host_seq, created_at and payload_digest are
        // this host's own bookkeeping; sending them would invite a broker to
        // echo values it does not own back into our ordering decisions.
        events: batch.map((event) => ({
          host_event_id: event.host_event_id,
          event_type: event.event_type,
          payload: event.payload,
        })),
      },
      undefined,
      REQUEST_TIMEOUT_MS,
    );
  } catch (error) {
    return { ok: false, ...classifyRcError(error) };
  }

  // `rc off` writes its tombstone before contacting the broker. An in-flight
  // append must not save an older active record over that local decision.
  if (before) {
    if (!existsSync(deps.outboxPath)) {
      return { ok: false, code: "RC_SESSION_TERMINAL", detail: "local RC session disappeared during append" };
    }
    const current = loadOutbox(deps.outboxPath, deps.projectRoot);
    if (current.recovery || current.session_id !== before.session_id || current.revoke_pending) {
      return { ok: false, code: "RC_SESSION_TERMINAL", detail: "local RC session changed during append" };
    }
  }

  const outcome = commitReceipts(record, batch, response);
  if (!outcome.ok) {
    return { ok: false, code: "RC_RECEIPTS_UNPROVEN", detail: describeRejection(outcome.reason) };
  }
  // A receipted append is the proof `rc start` waits for (#227). It may land
  // here rather than in start itself: a start that hit an outage stays
  // "attached" until a later delivery is receipted.
  if (record.start_phase === "attached") record.start_phase = "confirmed";

  // Durable before we forget: a crash between the receipt and this write would
  // otherwise resend a batch the broker already stored. A failed write throws:
  // the caller must not report as stored what this host cannot remember.
  persistOf(deps)(deps.outboxPath, record);
  return { ok: true, sent: batch.length, cursor: record.cursor };
}

// ── revoke ──────────────────────────────────────────────────────────────────

export type RevokeOutcome = { ok: true } | { ok: false; code: RcCode; detail: string };

/**
 * Turn the host off. Local-first, server-final (spec §5.4).
 *
 * The order is the whole design. Publication stops and the tombstone becomes
 * durable BEFORE the network request, so a crash at any instant leaves a host
 * that is off rather than one that looks alive. Local state is deleted only
 * after the Cloud confirms, so an unreachable Cloud leaves a host that is
 * locally silent and will reconcile later — never one that reported a success
 * it did not have.
 */
export async function revokeHost(
  deps: RcHostDeps,
  record: OutboxRecord,
  options: { timeoutMs?: number } = {},
): Promise<RevokeOutcome> {
  const sessionId = record.session_id;

  // No Cloud session means nothing to revoke and nothing to reconcile. A
  // tombstone naming no session could never be confirmed, so it would block
  // every later start; clear a stale one rather than writing a new one.
  if (!sessionId) {
    if (!record.revoke_pending && record.events.length === 0) return { ok: true };
    markRevoking(record);
    clearSession(record);
    return persistRecord(deps, record)
      ? { ok: true }
      : { ok: false, code: "RC_STATE_UNWRITABLE", detail: "local RC state could not be cleared" };
  }

  // 1-2: stop publishing and drop everything queued. Nothing further is sent
  // from this record whatever happens below.
  markRevoking(record);

  // 3: durable before the network. If this write fails, the ACTIVE record is
  // still on disk and a later run would resume from it, so nothing local can
  // keep publication off. Only the Cloud can: revoke there anyway, and report
  // exactly which half happened. Never a success, and never "will not resume".
  if (!persistRecord(deps, record)) {
    if (await confirmCloudRevoke(deps, sessionId, options.timeoutMs)) {
      return {
        ok: false,
        code: "RC_STATE_UNWRITABLE",
        detail:
          "the Cloud confirmed revocation, but local RC state could not be written; a later run's host is refused " +
          "by the revoked session. Run `aether rc off` again once local state is writable",
      };
    }
    return {
      ok: false,
      code: "RC_REVOKE_UNCONFIRMED",
      detail:
        "local RC state could not be written and the Cloud did not confirm revocation, so RC is NOT off; " +
        "run `aether rc off` again",
    };
  }

  // 4: Cloud revokes session, grants and streams atomically.
  if (!(await confirmCloudRevoke(deps, sessionId, options.timeoutMs))) {
    return {
      ok: false,
      code: "RC_REVOKE_UNCONFIRMED",
      detail:
        "local publication stopped, but the Cloud did not confirm revocation; RC stays off and will retry",
    };
  }

  // 5: confirmed. Only now does the local session identity go away. If even
  // that write fails the tombstone from step 3 is still on disk, so the next
  // command re-sends the (idempotent) revoke and clears it then.
  clearSession(record);
  if (!persistRecord(deps, record)) {
    return {
      ok: false,
      code: "RC_STATE_UNWRITABLE",
      detail: "the Cloud confirmed revocation, but local RC state could not be cleared; RC stays off",
    };
  }
  return { ok: true };
}

function markRevoking(record: OutboxRecord): void {
  record.events = [];
  record.revoke_pending = true;
}

function clearSession(record: OutboxRecord): void {
  record.session_id = "";
  record.device_id = "";
  record.project_ref = "";
  record.epoch = 0;
  record.cursor = 0;
  record.next_seq = 1;
  record.dropped = 0;
  record.quarantined = 0;
  record.observed_workers = Object.create(null) as typeof record.observed_workers;
  record.revoke_pending = false;
  record.start_phase = "";
}

/**
 * Ask the Cloud to revoke `sessionId`; true only when it confirmed.
 *
 * A session the Cloud no longer has, or that can no longer change state, is
 * already revoked as far as this host is concerned. Anything else — an
 * outage, a rate limit, a refusal — is unconfirmed and must stay pending.
 */
export async function confirmCloudRevoke(
  deps: RcHostDeps,
  sessionId: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<boolean> {
  try {
    await deps.api.postJson(sessionPath(sessionId, "/revoke"), {}, undefined, timeoutMs);
    return true;
  } catch (error) {
    const { code } = classifyRcError(error);
    // Only the Cloud's own answers settle it: its single 404 for a session
    // this account no longer has, or a 409 for one that can no longer change
    // state. A 404 from anything else — a proxy, a deployment without the
    // route — proves nothing about the session, so it stays pending.
    if (code === "RC_SESSION_NOT_FOUND") return detailText(error) === "session not found";
    return code === "RC_SESSION_TERMINAL";
  }
}

/** What a rolled-back start left behind, stated rather than implied. */
export interface AbandonOutcome {
  /** The Cloud confirmed the session is revoked. */
  revoked: boolean;
  /** Local state now matches: cleared when revoked, a tombstone when not. */
  durable: boolean;
}

/**
 * Roll back a session `rc start` registered but could not bring live (#227).
 *
 * The difference from revokeHost is one rule. revokeHost refuses to contact
 * the Cloud when it cannot first write its tombstone, because an operator
 * asked to turn a LIVE host off and must not be told "revoked" by a host that
 * could resume. Here the session was never reported live, and the failure
 * being rolled back is often exactly that the disk cannot be written. Not
 * revoking would orphan a Cloud session with no local record of it at all, so
 * the revoke is attempted whatever the disk says, and the outcome reports
 * both halves honestly.
 */
export async function abandonSession(deps: RcHostDeps, record: OutboxRecord): Promise<AbandonOutcome> {
  const sessionId = record.session_id;
  markRevoking(record);
  const tombstone = persistRecord(deps, record);
  if (!sessionId) return { revoked: true, durable: tombstone };
  if (!(await confirmCloudRevoke(deps, sessionId))) return { revoked: false, durable: tombstone };
  clearSession(record);
  return { revoked: true, durable: persistRecord(deps, record) };
}
