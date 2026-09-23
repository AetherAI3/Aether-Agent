// DelegatedTradingGrantV1 — Spec 1 section 11.3.
//
// A grant is the only thing in this freeze that says "yes". Everything else
// describes, observes or receipts. Three details carry most of the safety:
//
//   1. An EMPTY symbol allowlist means NONE, never "all". The spec says so
//      outright ("explicit symbol allowlist; empty means none") because the
//      opposite default is the classic way an allowlist becomes a wildcard the
//      first time a config load half-fails. grantPermits() therefore refuses an
//      empty list before it looks at anything else, and there is no wildcard
//      token to spell.
//
//   2. `confirmation` is pinned to "per_order". Spec 1 section 8 notes the
//      provider can permit an agent to place orders without per-order
//      confirmation; Aether refuses that mode for this program, and a grant
//      that tries to express it fails to parse.
//
//   3. The per-symbol position cap is enforced here. Spec 1 section 11.3 flags
//      it as declared-but-unenforced today and section 16 blocks delegated
//      paper on it, so it is a first-class field with a real check rather than
//      an advisory number.

import {
  bool,
  choice,
  closed,
  equityTicker,
  fail,
  ident,
  integer,
  minorUnits,
  opaqueRef,
  orderedWindow,
  pinned,
  schemaTag,
  symbol,
  timestamp,
  uniqueList,
  type FieldCheck,
  type Retagged,
} from "./primitives.js";
import { EXECUTION_ENVIRONMENTS, type ExecutionEnvironment } from "./mode.js";

export const TRADING_GRANT_SCHEMA = "aether.ats.delegated-trading-grant/1" as const;
/** Frozen `/1` admits URL-shaped allowlist entries; `/2` requires equity tickers. */
export const TRADING_GRANT_SCHEMA_V2 = "aether.ats.delegated-trading-grant/2" as const;

/** What a grant may authorize. Deliberately coarse and short. */
export const GRANT_CAPABILITIES = ["read_account", "review_order", "commit_order"] as const;
export type GrantCapability = (typeof GRANT_CAPABILITIES)[number];

export const ORDER_SIDES = ["buy", "sell"] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];

export const ORDER_TYPES = ["market", "limit"] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const GRANT_STATES = ["active", "suspended", "revoked", "expired"] as const;
export type GrantState = (typeof GRANT_STATES)[number];

/** Bounds the grant enforces. All money is integer minor units. */
export interface GrantLimits {
  readonly max_notional_per_order_minor: number;
  readonly max_notional_per_day_minor: number;
  readonly max_position_notional_per_symbol_minor: number;
  readonly max_orders_per_day: number;
  readonly max_open_orders: number;
}

/** Consumption so far, supplied by ATSv2 — never by the caller requesting an order. */
export interface GrantUsage {
  readonly notional_today_minor: number;
  readonly orders_today: number;
  readonly open_orders: number;
}

export interface DelegatedTradingGrantV1 {
  readonly schema_version: typeof TRADING_GRANT_SCHEMA;
  readonly grant_id: string;
  readonly grant_version: number;
  readonly client_principal: string;
  readonly provider_id: string;
  readonly opaque_account_ref: string;
  readonly execution_environment: ExecutionEnvironment;
  readonly capabilities: readonly GrantCapability[];
  /** Empty means no symbol is permitted. There is no wildcard. */
  readonly symbol_allowlist: readonly string[];
  readonly limits: GrantLimits;
  readonly allowed_sides: readonly OrderSide[];
  readonly allowed_order_types: readonly OrderType[];
  /** Pinned "per_order". Standing or session approval is not expressible. */
  readonly confirmation: "per_order";
  readonly state: GrantState;
  readonly abuse_flagged: boolean;
  readonly issued_at: string;
  readonly expires_at: string;
}

/** Same fields as `/1`; every allowlist entry must be an equity ticker (`equityTicker()`). */
export interface DelegatedTradingGrantV2 extends Omit<DelegatedTradingGrantV1, "schema_version"> {
  readonly schema_version: typeof TRADING_GRANT_SCHEMA_V2;
}

