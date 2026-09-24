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
//
// The `/2` successors (same fields, strict equity ticker) share each `/1`
// validator body. Only verifyExecutableCommitAuthority() may authorize an
// executable order: it admits nothing but a `/2` chain, re-validates every
// member and input before deciding, and decides on the re-validated copies.
// The `/1` gates are kept, version-blind as they always were, for historical
// records.

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
import { digestEquals, digestOf } from "./canonical.js";
import { isHalted, permitsOrderSubmission } from "./mode.js";
import {
  ACCOUNT_BINDING_SCHEMA_V2,
  validateAccountBindingV2,
  type BrokerAccountBindingV1,
  type BrokerAccountBindingV2,
} from "./connector.js";
import {
  grantPermits,
  ORDER_SIDES,
  ORDER_TYPES,
  TRADING_GRANT_SCHEMA_V2,
  validateGrantUsage,
  validateTradingGrantV2,
  type DelegatedTradingGrantV1,
  type DelegatedTradingGrantV2,
  type GrantUsage,
  type OrderSide,
  type OrderType,
} from "./grant.js";
import {
  connectorBindingMatches,
  isReviewApprovable,
  ORDER_INTENT_SCHEMA_V2,
  validateConnectorBindingRef,
  validateOrderIntentV2,
  validateOrderReview,
  type BrokerOrderReviewReceiptV1,
  type ConnectorBindingRef,
  type NormalizedEquityOrderIntentV1,
  type NormalizedEquityOrderIntentV2,
} from "./order.js";

export const OPERATOR_APPROVAL_SCHEMA = "aether.ats.operator-approval/1" as const;
/** Frozen `/1` admits URL-shaped symbols; `/2` requires an equity ticker. */
export const OPERATOR_APPROVAL_SCHEMA_V2 = "aether.ats.operator-approval/2" as const;
export const EXECUTION_RECEIPT_SCHEMA = "aether.ats.execution-receipt/1" as const;
/** Frozen `/1` admits URL-shaped symbols; `/2` requires an equity ticker. */
export const EXECUTION_RECEIPT_SCHEMA_V2 = "aether.ats.execution-receipt/2" as const;

/**
 * The two refusals the executable gates add. Fixed text, never parameterized,
 * so a caller can match them exactly and no document content reaches them.
 *
 * The version refusal names the four members that have a `/2`; the review
 * receipt has one version and is bound to its intent by digest.
 */
export const EXECUTABLE_CHAIN_REFUSAL =
  "Only an order chain whose intent, approval, account binding and grant are all /2 may authorize an executable order; any /1 member makes it a historical record." as const;

/**
 * A chain whose tags all say `/2` but whose content the gate cannot re-validate:
 * a `/1` document retagged in code, a document that was never validated, or an
 * input (usage, clock, resulting position) that is not a well-formed value.
 */
export const EXECUTABLE_MEMBER_REFUSAL =
  "An executable order chain member failed re-validation; only freshly validated /2 documents and well-formed inputs may authorize an order." as const;

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

/** Same fields as `/1`; only the symbol check is stricter (`equityTicker()`). */
export interface OperatorApprovalReceiptV2 extends Omit<OperatorApprovalReceiptV1, "schema_version"> {
  readonly schema_version: typeof OPERATOR_APPROVAL_SCHEMA_V2;
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
  return operatorApproval(value, name, OPERATOR_APPROVAL_SCHEMA, tickerSymbol);
}

/** `/2`: the `/1` approval, except that the restated symbol must be an equity ticker. */
export function validateOperatorApprovalV2(value: unknown, name = "Operator approval"): OperatorApprovalReceiptV2 {
  return operatorApproval(value, name, OPERATOR_APPROVAL_SCHEMA_V2, equityTicker);
}

