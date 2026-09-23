// agent-browser-ats-order/1, result half: what the site adapter may report.
// Closed documents whose only site-derived strings are a bare https origin
// and a masked label from a closed character set. No I/O, no credential.

import { digestEquals, digestOf } from "./canonical.js";
import { ORDER_SIDES, ORDER_TYPES, type OrderSide, type OrderType } from "./grant.js";
import { choice, closed, digest, fail, ident, integer, list, minorUnits, nullable, pinned, schemaTag, timestamp } from "./primitives.js";
import {
  BROWSER_OPERATION_EFFECTS, BROWSER_ORDER_OPERATIONS, BROWSER_ORDER_RESULT_SCHEMA, BROWSER_REFUSAL_CODES,
  BROWSER_RESULT_STATUSES, SITE_MODES,
  type BrowserOrderOperation, type BrowserRefusalCode, type BrowserResultStatus, type SiteMode,
} from "./browser_order.js";
import {
  MAX_TICKET_QUANTITY, TICKET_FIELDS, equitySymbol, maskedAccountLabel, positiveMinor, priceAgreesWithType,
  signedMinor, siteOrigin, ticketShape, validateAdapterPin, validatePrincipal,
  type BrowserAdapterPin, type BrowserPrincipal, type BrowserTicket,
} from "./browser_order_values.js";

const MAX_POSITION_QUANTITY = 1_000_000_000;
const MAX_POSITIONS = 500;

const SESSION_STATES = ["user_authenticating", "observe_only", "verified"] as const;
const PRIMARY_INDICATORS = ["paper", "live", "absent"] as const;
const SECONDARY_INDICATORS = ["paper", "live", "absent", "not_supported"] as const;
const TRADING_PERMISSIONS = ["equity_orders", "none"] as const;
const CONTROL_HOLDERS = ["user", "ats", "none"] as const;
const RELEASED_HOLDERS = ["user", "none"] as const;
const QUOTE_CLASSES = ["account_executable", "display_only"] as const;
const SUBMIT_CONTROLS = ["enabled", "disabled"] as const;
const SUBMISSIONS = ["confirmed", "site_rejected"] as const;
const ORDER_LOOKUPS = ["found", "not_found", "indeterminate"] as const;
const ORDER_EVIDENCE_SOURCES = ["order_history", "order_detail"] as const;
const SITE_ORDER_STATUSES = ["working", "partially_filled", "filled", "cancelled", "rejected", "expired"] as const;
const CANCEL_STATES = ["cancel_confirmed", "already_final"] as const;

export interface ModeEvidence {
  readonly primary: (typeof PRIMARY_INDICATORS)[number];
  readonly secondary: (typeof SECONDARY_INDICATORS)[number];
}

export interface VerifySessionData {
  readonly session_state: (typeof SESSION_STATES)[number];
  readonly site_origin: string | null;
  readonly account_fingerprint: string | null;
  readonly masked_account_label: string | null;
  readonly mode_evidence: ModeEvidence | null;
  readonly trading_permission: (typeof TRADING_PERMISSIONS)[number] | null;
  readonly control_holder: (typeof CONTROL_HOLDERS)[number];
}

export interface MarketData {
  readonly symbol: string;
  readonly currency: "USD";
  readonly bid_minor: number | null;
  readonly ask_minor: number | null;
  readonly last_minor: number | null;
  readonly quote_time: string | null;
  readonly quote_class: (typeof QUOTE_CLASSES)[number];
}

export interface AccountData {
  readonly account_fingerprint: string;
  readonly site_mode: SiteMode;
  readonly currency: "USD";
  readonly cash_minor: number | null;
  readonly buying_power_minor: number | null;
}

export interface RenderedTicket extends BrowserTicket {
  readonly account_fingerprint: string;
  readonly site_mode: SiteMode;
}

export interface TicketData {
  readonly rendered_ticket: RenderedTicket;
  readonly rendered_ticket_digest: string;
  readonly estimated_cost_minor: number | null;
  readonly submit_control: (typeof SUBMIT_CONTROLS)[number];
}

/** A site's immediate answer to a submit. It is not a fill and cannot hold one. */
export interface CommitData {
  readonly submission: (typeof SUBMISSIONS)[number];
  readonly site_order_id: string | null;
  readonly rendered_ticket_digest: string;
}

