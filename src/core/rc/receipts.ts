// receipts.ts — when the durable cursor is allowed to move.
//
// The host uploads a batch of observation events and the broker answers with
// receipts. Advancing the cursor means "these are safely stored, drop them
// locally". Getting that wrong in either direction is bad, but not equally bad:
//
//   advance too eagerly -> events are gone, and the viewer silently missed part
//                          of a session nobody can reconstruct
//   advance too late    -> events are re-sent and deduped broker-side by
//                          host_event_id
//
// The second is cheap and self-correcting. So every ambiguity resolves to
// "preserve the batch", and `validateReceipts` returns a REASON rather than a
// boolean, because the host has to be able to say honestly why it did not
// advance.
//
// FIVE THINGS A RECEIPT MUST PROVE, AND THE FOUR PR #108 CHECKED
//
// PR #108's `validatedReceiptSeqs` checked the batch was fully covered, had no
// duplicate ids, no rejected flag, and that each seq was a positive safe
// integer. Necessary, not sufficient. It would accept:
//
//   * receipts whose sequences run backwards within one batch,
//   * sequences at or below the cursor the host already durably recorded,
//   * a receipt for the right event id carrying a digest for different bytes.
//
// The first two let a broker — or something impersonating one — replay stale
// sequence numbers to make the host drop events it never really stored. The
// third is the event-id/payload binding the specification names
// RC_EVENT_ID_CONFLICT: the same id with different bytes is a different event,
// and accepting it would let a retry silently change what a viewer saw.

import { digestOf } from "../device_runtime/canonical_json.js";

/** One event as it sits in the durable outbox. */
export interface OutboxEvent {
  host_event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
}

/** One receipt as the broker returns it. Fields are `unknown`: this is wire
 *  input, and typing it optimistically is how a malformed body gets trusted. */
export interface AppendReceipt {
  host_event_id?: unknown;
  seq?: unknown;
  payload_digest?: unknown;
  rejected?: unknown;
}

export interface AppendResponse {
  receipts?: unknown;
  /** Echoed by the Cloud append route. Never read here -- the session this
   *  batch belongs to is the host's own state, not something a response is
   *  allowed to redefine -- but declared so the wire shape is honest. */
  session_id?: unknown;
}

/** Why the cursor did not move. Every value is a preserve-the-batch outcome. */
export type ReceiptRejection =
  | "malformed_response"
  | "count_mismatch"
  | "unknown_event_id"
  | "duplicate_receipt"
  | "explicitly_rejected"
  | "invalid_sequence"
  | "sequence_not_increasing"
  | "sequence_not_above_cursor"
  | "digest_mismatch";

export type ReceiptOutcome =
  | { ok: true; highestSeq: number }
  | { ok: false; reason: ReceiptRejection };

/** The stable error code for an id reused with different bytes. */
export const RC_EVENT_ID_CONFLICT = "RC_EVENT_ID_CONFLICT" as const;

/**
 * Canonical digest of an event's payload.
 *
 * Reuses `digestOf` from device_runtime/canonical_json.ts — the repository's
 * existing canonical-JSON owner — rather than adding another. AETHER-CLOUD
 * already carries three functions named `canonical_digest` that disagree on
 * non-ASCII input; a fourth spelling here, on the boundary deciding whether a
 * viewer's events get dropped, would be the worst possible place for it.
 */
export function payloadDigest(payload: Record<string, unknown>): string {
  return digestOf(payload);
}

/**
 * Decide whether a broker response permits advancing the durable cursor.
 *
 * `cursor` is the highest sequence the host has already durably recorded. Every
 * receipt must sit strictly above it, and the batch's sequences must strictly
 * increase in the order the events were sent.
 */
export function validateReceipts(
  response: AppendResponse,
  batch: readonly OutboxEvent[],
  cursor: number,
): ReceiptOutcome {
  const receipts = response?.receipts;
  if (!Array.isArray(receipts)) return { ok: false, reason: "malformed_response" };

  // A partial receipt list is the commonest ambiguous answer and the one most
  // likely to be read as "mostly fine". It is not: an event without a receipt
  // has no evidence of storage.
  if (receipts.length !== batch.length) return { ok: false, reason: "count_mismatch" };

  const expected = new Map(batch.map((event) => [event.host_event_id, event]));
  const seen = new Set<string>();
  let previousSeq = cursor;

  for (const raw of receipts as AppendReceipt[]) {
    if (!raw || typeof raw !== "object") return { ok: false, reason: "malformed_response" };

    const id = raw.host_event_id;
    if (typeof id !== "string" || !expected.has(id)) {
      return { ok: false, reason: "unknown_event_id" };
    }
    if (seen.has(id)) return { ok: false, reason: "duplicate_receipt" };

    // Truthiness, not `=== true`. A broker answering `rejected: "quota"` is
    // rejecting the event; reading only the boolean would call that acceptance.
    if (raw.rejected) return { ok: false, reason: "explicitly_rejected" };

    const seq = raw.seq;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) {
      return { ok: false, reason: "invalid_sequence" };
    }
    if (seq <= cursor) return { ok: false, reason: "sequence_not_above_cursor" };
    if (seq <= previousSeq) return { ok: false, reason: "sequence_not_increasing" };

    // The event-id/payload binding. Checked only when the broker supplies a
    // digest: older brokers omit it, and refusing every batch from one would
    // stall observation over a field that used not to exist. When it IS
    // supplied it must match, because that is the entire point of sending it.
    const digest = raw.payload_digest;
    if (digest !== undefined) {
      if (typeof digest !== "string") return { ok: false, reason: "digest_mismatch" };
      if (digest !== payloadDigest(expected.get(id)!.payload)) {
        return { ok: false, reason: "digest_mismatch" };
      }
    }

    seen.add(id);
    previousSeq = seq;
  }

  // Redundant given the count and duplicate checks, kept because it states the
  // property that actually matters: every event in the batch is covered.
  if (seen.size !== batch.length) return { ok: false, reason: "count_mismatch" };

  return { ok: true, highestSeq: previousSeq };
}

/**
 * Operator-facing explanation. Never includes a payload or an event id — a
 * status line is somewhere people paste into issues.
 */
export function describeRejection(reason: ReceiptRejection): string {
  switch (reason) {
    case "malformed_response":
      return "the broker's receipt response was malformed";
    case "count_mismatch":
      return "the broker did not acknowledge every event in the batch";
    case "unknown_event_id":
      return "the broker acknowledged an event this host did not send";
    case "duplicate_receipt":
      return "the broker acknowledged the same event twice";
    case "explicitly_rejected":
      return "the broker rejected an event in the batch";
    case "invalid_sequence":
      return "the broker returned an invalid sequence number";
    case "sequence_not_increasing":
      return "the broker returned out-of-order sequence numbers";
    case "sequence_not_above_cursor":
      return "the broker returned a sequence at or below the durable cursor";
    case "digest_mismatch":
      return "a receipt did not match the payload this host sent";
  }
}
