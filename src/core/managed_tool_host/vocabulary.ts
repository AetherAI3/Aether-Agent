// Frozen vocabulary of the managed ATS tool host contract v1: schema IDs,
// closed field lists, closed enums and bounds. Data only. The schema bundle in
// contracts/managed-ats-tool-host/v1 and the Python mirror repeat every value,
// and the contract test proves the three agree.

export const COMMON_SCHEMA = "aether.managed-tool-common/1";
export const SCHEMA_BUNDLE_SCHEMA = "aether.managed-tool-schema-bundle/1";
export const TRUST_SCHEMA = "aether.managed-tool-trust/1";
export const DEVICE_PROOF_SCHEMA = "aether.managed-tool-device-proof/1";
export const HOST_OPEN_PROOF_SCHEMA = "aether.managed-tool-host-open-proof/1";
/** The host-open signing preimage prefix, distinct from the proof object's own schema. */
export const HOST_OPEN_SIGNING_SCHEMA = "aether.managed-tool-host-open/1";
export const OBSERVER_CHANNEL_PROTOCOL = "aether.ats.observer-channel/1";
export const OBSERVER_RECEIPT_SCHEMA = "aether.ats.observer-channel-receipt/1";
export const RUNTIME_CAPABILITY_SCHEMA = "aether.ats.runtime-capability/1";
export const REGISTRY_SCHEMA = "aether.managed-tool-registry/1";
export const HOST_LEASE_SCHEMA = "aether.managed-tool-host-lease/1";
export const INVOCATION_SCHEMA = "aether.managed-tool-invocation/1";
export const CANCELLATION_SCHEMA = "aether.managed-tool-cancellation/1";
export const RESULT_SCHEMA = "aether.managed-tool-result/1";
export const WORKSPACE_STATUS_INPUT_SCHEMA = "aether.ats.workspace-status-input/1";
export const WORKSPACE_STATUS_SCHEMA = "aether.ats.workspace-status/1";
export const WORKSPACE_STATUS_OPERATION = "aether.ats.workspace-status/1";
export const SCHEMA_DIGEST_SCHEMA = "aether.schema/1";
export const ARGUMENTS_SCHEMA = "aether.managed-tool-arguments/1";
export const ACCOUNT_SCOPE_SCHEMA = "aether.account-scope/1";
export const WORKSPACE_BINDING_SCHEMA = "aether.ats.workspace-status-binding/1";
export const REDACTION_PROFILE = "aether.safe-display/1";

/** Frozen schema digests of the E1 tool's input and output schema documents. */
export const WORKSPACE_STATUS_INPUT_SCHEMA_DIGEST = "sha256:04e0d3206904490a99a80e0aad06771b050e9bb63b0a66205ff6aad43108e87b";
export const WORKSPACE_STATUS_SCHEMA_DIGEST = "sha256:7b896662d6f34cc8da77c31b65cb60cdbf1018919f32a98327c239353489b7ef";
export const E1_TOOL_NAME = "ats_workspace_status";
export const E1_TOOL_VERSION = 1;
export const E1_TOOL_DEPENDENCIES = ["ats_profile", "foreground_session", "verified_account"] as const;

export const MAX_FRAME_BYTES = 262_144;
export const MAX_FRAME_DEPTH = 16;
export const MAX_ARGUMENT_DEPTH = 8;
/** A payload sits one level inside its result frame. */
export const MAX_PAYLOAD_DEPTH = MAX_FRAME_DEPTH - 1;
export const MAX_STRING_SCALARS = 256;
export const MAX_ARRAY_ENTRIES = 32;
export const MAX_SAFE = 9_007_199_254_740_991;
export const CLOCK_SKEW_MS = 30_000;
export const MAX_TRUST_LIFETIME_MS = 86_400_000;
export const MAX_DEVICE_PROOF_LIFETIME_MS = 2_592_000_000;
export const MAX_RECEIPT_LIFETIME_MS = 60_000;
export const MAX_CAPABILITY_LIFETIME_MS = 60_000;
export const MAX_REGISTRY_LIFETIME_MS = 300_000;
export const MAX_LEASE_LIFETIME_MS = 300_000;
export const MAX_TRUST_KEYS = 16;
export const MAX_TOOLS = 32;
export const MAX_TOOL_VERSION = 65_535;
export const MAX_DEPENDENCIES = 6;
export const MAX_DATA_CLASSES = 3;
export const MIN_ARGUMENT_BYTES = 2;
export const MAX_ARGUMENT_BYTES = 65_536;
export const MIN_RESULT_BYTES = 256;
export const MAX_RESULT_BYTES = 65_536;
export const MAX_DURATION_MS = 30_000;
export const MAX_CALLS = 256;
export const MAX_EVIDENCE_REFS = 16;
export const MAX_DIAGNOSTICS = 16;
export const MAX_STRATEGY_COUNT = 10_000;
export const MAX_CONFIGURED_GIB = 16_384;
export const MAX_WORKSPACE_STATUS_BYTES = 65_536;

