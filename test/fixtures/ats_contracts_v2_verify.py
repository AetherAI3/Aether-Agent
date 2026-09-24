#!/usr/bin/env python3
"""Reproduce the Spec 1 /2 closure fixture in Python.

    python test/fixtures/ats_contracts_v2_verify.py

Runs every vector in ats_contracts_v2_golden.json through the independent
mirror in ats_contracts_v2_wire.py and requires byte-identical digests and
identical refusal messages; see docs/CONTRACTS.md, "Spec 1 /2 closure".
"""

from __future__ import annotations

import copy
import json
import pathlib
import sys
from typing import Any, Callable

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from ats_contracts_v2_wire import (  # noqa: E402
    APPROVAL_SCHEMA,
    BINDING_SCHEMA,
    EXECUTABLE_CHAIN_REFUSAL,
    EXECUTABLE_MEMBER_REFUSAL,
    GRANT_SCHEMA,
    INTENT_SCHEMA,
    PROPOSAL_SCHEMA,
    RECEIPT_SCHEMA,
    V1_OF,
    V1_VALIDATORS,
    V2_VALIDATORS,
    ContractError,
    _approval_chain_verdict,
    _commit_authority_verdict,
    canonical_json,
    digest_of,
    epoch_ms,
    optional_binding_v2,
    validate_account_binding_v2,
    validate_grant_usage,
    verify_executable_approval_chain,
    verify_executable_commit_authority,
)

FIXTURE = pathlib.Path(__file__).with_name("ats_contracts_v2_golden.json")

# Named floors equal to the coverage that exists, independent of the data they guard.
V2_SCHEMAS = tuple(sorted(V2_VALIDATORS))
TICKER_SCHEMAS = (PROPOSAL_SCHEMA[1], INTENT_SCHEMA[1], APPROVAL_SCHEMA[1], RECEIPT_SCHEMA[1], GRANT_SCHEMA[1])
LABEL_SCHEMAS = (BINDING_SCHEMA[1],)
FROZEN_TICKER_CASES = ("HTTPS://X", "A:B", "X/Y", "ABCDEFG", "BRK.BBBBB", "A^B", "1ABC")
REJECTED_TICKER_CASES = ("spy",)
FROZEN_LABEL_CASES = (
    "fullwidth_digits", "arabic_indic_digits", "cyrillic_confusable",
    "right_to_left_override", "zero_width_space", "byte_order_mark",
)
REJECTED_LABEL_CASES = ("five_ascii_digits",)
VERSION_CASES = ("all_v2", "intent_v1", "approval_v1", "binding_v1", "grant_v1", "all_v1")
MEMBER_CASES = (
    "retagged_v1_chain", "retagged_v1_binding", "retagged_v1_grant", "unvalidated_intent", "unvalidated_review",
    "unvalidated_approval", "unvalidated_usage", "unvalidated_clock", "unvalidated_position",
)
# Distinct refusal messages the branch cases pin: one per reachable refusal branch.
BRANCH_MESSAGE_FLOOR = 50
MIN_ACCEPTS = 8


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
        cursor[leaf] = copy.deepcopy(patch["value"])
    return patched


def retag(document: dict[str, Any], tag: str) -> dict[str, Any]:
    return {**copy.deepcopy(document), "schema_version": tag}


def refusal_of(action: Callable[[], Any]) -> str | None:
    try:
        action()
    except ContractError as error:
        return str(error)
    return None


def at_own_version(document: dict[str, Any]) -> dict[str, Any]:
    tag = document.get("schema_version")
    validate = V1_VALIDATORS.get(tag) or V2_VALIDATORS.get(tag)
    if validate is None:
        raise AssertionError(f"no validator for {tag!r}")
    return validate(document)


