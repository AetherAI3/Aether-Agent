"""Independent Python mirror of the managed tool host object validators.

Mirrors src/core/managed_tool_host (vocabulary.ts, trust.ts, device.ts,
ats_channel.ts, registry.ts, lease.ts, invocation.ts, result.ts,
workspace_status.ts and the derivations in digest.ts) field for field and
message for message. Each check returns the value it received, and output
objects drop only members a deleted guard let through as MISSING, so a digest
over validated output is a digest over what arrived.
"""

from __future__ import annotations

import pathlib
import sys
from typing import Any

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import managed_tool_host_wire as w  # noqa: E402
from managed_tool_host_ed25519 import verify as ed25519_verify, weak_key  # noqa: E402

TRUST_SCHEMA = "aether.managed-tool-trust/1"
DEVICE_PROOF_SCHEMA = "aether.managed-tool-device-proof/1"
HOST_OPEN_PROOF_SCHEMA = "aether.managed-tool-host-open-proof/1"
HOST_OPEN_SIGNING_SCHEMA = "aether.managed-tool-host-open/1"
OBSERVER_RECEIPT_SCHEMA = "aether.ats.observer-channel-receipt/1"
RUNTIME_CAPABILITY_SCHEMA = "aether.ats.runtime-capability/1"
REGISTRY_SCHEMA = "aether.managed-tool-registry/1"
HOST_LEASE_SCHEMA = "aether.managed-tool-host-lease/1"
INVOCATION_SCHEMA = "aether.managed-tool-invocation/1"
CANCELLATION_SCHEMA = "aether.managed-tool-cancellation/1"
RESULT_SCHEMA = "aether.managed-tool-result/1"
WORKSPACE_STATUS_INPUT_SCHEMA = "aether.ats.workspace-status-input/1"
WORKSPACE_STATUS_SCHEMA = "aether.ats.workspace-status/1"
WORKSPACE_STATUS_OPERATION = "aether.ats.workspace-status/1"
SCHEMA_DIGEST_SCHEMA = "aether.schema/1"
ARGUMENTS_SCHEMA = "aether.managed-tool-arguments/1"
ACCOUNT_SCOPE_SCHEMA = "aether.account-scope/1"
WORKSPACE_BINDING_SCHEMA = "aether.ats.workspace-status-binding/1"
REDACTION_PROFILE = "aether.safe-display/1"
WORKSPACE_STATUS_INPUT_SCHEMA_DIGEST = "sha256:04e0d3206904490a99a80e0aad06771b050e9bb63b0a66205ff6aad43108e87b"
WORKSPACE_STATUS_SCHEMA_DIGEST = "sha256:7b896662d6f34cc8da77c31b65cb60cdbf1018919f32a98327c239353489b7ef"

MAX_ARGUMENT_DEPTH = 8
MAX_PAYLOAD_DEPTH = 15

FAILURE_CODES = (
    "TOOL_CONTRACT_INVALID", "TOOL_SCOPE_MISMATCH", "TOOL_LEASE_EXPIRED", "TOOL_LEASE_REVOKED", "TOOL_REGISTRY_MISMATCH",
    "TOOL_SEQUENCE_INVALID", "TOOL_IDEMPOTENCY_CONFLICT", "TOOL_UNKNOWN", "TOOL_ARGUMENT_INVALID", "TOOL_DEADLINE_EXCEEDED",
    "TOOL_CANCELLED", "TOOL_DEPENDENCY_UNAVAILABLE", "TOOL_RESULT_TOO_LARGE", "TOOL_DELIVERY_UNAVAILABLE",
)
EXECUTION_MODES = ("observe", "paper", "approve", "auto", "unknown")
TOOL_DEPENDENCIES = ("foreground_session", "verified_account", "ats_profile", "memory_writer", "ats_runtime", "browser_observer")
DATA_CLASSES = ("local_status", "ats_status", "untrusted_browser_observation")
CANCELLATION_REASONS = ("user_cancelled", "run_cancelled", "session_closed", "lease_revoked", "deadline_exceeded")
RESULT_STATES = ("succeeded", "refused", "cancelled", "deadline_exceeded", "unavailable")
REPLAY_STATUSES = ("fresh", "stored_redelivery", "interrupted_before_result")
RETRY_CLASSES = ("none", "redeliver_stored_result", "new_call_after_recovery")
MEMORY_STATES = ("ready", "degraded", "unavailable")
WRITER_LEASE_STATES = ("held", "lost", "not_held", "unavailable")
STRATEGY_STATES = ("scanned", "unavailable")
COMPILER_STATES = ("native_ats", "unavailable")
RESEARCH_CONFIGURATIONS = ("configured", "not_configured", "unavailable")
PROBE_STATES = ("fresh", "stale", "failed", "never", "unavailable")
BROWSER_STATES = ("available", "unavailable", "cleanup_required")
RUNTIME_STATES = ("ready", "degraded", "unavailable", "unknown")
DIAGNOSTIC_SEVERITIES = ("info", "warning", "error")

