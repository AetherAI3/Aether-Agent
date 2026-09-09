// The canonical settings contract, as this repository sees it.
//
// F2 convergence rule: Aether Cloud owns the settings contract. This module is
// the ONLY place Aether Agent learns a canonical setting's key, type, default,
// allowed scopes or persistence owner, and it learns all of them from the
// vendored vector file in src/generated/settings_vectors.ts. Nothing here
// re-declares a canonical fact; a hand-written second schema is exactly what
// this lane exists to remove.
//
// What this module decides is only ROUTING: given a setting, which authority
// answers for it.
//
//   persistence "server" -> account/project scope -> canonical Cloud settings
//                           API, with the revision/CAS contract
//   persistence "device" -> this machine's local settings authority
//   session              -> memory only, never durable
//
// It deliberately does NOT perform I/O. settings_cloud.ts owns the HTTP side and
// settings_store.ts owns the local side; both consume the routing decided here.

import {
  AETHER_SETTINGS_CONTRACT_DIGEST,
  AETHER_SETTINGS_VECTORS,
} from "../generated/settings_vectors.js";

export const CANONICAL_SETTINGS_SCHEMA = "aether.settings/1" as const;
export const CANONICAL_SETTINGS_VECTORS_SCHEMA =
  "aether.settings.cross-surface-vectors/1" as const;

/** Highest safe integer revision the canonical CAS contract accepts. */
export const CANONICAL_MAX_REVISION = 9_007_199_254_740_991;

export type CanonicalScope = "device" | "account" | "project";
export type CanonicalPersistence = "device" | "server";
export type CanonicalApply = "immediate" | "next_session" | "approval_step_up";
export type CanonicalValueType = "boolean" | "integer" | "string";

/**
 * Which authority answers for a setting.
 *
 * "cloud"  — account/project scope; the Cloud service is authoritative and a
 *            write must carry the expected revision.
 * "device" — this machine only; local authority, works offline, and is never
 *            given a server row (the settings DB deliberately has none).
 */
export type CanonicalAuthority = "cloud" | "device";

export interface CanonicalValidation {
  readonly kind: "boolean" | "integer" | "enum" | "catalog_model_id";
  readonly options?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maximumLength?: number;
}

export interface CanonicalSetting {
  readonly key: string;
  readonly valueType: CanonicalValueType;
  readonly defaultValue: boolean | number | string;
  readonly allowedScopes: readonly CanonicalScope[];
  readonly persistence: CanonicalPersistence;
  readonly apply: CanonicalApply;
  readonly managedPolicy: boolean;
  readonly policyOnlyScopes: readonly string[];
  readonly deprecated: boolean;
  readonly validation: CanonicalValidation;
}

/**
 * Stable public failure codes. Internal detail (HTTP status, PostgREST error,
 * store errno) is mapped onto these without losing the diagnostic trace id that
 * accompanies them; see settings_cloud.ts.
 */
export type AetherSettingsErrorCode =
  | "AETHER_SETTINGS_REVISION_CONFLICT"
  | "AETHER_SETTINGS_OFFLINE"
  | "AETHER_SETTINGS_SCOPE_INVALID"
  | "AETHER_SETTINGS_POLICY_DENIED"
  | "AETHER_SETTINGS_KEY_UNKNOWN"
  | "AETHER_SETTINGS_VALUE_INVALID"
  | "AETHER_SETTINGS_UNAUTHORIZED"
  | "AETHER_SETTINGS_PROJECT_NOT_FOUND"
  | "AETHER_SETTINGS_DISABLED"
  | "AETHER_SETTINGS_BACKEND_ERROR";

export interface AetherSettingsConflictDetail {
  readonly key: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;
}

/** A typed, value-free failure. Setting VALUES never appear on an error. */
export class AetherSettingsError extends Error {
  readonly code: AetherSettingsErrorCode;
  /** Canonical keys only — never values. */
  readonly keys: readonly string[];
  readonly conflicts: readonly AetherSettingsConflictDetail[];
  /** Correlates with the server log line; safe to print. */
  readonly traceId: string | undefined;

  constructor(
    code: AetherSettingsErrorCode,
    message: string,
    opts: {
      keys?: readonly string[];
      conflicts?: readonly AetherSettingsConflictDetail[];
      traceId?: string | undefined;
    } = {},
  ) {
    super(message);
    this.name = "AetherSettingsError";
    this.code = code;
    this.keys = opts.keys ? [...opts.keys] : [];
    this.conflicts = opts.conflicts ? [...opts.conflicts] : [];
    this.traceId = opts.traceId;
  }
}

const SETTINGS: readonly CanonicalSetting[] = Object.freeze(
  AETHER_SETTINGS_VECTORS.settings.map(
    (item) => Object.freeze({ ...item }) as unknown as CanonicalSetting,
  ),
);

const BY_KEY = new Map<string, CanonicalSetting>(
  SETTINGS.map((item) => [item.key, item]),
);

/** Every canonical setting, in canonical (key-sorted) order. */
export function canonicalSettings(): readonly CanonicalSetting[] {
  return SETTINGS;
}

/** The canonical definition, or null when the key is not canonical at all. */
export function canonicalSetting(key: string): CanonicalSetting | null {
  return BY_KEY.get(key) ?? null;
}

/** Throws AETHER_SETTINGS_KEY_UNKNOWN rather than inventing a definition. */
export function requireCanonicalSetting(key: string): CanonicalSetting {
  const found = BY_KEY.get(key);
  if (!found) {
    throw new AetherSettingsError(
      "AETHER_SETTINGS_KEY_UNKNOWN",
      `${key} is not a canonical Aether setting`,
      { keys: [key] },
    );
  }
  return found;
}