const GRANT_FIELDS = [
  "schema_version",
  "grant_id",
  "grant_version",
  "client_principal",
  "provider_id",
  "opaque_account_ref",
  "execution_environment",
  "capabilities",
  "symbol_allowlist",
  "limits",
  "allowed_sides",
  "allowed_order_types",
  "confirmation",
  "state",
  "abuse_flagged",
  "issued_at",
  "expires_at",
] as const;

const LIMIT_FIELDS = [
  "max_notional_per_order_minor",
  "max_notional_per_day_minor",
  "max_position_notional_per_symbol_minor",
  "max_orders_per_day",
  "max_open_orders",
] as const;

const USAGE_FIELDS = ["notional_today_minor", "orders_today", "open_orders"] as const;

function validateLimits(value: unknown, name: string): GrantLimits {
  const raw = closed(value, name, LIMIT_FIELDS);
  const limits = {
    max_notional_per_order_minor: minorUnits(raw.max_notional_per_order_minor, `${name} per-order notional`),
    max_notional_per_day_minor: minorUnits(raw.max_notional_per_day_minor, `${name} daily notional`),
    max_position_notional_per_symbol_minor: minorUnits(
      raw.max_position_notional_per_symbol_minor,
      `${name} per-symbol position notional`,
    ),
    max_orders_per_day: integer(raw.max_orders_per_day, `${name} daily order count`, 0, 10_000),
    max_open_orders: integer(raw.max_open_orders, `${name} open order count`, 0, 1_000),
  };
  // A per-order cap above the daily cap is not a bound, it is a typo that reads
  // as a bound. Refuse it rather than silently letting the daily figure govern.
  if (limits.max_notional_per_order_minor > limits.max_notional_per_day_minor) {
    fail(`${name} per-order notional cannot exceed the daily notional.`);
  }
  return Object.freeze(limits);
}

export function validateGrantUsage(value: unknown, name = "Grant usage"): GrantUsage {
  const raw = closed(value, name, USAGE_FIELDS);
  return Object.freeze({
    notional_today_minor: minorUnits(raw.notional_today_minor, `${name} notional today`),
    orders_today: integer(raw.orders_today, `${name} orders today`, 0, 1_000_000),
    open_orders: integer(raw.open_orders, `${name} open orders`, 0, 1_000_000),
  });
}

export function validateTradingGrant(value: unknown, name = "Trading grant"): DelegatedTradingGrantV1 {
  return tradingGrant(value, name, TRADING_GRANT_SCHEMA, symbol);
}

/** `/2`: the `/1` grant, except that every allowlist entry must be an equity ticker. */
export function validateTradingGrantV2(value: unknown, name = "Trading grant"): DelegatedTradingGrantV2 {
  return tradingGrant(value, name, TRADING_GRANT_SCHEMA_V2, equityTicker);
}

/** One body for both versions; only the schema tag and the allowlist entry check vary. */
function tradingGrant<S extends string>(
  value: unknown,
  name: string,
  schema: S,
  ticker: FieldCheck,
): Retagged<DelegatedTradingGrantV1, S> {
  const raw = closed(value, name, GRANT_FIELDS);
  const issuedAt = timestamp(raw.issued_at, `${name} issued_at`);
  const expiresAt = timestamp(raw.expires_at, `${name} expires_at`);
  orderedWindow(issuedAt, expiresAt, `${name} validity window`);

  const capabilities = uniqueList(raw.capabilities, `${name} capabilities`, GRANT_CAPABILITIES.length, (v, n) =>
    choice(v, GRANT_CAPABILITIES, n),
  );
  // Committing an order you may not review skips the reconciliation step the
  // whole authority chain is built on.
  if (capabilities.includes("commit_order") && !capabilities.includes("review_order")) {
    fail(`${name} cannot grant commit without review.`);
  }

  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, schema, name) as S,
    grant_id: ident(raw.grant_id, `${name} id`),
    grant_version: integer(raw.grant_version, `${name} version`, 1, Number.MAX_SAFE_INTEGER),
    client_principal: ident(raw.client_principal, `${name} client principal`),
    provider_id: ident(raw.provider_id, `${name} provider`),
    opaque_account_ref: opaqueRef(raw.opaque_account_ref, `${name} opaque account reference`),
    execution_environment: choice(raw.execution_environment, EXECUTION_ENVIRONMENTS, `${name} execution environment`),
    capabilities: Object.freeze(capabilities),
    symbol_allowlist: Object.freeze(uniqueList(raw.symbol_allowlist, `${name} symbol allowlist`, 100, ticker)),
    limits: validateLimits(raw.limits, `${name} limits`),
    allowed_sides: Object.freeze(
      uniqueList(raw.allowed_sides, `${name} sides`, ORDER_SIDES.length, (v, n) => choice(v, ORDER_SIDES, n)),
    ),
    allowed_order_types: Object.freeze(
      uniqueList(raw.allowed_order_types, `${name} order types`, ORDER_TYPES.length, (v, n) =>
        choice(v, ORDER_TYPES, n),
      ),
    ),
    confirmation: pinned(raw.confirmation, "per_order" as const, `${name} confirmation`),
    state: choice(raw.state, GRANT_STATES, `${name} state`),
    // Strict. `raw.abuse_flagged === true` would have turned a missing key, a
    // null, or the string "true" into `false` — i.e. silently downgraded an
    // abuse flag to "not abusive", which is the one direction this field must
    // never fail in.
    abuse_flagged: bool(raw.abuse_flagged, `${name} abuse flag`),
    issued_at: issuedAt,
    expires_at: expiresAt,
  });
}