TRUST_FIELDS = ("schema", "generated_at", "expires_at", "keys")
TRUST_KEY_FIELDS = ("key_id", "algorithm", "public_key")
DEVICE_PROOF_FIELDS = ("schema", "cloud_origin_id", "account_scope_digest", "device_id", "device_public_key", "issued_at",
                       "expires_at", "revocation_epoch", "signature_key_id", "proof_digest", "cloud_signature")
HOST_OPEN_PROOF_FIELDS = ("schema", "challenge", "device_proof_digest", "agent_id", "conversation_id", "local_session_id",
                          "session_generation", "registry_digest", "device_signature")
HOST_OPEN_SIGNED_FIELDS = HOST_OPEN_PROOF_FIELDS[1:8]
OBSERVER_RECEIPT_FIELDS = ("schema", "receipt_id", "channel_id", "runtime_id", "runtime_version", "runtime_build_digest",
                           "challenge", "capability_digest", "issued_at", "expires_at", "authentication", "receipt_digest")
RUNTIME_CAPABILITY_FIELDS = ("schema", "runtime_id", "runtime_version", "runtime_build_digest", "attestation_kind",
                             "attestation_ref", "supported_read_operations", "effective_execution_mode",
                             "supports_paper_execution", "supports_live_execution", "observed_at", "expires_at",
                             "grants_execution_authority", "capability_digest")
REGISTRY_FIELDS = ("schema", "registry_id", "account_scope_digest", "agent_id", "device_id", "local_session_id",
                   "session_generation", "created_at", "expires_at", "tools", "grants_execution_authority", "registry_digest")
TOOL_FIELDS = ("name", "version", "input_schema_id", "input_schema_digest", "output_schema_id", "output_schema_digest",
               "effect_class", "dependencies", "max_argument_bytes", "max_result_bytes", "max_duration_ms", "data_classes",
               "grants_execution_authority")
HOST_LEASE_FIELDS = ("schema", "lease_id", "host_session_id", "cloud_origin_id", "account_scope_digest", "agent_id",
                     "device_id", "local_session_id", "session_generation", "revocation_epoch", "conversation_id",
                     "registry_digest", "issued_at", "expires_at", "max_calls", "capabilities", "grants_execution_authority",
                     "signature_key_id", "cloud_signature")
INVOCATION_FIELDS = ("schema", "request_id", "cloud_tool_call_id", "lease_id", "host_session_id", "session_generation",
                     "revocation_epoch", "cloud_origin_id", "account_scope_digest", "agent_id", "device_id",
                     "local_session_id", "conversation_id", "run_id", "sequence", "tool_name", "tool_version",
                     "input_schema_id", "input_schema_digest", "arguments", "arguments_digest", "issued_at", "deadline_at",
                     "nonce", "invocation_digest")
CANCELLATION_FIELDS = ("schema", "cancellation_id", "cloud_tool_call_id", "invocation_digest", "lease_id", "host_session_id",
                       "session_generation", "revocation_epoch", "reason", "issued_at", "cancellation_digest")
