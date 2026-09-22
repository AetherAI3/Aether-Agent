// BrokerConnectorCapabilityV1 and BrokerAccountBindingV1 — Spec 1 sections
// 11.1 and 11.2.
//
// Two rules from the spec are enforced here rather than left to reviewers:
//
//   1. "Implementation support is not permission." A capability snapshot
//      describes what an adapter CAN do. It carries `grants_execution_authority`
//      pinned to false, and the validator refuses any other value, so a
//      capability document can never be mistaken for a grant.
//
//   2. "Only the opaque reference, provider identifier, and bounded masked
//      label may leave ATS." A binding is a LOCAL-ONLY record; the exported
//      subset is produced by redactBindingForExport() below, which is the only
//      supported way to move binding data toward Agent or Cloud.

import {
  bool,
  choice,
  closed,
  digest,
  fail,
  ident,
  integer,
  nullable,
  opaqueRef,
  orderedWindow,
  pinned,
  schemaTag,
  text,
  timestamp,
  uniqueList,
} from "./primitives.js";
import { validateExecutionState, type RequestedEffectiveExecutionStateV1 } from "./mode.js";

export const CONNECTOR_CAPABILITY_SCHEMA = "aether.ats.connector-capability/1" as const;
export const ACCOUNT_BINDING_SCHEMA = "aether.ats.account-binding/1" as const;

/**
 * The fixed normalized operations the execution layer may name (Spec 1 section
 * 6.2). A provider tool name such as `place_equity_order` is NOT in this list
 * and never becomes one: adapters map provider surfaces onto these, so a
 * renamed or newly appearing provider tool cannot reach a caller.
 */
export const NORMALIZED_OPERATIONS = [
  "capabilities",
  "quote",
  "positions",
  "orders_history",
  "balances",
  "prepare_order",
  "commit_approved_order",
  "lookup_order",
  "reconcile_order",
] as const;
export type NormalizedOperation = (typeof NORMALIZED_OPERATIONS)[number];

/**
 * Asset classes this freeze admits. Options, crypto, fractional, short and
 * margin are out of scope for the release (Spec 1 section 13) and are absent
 * rather than present-and-disabled, so adding one is a visible schema change.
 */