export interface SiteOrder {
  readonly site_order_id: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly quantity: number;
  readonly order_type: OrderType;
  readonly limit_price_minor: number | null;
  readonly status: (typeof SITE_ORDER_STATUSES)[number];
  readonly filled_quantity: number;
  readonly average_fill_price_minor: number | null;
  readonly updated_at: string | null;
}

/** Order evidence names the account whose history it was read from. */
export interface OrderData {
  readonly account_fingerprint: string;
  readonly site_mode: SiteMode;
  readonly lookup: (typeof ORDER_LOOKUPS)[number];
  readonly order: SiteOrder | null;
  readonly evidence_source: (typeof ORDER_EVIDENCE_SOURCES)[number];
}

export interface SitePosition {
  readonly symbol: string;
  readonly quantity: number;
  readonly average_cost_minor: number | null;
}

/**
 * Equity positions from the positions view. Holdings the contract cannot
 * represent (options, other currencies, other instrument shapes) are counted,
 * never silently dropped, so ATSv2 knows its view of exposure is partial.
 */
export interface PositionsData {
  readonly account_fingerprint: string;
  readonly site_mode: SiteMode;
  readonly positions: readonly SitePosition[];
  readonly unrepresented_positions: number;
  readonly evidence_source: "positions_view";
}

export interface CancelData {
  readonly account_fingerprint: string;
  readonly site_mode: SiteMode;
  readonly cancel_state: (typeof CANCEL_STATES)[number];
  readonly site_order_id: string;
}

export interface EndControlData {
  readonly control_holder: (typeof RELEASED_HOLDERS)[number];
}

export interface BrowserOrderDataByOperation {
  readonly verify_session: VerifySessionData;
  readonly read_market: MarketData;
  readonly read_account: AccountData;
  readonly prepare_ticket: TicketData;
  readonly verify_ticket: TicketData;
  readonly commit_once: CommitData;
  readonly read_order: OrderData;
  readonly read_positions: PositionsData;
  readonly cancel_order: CancelData;
  readonly end_control: EndControlData;
}

const SESSION_ACCOUNT_FIELDS = ["site_origin", "account_fingerprint", "masked_account_label", "mode_evidence", "trading_permission"] as const;

function validateModeEvidence(value: unknown, name: string): ModeEvidence {
  const raw = closed(value, name, ["primary", "secondary"] as const);
  return Object.freeze({
    primary: choice(raw.primary, PRIMARY_INDICATORS, `${name} primary`),
    secondary: choice(raw.secondary, SECONDARY_INDICATORS, `${name} secondary`),
  });
}

function validateVerifySessionData(value: unknown, name: string): VerifySessionData {
  const raw = closed(value, name, ["session_state", ...SESSION_ACCOUNT_FIELDS, "control_holder"] as const);
  const state = choice(raw.session_state, SESSION_STATES, `${name} session state`);
  const control = choice(raw.control_holder, CONTROL_HOLDERS, `${name} control holder`);
  const account = {
    site_origin: nullable(raw.site_origin, `${name} site origin`, siteOrigin),
    account_fingerprint: nullable(raw.account_fingerprint, `${name} account fingerprint`, digest),
    masked_account_label: nullable(raw.masked_account_label, `${name} masked account label`, maskedAccountLabel),
    mode_evidence: nullable(raw.mode_evidence, `${name} mode evidence`, validateModeEvidence),
    trading_permission: nullable(raw.trading_permission, `${name} trading permission`, (v, n) => choice(v, TRADING_PERMISSIONS, n)),
  };
  const present = Object.values(account).filter((entry) => entry !== null).length;
  if (state === "verified" && present !== SESSION_ACCOUNT_FIELDS.length) {
    fail(`${name}: a verified session must name its origin, account, mode evidence and trading permission.`);
  }
  if (state !== "verified" && present !== 0) fail(`${name}: an unverified session must not carry account data.`);
  if (state === "user_authenticating" && control !== "user") fail(`${name}: authentication leaves control with the user.`);
  return Object.freeze({ session_state: state, ...account, control_holder: control });
}