def check_coverage(fixture: dict[str, Any]) -> list[str]:
    missing: list[str] = []

    def has(section: str, tag: str, category: str, case: str) -> bool:
        return any(e["schema_version"] == tag and e["category"] == category and e["case"] == case for e in fixture[section])

    for tag in TICKER_SCHEMAS:
        missing += [f"{tag} frozen ticker {c}" for c in FROZEN_TICKER_CASES if not has("frozen_weakness", tag, "ticker", c)]
        missing += [f"{tag} ticker reject {c}" for c in REJECTED_TICKER_CASES if not has("rejects", tag, "ticker", c)]
    for tag in LABEL_SCHEMAS:
        missing += [f"{tag} frozen label {c}" for c in FROZEN_LABEL_CASES if not has("frozen_weakness", tag, "label", c)]
        missing += [f"{tag} label reject {c}" for c in REJECTED_LABEL_CASES if not has("rejects", tag, "label", c)]
    missing += [f"{tag} /1 tag reject" for tag in V2_SCHEMAS if not has("rejects", tag, "schema_tag", "v1_tag")]
    cases = fixture["chains"]["cases"]
    for category, ids in (("version", VERSION_CASES), ("member", MEMBER_CASES)):
        present = {entry["case"] for entry in cases if entry["category"] == category}
        missing += [f"{category} chain case {c}" for c in ids if c not in present]
    branch_messages = {entry["commit_expect"] for entry in cases if entry["category"] == "branch"}
    if len(branch_messages) < BRANCH_MESSAGE_FLOOR:
        missing.append(f"branch messages fell to {len(branch_messages)}")
    if len(fixture["accepts"]) < MIN_ACCEPTS:
        missing.append(f"accepts fell to {len(fixture['accepts'])}")
    return missing


def check_vectors(fixture: dict[str, Any], bases: dict[str, dict[str, Any]]) -> list[str]:
    """Canonical /2 documents, their /1 re-tags, and the strict variants that must stay accepted."""
    failures: list[str] = []
    if tuple(sorted(bases)) != V2_SCHEMAS:
        failures.append(f"vectors cover {sorted(bases)}, expected {list(V2_SCHEMAS)}")
    for entry in fixture["vectors"]:
        tag = entry["schema_version"]
        try:
            parsed = V2_VALIDATORS[tag](entry["document"])
        except ContractError as error:
            failures.append(f"{tag}: refused its canonical vector: {error}")
            continue
        if canonical_json(parsed) != entry["canonical"]:
            failures.append(f"{tag}: canonical bytes drifted")
        if digest_of(parsed) != entry["canonical_digest"]:
            failures.append(f"{tag}: digest drifted")
        v1_tag = V1_OF[tag]
        message = refusal_of(lambda: V1_VALIDATORS[v1_tag](retag(entry["document"], v1_tag)))
        if message is not None:
            failures.append(f"{v1_tag}: refused a /2-valid document: {message}")
        reverse = refusal_of(lambda: V1_VALIDATORS[v1_tag](entry["document"]))
        if reverse is None or not reverse.endswith(f"must declare schema {v1_tag}."):
            failures.append(f"{v1_tag}: accepted a /2 tag: {reverse!r}")
    for entry in fixture["accepts"]:
        tag = entry["schema_version"]
        document = apply_patches(bases[tag], entry["patches"])
        strict = refusal_of(lambda: V2_VALIDATORS[tag](document))
        if strict is not None:
            failures.append(f"{entry['name']}: /2 refused: {strict}")
        frozen = refusal_of(lambda: V1_VALIDATORS[V1_OF[tag]](retag(document, V1_OF[tag])))
        if frozen is not None:
            failures.append(f"{entry['name']}: /1 refused: {frozen}")
    return failures


