// OperatorApprovalReceiptV1 and ExecutionReceiptV1 — Spec 1 sections 11.6 and
// 11.7, plus the chain check from the end of 11.6.
//
// The approval is the only human "yes" in the system. It is deliberately
// over-specified: it re-states the symbol, side, quantity, notional, type and
// limit that the operator actually saw, rather than pointing at the review and
// trusting it not to have moved. Spec 1 section 18 requires that changing ANY
// order, evidence, preview, grant or account field invalidates the approval,
// and a receipt that only carried references could not detect that.
//
// What this module cannot do, and does not pretend to: enforce single use.
// Atomicity belongs to ATSv2's existing approval store, which performs the
// compare-and-set. `consumed_at` and isApprovalUsable() model the state so a
// caller can render it honestly and refuse an obviously spent approval early —
// they are not a substitute for the atomic consume.

import {
  choice,
  closed,
  digest,
  fail,
  ident,
  integer,
  minorUnits,
  nullable,
  opaqueRef,
  orderedWindow,
  schemaTag,
  symbol as tickerSymbol,
  text,
  timestamp,
} from "./primitives.js";
import { ORDER_SIDES, ORDER_TYPES, type OrderSide, type OrderType } from "./grant.js";
import {
  connectorBindingMatches,
  validateConnectorBindingRef,
  type BrokerOrderReviewReceiptV1,
  type ConnectorBindingRef,
  type NormalizedEquityOrderIntentV1,
} from "./order.js";

export const OPERATOR_APPROVAL_SCHEMA = "aether.ats.operator-approval/1" as const;
export const EXECUTION_RECEIPT_SCHEMA = "aether.ats.execution-receipt/1" as const;

export interface OperatorApprovalReceiptV1 {
  readonly schema_version: typeof OPERATOR_APPROVAL_SCHEMA;
  readonly approval_id: string;
  readonly request_id: string;
  readonly intent_digest: string;
  readonly review_id: string;
  readonly review_digest: string;
  readonly connector: ConnectorBindingRef;
  readonly provider_id: string;
  readonly opaque_account_ref: string;
  readonly grant_id: string;
  readonly grant_version: number;
  readonly policy_version: string;
  /** Restated order facts — exactly what the operator saw on the card. */
  readonly symbol: string;
  readonly side: OrderSide;
  readonly quantity: number;
  readonly order_type: OrderType;
  readonly limit_price_minor: number | null;
  readonly worst_case_notional_minor: number;
  readonly reservation_ref: string;
  readonly broker_preview_id: string;
  readonly activation_id: string;
  readonly artifact_id: string;
  readonly evidence_digest: string;
  /** Who approved, on which local device, in which local operator session. */
  readonly operator_id: string;
  readonly local_device_id: string;
  readonly operator_session_id: string;
  readonly approved_at: string;
  readonly expires_at: string;
  /** Set once the submission coordinator consumes it. Null while unspent. */
  readonly consumed_at: string | null;
}

const APPROVAL_FIELDS = [
  "schema_version",
  "approval_id",
  "request_id",
  "intent_digest",
  "review_id",
  "review_digest",
  "connector",
  "provider_id",
  "opaque_account_ref",
  "grant_id",
  "grant_version",
  "policy_version",
  "symbol",
  "side",
  "quantity",
  "order_type",
  "limit_price_minor",
  "worst_case_notional_minor",
  "reservation_ref",
  "broker_preview_id",
  "activation_id",
  "artifact_id",
  "evidence_digest",
  "operator_id",
  "local_device_id",
  "operator_session_id",
  "approved_at",
  "expires_at",
  "consumed_at",
] as const;

