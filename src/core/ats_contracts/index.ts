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
  ASSET_CLASSES,
  AUTHENTICATION_MODES,
  CONNECTOR_CAPABILITY_SCHEMA,
  NORMALIZED_OPERATIONS,
  connectorStatusLine,
  isCapabilityExpired,
  optionalBinding,
  redactBindingForExport,
  validateAccountBinding,
  validateConnectorCapability,
  type AssetClass,
  type AuthenticationMode,
  type BrokerAccountBindingV1,
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
  grantPermits,
  validateGrantUsage,
  validateTradingGrant,
  type DelegatedTradingGrantV1,
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
  ORDER_REVIEW_SCHEMA,
  RISK_VERDICTS,
  connectorBindingMatches,
  connectorRefFromBinding,
  isReviewApprovable,
  validateConnectorBindingRef,
  validateMarketEvidence,
  validateOrderIntent,
  validateOrderReview,
  type BrokerOrderReviewReceiptV1,
  type ConnectorBindingRef,
  type MarketEvidenceRef,
  type NormalizedEquityOrderIntentV1,
  type ReviewApprovability,
  type RiskVerdict,
} from "./order.js";

export {
  EXECUTION_OUTCOMES,
  EXECUTION_RECEIPT_SCHEMA,
  OPERATOR_APPROVAL_SCHEMA,
  RECONCILIATION_STATES,
  forbidsRetry,
  isApprovalUsable,
  validateExecutionReceipt,
  validateOperatorApproval,
  verifyApprovalChain,
  verifyCommitAuthority,
  type ApprovalUsability,
  type BrokerConfirmedFill,
  type ChainVerdict,
  type CommitAuthorityRequest,
  type ExecutionOutcome,
  type ExecutionReceiptV1,
  type OperatorApprovalReceiptV1,
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
export * from "./proposal.js";
export * from "./browser_order.js";
export * from "./browser_order_result.js";
export * from "./browser_order_gate.js";
