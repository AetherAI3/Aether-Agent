// agent-browser-ats-order/1, decisions: the pure functions ATSv2 applies to
// validated calls and results before it acts. No I/O, no credential.

import { digestEquals } from "./canonical.js";
import { fail } from "./primitives.js";
import {
  BROWSER_OPERATION_EFFECTS, MAX_CLOCK_SKEW_MS,
  type BrowserBindingRef, type BrowserBindingState, type BrowserOrderCallV1, type BrowserOrderOperation,
  type BrowserOrderParamsByOperation, type SiteMode,
} from "./browser_order.js";
import type { BrowserOrderResultV1, ModeEvidence, RenderedTicket, VerifySessionData } from "./browser_order_result.js";
import { TICKET_FIELDS, type BrowserAdapterPin, type BrowserTicket } from "./browser_order_values.js";

export function adapterPinsEqual(a: BrowserAdapterPin, b: BrowserAdapterPin): boolean {
  return a.adapter_id === b.adapter_id && a.adapter_version === b.adapter_version && digestEquals(a.adapter_digest, b.adapter_digest);
}

/**
 * The site mode two independent indicators agree on. A single site-specific
 * indicator suffices only where the adapter declares that no second one
 * exists; an absent or contradicting second indicator leaves the mode unknown.
 */
export function resolveSiteMode(evidence: ModeEvidence): SiteMode | null {
  if (evidence.primary === "absent") return null;
  if (evidence.secondary === "not_supported") return evidence.primary;
  return evidence.secondary === evidence.primary ? evidence.primary : null;
}

/**
 * Binding state from a verify_session answer. Live is always locked here: a
 * signed-in live session never enables an order without ATSv2's separate,
 * expiring live arm.
 */
export function deriveBrowserBindingState(session: VerifySessionData): BrowserBindingState {
  if (session.session_state !== "verified") return session.session_state;
  if (session.trading_permission !== "equity_orders" || session.mode_evidence === null) return "observe_only";
  const mode = resolveSiteMode(session.mode_evidence);
  if (mode === null) return "observe_only";
  return mode === "paper" ? "paper_ready" : "live_locked";
}

/**
 * Whether the request behind this result must be settled from the site's own
 * order history before anything else is submitted. True for a commit or
 * cancel that was dispatched or may have been. A refused mutation dispatched
 * nothing — that is what a refusal promises — except that `duplicate_commit`
 * proves an earlier commit for the same request exists, so it reconciles too.
 */
export function requiresReconciliation(result: BrowserOrderResultV1): boolean {
  if (BROWSER_OPERATION_EFFECTS[result.operation] !== "mutate") return false;
  return result.status !== "refused" || result.refusal === "duplicate_commit";
}

export type BrowserResultVerdict = { readonly answers: true } | { readonly answers: false; readonly reason: string };

const ANSWERS: BrowserResultVerdict = Object.freeze({ answers: true as const });

function refuse(reason: string): BrowserResultVerdict {
  return Object.freeze({ answers: false as const, reason });
}

function accountMatches(fingerprint: string, mode: SiteMode, binding: BrowserBindingRef): BrowserResultVerdict {
  if (!digestEquals(fingerprint, binding.account_fingerprint)) return refuse("Account differs from the binding.");
  if (mode !== binding.site_mode) return refuse("Site mode differs from the binding.");
  return ANSWERS;
}

function sessionMatches(session: VerifySessionData, binding: BrowserBindingRef): BrowserResultVerdict {
  if (session.session_state !== "verified" || session.account_fingerprint === null || session.mode_evidence === null) {
    return refuse("Session is not verified for this binding.");
  }
  const mode = resolveSiteMode(session.mode_evidence);
  if (mode === null) return refuse("Site mode is unresolved for this binding.");
  const account = accountMatches(session.account_fingerprint, mode, binding);
  if (!account.answers) return account;
  if (session.trading_permission !== "equity_orders") return refuse("Session lost trading permission for this binding.");
  return ANSWERS;
}

function ticketMatches(rendered: RenderedTicket, expected: BrowserTicket, binding: BrowserBindingRef): BrowserResultVerdict {
  const account = accountMatches(rendered.account_fingerprint, rendered.site_mode, binding);
  if (!account.answers) return account;
  const differing = TICKET_FIELDS.find((field) => rendered[field] !== expected[field]);
  return differing === undefined ? ANSWERS : refuse(`Rendered ticket ${differing} differs from the requested ticket.`);
}

function paramsOf<O extends BrowserOrderOperation>(call: BrowserOrderCallV1, operation: O): BrowserOrderParamsByOperation[O] {
  if (call.operation !== operation) fail("Browser order call and result operations diverged.");
  return call.params as BrowserOrderParamsByOperation[O];
}