export const ASSET_CLASSES = ["equity"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const AUTHENTICATION_MODES = ["oauth2_pkce", "oauth2_dcr_pkce", "api_key_vault"] as const;
export type AuthenticationMode = (typeof AUTHENTICATION_MODES)[number];

/**
 * Implementation-support flags. These say "this adapter has code for X", never
 * "this adapter may do X now" — permission lives in the grant plus the
 * effective execution state.
 */
export interface ConnectorImplementationSupport {
  readonly read: boolean;
  readonly review: boolean;
  readonly paper: boolean;
  readonly live: boolean;
}

export interface BrokerConnectorCapabilityV1 {
  readonly schema_version: typeof CONNECTOR_CAPABILITY_SCHEMA;
  readonly provider_id: string;
  readonly adapter_id: string;
  readonly adapter_version: string;
  /** Digest of the endpoint identity the adapter is pinned to. */
  readonly endpoint_identity_digest: string;
  /** Digest of the provider tool catalog or API schema snapshot. */
  readonly tool_catalog_digest: string;
  readonly supported_operations: readonly NormalizedOperation[];
  readonly supported_asset_classes: readonly AssetClass[];
  readonly authentication_mode: AuthenticationMode;
  readonly implementation_support: ConnectorImplementationSupport;
  readonly execution_state: RequestedEffectiveExecutionStateV1;
  readonly observed_at: string;
  readonly expires_at: string;
  /** Pinned false. A capability document is evidence, never authority. */
  readonly grants_execution_authority: false;
}

const CAPABILITY_FIELDS = [
  "schema_version",
  "provider_id",
  "adapter_id",
  "adapter_version",
  "endpoint_identity_digest",
  "tool_catalog_digest",
  "supported_operations",
  "supported_asset_classes",
  "authentication_mode",
  "implementation_support",
  "execution_state",
  "observed_at",
  "expires_at",
  "grants_execution_authority",
] as const;

const SUPPORT_FIELDS = ["read", "review", "paper", "live"] as const;

function validateSupport(value: unknown, name: string): ConnectorImplementationSupport {
  const raw = closed(value, name, SUPPORT_FIELDS);
  const support = {
    read: bool(raw.read, `${name} read support`),
    review: bool(raw.review, `${name} review support`),
    paper: bool(raw.paper, `${name} paper support`),
    live: bool(raw.live, `${name} live support`),
  };
  // Support is layered: reviewing an order you cannot read the account for, or
  // committing one you cannot review, describes an adapter that cannot exist.
  // Catching it here stops a malformed snapshot from advertising a capability
  // the connector could never honour.
  if (support.review && !support.read) fail(`${name} cannot support review without reads.`);
  if (support.paper && !support.review) fail(`${name} cannot support paper commits without review.`);
  if (support.live && !support.review) fail(`${name} cannot support live commits without review.`);
  return Object.freeze(support);
}

export function validateConnectorCapability(
  value: unknown,
  name = "Connector capability",
): BrokerConnectorCapabilityV1 {
  const raw = closed(value, name, CAPABILITY_FIELDS);
  const observedAt = timestamp(raw.observed_at, `${name} observed_at`);
  const expiresAt = timestamp(raw.expires_at, `${name} expires_at`);
  orderedWindow(observedAt, expiresAt, `${name} observation window`);

  const operations = uniqueList(
    raw.supported_operations,
    `${name} operations`,
    NORMALIZED_OPERATIONS.length,
    (v, n) => choice(v, NORMALIZED_OPERATIONS, n),
  );
  if (!operations.includes("capabilities")) fail(`${name} must support the capabilities operation.`);

  return Object.freeze({
    schema_version: schemaTag(
      raw.schema_version,
      CONNECTOR_CAPABILITY_SCHEMA,
      name,
    ) as typeof CONNECTOR_CAPABILITY_SCHEMA,
    provider_id: ident(raw.provider_id, `${name} provider`),
    adapter_id: ident(raw.adapter_id, `${name} adapter`),
    adapter_version: text(raw.adapter_version, `${name} adapter version`, 64),
    endpoint_identity_digest: digest(raw.endpoint_identity_digest, `${name} endpoint digest`),
    tool_catalog_digest: digest(raw.tool_catalog_digest, `${name} tool catalog digest`),
    supported_operations: Object.freeze(operations),
    supported_asset_classes: Object.freeze(
      uniqueList(raw.supported_asset_classes, `${name} asset classes`, ASSET_CLASSES.length, (v, n) =>
        choice(v, ASSET_CLASSES, n),
      ),
    ),
    authentication_mode: choice(raw.authentication_mode, AUTHENTICATION_MODES, `${name} authentication mode`),
    implementation_support: validateSupport(raw.implementation_support, `${name} implementation support`),
    execution_state: validateExecutionState(raw.execution_state, `${name} execution state`),
    observed_at: observedAt,
    expires_at: expiresAt,
    grants_execution_authority: pinned(raw.grants_execution_authority, false, `${name} execution authority`),
  });
}

/** A capability snapshot is evidence only while fresh. */
export function isCapabilityExpired(capability: BrokerConnectorCapabilityV1, nowMs: number = Date.now()): boolean {
  return nowMs >= Date.parse(capability.expires_at);
}

/**
 * A masked account label such as `Agentic ****41`. The validator caps the run
 * of consecutive digits at four so a "label" cannot carry a full account number
 * past the redaction boundary.
 */
function maskedLabel(value: unknown, name: string): string {
  const label = text(value, name, 64);
  if (/\d{5,}/.test(label)) fail(`${name} must not embed a full account number.`);
  return label;
}

export interface BrokerAccountBindingV1 {
  readonly schema_version: typeof ACCOUNT_BINDING_SCHEMA;
  readonly provider_id: string;
  /** Reference into the ATS connector vault. Never a credential value. */
  readonly credential_ref: string;
  /** Reference to the encrypted provider account id. Never the id itself. */
  readonly encrypted_account_ref: string;
  /** The only account identifier permitted outside the connector core. */
  readonly opaque_account_ref: string;
  readonly masked_label: string;
  readonly asset_capabilities: readonly AssetClass[];
  readonly connector_snapshot_digest: string;
  readonly selected_at: string;
  /**
   * Incremented on every unlink or re-bind. Spec 1 section 11.6 requires a
   * preview, an approval and a commit to name the same generation, so a
   * re-linked account cannot silently inherit an approval minted for the old
   * one.
   */
  readonly binding_generation: number;
}

const BINDING_FIELDS = [
  "schema_version",
  "provider_id",
  "credential_ref",
  "encrypted_account_ref",
  "opaque_account_ref",
  "masked_label",
  "asset_capabilities",
  "connector_snapshot_digest",
  "selected_at",
  "binding_generation",
] as const;

export function validateAccountBinding(value: unknown, name = "Account binding"): BrokerAccountBindingV1 {
  const raw = closed(value, name, BINDING_FIELDS);
  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, ACCOUNT_BINDING_SCHEMA, name) as typeof ACCOUNT_BINDING_SCHEMA,
    provider_id: ident(raw.provider_id, `${name} provider`),
    credential_ref: opaqueRef(raw.credential_ref, `${name} credential reference`),
    encrypted_account_ref: opaqueRef(raw.encrypted_account_ref, `${name} encrypted account reference`),
    opaque_account_ref: opaqueRef(raw.opaque_account_ref, `${name} opaque account reference`),
    masked_label: maskedLabel(raw.masked_label, `${name} masked label`),
    asset_capabilities: Object.freeze(
      uniqueList(raw.asset_capabilities, `${name} asset capabilities`, ASSET_CLASSES.length, (v, n) =>
        choice(v, ASSET_CLASSES, n),
      ),
    ),
    connector_snapshot_digest: digest(raw.connector_snapshot_digest, `${name} connector snapshot digest`),
    selected_at: timestamp(raw.selected_at, `${name} selected_at`),
    binding_generation: integer(raw.binding_generation, `${name} generation`, 1, Number.MAX_SAFE_INTEGER),
  });
}