export function validateOperatorApproval(value: unknown, name = "Operator approval"): OperatorApprovalReceiptV1 {
  const raw = closed(value, name, APPROVAL_FIELDS);
  const approvedAt = timestamp(raw.approved_at, `${name} approved_at`);
  const expiresAt = timestamp(raw.expires_at, `${name} expires_at`);
  orderedWindow(approvedAt, expiresAt, `${name} validity window`);

  const consumedAt = nullable(raw.consumed_at, `${name} consumed_at`, (v, n) => timestamp(v, n));
  if (consumedAt !== null && Date.parse(consumedAt) < Date.parse(approvedAt)) {
    fail(`${name} cannot be consumed before it was approved.`);
  }

  const orderType = choice(raw.order_type, ORDER_TYPES, `${name} order type`);
  const limitPrice = nullable(raw.limit_price_minor, `${name} limit price`, (v, n) => minorUnits(v, n));
  if (orderType === "limit" && limitPrice === null) fail(`${name} limit order requires a limit price.`);
  if (orderType === "market" && limitPrice !== null) fail(`${name} market order must not carry a limit price.`);

  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, OPERATOR_APPROVAL_SCHEMA, name) as typeof OPERATOR_APPROVAL_SCHEMA,
    approval_id: ident(raw.approval_id, `${name} id`),
    request_id: ident(raw.request_id, `${name} request id`),
    intent_digest: digest(raw.intent_digest, `${name} intent digest`),
    review_id: ident(raw.review_id, `${name} review id`),
    review_digest: digest(raw.review_digest, `${name} review digest`),
    connector: validateConnectorBindingRef(raw.connector, `${name} connector`),
    provider_id: ident(raw.provider_id, `${name} provider`),
    opaque_account_ref: opaqueRef(raw.opaque_account_ref, `${name} opaque account reference`),
    grant_id: ident(raw.grant_id, `${name} grant id`),
    grant_version: integer(raw.grant_version, `${name} grant version`, 1, Number.MAX_SAFE_INTEGER),
    policy_version: text(raw.policy_version, `${name} policy version`, 64),
    symbol: tickerSymbol(raw.symbol, `${name} symbol`),
    side: choice(raw.side, ORDER_SIDES, `${name} side`),
    quantity: integer(raw.quantity, `${name} quantity`, 1, 1_000_000),
    order_type: orderType,
    limit_price_minor: limitPrice,
    worst_case_notional_minor: minorUnits(raw.worst_case_notional_minor, `${name} worst case notional`),
    reservation_ref: ident(raw.reservation_ref, `${name} reservation reference`),
    broker_preview_id: ident(raw.broker_preview_id, `${name} preview id`),
    activation_id: ident(raw.activation_id, `${name} activation`),
    artifact_id: ident(raw.artifact_id, `${name} artifact`),
    evidence_digest: digest(raw.evidence_digest, `${name} evidence digest`),
    operator_id: ident(raw.operator_id, `${name} operator`),
    local_device_id: ident(raw.local_device_id, `${name} device`),
    operator_session_id: ident(raw.operator_session_id, `${name} operator session`),
    approved_at: approvedAt,
    expires_at: expiresAt,
    consumed_at: consumedAt,
  });
}

export type ApprovalUsability = { readonly usable: true } | { readonly usable: false; readonly reason: string };

/**
 * Cheap pre-check before the atomic consume. A false here is authoritative
 * (the approval definitely cannot be used); a true is only "not obviously
 * spent" — the store still decides, because between this call and the commit
 * another click may have consumed it. Spec 1 section 16: "First terminal
 * action wins; later calls return stored outcome."
 */
export function isApprovalUsable(approval: OperatorApprovalReceiptV1, nowMs: number = Date.now()): ApprovalUsability {
  if (approval.consumed_at !== null) return { usable: false, reason: "Approval was already used." };
  if (nowMs >= Date.parse(approval.expires_at)) return { usable: false, reason: "Approval expired." };
  return { usable: true };
}

export type ChainVerdict = { readonly consistent: true } | { readonly consistent: false; readonly reason: string };

function broken(reason: string): ChainVerdict {
  return Object.freeze({ consistent: false as const, reason });
}

/**
 * Spec 1 section 11.6: "Preview, approval, and commit must name the same
 * adapter, account binding generation, endpoint/schema digest, and exact
 * execution environment. A mismatch is a terminal refusal, never an automatic
 * re-preview or reroute."
 *
 * This returns a verdict rather than repairing anything, and every caller must
 * treat `consistent: false` as terminal. The temptation on a mismatch is to
 * re-run the preview and carry on; that is precisely how an approval minted
 * against a paper preview ends up authorizing a live order, so there is no
 * refresh path in this module to reach for.
 */
