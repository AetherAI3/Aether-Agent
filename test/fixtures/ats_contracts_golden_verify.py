#!/usr/bin/env python3
"""Reference RFC 8785 (JCS) mirror for the ATS contract golden vectors.

This is the Python half of the drift detector described in docs/CONTRACTS.md
section 2. It is an INDEPENDENT implementation — it imports nothing from the
TypeScript side — so agreement between the two is evidence that the canonical
form is reproducible across languages rather than an artifact of one encoder.

Run it against the committed fixture:

    python test/fixtures/ats_contracts_golden_verify.py

ATSv2 should lift these functions (not the harness) into its own test suite.

THE TRAP THIS EXISTS TO CATCH: RFC 8785 sorts object keys by UTF-16 code unit.
Python's built-in ``sorted()`` compares code points, and the two disagree
whenever an astral character (U+10000 and up) meets a BMP character at or above
U+E000 — because the astral character's UTF-16 form begins with a high
surrogate (0xD800), which is numerically *below* U+FFFF. Sorting on the
UTF-16-BE encoding restores the required order. The fixture contains a vector
that fails loudly if this is got wrong, and passes everywhere else.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import sys
from typing import Any


def _utf16_sort_key(key: str) -> bytes:
    """Order keys by UTF-16 code unit, as RFC 8785 section 3.2.3 requires."""
    return key.encode("utf-16-be", errors="surrogatepass")


def _encode_string(value: str) -> str:
    # json.dumps with ensure_ascii=False emits exactly the escaping RFC 8785
    # section 3.2.2.2 prescribes: the short escapes for " \ \b \f \n \r \t,
    # lowercase \u00xx for the remaining C0 controls, and every other code
    # point literal.
    value.encode("utf-8")  # raises on a lone surrogate, which has no UTF-8 form
    return json.dumps(value, ensure_ascii=False)


def _encode_number(value: Any) -> str:
    if isinstance(value, int):
        return str(value)
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError("NaN and Infinity have no JSON representation")
    if value == 0:
        return "0"  # normalizes -0.0
    # Python's repr and ECMAScript Number::toString are both shortest
    # round-trip forms and agree on the values these contracts carry.
    return repr(value)


def canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):  # bool is a subclass of int; check it first
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _encode_number(value)
    if isinstance(value, str):
        return _encode_string(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=_utf16_sort_key)
        return "{" + ",".join(f"{_encode_string(k)}:{canonical_json(value[k])}" for k in keys) + "}"
    raise TypeError(f"canonical json: unsupported value of type {type(value).__name__}")


def digest_of(value: Any) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def main() -> int:
    fixture_path = pathlib.Path(__file__).with_name("ats_contracts_golden.json")
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    if fixture["canonical_profile"] != "rfc8785/1":
        print(f"FAIL: unexpected canonical profile {fixture['canonical_profile']!r}")
        return 1

    failures = 0

    for entry in fixture["canonical_vectors"]:
        produced = canonical_json(entry["value"])
        if produced != entry["canonical"]:
            failures += 1
            print(f"FAIL canonical bytes: {entry['name']}")
            print(f"  python : {produced!r}")
            print(f"  fixture: {entry['canonical']!r}")
        elif digest_of(entry["value"]) != entry["digest"]:
            failures += 1
            print(f"FAIL digest: {entry['name']}")

    for entry in fixture["canonical_rejects"]:
        try:
            canonical_json(entry["value"])
        except (UnicodeEncodeError, ValueError, TypeError):
            continue
        failures += 1
        print(f"FAIL: python accepted {entry['name']}, which must be refused")

    for entry in fixture["vectors"]:
        produced = digest_of(entry["document"])
        if produced != entry["canonical_digest"]:
            failures += 1
            print(f"FAIL digest: {entry['schema_version']}")
            print(f"  python : {produced}")
            print(f"  fixture: {entry['canonical_digest']}")

    total = len(fixture["canonical_vectors"]) + len(fixture["canonical_rejects"]) + len(fixture["vectors"])
    if failures:
        print(f"\n{failures} of {total} checks FAILED — canonicalization has drifted.")
        return 1
    print(f"OK: {total} checks reproduced byte-for-byte by an independent Python implementation.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
