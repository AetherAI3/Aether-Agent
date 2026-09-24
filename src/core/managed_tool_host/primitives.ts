// Closed-shape checks shared by every managed tool host validator.
//
// Each check returns the value it was given, never a substitute, so a digest
// computed over validated output is a digest over what arrived. Messages name
// the field path and never echo the value (errors.ts).

import { fail } from "./errors.js";
import { CLOCK_SKEW_MS, MAX_ARRAY_ENTRIES, MAX_SAFE, MAX_STRING_SCALARS, MAX_TOOL_VERSION } from "./vocabulary.js";

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Raw = Readonly<Record<string, unknown>>;
export type Check<T> = (value: unknown, path: string) => T;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SCHEMA_ID = new RegExp("^aether[.][a-z0-9.-]+/[1-9][0-9]*$");
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const PRINTABLE_ASCII = /^[ -~]{1,64}$/;
const DISPLAY = /^[ -~]*$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const TIMESTAMP = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})[.]([0-9]{3})Z$/;
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const ORIGIN = new RegExp(`^https://(${LABEL}(?:[.]${LABEL})+)(?::([1-9][0-9]{0,4}))?$`);
/** Final characters whose unused low bits are zero: one spelling per byte string. */
const CANONICAL_LAST: Readonly<Record<32 | 64, string>> = { 32: "AEIMQUYcgkosw048", 64: "AQgw" };
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function object(value: unknown, path: string): Raw {
  if (!isPlainObject(value)) fail(`${path} must be a JSON object.`);
  return value;
}

export function closed(value: unknown, path: string, fields: readonly string[]): Raw {
  const raw = object(value, path);
  for (const key of Object.keys(raw)) if (!fields.includes(key)) fail(`${path} contains an unsupported field.`);
  return raw;
}

/** A top-level object: its schema tag is checked before any other rule. */
export function envelope(value: unknown, label: string, schema: string, fields: readonly string[]): Raw {
  const raw = object(value, label);
  if (raw["schema"] !== schema) fail(`${label} schema must be ${schema}.`);
  return closed(raw, label, fields);
}

/** Reads `field` through `check`, labelled `prefix + field`. */
export function fieldOf(raw: Raw, prefix: string): <T>(field: string, check: Check<T>) => T {
  return <T>(field: string, check: Check<T>): T => check(raw[field], prefix + field);
}

function grammar(pattern: RegExp, message: string): Check<string> {
  return (value, path) => {
    if (typeof value !== "string" || !pattern.test(value)) fail(`${path} ${message}`);
    return value;
  };
}

export const id = grammar(ID, "must be an ID.");
export const digest = grammar(DIGEST, "must be a sha256 digest.");
export const toolName = grammar(TOOL_NAME, "must be a tool name.");
export const diagnosticCode = grammar(DIAGNOSTIC_CODE, "must be an uppercase code of 1 to 64 characters.");
export const printableAscii = grammar(PRINTABLE_ASCII, "must be 1 to 64 printable ASCII characters.");

export function deviceId(value: unknown, path: string): string {
  if (typeof value !== "string" || !ID.test(value) || !value.startsWith("scdev_")) fail(`${path} must be an scdev_ device ID.`);
  return value;
}

export function schemaId(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > 128 || !SCHEMA_ID.test(value)) fail(`${path} must be a schema ID.`);
  return value;
}

function timestampParts(match: RegExpExecArray): readonly number[] {
  return match.slice(1, 8).map(Number);
}

/** Whether a timestamp-shaped match names a real Gregorian instant, year 0001 to 9999, no leap second. */
function realInstant(match: RegExpExecArray): boolean {
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = timestampParts(match);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
  return year >= 1 && monthDays !== undefined && day >= 1 && day <= monthDays && hour <= 23 && minute <= 59 && second <= 59;
}

/** UTC with exactly millisecond precision, on the real Gregorian calendar. */
export function timestamp(value: unknown, path: string): string {
  const match = typeof value === "string" ? TIMESTAMP.exec(value) : null;
  if (!match) fail(`${path} must be a UTC timestamp with milliseconds.`);
  if (match && !realInstant(match)) fail(`${path} is not a real UTC instant.`);
  return value as string;
}