/** One body for both versions; only the schema tag and the ticker check vary. */
function operatorApproval<S extends string>(
  value: unknown,
  name: string,
  schema: S,
  ticker: FieldCheck,
): Retagged<OperatorApprovalReceiptV1, S> {
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
    schema_version: schemaTag(raw.schema_version, schema, name) as S,
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
    symbol: ticker(raw.symbol, `${name} symbol`),
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
export function isApprovalUsable(
  approval: OperatorApprovalReceiptV1 | OperatorApprovalReceiptV2,
  nowMs: number = Date.now(),
): ApprovalUsability {
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
 * The digests are COMPUTED HERE from the intent and review themselves. An
 * earlier revision accepted an `intentDigest` argument from the caller, which
 * meant the check proved only that three documents agreed about a number the
 * attacker supplied — a forged intent plus a matching digest sailed through.
 * The inputs must be the validated, frozen objects the validators return;
 * digesting a raw payload would canonicalize a different key set.
 *
 * Returns a verdict rather than repairing anything, and every caller must
 * treat `consistent: false` as terminal. The temptation on a mismatch is to
 * re-run the preview and carry on; that is precisely how an approval minted
 * against a paper preview ends up authorizing a live order, so there is no
 * refresh path in this module to reach for.
 *
 * @deprecated For historical `/1` records only. It never reads a schema tag and
 * never re-validates its inputs; anything that may execute must use
 * `verifyExecutableApprovalChain()`.
 */
export function verifyApprovalChain(
  intent: NormalizedEquityOrderIntentV1,
  review: BrokerOrderReviewReceiptV1,
  approval: OperatorApprovalReceiptV1,
  nowMs: number = Date.now(),
): ChainVerdict {
  return approvalChainVerdict(intent, review, approval, nowMs);
}

/**
 * `verifyApprovalChain` for an order that may execute. It admits only a `/2`
 * intent and a `/2` approval, refusing anything else with
 * EXECUTABLE_CHAIN_REFUSAL before any other check. A tag is only a claim, so
 * it then re-validates the intent and approval with their `/2` validators, the
 * review with `validateOrderReview` and the clock as a whole number of
 * milliseconds, refusing with EXECUTABLE_MEMBER_REFUSAL if any of them fails:
 * a `/1` document retagged `/2` in code carries whatever it was validated
 * with. The verdict then runs on the re-validated copies, never on the
 * caller's objects. Past that it is the very same version-blind logic.
 *
 * The review receipt has one version: it carries no ticker or label, and its
 * `intent_digest` covers the intent's schema tag, so it can only answer the
 * `/2` intent it was minted for.
 *
 * Inputs are typed as either version on purpose. A document deserialized at
 * runtime carries whatever tag it carries, so the refusal has to be a verdict
 * this gate returns, not a guarantee the compiler was trusted to give.
 */
export function verifyExecutableApprovalChain(
  intent: NormalizedEquityOrderIntentV1 | NormalizedEquityOrderIntentV2,
  review: BrokerOrderReviewReceiptV1,
  approval: OperatorApprovalReceiptV1 | OperatorApprovalReceiptV2,
  nowMs: number = Date.now(),
): ChainVerdict {
  if (tagOf(intent) !== ORDER_INTENT_SCHEMA_V2 || tagOf(approval) !== OPERATOR_APPROVAL_SCHEMA_V2) {
    return broken(EXECUTABLE_CHAIN_REFUSAL);
  }
  let chain: { intent: NormalizedEquityOrderIntentV2; review: BrokerOrderReviewReceiptV1; approval: OperatorApprovalReceiptV2; now: number };
  try {
    chain = {
      intent: validateOrderIntentV2(intent),
      review: validateOrderReview(review),
      approval: validateOperatorApprovalV2(approval),
      now: executableClock(nowMs),
    };
  } catch {
    return broken(EXECUTABLE_MEMBER_REFUSAL);
  }
  return approvalChainVerdict(chain.intent, chain.review, chain.approval, chain.now);
}

/** A member's schema tag, or undefined for anything that is not an object. Never throws. */
function tagOf(member: unknown): unknown {
  return typeof member === "object" && member !== null ? (member as { readonly schema_version?: unknown }).schema_version : undefined;
}

/** The clock an executable gate trusts: whole milliseconds, never NaN, which would pass every expiry check. */
function executableClock(value: unknown): number {
  return integer(value, "Executable order clock", 0, Number.MAX_SAFE_INTEGER);
}

/** The chain logic both gates share. It never reads a schema tag. */
function approvalChainVerdict(
  intent: NormalizedEquityOrderIntentV1 | NormalizedEquityOrderIntentV2,
  review: BrokerOrderReviewReceiptV1,
  approval: OperatorApprovalReceiptV1 | OperatorApprovalReceiptV2,
  nowMs: number,
): ChainVerdict {
  const intentDigest = digestOf(intent);
  const reviewDigest = digestOf(review);

  if (!digestEquals(review.intent_digest, intentDigest)) return broken("Review does not answer this intent.");
  if (!digestEquals(approval.intent_digest, intentDigest)) return broken("Approval does not bind this intent.");
  if (!digestEquals(approval.review_digest, reviewDigest)) {
    return broken("Approval does not bind this exact review.");
  }
  if (approval.review_id !== review.review_id) return broken("Approval does not bind this review.");
  if (intent.request_id !== review.request_id || review.request_id !== approval.request_id) {
    return broken("Request identity differs across the chain.");
  }
  if (approval.intent_digest !== review.intent_digest) return broken("Approval and review disagree about the intent.");

  // Provider, account binding, generation, adapter, schema digest and
  // environment, compared as a unit across every hop.
  if (!connectorBindingMatches(intent.connector, review.connector)) {
    return broken("Review connector binding differs from the intent.");
  }
  if (!connectorBindingMatches(review.connector, approval.connector)) {
    return broken("Approval connector binding differs from the review.");
  }
  if (approval.provider_id !== approval.connector.provider_id) {
    return broken("Approval provider disagrees with its own connector binding.");
  }

  if (approval.grant_id !== review.grant_id || approval.grant_version !== review.grant_version) {
    return broken("Grant identity or version changed after review.");
  }
  if (approval.reservation_ref !== review.reservation_ref) return broken("Reservation changed after review.");
  if (approval.broker_preview_id !== review.broker_preview_id) return broken("Broker preview changed after review.");
  if (approval.evidence_digest !== review.evidence.evidence_digest) {
    return broken("Market evidence changed after review.");
  }
  if (approval.evidence_digest !== intent.evidence.evidence_digest) {
    return broken("Approved evidence differs from the evidence the intent was formed on.");
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

  // State of the chain, not just its shape. A structurally perfect chain over
  // a refused review or a spent approval must still refuse.
  const approvable = isReviewApprovable(review, nowMs);
  if (!approvable.approvable) return broken(approvable.reason);
  const usable = isApprovalUsable(approval, nowMs);
  if (!usable.usable) return broken(usable.reason);
  if (nowMs >= Date.parse(intent.expires_at)) return broken("Intent expired.");

  return Object.freeze({ consistent: true as const });
}

/** Everything the commit gate needs. Supplied by ATSv2, never by a model. */
export interface CommitAuthorityRequest {
  readonly now: number;
  readonly grant: DelegatedTradingGrantV1;
  readonly usage: GrantUsage;
  /** The authoritative local binding — the account that will actually be hit. */
  readonly binding: BrokerAccountBindingV1;
  readonly intent: NormalizedEquityOrderIntentV1;
  readonly review: BrokerOrderReviewReceiptV1;
  readonly approval: OperatorApprovalReceiptV1;
  /** Position notional for this symbol if the order fills, from ATSv2. */
  readonly resultingPositionNotionalMinor: number;
}

/**
 * What `verifyExecutableCommitAuthority` receives. Members are typed as either
 * version so that a `/1` or mixed chain reaches the gate and is refused there
 * with EXECUTABLE_CHAIN_REFUSAL (see `verifyExecutableApprovalChain`).
 */
export interface ExecutableCommitAuthorityRequest {
  readonly now: number;
  readonly grant: DelegatedTradingGrantV1 | DelegatedTradingGrantV2;
  readonly usage: GrantUsage;
  readonly binding: BrokerAccountBindingV1 | BrokerAccountBindingV2;
  readonly intent: NormalizedEquityOrderIntentV1 | NormalizedEquityOrderIntentV2;
  readonly review: BrokerOrderReviewReceiptV1;
  readonly approval: OperatorApprovalReceiptV1 | OperatorApprovalReceiptV2;
  readonly resultingPositionNotionalMinor: number;
}

/**
 * The gate immediately before a broker commit.
 *
 * `verifyApprovalChain` proves the three documents describe one order. This
 * additionally proves that order is aimed at the account the binding names,
 * under a grant that still permits it, in a mode that still allows submission.
 * Spec 1 section 16 requires kill and pause to win *after* review and
 * immediately before commit, so the effective-mode check lives here rather
 * than being inherited from whatever the review said minutes ago.
 *
 * @deprecated For historical `/1` records only. It never reads a schema tag and
 * never re-validates its inputs; the only gate that may authorize an
 * executable order is `verifyExecutableCommitAuthority()`.
 */
export function verifyCommitAuthority(request: CommitAuthorityRequest): ChainVerdict {
  return commitAuthorityVerdict(request);
}

/**
 * The ONLY gate that may authorize an executable order.
 *
 *   1. Version: the intent, approval, account binding and grant must all be
 *      tagged `/2`, or it refuses with EXECUTABLE_CHAIN_REFUSAL.
 *   2. Re-validation: a tag is only a claim, so every member is re-validated
 *      (the four with their `/2` validators, the review with
 *      `validateOrderReview`, the usage with `validateGrantUsage`) and the
 *      clock and resulting position notional must be whole, non-negative
 *      numbers; anything that fails refuses with EXECUTABLE_MEMBER_REFUSAL.
 *      A NaN clock would pass every expiry check and a NaN or negative
 *      position or usage every limit, so these are checked as strictly as
 *      the documents.
 *   3. Verdict: `verifyCommitAuthority`'s logic, unchanged, run on the
 *      re-validated copies rather than on the caller's objects.
 *
 * `/1` chains stay valid historical records and are never executable.
 */
export function verifyExecutableCommitAuthority(request: ExecutableCommitAuthorityRequest): ChainVerdict {
  const raw: { readonly [K in keyof ExecutableCommitAuthorityRequest]?: unknown } =
    typeof request === "object" && request !== null ? request : {};
  if (
    tagOf(raw.intent) !== ORDER_INTENT_SCHEMA_V2 ||
    tagOf(raw.approval) !== OPERATOR_APPROVAL_SCHEMA_V2 ||
    tagOf(raw.binding) !== ACCOUNT_BINDING_SCHEMA_V2 ||
    tagOf(raw.grant) !== TRADING_GRANT_SCHEMA_V2
  ) {
    return broken(EXECUTABLE_CHAIN_REFUSAL);
  }
  let revalidated: ExecutableCommitAuthorityRequest;
  try {
    revalidated = {
      now: executableClock(raw.now),
      grant: validateTradingGrantV2(raw.grant),
      usage: validateGrantUsage(raw.usage),
      binding: validateAccountBindingV2(raw.binding),
      intent: validateOrderIntentV2(raw.intent),
      review: validateOrderReview(raw.review),
      approval: validateOperatorApprovalV2(raw.approval),
      resultingPositionNotionalMinor: integer(
        raw.resultingPositionNotionalMinor,
        "Executable order resulting position notional",
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    };
  } catch {
    return broken(EXECUTABLE_MEMBER_REFUSAL);
  }
  return commitAuthorityVerdict(revalidated);
}

/** The commit logic both gates share. It never reads a schema tag. */
function commitAuthorityVerdict(request: ExecutableCommitAuthorityRequest): ChainVerdict {
  const { now, grant, usage, binding, intent, review, approval } = request;

  const chain = approvalChainVerdict(intent, review, approval, now);
  if (!chain.consistent) return chain;

  // The chain agrees with itself; does it agree with the account on disk?
  if (intent.connector.account_binding_id !== binding.account_binding_id) {
    return broken("Order is bound to a different account binding.");
  }
  if (intent.connector.provider_id !== binding.provider_id) return broken("Order provider differs from the binding.");
  if (intent.connector.binding_generation !== binding.binding_generation) {
    return broken("Account was re-linked after this order was reviewed.");
  }
  if (approval.opaque_account_ref !== binding.opaque_account_ref) {
    return broken("Approved account differs from the bound account.");
  }

  if (grant.grant_id !== review.grant_id || grant.grant_version !== review.grant_version) {
    return broken("Grant changed after review.");
  }
  if (grant.opaque_account_ref !== binding.opaque_account_ref) return broken("Grant is for a different account.");
  if (grant.provider_id !== binding.provider_id) return broken("Grant is for a different provider.");
  if (grant.execution_environment !== intent.connector.execution_environment) {
    return broken("Grant environment differs from the order environment.");
  }

  // Kill, pause and degraded modes are checked HERE, not carried over.
  const effective = review.execution_state.effective_mode;
  if (isHalted(effective)) return broken(`Execution is halted (${effective}).`);
  if (!permitsOrderSubmission(effective)) return broken(`Effective mode ${effective} does not permit submission.`);

  const decision = grantPermits(
    grant,
    {
      symbol: intent.symbol,
      side: intent.side,
      order_type: intent.order_type,
      worst_case_notional_minor: review.worst_case_notional_minor,
      resulting_position_notional_minor: request.resultingPositionNotionalMinor,
      execution_environment: intent.connector.execution_environment,
    },
    usage,
    now,
  );
  if (!decision.allowed) return broken(decision.reason);

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

/** Same fields as `/1`; only the symbol check is stricter (`equityTicker()`). */
export interface ExecutionReceiptV2 extends Omit<ExecutionReceiptV1, "schema_version"> {
  readonly schema_version: typeof EXECUTION_RECEIPT_SCHEMA_V2;
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
  return executionReceipt(value, name, EXECUTION_RECEIPT_SCHEMA, tickerSymbol);
}

/** `/2`: the `/1` receipt, except that the symbol must be an equity ticker. */
export function validateExecutionReceiptV2(value: unknown, name = "Execution receipt"): ExecutionReceiptV2 {
  return executionReceipt(value, name, EXECUTION_RECEIPT_SCHEMA_V2, equityTicker);
}

/** One body for both versions; only the schema tag and the ticker check vary. */
function executionReceipt<S extends string>(
  value: unknown,
  name: string,
  schema: S,
  ticker: FieldCheck,
): Retagged<ExecutionReceiptV1, S> {
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
    schema_version: schemaTag(raw.schema_version, schema, name) as S,
    request_id: ident(raw.request_id, `${name} request id`),
    intent_id: ident(raw.intent_id, `${name} intent id`),
    approval_id: ident(raw.approval_id, `${name} approval id`),
    outcome,
    opaque_order_ref: nullable(raw.opaque_order_ref, `${name} order reference`, (v, n) => opaqueRef(v, n)),
    opaque_account_ref: opaqueRef(raw.opaque_account_ref, `${name} opaque account reference`),
    symbol: ticker(raw.symbol, `${name} symbol`),
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
export function forbidsRetry(receipt: ExecutionReceiptV1 | ExecutionReceiptV2): boolean {
  return receipt.outcome === "ambiguous" || receipt.submitted_at !== null;
}
