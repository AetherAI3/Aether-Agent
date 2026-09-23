// agent-browser-ats-order/1 — the typed wire between ATSv2's browser order
// port and the qualified site adapter that runs beside the user's signed-in
// Agent Browser session.
//
// Only two parties speak it: the deterministic ATSv2 controller (caller) and
// reviewed adapter code on the browser host (callee). A model never does. It
// receives sanitized evidence and may emit the separate, closed
// aether.ats.model-order-proposal/1; nothing it produces can name an
// operation, a binding or an adapter here.
//
// What these shapes make unrepresentable, rather than merely forbid:
//
//   * A caller-supplied selector, coordinate, URL, script or free-text action.
//     Every document is closed and every string a caller sends is a bounded
//     identifier, digest, equity ticker, timestamp or enum member. Which
//     element to press is the adapter's reviewed recipe, pinned by
//     adapter_digest, never data on this wire.
//   * ATS simulated paper reaching a browser. A binding's environment is
//     provider_sandbox or provider_live and must agree with the site mode the
//     adapter verified, so a paper page cannot satisfy a live binding and a
//     live page cannot satisfy a paper one.
//   * Page text, pixels, cookies or account numbers in a result. Results hold
//     enums, integers, digests, a bare https origin and a masked label drawn
//     from a closed character set.
//   * A fill claimed from a confirmation screen. A commit result cannot carry
//     fill facts; only read_order from a qualified history surface can.
//   * A second click after an unknown outcome. `ambiguous` is a first-class
//     status of the two order mutations and always requires reconciliation.
//
// Parsing a call never authorizes it: grant, preview, approval, live arm and
// halt state stay in ATSv2. Like the rest of this directory, this module
// performs no I/O and holds no credential.
//
// The family: this module holds the vocabulary and the call;
// browser_order_result.ts the result; browser_order_gate.ts the decisions
// ATSv2 makes from both; browser_order_values.ts the shared value shapes.

import type { ExecutionEnvironment } from "./mode.js";
import { choice, closed, digest, fail, ident, integer, nullable, schemaTag, timestamp } from "./primitives.js";
import {
  MAX_GENERATION, equitySymbol, validateAdapterPin, validatePrincipal, validateTicket,
  type BrowserAdapterPin, type BrowserPrincipal, type BrowserTicket,
} from "./browser_order_values.js";

export type { BrowserAdapterPin, BrowserPrincipal, BrowserTicket } from "./browser_order_values.js";

export const AGENT_BROWSER_ATS_ORDER_PROTOCOL = "agent-browser-ats-order/1" as const;
export const BROWSER_ORDER_CALL_SCHEMA = "aether.ats.browser-order-call/1" as const;
export const BROWSER_ORDER_RESULT_SCHEMA = "aether.ats.browser-order-result/1" as const;
export const BROWSER_ORDER_SCHEMAS = [BROWSER_ORDER_CALL_SCHEMA, BROWSER_ORDER_RESULT_SCHEMA] as const;

export const BROWSER_ORDER_OPERATIONS = [
  "verify_session", "read_market", "read_account", "prepare_ticket", "verify_ticket",
  "commit_once", "read_order", "read_positions", "cancel_order", "end_control",
] as const;
export type BrowserOrderOperation = (typeof BROWSER_ORDER_OPERATIONS)[number];

/**
 * What an operation may do to the trading site. `prepare` fills the order
 * ticket without submitting it. Only the two `mutate` operations can create or
 * cancel an order, and only they can end `ambiguous`.
 */
export type BrowserOperationEffect = "observe" | "prepare" | "mutate" | "release";
export const BROWSER_OPERATION_EFFECTS: Readonly<Record<BrowserOrderOperation, BrowserOperationEffect>> = Object.freeze({
  verify_session: "observe",
  read_market: "observe",
  read_account: "observe",
  prepare_ticket: "prepare",
  verify_ticket: "observe",
  commit_once: "mutate",
  read_order: "observe",
  read_positions: "observe",
  cancel_order: "mutate",
  end_control: "release",
});

export const SITE_MODES = ["paper", "live"] as const;
export type SiteMode = (typeof SITE_MODES)[number];

/** `ats_paper` is absent on purpose: the ATS simulator never reaches a browser. */
export const BROWSER_EXECUTION_ENVIRONMENTS = ["provider_sandbox", "provider_live"] as const satisfies readonly ExecutionEnvironment[];
export type BrowserExecutionEnvironment = (typeof BROWSER_EXECUTION_ENVIRONMENTS)[number];