export function verifyApprovalChain(
  intent: NormalizedEquityOrderIntentV1,
  review: BrokerOrderReviewReceiptV1,
  approval: OperatorApprovalReceiptV1,
  intentDigest: string,
): ChainVerdict {
  if (review.intent_digest !== intentDigest) return broken("Review does not answer this intent.");
  if (approval.intent_digest !== intentDigest) return broken("Approval does not bind this intent.");
  if (approval.review_id !== review.review_id) return broken("Approval does not bind this review.");
  if (intent.request_id !== review.request_id || review.request_id !== approval.request_id) {
    return broken("Request identity differs across the chain.");
  }

  if (!connectorBindingMatches(intent.connector, review.connector)) {
    return broken("Review connector binding differs from the intent.");
  }
  if (!connectorBindingMatches(review.connector, approval.connector)) {
    return broken("Approval connector binding differs from the review.");
  }

  if (approval.grant_id !== review.grant_id || approval.grant_version !== review.grant_version) {
    return broken("Grant identity or version changed after review.");
  }
  if (approval.reservation_ref !== review.reservation_ref) return broken("Reservation changed after review.");
  if (approval.broker_preview_id !== review.broker_preview_id) return broken("Broker preview changed after review.");
  if (approval.evidence_digest !== review.evidence.evidence_digest) {
    return broken("Market evidence changed after review.");
  }

  // The restated order facts must match what the intent actually said.
  if (
    approval.symbol !== intent.symbol ||
    approval.side !== intent.side ||
    approval.quantity !== intent.quantity ||
    approval.order_type !== intent.order_type ||
    approval.limit_price_minor !== intent.limit_price_minor
  ) {
    return broken("Approved order terms differ from the intent.");
  }
  if (approval.worst_case_notional_minor !== review.worst_case_notional_minor) {
    return broken("Approved notional differs from the reviewed notional.");
  }
  if (approval.activation_id !== intent.activation_id || approval.artifact_id !== intent.artifact_id) {
    return broken("Strategy activation or artifact changed after review.");
  }
  if (Date.parse(approval.expires_at) > Date.parse(review.reservation_expires_at)) {
    return broken("Approval outlives its reservation.");
  }

  return Object.freeze({ consistent: true as const });
}

/**
 * Terminal outcomes. `ambiguous` is first-class rather than an error code:
 * Spec 1 section 16 requires that a commit which MAY have started is never
 * retried, so "we do not know" must be a state the ledger can hold.
 */
export const EXECUTION_OUTCOMES = [
  "submitted",
  "accepted",
  "filled",
  "partially_filled",
  "refused",
  "cancelled",
  "ambiguous",
] as const;
export type ExecutionOutcome = (typeof EXECUTION_OUTCOMES)[number];

export const RECONCILIATION_STATES = ["not_required", "pending", "resolved", "unresolved"] as const;
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

/** Fill facts. Present ONLY when the broker confirmed them. */
export interface BrokerConfirmedFill {
  readonly filled_quantity: number;
  readonly average_fill_price_minor: number;
  readonly confirmed_at: string;
}

const FILL_FIELDS = ["filled_quantity", "average_fill_price_minor", "confirmed_at"] as const;

function validateFill(value: unknown, name: string): BrokerConfirmedFill {
  const raw = closed(value, name, FILL_FIELDS);
  return Object.freeze({
    filled_quantity: integer(raw.filled_quantity, `${name} quantity`, 1, 1_000_000),
    average_fill_price_minor: minorUnits(raw.average_fill_price_minor, `${name} average price`),
    confirmed_at: timestamp(raw.confirmed_at, `${name} confirmed_at`),
  });
}

export interface ExecutionReceiptV1 {
  readonly schema_version: typeof EXECUTION_RECEIPT_SCHEMA;
  readonly request_id: string;
  readonly intent_id: string;
  readonly approval_id: string;
  readonly outcome: ExecutionOutcome;
  readonly opaque_order_ref: string | null;
  readonly opaque_account_ref: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly quantity: number;
  readonly order_type: OrderType;
  readonly activation_id: string;
  readonly artifact_id: string;
  readonly evidence_digest: string;
  readonly client_principal: string;
  readonly grant_id: string;
  readonly submitted_at: string | null;
  readonly settled_at: string | null;
  /** Null unless the broker confirmed a fill. Never inferred. */
  readonly fill: BrokerConfirmedFill | null;
  readonly reconciliation_state: ReconciliationState;
  readonly reason: string | null;
}