def check_refusals(fixture: dict[str, Any], bases: dict[str, dict[str, Any]]) -> list[str]:
    """Exact-message rejects (with their /1 outcome) and frozen /1 weaknesses."""
    failures: list[str] = []
    for entry in fixture["rejects"]:
        tag = entry["schema_version"]
        if refusal_of(lambda: V2_VALIDATORS[tag](bases[tag])) is not None:
            failures.append(f"{entry['name']}: control document refused")
        message = refusal_of(lambda: V2_VALIDATORS[tag](apply_patches(bases[tag], entry["patches"])))
        if message != entry["expect"]:
            failures.append(f"{entry['name']}: expected {entry['expect']!r}, got {message!r}")
        if entry["category"] == "schema_tag":
            continue
        v1_tag, v1_expect = entry.get("v1_schema_version"), entry.get("v1_expect")
        if v1_tag is None or v1_expect is None:
            failures.append(f"{entry['name']}: a ticker or label reject must state the /1 outcome")
            continue
        v1_message = refusal_of(lambda: V1_VALIDATORS[v1_tag](apply_patches(retag(bases[tag], v1_tag), entry["patches"])))
        if v1_message != v1_expect:
            failures.append(f"{entry['name']}: /1 expected {v1_expect!r}, got {v1_message!r}")
    for entry in fixture["frozen_weakness"]:
        tag, v1_tag = entry["schema_version"], entry["v1_schema_version"]
        message = refusal_of(lambda: V2_VALIDATORS[tag](apply_patches(bases[tag], entry["patches"])))
        if message != entry["expect"]:
            failures.append(f"{entry['name']}: /2 expected {entry['expect']!r}, got {message!r}")
        v1_message = refusal_of(lambda: V1_VALIDATORS[v1_tag](apply_patches(retag(bases[tag], v1_tag), entry["patches"])))
        if v1_message is not None:
            failures.append(f"{entry['name']}: /1 no longer accepts it ({v1_message}); the /1 freeze changed")
    return failures


def check_optional_binding(fixture: dict[str, Any], bases: dict[str, dict[str, Any]]) -> list[str]:
    failures: list[str] = []
    binding = bases[BINDING_SCHEMA[1]]
    if optional_binding_v2(None) is not None:
        failures.append("optional_binding_v2 did not pass through an absent binding")
    if digest_of(optional_binding_v2(binding)) != digest_of(validate_account_binding_v2(binding)):
        failures.append("optional_binding_v2 changed a valid binding")
    override = next((e for e in fixture["frozen_weakness"] if e["case"] == "right_to_left_override"), None)
    if override is None:
        failures.append("the direction-override label vector left the fixture")
    elif refusal_of(lambda: optional_binding_v2(apply_patches(binding, override["patches"]))) != override["expect"]:
        failures.append("optional_binding_v2 accepted a direction-override label")
    if refusal_of(lambda: optional_binding_v2(retag(binding, BINDING_SCHEMA[0]))) != f"Account binding must declare schema {BINDING_SCHEMA[1]}.":
        failures.append("optional_binding_v2 accepted a /1 binding")
    return failures


# --- Chains -------------------------------------------------------------------------


def chain_document(chains: dict[str, Any], key: str) -> dict[str, Any]:
    entry = chains["documents"].get(key) or chains["raw_documents"].get(key)
    if entry is None:
        raise AssertionError(f"missing chain document {key}")
    return copy.deepcopy(entry["document"])


def request_of(chains: dict[str, Any], case: dict[str, Any]) -> dict[str, Any]:
    """A raw case hands the gates the parsed JSON untouched; every other case the validators' output."""
    def load(key: str) -> dict[str, Any]:
        document = chain_document(chains, key)
        return document if case["raw"] else at_own_version(document)

    usage = copy.deepcopy(case.get("usage", chains["usage"]))
    return {
        "now": case["now_ms"] if "now_ms" in case else epoch_ms(case.get("now", chains["now"])),
        "usage": usage if case["raw"] else validate_grant_usage(usage),
        "resulting_position_notional_minor": case.get("resulting_position_notional_minor", chains["resulting_position_notional_minor"]),
        **{role: load(key) for role, key in case["members"].items()},
    }


def reason_of(verdict: dict[str, Any]) -> str | None:
    return None if verdict["consistent"] else verdict["reason"]


def version_blind(request: dict[str, Any]) -> tuple[str | None, str | None]:
    """The shared logic alone: it never reads a tag or re-validates, so it is the control."""
    return (
        reason_of(_approval_chain_verdict(request["intent"], request["review"], request["approval"], request["now"])),
        reason_of(_commit_authority_verdict(request)),
    )


def executable(request: dict[str, Any]) -> tuple[str | None, str | None]:
    return (
        reason_of(verify_executable_approval_chain(request["intent"], request["review"], request["approval"], request["now"])),
        reason_of(verify_executable_commit_authority(request)),
    )