/** A site's paper account is the provider's sandbox; its live account is live capital. */
export function environmentForSiteMode(mode: SiteMode): BrowserExecutionEnvironment {
  return mode === "paper" ? "provider_sandbox" : "provider_live";
}

/**
 * Why an adapter declined. For `commit_once` and `cancel_order` a refusal is a
 * promise that no submit or cancel control was dispatched; anything the
 * adapter cannot promise that about is `ambiguous`, never a refusal.
 */
export const BROWSER_REFUSAL_CODES = [
  "observe_only",
  "user_authenticating",
  "user_control",
  "session_generation_mismatch",
  "binding_mismatch",
  "adapter_mismatch",
  "deadline_exceeded",
  "ticket_mismatch",
  "ui_drift",
  "navigation_drift",
  "duplicate_commit",
  "unsupported",
  "halted",
] as const;
export type BrowserRefusalCode = (typeof BROWSER_REFUSAL_CODES)[number];

export const BROWSER_RESULT_STATUSES = ["ok", "refused", "ambiguous"] as const;
export type BrowserResultStatus = (typeof BROWSER_RESULT_STATUSES)[number];

export const END_CONTROL_REASONS = ["complete", "user_takeover", "halt", "deadline", "session_change", "error"] as const;
export type EndControlReason = (typeof END_CONTROL_REASONS)[number];

/** Derived by ATSv2 from a verify_session result; never reported by the browser. */
export const BROWSER_BINDING_STATES = ["user_authenticating", "observe_only", "paper_ready", "live_locked"] as const;
export type BrowserBindingState = (typeof BROWSER_BINDING_STATES)[number];

/** A late click is worse than none, so the two order mutations get the tighter window. */
export const MAX_CALL_WINDOW_MS = 120_000;
export const MAX_MUTATION_WINDOW_MS = 30_000;

/**
 * How far a result may appear to predate its call because the ATSv2 and
 * browser hosts' clocks disagree. Anything earlier is a replayed or cached
 * answer, not an observation made for this call.
 */
export const MAX_CLOCK_SKEW_MS = 5_000;

/** An ATS-minted binding of one verified site account in one mode. */
export interface BrowserBindingRef {
  readonly binding_id: string;
  readonly binding_generation: number;
  readonly account_fingerprint: string;
  readonly site_mode: SiteMode;
  readonly execution_environment: BrowserExecutionEnvironment;
}

const BINDING_FIELDS = ["binding_id", "binding_generation", "account_fingerprint", "site_mode", "execution_environment"] as const;

function validateBinding(value: unknown, name: string): BrowserBindingRef {
  const raw = closed(value, name, BINDING_FIELDS);
  const siteMode = choice(raw.site_mode, SITE_MODES, `${name} site mode`);
  const environment = choice(raw.execution_environment, BROWSER_EXECUTION_ENVIRONMENTS, `${name} execution environment`);
  if (environment !== environmentForSiteMode(siteMode)) fail(`${name} execution environment does not match its site mode.`);
  return Object.freeze({
    binding_id: ident(raw.binding_id, `${name} id`),
    binding_generation: integer(raw.binding_generation, `${name} generation`, 1, MAX_GENERATION),
    account_fingerprint: digest(raw.account_fingerprint, `${name} account fingerprint`),
    site_mode: siteMode,
    execution_environment: environment,
  });
}

export interface BrowserOrderParamsByOperation {
  readonly verify_session: Readonly<Record<string, never>>;
  readonly read_market: { readonly symbol: string };
  readonly read_account: Readonly<Record<string, never>>;
  readonly prepare_ticket: { readonly ticket: BrowserTicket; readonly preview_digest: string };
  readonly verify_ticket: { readonly ticket: BrowserTicket; readonly preview_digest: string };
  readonly commit_once: { readonly preview_digest: string; readonly rendered_ticket_digest: string; readonly approval_id: string };
  readonly read_order: { readonly site_order_id: string | null };
  readonly read_positions: { readonly symbol: string | null };
  readonly cancel_order: { readonly site_order_id: string };
  readonly end_control: { readonly reason: EndControlReason };
}

type ParamValidators = { readonly [O in BrowserOrderOperation]: (value: unknown, name: string) => BrowserOrderParamsByOperation[O] };

function ticketParams(value: unknown, name: string): { readonly ticket: BrowserTicket; readonly preview_digest: string } {
  const raw = closed(value, name, ["ticket", "preview_digest"] as const);
  return Object.freeze({
    ticket: validateTicket(raw.ticket, `${name} ticket`),
    preview_digest: digest(raw.preview_digest, `${name} preview digest`),
  });
}

function noParams(value: unknown, name: string): Readonly<Record<string, never>> {
  closed(value, name, [] as const);
  return Object.freeze({});
}

