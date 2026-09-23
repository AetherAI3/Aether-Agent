#!/usr/bin/env python3
"""Reproduce the agent-browser-ats-order/1 golden fixture in Python.

    python test/fixtures/ats_browser_order_verify.py

Runs every vector in ats_browser_order_golden.json through the independent
mirror in ats_browser_order_wire.py and ats_browser_order_gate.py and
requires byte-identical digests and identical refusal messages; see
docs/CONTRACTS.md section 4.
"""

from __future__ import annotations

import copy
import json
import pathlib
import sys
from typing import Any, Callable

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from ats_browser_order_gate import (  # noqa: E402
    ANSWERS,
    adapter_pins_equal,
    derive_binding_state,
    requires_reconciliation,
    verify_browser_result,
)
from ats_browser_order_wire import (  # noqa: E402
    OPERATIONS,
    ContractError,
    digest_of,
    validate_call,
    validate_result,
)


# --- Harness: reproduce the golden fixture -------------------------------------

FIXTURE = pathlib.Path(__file__).with_name("ats_browser_order_golden.json")

# Named floors equal to real coverage, independent of the data they guard.
REQUIRED_CALL_REJECT_CATEGORIES = (
    "unknown_operation", "selector", "coordinate", "url", "script", "free_text",
    "authority_injection", "identity", "binding", "environment", "deadline",
    "money", "quantity", "shape",
)
REQUIRED_RESULT_REJECT_CATEGORIES = (
    "status", "page_content", "account_number", "origin", "session", "ticket_digest",
    "fill_claim", "order_state", "quote", "positions", "shape",
)
REQUIRED_MISMATCH_CATEGORIES = (
    "adapter_digest", "adapter_version", "call_identity", "session_generation",
    "principal", "binding", "ticket_field", "symbol", "order_ref", "deadline",
    "replay",
)


def apply_patches(document: dict[str, Any], patches: list[dict[str, Any]]) -> dict[str, Any]:
    if not patches:
        raise AssertionError("a vector must change something")
    patched = copy.deepcopy(document)
    for patch in patches:
        path = patch["path"]
        cursor: Any = patched
        for key in path[:-1]:
            cursor = cursor[int(key)] if isinstance(cursor, list) else cursor[key]
        leaf: Any = int(path[-1]) if isinstance(cursor, list) else path[-1]
        if patch.get("delete"):
            del cursor[leaf]
        else:
            cursor[leaf] = copy.deepcopy(patch["value"])
    return patched


def refusal_of(action: Callable[[], Any]) -> str | None:
    try:
        action()
    except ContractError as error:
        return str(error)
    return None


def check_fixture(fixture: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    if fixture.get("schema_version") != "aether.ats.browser-order-golden/1":
        failures.append("unexpected fixture schema")
    if fixture.get("protocol") != "agent-browser-ats-order/1":
        failures.append("unexpected protocol")
    if fixture.get("canonical_profile") != "rfc8785/1":
        failures.append("unexpected canonical profile")

    exchanges = {entry["name"]: entry for entry in fixture["exchanges"]}
    for name, exchange in exchanges.items():
        try:
            call = validate_call(exchange["call"])
            result = validate_result(exchange["result"])
        except ContractError as error:
            failures.append(f"{name}: refused a faithful exchange: {error}")
            continue
        if digest_of(call) != exchange["call_digest"]:
            failures.append(f"{name}: call digest drifted")
        if digest_of(result) != exchange["result_digest"]:
            failures.append(f"{name}: result digest drifted")
        if not any(adapter_pins_equal(pin, call["adapter"]) for pin in fixture["adapter_registry"]):
            failures.append(f"{name}: adapter outside the qualified registry")
        verdict = verify_browser_result(call, result)
        if verdict != ANSWERS:
            failures.append(f"{name}: gate refused a faithful answer: {verdict}")
        state = derive_binding_state(result["data"]) if result["operation"] == "verify_session" and result["status"] == "ok" else None
        if state != exchange["expect"]["binding_state"]:
            failures.append(f"{name}: binding state {state!r}")
        if requires_reconciliation(result) != exchange["expect"]["requires_reconciliation"]:
            failures.append(f"{name}: reconciliation expectation")

    covered = {exchange["call"]["operation"] for exchange in fixture["exchanges"]}
    failures.extend(f"no exchange exercises {operation}" for operation in OPERATIONS if operation not in covered)

    groups = (
        ("call_rejects", REQUIRED_CALL_REJECT_CATEGORIES, "call", validate_call),
        ("result_rejects", REQUIRED_RESULT_REJECT_CATEGORIES, "result", validate_result),
    )
    for key, required, side, validator in groups:
        categories = {entry["category"] for entry in fixture[key]}
        failures.extend(f"no {key} entry covers {category}" for category in required if category not in categories)
        for reject in fixture[key]:
            base = exchanges[reject["exchange"]][side]
            if refusal_of(lambda: validator(base)) is not None:
                failures.append(f"{reject['name']}: control document refused")
            message = refusal_of(lambda: validator(apply_patches(base, reject["patches"])))
            if message is None or reject["expect"] not in message:
                failures.append(f"{reject['name']}: expected {reject['expect']!r}, got {message!r}")

    categories = {entry["category"] for entry in fixture["mismatches"]}
    failures.extend(f"no mismatch covers {category}" for category in REQUIRED_MISMATCH_CATEGORIES if category not in categories)
    for mismatch in fixture["mismatches"]:
        exchange = exchanges[mismatch["exchange"]]
        raw_call = apply_patches(exchange["call"], mismatch["patches"]) if mismatch["target"] == "call" else exchange["call"]
        raw_result = apply_patches(exchange["result"], mismatch["patches"]) if mismatch["target"] == "result" else exchange["result"]
        try:
            verdict = verify_browser_result(validate_call(raw_call), validate_result(raw_result))
        except ContractError as error:
            failures.append(f"{mismatch['name']}: refused by shape, not by the gate: {error}")
            continue
        if verdict["answers"] or mismatch["expect"] not in verdict["reason"]:
            failures.append(f"{mismatch['name']}: expected {mismatch['expect']!r}, got {verdict}")
    return failures


def main() -> int:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    failures = check_fixture(fixture)
    total = (len(fixture["exchanges"]) + len(fixture["call_rejects"])
             + len(fixture["result_rejects"]) + len(fixture["mismatches"]))
    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        print(f"\n{len(failures)} problem(s) across {total} vectors: the Python mirror disagrees with the fixture.")
        return 1
    print(f"OK: {total} browser order vectors reproduced by an independent Python implementation.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
