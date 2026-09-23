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
 * Shape check for an opaque local reference: a namespace prefix plus a body
 * (`acct_9f2c4ab77e10`).
 *
 * BE CLEAR ABOUT WHAT THIS DOES NOT DO. A prefix cannot prove that a provider
 * account number is absent from the body — `acct_000123456789` satisfies this
 * regex. This is a shape guard that stops a BARE account number being passed
 * where a reference belongs. It is not a confidentiality control.
 *
 * The guarantee Spec 1 section 14 actually needs has to be produced upstream:
 * the connector core must MINT these as non-reversible local identifiers (a
 * random id, or a keyed digest of the provider id under a local secret) and
 * keep the mapping only in the encrypted binding. Nothing visible to this
 * validator distinguishes a minted reference from a hand-built one, so that
 * invariant belongs to whoever generates them.
 */
const OPAQUE_REF = /^[a-z][a-z0-9]{1,15}_[A-Za-z0-9_-]{8,128}$/;

/** `sha256:<64 lowercase hex>` — the digest form shared with the Python side. */
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Bare lowercase hex sha256, for fields the specs type as `*_sha256`. */
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Ticker shape frozen with the Spec 1 `/1` documents, matching the bound
 * already enforced by ats-skills settings. It is WEAK: `/` and `:` let an
 * all-caps string spell `HTTPS://X`. Executable shapes use EQUITY_TICKER.
 */
const SYMBOL = /^[A-Z0-9][A-Z0-9.^:=_/-]{0,39}$/;

/**
 * An equity ticker such as SPY, BRK.B or BRK-B. Deliberately narrower than
 * SYMBOL, whose `/` and `:` let an all-caps string spell a URL.
 */
const EQUITY_TICKER = /^[A-Z]{1,6}(?:[.-][A-Z]{1,4})?$/;

/**
 * A masked label is drawn from a closed character set: ASCII letters and
 * digits, space, `. - _ ( ) # *`, the bullet and the ellipsis. Blacklisting
 * cannot hold this line: fullwidth or other-script digits slip past a
 * digit-run rule, and confusable letters or direction overrides can make an
 * approval card read as something it is not. The two non-ASCII members are
 * built from their code points so no editor or escape layer can swap them.
 */
const CLOSED_LABEL_CHARACTERS = new RegExp(`^[A-Za-z0-9 ._()#*${String.fromCharCode(0x2022, 0x2026)}-]+$`, "u");

/**
 * Control characters are refused everywhere, and that now means ALL of them.
 *
 * The previous range skipped tab, newline and carriage return while the
 * comment above it claimed they were refused everywhere — a doc/code
 * disagreement inside a security boundary. Every field validated by `text()`
 * is single-line by construction (a risk reason, a masked label, a policy
 * version, a refusal message), and those are exactly the strings that reach
 * terminal output, log lines and support bundles, where an embedded newline
 * lets one record forge a second one.
 *
 * Multi-line content uses `multilineText()` below, which states its newline
 * policy explicitly rather than widening this.
 */
const CONTROL = /[\u0000-\u001f\u007f]/u;

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

/** The frozen `/1` ticker. Never use it for a shape that can authorize an order. */
export function symbol(value: unknown, name: string): string {
  if (typeof value !== "string" || !SYMBOL.test(value)) fail(`${name} must be a bounded uppercase ticker.`);
  return value;
}

/** The strict ticker every executable (`/2`) shape and the browser order wire use. */
export function equityTicker(value: unknown, name: string): string {
  if (typeof value !== "string" || !EQUITY_TICKER.test(value)) fail(`${name} must be an equity ticker such as SPY or BRK.B.`);
  return value;
}

/**
 * A masked account label from the closed character set, with at most four
 * consecutive digits so it cannot carry a full account number.
 */
export function closedMaskedLabel(value: unknown, name: string): string {
  const label = text(value, name, 64);
  if (!CLOSED_LABEL_CHARACTERS.test(label)) {
    fail(`${name} must use only letters, digits, spaces, masking bullets and . - _ ( ) # *.`);
  }
  if (/[0-9]{5,}/.test(label)) fail(`${name} must not embed a full account number.`);
  return label;
}

/**
 * An RFC 3339 UTC instant, normalized to Z. Timestamps are compared across
 * two languages and three processes; a local offset would make "expired"
 * depend on who parsed it, so only explicit UTC is accepted.
 *
 * The field values are re-derived from the parsed instant and compared back
 * to the input, because `Date.parse` silently ROLLS OVER an impossible
 * calendar date: "2026-02-30T00:00:00Z" parses cleanly as 2 March. An
 * expiry that quietly moves is not an expiry.
 */
export function timestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length > 40) fail(`${name} must be an RFC 3339 UTC timestamp.`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) fail(`${name} must be an RFC 3339 UTC timestamp ending in Z.`);
  const parts = match as unknown as string[];
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${name} is not a real instant.`);
  const utc = new Date(parsed);
  const same =
    utc.getUTCFullYear() === Number(parts[1]) &&
    utc.getUTCMonth() + 1 === Number(parts[2]) &&
    utc.getUTCDate() === Number(parts[3]) &&
    utc.getUTCHours() === Number(parts[4]) &&
    utc.getUTCMinutes() === Number(parts[5]) &&
    utc.getUTCSeconds() === Number(parts[6]);
  if (!same) fail(`${name} is not a real calendar date.`);
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

/**
 * Forbidden inside multi-line text: every C0 control except tab and newline,
 * plus DEL and the C1 range. Carriage return is REJECTED rather than
 * normalized — these strings get digested, and silently folding CRLF to LF
 * would mean a note round-tripped through a Windows editor hashes
 * differently from the identical-looking text it came from. Refusing is the
 * only behaviour that keeps a digest meaning what it appears to mean.
 */
const MULTILINE_FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/u;

/**
 * Bounded prose: a journal note, a thesis, a compiler diagnostic. Permits
 * newline and tab; refuses carriage return and every other control
 * character. Like `text()`, it never embeds the offending value in its error.
 */
export function multilineText(
  value: unknown,
  name: string,
  max: number,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") fail(`${name} must be a string.`);
  if (!options.allowEmpty && !value.length) fail(`${name} must not be empty.`);
  if (value.length > max) fail(`${name} exceeds its ${max} character limit.`);
  if (MULTILINE_FORBIDDEN.test(value)) {
    fail(`${name} contains control characters; carriage returns are refused rather than normalized.`);
  }
  return value;
}