/**
 * The exported projection of a binding — Spec 1 section 11.2: "Only the opaque
 * reference, provider identifier, and bounded masked label may leave ATS."
 *
 * This function exists so that rule is a call site rather than a code-review
 * comment. Anything heading for Agent, Cloud or a rendered surface goes through
 * here; the credential and encrypted-account references are structurally absent
 * from the result rather than blanked, so they cannot be reinstated downstream.
 */
export interface ExportedAccountBinding {
  readonly provider_id: string;
  readonly opaque_account_ref: string;
  readonly masked_label: string;
  readonly binding_generation: number;
}

export function redactBindingForExport(binding: BrokerAccountBindingV1): ExportedAccountBinding {
  return Object.freeze({
    provider_id: binding.provider_id,
    opaque_account_ref: binding.opaque_account_ref,
    masked_label: binding.masked_label,
    binding_generation: binding.binding_generation,
  });
}

/** Connector status for an operator surface; renders the masked label only. */
export function connectorStatusLine(
  capability: BrokerConnectorCapabilityV1,
  binding: BrokerAccountBindingV1 | null,
  nowMs: number = Date.now(),
): string {
  const account = binding ? redactBindingForExport(binding).masked_label : "not bound";
  const freshness = isCapabilityExpired(capability, nowMs) ? "stale" : "fresh";
  return `${capability.provider_id} · account ${account} · snapshot ${freshness}`;
}

/** Parse an optional binding: a connector may be authenticated but unbound. */
export function optionalBinding(value: unknown, name = "Account binding"): BrokerAccountBindingV1 | null {
  return nullable(value, name, (v, n) => validateAccountBinding(v, n));
}
