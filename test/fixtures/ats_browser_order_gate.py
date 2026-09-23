"""Independent Python mirror of the agent-browser-ats-order/1 decisions.

The pure functions ATSv2 applies to validated calls and results; mirrors
src/core/ats_contracts/browser_order_gate.ts with identical refusal reasons.
"""

from __future__ import annotations

import pathlib
import sys
import types
from typing import Any, Mapping

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from ats_browser_order_wire import (  # noqa: E402
    EFFECTS,
    MAX_CLOCK_SKEW_MS,
    TICKET_FIELDS,
    digest_equals,
    epoch_ms,
)


# --- Decisions (mirrors the TypeScript gate) -----------------------------------

# Verdicts are read-only views, as the TypeScript verdicts are frozen.
ANSWERS: Mapping[str, Any] = types.MappingProxyType({"answers": True})


def refuse(reason: str) -> Mapping[str, Any]:
    return types.MappingProxyType({"answers": False, "reason": reason})


def adapter_pins_equal(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return (a["adapter_id"] == b["adapter_id"] and a["adapter_version"] == b["adapter_version"]
            and digest_equals(a["adapter_digest"], b["adapter_digest"]))


def resolve_site_mode(evidence: dict[str, Any]) -> str | None:
    if evidence["primary"] == "absent":
        return None
    if evidence["secondary"] == "not_supported":
        return evidence["primary"]
    return evidence["primary"] if evidence["secondary"] == evidence["primary"] else None


def derive_binding_state(session: dict[str, Any]) -> str:
    if session["session_state"] != "verified":
        return session["session_state"]
    if session["trading_permission"] != "equity_orders" or session["mode_evidence"] is None:
        return "observe_only"
    mode = resolve_site_mode(session["mode_evidence"])
    if mode is None:
        return "observe_only"
    return "paper_ready" if mode == "paper" else "live_locked"


def requires_reconciliation(result: Mapping[str, Any]) -> bool:
    if EFFECTS[result["operation"]] != "mutate":
        return False
    return result["status"] != "refused" or result["refusal"] == "duplicate_commit"


def account_matches(fingerprint: str, mode: str, binding: dict[str, Any]) -> dict[str, Any]:
    if not digest_equals(fingerprint, binding["account_fingerprint"]):
        return refuse("Account differs from the binding.")
    if mode != binding["site_mode"]:
        return refuse("Site mode differs from the binding.")
    return ANSWERS


def session_matches(session: dict[str, Any], binding: dict[str, Any]) -> dict[str, Any]:
    if session["session_state"] != "verified" or session["account_fingerprint"] is None or session["mode_evidence"] is None:
        return refuse("Session is not verified for this binding.")
    mode = resolve_site_mode(session["mode_evidence"])
    if mode is None:
        return refuse("Site mode is unresolved for this binding.")
    account = account_matches(session["account_fingerprint"], mode, binding)
    if not account["answers"]:
        return account
    if session["trading_permission"] != "equity_orders":
        return refuse("Session lost trading permission for this binding.")
    return ANSWERS


def ticket_matches(rendered: dict[str, Any], expected: dict[str, Any], binding: dict[str, Any]) -> dict[str, Any]:
    account = account_matches(rendered["account_fingerprint"], rendered["site_mode"], binding)
    if not account["answers"]:
        return account
    for field in TICKET_FIELDS:
        if rendered[field] != expected[field]:
            return refuse(f"Rendered ticket {field} differs from the requested ticket.")
    return ANSWERS


def data_answers_call(call: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    operation, data, params, binding = result["operation"], result["data"], call["params"], call["binding"]
    if data is None:
        return refuse("An ok result carries no data.")
    if operation == "verify_session":
        return ANSWERS if binding is None else session_matches(data, binding)
    if operation == "read_market":
        return ANSWERS if data["symbol"] == params["symbol"] else refuse("Quote symbol differs from the requested symbol.")
    if operation == "read_account":
        return account_matches(data["account_fingerprint"], data["site_mode"], binding)
    if operation in ("prepare_ticket", "verify_ticket"):
        return ticket_matches(data["rendered_ticket"], params["ticket"], binding)
    if operation == "commit_once":
        if digest_equals(data["rendered_ticket_digest"], params["rendered_ticket_digest"]):
            return ANSWERS
        return refuse("Committed ticket differs from the verified ticket.")
    if operation == "read_order":
        account = account_matches(data["account_fingerprint"], data["site_mode"], binding)
        if not account["answers"]:
            return account
        wanted, found = params["site_order_id"], data["order"]
        if wanted is None or found is None or found["site_order_id"] == wanted:
            return ANSWERS
        return refuse("Order history returned a different order.")
    if operation == "read_positions":
        account = account_matches(data["account_fingerprint"], data["site_mode"], binding)
        if not account["answers"]:
            return account
        wanted = params["symbol"]
        if wanted is None or all(entry["symbol"] == wanted for entry in data["positions"]):
            return ANSWERS
        return refuse("Positions include a symbol other than the requested symbol.")
    if operation == "cancel_order":
        account = account_matches(data["account_fingerprint"], data["site_mode"], binding)
        if not account["answers"]:
            return account
        return ANSWERS if data["site_order_id"] == params["site_order_id"] else refuse("Cancel result names a different order.")
    return ANSWERS  # end_control


def verify_browser_result(call: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    if result["call_id"] != call["call_id"] or result["request_id"] != call["request_id"] or result["operation"] != call["operation"]:
        return refuse("Result answers a different call, request or operation.")
    ours, theirs = call["principal"], result["principal"]
    if theirs["session_generation"] != ours["session_generation"]:
        return refuse("Browser session generation changed; verify the binding again.")
    if any(theirs[key] != ours[key] for key in ("user_ref", "agent_id", "browser_session_id")):
        return refuse("Result comes from a different user, agent or browser session.")
    if not adapter_pins_equal(result["adapter"], call["adapter"]):
        return refuse("Adapter differs from the pinned adapter.")
    if epoch_ms(result["observed_at"]) < epoch_ms(call["issued_at"]) - MAX_CLOCK_SKEW_MS:
        return refuse("Observation predates the call.")
    if result["status"] != "ok":
        return ANSWERS
    if EFFECTS[call["operation"]] != "mutate" and epoch_ms(result["observed_at"]) > epoch_ms(call["deadline"]):
        return refuse("Observation arrived after the call deadline.")
    return data_answers_call(call, result)