/** Spec section 14, in order. */
export const FAILURE_CODES = [
  "TOOL_CONTRACT_INVALID", "TOOL_SCOPE_MISMATCH", "TOOL_LEASE_EXPIRED", "TOOL_LEASE_REVOKED", "TOOL_REGISTRY_MISMATCH",
  "TOOL_SEQUENCE_INVALID", "TOOL_IDEMPOTENCY_CONFLICT", "TOOL_UNKNOWN", "TOOL_ARGUMENT_INVALID", "TOOL_DEADLINE_EXCEEDED",
  "TOOL_CANCELLED", "TOOL_DEPENDENCY_UNAVAILABLE", "TOOL_RESULT_TOO_LARGE", "TOOL_DELIVERY_UNAVAILABLE",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];
export const EXECUTION_MODES = ["observe", "paper", "approve", "auto", "unknown"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export const TOOL_DEPENDENCIES = ["foreground_session", "verified_account", "ats_profile", "memory_writer", "ats_runtime", "browser_observer"] as const;
export type ToolDependency = (typeof TOOL_DEPENDENCIES)[number];
export const DATA_CLASSES = ["local_status", "ats_status", "untrusted_browser_observation"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];
export const LEASE_CAPABILITIES = ["local_read_tools"] as const;
export const CANCELLATION_REASONS = ["user_cancelled", "run_cancelled", "session_closed", "lease_revoked", "deadline_exceeded"] as const;
export const RESULT_STATES = ["succeeded", "refused", "cancelled", "deadline_exceeded", "unavailable"] as const;
export type ResultState = (typeof RESULT_STATES)[number];
export const REPLAY_STATUSES = ["fresh", "stored_redelivery", "interrupted_before_result"] as const;
export const RETRY_CLASSES = ["none", "redeliver_stored_result", "new_call_after_recovery"] as const;
export const MEMORY_STATES = ["ready", "degraded", "unavailable"] as const;
export const WRITER_LEASE_STATES = ["held", "lost", "not_held", "unavailable"] as const;
export const STRATEGY_STATES = ["scanned", "unavailable"] as const;
export const COMPILER_STATES = ["native_ats", "unavailable"] as const;
export const RESEARCH_CONFIGURATIONS = ["configured", "not_configured", "unavailable"] as const;
export const PROBE_STATES = ["fresh", "stale", "failed", "never", "unavailable"] as const;
export const BROWSER_STATES = ["available", "unavailable", "cleanup_required"] as const;
export const RUNTIME_STATES = ["ready", "degraded", "unavailable", "unknown"] as const;
export const DIAGNOSTIC_SEVERITIES = ["info", "warning", "error"] as const;

// Closed field lists, in schema order. The contract test compares each with
// its schema document's properties and required lists.
export const TRUST_FIELDS = ["schema", "generated_at", "expires_at", "keys"] as const;
export const TRUST_KEY_FIELDS = ["key_id", "algorithm", "public_key"] as const;
export const DEVICE_PROOF_FIELDS = [
  "schema", "cloud_origin_id", "account_scope_digest", "device_id", "device_public_key", "issued_at", "expires_at",
  "revocation_epoch", "signature_key_id", "proof_digest", "cloud_signature",
] as const;
export const HOST_OPEN_PROOF_FIELDS = [
  "schema", "challenge", "device_proof_digest", "agent_id", "conversation_id", "local_session_id", "session_generation",
  "registry_digest", "device_signature",
] as const;
/** The fields device_signature signs, in this order. */
export const HOST_OPEN_SIGNED_FIELDS = [
  "challenge", "device_proof_digest", "agent_id", "conversation_id", "local_session_id", "session_generation", "registry_digest",
] as const;
export const OBSERVER_RECEIPT_FIELDS = [
  "schema", "receipt_id", "channel_id", "runtime_id", "runtime_version", "runtime_build_digest", "challenge",
  "capability_digest", "issued_at", "expires_at", "authentication", "receipt_digest",
] as const;
export const RUNTIME_CAPABILITY_FIELDS = [
  "schema", "runtime_id", "runtime_version", "runtime_build_digest", "attestation_kind", "attestation_ref",
  "supported_read_operations", "effective_execution_mode", "supports_paper_execution", "supports_live_execution",
  "observed_at", "expires_at", "grants_execution_authority", "capability_digest",
] as const;
export const REGISTRY_FIELDS = [
  "schema", "registry_id", "account_scope_digest", "agent_id", "device_id", "local_session_id", "session_generation",
  "created_at", "expires_at", "tools", "grants_execution_authority", "registry_digest",
] as const;
export const TOOL_FIELDS = [
  "name", "version", "input_schema_id", "input_schema_digest", "output_schema_id", "output_schema_digest", "effect_class",
  "dependencies", "max_argument_bytes", "max_result_bytes", "max_duration_ms", "data_classes", "grants_execution_authority",
] as const;
export const HOST_LEASE_FIELDS = [
  "schema", "lease_id", "host_session_id", "cloud_origin_id", "account_scope_digest", "agent_id", "device_id",
  "local_session_id", "session_generation", "revocation_epoch", "conversation_id", "registry_digest", "issued_at",
  "expires_at", "max_calls", "capabilities", "grants_execution_authority", "signature_key_id", "cloud_signature",
] as const;
export const INVOCATION_FIELDS = [
  "schema", "request_id", "cloud_tool_call_id", "lease_id", "host_session_id", "session_generation", "revocation_epoch",
  "cloud_origin_id", "account_scope_digest", "agent_id", "device_id", "local_session_id", "conversation_id", "run_id",
  "sequence", "tool_name", "tool_version", "input_schema_id", "input_schema_digest", "arguments", "arguments_digest",
  "issued_at", "deadline_at", "nonce", "invocation_digest",
] as const;
export const CANCELLATION_FIELDS = [
  "schema", "cancellation_id", "cloud_tool_call_id", "invocation_digest", "lease_id", "host_session_id",
  "session_generation", "revocation_epoch", "reason", "issued_at", "cancellation_digest",
] as const;
export const RESULT_FIELDS = [
  "schema", "result_id", "request_id", "cloud_tool_call_id", "lease_id", "host_session_id", "local_session_id",
  "session_generation", "revocation_epoch", "run_id", "tool_name", "tool_version", "input_schema_id",
  "input_schema_digest", "invocation_digest", "arguments_digest", "state", "payload", "output_schema_id",
  "output_schema_digest", "error", "evidence_refs", "replay_status", "retry_class", "started_at", "completed_at",
  "bounded_bytes", "redaction_profile", "grants_execution_authority", "result_digest",
] as const;
export const RESULT_ERROR_FIELDS = ["code", "message"] as const;
export const WORKSPACE_BINDING_FIELDS = ["account_scope_digest", "agent_id", "device_id", "local_session_id", "session_generation"] as const;
export const WORKSPACE_STATUS_FIELDS = [
  "schema", "observed_at", "binding_digest", "local", "data", "browser", "runtime", "execution_authority",
  "orders_enabled", "grants_execution_authority", "diagnostics", "status_digest",
] as const;
export const WORKSPACE_LOCAL_FIELDS = ["memory", "strategies"] as const;
export const WORKSPACE_MEMORY_FIELDS = ["state", "configured_gib", "writer_lease"] as const;
export const WORKSPACE_STRATEGIES_FIELDS = ["state", "count", "compiler", "execution_enabled"] as const;
export const WORKSPACE_DATA_FIELDS = ["research_configuration", "last_probe", "executable_evidence"] as const;
export const WORKSPACE_BROWSER_FIELDS = ["state"] as const;
export const WORKSPACE_RUNTIME_FIELDS = ["state", "effective_execution_mode"] as const;
export const WORKSPACE_DIAGNOSTIC_FIELDS = ["code", "severity", "summary"] as const;
