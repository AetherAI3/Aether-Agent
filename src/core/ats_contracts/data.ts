// Spec 2 section 8 — configured-versus-verified market data.
//
// The whole point of splitting these two documents is that CONFIGURING a
// provider proves nothing about whether data is arriving:
//
//   DataProfileV1      — what the operator asked for. Durable, edited by hand,
//                        and by itself never evidence of connectivity.
//   DataProbeReceiptV1 — what a live probe actually saw, and how stale it was
//                        by the time it landed. Perishable evidence.
//
// Spec 2 section 8.2 states the rule this module mechanises: settings cannot
// persist `connected: true`, and a previous successful probe is not perpetual
// evidence. So there is deliberately no field anywhere in DataProfileV1 that
// can hold a connection verdict — the type makes the mistake unrepresentable
// rather than relying on a reviewer to catch it.
//
// NOTE on provider coverage. Spec 2 section 5 step 4 admits exactly three
// providers here: none, yfinance, polygon. `custom` is intentionally absent.
// packages/ats-skills/src/settings.js still accepts `custom` in its own older
// `aether.ats.settings/1` shape; reconciling that is PR 2.4's job together
// with the settings/1 to /2 migration in section 15, because dropping it from
// the validator today would throw on an existing operator's saved file rather
// than degrade it.

import {
  choice,
  closed,
  fail,
  ident,
  integer,
  nullable,
  schemaTag,
  symbol,
  text,
  timestamp,
  uniqueList,
} from "./primitives.js";

export const DATA_PROFILE_SCHEMA = "aether.ats.data-profile/1" as const;
export const DATA_PROBE_SCHEMA = "aether.ats.data-probe/1" as const;

export const DATA_PROVIDERS = ["none", "yfinance", "polygon"] as const;
export type DataProvider = (typeof DATA_PROVIDERS)[number];

/** Timeframes the native providers support, matching the existing ats-skills bound. */
const TIMEFRAME = /^(?:M(?:1|2|3|5|10|15|30)|H(?:1|2|4|6|8|12)|D1|W1)$/;

/**
 * A credential REFERENCE. Spec 2 section 8.1: `credential_ref` names a local
 * secret reference, never a secret value. Requiring a namespace prefix is what
 * makes that mechanical — a pasted API key has no `env:`/`vault:` prefix and
 * cannot satisfy this shape, so a leak becomes a validation error at the
 * boundary instead of a secret written into a profile file and later echoed
 * into a support bundle.
 */
const CREDENTIAL_REF = /^(?:env:[A-Z_][A-Z0-9_]{0,127}|vault:[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

export function credentialRef(value: unknown, name: string): string {
  if (typeof value !== "string" || !CREDENTIAL_REF.test(value)) {
    fail(`${name} must be an env: or vault: reference, never a credential value.`);
  }
  return value;
}

export interface DataProfileV1 {
  readonly schema_version: typeof DATA_PROFILE_SCHEMA;
  readonly profile_id: string;
  readonly provider: DataProvider;
  readonly symbols: readonly string[];
  readonly timeframe: string;
  readonly poll_interval_ms: number;
  readonly credential_ref: string | null;
  readonly configured_at: string;
}

const PROFILE_FIELDS = [
  "schema_version", "profile_id", "provider", "symbols",
  "timeframe", "poll_interval_ms", "credential_ref", "configured_at",
] as const;

export function validateDataProfile(value: unknown, name = "Data profile"): DataProfileV1 {
  const raw = closed(value, name, PROFILE_FIELDS);
  const provider = choice(raw.provider, DATA_PROVIDERS, `${name} provider`);
  const symbols = uniqueList(raw.symbols, `${name} symbols`, 100, symbol);
  const timeframe = text(raw.timeframe, `${name} timeframe`, 8);
  if (!TIMEFRAME.test(timeframe)) fail(`${name} timeframe is unsupported.`);
  const credential = raw.credential_ref === null ? null : credentialRef(raw.credential_ref, `${name} credential reference`);

  // An unconfigured provider carries no symbols and no credential. Otherwise a
  // profile could sit in "none" while still displaying SPY and QQQ, which reads
  // to an operator as a configured feed that simply is not polling.
  if (provider === "none" && (symbols.length || credential !== null)) {
    fail(`${name} cannot carry symbols or a credential while no provider is selected.`);
  }
  // The native yfinance adapter takes no credential.
  if (provider === "yfinance" && credential !== null) {
    fail(`${name} yfinance provider takes no credential reference.`);
  }
  // Polygon is key-gated. A profile without a reference cannot be probed, so it
  // is refused at configuration time rather than failing later as "unavailable"
  // with a reason the operator cannot act on.
  if (provider === "polygon" && credential === null) {
    fail(`${name} polygon provider requires a credential reference.`);
  }

  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, DATA_PROFILE_SCHEMA, name) as typeof DATA_PROFILE_SCHEMA,
    profile_id: ident(raw.profile_id, `${name} profile id`),
    provider,
    symbols: Object.freeze(symbols),
    timeframe,
    poll_interval_ms: integer(raw.poll_interval_ms, `${name} poll interval`, 1_000, 300_000),
    credential_ref: credential,
    configured_at: timestamp(raw.configured_at, `${name} configured at`),
  });
}