RESULT_FIELDS = ("schema", "result_id", "request_id", "cloud_tool_call_id", "lease_id", "host_session_id", "local_session_id",
                 "session_generation", "revocation_epoch", "run_id", "tool_name", "tool_version", "input_schema_id",
                 "input_schema_digest", "invocation_digest", "arguments_digest", "state", "payload", "output_schema_id",
                 "output_schema_digest", "error", "evidence_refs", "replay_status", "retry_class", "started_at",
                 "completed_at", "bounded_bytes", "redaction_profile", "grants_execution_authority", "result_digest")
RESULT_ERROR_FIELDS = ("code", "message")
WORKSPACE_BINDING_FIELDS = ("account_scope_digest", "agent_id", "device_id", "local_session_id", "session_generation")
WORKSPACE_STATUS_FIELDS = ("schema", "observed_at", "binding_digest", "local", "data", "browser", "runtime",
                           "execution_authority", "orders_enabled", "grants_execution_authority", "diagnostics",
                           "status_digest")


def _fields(raw: dict, prefix: str, checks: list) -> dict:
    """Validate (field, check) pairs in order into an output record."""
    f = w.field_of(raw, prefix)
    return w.record([(field, f(field, check)) for field, check in checks])


def _top(raw: dict, label: str, checks: list) -> dict:
    return w.record([("schema", raw.get("schema", w.MISSING))] + list(_fields(raw, label + " ", checks).items()))


# --- Derivations ----------------------------------------------------------------------

def binding_digest_of(binding: dict) -> str:
    return w.digest_for(WORKSPACE_BINDING_SCHEMA, {field: binding.get(field, w.MISSING) for field in WORKSPACE_BINDING_FIELDS})


def workspace_binding_digest(binding: Any) -> str:
    label = "Workspace binding"
    raw = w.closed(binding, label, WORKSPACE_BINDING_FIELDS)
    return binding_digest_of(_fields(raw, label + " ", [
        ("account_scope_digest", w.digest), ("agent_id", w.ident), ("device_id", w.device_id),
        ("local_session_id", w.ident), ("session_generation", w.positive53),
    ]))


def account_scope_digest(cloud_origin_id: Any, account_subject: Any) -> str:
    origin = w.https_origin(cloud_origin_id, "Account scope cloud_origin_id")
    subject = w.bounded_text(account_subject, "Account scope account_subject")
    return w.digest_for(ACCOUNT_SCOPE_SCHEMA, {"cloud_origin_id": origin, "account_subject": subject})


def arguments_digest(value: Any) -> str:
    return w.digest_for(ARGUMENTS_SCHEMA, w.json_value(value, "Arguments", MAX_ARGUMENT_DEPTH))


def schema_digest(document: Any) -> str:
    return w.digest_for(SCHEMA_DIGEST_SCHEMA, w.plain_object(document, "Schema document"))


# --- Trust, device proof, host-open proof ------------------------------------------------------

def ed25519_key(value: Any, path: str) -> Any:
    """A trust or device key: canonical point encoding, not in libsodium's small-order blocklist."""
    encoded = w.bytes32(value, path)
    if weak_key(w.decode_base64url(encoded)):
        w.fail(f"{path} is not a valid Ed25519 public key.")
    return encoded


def _trust_key(value: Any, path: str) -> dict:
    return _fields(w.closed(value, path, TRUST_KEY_FIELDS), path + ".", [
        ("key_id", w.ident), ("algorithm", w.constant("Ed25519")), ("public_key", ed25519_key),
    ])


def validate_trust_document(value: Any, now: int) -> dict:
    label = "Trust document"
    w.clock(now)
    raw = w.envelope(value, label, TRUST_SCHEMA, TRUST_FIELDS)
    trust = _top(raw, label, [
        ("generated_at", w.timestamp), ("expires_at", w.timestamp),
        ("keys", lambda keys, path: w.items(w.array(keys, path, 1, 16), path, _trust_key)),
    ])
    w.strictly_ascending(trust.get("keys", []), lambda key: key.get("key_id"),
                         f"{label} keys must not repeat a key_id.", f"{label} keys must be in ascending key_id order.")
    w.lifetime(label, trust.get("generated_at"), "generated_at", trust.get("expires_at"), 86400000, "24 hours")
    w.fresh(label, trust.get("generated_at"), "generated_at", trust.get("expires_at"), now)
    return trust


