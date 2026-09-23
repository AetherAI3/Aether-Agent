"""Independent Python mirror of the Spec 1 validators at /1 and /2 and of the
executable chain gate; see docs/CONTRACTS.md, "Spec 1 /2 closure".

Mirrors src/core/ats_contracts/{proposal,order,approval,grant,connector,mode}.ts
with byte-identical refusal messages. It imports nothing from TypeScript. It
borrows the primitives and the two strict helpers from ats_browser_order_wire.py
and the RFC 8785 encoder from ats_contracts_golden_verify.py (both independent
mirrors themselves), so each rule has one Python definition, just as each has
one TypeScript definition. The fixture harness is ats_contracts_v2_verify.py;
ATSv2 lifts this module, not the harness.

Cross-language trap handled here on purpose: the regex digit class matches
every Unicode digit in Python but only ASCII 0-9 in JavaScript. The frozen
/1 label rule is therefore written [0-9]{5,}; with the digit class the
Python /1 mirror would refuse the fullwidth-digit weakness that TypeScript
/1 accepts, and the fixture's frozen_weakness section would stop proving
anything about /1.
"""

from __future__ import annotations

import pathlib
import re
import sys
from typing import Any, Callable

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from ats_browser_order_wire import (  # noqa: E402  independent mirror of primitives.ts
    MAX_SAFE_INTEGER,
    ORDER_SIDES,
    ORDER_TYPES,
    ContractError,
    bounded_list,
    choice,
    closed,
    digest,
    digest_equals,
    epoch_ms,
    fail,
    ident,
    integer,
    minor_units,
    nullable,
    opaque_ref,
    pinned,
    schema_tag,
    text,
    timestamp,
)
from ats_browser_order_wire import equity_symbol as equity_ticker  # noqa: E402  primitives.ts equityTicker()
from ats_browser_order_wire import masked_account_label as closed_masked_label  # noqa: E402  closedMaskedLabel()
from ats_contracts_golden_verify import canonical_json, digest_of  # noqa: E402  independent JCS mirror

FieldCheck = Callable[[Any, str], str]

# --- Frozen /1 checks (primitives.ts symbol(), connector.ts maskedLabel()) ------

SYMBOL = re.compile(r"[A-Z0-9][A-Z0-9.^:=_/-]{0,39}")
ASCII_DIGIT_RUN = re.compile(r"[0-9]{5,}")


def symbol(value: Any, name: str) -> str:
    """The frozen /1 ticker. Admits URL-shaped strings such as HTTPS://X."""
    if not isinstance(value, str) or not SYMBOL.fullmatch(value):
        fail(f"{name} must be a bounded uppercase ticker.")
    return value


def frozen_masked_label(value: Any, name: str) -> str:
    """The frozen /1 label: any control-free text without a 5-digit ASCII run."""
    label = text(value, name, 64)
    if ASCII_DIGIT_RUN.search(label):
        fail(f"{name} must not embed a full account number.")
    return label


