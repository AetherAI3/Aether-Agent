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
    GRANT_SCHEMA,
    INTENT_SCHEMA,
    PROPOSAL_SCHEMA,
    RECEIPT_SCHEMA,
    V1_OF,
    V1_VALIDATORS,
    V2_VALIDATORS,
    ContractError,
    approval_chain_verdict,
    canonical_json,
    commit_authority_verdict,
    digest_of,
    epoch_ms,
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
CHAIN_CASES = ("all_v2", "intent_v1", "approval_v1", "binding_v1", "grant_v1", "all_v1")
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
    cases = {entry["case"] for entry in fixture["chains"]["cases"]}
    missing += [f"chain case {c}" for c in CHAIN_CASES if c not in cases]
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


def check_chains(fixture: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    chains = fixture["chains"]
    parsed: dict[str, dict[str, Any]] = {}
    for key, entry in chains["documents"].items():
        try:
            parsed[key] = at_own_version(entry["document"])
        except ContractError as error:
            failures.append(f"chain document {key}: refused: {error}")
            continue
        if digest_of(parsed[key]) != entry["canonical_digest"]:
            failures.append(f"chain document {key}: digest drifted")
    now = epoch_ms(chains["now"])
    usage = validate_grant_usage(chains["usage"])
    for case in chains["cases"]:
        members = {role: parsed.get(key) for role, key in case["members"].items()}
        if any(document is None for document in members.values()):
            failures.append(f"{case['name']}: a member document did not parse")
            continue
        request = {**members, "now": now, "usage": usage,
                   "resulting_position_notional_minor": chains["resulting_position_notional_minor"]}
        # Single-cause control: the version-blind logic accepts every case.
        blind = [approval_chain_verdict(members["intent"], members["review"], members["approval"], now),
                 commit_authority_verdict(request)]
        for verdict in blind:
            if not verdict["consistent"]:
                failures.append(f"{case['name']}: not single-cause; the version-blind logic refuses it: {verdict['reason']}")
        results = (
            ("approval chain", verify_executable_approval_chain(members["intent"], members["review"], members["approval"], now),
             case["approval_chain_expect"]),
            ("commit", verify_executable_commit_authority(request), case["commit_expect"]),
        )
        for label, verdict, expected in results:
            reason = None if verdict["consistent"] else verdict["reason"]
            if reason != expected:
                failures.append(f"{case['name']}: {label} expected {expected!r}, got {reason!r}")
            if expected is not None and expected != EXECUTABLE_CHAIN_REFUSAL:
                failures.append(f"{case['name']}: {label} pins a message other than the fixed refusal")
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