function validateMarketData(value: unknown, name: string): MarketData {
  const raw = closed(value, name, ["symbol", "currency", "bid_minor", "ask_minor", "last_minor", "quote_time", "quote_class"] as const);
  const bid = nullable(raw.bid_minor, `${name} bid`, positiveMinor);
  const ask = nullable(raw.ask_minor, `${name} ask`, positiveMinor);
  const last = nullable(raw.last_minor, `${name} last`, positiveMinor);
  if (bid === null && ask === null && last === null) fail(`${name} carries no price.`);
  if (bid !== null && ask !== null && bid > ask) fail(`${name} is a crossed quote.`);
  return Object.freeze({
    symbol: equitySymbol(raw.symbol, `${name} symbol`),
    currency: pinned(raw.currency, "USD", `${name} currency`),
    bid_minor: bid,
    ask_minor: ask,
    last_minor: last,
    quote_time: nullable(raw.quote_time, `${name} quote time`, timestamp),
    quote_class: choice(raw.quote_class, QUOTE_CLASSES, `${name} quote class`),
  });
}

function validateAccountData(value: unknown, name: string): AccountData {
  const raw = closed(value, name, ["account_fingerprint", "site_mode", "currency", "cash_minor", "buying_power_minor"] as const);
  return Object.freeze({
    account_fingerprint: digest(raw.account_fingerprint, `${name} account fingerprint`),
    site_mode: choice(raw.site_mode, SITE_MODES, `${name} site mode`),
    currency: pinned(raw.currency, "USD", `${name} currency`),
    cash_minor: nullable(raw.cash_minor, `${name} cash`, signedMinor),
    buying_power_minor: nullable(raw.buying_power_minor, `${name} buying power`, minorUnits),
  });
}

function validateRenderedTicket(value: unknown, name: string): RenderedTicket {
  const raw = closed(value, name, ["account_fingerprint", "site_mode", ...TICKET_FIELDS] as const);
  return Object.freeze({
    account_fingerprint: digest(raw.account_fingerprint, `${name} account fingerprint`),
    site_mode: choice(raw.site_mode, SITE_MODES, `${name} site mode`),
    ...ticketShape(raw, name),
  });
}

function validateTicketData(value: unknown, name: string): TicketData {
  const raw = closed(value, name, ["rendered_ticket", "rendered_ticket_digest", "estimated_cost_minor", "submit_control"] as const);
  const rendered = validateRenderedTicket(raw.rendered_ticket, `${name} rendered ticket`);
  const claimed = digest(raw.rendered_ticket_digest, `${name} rendered ticket digest`);
  if (!digestEquals(claimed, digestOf(rendered))) fail(`${name} rendered ticket digest does not match the rendered ticket.`);
  return Object.freeze({
    rendered_ticket: rendered,
    rendered_ticket_digest: claimed,
    estimated_cost_minor: nullable(raw.estimated_cost_minor, `${name} estimated cost`, minorUnits),
    submit_control: choice(raw.submit_control, SUBMIT_CONTROLS, `${name} submit control`),
  });
}

function validateCommitData(value: unknown, name: string): CommitData {
  const raw = closed(value, name, ["submission", "site_order_id", "rendered_ticket_digest"] as const);
  const submission = choice(raw.submission, SUBMISSIONS, `${name} submission`);
  const orderId = nullable(raw.site_order_id, `${name} site order id`, ident);
  if (submission === "confirmed" && orderId === null) fail(`${name}: a confirmed submission must name its site order id.`);
  return Object.freeze({
    submission,
    site_order_id: orderId,
    rendered_ticket_digest: digest(raw.rendered_ticket_digest, `${name} rendered ticket digest`),
  });
}

type FillState = Pick<SiteOrder, "status" | "quantity" | "filled_quantity" | "average_fill_price_minor">;

function checkFillState(fills: FillState, name: string): void {
  const { status, quantity, filled_quantity: filled, average_fill_price_minor: average } = fills;
  if ((filled > 0) !== (average !== null)) fail(`${name}: an average fill price exists exactly when shares filled.`);
  const consistent =
    status === "filled" ? filled === quantity
      : status === "partially_filled" ? filled > 0 && filled < quantity
        : status === "working" || status === "rejected" ? filled === 0
          : filled < quantity; // cancelled or expired, possibly after a partial fill
  if (!consistent) fail(`${name}: status ${status} disagrees with its filled quantity.`);
}