export const DATA_PROBE_STATES = ["verified", "stale", "unavailable"] as const;
export type DataProbeState = (typeof DATA_PROBE_STATES)[number];

export interface DataProbeReceiptV1 {
  readonly schema_version: typeof DATA_PROBE_SCHEMA;
  readonly probe_id: string;
  readonly profile_id: string;
  readonly provider: DataProvider;
  readonly state: DataProbeState;
  readonly sample_count: number;
  readonly symbols_verified: readonly string[];
  readonly observed_at: string | null;
  readonly received_at: string;
  readonly freshness_ms: number | null;
  readonly reason: string | null;
}

const PROBE_FIELDS = [
  "schema_version", "probe_id", "profile_id", "provider", "state", "sample_count",
  "symbols_verified", "observed_at", "received_at", "freshness_ms", "reason",
] as const;

export function validateDataProbeReceipt(value: unknown, name = "Data probe receipt"): DataProbeReceiptV1 {
  const raw = closed(value, name, PROBE_FIELDS);
  const state = choice(raw.state, DATA_PROBE_STATES, `${name} state`);
  const sampleCount = integer(raw.sample_count, `${name} sample count`, 0, 1_000_000);
  const verified = uniqueList(raw.symbols_verified, `${name} verified symbols`, 100, symbol);
  const observedAt = nullable(raw.observed_at, `${name} observed at`, timestamp);
  const receivedAt = timestamp(raw.received_at, `${name} received at`);
  const freshness = raw.freshness_ms === null
    ? null
    : integer(raw.freshness_ms, `${name} freshness`, 0, 30 * 24 * 60 * 60_000);
  // Provider errors are bounded and redacted (section 8.2). The reason is a
  // short operator sentence, never an adapter exception that may carry a
  // provider URL or a credential fragment.
  const reason = raw.reason === null ? null : text(raw.reason, `${name} reason`, 200);

  // `verified` is the only state that asserts data actually arrived, so it is
  // the only state permitted to claim samples, symbols and an observation time.
  if (state === "verified") {
    if (sampleCount < 1) fail(`${name} cannot be verified without at least one sample.`);
    if (!verified.length) fail(`${name} cannot be verified without a verified symbol.`);
    if (observedAt === null || freshness === null) {
      fail(`${name} cannot be verified without an observation time and freshness.`);
    }
  }
  // An unavailable probe saw nothing. Letting it carry samples would make a
  // failed probe indistinguishable from a successful one in an aggregate view.
  if (state === "unavailable" && (sampleCount > 0 || verified.length || observedAt !== null)) {
    fail(`${name} cannot report samples while the provider is unavailable.`);
  }
  // Anything other than a clean verification owes the operator a reason.
  if (state !== "verified" && reason === null) {
    fail(`${name} must explain why the provider is ${state}.`);
  }
  // An observation cannot postdate its receipt: that is a clock fault or a
  // fabricated timestamp, and treating it as "very fresh" would defeat the
  // staleness check entirely.
  if (observedAt !== null && Date.parse(observedAt) > Date.parse(receivedAt)) {
    fail(`${name} cannot have been observed after it was received.`);
  }

  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, DATA_PROBE_SCHEMA, name) as typeof DATA_PROBE_SCHEMA,
    probe_id: ident(raw.probe_id, `${name} probe id`),
    profile_id: ident(raw.profile_id, `${name} profile id`),
    provider: choice(raw.provider, DATA_PROVIDERS, `${name} provider`),
    state,
    sample_count: sampleCount,
    symbols_verified: Object.freeze(verified),
    observed_at: observedAt,
    received_at: receivedAt,
    freshness_ms: freshness,
    reason,
  });
}