def boolean(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        fail(f"{name} must be a boolean.")
    return value


def unique_list(value: Any, name: str, maximum: int, item: FieldCheck) -> list[Any]:
    entries = bounded_list(value, name, maximum, item)
    if len(set(entries)) != len(entries):
        fail(f"{name} must not repeat an entry.")
    return entries


def ordered_window(starts_at: str, ends_at: str, name: str) -> None:
    if epoch_ms(ends_at) <= epoch_ms(starts_at):
        fail(f"{name} must expire after it begins.")


# --- Vocabulary (mode.ts, grant.ts, order.ts, approval.ts, connector.ts) --------

EXECUTION_STATE_SCHEMA = "aether.ats.execution-state/1"
PROPOSAL_SCHEMA = ("aether.ats.model-order-proposal/1", "aether.ats.model-order-proposal/2")
INTENT_SCHEMA = ("aether.ats.equity-order-intent/1", "aether.ats.equity-order-intent/2")
REVIEW_SCHEMA = "aether.ats.order-review-receipt/1"
APPROVAL_SCHEMA = ("aether.ats.operator-approval/1", "aether.ats.operator-approval/2")
RECEIPT_SCHEMA = ("aether.ats.execution-receipt/1", "aether.ats.execution-receipt/2")
GRANT_SCHEMA = ("aether.ats.delegated-trading-grant/1", "aether.ats.delegated-trading-grant/2")
BINDING_SCHEMA = ("aether.ats.account-binding/1", "aether.ats.account-binding/2")
EXECUTABLE_CHAIN_REFUSAL = (
    "Only a /2 order chain may authorize an executable order; a /1 or mixed-version chain is a historical record."
)

REQUESTED_EXECUTION_MODES = ("observe", "paper", "approve", "auto")
EFFECTIVE_EXECUTION_MODES = ("offline", "observe", "review_only", "paper", "approve", "auto", "orders_paused", "emergency_locked")
EXECUTION_ENVIRONMENTS = ("ats_paper", "provider_sandbox", "provider_live")
AUTHORITY_RANK = {"offline": 0, "observe": 1, "review_only": 2, "paper": 3, "approve": 4, "auto": 5}
HALTED = ("orders_paused", "emergency_locked")
SUBMITTING = ("paper", "approve", "auto")
GRANT_CAPABILITIES = ("read_account", "review_order", "commit_order")
GRANT_STATES = ("active", "suspended", "revoked", "expired")
RISK_VERDICTS = ("pass", "refuse")
EXECUTION_OUTCOMES = ("submitted", "accepted", "filled", "partially_filled", "refused", "cancelled", "ambiguous")
RECONCILIATION_STATES = ("not_required", "pending", "resolved", "unresolved")
ASSET_CLASSES = ("equity",)
MAX_QUANTITY = 1_000_000

CONNECTOR_REF_FIELDS = (
    "provider_id", "account_binding_id", "adapter_id", "endpoint_schema_digest", "execution_environment", "binding_generation",
)


# --- Shared nested shapes -------------------------------------------------------


def within_requested_authority(requested: str, effective: str) -> bool:
    if effective in HALTED:
        return True
    asked, granted = AUTHORITY_RANK.get(requested), AUTHORITY_RANK.get(effective)
    return asked is not None and granted is not None and granted <= asked


def validate_execution_state(value: Any, name: str = "Execution state") -> dict[str, Any]:
    raw = closed(value, name, ("schema_version", "requested_mode", "effective_mode", "effective_reason"))
    schema = schema_tag(raw["schema_version"], EXECUTION_STATE_SCHEMA, name)
    requested = choice(raw["requested_mode"], REQUESTED_EXECUTION_MODES, f"{name} requested mode")
    effective = choice(raw["effective_mode"], EFFECTIVE_EXECUTION_MODES, f"{name} effective mode")
    reason = None if raw["effective_reason"] is None else text(raw["effective_reason"], f"{name} effective reason", 200)
    if not within_requested_authority(requested, effective):
        fail(f"{name} cannot grant more authority than was requested.")
    if requested != effective and reason is None:
        fail(f"{name} must explain why the effective mode differs from the requested mode.")
    return {"schema_version": schema, "requested_mode": requested, "effective_mode": effective, "effective_reason": reason}


def validate_market_evidence(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("market_snapshot_ref", "broker_quote_ref", "evidence_digest", "observed_at"))
    return {
        "market_snapshot_ref": ident(raw["market_snapshot_ref"], f"{name} snapshot reference"),
        "broker_quote_ref": ident(raw["broker_quote_ref"], f"{name} quote reference"),
        "evidence_digest": digest(raw["evidence_digest"], f"{name} digest"),
        "observed_at": timestamp(raw["observed_at"], f"{name} observed_at"),
    }


def validate_connector_binding_ref(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, CONNECTOR_REF_FIELDS)
    return {
        "provider_id": ident(raw["provider_id"], f"{name} provider"),
        "account_binding_id": opaque_ref(raw["account_binding_id"], f"{name} account binding id"),
        "adapter_id": ident(raw["adapter_id"], f"{name} adapter"),
        "endpoint_schema_digest": digest(raw["endpoint_schema_digest"], f"{name} endpoint schema digest"),
        "execution_environment": choice(raw["execution_environment"], EXECUTION_ENVIRONMENTS, f"{name} execution environment"),
        "binding_generation": integer(raw["binding_generation"], f"{name} generation", 1, MAX_SAFE_INTEGER),
    }


def validate_grant_usage(value: Any, name: str = "Grant usage") -> dict[str, Any]:
    raw = closed(value, name, ("notional_today_minor", "orders_today", "open_orders"))
    return {
        "notional_today_minor": minor_units(raw["notional_today_minor"], f"{name} notional today"),
        "orders_today": integer(raw["orders_today"], f"{name} orders today", 0, 1_000_000),
        "open_orders": integer(raw["open_orders"], f"{name} open orders", 0, 1_000_000),
    }


def validate_limits(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, (
        "max_notional_per_order_minor", "max_notional_per_day_minor", "max_position_notional_per_symbol_minor",
        "max_orders_per_day", "max_open_orders",
    ))
    limits = {
        "max_notional_per_order_minor": minor_units(raw["max_notional_per_order_minor"], f"{name} per-order notional"),
        "max_notional_per_day_minor": minor_units(raw["max_notional_per_day_minor"], f"{name} daily notional"),
        "max_position_notional_per_symbol_minor": minor_units(
            raw["max_position_notional_per_symbol_minor"], f"{name} per-symbol position notional"),
        "max_orders_per_day": integer(raw["max_orders_per_day"], f"{name} daily order count", 0, 10_000),
        "max_open_orders": integer(raw["max_open_orders"], f"{name} open order count", 0, 1_000),
    }
    if limits["max_notional_per_order_minor"] > limits["max_notional_per_day_minor"]:
        fail(f"{name} per-order notional cannot exceed the daily notional.")
    return limits


# --- Versioned documents: one body per document, the schema tag and check vary ---

PROPOSAL_FIELDS = (
    "schema_version", "activation_id", "artifact_id", "symbol", "side", "quantity", "order_type",
    "limit_price_minor", "market_snapshot_ref", "broker_quote_ref", "evidence_digest", "expires_at",
)


def _model_order_proposal(value: Any, schema: str, ticker: FieldCheck) -> dict[str, Any]:
    raw = closed(value, "Model order proposal", PROPOSAL_FIELDS)
    order_type = choice(raw["order_type"], ORDER_TYPES, "Proposal order type")
    price = nullable(raw["limit_price_minor"], "Proposal limit price", minor_units)
    if order_type == "limit" and (price is None or price <= 0):
        fail("A limit proposal requires a positive minor-unit price.")
    if order_type == "market" and price is not None:
        fail("A market proposal cannot carry a limit price.")
    return {
        "schema_version": schema_tag(raw["schema_version"], schema, "Model order proposal"),
        "activation_id": ident(raw["activation_id"], "Proposal activation"),
        "artifact_id": ident(raw["artifact_id"], "Proposal artifact"),
        "symbol": ticker(raw["symbol"], "Proposal symbol"),
        "side": choice(raw["side"], ORDER_SIDES, "Proposal side"),
        "quantity": integer(raw["quantity"], "Proposal quantity", 1, MAX_QUANTITY),
        "order_type": order_type,
        "limit_price_minor": price,
        "market_snapshot_ref": ident(raw["market_snapshot_ref"], "Proposal market snapshot"),
        "broker_quote_ref": ident(raw["broker_quote_ref"], "Proposal broker quote"),
        "evidence_digest": digest(raw["evidence_digest"], "Proposal evidence digest"),
        "expires_at": timestamp(raw["expires_at"], "Proposal expiry"),
    }


def validate_model_order_proposal(value: Any) -> dict[str, Any]:
    return _model_order_proposal(value, PROPOSAL_SCHEMA[0], symbol)


def validate_model_order_proposal_v2(value: Any) -> dict[str, Any]:
    return _model_order_proposal(value, PROPOSAL_SCHEMA[1], equity_ticker)


INTENT_FIELDS = (
    "schema_version", "intent_id", "request_id", "connector", "activation_id", "artifact_id", "symbol", "side",
    "quantity", "order_type", "limit_price_minor", "evidence", "created_at", "expires_at",
)


def _order_intent(value: Any, name: str, schema: str, ticker: FieldCheck) -> dict[str, Any]:
    raw = closed(value, name, INTENT_FIELDS)
    created_at = timestamp(raw["created_at"], f"{name} created_at")
    expires_at = timestamp(raw["expires_at"], f"{name} expires_at")
    ordered_window(created_at, expires_at, f"{name} validity window")
    order_type = choice(raw["order_type"], ORDER_TYPES, f"{name} order type")
    limit_price = nullable(raw["limit_price_minor"], f"{name} limit price", minor_units)
    if order_type == "limit" and limit_price is None:
        fail(f"{name} limit order requires a limit price.")
    if order_type == "market" and limit_price is not None:
        fail(f"{name} market order must not carry a limit price.")
    if limit_price is not None and limit_price <= 0:
        fail(f"{name} limit price must be above zero.")
    return {
        "schema_version": schema_tag(raw["schema_version"], schema, name),
        "intent_id": ident(raw["intent_id"], f"{name} id"),
        "request_id": ident(raw["request_id"], f"{name} request id"),
        "connector": validate_connector_binding_ref(raw["connector"], f"{name} connector"),
        "activation_id": ident(raw["activation_id"], f"{name} activation"),
        "artifact_id": ident(raw["artifact_id"], f"{name} artifact"),
        "symbol": ticker(raw["symbol"], f"{name} symbol"),
        "side": choice(raw["side"], ORDER_SIDES, f"{name} side"),
        "quantity": integer(raw["quantity"], f"{name} quantity", 1, MAX_QUANTITY),
        "order_type": order_type,
        "limit_price_minor": limit_price,
        "evidence": validate_market_evidence(raw["evidence"], f"{name} evidence"),
        "created_at": created_at,
        "expires_at": expires_at,
    }


def validate_order_intent(value: Any, name: str = "Order intent") -> dict[str, Any]:
    return _order_intent(value, name, INTENT_SCHEMA[0], symbol)


def validate_order_intent_v2(value: Any, name: str = "Order intent") -> dict[str, Any]:
    return _order_intent(value, name, INTENT_SCHEMA[1], equity_ticker)


REVIEW_FIELDS = (
    "schema_version", "review_id", "request_id", "intent_digest", "connector", "grant_id", "grant_version", "usage",
    "reservation_ref", "reservation_expires_at", "risk_verdict", "risk_reason", "broker_preview_id",
    "broker_preview_digest", "evidence", "evidence_age_ms", "worst_case_notional_minor", "approval_deadline",
    "execution_state", "recorded_at",
)


def validate_order_review(value: Any, name: str = "Order review") -> dict[str, Any]:
    """The review receipt has one version: it carries no ticker and no label."""
    raw = closed(value, name, REVIEW_FIELDS)
    recorded_at = timestamp(raw["recorded_at"], f"{name} recorded_at")
    reservation_expires_at = timestamp(raw["reservation_expires_at"], f"{name} reservation expiry")
    approval_deadline = timestamp(raw["approval_deadline"], f"{name} approval deadline")
    ordered_window(recorded_at, reservation_expires_at, f"{name} reservation window")
    ordered_window(recorded_at, approval_deadline, f"{name} approval window")
    if epoch_ms(approval_deadline) > epoch_ms(reservation_expires_at):
        fail(f"{name} approval deadline cannot outlive its reservation.")
    verdict = choice(raw["risk_verdict"], RISK_VERDICTS, f"{name} risk verdict")
    reason = None if raw["risk_reason"] is None else text(raw["risk_reason"], f"{name} risk reason", 200)
    if verdict == "refuse" and reason is None:
        fail(f"{name} must explain a refusing risk verdict.")
    return {
        "schema_version": schema_tag(raw["schema_version"], REVIEW_SCHEMA, name),
        "review_id": ident(raw["review_id"], f"{name} id"),
        "request_id": ident(raw["request_id"], f"{name} request id"),
        "intent_digest": digest(raw["intent_digest"], f"{name} intent digest"),
        "connector": validate_connector_binding_ref(raw["connector"], f"{name} connector"),
        "grant_id": ident(raw["grant_id"], f"{name} grant id"),
        "grant_version": integer(raw["grant_version"], f"{name} grant version", 1, MAX_SAFE_INTEGER),
        "usage": validate_grant_usage(raw["usage"], f"{name} usage"),
        "reservation_ref": ident(raw["reservation_ref"], f"{name} reservation reference"),
        "reservation_expires_at": reservation_expires_at,
        "risk_verdict": verdict,
        "risk_reason": reason,
        "broker_preview_id": ident(raw["broker_preview_id"], f"{name} preview id"),
        "broker_preview_digest": digest(raw["broker_preview_digest"], f"{name} preview digest"),
        "evidence": validate_market_evidence(raw["evidence"], f"{name} evidence"),
        "evidence_age_ms": integer(raw["evidence_age_ms"], f"{name} evidence age", 0, 86_400_000),
        "worst_case_notional_minor": minor_units(raw["worst_case_notional_minor"], f"{name} worst case notional"),
        "approval_deadline": approval_deadline,
        "execution_state": validate_execution_state(raw["execution_state"], f"{name} execution state"),
        "recorded_at": recorded_at,
    }


APPROVAL_FIELDS = (
    "schema_version", "approval_id", "request_id", "intent_digest", "review_id", "review_digest", "connector",
    "provider_id", "opaque_account_ref", "grant_id", "grant_version", "policy_version", "symbol", "side", "quantity",
    "order_type", "limit_price_minor", "worst_case_notional_minor", "reservation_ref", "broker_preview_id",
    "activation_id", "artifact_id", "evidence_digest", "operator_id", "local_device_id", "operator_session_id",
    "approved_at", "expires_at", "consumed_at",
)


def _operator_approval(value: Any, name: str, schema: str, ticker: FieldCheck) -> dict[str, Any]:
    raw = closed(value, name, APPROVAL_FIELDS)
    approved_at = timestamp(raw["approved_at"], f"{name} approved_at")
    expires_at = timestamp(raw["expires_at"], f"{name} expires_at")
    ordered_window(approved_at, expires_at, f"{name} validity window")
    consumed_at = nullable(raw["consumed_at"], f"{name} consumed_at", timestamp)
    if consumed_at is not None and epoch_ms(consumed_at) < epoch_ms(approved_at):
        fail(f"{name} cannot be consumed before it was approved.")
    order_type = choice(raw["order_type"], ORDER_TYPES, f"{name} order type")
    limit_price = nullable(raw["limit_price_minor"], f"{name} limit price", minor_units)
    if order_type == "limit" and limit_price is None:
        fail(f"{name} limit order requires a limit price.")
    if order_type == "market" and limit_price is not None:
        fail(f"{name} market order must not carry a limit price.")
    return {
        "schema_version": schema_tag(raw["schema_version"], schema, name),
        "approval_id": ident(raw["approval_id"], f"{name} id"),
        "request_id": ident(raw["request_id"], f"{name} request id"),
        "intent_digest": digest(raw["intent_digest"], f"{name} intent digest"),
        "review_id": ident(raw["review_id"], f"{name} review id"),
        "review_digest": digest(raw["review_digest"], f"{name} review digest"),
        "connector": validate_connector_binding_ref(raw["connector"], f"{name} connector"),
        "provider_id": ident(raw["provider_id"], f"{name} provider"),
        "opaque_account_ref": opaque_ref(raw["opaque_account_ref"], f"{name} opaque account reference"),
        "grant_id": ident(raw["grant_id"], f"{name} grant id"),
        "grant_version": integer(raw["grant_version"], f"{name} grant version", 1, MAX_SAFE_INTEGER),
        "policy_version": text(raw["policy_version"], f"{name} policy version", 64),
        "symbol": ticker(raw["symbol"], f"{name} symbol"),
        "side": choice(raw["side"], ORDER_SIDES, f"{name} side"),
        "quantity": integer(raw["quantity"], f"{name} quantity", 1, MAX_QUANTITY),
        "order_type": order_type,
        "limit_price_minor": limit_price,
        "worst_case_notional_minor": minor_units(raw["worst_case_notional_minor"], f"{name} worst case notional"),
        "reservation_ref": ident(raw["reservation_ref"], f"{name} reservation reference"),
        "broker_preview_id": ident(raw["broker_preview_id"], f"{name} preview id"),
        "activation_id": ident(raw["activation_id"], f"{name} activation"),
        "artifact_id": ident(raw["artifact_id"], f"{name} artifact"),
        "evidence_digest": digest(raw["evidence_digest"], f"{name} evidence digest"),
        "operator_id": ident(raw["operator_id"], f"{name} operator"),
        "local_device_id": ident(raw["local_device_id"], f"{name} device"),
        "operator_session_id": ident(raw["operator_session_id"], f"{name} operator session"),
        "approved_at": approved_at,
        "expires_at": expires_at,
        "consumed_at": consumed_at,
    }


def validate_operator_approval(value: Any, name: str = "Operator approval") -> dict[str, Any]:
    return _operator_approval(value, name, APPROVAL_SCHEMA[0], symbol)


def validate_operator_approval_v2(value: Any, name: str = "Operator approval") -> dict[str, Any]:
    return _operator_approval(value, name, APPROVAL_SCHEMA[1], equity_ticker)


RECEIPT_FIELDS = (
    "schema_version", "request_id", "intent_id", "approval_id", "outcome", "opaque_order_ref", "opaque_account_ref",
    "symbol", "side", "quantity", "order_type", "activation_id", "artifact_id", "evidence_digest", "client_principal",
    "grant_id", "submitted_at", "settled_at", "fill", "reconciliation_state", "reason",
)


def _validate_fill(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("filled_quantity", "average_fill_price_minor", "confirmed_at"))
    return {
        "filled_quantity": integer(raw["filled_quantity"], f"{name} quantity", 1, MAX_QUANTITY),
        "average_fill_price_minor": minor_units(raw["average_fill_price_minor"], f"{name} average price"),
        "confirmed_at": timestamp(raw["confirmed_at"], f"{name} confirmed_at"),
    }


def _execution_receipt(value: Any, name: str, schema: str, ticker: FieldCheck) -> dict[str, Any]:
    raw = closed(value, name, RECEIPT_FIELDS)
    outcome = choice(raw["outcome"], EXECUTION_OUTCOMES, f"{name} outcome")
    fill = None if raw["fill"] is None else _validate_fill(raw["fill"], f"{name} fill")
    reconciliation = choice(raw["reconciliation_state"], RECONCILIATION_STATES, f"{name} reconciliation state")
    quantity = integer(raw["quantity"], f"{name} quantity", 1, MAX_QUANTITY)
    filled_outcome = outcome in ("filled", "partially_filled")
    if filled_outcome and fill is None:
        fail(f"{name} reports a fill without broker-confirmed fill facts.")
    if not filled_outcome and fill is not None:
        fail(f"{name} carries fill facts for an outcome that did not fill.")
    if fill is not None and fill["filled_quantity"] > quantity:
        fail(f"{name} filled more than it ordered.")
    if outcome == "filled" and fill is not None and fill["filled_quantity"] != quantity:
        fail(f"{name} reports a complete fill for a partial quantity.")
    if outcome == "partially_filled" and fill is not None and fill["filled_quantity"] >= quantity:
        fail(f"{name} reports a partial fill for the whole quantity.")
    if outcome == "ambiguous" and reconciliation == "not_required":
        fail(f"{name} cannot mark an ambiguous commit as needing no reconciliation.")
    reason = None if raw["reason"] is None else text(raw["reason"], f"{name} reason", 200)
    if outcome in ("refused", "ambiguous") and reason is None:
        fail(f"{name} must explain a refused or ambiguous outcome.")
    return {
        "schema_version": schema_tag(raw["schema_version"], schema, name),
        "request_id": ident(raw["request_id"], f"{name} request id"),
        "intent_id": ident(raw["intent_id"], f"{name} intent id"),
        "approval_id": ident(raw["approval_id"], f"{name} approval id"),
        "outcome": outcome,
        "opaque_order_ref": nullable(raw["opaque_order_ref"], f"{name} order reference", opaque_ref),
        "opaque_account_ref": opaque_ref(raw["opaque_account_ref"], f"{name} opaque account reference"),
        "symbol": ticker(raw["symbol"], f"{name} symbol"),
        "side": choice(raw["side"], ORDER_SIDES, f"{name} side"),
        "quantity": quantity,
        "order_type": choice(raw["order_type"], ORDER_TYPES, f"{name} order type"),
        "activation_id": ident(raw["activation_id"], f"{name} activation"),
        "artifact_id": ident(raw["artifact_id"], f"{name} artifact"),
        "evidence_digest": digest(raw["evidence_digest"], f"{name} evidence digest"),
        "client_principal": ident(raw["client_principal"], f"{name} client principal"),
        "grant_id": ident(raw["grant_id"], f"{name} grant id"),
        "submitted_at": nullable(raw["submitted_at"], f"{name} submitted_at", timestamp),
        "settled_at": nullable(raw["settled_at"], f"{name} settled_at", timestamp),
        "fill": fill,
        "reconciliation_state": reconciliation,
        "reason": reason,
    }


def validate_execution_receipt(value: Any, name: str = "Execution receipt") -> dict[str, Any]:
    return _execution_receipt(value, name, RECEIPT_SCHEMA[0], symbol)


def validate_execution_receipt_v2(value: Any, name: str = "Execution receipt") -> dict[str, Any]:
    return _execution_receipt(value, name, RECEIPT_SCHEMA[1], equity_ticker)


GRANT_FIELDS = (
    "schema_version", "grant_id", "grant_version", "client_principal", "provider_id", "opaque_account_ref",
    "execution_environment", "capabilities", "symbol_allowlist", "limits", "allowed_sides", "allowed_order_types",
    "confirmation", "state", "abuse_flagged", "issued_at", "expires_at",
)


def _trading_grant(value: Any, name: str, schema: str, ticker: FieldCheck) -> dict[str, Any]:
    raw = closed(value, name, GRANT_FIELDS)
    issued_at = timestamp(raw["issued_at"], f"{name} issued_at")
    expires_at = timestamp(raw["expires_at"], f"{name} expires_at")
    ordered_window(issued_at, expires_at, f"{name} validity window")
    capabilities = unique_list(raw["capabilities"], f"{name} capabilities", len(GRANT_CAPABILITIES),
                               lambda v, n: choice(v, GRANT_CAPABILITIES, n))
    if "commit_order" in capabilities and "review_order" not in capabilities:
        fail(f"{name} cannot grant commit without review.")
    return {
        "schema_version": schema_tag(raw["schema_version"], schema, name),
        "grant_id": ident(raw["grant_id"], f"{name} id"),
        "grant_version": integer(raw["grant_version"], f"{name} version", 1, MAX_SAFE_INTEGER),
        "client_principal": ident(raw["client_principal"], f"{name} client principal"),
        "provider_id": ident(raw["provider_id"], f"{name} provider"),
        "opaque_account_ref": opaque_ref(raw["opaque_account_ref"], f"{name} opaque account reference"),
        "execution_environment": choice(raw["execution_environment"], EXECUTION_ENVIRONMENTS, f"{name} execution environment"),
        "capabilities": capabilities,
        "symbol_allowlist": unique_list(raw["symbol_allowlist"], f"{name} symbol allowlist", 100, ticker),
        "limits": validate_limits(raw["limits"], f"{name} limits"),
        "allowed_sides": unique_list(raw["allowed_sides"], f"{name} sides", len(ORDER_SIDES), lambda v, n: choice(v, ORDER_SIDES, n)),
        "allowed_order_types": unique_list(raw["allowed_order_types"], f"{name} order types", len(ORDER_TYPES),
                                           lambda v, n: choice(v, ORDER_TYPES, n)),
        "confirmation": pinned(raw["confirmation"], "per_order", f"{name} confirmation"),
        "state": choice(raw["state"], GRANT_STATES, f"{name} state"),
        "abuse_flagged": boolean(raw["abuse_flagged"], f"{name} abuse flag"),
        "issued_at": issued_at,
        "expires_at": expires_at,
    }


def validate_trading_grant(value: Any, name: str = "Trading grant") -> dict[str, Any]:
    return _trading_grant(value, name, GRANT_SCHEMA[0], symbol)


def validate_trading_grant_v2(value: Any, name: str = "Trading grant") -> dict[str, Any]:
    return _trading_grant(value, name, GRANT_SCHEMA[1], equity_ticker)


BINDING_FIELDS = (
    "schema_version", "account_binding_id", "provider_id", "credential_ref", "encrypted_account_ref",
    "opaque_account_ref", "masked_label", "asset_capabilities", "connector_snapshot_digest", "selected_at",
    "binding_generation",
)


def _account_binding(value: Any, name: str, schema: str, label: FieldCheck) -> dict[str, Any]:
    raw = closed(value, name, BINDING_FIELDS)
    return {
        "schema_version": schema_tag(raw["schema_version"], schema, name),
        "account_binding_id": opaque_ref(raw["account_binding_id"], f"{name} binding id"),
        "provider_id": ident(raw["provider_id"], f"{name} provider"),
        "credential_ref": opaque_ref(raw["credential_ref"], f"{name} credential reference"),
        "encrypted_account_ref": opaque_ref(raw["encrypted_account_ref"], f"{name} encrypted account reference"),
        "opaque_account_ref": opaque_ref(raw["opaque_account_ref"], f"{name} opaque account reference"),
        "masked_label": label(raw["masked_label"], f"{name} masked label"),
        "asset_capabilities": unique_list(raw["asset_capabilities"], f"{name} asset capabilities", len(ASSET_CLASSES),
                                          lambda v, n: choice(v, ASSET_CLASSES, n)),
        "connector_snapshot_digest": digest(raw["connector_snapshot_digest"], f"{name} connector snapshot digest"),
        "selected_at": timestamp(raw["selected_at"], f"{name} selected_at"),
        "binding_generation": integer(raw["binding_generation"], f"{name} generation", 1, MAX_SAFE_INTEGER),
    }


def validate_account_binding(value: Any, name: str = "Account binding") -> dict[str, Any]:
    return _account_binding(value, name, BINDING_SCHEMA[0], frozen_masked_label)


def validate_account_binding_v2(value: Any, name: str = "Account binding") -> dict[str, Any]:
    return _account_binding(value, name, BINDING_SCHEMA[1], closed_masked_label)


V1_VALIDATORS: dict[str, Callable[[Any], dict[str, Any]]] = {
    PROPOSAL_SCHEMA[0]: validate_model_order_proposal,
    INTENT_SCHEMA[0]: validate_order_intent,
    APPROVAL_SCHEMA[0]: validate_operator_approval,
    RECEIPT_SCHEMA[0]: validate_execution_receipt,
    GRANT_SCHEMA[0]: validate_trading_grant,
    BINDING_SCHEMA[0]: validate_account_binding,
    REVIEW_SCHEMA: validate_order_review,
}
V2_VALIDATORS: dict[str, Callable[[Any], dict[str, Any]]] = {
    PROPOSAL_SCHEMA[1]: validate_model_order_proposal_v2,
    INTENT_SCHEMA[1]: validate_order_intent_v2,
    APPROVAL_SCHEMA[1]: validate_operator_approval_v2,
    RECEIPT_SCHEMA[1]: validate_execution_receipt_v2,
    GRANT_SCHEMA[1]: validate_trading_grant_v2,
    BINDING_SCHEMA[1]: validate_account_binding_v2,
}
V1_OF = {
    PROPOSAL_SCHEMA[1]: PROPOSAL_SCHEMA[0],
    INTENT_SCHEMA[1]: INTENT_SCHEMA[0],
    APPROVAL_SCHEMA[1]: APPROVAL_SCHEMA[0],
    RECEIPT_SCHEMA[1]: RECEIPT_SCHEMA[0],
    GRANT_SCHEMA[1]: GRANT_SCHEMA[0],
    BINDING_SCHEMA[1]: BINDING_SCHEMA[0],
}


# --- Chain decisions (approval.ts, grant.ts) ------------------------------------

CONSISTENT: dict[str, Any] = {"consistent": True}


def broken(reason: str) -> dict[str, Any]:
    return {"consistent": False, "reason": reason}


def review_refusal(review: dict[str, Any], now_ms: int) -> str | None:
    if review["risk_verdict"] != "pass":
        return "Risk review refused this order."
    if now_ms >= epoch_ms(review["approval_deadline"]):
        return "Approval window expired."
    if now_ms >= epoch_ms(review["reservation_expires_at"]):
        return "Reservation expired."
    return None


def approval_refusal(approval: dict[str, Any], now_ms: int) -> str | None:
    if approval["consumed_at"] is not None:
        return "Approval was already used."
    if now_ms >= epoch_ms(approval["expires_at"]):
        return "Approval expired."
    return None


def connector_binding_matches(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return all(a[field] == b[field] for field in CONNECTOR_REF_FIELDS)


def approval_chain_verdict(intent: dict[str, Any], review: dict[str, Any], approval: dict[str, Any], now_ms: int) -> dict[str, Any]:
    """verifyApprovalChain's logic. It never reads a schema tag."""
    intent_digest = digest_of(intent)
    review_digest = digest_of(review)
    if not digest_equals(review["intent_digest"], intent_digest):
        return broken("Review does not answer this intent.")
    if not digest_equals(approval["intent_digest"], intent_digest):
        return broken("Approval does not bind this intent.")
    if not digest_equals(approval["review_digest"], review_digest):
        return broken("Approval does not bind this exact review.")
    if approval["review_id"] != review["review_id"]:
        return broken("Approval does not bind this review.")
    if intent["request_id"] != review["request_id"] or review["request_id"] != approval["request_id"]:
        return broken("Request identity differs across the chain.")
    if approval["intent_digest"] != review["intent_digest"]:
        return broken("Approval and review disagree about the intent.")
    if not connector_binding_matches(intent["connector"], review["connector"]):
        return broken("Review connector binding differs from the intent.")
    if not connector_binding_matches(review["connector"], approval["connector"]):
        return broken("Approval connector binding differs from the review.")
    if approval["provider_id"] != approval["connector"]["provider_id"]:
        return broken("Approval provider disagrees with its own connector binding.")
    if approval["grant_id"] != review["grant_id"] or approval["grant_version"] != review["grant_version"]:
        return broken("Grant identity or version changed after review.")
    if approval["reservation_ref"] != review["reservation_ref"]:
        return broken("Reservation changed after review.")
    if approval["broker_preview_id"] != review["broker_preview_id"]:
        return broken("Broker preview changed after review.")
    if approval["evidence_digest"] != review["evidence"]["evidence_digest"]:
        return broken("Market evidence changed after review.")
    if approval["evidence_digest"] != intent["evidence"]["evidence_digest"]:
        return broken("Approved evidence differs from the evidence the intent was formed on.")
    if any(approval[field] != intent[field] for field in ("symbol", "side", "quantity", "order_type", "limit_price_minor")):
        return broken("Approved order terms differ from the intent.")
    if approval["worst_case_notional_minor"] != review["worst_case_notional_minor"]:
        return broken("Approved notional differs from the reviewed notional.")
    if approval["activation_id"] != intent["activation_id"] or approval["artifact_id"] != intent["artifact_id"]:
        return broken("Strategy activation or artifact changed after review.")
    if epoch_ms(approval["expires_at"]) > epoch_ms(review["reservation_expires_at"]):
        return broken("Approval outlives its reservation.")
    reason = review_refusal(review, now_ms) or approval_refusal(approval, now_ms)
    if reason is not None:
        return broken(reason)
    if now_ms >= epoch_ms(intent["expires_at"]):
        return broken("Intent expired.")
    return CONSISTENT


def grant_refusal(grant: dict[str, Any], order: dict[str, Any], usage: dict[str, Any], now_ms: int) -> str | None:
    """grantPermits: None when the grant admits the order, otherwise the reason."""
    if grant["state"] != "active":
        return f"Grant is {grant['state']}."
    if grant["abuse_flagged"]:
        return "Grant is flagged for abuse review."
    if now_ms >= epoch_ms(grant["expires_at"]):
        return "Grant has expired."
    if "commit_order" not in grant["capabilities"]:
        return "Grant does not authorize order commits."
    if not grant["symbol_allowlist"]:
        return "Grant has no permitted symbols."
    if order["symbol"] not in grant["symbol_allowlist"]:
        return "Symbol is outside the grant allowlist."
    if grant["execution_environment"] != order["execution_environment"]:
        return "Order environment does not match the grant environment."
    if order["side"] not in grant["allowed_sides"]:
        return "Side is not permitted by the grant."
    if order["order_type"] not in grant["allowed_order_types"]:
        return "Order type is not permitted by the grant."
    limits = grant["limits"]
    if order["worst_case_notional_minor"] > limits["max_notional_per_order_minor"]:
        return "Order exceeds the per-order notional limit."
    if usage["notional_today_minor"] + order["worst_case_notional_minor"] > limits["max_notional_per_day_minor"]:
        return "Order exceeds the remaining daily notional limit."
    if order["resulting_position_notional_minor"] > limits["max_position_notional_per_symbol_minor"]:
        return "Order exceeds the per-symbol position notional limit."
    if usage["orders_today"] + 1 > limits["max_orders_per_day"]:
        return "Order exceeds the daily order count limit."
    if usage["open_orders"] + 1 > limits["max_open_orders"]:
        return "Order exceeds the open order limit."
    return None


def commit_authority_verdict(request: dict[str, Any]) -> dict[str, Any]:
    """verifyCommitAuthority's logic. It never reads a schema tag."""
    now, grant, usage, binding = request["now"], request["grant"], request["usage"], request["binding"]
    intent, review, approval = request["intent"], request["review"], request["approval"]
    chain = approval_chain_verdict(intent, review, approval, now)
    if not chain["consistent"]:
        return chain
    connector = intent["connector"]
    if connector["account_binding_id"] != binding["account_binding_id"]:
        return broken("Order is bound to a different account binding.")
    if connector["provider_id"] != binding["provider_id"]:
        return broken("Order provider differs from the binding.")
    if connector["binding_generation"] != binding["binding_generation"]:
        return broken("Account was re-linked after this order was reviewed.")
    if approval["opaque_account_ref"] != binding["opaque_account_ref"]:
        return broken("Approved account differs from the bound account.")
    if grant["grant_id"] != review["grant_id"] or grant["grant_version"] != review["grant_version"]:
        return broken("Grant changed after review.")
    if grant["opaque_account_ref"] != binding["opaque_account_ref"]:
        return broken("Grant is for a different account.")
    if grant["provider_id"] != binding["provider_id"]:
        return broken("Grant is for a different provider.")
    if grant["execution_environment"] != connector["execution_environment"]:
        return broken("Grant environment differs from the order environment.")
    effective = review["execution_state"]["effective_mode"]
    if effective in HALTED:
        return broken(f"Execution is halted ({effective}).")
    if effective not in SUBMITTING:
        return broken(f"Effective mode {effective} does not permit submission.")
    order = {
        "symbol": intent["symbol"], "side": intent["side"], "order_type": intent["order_type"],
        "worst_case_notional_minor": review["worst_case_notional_minor"],
        "resulting_position_notional_minor": request["resulting_position_notional_minor"],
        "execution_environment": connector["execution_environment"],
    }
    reason = grant_refusal(grant, order, usage, now)
    return CONSISTENT if reason is None else broken(reason)


def verify_executable_approval_chain(intent: dict[str, Any], review: dict[str, Any], approval: dict[str, Any], now_ms: int) -> dict[str, Any]:
    """verifyExecutableApprovalChain: a /2 intent and a /2 approval, then the shared logic."""
    if intent["schema_version"] != INTENT_SCHEMA[1] or approval["schema_version"] != APPROVAL_SCHEMA[1]:
        return broken(EXECUTABLE_CHAIN_REFUSAL)
    return approval_chain_verdict(intent, review, approval, now_ms)


def verify_executable_commit_authority(request: dict[str, Any]) -> dict[str, Any]:
    """verifyExecutableCommitAuthority: every versioned member at /2, then the shared logic."""
    if (
        request["intent"]["schema_version"] != INTENT_SCHEMA[1]
        or request["approval"]["schema_version"] != APPROVAL_SCHEMA[1]
        or request["binding"]["schema_version"] != BINDING_SCHEMA[1]
        or request["grant"]["schema_version"] != GRANT_SCHEMA[1]
    ):
        return broken(EXECUTABLE_CHAIN_REFUSAL)
    return commit_authority_verdict(request)
