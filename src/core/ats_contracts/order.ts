// NormalizedEquityOrderIntentV1 and BrokerOrderReviewReceiptV1 — Spec 1
// sections 11.4 and 11.5.
//
// An intent is what a model may PROPOSE. A review receipt is what ATSv2
// answers after risk, limits and a broker preview have run. Neither commits
// anything: Spec 1 section 7.3 is explicit that ats_broker_review_order
// "produces an immutable review and pending-approval request. It never
// commits."
//
// This is an ATS-private, fully bound intent, not the model input. The model
// may submit only the closed model order proposal in proposal.ts (`/1`, or
// `/2` for an executable chain); ATSv2 must inject provider, account, grant,
// device and runtime identity after authentication.

import {
  choice,
  closed,
  digest,
  equityTicker,
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
  type FieldCheck,
  type Retagged,
} from "./primitives.js";
import {
  EXECUTION_ENVIRONMENTS,
  validateExecutionState,
  type ExecutionEnvironment,
  type RequestedEffectiveExecutionStateV1,
} from "./mode.js";
import {
  ORDER_SIDES,
  ORDER_TYPES,
  validateGrantUsage,
  type GrantUsage,
  type OrderSide,
  type OrderType,
} from "./grant.js";

export const ORDER_INTENT_SCHEMA = "aether.ats.equity-order-intent/1" as const;
/** Frozen `/1` admits URL-shaped symbols; `/2` requires an equity ticker. */
export const ORDER_INTENT_SCHEMA_V2 = "aether.ats.equity-order-intent/2" as const;
/**
 * The review receipt has one version. It carries no ticker and no masked
 * label, and its `intent_digest` covers the intent's schema tag, so a review
 * answers exactly one intent version (docs/CONTRACTS.md, "Spec 1 `/2` closure").
 */
export const ORDER_REVIEW_SCHEMA = "aether.ats.order-review-receipt/1" as const;

/**
 * The market evidence an intent is pinned to. References, not values: the
 * canonical price lives in ATSv2's evidence store, and Spec 1 section 15 bars
 * a screenshot, chat message or model statement from ever being the source.
 */
export interface MarketEvidenceRef {
  readonly market_snapshot_ref: string;
  readonly broker_quote_ref: string;
  readonly evidence_digest: string;
  readonly observed_at: string;
}

const EVIDENCE_FIELDS = ["market_snapshot_ref", "broker_quote_ref", "evidence_digest", "observed_at"] as const;

export function validateMarketEvidence(value: unknown, name = "Market evidence"): MarketEvidenceRef {
  const raw = closed(value, name, EVIDENCE_FIELDS);
  return Object.freeze({
    market_snapshot_ref: ident(raw.market_snapshot_ref, `${name} snapshot reference`),
    broker_quote_ref: ident(raw.broker_quote_ref, `${name} quote reference`),
    evidence_digest: digest(raw.evidence_digest, `${name} digest`),
    observed_at: timestamp(raw.observed_at, `${name} observed_at`),
  });
}

/**
 * Which provider, which account binding, which adapter, at which pinned
 * schema, in which environment.
 *
 * `provider_id` and `account_binding_id` are here because an earlier revision
 * carried only `binding_generation`, which cannot distinguish two different
 * accounts: both are generation 1 the day they are linked. A chain check that
 * compared generation alone would accept an approval minted for one account
 * against a commit aimed at another.
 */
export interface ConnectorBindingRef {
  readonly provider_id: string;
  readonly account_binding_id: string;
  readonly adapter_id: string;
  readonly endpoint_schema_digest: string;
  readonly execution_environment: ExecutionEnvironment;
  readonly binding_generation: number;
}

const CONNECTOR_REF_FIELDS = [
  "provider_id",
  "account_binding_id",
  "adapter_id",
  "endpoint_schema_digest",
  "execution_environment",
  "binding_generation",
] as const;

export function validateConnectorBindingRef(value: unknown, name = "Connector binding"): ConnectorBindingRef {
  const raw = closed(value, name, CONNECTOR_REF_FIELDS);
  return Object.freeze({
    provider_id: ident(raw.provider_id, `${name} provider`),
    account_binding_id: opaqueRef(raw.account_binding_id, `${name} account binding id`),
    adapter_id: ident(raw.adapter_id, `${name} adapter`),
    endpoint_schema_digest: digest(raw.endpoint_schema_digest, `${name} endpoint schema digest`),
    execution_environment: choice(raw.execution_environment, EXECUTION_ENVIRONMENTS, `${name} execution environment`),
    binding_generation: integer(raw.binding_generation, `${name} generation`, 1, Number.MAX_SAFE_INTEGER),
  });
}

/**
 * Every fact a preview, an approval and a commit must agree on (Spec 1 section
 * 11.6). Compared as a unit, and derived from the field list rather than
 * written out by hand, so adding a field to `ConnectorBindingRef` cannot leave
 * this comparison silently checking the old set.
 */