def verify_cloud_signature(label: str, schema: str, signed: dict, trust: dict, now: int) -> None:
    if now >= w.epoch_ms(trust["expires_at"]) + w.CLOCK_SKEW_MS:
        w.fail(f"{label} trust document has expired.")
    key = next((entry for entry in trust["keys"] if entry.get("key_id") == signed.get("signature_key_id")), None)
    if key is None:
        w.fail(f"{label} signature_key_id names no trusted key.")
    message = w.preimage(schema, w.omit(signed, ("cloud_signature",)))
    if not ed25519_verify(w.decode_base64url(key["public_key"]), message, w.decode_base64url(str(signed.get("cloud_signature")))):
        w.fail(f"{label} cloud_signature does not verify.")


def validate_device_proof(value: Any, trust: dict, now: int) -> dict:
    label = "Device proof"
    w.clock(now)
    raw = w.envelope(value, label, DEVICE_PROOF_SCHEMA, DEVICE_PROOF_FIELDS)
    proof = _top(raw, label, [
        ("cloud_origin_id", w.https_origin), ("account_scope_digest", w.digest), ("device_id", w.device_id),
        ("device_public_key", ed25519_key), ("issued_at", w.timestamp), ("expires_at", w.timestamp),
        ("revocation_epoch", w.uint53), ("signature_key_id", w.ident), ("proof_digest", w.digest),
        ("cloud_signature", w.bytes64),
    ])
    w.lifetime(label, proof.get("issued_at"), "issued_at", proof.get("expires_at"), 2592000000, "30 days")
    w.match_digest(label, "proof_digest", proof.get("proof_digest"),
                   w.digest_for(DEVICE_PROOF_SCHEMA, w.omit(proof, ("proof_digest", "cloud_signature"))))
    verify_cloud_signature(label, DEVICE_PROOF_SCHEMA, proof, trust, now)
    w.fresh(label, proof.get("issued_at"), "issued_at", proof.get("expires_at"), now)
    return proof


def host_open_preimage(proof: dict) -> bytes:
    return w.preimage(HOST_OPEN_SIGNING_SCHEMA, {field: proof.get(field, w.MISSING) for field in HOST_OPEN_SIGNED_FIELDS})


def validate_host_open_proof(value: Any, device_proof: dict) -> dict:
    label = "Host-open proof"
    raw = w.envelope(value, label, HOST_OPEN_PROOF_SCHEMA, HOST_OPEN_PROOF_FIELDS)
    proof = _top(raw, label, [
        ("challenge", w.bytes32), ("device_proof_digest", w.digest), ("agent_id", w.ident),
        ("conversation_id", w.ident), ("local_session_id", w.ident), ("session_generation", w.positive53),
        ("registry_digest", w.digest), ("device_signature", w.bytes64),
    ])
    if proof.get("device_proof_digest") != device_proof["proof_digest"]:
        w.fail(f"{label} device_proof_digest does not match the device proof.")
    signature = w.decode_base64url(str(proof.get("device_signature")))
    if not ed25519_verify(w.decode_base64url(device_proof["device_public_key"]), host_open_preimage(proof), signature):
        w.fail(f"{label} device_signature does not verify.")
    return proof


# --- ATS observer channel ------------------------------------------------------------------------

def validate_observer_receipt(value: Any, now: int) -> dict:
    label = "Observer receipt"
    w.clock(now)
    raw = w.envelope(value, label, OBSERVER_RECEIPT_SCHEMA, OBSERVER_RECEIPT_FIELDS)
    receipt = _top(raw, label, [
        ("receipt_id", w.ident), ("channel_id", w.ident), ("runtime_id", w.ident), ("runtime_version", w.printable_ascii),
        ("runtime_build_digest", w.digest), ("challenge", w.bytes32), ("capability_digest", w.digest),
        ("issued_at", w.timestamp), ("expires_at", w.timestamp),
        ("authentication", w.constant("ats_mcp_private_credential")), ("receipt_digest", w.digest),
    ])
    w.lifetime(label, receipt.get("issued_at"), "issued_at", receipt.get("expires_at"), 60000, "60 seconds")
    w.match_digest(label, "receipt_digest", receipt.get("receipt_digest"),
                   w.digest_for(OBSERVER_RECEIPT_SCHEMA, w.omit(receipt, ("receipt_digest",))))
    w.fresh(label, receipt.get("issued_at"), "issued_at", receipt.get("expires_at"), now)
    return receipt


