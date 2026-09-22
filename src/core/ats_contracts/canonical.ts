// Canonical encoding and digests for the ATS trading contracts.
//
// The specs call for "RFC 8785 canonicalization". This module deliberately
// reuses the encoder the device-runtime contract already ships
// (src/core/device_runtime/canonical_json.ts) rather than adding a second,
// subtly different one — two canonicalizers in one process is how digests
// silently stop matching across a release.
//
// HONEST SUBSET NOTE. That encoder is a STRICTER SUBSET of RFC 8785, not a
// full implementation, and the difference is deliberate:
//
//   * RFC 8785 serializes numbers with the ECMAScript Number-to-String
//     algorithm, so it admits floats (1.5, 1e-7). This encoder REFUSES any
//     non-integer or non-finite number outright.
//   * On the values these contracts actually carry — integers only — the two
//     agree byte for byte, and both agree with Python's
//     json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=True).
//
// Refusing floats is the point. Money and quantity crossing a language
// boundary as a float is how a preview and a commit come to disagree about a
// number that looked equal, so every monetary field in these contracts is an
// integer count of minor units and every quantity is a whole share. A caller
// that tries to digest a float gets an exception here instead of a receipt
// that reconciles differently on the Python side.

import { canonicalJson, digestOf, sha256CanonicalHex } from "../device_runtime/canonical_json.js";

export { canonicalJson, digestOf, sha256CanonicalHex };

/**
 * The canonicalization profile these contracts are frozen against. Both
 * language mirrors assert this string so a future switch to a full RFC 8785
 * encoder is a deliberate, versioned act rather than a silent digest change.
 */
export const ATS_CANONICAL_PROFILE = "jcs-integer-subset/1" as const;

/**
 * Digest a contract document after stripping the fields that carry a digest of
 * the document itself. A receipt cannot contain its own digest and also hash to
 * it, so the binding digest is always taken over the document MINUS those keys.
 */
export function digestWithout(value: Record<string, unknown>, omit: readonly string[]): string {
  const subject: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!omit.includes(key)) subject[key] = entry;
  }
  return digestOf(subject);
}

/**
 * Exact equality for the `sha256:<hex>` digests these contracts compare.
 * Digests here are public identifiers rather than secrets, so this is a
 * correctness guard — no normalization, no case folding, no prefix match —
 * rather than a timing defence. A caller must not "nearly" match a preview.
 */
export function digestEquals(a: string, b: string): boolean {
  return typeof a === "string" && typeof b === "string" && a.length === b.length && a === b;
}