function validateSiteOrder(value: unknown, name: string): SiteOrder {
  const raw = closed(value, name, [
    "site_order_id", "symbol", "side", "quantity", "order_type", "limit_price_minor",
    "status", "filled_quantity", "average_fill_price_minor", "updated_at",
  ] as const);
  const orderType = choice(raw.order_type, ORDER_TYPES, `${name} order type`);
  const price = nullable(raw.limit_price_minor, `${name} limit price`, positiveMinor);
  priceAgreesWithType(orderType, price, name);
  const quantity = integer(raw.quantity, `${name} quantity`, 1, MAX_TICKET_QUANTITY);
  const fills: FillState = {
    status: choice(raw.status, SITE_ORDER_STATUSES, `${name} status`),
    quantity,
    filled_quantity: integer(raw.filled_quantity, `${name} filled quantity`, 0, quantity),
    average_fill_price_minor: nullable(raw.average_fill_price_minor, `${name} average fill price`, positiveMinor),
  };
  checkFillState(fills, name);
  return Object.freeze({
    site_order_id: ident(raw.site_order_id, `${name} site order id`),
    symbol: equitySymbol(raw.symbol, `${name} symbol`),
    side: choice(raw.side, ORDER_SIDES, `${name} side`),
    order_type: orderType,
    limit_price_minor: price,
    ...fills,
    updated_at: nullable(raw.updated_at, `${name} updated_at`, timestamp),
  });
}

function validateOrderData(value: unknown, name: string): OrderData {
  const raw = closed(value, name, ["account_fingerprint", "site_mode", "lookup", "order", "evidence_source"] as const);
  const lookup = choice(raw.lookup, ORDER_LOOKUPS, `${name} lookup`);
  const order = nullable(raw.order, `${name} order`, validateSiteOrder);
  if ((lookup === "found") !== (order !== null)) fail(`${name}: an order is present exactly when the lookup found one.`);
  return Object.freeze({
    account_fingerprint: digest(raw.account_fingerprint, `${name} account fingerprint`),
    site_mode: choice(raw.site_mode, SITE_MODES, `${name} site mode`),
    lookup,
    order,
    evidence_source: choice(raw.evidence_source, ORDER_EVIDENCE_SOURCES, `${name} evidence source`),
  });
}

function validatePosition(value: unknown, name: string): SitePosition {
  const raw = closed(value, name, ["symbol", "quantity", "average_cost_minor"] as const);
  const quantity = integer(raw.quantity, `${name} quantity`, -MAX_POSITION_QUANTITY, MAX_POSITION_QUANTITY);
  if (quantity === 0) fail(`${name} quantity must not be zero; a flat position is absent.`);
  return Object.freeze({
    symbol: equitySymbol(raw.symbol, `${name} symbol`),
    quantity,
    average_cost_minor: nullable(raw.average_cost_minor, `${name} average cost`, positiveMinor),
  });
}

function validatePositionsData(value: unknown, name: string): PositionsData {
  const raw = closed(value, name, ["account_fingerprint", "site_mode", "positions", "unrepresented_positions", "evidence_source"] as const);
  const positions = Object.freeze(list(raw.positions, `${name} positions`, MAX_POSITIONS, validatePosition));
  if (new Set(positions.map((entry) => entry.symbol)).size !== positions.length) fail(`${name} positions must not repeat an entry.`);
  return Object.freeze({
    account_fingerprint: digest(raw.account_fingerprint, `${name} account fingerprint`),
    site_mode: choice(raw.site_mode, SITE_MODES, `${name} site mode`),
    positions,
    unrepresented_positions: integer(raw.unrepresented_positions, `${name} unrepresented positions`, 0, MAX_POSITIONS),
    evidence_source: pinned(raw.evidence_source, "positions_view", `${name} evidence source`),
  });
}

