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
import { commitReceipts, saveOutbox, takeBatch, type OutboxRecord } from "./outbox.js";
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
  | "RC_REVOKE_UNCONFIRMED";

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

export type FlushOutcome =
  | { ok: true; sent: number; cursor: number }
  | { ok: false; code: RcCode; detail: string };

// ── error classification ────────────────────────────────────────────────────

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/** The server's `detail`, flattened for MATCHING only. Never printed: a
 *  broker-authored string does not belong in a terminal. */
function detailText(error: unknown): string {
  const detail = (error as { detail?: unknown } | null)?.detail;
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
  try {
    return await deps.api.postJson<RemoteSessionSummary>(
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

  const outcome = commitReceipts(record, batch, response);
  if (!outcome.ok) {
    return { ok: false, code: "RC_RECEIPTS_UNPROVEN", detail: describeRejection(outcome.reason) };
  }

  // Durable before we forget: a crash between the receipt and this write would
  // otherwise resend a batch the broker already stored.
  saveOutbox(deps.outboxPath, record);
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
export async function revokeHost(deps: RcHostDeps, record: OutboxRecord): Promise<RevokeOutcome> {
  const sessionId = record.session_id;

  // 1-2: stop publishing and drop everything queued. Nothing further is sent
  // from this record whatever happens below.
  record.events = [];
  record.revoke_pending = true;

  // 3: durable before the network. If this write fails we are not permitted to
  // attempt the revoke and report on it — a caller would read "revoked" from a
  // host whose next start could resume.
  try {
    saveOutbox(deps.outboxPath, record);
  } catch {
    return {
      ok: false,
      code: "RC_REVOKE_UNCONFIRMED",
      detail:
        "publication stopped, but the local revoke marker could not be written; RC will not resume automatically",
    };
  }

  if (!sessionId) return { ok: true };

  // 4: Cloud revokes session, grants and streams atomically.
  try {
    await deps.api.postJson(sessionPath(sessionId, "/revoke"), {}, undefined, REQUEST_TIMEOUT_MS);
  } catch (error) {
    const { code } = classifyRcError(error);
    // A session the Cloud no longer has is already revoked as far as this host
    // is concerned; anything else stays pending and reconciles later.
    if (code !== "RC_SESSION_NOT_FOUND" && code !== "RC_SESSION_TERMINAL") {
      return {
        ok: false,
        code: "RC_REVOKE_UNCONFIRMED",
        detail:
          "local publication stopped, but the Cloud did not confirm revocation; RC stays off and will retry",
      };
    }
  }

  // 5: confirmed. Only now does the local session identity go away.
  record.session_id = "";
  record.device_id = "";
  record.project_ref = "";
  record.epoch = 0;
  record.cursor = 0;
  record.next_seq = 1;
  record.dropped = 0;
  record.quarantined = 0;
  record.revoke_pending = false;
  saveOutbox(deps.outboxPath, record);
  return { ok: true };
}
