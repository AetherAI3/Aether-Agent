// RequestedEffectiveExecutionStateV1 — the requested-versus-effective mode
// projection shared by Spec 1 (section 11.8) and Spec 2 (section 7.2).
//
// This is the most load-bearing shape in the freeze. "Requested" is what the
// operator asked for; "effective" is what ATSv2 will actually honour. They are
// separate fields precisely so a UI preference can never be mistaken for an
// authority grant. Note that packages/ats-skills/src/settings.js already
// stores a requested-only preference and documents it as "not applied by this
// module" — this contract is the other half of that sentence.
//
// SPEC RECONCILIATION. The two specs enumerate `effective_mode` from different
// vantage points and neither list is complete on its own:
//
//   Spec 2 section 7.2 (runtime lens):    offline | observe | paper | approve | auto
//   Spec 1 section 11.8 (execution lens): observe | review_only | orders_paused
//                                         | emergency_locked
//
// They describe one projection, so this module freezes the UNION. Splitting
// them into two enums would let a runtime-authored `orders_paused` fail to
// parse on the connector side — a halt that does not deserialize is a halt
// that does not stop anything.

import { choice, fail, closed, schemaTag, text } from "./primitives.js";

export const REQUESTED_EXECUTION_MODES = ["observe", "paper", "approve", "auto"] as const;
export type RequestedExecutionMode = (typeof REQUESTED_EXECUTION_MODES)[number];

export const EFFECTIVE_EXECUTION_MODES = [
  "offline",
  "observe",
  "review_only",
  "paper",
  "approve",
  "auto",
  "orders_paused",
  "emergency_locked",
] as const;
export type EffectiveExecutionMode = (typeof EFFECTIVE_EXECUTION_MODES)[number];

/**
 * The environment a preview, approval and commit are bound to. Spec 1 section
 * 8.1: a Robinhood live preview cannot authorize an ATS paper fill and vice
 * versa, so this rides on the intent, the review, the approval AND the commit,
 * and all four must name the same value.
 */
export const EXECUTION_ENVIRONMENTS = ["ats_paper", "provider_sandbox", "provider_live"] as const;
export type ExecutionEnvironment = (typeof EXECUTION_ENVIRONMENTS)[number];

/**
 * Authority ladder. A higher rank permits strictly more than a lower one, so
 * "effective must not exceed requested" reduces to a numeric comparison.
 *
 * The two halt states are NOT on the ladder: `orders_paused` and
 * `emergency_locked` are restrictions that can follow any request, and ranking
 * them would imply an operator could "request" a kill switch as an authority
 * level. They are handled as always-permitted outcomes below.
 */
const AUTHORITY_RANK: Readonly<Record<string, number>> = Object.freeze({
  offline: 0,
  observe: 1,
  review_only: 2,
  paper: 3,
  approve: 4,
  auto: 5,
});

const HALTED: readonly EffectiveExecutionMode[] = ["orders_paused", "emergency_locked"];

export const EXECUTION_STATE_SCHEMA = "aether.ats.execution-state/1" as const;

export interface RequestedEffectiveExecutionStateV1 {
  readonly schema_version: typeof EXECUTION_STATE_SCHEMA;
  readonly requested_mode: RequestedExecutionMode;
  readonly effective_mode: EffectiveExecutionMode;
  /**
   * Why effective differs from requested. Required whenever they differ, so a
   * downgrade is always explainable to the operator instead of appearing as a
   * stuck toggle.
   */
  readonly effective_reason: string | null;
}

const FIELDS = ["schema_version", "requested_mode", "effective_mode", "effective_reason"] as const;

/** True when the effective mode is a halt rather than a point on the ladder. */
export function isHalted(mode: EffectiveExecutionMode): boolean {
  return HALTED.includes(mode);
}

/**
 * True when `effective` grants no more authority than `requested`.
 *
 * This is the mechanical form of both specs' rule that an Agent-side preference
 * cannot upgrade authority: a runtime may always answer with LESS than was
 * asked for (degraded, paused, killed), never more.
 */
export function withinRequestedAuthority(
  requested: RequestedExecutionMode,
  effective: EffectiveExecutionMode,
): boolean {
  if (isHalted(effective)) return true;
  const asked = AUTHORITY_RANK[requested];
  const granted = AUTHORITY_RANK[effective];
  if (asked === undefined || granted === undefined) return false;
  return granted <= asked;
}

/**
 * Whether an effective mode permits ATSv2 to place an order at all. Note that
 * `approve` and `auto` permit SUBMISSION, not unattended trading — Spec 1 keeps
 * every Aether-initiated order behind an exact per-order approval regardless of
 * mode, and `auto` remains unreachable for this release.
 */
export function permitsOrderSubmission(mode: EffectiveExecutionMode): boolean {
  return mode === "paper" || mode === "approve" || mode === "auto";
}

export function validateExecutionState(value: unknown, name = "Execution state"): RequestedEffectiveExecutionStateV1 {
  const raw = closed(value, name, FIELDS);
  const schema = schemaTag(raw.schema_version, EXECUTION_STATE_SCHEMA, name) as typeof EXECUTION_STATE_SCHEMA;
  const requested = choice(raw.requested_mode, REQUESTED_EXECUTION_MODES, `${name} requested mode`);
  const effective = choice(raw.effective_mode, EFFECTIVE_EXECUTION_MODES, `${name} effective mode`);
  const reason = raw.effective_reason === null ? null : text(raw.effective_reason, `${name} effective reason`, 200);

  if (!withinRequestedAuthority(requested, effective)) {
    fail(`${name} cannot grant more authority than was requested.`);
  }
  if (requested !== effective && reason === null) {
    fail(`${name} must explain why the effective mode differs from the requested mode.`);
  }

  return Object.freeze({
    schema_version: schema,
    requested_mode: requested,
    effective_mode: effective,
    effective_reason: reason,
  });
}

/**
 * Render the projection for an operator surface. Both specs require requested
 * and effective to be shown separately and never collapsed into one badge, so
 * the formatter has no single-value form.
 */
export function formatExecutionState(state: RequestedEffectiveExecutionStateV1): string {
  const suffix = state.effective_reason ? ` · ${state.effective_reason}` : "";
  return `Requested: ${state.requested_mode} · Effective: ${state.effective_mode}${suffix}`;
}