/** A single order's shape, as the grant check sees it. */
export interface GrantCheckRequest {
  readonly symbol: string;
  readonly side: OrderSide;
  readonly order_type: OrderType;
  readonly worst_case_notional_minor: number;
  /** Resulting position notional for this symbol if the order fills. */
  readonly resulting_position_notional_minor: number;
  readonly execution_environment: ExecutionEnvironment;
}

export type GrantDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

function deny(reason: string): GrantDecision {
  return Object.freeze({ allowed: false as const, reason });
}

const ALLOWED: GrantDecision = Object.freeze({ allowed: true as const });

/**
 * Decide whether a grant admits one order, given current usage.
 *
 * Returns a decision rather than throwing: a refusal is an ordinary, expected
 * outcome that the operator sheet renders, not an exceptional condition. Every
 * denial carries a reason so the approval card can say WHY a proposal was
 * blocked instead of showing an unexplained empty state.
 *
 * Deliberately total and side-effect free — it reserves nothing. Reservation
 * and consumption stay with ATSv2's existing atomic reservation path;
 * duplicating them here would create a second ledger.
 */
export function grantPermits(
  grant: DelegatedTradingGrantV1 | DelegatedTradingGrantV2,
  request: GrantCheckRequest,
  usage: GrantUsage,
  nowMs: number = Date.now(),
): GrantDecision {
  if (grant.state !== "active") return deny(`Grant is ${grant.state}.`);
  if (grant.abuse_flagged) return deny("Grant is flagged for abuse review.");
  if (nowMs >= Date.parse(grant.expires_at)) return deny("Grant has expired.");
  if (!grant.capabilities.includes("commit_order")) return deny("Grant does not authorize order commits.");

  // Empty allowlist means none. Checked before the membership test so an empty
  // list can never fall through to a permissive branch.
  if (grant.symbol_allowlist.length === 0) return deny("Grant has no permitted symbols.");
  if (!grant.symbol_allowlist.includes(request.symbol)) return deny("Symbol is outside the grant allowlist.");

  if (grant.execution_environment !== request.execution_environment) {
    return deny("Order environment does not match the grant environment.");
  }
  if (!grant.allowed_sides.includes(request.side)) return deny("Side is not permitted by the grant.");
  if (!grant.allowed_order_types.includes(request.order_type)) return deny("Order type is not permitted by the grant.");

  const { limits } = grant;
  if (request.worst_case_notional_minor > limits.max_notional_per_order_minor) {
    return deny("Order exceeds the per-order notional limit.");
  }
  if (usage.notional_today_minor + request.worst_case_notional_minor > limits.max_notional_per_day_minor) {
    return deny("Order exceeds the remaining daily notional limit.");
  }
  if (request.resulting_position_notional_minor > limits.max_position_notional_per_symbol_minor) {
    return deny("Order exceeds the per-symbol position notional limit.");
  }
  if (usage.orders_today + 1 > limits.max_orders_per_day) return deny("Order exceeds the daily order count limit.");
  if (usage.open_orders + 1 > limits.max_open_orders) return deny("Order exceeds the open order limit.");

  return ALLOWED;
}