def validate_runtime_capability(value: Any, now: int) -> dict:
    label = "Runtime capability"
    w.clock(now)
    raw = w.envelope(value, label, RUNTIME_CAPABILITY_SCHEMA, RUNTIME_CAPABILITY_FIELDS)
    capability = _top(raw, label, [
        ("runtime_id", w.ident), ("runtime_version", w.printable_ascii), ("runtime_build_digest", w.digest),
        ("attestation_kind", w.constant("ats_observer_channel_v1")), ("attestation_ref", w.ident),
        ("supported_read_operations", w.constant_list((WORKSPACE_STATUS_OPERATION,))),
        ("effective_execution_mode", w.one_of(EXECUTION_MODES)), ("supports_paper_execution", w.boolean),
        ("supports_live_execution", w.constant(False)), ("observed_at", w.timestamp), ("expires_at", w.timestamp),
        ("grants_execution_authority", w.constant(False)), ("capability_digest", w.digest),
    ])
    w.lifetime(label, capability.get("observed_at"), "observed_at", capability.get("expires_at"), 60000, "60 seconds")
    w.match_digest(label, "capability_digest", capability.get("capability_digest"),
                   w.digest_for(RUNTIME_CAPABILITY_SCHEMA, w.omit(capability, ("capability_digest",))))
    w.fresh(label, capability.get("observed_at"), "observed_at", capability.get("expires_at"), now)
    return capability


# --- Registry and lease -----------------------------------------------------------------------------

def _tool_entry(value: Any, path: str) -> dict:
    return _fields(w.closed(value, path, TOOL_FIELDS), path + ".", [
        ("name", w.tool_name), ("version", w.tool_version), ("input_schema_id", w.schema_id),
        ("input_schema_digest", w.digest), ("output_schema_id", w.schema_id), ("output_schema_digest", w.digest),
        ("effect_class", w.constant("read_only")), ("dependencies", w.string_set(1, 6, w.one_of(TOOL_DEPENDENCIES))),
        ("max_argument_bytes", w.int_range(2, 65536)), ("max_result_bytes", w.int_range(256, 65536)),
        ("max_duration_ms", w.int_range(1, 30000)), ("data_classes", w.string_set(1, 3, w.one_of(DATA_CLASSES))),
        ("grants_execution_authority", w.constant(False)),
    ])


def validate_registry(value: Any, now: int) -> dict:
    label = "Registry"
    w.clock(now)
    raw = w.envelope(value, label, REGISTRY_SCHEMA, REGISTRY_FIELDS)
    registry = _top(raw, label, [
        ("registry_id", w.ident), ("account_scope_digest", w.digest), ("agent_id", w.ident), ("device_id", w.device_id),
        ("local_session_id", w.ident), ("session_generation", w.positive53), ("created_at", w.timestamp),
        ("expires_at", w.timestamp), ("tools", lambda tools, path: w.items(w.array(tools, path, 1, 32), path, _tool_entry)),
        ("grants_execution_authority", w.constant(False)), ("registry_digest", w.digest),
    ])
    w.strictly_ascending(registry.get("tools", []), lambda tool: (tool.get("name"), tool.get("version")),
                         f"{label} tools must not repeat a name and version.", f"{label} tools must be in ascending name and version order.")
    w.lifetime(label, registry.get("created_at"), "created_at", registry.get("expires_at"), 300000, "5 minutes")
    w.match_digest(label, "registry_digest", registry.get("registry_digest"),
                   w.digest_for(REGISTRY_SCHEMA, w.omit(registry, ("registry_digest",))))
    w.fresh(label, registry.get("created_at"), "created_at", registry.get("expires_at"), now)
    return registry