def check_chain_documents(chains: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    for key, entry in chains["documents"].items():
        try:
            parsed = at_own_version(entry["document"])
        except ContractError as error:
            failures.append(f"chain document {key}: refused: {error}")
            continue
        if digest_of(parsed) != entry["canonical_digest"]:
            failures.append(f"chain document {key}: digest drifted")
    for key, entry in chains["raw_documents"].items():
        document = entry["document"]
        if digest_of(document) != entry["canonical_digest"]:
            failures.append(f"raw document {key}: digest drifted")
        if refusal_of(lambda: at_own_version(document)) is None:
            failures.append(f"raw document {key}: validates at its own tag, so it is not raw")
        if key.startswith("retagged_v1_"):
            v1_tag = V1_OF.get(document.get("schema_version"))
            if v1_tag is None:
                failures.append(f"raw document {key}: is not tagged /2")
            elif refusal_of(lambda: V1_VALIDATORS[v1_tag](retag(document, v1_tag))) is not None:
                failures.append(f"raw document {key}: its content is not /1-valid")
    return failures


def check_chains(fixture: dict[str, Any]) -> list[str]:
    chains = fixture["chains"]
    failures = check_chain_documents(chains)
    if chains["refusals"]["version"] != EXECUTABLE_CHAIN_REFUSAL:
        failures.append("the version refusal differs from the fixture")
    if chains["refusals"]["member"] != EXECUTABLE_MEMBER_REFUSAL:
        failures.append("the member refusal differs from the fixture")
    fixed_for = {"version": EXECUTABLE_CHAIN_REFUSAL, "member": EXECUTABLE_MEMBER_REFUSAL}
    for case in chains["cases"]:
        name, category = case["case"], case["category"]
        if case["raw"] != (category == "member"):
            failures.append(f"{name}: only member cases are raw")
        try:
            request = request_of(chains, case)
        except (ContractError, AssertionError) as error:
            failures.append(f"{name}: could not build the request: {error}")
            continue
        expected = (case["approval_chain_expect"], case["commit_expect"])
        blind = version_blind(request)
        if category == "branch":
            if blind != expected:
                failures.append(f"{name}: version-blind expected {expected!r}, got {blind!r}")
        else:
            if blind != (None, None):
                failures.append(f"{name}: not single-cause; the version-blind logic refuses it: {blind!r}")
            if any(value not in (None, fixed_for[category]) for value in expected):
                failures.append(f"{name}: pins a message other than the fixed {category} refusal")
        verdict = executable(request)
        if verdict[0] != expected[0]:
            failures.append(f"{name}: approval chain expected {expected[0]!r}, got {verdict[0]!r}")
        if verdict[1] != expected[1]:
            failures.append(f"{name}: commit expected {expected[1]!r}, got {verdict[1]!r}")
    return failures


def check_fixture(fixture: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    if fixture.get("schema_version") != "aether.ats.spec1-v2-golden/1":
        failures.append("unexpected fixture schema")
    if fixture.get("canonical_profile") != "rfc8785/1":
        failures.append("unexpected canonical profile")
    bases = {entry["schema_version"]: entry["document"] for entry in fixture["vectors"]}
    failures += check_coverage(fixture)
    failures += check_vectors(fixture, bases)
    failures += check_refusals(fixture, bases)
    failures += check_optional_binding(fixture, bases)
    failures += check_chains(fixture)
    return failures


def main() -> int:
    raw = FIXTURE.read_bytes()
    failures = [f"fixture byte {index} is above 126" for index, byte in enumerate(raw) if byte > 126][:1]
    fixture = json.loads(raw.decode("ascii", errors="replace"))
    failures += check_fixture(fixture)
    chains = fixture["chains"]
    counts = {
        "vectors": len(fixture["vectors"]),
        "accepts": len(fixture["accepts"]),
        "rejects": len(fixture["rejects"]),
        "frozen_weakness": len(fixture["frozen_weakness"]),
        "chain_documents": len(chains["documents"]),
        "raw_documents": len(chains["raw_documents"]),
        "chain_cases": len(chains["cases"]),
    }
    total = sum(counts.values())
    breakdown = ", ".join(f"{count} {name}" for name, count in counts.items())
    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        print(f"\n{len(failures)} problem(s) across {total} vectors ({breakdown}): the Python mirror disagrees with the fixture.")
        return 1
    print(f"OK: {total} Spec 1 /2 closure vectors ({breakdown}) reproduced by an independent Python implementation.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
