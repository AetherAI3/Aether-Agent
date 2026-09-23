// Model-facing proposal only. ATSv2 assigns request, client, target, grant,
// environment and operator from authenticated state after this boundary.
// Parsing a proposal NEVER authorizes review or execution.

import {
  choice, closed, digest, ident, integer, minorUnits, nullable,
  schemaTag, symbol as tickerSymbol, timestamp,
} from "./primitives.js";
import { ORDER_SIDES, ORDER_TYPES, type OrderSide, type OrderType } from "./grant.js";

export const MODEL_ORDER_PROPOSAL_SCHEMA = "aether.ats.model-order-proposal/1" as const;

export interface ModelEquityOrderProposalV1 {
  readonly schema_version: typeof MODEL_ORDER_PROPOSAL_SCHEMA;
  readonly activation_id: string;
  readonly artifact_id: string;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly quantity: number;
  readonly order_type: OrderType;
  readonly limit_price_minor: number | null;
  readonly market_snapshot_ref: string;
  readonly broker_quote_ref: string;
  readonly evidence_digest: string;
  readonly expires_at: string;
}

const FIELDS = [
  "schema_version", "activation_id", "artifact_id", "symbol", "side",
  "quantity", "order_type", "limit_price_minor", "market_snapshot_ref",
  "broker_quote_ref", "evidence_digest", "expires_at",
] as const;

export function validateModelOrderProposal(value: unknown): ModelEquityOrderProposalV1 {
  const raw = closed(value, "Model order proposal", FIELDS);
  const orderType = choice(raw.order_type, ORDER_TYPES, "Proposal order type");
  const price = nullable(raw.limit_price_minor, "Proposal limit price", minorUnits);
  if (orderType === "limit" && (price === null || price <= 0)) {
    throw new Error("A limit proposal requires a positive minor-unit price.");
  }
  if (orderType === "market" && price !== null) {
    throw new Error("A market proposal cannot carry a limit price.");
  }
  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, MODEL_ORDER_PROPOSAL_SCHEMA, "Model order proposal") as typeof MODEL_ORDER_PROPOSAL_SCHEMA,
    activation_id: ident(raw.activation_id, "Proposal activation"),
    artifact_id: ident(raw.artifact_id, "Proposal artifact"),
    symbol: tickerSymbol(raw.symbol, "Proposal symbol"),
    side: choice(raw.side, ORDER_SIDES, "Proposal side"),
    quantity: integer(raw.quantity, "Proposal quantity", 1, 1_000_000),
    order_type: orderType,
    limit_price_minor: price,
    market_snapshot_ref: ident(raw.market_snapshot_ref, "Proposal market snapshot"),
    broker_quote_ref: ident(raw.broker_quote_ref, "Proposal broker quote"),
    evidence_digest: digest(raw.evidence_digest, "Proposal evidence digest"),
    expires_at: timestamp(raw.expires_at, "Proposal expiry"),
  });
}