/** Days since 1970-01-01 in the proleptic Gregorian calendar (Hinnant's days_from_civil). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  return era * 146_097 + yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear - 719_468;
}

/** Epoch milliseconds of a validated timestamp, by explicit arithmetic rather than Date.parse. */
export function epochMs(value: string): number {
  const match = TIMESTAMP.exec(value);
  if (!match) fail("epochMs requires a validated timestamp.");
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0, millis = 0] = timestampParts(match);
  return ((daysFromCivil(year, month, day) * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis;
}

export function clock(now: number): number {
  if (!Number.isSafeInteger(now)) fail("now must be an integer of epoch milliseconds.");
  return now;
}

/** An integer within [min, max]. Magnitude beyond 2^53 - 1 is a range refusal: every bound here is safe. */
export function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || Object.is(value, -0)) fail(`${path} must be an integer.`);
  if (value < min || value > max) fail(`${path} is out of range.`);
  return value;
}

export const range = (min: number, max: number): Check<number> => (value, path) => integer(value, path, min, max);
export const uint53 = range(0, MAX_SAFE);
export const positive53 = range(1, MAX_SAFE);
export const toolVersion = range(1, MAX_TOOL_VERSION);

export function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(`${path} must be a boolean.`);
  return value;
}

export function choice<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) fail(`${path} is not an allowed value.`);
  return value as T;
}

export const oneOf = <T extends string>(allowed: readonly T[]): Check<T> => (value, path) => choice(value, allowed, path);

export const constant = <T extends string | boolean>(expected: T): Check<T> => (value, path) => {
  if (value !== expected) fail(`${path} must be ${JSON.stringify(expected)}.`);
  return value as T;
};

/** An array pinned to one exact value, such as ["local_read_tools"]. */
export const constantList = (expected: readonly string[]): Check<readonly string[]> => (value, path) => {
  if (!Array.isArray(value) || value.length !== expected.length || !expected.every((entry, i) => value[i] === entry)) {
    fail(`${path} must be ${JSON.stringify(expected)}.`);
  }
  return Array.isArray(value) ? Object.freeze([...(value as string[])]) : (value as readonly string[]);
};

export const nullable = <T>(check: Check<T>): Check<T | null> => (value, path) => (value === null ? null : check(value, path));

export function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    }
  }
  return false;
}

/** Unicode Cc: U+0000 to U+001F and U+007F to U+009F. */
export function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f)) return true;
  }
  return false;
}

/** Unicode scalar values in a string already known to have no unpaired surrogate. */
function scalarCount(value: string): number {
  let count = value.length;
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) count -= 1;
  }
  return count;
}

function stringHygiene(value: string, path: string): void {
  if (hasUnpairedSurrogate(value)) fail(`${path} contains an unpaired surrogate.`);
  if (hasControl(value)) fail(`${path} contains a control character.`);
}

/** Bounded text; length counts Unicode scalar values, not UTF-16 units. */
export function text(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== "string") fail(`${path} must be a string.`);
  stringHygiene(value, path);
  const count = scalarCount(value);
  if (count < min || count > max) fail(`${path} must be ${min} to ${max} characters.`);
  return value;
}

/** 1 to 256 scalars with no Cc or unpaired surrogate: account_subject, which is hashed and never displayed. */
export const boundedText: Check<string> = (value, path) => text(value, path, 1, MAX_STRING_SCALARS);

/**
 * aether.safe-display/1 (error.message, diagnostics[].summary): 1 to 256
 * printable ASCII characters, U+0020 to U+007E. Nothing a model or terminal
 * could render invisibly, and no Unicode table to drift between languages.
 */
export function safeDisplay(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} must be a string.`);
  if (!DISPLAY.test(value)) fail(`${path} must contain only printable ASCII characters.`);
  if (value.length < 1 || value.length > MAX_STRING_SCALARS) fail(`${path} must be 1 to 256 characters.`);
  return value;
}

/** Unpadded base64url of exactly 32 or 64 bytes, in its single canonical spelling. */
export function base64url(value: unknown, path: string, bytes: 32 | 64): string {
  const chars = bytes === 32 ? 43 : 86;
  if (typeof value !== "string" || value.length !== chars || !BASE64URL.test(value)) {
    fail(`${path} must be ${chars} unpadded base64url characters.`);
  }
  if (!CANONICAL_LAST[bytes].includes(value.charAt(chars - 1))) fail(`${path} is not canonical base64url.`);
  return value;
}

export const bytes32: Check<string> = (value, path) => base64url(value, path, 32);
export const bytes64: Check<string> = (value, path) => base64url(value, path, 64);

export function decodeBase64url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

/** A normalized lowercase https origin: dotted host, no IP literal, no path, no default port. */
export function httpsOrigin(value: unknown, path: string): string {
  const match = typeof value === "string" && value.length <= MAX_STRING_SCALARS ? ORIGIN.exec(value) : null;
  const host = match?.[1] ?? "";
  const port = match?.[2] === undefined ? null : Number(match[2]);
  const topLabel = host.slice(host.lastIndexOf(".") + 1);
  if (!match || host.length > 253 || !/[a-z]/.test(topLabel) || port === 443 || (port !== null && port > 65_535)) {
    fail(`${path} must be a lowercase https origin.`);
  }
  return value as string;
}

export function array(value: unknown, path: string, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array.`);
  if (value.length < min || value.length > max) fail(`${path} must contain ${min} to ${max} entries.`);
  return value;
}