const RECEIPT_FIELDS = [
  "schema_version",
  "request_id",
  "intent_id",
  "approval_id",
  "outcome",
  "opaque_order_ref",
  "opaque_account_ref",
  "symbol",
  "side",
  "quantity",
  "order_type",
  "activation_id",
  "artifact_id",
  "evidence_digest",
  "client_principal",
  "grant_id",
  "submitted_at",
  "settled_at",
  "fill",
  "reconciliation_state",
  "reason",
] as const;

export function validateExecutionReceipt(value: unknown, name = "Execution receipt"): ExecutionReceiptV1 {
  const raw = closed(value, name, RECEIPT_FIELDS);
  const outcome = choice(raw.outcome, EXECUTION_OUTCOMES, `${name} outcome`);
  const fill = raw.fill === null ? null : validateFill(raw.fill, `${name} fill`);
  const reconciliation = choice(raw.reconciliation_state, RECONCILIATION_STATES, `${name} reconciliation state`);
  const quantity = integer(raw.quantity, `${name} quantity`, 1, 1_000_000);

  // Spec 1 section 11.7: "fill fields only when broker-confirmed". A receipt
  // that carries a fill for a refused or ambiguous order is exactly the
  // fabricated P&L both specs forbid, so the shape refuses to express it.
  const filledOutcome = outcome === "filled" || outcome === "partially_filled";
  if (filledOutcome && fill === null) fail(`${name} reports a fill without broker-confirmed fill facts.`);
  if (!filledOutcome && fill !== null) fail(`${name} carries fill facts for an outcome that did not fill.`);
  if (fill !== null && fill.filled_quantity > quantity) fail(`${name} filled more than it ordered.`);
  if (outcome === "filled" && fill !== null && fill.filled_quantity !== quantity) {
    fail(`${name} reports a complete fill for a partial quantity.`);
  }
  if (outcome === "partially_filled" && fill !== null && fill.filled_quantity >= quantity) {
    fail(`${name} reports a partial fill for the whole quantity.`);
  }

  // An ambiguous commit is never resolved by assumption — it must be pending or
  // explicitly reconciled against venue truth.
  if (outcome === "ambiguous" && reconciliation === "not_required") {
    fail(`${name} cannot mark an ambiguous commit as needing no reconciliation.`);
  }

  const reason = raw.reason === null ? null : text(raw.reason, `${name} reason`, 200);
  if ((outcome === "refused" || outcome === "ambiguous") && reason === null) {
    fail(`${name} must explain a refused or ambiguous outcome.`);
  }

  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, EXECUTION_RECEIPT_SCHEMA, name) as typeof EXECUTION_RECEIPT_SCHEMA,
    request_id: ident(raw.request_id, `${name} request id`),
    intent_id: ident(raw.intent_id, `${name} intent id`),
    approval_id: ident(raw.approval_id, `${name} approval id`),
    outcome,
    opaque_order_ref: nullable(raw.opaque_order_ref, `${name} order reference`, (v, n) => opaqueRef(v, n)),
    opaque_account_ref: opaqueRef(raw.opaque_account_ref, `${name} opaque account reference`),
    symbol: tickerSymbol(raw.symbol, `${name} symbol`),
    side: choice(raw.side, ORDER_SIDES, `${name} side`),
    quantity,
    order_type: choice(raw.order_type, ORDER_TYPES, `${name} order type`),
    activation_id: ident(raw.activation_id, `${name} activation`),
    artifact_id: ident(raw.artifact_id, `${name} artifact`),
    evidence_digest: digest(raw.evidence_digest, `${name} evidence digest`),
    client_principal: ident(raw.client_principal, `${name} client principal`),
    grant_id: ident(raw.grant_id, `${name} grant id`),
    submitted_at: nullable(raw.submitted_at, `${name} submitted_at`, (v, n) => timestamp(v, n)),
    settled_at: nullable(raw.settled_at, `${name} settled_at`, (v, n) => timestamp(v, n)),
    fill,
    reconciliation_state: reconciliation,
    reason,
  });
}

/**
 * Whether a receipt describes an outcome that must NOT be retried. Spec 1
 * section 16: "Connection loss after commit may have started — never retry;
 * enter reconciliation."
 */
export function forbidsRetry(receipt: ExecutionReceiptV1): boolean {
  return receipt.outcome === "ambiguous" || receipt.submitted_at !== null;
}