/** Which authority answers for this key. */
export function canonicalAuthority(key: string): CanonicalAuthority {
  return requireCanonicalSetting(key).persistence === "server"
    ? "cloud"
    : "device";
}

/**
 * The scope a write lands in when the caller did not name one.
 *
 * A device key has exactly one scope. A server key defaults to `account`;
 * `project` is opt-in because a project write is invisible from every other
 * project and is easy to make by accident.
 */
export function defaultWriteScope(key: string): CanonicalScope {
  const definition = requireCanonicalSetting(key);
  return definition.persistence === "device" ? "device" : "account";
}

export function assertScopeAllowed(key: string, scope: CanonicalScope): void {
  const definition = requireCanonicalSetting(key);
  if (!definition.allowedScopes.includes(scope)) {
    throw new AetherSettingsError(
      "AETHER_SETTINGS_SCOPE_INVALID",
      `${key} cannot be written at ${scope} scope`,
      { keys: [key] },
    );
  }
}

/**
 * Validate a value against the canonical constraint.
 *
 * `availableModels` is supplied by the caller for `catalog_model_id`; the agent
 * never hard-codes a model list. When it is omitted the check is limited to
 * shape, because refusing every model offline would be worse than accepting a
 * canonical-looking id the server will re-validate anyway.
 */
export function validateCanonicalValue(
  key: string,
  value: unknown,
  opts: { availableModels?: readonly string[] } = {},
): boolean | number | string {
  const definition = requireCanonicalSetting(key);
  const invalid = (why: string): never => {
    throw new AetherSettingsError(
      "AETHER_SETTINGS_VALUE_INVALID",
      `${key} ${why}`,
      { keys: [key] },
    );
  };
  const v = definition.validation;

  if (definition.valueType === "boolean") {
    if (typeof value !== "boolean") return invalid("must be a boolean");
    return value;
  }
  if (definition.valueType === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return invalid("must be an integer");
    }
    if (v.minimum !== undefined && value < v.minimum) {
      return invalid(`must be at least ${v.minimum}`);
    }
    if (v.maximum !== undefined && value > v.maximum) {
      return invalid(`must be at most ${v.maximum}`);
    }
    return value;
  }
  if (typeof value !== "string") return invalid("must be a string");
  if (v.kind === "enum") {
    if (!v.options?.includes(value)) {
      return invalid(`must be one of ${(v.options ?? []).join(", ")}`);
    }
    return value;
  }
  if (v.kind === "catalog_model_id") {
    if (v.maximumLength !== undefined && value.length > v.maximumLength) {
      return invalid(`must be at most ${v.maximumLength} characters`);
    }
    if (value !== value.trim() || value.length === 0) {
      return invalid("must not be empty or padded");
    }
    // A stored model can outlive its catalog entry; only reject when a catalog
    // was actually supplied, so `settings get` stays usable offline.
    if (opts.availableModels && !opts.availableModels.includes(value)) {
      return invalid("is not an available model for this account");
    }
    return value;
  }
  return invalid("failed canonical validation");
}

/**
 * Existing Agent setting ids that ARE the canonical setting under another name.
 *
 * Only semantic identity belongs here. A merely similar setting is listed in
 * NON_CANONICAL_AGENT_SETTINGS with the reason it was not equated, so the
 * decision is reviewable instead of implicit.
 */
export const AGENT_SETTING_ALIASES: Readonly<Record<string, string>> =
  Object.freeze({
    "code.hosted_model": "agent.defaultModel",
    "code.effort": "agent.defaultEffort",
    "voice.enabled": "voice.enabled",
  });

/**
 * Agent settings deliberately NOT mapped onto a canonical key, and why.
 *
 * These stay on their existing local persistence and keep their existing CLI
 * behaviour. Recording them here is what makes "unknown keys are never silently
 * discarded" checkable.
 */
export const NON_CANONICAL_AGENT_SETTINGS: Readonly<Record<string, string>> =
  Object.freeze({
    "code.auto_apply":
      "distinct semantics: this is the agent's workspace edit-apply gate, " +
      "whereas actions.liveCanvas.autoApply is the Cloud Live Canvas mutation " +
      "ceiling. Equating them would let a local toggle imply a server capability.",
    "code.backend": "local route selection (auto/local/cloud); has no canonical key",
    "code.permission_mode": "local tool-authority gate; has no canonical key",
    "agent.api_base_url": "local transport target; must not be server-owned",
    "agent.telemetry": "existing agent-owned opt-in; has no canonical key",
    "ollama.selected_model": "local runtime slot; never a hosted catalog id",
    "ollama.host": "local runtime endpoint",
    "voice.interaction_mode": "not yet in the canonical contract",
    "voice.hotkey": "not yet in the canonical contract",
    "voice.profile": "not yet in the canonical contract",
    "voice.speech_output": "not yet in the canonical contract",
    "voice.local_fallback": "not yet in the canonical contract",
    "voice.end_of_turn_silence_ms": "not yet in the canonical contract",
  });

/** The canonical key an existing agent id maps to, or null when it is local. */
export function canonicalKeyForAgentSetting(agentId: string): string | null {
  return AGENT_SETTING_ALIASES[agentId] ?? null;
}

export { AETHER_SETTINGS_CONTRACT_DIGEST };
