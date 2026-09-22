// Shared validators for the frozen ATS trading contracts.
//
// Every contract in this directory is a CLOSED document: an unknown key is a
// refusal, never an ignored extra. A model-originated proposal is attacker
// controlled input (Spec 1 section 4), so parsing into a typed value is the
// only safe posture — a caller receives a validated value or an exception,
// never a half-checked object.
//
// These helpers throw plain Errors with operator-readable text and NEVER embed
// the offending value: a rejected payload may carry a broker token, a raw
// account number or a provider URL, and error strings reach logs, UI and
// support bundles.

/** Bounded identifier: the shape every `*_id` field in this directory uses. */
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * An opaque local reference MUST carry a namespace prefix (`acct_...`, `ord_...`).
 * This is the mechanical half of Spec 1 section 14, "raw account numbers never
 * leave the connector core": a bare provider account number cannot satisfy this
 * shape, so a leak becomes a validation error at the boundary rather than a
 * disclosure.
 */
const OPAQUE_REF = /^[a-z][a-z0-9]{1,15}_[A-Za-z0-9_-]{8,128}$/;

/** `sha256:<64 lowercase hex>` — the digest form shared with the Python side. */
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Bare lowercase hex sha256, for fields the specs type as `*_sha256`. */
const HEX64 = /^[0-9a-f]{64}$/;

/** Equity ticker, matching the bound already enforced by ats-skills settings. */
const SYMBOL = /^[A-Z0-9][A-Z0-9.^:=_/-]{0,39}$/;

/** Control characters are refused everywhere; they corrupt logs and terminals. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/** Bounded version string. Providers, compilers and runtimes all use it. */
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export function fail(message: string): never {
  throw new Error(message);
}

/**
 * Reject anything that is not a plain object, then reject unknown keys.
 * A prototype other than Object.prototype/null is refused so a crafted payload
 * cannot smuggle behaviour through `__proto__` or a class instance.
 */
export function closed<K extends string>(value: unknown, name: string, allowed: readonly K[]): Record<K, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be a plain object.`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(`${name} must be a plain object.`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(allowed as readonly string[]).includes(key)) fail(`${name} contains an unsupported field.`);
  }
  return record as Record<K, unknown>;
}

/** Assert a literal schema tag. A contract that does not name itself is refused. */
export function schemaTag(value: unknown, expected: string, name: string): string {
  if (value !== expected) fail(`${name} must declare schema ${expected}.`);
  return expected;
}

export function choice<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) fail(`${name} is unsupported.`);
  return value as T;
}

export function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") fail(`${name} must be a boolean.`);
  return value;
}

/**
 * A field the contract pins to one constant (`false`, `"per_order"`). Used for
 * invariants that must not be negotiable by a caller — notably
 * `grants_execution_authority: false`.
 */
export function pinned<T extends boolean | string>(value: unknown, expected: T, name: string): T {
  if (value !== expected) fail(`${name} must be ${JSON.stringify(expected)}.`);
  return expected;
}

export function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value)) fail(`${name} must be a whole number.`);
  const n = value as number;
  if (n < min || n > max) fail(`${name} is out of range.`);
  return n;
}

export function text(value: unknown, name: string, max: number, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== "string") fail(`${name} must be a string.`);
  if (!options.allowEmpty && !value.length) fail(`${name} must not be empty.`);
  if (value.length > max) fail(`${name} exceeds its ${max} character limit.`);
  if (CONTROL.test(value)) fail(`${name} contains control characters.`);
  return value;
}

export function ident(value: unknown, name: string): string {
  if (typeof value !== "string" || !IDENT.test(value)) fail(`${name} must be a bounded identifier.`);
  return value;
}

export function opaqueRef(value: unknown, name: string): string {
  if (typeof value !== "string" || !OPAQUE_REF.test(value)) {
    fail(`${name} must be a prefixed opaque reference, never a provider account number.`);
  }
  return value;
}

export function digest(value: unknown, name: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(`${name} must be a sha256:<hex> digest.`);
  return value;
}

export function hex64(value: unknown, name: string): string {
  if (typeof value !== "string" || !HEX64.test(value)) fail(`${name} must be a lowercase sha256 hex digest.`);
  return value;
}

export function version(value: unknown, name: string): string {
  if (typeof value !== "string" || !VERSION.test(value)) fail(`${name} must be a bounded version string.`);
  return value;
}

export function symbol(value: unknown, name: string): string {
  if (typeof value !== "string" || !SYMBOL.test(value)) fail(`${name} must be a bounded uppercase ticker.`);
  return value;
}

/**
 * An RFC 3339 UTC instant, normalized to Z. Timestamps are compared across two
 * languages and three processes; a local offset would make "expired" depend on
 * who parsed it, so only explicit UTC is accepted.
 */
export function timestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length > 40) fail(`${name} must be an RFC 3339 UTC timestamp.`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) {
    fail(`${name} must be an RFC 3339 UTC timestamp ending in Z.`);
  }
  if (!Number.isFinite(Date.parse(value))) fail(`${name} is not a real instant.`);
  return value;
}

export function nullable<T>(value: unknown, name: string, inner: (v: unknown, n: string) => T): T | null {
  return value === null ? null : inner(value, name);
}

export function list<T>(value: unknown, name: string, max: number, item: (v: unknown, n: string) => T): T[] {
  if (!Array.isArray(value)) fail(`${name} must be an array.`);
  if (value.length > max) fail(`${name} exceeds its ${max} entry limit.`);
  return value.map((entry, index) => item(entry, `${name}[${index}]`));
}

/** A list whose entries must be unique — symbol allowlists, capability sets. */
export function uniqueList<T>(value: unknown, name: string, max: number, item: (v: unknown, n: string) => T): T[] {
  const entries = list(value, name, max, item);
  if (new Set(entries).size !== entries.length) fail(`${name} must not repeat an entry.`);
  return entries;
}

/**
 * Minor units (cents). Money never crosses these contracts as a float: 0.1 plus
 * 0.2 is not the same number in Python and JavaScript, and the canonical
 * encoder refuses non-integers outright so a digest stays reproducible.
 */
export function minorUnits(value: unknown, name: string, max = 1_000_000_000_000): number {
  return integer(value, name, 0, max);
}

/** Order the two ends of a validity window so an expiry can never precede its start. */
export function orderedWindow(startsAt: string, endsAt: string, name: string): void {
  if (Date.parse(endsAt) <= Date.parse(startsAt)) fail(`${name} must expire after it begins.`);
}