function bindingOf(call: BrowserOrderCallV1): BrowserBindingRef {
  return call.binding ?? fail(`Browser order operation ${call.operation} requires a binding.`);
}

const NO_DATA = refuse("An ok result carries no data.");

function dataAnswersCall(call: BrowserOrderCallV1, result: BrowserOrderResultV1): BrowserResultVerdict {
  switch (result.operation) {
    case "verify_session":
      if (!result.data) return NO_DATA;
      return call.binding === null ? ANSWERS : sessionMatches(result.data, call.binding);
    case "read_market":
      if (!result.data) return NO_DATA;
      return result.data.symbol === paramsOf(call, "read_market").symbol ? ANSWERS : refuse("Quote symbol differs from the requested symbol.");
    case "read_account":
      if (!result.data) return NO_DATA;
      return accountMatches(result.data.account_fingerprint, result.data.site_mode, bindingOf(call));
    case "prepare_ticket":
    case "verify_ticket":
      if (!result.data) return NO_DATA;
      return ticketMatches(result.data.rendered_ticket, paramsOf(call, result.operation).ticket, bindingOf(call));
    case "commit_once":
      if (!result.data) return NO_DATA;
      return digestEquals(result.data.rendered_ticket_digest, paramsOf(call, "commit_once").rendered_ticket_digest)
        ? ANSWERS : refuse("Committed ticket differs from the verified ticket.");
    case "read_order": {
      if (!result.data) return NO_DATA;
      const account = accountMatches(result.data.account_fingerprint, result.data.site_mode, bindingOf(call));
      if (!account.answers) return account;
      const wanted = paramsOf(call, "read_order").site_order_id;
      const found = result.data.order;
      return wanted === null || found === null || found.site_order_id === wanted ? ANSWERS : refuse("Order history returned a different order.");
    }
    case "read_positions": {
      if (!result.data) return NO_DATA;
      const account = accountMatches(result.data.account_fingerprint, result.data.site_mode, bindingOf(call));
      if (!account.answers) return account;
      const wanted = paramsOf(call, "read_positions").symbol;
      return wanted === null || result.data.positions.every((entry) => entry.symbol === wanted)
        ? ANSWERS : refuse("Positions include a symbol other than the requested symbol.");
    }
    case "cancel_order": {
      if (!result.data) return NO_DATA;
      const account = accountMatches(result.data.account_fingerprint, result.data.site_mode, bindingOf(call));
      if (!account.answers) return account;
      return result.data.site_order_id === paramsOf(call, "cancel_order").site_order_id ? ANSWERS : refuse("Cancel result names a different order.");
    }
    case "end_control":
      return result.data ? ANSWERS : NO_DATA;
  }
}

/**
 * The gate every browser answer passes before ATSv2 acts on it. It proves the
 * result answers exactly this call — same call, request, operation, principal
 * and session generation, from the same pinned adapter, observed no earlier
 * than the call allowing for clock skew — and that its data agrees with the
 * binding and parameters the call named. A read that arrives after its
 * deadline is stale. A mutation's outcome is a fact about the site and is never
 * discarded for lateness; when this gate refuses an answer to a mutation,
 * ATSv2 treats that mutation as `ambiguous`, because it journaled COMMITTING
 * before it asked.
 */
export function verifyBrowserResult(call: BrowserOrderCallV1, result: BrowserOrderResultV1): BrowserResultVerdict {
  if (result.call_id !== call.call_id || result.request_id !== call.request_id || result.operation !== call.operation) {
    return refuse("Result answers a different call, request or operation.");
  }
  if (result.principal.session_generation !== call.principal.session_generation) {
    return refuse("Browser session generation changed; verify the binding again.");
  }
  if (result.principal.user_ref !== call.principal.user_ref || result.principal.agent_id !== call.principal.agent_id
    || result.principal.browser_session_id !== call.principal.browser_session_id) {
    return refuse("Result comes from a different user, agent or browser session.");
  }
  if (!adapterPinsEqual(result.adapter, call.adapter)) return refuse("Adapter differs from the pinned adapter.");
  if (Date.parse(result.observed_at) < Date.parse(call.issued_at) - MAX_CLOCK_SKEW_MS) return refuse("Observation predates the call.");
  if (result.status !== "ok") return ANSWERS;
  if (BROWSER_OPERATION_EFFECTS[call.operation] !== "mutate" && Date.parse(result.observed_at) > Date.parse(call.deadline)) {
    return refuse("Observation arrived after the call deadline.");
  }
  return dataAnswersCall(call, result);
}
