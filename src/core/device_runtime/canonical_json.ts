// Canonical JSON — the cross-language wire encoding the SC-DEVICE-01 contract
// signs and hashes against. It MUST byte-match Python's
// `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)`
// so a digest computed here verifies on the Cloud (Python) side and vice versa.
//
// The rules, from SC-DEVICE-01-CONTRACT.md §"CANONICAL JSON":
//   * object keys sorted (ascending, by UTF-16 code unit, which agrees with
//     Python's byte-wise sort for the ASCII key names this contract uses),
//   * compact separators (no spaces),
//   * every non-ASCII code point escaped as a `\uXXXX` unit (ensure_ascii),
//   * integers only in signed material — a non-integer or non-finite number
//     throws rather than emitting a float whose textual form differs between
//     languages (`1.0` vs `1`, `1e-7`, NaN, …). The contract keeps every
//     signed number an integer (percentages, sizes in MB, unix-ms timestamps)
//     precisely so this encoder never has to make a float portable.
//
// `undefined`-valued keys are dropped (they have no JSON representation and no
// Python analogue), matching `JSON.stringify` so an optional field left unset
// never changes the digest.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** The all-zero digest that heads a device outbox chain (contract §DeviceCommand). */
export const ZERO_DIGEST = `sha256:${"0".repeat(64)}` as const;

/**
 * Escape every non-ASCII code point in an already-JSON-encoded fragment to a
 * `\uXXXX` escape (a surrogate pair for astral code points), matching Python's
 * `ensure_ascii=True`. The input is the output of `JSON.stringify` on a string
 * or key, so quotes, backslashes and C0 controls are already escaped as ASCII;
 * only literal non-ASCII characters remain to convert.
 */
export function escapeNonAscii(jsonEncoded: string): string {
  let out = "";
  for (const ch of jsonEncoded) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) {
      out += ch;
    } else if (code <= 0xffff) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      const c = code - 0x10000;
      const hi = 0xd800 + (c >> 10);
      const lo = 0xdc00 + (c & 0x3ff);
      out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
    }
  }
  return out;
}

/** Encode a string exactly as canonical JSON would (quoted, escaped, ASCII). */
function encodeString(value: string): string {
  return escapeNonAscii(JSON.stringify(value));
}

/**
 * Serialize `value` to the canonical form. Throws on anything the contract does
 * not permit in signed material — a non-finite or non-integer number, a
 * function, a symbol, a bigint — because silently coercing it would produce
 * bytes the Python side cannot reproduce.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) throw new Error("canonical json: non-finite number is not portable");
    if (!Number.isInteger(n)) throw new Error("canonical json: non-integer number is not portable in signed material");
    // Normalize -0 to 0 so its textual form matches Python's.
    return String(n === 0 ? 0 : n);
  }
  if (t === "string") return encodeString(value as string);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${encodeString(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  throw new Error(`canonical json: unsupported value of type ${t}`);
}

/** Hex sha256 over the canonical bytes of `value`. */
export function sha256CanonicalHex(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** The contract's digest form: `"sha256:" + hex(sha256(canonical_json(value)))`. */
export function digestOf(value: unknown): string {
  return `sha256:${sha256CanonicalHex(value)}`;
}

/** Hex HMAC-SHA256 of `message` under `key` (both UTF-8), used for command signatures. */
export function hmacSha256Hex(key: string, message: string): string {
  return createHmac("sha256", Buffer.from(key, "utf8")).update(message, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two hex strings of equal length. Timing-safe so a
 * forged signature cannot be discovered byte-by-byte from acceptance latency.
 * Unequal lengths short-circuit to false (never a length-oracle worth timing).
 */
export function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  // timingSafeEqual throws on a length mismatch; the equal-length guards above
  // guarantee it never does.
  return timingSafeEqual(ba, bb);
}
