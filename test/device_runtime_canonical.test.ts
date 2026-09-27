import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ZERO_DIGEST,
  canonicalJson,
  digestOf,
  escapeNonAscii,
  hmacSha256Hex,
  sha256CanonicalHex,
  timingSafeHexEqual,
} from "../src/core/device_runtime/canonical_json.js";

test("canonicalJson sorts keys, compacts, and ASCII-escapes", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ z: [3, 2, 1] }), '{"z":[3,2,1]}');
  assert.equal(canonicalJson("café"), '"caf\\u00e9"');
  // Astral code points become a surrogate pair, matching Python ensure_ascii.
  assert.equal(canonicalJson("\u{1f600}"), '"\\ud83d\\ude00"');
});

test("canonicalJson drops undefined-valued keys, keeps null", () => {
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

test("canonicalJson refuses non-integer and non-finite numbers", () => {
  assert.throws(() => canonicalJson(1.5), /non-integer/);
  assert.throws(() => canonicalJson(Number.NaN), /non-finite/);
  assert.throws(() => canonicalJson(Infinity), /non-finite/);
  // -0 normalizes to 0 so its text matches Python's.
  assert.equal(canonicalJson(-0), "0");
});

test("nested objects sort recursively", () => {
  assert.equal(canonicalJson({ outer: { y: 2, x: 1 } }), '{"outer":{"x":1,"y":2}}');
});

test("cross-language fixture: canonical bytes and sha256 are pinned", () => {
  // This exact string is what Python's
  //   json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
  // produces for the same document; the sha256 below is the cross-language pin.
  const doc = { b: 1, a: "café \u{1f600}", arr: [3, 2, 1], z: null, nested: { y: 2, x: 1 } };
  assert.equal(
    canonicalJson(doc),
    '{"a":"caf\\u00e9 \\ud83d\\ude00","arr":[3,2,1],"b":1,"nested":{"x":1,"y":2},"z":null}',
  );
  assert.equal(sha256CanonicalHex(doc), "35593da32a871f7b0ec5bb6825a4906fbb4a9e7e317d56ac3cd296495f489748");
  assert.equal(digestOf(doc), `sha256:${sha256CanonicalHex(doc)}`);
});

test("escapeNonAscii leaves ASCII untouched and escapes the rest", () => {
  assert.equal(escapeNonAscii('"plain"'), '"plain"');
  assert.equal(escapeNonAscii("é"), "\\u00e9");
});

test("hmac is stable and keyed", () => {
  const d = digestOf({ a: 1 });
  assert.equal(hmacSha256Hex("k3y", d), hmacSha256Hex("k3y", d));
  assert.notEqual(hmacSha256Hex("k3y", d), hmacSha256Hex("other", d));
});

test("timingSafeHexEqual compares by value and rejects length mismatch", () => {
  assert.equal(timingSafeHexEqual("abcd", "abcd"), true);
  assert.equal(timingSafeHexEqual("abcd", "abce"), false);
  assert.equal(timingSafeHexEqual("abcd", "abcde"), false);
});

test("ZERO_DIGEST is the 64-zero chain head", () => {
  assert.equal(ZERO_DIGEST, "sha256:" + "0".repeat(64));
});