def validate_host_lease(value: Any, trust: dict, now: int) -> dict:
    label = "Host lease"
    w.clock(now)
    raw = w.envelope(value, label, HOST_LEASE_SCHEMA, HOST_LEASE_FIELDS)
    lease = _top(raw, label, [
        ("lease_id", w.ident), ("host_session_id", w.ident), ("cloud_origin_id", w.https_origin),
        ("account_scope_digest", w.digest), ("agent_id", w.ident), ("device_id", w.device_id),
        ("local_session_id", w.ident), ("session_generation", w.positive53), ("revocation_epoch", w.uint53),
        ("conversation_id", w.ident), ("registry_digest", w.digest), ("issued_at", w.timestamp),
        ("expires_at", w.timestamp), ("max_calls", w.int_range(1, 256)),
        ("capabilities", w.constant_list(("local_read_tools",))), ("grants_execution_authority", w.constant(False)),
        ("signature_key_id", w.ident), ("cloud_signature", w.bytes64),
    ])
    w.lifetime(label, lease.get("issued_at"), "issued_at", lease.get("expires_at"), 300000, "5 minutes")
    verify_cloud_signature(label, HOST_LEASE_SCHEMA, lease, trust, now)
    w.fresh(label, lease.get("issued_at"), "issued_at", lease.get("expires_at"), now)
    return lease


# --- Invocation and cancellation ------------------------------------------------------------------------

def validate_invocation(value: Any) -> dict:
    label = "Invocation"
    raw = w.envelope(value, label, INVOCATION_SCHEMA, INVOCATION_FIELDS)
    invocation = _top(raw, label, [
        ("request_id", w.ident), ("cloud_tool_call_id", w.ident), ("lease_id", w.ident), ("host_session_id", w.ident),
        ("session_generation", w.positive53), ("revocation_epoch", w.uint53), ("cloud_origin_id", w.https_origin),
        ("account_scope_digest", w.digest), ("agent_id", w.ident), ("device_id", w.device_id),
        ("local_session_id", w.ident), ("conversation_id", w.ident), ("run_id", w.ident), ("sequence", w.positive53),
        ("tool_name", w.tool_name), ("tool_version", w.tool_version), ("input_schema_id", w.schema_id),
        ("input_schema_digest", w.digest),
        ("arguments", lambda args, path: w.json_value(args, path, MAX_ARGUMENT_DEPTH)),
        ("arguments_digest", w.digest), ("issued_at", w.timestamp), ("deadline_at", w.timestamp), ("nonce", w.bytes32),
        ("invocation_digest", w.digest),
    ])
    if w.canonical_bytes(invocation.get("arguments")) > 65536:
        w.fail(f"{label} arguments exceed 65536 canonical bytes.")
    if w.epoch_ms(invocation.get("deadline_at")) <= w.epoch_ms(invocation.get("issued_at")):
        w.fail(f"{label} deadline_at must be later than issued_at.")
    if invocation.get("arguments_digest") != w.digest_for(ARGUMENTS_SCHEMA, invocation.get("arguments")):
        w.fail(f"{label} arguments_digest does not match arguments.")
    w.match_digest(label, "invocation_digest", invocation.get("invocation_digest"),
                   w.digest_for(INVOCATION_SCHEMA, w.omit(invocation, ("invocation_digest",))))
    return invocation


def validate_cancellation(value: Any) -> dict:
    label = "Cancellation"
    raw = w.envelope(value, label, CANCELLATION_SCHEMA, CANCELLATION_FIELDS)
    cancellation = _top(raw, label, [
        ("cancellation_id", w.ident), ("cloud_tool_call_id", w.ident), ("invocation_digest", w.digest),
        ("lease_id", w.ident), ("host_session_id", w.ident), ("session_generation", w.positive53),
        ("revocation_epoch", w.uint53), ("reason", w.one_of(CANCELLATION_REASONS)), ("issued_at", w.timestamp),
        ("cancellation_digest", w.digest),
    ])
    w.match_digest(label, "cancellation_digest", cancellation.get("cancellation_digest"),
                   w.digest_for(CANCELLATION_SCHEMA, w.omit(cancellation, ("cancellation_digest",))))
    return cancellation


