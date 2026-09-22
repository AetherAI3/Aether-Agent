// RFC 8785 (JCS) canonicalization for the ATS trading contracts.
//
// An earlier revision of this module re-exported
// src/core/device_runtime/canonical_json.ts and called the result a "JCS
// integer subset". That was wrong, and the name hid the wrongness: that
// encoder escapes EVERY non-ASCII character (Python's ensure_ascii=True),
// while JCS requires non-control Unicode to be emitted as-is and the result
// encoded as UTF-8. The two produce different bytes — and therefore different
// digests — for any document containing a non-ASCII character. A profile name
// that implies "8785 with fewer number types" is a liability when the real
// difference is the string encoding.
//
// This is a real JCS implementation. It is NOT shared with device_runtime:
// that module's encoder is pinned to the Cloud's Python `json.dumps(...,
// ensure_ascii=True)` and changing it would invalidate device signatures. Two
// encoders exist here deliberately, each pinned to a different counterpart,
// and neither should be "unified" with the other.
//
// WHERE FLOATS ARE REJECTED. JCS serializes floats perfectly well, so this
// encoder accepts them. The ATS contracts still refuse them, one layer up, in
// the schema validators (`integer()`, `minorUnits()`): every monetary field is
// an integer count of minor units and every quantity a whole share, because a
// float crossing a language boundary is how a preview and a commit come to
// disagree about a number that looked equal. Rejecting them in the validator
// rather than the encoder keeps this module honest about what JCS is.
//
// CROSS-LANGUAGE WARNING — key ordering. RFC 8785 §3.2.3 sorts object keys by
// UTF-16 code unit, which is what JavaScript's default string comparison does.
// Python's `sorted()` compares by CODE POINT, and the two disagree whenever an
// astral character (U+10000 and above, encoded as a surrogate pair beginning
// 0xD800) meets a BMP character at or above U+E000. A Python mirror MUST sort
// on UTF-16 code units explicitly; plain `sorted(keys)` will silently produce a
// different digest. The golden vectors include a case that catches exactly
// this.

import { createHash } from "node:crypto";

/** The canonicalization profile these contracts are frozen against. */
export const ATS_CANONICAL_PROFILE = "rfc8785/1" as const;

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Reject unpaired surrogates. RFC 8785 §3.2.2 requires input to be valid
 * Unicode; a lone surrogate has no UTF-8 encoding, so different runtimes
 * substitute or throw differently and the digest stops being reproducible.
 */
function assertWellFormed(value: string, what: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) fail(`canonical json: ${what} contains an unpaired high surrogate`);
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(`canonical json: ${what} contains an unpaired low surrogate`);
    }
  }
}

/**
 * JCS string serialization. ECMAScript's JSON.stringify already emits exactly
 * the escaping RFC 8785 §3.2.2.2 prescribes — the two-character escapes for
 * `"` `\` `\b` `\f` `\n` `\r` `\t`, lowercase `\u00xx` for the remaining C0
 * controls, and every other code point literal — so the only work here is
 * rejecting input JSON.stringify would paper over.
 */
function encodeString(value: string, what: string): string {
  assertWellFormed(value, what);
  return JSON.stringify(value);
}

/**
 * Serialize `value` to its RFC 8785 canonical form.
 *
 * Numbers use ECMAScript's Number-to-String, which is what §3.2.2.3 specifies;
 * `JSON.stringify` applies it directly. `-0` normalizes to `0` because JCS has
 * no signed zero and Python would not reproduce `-0` either.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  const kind = typeof value;
  if (kind === "boolean") return value ? "true" : "false";
  if (kind === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) fail("canonical json: NaN and Infinity have no JSON representation");
    return JSON.stringify(Object.is(n, -0) ? 0 : n);
  }
  if (kind === "string") return encodeString(value as string, "string");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (kind === "object") {
    const record = value as Record<string, unknown>;
    // `undefined` has no JSON form and no Python analogue; dropping it matches
    // JSON.stringify so an optional field left unset never changes the digest.
    // Default sort compares UTF-16 code units, which is what §3.2.3 requires.
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${encodeString(key, "key")}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  fail(`canonical json: unsupported value of type ${kind}`);
}

/** Hex sha256 over the canonical UTF-8 bytes of `value`. */
export function sha256CanonicalHex(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** The digest form these contracts carry: `sha256:` + hex. */
export function digestOf(value: unknown): string {
  return `sha256:${sha256CanonicalHex(value)}`;
}

/**
 * Digest a document after stripping fields that carry a digest of the document
 * itself. A receipt cannot contain its own digest and also hash to it.
 */
export function digestWithout(value: Record<string, unknown>, omit: readonly string[]): string {
  const subject: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!omit.includes(key)) subject[key] = entry;
  }
  return digestOf(subject);
}

/**
 * Exact equality for `sha256:<hex>` digests. No normalization, no case
 * folding, no prefix match — a caller must not "nearly" match a preview.
 * Digests here are public identifiers, not secrets, so this is a correctness
 * guard rather than a timing defence.
 */
export function digestEquals(a: string, b: string): boolean {
  return typeof a === "string" && typeof b === "string" && a.length === b.length && a === b;
}
