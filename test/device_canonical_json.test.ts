// Canonical JSON is the byte-level agreement between the agent (TypeScript) and
// the Cloud (Python). If these bytes drift, every signature verifies on one side
// and fails on the other — so the encoding is pinned here against the exact
// output `json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=True)`
// produces, not merely against "some deterministic encoding".

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  ZERO_DIGEST,
  canonicalJson,
  digestOf,
  escapeNonAscii,
  hmacSha256Hex,
  sha256CanonicalHex,
  timingSafeHexEqual,
} from "../src/core/device_runtime/canonical_json.js";

test("canonical json sorts keys and uses compact separators", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  // Insertion order must not matter — the Cloud builds the same object from a
  // dict whose ordering is its own business.
  assert.equal(canonicalJson({ a: 2, b: 1 }), canonicalJson({ b: 1, a: 2 }));
  assert.equal(canonicalJson({ z: { y: 1, x: 2 }, a: [3, 2, 1] }), '{"a":[3,2,1],"z":{"x":2,"y":1}}');
  // Arrays keep their order; only object KEYS sort.
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
  assert.equal(canonicalJson({}), "{}");
  assert.equal(canonicalJson([]), "[]");
});

test("canonical json escapes every non-ascii code point like ensure_ascii", () => {
  assert.equal(canonicalJson("café"), '"caf\\u00e9"');
  assert.equal(canonicalJson({ "ключ": "значение" }), '{"\\u043a\\u043b\\u044e\\u0447":"\\u0437\\u043d\\u0430\\u0447\\u0435\\u043d\\u0438\\u0435"}');
  // Astral plane becomes a surrogate PAIR, which is what Python emits too.
  assert.equal(canonicalJson("🔥"), '"\\ud83d\\udd25"');
  assert.equal(escapeNonAscii('"a"'), '"a"');
  // Control characters are already ASCII-escaped by JSON.stringify and must be
  // left exactly as-is rather than double-escaped.
  assert.equal(canonicalJson("a\nb"), '"a\\nb"');
  assert.equal(canonicalJson('quote " and backslash \\'), '"quote \\" and backslash \\\\"');
});

test("canonical json refuses numbers whose textual form is not portable", () => {
  // A float renders differently across languages (1.0 vs 1), so signed material
  // may not contain one. Failing loudly beats a digest that silently disagrees.
  assert.throws(() => canonicalJson({ pct: 12.5 }), /non-integer/);
  assert.throws(() => canonicalJson(Number.NaN), /non-finite/);
  assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), /non-finite/);
  assert.throws(() => canonicalJson(10n as unknown), /unsupported value/);
  assert.throws(() => canonicalJson(() => 1), /unsupported value/);
  // -0 normalizes to 0 rather than emitting "-0".
  assert.equal(canonicalJson(-0), "0");
  assert.equal(canonicalJson(-17), "-17");
});

test("canonical json drops undefined-valued keys and keeps nulls", () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalJson({ a: null }), '{"a":null}');
  assert.equal(canonicalJson({ a: true, b: false }), '{"a":true,"b":false}');
});

test("digestOf is sha256 over the canonical bytes with the contract prefix", () => {
  const value = { device_id: "dev_1", seq: 3, nested: { b: 2, a: 1 } };
  const expected = createHash("sha256").update('{"device_id":"dev_1","nested":{"a":1,"b":2},"seq":3}', "utf8").digest("hex");
  assert.equal(sha256CanonicalHex(value), expected);
  assert.equal(digestOf(value), `sha256:${expected}`);
  assert.match(digestOf(value), /^sha256:[0-9a-f]{64}$/);
  assert.equal(ZERO_DIGEST, `sha256:${"0".repeat(64)}`);
});

test("hmac matches node's own HMAC-SHA256 and comparison is length-safe", () => {
  const key = "device-command-key";
  const message = `sha256:${"7".repeat(64)}`;
  assert.equal(hmacSha256Hex(key, message), createHmac("sha256", Buffer.from(key, "utf8")).update(message, "utf8").digest("hex"));
  // A different key must not produce the same tag — that is the whole point.
  assert.notEqual(hmacSha256Hex(key, message), hmacSha256Hex("other-key", message));

  const a = "a".repeat(64);
  assert.equal(timingSafeHexEqual(a, a), true);
  assert.equal(timingSafeHexEqual(a, "b".repeat(64)), false);
  // Unequal lengths short-circuit instead of throwing out of timingSafeEqual.
  assert.equal(timingSafeHexEqual(a, "a".repeat(63)), false);
  assert.equal(timingSafeHexEqual("", ""), true);
});