export function connectorBindingMatches(a: ConnectorBindingRef, b: ConnectorBindingRef): boolean {
  return CONNECTOR_REF_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * Build the reference an intent carries from the authoritative binding. Using
 * this rather than hand-assembling a ref is what keeps `account_binding_id`
 * and `binding_generation` agreeing with the record they came from.
 */
export function connectorRefFromBinding(
  binding: { account_binding_id: string; provider_id: string; binding_generation: number },
  adapter: { adapter_id: string; endpoint_schema_digest: string; execution_environment: ExecutionEnvironment },
): ConnectorBindingRef {
  return Object.freeze({
    provider_id: binding.provider_id,
    account_binding_id: binding.account_binding_id,
    adapter_id: adapter.adapter_id,
    endpoint_schema_digest: adapter.endpoint_schema_digest,
    execution_environment: adapter.execution_environment,
    binding_generation: binding.binding_generation,
  });
}

export interface NormalizedEquityOrderIntentV1 {
  readonly schema_version: typeof ORDER_INTENT_SCHEMA;
  readonly intent_id: string;
  readonly request_id: string;
  readonly connector: ConnectorBindingRef;
  /** The activated strategy artifact this order came from. Never synthetic. */
  readonly activation_id: string;
  readonly artifact_id: string;
  readonly symbol: string;
  readonly side: OrderSide;
  /** Whole shares only. Fractional is out of scope (Spec 1 section 13). */
  readonly quantity: number;
  readonly order_type: OrderType;
  /** Minor units. Required for a limit order, null for a market order. */
  readonly limit_price_minor: number | null;
  readonly evidence: MarketEvidenceRef;
  readonly created_at: string;
  readonly expires_at: string;
}

/** Same fields as `/1`; only the symbol check is stricter (`equityTicker()`). */
export interface NormalizedEquityOrderIntentV2 extends Omit<NormalizedEquityOrderIntentV1, "schema_version"> {
  readonly schema_version: typeof ORDER_INTENT_SCHEMA_V2;
}

const INTENT_FIELDS = [
  "schema_version",
  "intent_id",
  "request_id",
  "connector",
  "activation_id",
  "artifact_id",
  "symbol",
  "side",
  "quantity",
  "order_type",
  "limit_price_minor",
  "evidence",
  "created_at",
  "expires_at",
] as const;

export function validateOrderIntent(value: unknown, name = "Order intent"): NormalizedEquityOrderIntentV1 {
  return orderIntent(value, name, ORDER_INTENT_SCHEMA, tickerSymbol);
}

/** `/2`: the `/1` intent, except that the symbol must be an equity ticker. */
export function validateOrderIntentV2(value: unknown, name = "Order intent"): NormalizedEquityOrderIntentV2 {
  return orderIntent(value, name, ORDER_INTENT_SCHEMA_V2, equityTicker);
}

/** One body for both versions; only the schema tag and the ticker check vary. */
function orderIntent<S extends string>(
  value: unknown,
  name: string,
  schema: S,
  ticker: FieldCheck,
): Retagged<NormalizedEquityOrderIntentV1, S> {
  const raw = closed(value, name, INTENT_FIELDS);
  const createdAt = timestamp(raw.created_at, `${name} created_at`);
  const expiresAt = timestamp(raw.expires_at, `${name} expires_at`);
  orderedWindow(createdAt, expiresAt, `${name} validity window`);

  const orderType = choice(raw.order_type, ORDER_TYPES, `${name} order type`);
  const limitPrice = nullable(raw.limit_price_minor, `${name} limit price`, (v, n) => minorUnits(v, n));

  // A limit order without a price, or a market order carrying one, is an
  // ambiguous instruction. Refuse rather than guess which field the caller
  // meant — the guess would be the price someone gets filled at.
  if (orderType === "limit" && limitPrice === null) fail(`${name} limit order requires a limit price.`);
  if (orderType === "market" && limitPrice !== null) fail(`${name} market order must not carry a limit price.`);
  if (limitPrice !== null && limitPrice <= 0) fail(`${name} limit price must be above zero.`);

  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, schema, name) as S,
    intent_id: ident(raw.intent_id, `${name} id`),
    request_id: ident(raw.request_id, `${name} request id`),
    connector: validateConnectorBindingRef(raw.connector, `${name} connector`),
    activation_id: ident(raw.activation_id, `${name} activation`),
    artifact_id: ident(raw.artifact_id, `${name} artifact`),
    symbol: ticker(raw.symbol, `${name} symbol`),
    side: choice(raw.side, ORDER_SIDES, `${name} side`),
    quantity: integer(raw.quantity, `${name} quantity`, 1, 1_000_000),
    order_type: orderType,
    limit_price_minor: limitPrice,
    evidence: validateMarketEvidence(raw.evidence, `${name} evidence`),
    created_at: createdAt,
    expires_at: expiresAt,
  });
}

export const RISK_VERDICTS = ["pass", "refuse"] as const;
export type RiskVerdict = (typeof RISK_VERDICTS)[number];

