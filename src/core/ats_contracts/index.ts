// The frozen ATS trading contracts — Spec 1 Gate 1.0 (shared schema freeze).
//
// This barrel is the supported import surface. Nothing in this directory opens
// a socket, reads a file, holds a credential or places an order: these are
// shapes, validators and pure decision functions only. Gate 1.0 lands with "no
// connector write path enabled", and keeping the module I/O-free is what makes
// that claim checkable rather than asserted.
//
// The Spec 2 runtime, data, strategy and journal contracts are a separate lane
// and land alongside these under the same directory.
//
// The Spec 1 `/2` closure (ATS_SPEC1_V2_SCHEMAS) re-versions every document
// whose `/1` validator used the weak ticker or masked label. Only a `/2` chain
// can pass verifyExecutableCommitAuthority(); `/1` stays frozen as a record.

export { multilineText } from "./primitives.js";

export {
  ATS_CANONICAL_PROFILE,
  canonicalJson,
  digestEquals,
  digestOf,
  digestWithout,
  sha256CanonicalHex,
} from "./canonical.js";

export {
  EFFECTIVE_EXECUTION_MODES,
  EXECUTION_ENVIRONMENTS,
  EXECUTION_STATE_SCHEMA,
  REQUESTED_EXECUTION_MODES,
  formatExecutionState,
  isHalted,
  permitsOrderSubmission,
  validateExecutionState,
  withinRequestedAuthority,
  type EffectiveExecutionMode,
  type ExecutionEnvironment,
  type RequestedEffectiveExecutionStateV1,
  type RequestedExecutionMode,
} from "./mode.js";

export {
  ACCOUNT_BINDING_SCHEMA,
  ACCOUNT_BINDING_SCHEMA_V2,
  ASSET_CLASSES,
  AUTHENTICATION_MODES,
  CONNECTOR_CAPABILITY_SCHEMA,
  NORMALIZED_OPERATIONS,
  connectorStatusLine,
  isCapabilityExpired,
  optionalBinding,
  redactBindingForExport,
  validateAccountBinding,
  validateAccountBindingV2,
  validateConnectorCapability,
  type AssetClass,
  type AuthenticationMode,
  type BrokerAccountBindingV1,
  type BrokerAccountBindingV2,
  type BrokerConnectorCapabilityV1,
  type ConnectorImplementationSupport,
  type ExportedAccountBinding,
  type NormalizedOperation,
} from "./connector.js";

export {
  GRANT_CAPABILITIES,
  GRANT_STATES,
  ORDER_SIDES,
  ORDER_TYPES,
  TRADING_GRANT_SCHEMA,
  TRADING_GRANT_SCHEMA_V2,
  grantPermits,
  validateGrantUsage,
  validateTradingGrant,
  validateTradingGrantV2,
  type DelegatedTradingGrantV1,
  type DelegatedTradingGrantV2,
  type GrantCapability,
  type GrantCheckRequest,
  type GrantDecision,
  type GrantLimits,
  type GrantState,
  type GrantUsage,
  type OrderSide,
  type OrderType,
} from "./grant.js";

export {
  ORDER_INTENT_SCHEMA,
  ORDER_INTENT_SCHEMA_V2,
  ORDER_REVIEW_SCHEMA,
  RISK_VERDICTS,
  connectorBindingMatches,
  connectorRefFromBinding,
  isReviewApprovable,
  validateConnectorBindingRef,
  validateMarketEvidence,
  validateOrderIntent,
  validateOrderIntentV2,
  validateOrderReview,
  type BrokerOrderReviewReceiptV1,
  type ConnectorBindingRef,
  type MarketEvidenceRef,
  type NormalizedEquityOrderIntentV1,
  type NormalizedEquityOrderIntentV2,
  type ReviewApprovability,
  type RiskVerdict,
} from "./order.js";

export {
  EXECUTABLE_CHAIN_REFUSAL,
  EXECUTION_OUTCOMES,
  EXECUTION_RECEIPT_SCHEMA,
  EXECUTION_RECEIPT_SCHEMA_V2,
  OPERATOR_APPROVAL_SCHEMA,
  OPERATOR_APPROVAL_SCHEMA_V2,
  RECONCILIATION_STATES,
  forbidsRetry,
  isApprovalUsable,
  validateExecutionReceipt,
  validateExecutionReceiptV2,
  validateOperatorApproval,
  validateOperatorApprovalV2,
  verifyApprovalChain,
  verifyCommitAuthority,
  verifyExecutableApprovalChain,
  verifyExecutableCommitAuthority,
  type ApprovalUsability,
  type BrokerConfirmedFill,
  type ChainVerdict,
  type CommitAuthorityRequest,
  type ExecutableCommitAuthorityRequest,
  type ExecutionOutcome,
  type ExecutionReceiptV1,
  type ExecutionReceiptV2,
  type OperatorApprovalReceiptV1,
  type OperatorApprovalReceiptV2,
  type ReconciliationState,
} from "./approval.js";

/**
 * Every schema tag frozen by this gate, for the conformance fixture and for any
 * registry that needs to enumerate them. Kept as a literal list rather than
 * derived from the modules so a renamed tag shows up as a diff here.
 */
export const ATS_SPEC1_SCHEMAS = [
  "aether.ats.execution-state/1",
  "aether.ats.connector-capability/1",
  "aether.ats.account-binding/1",
  "aether.ats.delegated-trading-grant/1",
  "aether.ats.equity-order-intent/1",
  "aether.ats.order-review-receipt/1",
  "aether.ats.operator-approval/1",
  "aether.ats.execution-receipt/1",
] as const;

/**
 * The Spec 1 `/2` closure: every document whose `/1` validator used the weak
 * ticker or the weak masked label, re-versioned with `equityTicker()` and
 * `closedMaskedLabel()` and otherwise unchanged. The `/1` tags above stay
 * frozen and valid as historical records; only a chain of these `/2` documents
 * can pass `verifyExecutableCommitAuthority()`. The review receipt has no `/2`:
 * it carries neither field and is bound to its intent by digest.
 */
export const ATS_SPEC1_V2_SCHEMAS = [
  "aether.ats.account-binding/2",
  "aether.ats.delegated-trading-grant/2",
  "aether.ats.model-order-proposal/2",
  "aether.ats.equity-order-intent/2",
  "aether.ats.operator-approval/2",
  "aether.ats.execution-receipt/2",
] as const;
export * from "./proposal.js";
export * from "./browser_order.js";
export * from "./browser_order_result.js";
export * from "./browser_order_gate.js";