/** Validates every index, holes included, labelling each `path[i]`. */
export function items<T>(values: readonly unknown[], path: string, item: Check<T>): readonly T[] {
  const out: T[] = [];
  for (let i = 0; i < values.length; i += 1) out.push(item(values[i], `${path}[${i}]`));
  return Object.freeze(out);
}

export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const delta = (left[i]?.codePointAt(0) ?? 0) - (right[i]?.codePointAt(0) ?? 0);
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

/**
 * Unique and strictly ascending. Repetition and order are separate refusals
 * (equal neighbours are not "out of order"), so each has its own vector.
 */
export function strictlyAscending<T>(entries: readonly T[], key: (entry: T) => string, compare: (a: T, b: T) => number, repeated: string, unordered: string): void {
  if (new Set(entries.map(key)).size !== entries.length) fail(repeated);
  for (let i = 1; i < entries.length; i += 1) if (compare(entries[i - 1] as T, entries[i] as T) > 0) fail(unordered);
}

/** A set-like array: strictly ascending by code point, no duplicates, never reordered. */
export function stringSet<T extends string>(min: number, max: number, item: Check<T>): Check<readonly T[]> {
  return (value, path) => {
    const entries = items(array(value, path, min, max), path, item);
    strictlyAscending(entries, (entry) => entry, compareCodePoints, `${path} must not contain duplicates.`, `${path} must be in ascending code point order.`);
    return entries;
  };
}

function jsonString(value: string, path: string): string {
  stringHygiene(value, path);
  if (scalarCount(value) > MAX_STRING_SCALARS) fail(`${path} contains a string longer than 256 characters.`);
  return value;
}

function walk(value: unknown, path: string, maxDepth: number, depth: number): Json {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      fail(`${path} contains a number that is not an integer from 0 to 2^53 - 1.`);
    }
    return value;
  }
  if (typeof value === "string") return jsonString(value, path);
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) fail(`${path} contains a value that is not JSON.`);
  if (depth + 1 > maxDepth) fail(`${path} nests deeper than ${maxDepth} levels.`);
  if (isArray) {
    const list = value as readonly unknown[];
    if (list.length > MAX_ARRAY_ENTRIES) fail(`${path} contains an array longer than 32 entries.`);
    const out: Json[] = [];
    for (let i = 0; i < list.length; i += 1) {
      if (!Object.hasOwn(list, i)) fail(`${path} contains a value that is not JSON.`);
      out.push(walk(list[i], path, maxDepth, depth + 1));
    }
    return Object.freeze(out);
  }
  const record = value as Raw;
  const entries = Object.keys(record).map((key) => [jsonString(key, path), walk(record[key], path, maxDepth, depth + 1)] as const);
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * An open JSON value (tool arguments or payload): unsigned safe integers only,
 * no control characters or unpaired surrogates in any string or key, the
 * common string and array bounds, and at most `maxDepth` container levels.
 * Returns a frozen copy. Messages name only `path`: keys are caller data.
 */
export function jsonValue(value: unknown, path: string, maxDepth: number): Json {
  return walk(value, path, maxDepth, 0);
}

export function lifetime(label: string, start: string, startField: string, end: string, maxMs: number, human: string): void {
  const from = epochMs(start);
  const until = epochMs(end);
  if (until <= from) fail(`${label} expires_at must be later than ${startField}.`);
  if (until - from > maxMs) fail(`${label} lifetime exceeds ${human}.`);
}

/** Fresh at `now` allowing CLOCK_SKEW_MS either way: started no later than now + skew, not past expiry + skew. */
export function fresh(label: string, start: string, startField: string, end: string, now: number): void {
  if (epochMs(start) > now + CLOCK_SKEW_MS) fail(`${label} ${startField} is in the future.`);
  if (now >= epochMs(end) + CLOCK_SKEW_MS) fail(`${label} has expired.`);
}

export function matchDigest(label: string, field: string, claimed: string, computed: string): void {
  if (claimed !== computed) fail(`${label} ${field} does not match its contents.`);
}
