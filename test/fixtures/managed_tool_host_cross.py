"""Independent Python mirror of the managed tool host cross-object checks.

Mirrors src/core/managed_tool_host/cross.ts with identical refusal messages.
Every function takes objects already validated by managed_tool_host_objects
and raises ContractError on the first mismatch. Tools are looked up by the
invocation's (name, version), the call the host actually accepted.
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import managed_tool_host_objects as o  # noqa: E402
import managed_tool_host_wire as w  # noqa: E402

UNLISTED_INVOCATION = "Invocation names a tool the registry does not list."
UNLISTED_RESULT = "Result names a tool the registry does not list."
E1_DEPENDENCIES = ["ats_profile", "foreground_session", "verified_account"]
INVOCATION_SCOPE = ("lease_id", "host_session_id", "session_generation", "revocation_epoch", "cloud_origin_id",
                    "account_scope_digest", "agent_id", "device_id", "local_session_id", "conversation_id")
RESULT_IDENTITY = ("request_id", "cloud_tool_call_id", "lease_id", "host_session_id", "local_session_id",
                   "session_generation", "revocation_epoch", "run_id", "tool_name", "tool_version", "input_schema_id",
                   "input_schema_digest", "invocation_digest", "arguments_digest")


def _same(actual, expected, message: str) -> None:
    if actual != expected or type(actual) is not type(expected):
        w.fail(message)


def _tool_for(invocation: dict, registry: dict, message: str) -> dict:
    for tool in registry["tools"]:
        if tool["name"] == invocation["tool_name"] and tool["version"] == invocation["tool_version"]:
            return tool
    w.fail(message)


def check_lease_binding(lease: dict, registry: dict, device_proof: dict, trust: dict) -> None:
    for field in ("account_scope_digest", "agent_id", "device_id", "local_session_id", "session_generation"):
        _same(lease[field], registry[field], f"Host lease {field} does not match the registry.")
    _same(lease["registry_digest"], registry["registry_digest"], "Host lease registry_digest does not match the registry.")
    for field in ("cloud_origin_id", "account_scope_digest", "device_id"):
        _same(lease[field], device_proof[field], f"Host lease {field} does not match the device proof.")
    expires = w.epoch_ms(lease["expires_at"])
    if expires > w.epoch_ms(registry["expires_at"]):
        w.fail("Host lease outlives the registry.")
    if expires > w.epoch_ms(device_proof["expires_at"]):
        w.fail("Host lease outlives the device proof.")
    if expires > w.epoch_ms(trust["expires_at"]):
        w.fail("Host lease outlives the trust document.")


def check_invocation(invocation: dict, lease: dict, registry: dict, now: int) -> None:
    w.clock(now)
    for field in INVOCATION_SCOPE:
        _same(invocation[field], lease[field], f"Invocation {field} does not match the host lease.")
    _same(lease["registry_digest"], registry["registry_digest"], "Host lease registry_digest does not match the registry.")
    tool = _tool_for(invocation, registry, UNLISTED_INVOCATION)
    _same(invocation["input_schema_id"], tool["input_schema_id"], "Invocation input_schema_id does not match the registered tool.")
    _same(invocation["input_schema_digest"], tool["input_schema_digest"], "Invocation input_schema_digest does not match the registered tool.")
    if w.canonical_bytes(invocation["arguments"]) > tool["max_argument_bytes"]:
        w.fail("Invocation arguments exceed the registered max_argument_bytes.")
    deadline = w.epoch_ms(invocation["deadline_at"])
    if deadline > w.epoch_ms(lease["expires_at"]):
        w.fail("Invocation deadline_at is later than the host lease expiry.")
    if deadline - w.epoch_ms(invocation["issued_at"]) > tool["max_duration_ms"]:
        w.fail("Invocation deadline_at exceeds the registered max_duration_ms.")
    if now >= deadline + w.CLOCK_SKEW_MS:
        w.fail("Invocation deadline has passed.")


def check_tool_arguments(invocation: dict, registry: dict) -> None:
    tool = _tool_for(invocation, registry, UNLISTED_INVOCATION)
    if tool["input_schema_id"] != o.WORKSPACE_STATUS_INPUT_SCHEMA or tool["input_schema_digest"] != o.WORKSPACE_STATUS_INPUT_SCHEMA_DIGEST:
        w.fail("No argument validator is registered for the tool input schema.")
    o.validate_workspace_status_input(invocation["arguments"])


def check_cancellation(cancellation: dict, invocation: dict, lease: dict) -> None:
    _same(cancellation["cloud_tool_call_id"], invocation["cloud_tool_call_id"], "Cancellation cloud_tool_call_id does not match the invocation.")
    _same(cancellation["invocation_digest"], invocation["invocation_digest"], "Cancellation invocation_digest does not match the invocation.")
    for field in ("lease_id", "host_session_id", "session_generation", "revocation_epoch"):
        _same(cancellation[field], lease[field], f"Cancellation {field} does not match the host lease.")
    issued = w.epoch_ms(cancellation["issued_at"])
    if issued < w.epoch_ms(lease["issued_at"]) - w.CLOCK_SKEW_MS or issued >= w.epoch_ms(lease["expires_at"]) + w.CLOCK_SKEW_MS:
        w.fail("Cancellation issued_at is outside the host lease window.")


def check_result(result: dict, invocation: dict, registry: dict, now: int) -> None:
    w.clock(now)
    for field in RESULT_IDENTITY:
        _same(result[field], invocation[field], f"Result {field} does not match the invocation.")
    tool = _tool_for(invocation, registry, UNLISTED_RESULT)
    if result["state"] == "succeeded":
        _same(result["output_schema_id"], tool["output_schema_id"], "Result output_schema_id does not match the registered tool.")
        _same(result["output_schema_digest"], tool["output_schema_digest"], "Result output_schema_digest does not match the registered tool.")
    if result["bounded_bytes"] > tool["max_result_bytes"]:
        w.fail("Result bounded_bytes exceeds the registered max_result_bytes.")
    if w.epoch_ms(result["started_at"]) < w.epoch_ms(invocation["issued_at"]) - w.CLOCK_SKEW_MS:
        w.fail("Result started_at is earlier than the invocation issued_at.")
    if w.epoch_ms(result["completed_at"]) > now + w.CLOCK_SKEW_MS:
        w.fail("Result completed_at is in the future.")


def check_tool_payload(result: dict, invocation: dict, registry: dict) -> None:
    if result["state"] != "succeeded":
        return
    tool = _tool_for(invocation, registry, UNLISTED_RESULT)
    if tool["output_schema_id"] != o.WORKSPACE_STATUS_SCHEMA or tool["output_schema_digest"] != o.WORKSPACE_STATUS_SCHEMA_DIGEST:
        w.fail("No payload validator is registered for the tool output schema.")
    o.validate_workspace_status(result["payload"], {field: invocation[field] for field in o.WORKSPACE_BINDING_FIELDS})


def assert_e1_canary_registry(registry: dict) -> None:
    if len(registry["tools"]) != 1:
        w.fail("E1 canary registry must list exactly one tool.")
    tool = registry["tools"][0]
    if tool["name"] != "ats_workspace_status":
        w.fail("E1 canary tool must be ats_workspace_status.")
    if tool["version"] != 1:
        w.fail("E1 canary tool version must be 1.")
    if tool["input_schema_id"] != o.WORKSPACE_STATUS_INPUT_SCHEMA:
        w.fail("E1 canary tool input_schema_id must be aether.ats.workspace-status-input/1.")
    if tool["input_schema_digest"] != o.WORKSPACE_STATUS_INPUT_SCHEMA_DIGEST:
        w.fail("E1 canary tool input_schema_digest must match the frozen schema.")
    if tool["output_schema_id"] != o.WORKSPACE_STATUS_SCHEMA:
        w.fail("E1 canary tool output_schema_id must be aether.ats.workspace-status/1.")
    if tool["output_schema_digest"] != o.WORKSPACE_STATUS_SCHEMA_DIGEST:
        w.fail("E1 canary tool output_schema_digest must match the frozen schema.")
    if list(tool["dependencies"]) != E1_DEPENDENCIES:
        w.fail("E1 canary tool dependencies must be ats_profile, foreground_session, verified_account.")


def check_capability_receipt(capability: dict, receipt: dict, expected: dict) -> None:
    _same(capability["attestation_ref"], receipt["receipt_id"], "Runtime capability attestation_ref does not match the observer receipt.")
    _same(capability["capability_digest"], receipt["capability_digest"], "Runtime capability capability_digest does not match the observer receipt.")
    for field in ("runtime_id", "runtime_version", "runtime_build_digest"):
        _same(capability[field], receipt[field], f"Runtime capability {field} does not match the observer receipt.")
    _same(receipt["challenge"], expected["challenge"], "Observer receipt challenge does not match the challenge sent.")
    _same(capability["runtime_build_digest"], expected["runtime_build_digest"], "Runtime capability runtime_build_digest does not match the loaded build.")