/**
 * Default freshness ceiling. Spec 2 section 8.2 requires activation to recheck
 * freshness rather than trust a stored verdict, so this is the age at which a
 * previously verified receipt stops counting as evidence.
 */
export const DATA_FRESHNESS_CEILING_MS = 60_000;

/**
 * Re-evaluate a stored receipt against the clock. A receipt that was verified
 * an hour ago is `stale` now — it does not become unavailable, because nothing
 * new has failed; it simply is no longer current evidence.
 *
 * This exists because section 8.2 forbids treating a previous successful probe
 * as perpetual evidence, and section 17's stale-data canary requires a
 * previously verified feed to block a NEW activation.
 */
export function ageProbeReceipt(
  receipt: DataProbeReceiptV1,
  now: number,
  ceilingMs: number = DATA_FRESHNESS_CEILING_MS,
): DataProbeReceiptV1 {
  if (receipt.state !== "verified") return receipt;
  if (!Number.isSafeInteger(ceilingMs) || ceilingMs < 1) fail("Data freshness ceiling is out of bounds.");
  const observed = receipt.observed_at === null ? NaN : Date.parse(receipt.observed_at);
  const age = now - observed;
  if (Number.isFinite(observed) && age >= 0 && age <= ceilingMs) return receipt;
  return validateDataProbeReceipt({
    ...receipt,
    symbols_verified: [...receipt.symbols_verified],
    state: "stale",
    reason: "The last verified sample is older than the freshness ceiling. Run a fresh probe.",
  });
}

/**
 * Whether this receipt may gate a strategy activation. Section 9 permits
 * activation only with verified runtime AND data inputs, and section 8.2 adds
 * that a strategy requiring unavailable signals cannot reach `active`.
 */
export function probeAdmitsActivation(receipt: DataProbeReceiptV1, now: number): boolean {
  return ageProbeReceipt(receipt, now).state === "verified";
}

/**
 * The two-line operator rendering section 5 step 4 mandates. Configuration and
 * runtime truth are printed on separate lines and never merged, so a configured
 * provider can never read as a connected one.
 */
export function formatDataTruth(profile: DataProfileV1, receipt: DataProbeReceiptV1 | null, now: number): string {
  const symbols = profile.symbols.length ? profile.symbols.join(", ") : "no symbols";
  const configured = `Configured: ${profile.provider} · ${symbols} · ${profile.timeframe}`;
  if (!receipt || receipt.profile_id !== profile.profile_id) {
    return `${configured}\nRuntime:    Unverified · run probe`;
  }
  const aged = ageProbeReceipt(receipt, now);
  const detail = aged.state === "verified" ? `${aged.sample_count} samples` : aged.reason ?? "no reason given";
  return `${configured}\nRuntime:    ${aged.state} · ${detail}`;
}