export interface BrokerOrderReviewReceiptV1 {
  readonly schema_version: typeof ORDER_REVIEW_SCHEMA;
  readonly review_id: string;
  readonly request_id: string;
  /** Digest of the exact intent this review answers. */
  readonly intent_digest: string;
  readonly connector: ConnectorBindingRef;
  readonly grant_id: string;
  readonly grant_version: number;
  readonly usage: GrantUsage;
  readonly reservation_ref: string;
  readonly reservation_expires_at: string;
  readonly risk_verdict: RiskVerdict;
  readonly risk_reason: string | null;
  readonly broker_preview_id: string;
  readonly broker_preview_digest: string;
  readonly evidence: MarketEvidenceRef;
  readonly evidence_age_ms: number;
  readonly worst_case_notional_minor: number;
  readonly approval_deadline: string;
  readonly execution_state: RequestedEffectiveExecutionStateV1;
  readonly recorded_at: string;
}

const REVIEW_FIELDS = [
  "schema_version",
  "review_id",
  "request_id",
  "intent_digest",
  "connector",
  "grant_id",
  "grant_version",
  "usage",
  "reservation_ref",
  "reservation_expires_at",
  "risk_verdict",
  "risk_reason",
  "broker_preview_id",
  "broker_preview_digest",
  "evidence",
  "evidence_age_ms",
  "worst_case_notional_minor",
  "approval_deadline",
  "execution_state",
  "recorded_at",
] as const;

export function validateOrderReview(value: unknown, name = "Order review"): BrokerOrderReviewReceiptV1 {
  const raw = closed(value, name, REVIEW_FIELDS);
  const recordedAt = timestamp(raw.recorded_at, `${name} recorded_at`);
  const reservationExpiresAt = timestamp(raw.reservation_expires_at, `${name} reservation expiry`);
  const approvalDeadline = timestamp(raw.approval_deadline, `${name} approval deadline`);
  orderedWindow(recordedAt, reservationExpiresAt, `${name} reservation window`);
  orderedWindow(recordedAt, approvalDeadline, `${name} approval window`);

  // Spec 1 section 11.6: an approval expires no later than the preview or the
  // reservation. If the deadline outlived the reservation, an operator could
  // approve an order whose capacity had already been released to someone else.
  if (Date.parse(approvalDeadline) > Date.parse(reservationExpiresAt)) {
    fail(`${name} approval deadline cannot outlive its reservation.`);
  }

  const verdict = choice(raw.risk_verdict, RISK_VERDICTS, `${name} risk verdict`);
  const reason = raw.risk_reason === null ? null : text(raw.risk_reason, `${name} risk reason`, 200);
  if (verdict === "refuse" && reason === null) fail(`${name} must explain a refusing risk verdict.`);

  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, ORDER_REVIEW_SCHEMA, name) as typeof ORDER_REVIEW_SCHEMA,
    review_id: ident(raw.review_id, `${name} id`),
    request_id: ident(raw.request_id, `${name} request id`),
    intent_digest: digest(raw.intent_digest, `${name} intent digest`),
    connector: validateConnectorBindingRef(raw.connector, `${name} connector`),
    grant_id: ident(raw.grant_id, `${name} grant id`),
    grant_version: integer(raw.grant_version, `${name} grant version`, 1, Number.MAX_SAFE_INTEGER),
    usage: validateGrantUsage(raw.usage, `${name} usage`),
    reservation_ref: ident(raw.reservation_ref, `${name} reservation reference`),
    reservation_expires_at: reservationExpiresAt,
    risk_verdict: verdict,
    risk_reason: reason,
    broker_preview_id: ident(raw.broker_preview_id, `${name} preview id`),
    broker_preview_digest: digest(raw.broker_preview_digest, `${name} preview digest`),
    evidence: validateMarketEvidence(raw.evidence, `${name} evidence`),
    evidence_age_ms: integer(raw.evidence_age_ms, `${name} evidence age`, 0, 86_400_000),
    worst_case_notional_minor: minorUnits(raw.worst_case_notional_minor, `${name} worst case notional`),
    approval_deadline: approvalDeadline,
    execution_state: validateExecutionState(raw.execution_state, `${name} execution state`),
    recorded_at: recordedAt,
  });
}

export type ReviewApprovability =
  | { readonly approvable: true }
  | { readonly approvable: false; readonly reason: string };

/**
 * Whether a review may still be approved. Separate from validation because a
 * receipt does not become malformed when it goes stale — it stays a true record
 * of a review that can no longer be acted on.
 */
export function isReviewApprovable(
  review: BrokerOrderReviewReceiptV1,
  nowMs: number = Date.now(),
): ReviewApprovability {
  if (review.risk_verdict !== "pass") return { approvable: false, reason: "Risk review refused this order." };
  if (nowMs >= Date.parse(review.approval_deadline)) return { approvable: false, reason: "Approval window expired." };
  if (nowMs >= Date.parse(review.reservation_expires_at)) return { approvable: false, reason: "Reservation expired." };
  return { approvable: true };
}