# --- Result -------------------------------------------------------------------------------------------------

def _result_error(value: Any, path: str) -> dict:
    return _fields(w.closed(value, path, RESULT_ERROR_FIELDS), path + ".", [
        ("code", w.one_of(FAILURE_CODES)), ("message", w.safe_display),
    ])


def _output_agrees_with_state(result: dict) -> None:
    succeeded = result.get("state") == "succeeded"
    for field in ("payload", "output_schema_id", "output_schema_digest"):
        if succeeded and result.get(field) is None:
            w.fail(f"Result {field} must be non-null when state is succeeded.")
        if not succeeded and result.get(field) is not None:
            w.fail(f"Result {field} must be null unless state is succeeded.")
    if succeeded and result.get("error") is not None:
        w.fail("Result error must be null when state is succeeded.")
    if not succeeded and result.get("error") is None:
        w.fail("Result error must be non-null unless state is succeeded.")


def _code_agrees_with_state(result: dict) -> None:
    error = result.get("error")
    code = error.get("code") if isinstance(error, dict) else None
    state = result.get("state")
    if state == "cancelled" and code != "TOOL_CANCELLED":
        w.fail("Result state cancelled requires error.code TOOL_CANCELLED.")
    if state == "deadline_exceeded" and code != "TOOL_DEADLINE_EXCEEDED":
        w.fail("Result state deadline_exceeded requires error.code TOOL_DEADLINE_EXCEEDED.")
    if state == "refused" and code in ("TOOL_CANCELLED", "TOOL_DEADLINE_EXCEEDED"):
        w.fail("Result state refused must not use error.code TOOL_CANCELLED or TOOL_DEADLINE_EXCEEDED.")


def _replay_agrees_with_retry(result: dict) -> None:
    if result.get("retry_class") == "redeliver_stored_result" and result.get("replay_status") != "stored_redelivery":
        w.fail("Result retry_class redeliver_stored_result requires replay_status stored_redelivery.")
    if result.get("replay_status") == "interrupted_before_result":
        if result.get("state") != "unavailable":
            w.fail("Result replay_status interrupted_before_result requires state unavailable.")
        if result.get("retry_class") != "new_call_after_recovery":
            w.fail("Result replay_status interrupted_before_result requires retry_class new_call_after_recovery.")
    if result.get("state") == "succeeded" and result.get("retry_class") == "new_call_after_recovery":
        w.fail("Result state succeeded must not use retry_class new_call_after_recovery.")


def validate_result(value: Any) -> dict:
    label = "Result"
    raw = w.envelope(value, label, RESULT_SCHEMA, RESULT_FIELDS)
    result = _top(raw, label, [
        ("result_id", w.ident), ("request_id", w.ident), ("cloud_tool_call_id", w.ident), ("lease_id", w.ident),
        ("host_session_id", w.ident), ("local_session_id", w.ident), ("session_generation", w.positive53),
        ("revocation_epoch", w.uint53), ("run_id", w.ident), ("tool_name", w.tool_name), ("tool_version", w.tool_version),
        ("input_schema_id", w.schema_id), ("input_schema_digest", w.digest), ("invocation_digest", w.digest),
        ("arguments_digest", w.digest), ("state", w.one_of(RESULT_STATES)),
        ("payload", w.nullable(lambda payload, path: w.json_value(payload, path, MAX_PAYLOAD_DEPTH))),
        ("output_schema_id", w.nullable(w.schema_id)), ("output_schema_digest", w.nullable(w.digest)),
        ("error", w.nullable(_result_error)), ("evidence_refs", w.string_set(0, 16, w.ident)),
        ("replay_status", w.one_of(REPLAY_STATUSES)), ("retry_class", w.one_of(RETRY_CLASSES)),
        ("started_at", w.timestamp), ("completed_at", w.timestamp), ("bounded_bytes", w.int_range(0, 65536)),
        ("redaction_profile", w.constant(REDACTION_PROFILE)), ("grants_execution_authority", w.constant(False)),
        ("result_digest", w.digest),
    ])
    _output_agrees_with_state(result)
    _code_agrees_with_state(result)
    _replay_agrees_with_retry(result)
    if w.epoch_ms(result.get("completed_at")) < w.epoch_ms(result.get("started_at")):
        w.fail(f"{label} completed_at must not be earlier than started_at.")
    payload = result.get("payload")
    if result.get("bounded_bytes") != (0 if payload is None else w.canonical_bytes(payload)):
        w.fail(f"{label} bounded_bytes does not match the payload size.")
    w.match_digest(label, "result_digest", result.get("result_digest"), w.digest_for(RESULT_SCHEMA, w.omit(result, ("result_digest",))))
    return result


