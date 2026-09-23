#!/usr/bin/env python3
"""Reproduce the managed tool host golden fixture in Python.

    python test/fixtures/managed_tool_host_verify.py

Runs every vector in managed_tool_host_golden.json through the independent
mirror (managed_tool_host_wire, _objects, _cross and _ed25519: stdlib only,
nothing shared with TypeScript) and requires identical canonical bytes,
digests, signatures and refusal messages; see docs/CONTRACTS.md section 5.
Exits non-zero on any mismatch and prints a one-line summary with counts.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import pathlib
import sys
from typing import Any, Callable

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import managed_tool_host_cross as c  # noqa: E402
import managed_tool_host_ed25519 as ed  # noqa: E402
import managed_tool_host_objects as o  # noqa: E402
import managed_tool_host_wire as w  # noqa: E402

FIXTURE = HERE / "managed_tool_host_golden.json"
BUNDLE = HERE.parents[1] / "contracts" / "managed-ats-tool-host" / "v1"

# Named floors equal to the coverage frozen with the fixture, never derived from it.
REJECT_FLOORS = {
    "trust": 24, "device_proof": 35, "host_open_proof": 19, "observer_receipt": 21, "runtime_capability": 24,
    "registry": 49, "host_lease": 23, "invocation": 37, "cancellation": 13, "result": 51,
    "workspace_status_input": 5, "workspace_status": 51,
}
CROSS_REJECT_FLOORS = {
    "lease_binding": 12, "invocation": 20, "tool_arguments": 4, "cancellation": 8, "result": 20, "tool_payload": 5,
    "e1_canary": 9, "capability_receipt": 7,
}
SECTION_FLOORS = {"accept": 39, "cross_accept": 23, "raw_accept": 12, "raw_reject": 55, "primitives": 114, "canonical": 6}
SELF_DIGESTS = {
    "device_proof": ("proof_digest", ("proof_digest", "cloud_signature"), o.DEVICE_PROOF_SCHEMA),
    "observer_receipt": ("receipt_digest", ("receipt_digest",), o.OBSERVER_RECEIPT_SCHEMA),
    "runtime_capability": ("capability_digest", ("capability_digest",), o.RUNTIME_CAPABILITY_SCHEMA),
    "registry": ("registry_digest", ("registry_digest",), o.REGISTRY_SCHEMA),
    "invocation": ("invocation_digest", ("invocation_digest",), o.INVOCATION_SCHEMA),
    "cancellation": ("cancellation_digest", ("cancellation_digest",), o.CANCELLATION_SCHEMA),
    "result": ("result_digest", ("result_digest",), o.RESULT_SCHEMA),
    "workspace_status": ("status_digest", ("status_digest",), o.WORKSPACE_STATUS_SCHEMA),
}


def sha256(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def refusal(action: Callable[[], Any]) -> str | None:
    try:
        action()
    except w.ContractError as error:
        return str(error)
    return None


def generated(patch: dict) -> Any:
    if "repeat" in patch:
        return patch["repeat"]["unit"] * patch["repeat"]["count"]
    if "grid" in patch:
        spec = patch["grid"]
        grid = [[spec["unit"] * spec["length"] for _ in range(spec["cols"])] for _ in range(spec["rows"])]
        return grid if "pad" not in spec else {"grid": grid, "pad": spec["unit"] * spec["pad"]}
    value = patch["nest"]["leaf"]
    for _ in range(patch["nest"]["depth"]):
        value = [value] if patch["nest"]["kind"] == "array" else {"k": value}
    return value


def apply_patches(document: Any, patches: list) -> Any:
    root = copy.deepcopy(document)
    for patch in patches:
        value = None if patch.get("delete") else copy.deepcopy(patch["value"]) if "value" in patch else generated(patch)
        if not patch["path"]:
            root = value
            continue
        cursor = root
        for key in patch["path"][:-1]:
            cursor = cursor[key]
        if patch.get("delete"):
            del cursor[patch["path"][-1]]
        else:
            cursor[patch["path"][-1]] = value
    return root


class Harness:
    def __init__(self, fixture: dict) -> None:
        self.fixture = fixture
        self.accept = {vector["id"]: vector for vector in fixture["accept"]}
        self.failures: list[str] = []
        self.checked = 0

    def problem(self, message: str) -> None:
        self.failures.append(message)

    def expect_refusal(self, label: str, action: Callable[[], Any], expected: str) -> None:
        self.checked += 1
        message = refusal(action)
        if message != expected:
            self.problem(f"{label}: expected {expected!r}, got {message!r}")

    # --- context and dispatch ---

    def context(self, spec: dict | None) -> dict:
        resolved: dict = {}
        if spec and "trust" in spec:
            trust = self.accept[spec["trust"]]
            resolved["trust"] = o.validate_trust_document(trust["document"], trust["now"])
        if spec and "device_proof" in spec:
            proof = self.accept[spec["device_proof"]]
            resolved["device_proof"] = o.validate_device_proof(proof["document"], self.context(proof.get("context"))["trust"], proof["now"])
        if spec and "binding" in spec:
            resolved["binding"] = spec["binding"]
        return resolved

    @staticmethod
    def validate(kind: str, value: Any, now: int | None, ctx: dict) -> Any:
        return {
            "trust": lambda: o.validate_trust_document(value, now),
            "device_proof": lambda: o.validate_device_proof(value, ctx["trust"], now),
            "host_open_proof": lambda: o.validate_host_open_proof(value, ctx["device_proof"]),
            "observer_receipt": lambda: o.validate_observer_receipt(value, now),
            "runtime_capability": lambda: o.validate_runtime_capability(value, now),
            "registry": lambda: o.validate_registry(value, now),
            "host_lease": lambda: o.validate_host_lease(value, ctx["trust"], now),
            "invocation": lambda: o.validate_invocation(value),
            "cancellation": lambda: o.validate_cancellation(value),
            "result": lambda: o.validate_result(value),
            "workspace_status_input": lambda: o.validate_workspace_status_input(value),
            "workspace_status": lambda: o.validate_workspace_status(value, ctx["binding"]),
        }[kind]()

    # --- sections ---

    def header(self) -> None:
        fixture = self.fixture
        if fixture.get("schema") != "aether.managed-tool-host-golden/1" or fixture.get("canonical_profile") != "rfc8785/1":
            self.problem("unexpected fixture schema or canonical profile")
        if fixture.get("clock_skew_ms") != w.CLOCK_SKEW_MS:
            self.problem("clock skew drifted")
        raw = FIXTURE.read_bytes()
        if any(b > 126 or (b < 32 and b not in (10, 13)) for b in raw):
            self.problem("fixture is not printable ASCII")
        for name, floor in SECTION_FLOORS.items():
            count = len(fixture["cross"]["accept"]) if name == "cross_accept" else len(fixture[name])
            if count < floor:
                self.problem(f"{name}: {count} vectors, floor {floor}")

    def keys(self) -> None:
        for key in self.fixture["keys"]:
            self.checked += 1
            seed = bytes.fromhex(key["seed_hex"])
            if "NOT FOR PRODUCTION" not in key["note"]:
                self.problem(f"key {key['label']}: missing production warning")
            if b64url(ed.public_key(seed)) != key["public_key"]:
                self.problem(f"key {key['label']}: public key does not derive from its seed")
            message = b"managed tool host self-check " + key["label"].encode("ascii")
            if not ed.verify(ed.public_key(seed), message, ed.sign(seed, message)):
                self.problem(f"key {key['label']}: sign/verify self-check failed")

    def schemas(self) -> None:
        manifest = json.loads((BUNDLE / "manifest.json").read_text(encoding="utf-8"))
        entries = manifest["entries"]
        if manifest["schema"] != "aether.managed-tool-schema-bundle/1":
            self.problem("manifest schema drifted")
        if [entry["file"] for entry in entries] != sorted(entry["file"] for entry in entries):
            self.problem("manifest is not sorted by file")
        if entries != self.fixture["schemas"]:
            self.problem("fixture schemas section differs from the manifest")
        for entry in entries:
            self.checked += 1
            raw = (BUNDLE / entry["file"]).read_bytes()
            if any(b > 126 or (b < 32 and b not in (10, 13)) for b in raw):
                self.problem(f"{entry['file']}: not ASCII")
            document = json.loads(raw.decode("utf-8"))
            if document.get("x-aether-schema-id") != entry["schema_id"]:
                self.problem(f"{entry['file']}: schema id drifted")
            if o.schema_digest(document) != entry["schema_digest"]:
                self.problem(f"{entry['file']}: schema digest drifted")
        pinned = {entry["file"]: entry["schema_digest"] for entry in entries}
        if pinned.get("workspace-status-input.schema.json") != o.WORKSPACE_STATUS_INPUT_SCHEMA_DIGEST:
            self.problem("pinned E1 input schema digest drifted")
        if pinned.get("workspace-status.schema.json") != o.WORKSPACE_STATUS_SCHEMA_DIGEST:
            self.problem("pinned E1 output schema digest drifted")

    def canonical(self) -> None:
        for vector in self.fixture["canonical"]:
            self.checked += 1
            text = w.canonical(vector["value"])
            if text != vector["canonical"]:
                self.problem(f"canonical {vector['name']}: bytes drifted: {text!r}")
            elif sha256(text.encode("utf-8")) != vector["digest"]:
                self.problem(f"canonical {vector['name']}: digest drifted")

    def primitives(self) -> None:
        checks = {
            "timestamp": lambda value: w.epoch_ms(w.timestamp(value, "Value")),
            "text": lambda value: w.text(value, "Value", 1, 256),
            "id": lambda value: w.ident(value, "Value"),
            "origin": lambda value: w.https_origin(value, "Value"),
            "base64url_32": lambda value: w.base64url(value, "Value", 32),
            "base64url_64": lambda value: w.base64url(value, "Value", 64),
            "schema_id": lambda value: w.schema_id(value, "Value"),
        }
        for index, entry in enumerate(self.fixture["primitives"]):
            check = checks[entry["check"]]
            label = f"{entry['check']}[{index}]"
            if "expect" in entry:
                self.expect_refusal(label, lambda: check(entry["value"]), entry["expect"])
                continue
            self.checked += 1
            try:
                result = check(entry["value"])
            except w.ContractError as error:
                self.problem(f"{label}: refused a valid value: {error}")
                continue
            if "epoch_ms" in entry and result != entry["epoch_ms"]:
                self.problem(f"{label}: epoch {result}")

    def derivations(self) -> None:
        d = self.fixture["derivations"]
        for row in d["account_scope"]:
            self.checked += 1
            if o.account_scope_digest(row["cloud_origin_id"], row["account_subject"]) != row["digest"]:
                self.problem(f"account_scope {row['name']}: digest drifted")
        for row in d["account_scope_reject"]:
            self.expect_refusal(f"account_scope {row['name']}", lambda: o.account_scope_digest(row["cloud_origin_id"], row["account_subject"]), row["expect"])
        for row in d["binding"]:
            self.checked += 1
            if o.workspace_binding_digest(row["binding"]) != row["digest"]:
                self.problem(f"binding {row['name']}: digest drifted")
        for row in d["binding_reject"]:
            self.expect_refusal(f"binding {row['name']}", lambda: o.workspace_binding_digest(row["binding"]), row["expect"])
        for row in d["arguments"]:
            self.checked += 1
            if o.arguments_digest(row["arguments"]) != row["digest"]:
                self.problem(f"arguments {row['name']}: digest drifted")
        for row in d["arguments_reject"]:
            self.expect_refusal(f"arguments {row['name']}", lambda: o.arguments_digest(row["arguments"]), row["expect"])

    @staticmethod
    def frame_bytes(frame: dict) -> bytes:
        if "text" in frame:
            return frame["text"].encode("latin-1")
        if "base64" in frame:
            return base64.b64decode(frame["base64"])
        spec = frame["generate"]
        if "string_member" in spec:
            return ('{"k":"' + "x" * (spec["string_member"] - 8) + '"}').encode("utf-8")
        depth = spec["nest"]
        return ("[" * depth + "]" * depth if spec["kind"] == "array" else '{"a":' * depth + "0" + "}" * depth).encode("utf-8")

    def raw_frames(self) -> None:
        for vector in self.fixture["raw_accept"]:
            self.checked += 1
            try:
                text = w.canonical(w.parse_frame(self.frame_bytes(vector["frame"])))
            except w.ContractError as error:
                self.problem(f"raw {vector['id']}: refused a valid frame: {error}")
                continue
            if "canonical" in vector and text != vector["canonical"]:
                self.problem(f"raw {vector['id']}: canonical text drifted")
            if sha256(text.encode("utf-8")) != vector["canonical_sha256"]:
                self.problem(f"raw {vector['id']}: canonical digest drifted")
        for vector in self.fixture["raw_reject"]:
            self.expect_refusal(f"raw {vector['id']}", lambda: w.parse_frame(self.frame_bytes(vector["frame"])), vector["expect"])

    def independent(self, vector: dict) -> None:
        document = vector["document"]
        kind = vector["kind"]
        if kind in SELF_DIGESTS:
            field, omit_fields, schema = SELF_DIGESTS[kind]
            if sha256(w.preimage(schema, w.omit(document, omit_fields))) != document[field]:
                self.problem(f"{vector['id']}: {field} is not the common digest")
        if kind in ("device_proof", "host_lease"):
            schema = o.DEVICE_PROOF_SCHEMA if kind == "device_proof" else o.HOST_LEASE_SCHEMA
            trust = self.accept[vector["context"]["trust"]]["document"]
            key = next(k["public_key"] for k in trust["keys"] if k["key_id"] == document["signature_key_id"])
            message = w.preimage(schema, w.omit(document, ("cloud_signature",)))
            if not ed.verify(w.decode_base64url(key), message, w.decode_base64url(document["cloud_signature"])):
                self.problem(f"{vector['id']}: cloud_signature does not verify independently")
        if kind == "host_open_proof":
            proof = self.accept[vector["context"]["device_proof"]]["document"]
            body = {field: document[field] for field in o.HOST_OPEN_SIGNED_FIELDS}
            message = w.preimage(o.HOST_OPEN_SIGNING_SCHEMA, body)
            if not ed.verify(w.decode_base64url(proof["device_public_key"]), message, w.decode_base64url(document["device_signature"])):
                self.problem(f"{vector['id']}: device_signature does not verify independently")
        if kind == "invocation" and sha256(w.preimage(o.ARGUMENTS_SCHEMA, document["arguments"])) != document["arguments_digest"]:
            self.problem(f"{vector['id']}: arguments_digest drifted")
        if kind == "result":
            size = 0 if document["payload"] is None else len(w.canonical(document["payload"]).encode("utf-8"))
            if size != document["bounded_bytes"]:
                self.problem(f"{vector['id']}: bounded_bytes drifted")
        if kind == "workspace_status" and sha256(w.preimage(o.WORKSPACE_BINDING_SCHEMA, vector["context"]["binding"])) != document["binding_digest"]:
            self.problem(f"{vector['id']}: binding_digest drifted")

    def objects(self) -> None:
        for vector in self.fixture["accept"]:
            self.checked += 1
            self.independent(vector)
            if sha256(w.canonical(vector["document"]).encode("utf-8")) != vector["expect"]["canonical_sha256"]:
                self.problem(f"{vector['id']}: canonical digest drifted")
            try:
                output = self.validate(vector["kind"], vector["document"], vector.get("now"), self.context(vector.get("context")))
            except w.ContractError as error:
                self.problem(f"{vector['id']}: refused a faithful document: {error}")
                continue
            if w.canonical(output) != w.canonical(vector["document"]):
                self.problem(f"{vector['id']}: validator output differs from its input")
        counts: dict = {}
        for vector in self.fixture["reject"]:
            counts[vector["kind"]] = counts.get(vector["kind"], 0) + 1
            base = self.accept[vector["base"]]
            if refusal(lambda: self.validate(base["kind"], base["document"], base.get("now"), self.context(base.get("context")))) is not None:
                self.problem(f"{vector['id']}: control document refused")
            ctx = self.context(vector.get("context", base.get("context")))
            now = vector.get("now", base.get("now"))
            patched = apply_patches(base["document"], vector["patches"])
            self.expect_refusal(vector["id"], lambda: self.validate(vector["kind"], patched, now, ctx), vector["expect"])
        for kind, floor in REJECT_FLOORS.items():
            if counts.get(kind, 0) < floor:
                self.problem(f"{kind}: {counts.get(kind, 0)} reject vectors, floor {floor}")

    def cross_inputs(self, refs: dict, patches: dict, now: int) -> dict:
        raw = {name: apply_patches(self.accept[ref]["document"], patches.get(name, [])) for name, ref in refs.items()}
        out: dict = {}
        if "trust" in raw:
            out["trust"] = o.validate_trust_document(raw["trust"], now)
        for name, value in raw.items():
            if name == "trust":
                continue
            out[name] = {
                "device_proof": lambda: o.validate_device_proof(value, out["trust"], now),
                "lease": lambda: o.validate_host_lease(value, out["trust"], now),
                "registry": lambda: o.validate_registry(value, now),
                "invocation": lambda: o.validate_invocation(value),
                "cancellation": lambda: o.validate_cancellation(value),
                "result": lambda: o.validate_result(value),
                "capability": lambda: o.validate_runtime_capability(value, now),
                "receipt": lambda: o.validate_observer_receipt(value, now),
            }[name]()
        return out

    @staticmethod
    def run_check(check: str, v: dict, now: int, expected: dict | None) -> None:
        {
            "lease_binding": lambda: c.check_lease_binding(v["lease"], v["registry"], v["device_proof"], v["trust"]),
            "invocation": lambda: c.check_invocation(v["invocation"], v["lease"], v["registry"], now),
            "tool_arguments": lambda: c.check_tool_arguments(v["invocation"], v["registry"]),
            "cancellation": lambda: c.check_cancellation(v["cancellation"], v["invocation"], v["lease"]),
            "result": lambda: c.check_result(v["result"], v["invocation"], v["registry"], now),
            "tool_payload": lambda: c.check_tool_payload(v["result"], v["invocation"], v["registry"]),
            "e1_canary": lambda: c.assert_e1_canary_registry(v["registry"]),
            "capability_receipt": lambda: c.check_capability_receipt(v["capability"], v["receipt"], expected),
        }[check]()

    def cross(self) -> None:
        bases = {vector["id"]: vector for vector in self.fixture["cross"]["accept"]}
        for vector in self.fixture["cross"]["accept"]:
            self.checked += 1
            try:
                self.run_check(vector["check"], self.cross_inputs(vector["inputs"], {}, vector["now"]), vector["now"], vector.get("expected"))
            except w.ContractError as error:
                self.problem(f"cross {vector['id']}: {error}")
        counts: dict = {}
        for vector in self.fixture["cross"]["reject"]:
            counts[vector["check"]] = counts.get(vector["check"], 0) + 1
            base = bases[vector["base"]]
            now = vector.get("now", base["now"])
            try:
                inputs = self.cross_inputs({**base["inputs"], **vector.get("inputs", {})}, vector["patches"], now)
            except w.ContractError as error:
                self.problem(f"cross {vector['id']}: refused by shape, not by the cross check: {error}")
                continue
            expected = vector.get("expected", base.get("expected"))
            self.expect_refusal(f"cross {vector['id']}", lambda: self.run_check(vector["check"], inputs, now, expected), vector["expect"])
        for check, floor in CROSS_REJECT_FLOORS.items():
            if counts.get(check, 0) < floor:
                self.problem(f"{check}: {counts.get(check, 0)} cross rejects, floor {floor}")

    def run(self) -> None:
        for section in (self.header, self.keys, self.schemas, self.canonical, self.primitives, self.derivations,
                        self.raw_frames, self.objects, self.cross):
            section()


def main() -> int:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    harness = Harness(fixture)
    harness.run()
    counts = (f"keys {len(fixture['keys'])}, schemas {len(fixture['schemas'])}, canonical {len(fixture['canonical'])}, "
              f"primitives {len(fixture['primitives'])}, raw {len(fixture['raw_accept'])}+{len(fixture['raw_reject'])}, "
              f"accept {len(fixture['accept'])}, reject {len(fixture['reject'])}, "
              f"cross {len(fixture['cross']['accept'])}+{len(fixture['cross']['reject'])}")
    if harness.failures:
        for failure in harness.failures:
            print(f"FAIL {failure}")
        print(f"FAIL: {len(harness.failures)} problem(s) across {harness.checked} checks ({counts}): the Python mirror disagrees with the fixture.")
        return 1
    print(f"OK: {harness.checked} managed tool host checks reproduced by an independent Python implementation ({counts}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