const PARAM_VALIDATORS: ParamValidators = {
  verify_session: noParams,
  read_market: (value, name) => {
    const raw = closed(value, name, ["symbol"] as const);
    return Object.freeze({ symbol: equitySymbol(raw.symbol, `${name} symbol`) });
  },
  read_account: noParams,
  prepare_ticket: ticketParams,
  verify_ticket: ticketParams,
  commit_once: (value, name) => {
    const raw = closed(value, name, ["preview_digest", "rendered_ticket_digest", "approval_id"] as const);
    return Object.freeze({
      preview_digest: digest(raw.preview_digest, `${name} preview digest`),
      rendered_ticket_digest: digest(raw.rendered_ticket_digest, `${name} rendered ticket digest`),
      approval_id: ident(raw.approval_id, `${name} approval id`),
    });
  },
  read_order: (value, name) => {
    const raw = closed(value, name, ["site_order_id"] as const);
    return Object.freeze({ site_order_id: nullable(raw.site_order_id, `${name} site order id`, ident) });
  },
  read_positions: (value, name) => {
    const raw = closed(value, name, ["symbol"] as const);
    return Object.freeze({ symbol: nullable(raw.symbol, `${name} symbol`, equitySymbol) });
  },
  cancel_order: (value, name) => {
    const raw = closed(value, name, ["site_order_id"] as const);
    return Object.freeze({ site_order_id: ident(raw.site_order_id, `${name} site order id`) });
  },
  end_control: (value, name) => {
    const raw = closed(value, name, ["reason"] as const);
    return Object.freeze({ reason: choice(raw.reason, END_CONTROL_REASONS, `${name} reason`) });
  },
};

interface CallEnvelope {
  readonly schema_version: typeof BROWSER_ORDER_CALL_SCHEMA;
  readonly call_id: string;
  readonly request_id: string;
  readonly principal: BrowserPrincipal;
  readonly adapter: BrowserAdapterPin;
  readonly binding: BrowserBindingRef | null;
  readonly issued_at: string;
  readonly deadline: string;
}

export type BrowserOrderCallV1 = {
  readonly [O in BrowserOrderOperation]: CallEnvelope & { readonly operation: O; readonly params: BrowserOrderParamsByOperation[O] };
}[BrowserOrderOperation];

const CALL_FIELDS = [
  "schema_version", "call_id", "request_id", "operation", "principal", "adapter",
  "binding", "issued_at", "deadline", "params",
] as const;

/** Discovery and release are the only operations that may run without a binding. */
const BINDING_OPTIONAL: ReadonlySet<BrowserOrderOperation> = new Set(["verify_session", "end_control"]);

function checkDeadline(operation: BrowserOrderOperation, issuedAt: string, deadline: string): void {
  const window = Date.parse(deadline) - Date.parse(issuedAt);
  if (window <= 0) fail("Browser order deadline must follow issued_at.");
  const limit = BROWSER_OPERATION_EFFECTS[operation] === "mutate" ? MAX_MUTATION_WINDOW_MS : MAX_CALL_WINDOW_MS;
  if (window > limit) fail(`Browser order deadline exceeds the ${limit / 1000}s window for ${operation}.`);
}

export function validateBrowserOrderCall(value: unknown): BrowserOrderCallV1 {
  const raw = closed(value, "Browser order call", CALL_FIELDS);
  schemaTag(raw.schema_version, BROWSER_ORDER_CALL_SCHEMA, "Browser order call");
  const operation = choice(raw.operation, BROWSER_ORDER_OPERATIONS, "Browser order operation");
  const binding = nullable(raw.binding, "Browser order binding", validateBinding);
  if (binding === null && !BINDING_OPTIONAL.has(operation)) fail(`Browser order operation ${operation} requires a binding.`);
  const issuedAt = timestamp(raw.issued_at, "Browser order issued_at");
  const deadline = timestamp(raw.deadline, "Browser order deadline");
  checkDeadline(operation, issuedAt, deadline);
  return Object.freeze({
    schema_version: BROWSER_ORDER_CALL_SCHEMA,
    call_id: ident(raw.call_id, "Browser order call id"),
    request_id: ident(raw.request_id, "Browser order request id"),
    operation,
    principal: validatePrincipal(raw.principal, "Browser order principal"),
    adapter: validateAdapterPin(raw.adapter, "Browser order adapter"),
    binding,
    issued_at: issuedAt,
    deadline,
    params: PARAM_VALIDATORS[operation](raw.params, "Browser order params"),
  }) as BrowserOrderCallV1;
}
