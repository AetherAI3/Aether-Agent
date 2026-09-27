// Stable machine codes for every skill refusal. Rendered human guidance lives
// in the UI layer — these codes are the wire/API contract and must never be
// renamed once released (CONTRACTS.md discipline applies).

export const SKILL_ERROR_CODES = [
  "skill.untrusted",
  "skill.changed",
  "skill.disabled",
  "skill.ambiguous",
  "skill.not_found",
  "skill.schema_invalid",
  "skill.version_incompatible",
  "skill.dependency_missing",
  "skill.dependency_cycle",
  "skill.context_budget_exceeded",
  "skill.instruction_scan_incomplete",
  "skill.tool_not_declared",
  "skill.permission_unavailable",
  "skill.permission_denied",
  "skill.resource_unsafe",
  "skill.resource_changed",
  "skill.server_unsupported",
] as const;

export type SkillErrorCode = (typeof SKILL_ERROR_CODES)[number];

/** Structured refusal returned instead of executing. Never execute-then-explain. */
export interface SkillRefusal {
  code: SkillErrorCode;
  skillId?: string;
  detail: string;
  /** Extra machine-readable context, e.g. effective_allowed_tools on tool_not_declared. */
  context?: Readonly<Record<string, string | number | readonly string[]>>;
}

export class SkillError extends Error {
  readonly code: SkillErrorCode;
  readonly refusal: SkillRefusal;

  constructor(refusal: SkillRefusal) {
    super(refusal.code + ": " + refusal.detail);
    this.name = "SkillError";
    this.code = refusal.code;
    this.refusal = refusal;
  }
}