function validateCancelData(value: unknown, name: string): CancelData {
  const raw = closed(value, name, ["account_fingerprint", "site_mode", "cancel_state", "site_order_id"] as const);
  return Object.freeze({
    account_fingerprint: digest(raw.account_fingerprint, `${name} account fingerprint`),
    site_mode: choice(raw.site_mode, SITE_MODES, `${name} site mode`),
    cancel_state: choice(raw.cancel_state, CANCEL_STATES, `${name} cancel state`),
    site_order_id: ident(raw.site_order_id, `${name} site order id`),
  });
}

function validateEndControlData(value: unknown, name: string): EndControlData {
  const raw = closed(value, name, ["control_holder"] as const);
  return Object.freeze({ control_holder: choice(raw.control_holder, RELEASED_HOLDERS, `${name} control holder`) });
}

type DataValidators = { readonly [O in BrowserOrderOperation]: (value: unknown, name: string) => BrowserOrderDataByOperation[O] };

const DATA_VALIDATORS: DataValidators = {
  verify_session: validateVerifySessionData,
  read_market: validateMarketData,
  read_account: validateAccountData,
  prepare_ticket: validateTicketData,
  verify_ticket: validateTicketData,
  commit_once: validateCommitData,
  read_order: validateOrderData,
  read_positions: validatePositionsData,
  cancel_order: validateCancelData,
  end_control: validateEndControlData,
};

// --- Result envelope -----------------------------------------------------------

interface ResultEnvelope {
  readonly schema_version: typeof BROWSER_ORDER_RESULT_SCHEMA;
  readonly call_id: string;
  readonly request_id: string;
  readonly principal: BrowserPrincipal;
  readonly adapter: BrowserAdapterPin;
  readonly observed_at: string;
  readonly status: BrowserResultStatus;
  readonly refusal: BrowserRefusalCode | null;
}

export type BrowserOrderResultV1 = {
  readonly [O in BrowserOrderOperation]: ResultEnvelope & { readonly operation: O; readonly data: BrowserOrderDataByOperation[O] | null };
}[BrowserOrderOperation];

const RESULT_FIELDS = [
  "schema_version", "call_id", "request_id", "operation", "principal", "adapter",
  "observed_at", "status", "refusal", "data",
] as const;

function statusData(operation: BrowserOrderOperation, status: BrowserResultStatus, refusal: BrowserRefusalCode | null, data: unknown): unknown {
  if (status === "ok") {
    if (refusal !== null) fail("An ok browser result cannot carry a refusal.");
    return DATA_VALIDATORS[operation](data, `Browser order ${operation} data`);
  }
  if (data !== null) fail(`Browser result status ${status} cannot carry data.`);
  if (status === "refused") {
    if (refusal === null) fail("A refused browser result must name its refusal.");
    if (refusal === "duplicate_commit" && operation !== "commit_once") fail("Only commit_once can be refused as a duplicate commit.");
    return null;
  }
  if (BROWSER_OPERATION_EFFECTS[operation] !== "mutate") fail(`Only an order mutation can be ambiguous; ${operation} cannot.`);
  if (refusal !== null) fail("An ambiguous browser result cannot carry a refusal.");
  return null;
}

export function validateBrowserOrderResult(value: unknown): BrowserOrderResultV1 {
  const raw = closed(value, "Browser order result", RESULT_FIELDS);
  schemaTag(raw.schema_version, BROWSER_ORDER_RESULT_SCHEMA, "Browser order result");
  const operation = choice(raw.operation, BROWSER_ORDER_OPERATIONS, "Browser order result operation");
  const status = choice(raw.status, BROWSER_RESULT_STATUSES, "Browser order result status");
  const refusal = nullable(raw.refusal, "Browser order refusal", (v, n) => choice(v, BROWSER_REFUSAL_CODES, n));
  const data = statusData(operation, status, refusal, raw.data);
  return Object.freeze({
    schema_version: BROWSER_ORDER_RESULT_SCHEMA,
    call_id: ident(raw.call_id, "Browser order result call id"),
    request_id: ident(raw.request_id, "Browser order result request id"),
    operation,
    principal: validatePrincipal(raw.principal, "Browser order result principal"),
    adapter: validateAdapterPin(raw.adapter, "Browser order result adapter"),
    observed_at: timestamp(raw.observed_at, "Browser order observed_at"),
    status,
    refusal,
    data,
  }) as BrowserOrderResultV1;
}
