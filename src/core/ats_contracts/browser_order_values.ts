// Shared value shapes for agent-browser-ats-order/1, used by browser_order.ts
// (calls) and browser_order_result.ts (results). Internal: the barrel does not
// re-export this module, so none of these helpers become public contract
// surface. The public interfaces defined here are re-exported by
// browser_order.ts.

import { ORDER_SIDES, ORDER_TYPES, type OrderSide, type OrderType } from "./grant.js";
import { choice, closed, digest, fail, ident, integer, nullable, opaqueRef, pinned, text, version } from "./primitives.js";

export const MAX_GENERATION = 2_147_483_647;
export const MAX_TICKET_QUANTITY = 1_000_000;
export const MAX_MINOR = 1_000_000_000_000;

export function positiveMinor(value: unknown, name: string): number {
  return integer(value, name, 1, MAX_MINOR);
}

export function signedMinor(value: unknown, name: string): number {
  return integer(value, name, -MAX_MINOR, MAX_MINOR);
}

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HTTPS_ORIGIN = new RegExp(`^https://(${HOST_LABEL}(?:\\.${HOST_LABEL})+)(?::([1-9][0-9]{0,4}))?$`);

/**
 * A bare, canonical https origin: lowercase host with a dotted name, no path,
 * query, fragment or credentials, and no explicit default port, so one site
 * has exactly one spelling and therefore one digest. IP literals are refused.
 */
export function siteOrigin(value: unknown, name: string): string {
  const match = typeof value === "string" && value.length <= 270 ? HTTPS_ORIGIN.exec(value) : null;
  const host = match?.[1] ?? "";
  const port = match?.[2] === undefined ? null : Number(match[2]);
  const topLabel = host.slice(host.lastIndexOf(".") + 1);
  if (!match || host.length > 253 || !/[a-z]/.test(topLabel) || (port !== null && (port > 65535 || port === 443))) {
    fail(`${name} must be a bare https origin.`);
  }
  return value as string;
}

/**
 * A masked label is drawn from a closed character set: ASCII letters and
 * digits, space, `. - _ ( ) # *`, the bullet and the ellipsis. Blacklisting
 * cannot hold this line: fullwidth or other-script digits slip past a
 * digit-run rule, and confusable letters or direction overrides can make an
 * approval card read as something it is not.
 */
const MASKED_LABEL_CHARACTERS = new RegExp(`^[A-Za-z0-9 ._()#*${String.fromCharCode(0x2022, 0x2026)}-]+$`, "u");

export function maskedAccountLabel(value: unknown, name: string): string {
  const label = text(value, name, 64);
  if (!MASKED_LABEL_CHARACTERS.test(label)) {
    fail(`${name} must use only letters, digits, spaces, masking bullets and . - _ ( ) # *.`);
  }
  if (/[0-9]{5,}/.test(label)) fail(`${name} must not embed a full account number.`);
  return label;
}

/**
 * An equity ticker such as SPY, BRK.B or BRK-B. Deliberately narrower than the
 * shared ticker shape, whose `/` and `:` let an all-caps string spell a URL.
 */
const EQUITY_SYMBOL = /^[A-Z]{1,6}(?:[.-][A-Z]{1,4})?$/;

export function equitySymbol(value: unknown, name: string): string {
  if (typeof value !== "string" || !EQUITY_SYMBOL.test(value)) fail(`${name} must be an equity ticker such as SPY or BRK.B.`);
  return value;
}

/** Who the call is for. The generation rotates on browser restart, profile change or account switch. */
export interface BrowserPrincipal {
  readonly user_ref: string;
  readonly agent_id: string;
  readonly browser_session_id: string;
  readonly session_generation: number;
}

const PRINCIPAL_FIELDS = ["user_ref", "agent_id", "browser_session_id", "session_generation"] as const;

export function validatePrincipal(value: unknown, name: string): BrowserPrincipal {
  const raw = closed(value, name, PRINCIPAL_FIELDS);
  return Object.freeze({
    user_ref: opaqueRef(raw.user_ref, `${name} user`),
    agent_id: ident(raw.agent_id, `${name} agent`),
    browser_session_id: ident(raw.browser_session_id, `${name} browser session`),
    session_generation: integer(raw.session_generation, `${name} session generation`, 1, MAX_GENERATION),
  });
}

/** The reviewed site adapter. Its recipe is code; a changed digest is a different adapter. */
export interface BrowserAdapterPin {
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly adapter_digest: string;
}

const ADAPTER_FIELDS = ["adapter_id", "adapter_version", "adapter_digest"] as const;

export function validateAdapterPin(value: unknown, name: string): BrowserAdapterPin {
  const raw = closed(value, name, ADAPTER_FIELDS);
  return Object.freeze({
    adapter_id: ident(raw.adapter_id, `${name} id`),
    adapter_version: version(raw.adapter_version, `${name} version`),
    adapter_digest: digest(raw.adapter_digest, `${name} digest`),
  });
}

/** An equity ticket. Day orders only in /1: anything else the site shows is a mismatch. */
export interface BrowserTicket {
  readonly symbol: string;
  readonly side: OrderSide;
  readonly quantity: number;
  readonly order_type: OrderType;
  readonly limit_price_minor: number | null;
  readonly time_in_force: "day";
}

export const TICKET_FIELDS = ["symbol", "side", "quantity", "order_type", "limit_price_minor", "time_in_force"] as const;
export type TicketField = (typeof TICKET_FIELDS)[number];

export function priceAgreesWithType(orderType: OrderType, price: number | null, name: string): void {
  if (orderType === "limit" && price === null) fail(`${name}: a limit order requires a positive minor-unit price.`);
  if (orderType === "market" && price !== null) fail(`${name}: a market order cannot carry a limit price.`);
}

export function ticketShape(raw: Readonly<Record<TicketField, unknown>>, name: string): BrowserTicket {
  const orderType = choice(raw.order_type, ORDER_TYPES, `${name} order type`);
  const price = nullable(raw.limit_price_minor, `${name} limit price`, positiveMinor);
  priceAgreesWithType(orderType, price, name);
  return {
    symbol: equitySymbol(raw.symbol, `${name} symbol`),
    side: choice(raw.side, ORDER_SIDES, `${name} side`),
    quantity: integer(raw.quantity, `${name} quantity`, 1, MAX_TICKET_QUANTITY),
    order_type: orderType,
    limit_price_minor: price,
    time_in_force: pinned(raw.time_in_force, "day", `${name} time in force`),
  };
}

export function validateTicket(value: unknown, name: string): BrowserTicket {
  return Object.freeze(ticketShape(closed(value, name, TICKET_FIELDS), name));
}