# --- Workspace status -----------------------------------------------------------------------------------------

def validate_workspace_status_input(value: Any) -> dict:
    if not isinstance(value, dict) or len(value) != 0:
        w.fail("Workspace status input must be an empty object.")
    return {}


def _section(fields: tuple, checks: dict) -> w.Check:
    return lambda value, path: _fields(w.closed(value, path, fields), path + ".", [(field, checks[field]) for field in fields])


_MEMORY = _section(("state", "configured_gib", "writer_lease"), {
    "state": w.one_of(MEMORY_STATES), "configured_gib": w.nullable(w.int_range(1, 16384)),
    "writer_lease": w.one_of(WRITER_LEASE_STATES),
})
_STRATEGIES = _section(("state", "count", "compiler", "execution_enabled"), {
    "state": w.one_of(STRATEGY_STATES), "count": w.int_range(0, 10000), "compiler": w.one_of(COMPILER_STATES),
    "execution_enabled": w.constant(False),
})
_LOCAL = _section(("memory", "strategies"), {"memory": _MEMORY, "strategies": _STRATEGIES})
_DATA = _section(("research_configuration", "last_probe", "executable_evidence"), {
    "research_configuration": w.one_of(RESEARCH_CONFIGURATIONS), "last_probe": w.one_of(PROBE_STATES),
    "executable_evidence": w.constant("unavailable"),
})
_BROWSER = _section(("state",), {"state": w.one_of(BROWSER_STATES)})
_RUNTIME = _section(("state", "effective_execution_mode"), {
    "state": w.one_of(RUNTIME_STATES), "effective_execution_mode": w.one_of(EXECUTION_MODES),
})
_DIAGNOSTIC = _section(("code", "severity", "summary"), {
    "code": w.diagnostic_code, "severity": w.one_of(DIAGNOSTIC_SEVERITIES), "summary": w.safe_display,
})


def _encodable_size(value: Any) -> int | None:
    try:
        return w.canonical_bytes(value)
    except (w.CanonicalError, TypeError):
        return None


def validate_workspace_status(value: Any, binding: dict) -> dict:
    label = "Workspace status"
    size = _encodable_size(value)
    if size is not None and size > 65536:
        w.fail(f"{label} exceeds 65536 serialized bytes.")
    raw = w.envelope(value, label, WORKSPACE_STATUS_SCHEMA, WORKSPACE_STATUS_FIELDS)
    status = _top(raw, label, [
        ("observed_at", w.timestamp), ("binding_digest", w.digest), ("local", _LOCAL), ("data", _DATA),
        ("browser", _BROWSER), ("runtime", _RUNTIME), ("execution_authority", w.constant("none")),
        ("orders_enabled", w.constant(False)), ("grants_execution_authority", w.constant(False)),
        ("diagnostics", lambda entries, path: w.items(w.array(entries, path, 0, 16), path, _DIAGNOSTIC)),
        ("status_digest", w.digest),
    ])
    if status.get("binding_digest") != binding_digest_of(binding):
        w.fail(f"{label} binding_digest does not match the host binding.")
    w.match_digest(label, "status_digest", status.get("status_digest"),
                   w.digest_for(WORKSPACE_STATUS_SCHEMA, w.omit(status, ("status_digest",))))
    return status
