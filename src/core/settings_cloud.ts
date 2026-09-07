// The Agent's client for the canonical Cloud settings service.
//
// Account- and project-scoped settings are Cloud-authoritative. This module is
// the only place the Agent reads or writes them, and every write carries the
// expected per-key revision, so a stale write is refused by the server instead
// of silently winning.
//
// It owns no schema: keys, types, defaults and scopes all come from
// settings_canonical.ts, which reads the vendored canonical contract.
//
// Two rules this module exists to keep honest:
//
//   1. A local cache of an account/project value is NEVER authoritative. It is
//      returned only as an explicitly-stale projection with the revision it was
//      captured at.
//   2. An offline write is never reported as saved. It fails with
//      AETHER_SETTINGS_OFFLINE and the caller keeps it as pending user state.

import { createHash } from "node:crypto";

import { HttpError } from "./errors.js";
import type { ApiClient } from "./transport.js";
import {
  AetherSettingsError,
  assertScopeAllowed,
  requireCanonicalSetting,
  validateCanonicalValue,
  type AetherSettingsConflictDetail,
  type AetherSettingsErrorCode,
  type CanonicalScope,
} from "./settings_canonical.js";

export const CODE_SETTINGS_BASE = "/code/settings" as const;

/** The scopes the server accepts a mutation at. `device` is never one of them. */
export type CloudWritableScope = Extract<CanonicalScope, "account" | "project">;

export interface EffectiveOverride {
  readonly configured: boolean;
  readonly value?: unknown;
  readonly revision: number;
}

export interface EffectiveSetting {
  readonly key: string;
  readonly effectiveValue: unknown;
  readonly sourceScope: "default" | "account" | "project" | "policy";
  readonly sourceId: string | null;
  readonly revision: number;
  readonly overrides: Readonly<Record<string, EffectiveOverride>>;
  readonly managed: boolean;
  readonly locked: boolean;
  readonly reason: string | null;
  readonly policyRef: string | null;
  readonly capability: { readonly available: boolean; readonly reason?: string | null };
  readonly apply: string;
}

export interface EffectiveSettingsResponse {
  readonly schema: "aether.settings.effective/1";
  /** Opaque digest of the whole resolved view; not a per-key revision. */
  readonly revision: string;
  readonly projectId: string | null;
  readonly settings: Readonly<Record<string, EffectiveSetting>>;
}

export interface SettingsMutationResponse {
  readonly schema: "aether.settings.mutation/1";
  readonly operation: "patch" | "reset";
  readonly scope: CloudWritableScope;
  readonly scopeId: string | null;
  /** True when the server replayed an earlier identical request. */
  readonly duplicate: boolean;
  readonly changedKeys: readonly string[];
  readonly revisions: Readonly<Record<string, number>>;
  readonly revision: string;
}

/** Maps the server's closed error codes onto this repository's public codes. */
const SERVER_CODE_MAP: Readonly<Record<string, AetherSettingsErrorCode>> = Object.freeze(
  {
    REVISION_CONFLICT: "AETHER_SETTINGS_REVISION_CONFLICT",
    IDEMPOTENCY_CONFLICT: "AETHER_SETTINGS_REVISION_CONFLICT",
    UNAUTHORIZED: "AETHER_SETTINGS_UNAUTHORIZED",
    PROJECT_NOT_FOUND: "AETHER_SETTINGS_PROJECT_NOT_FOUND",
    SETTINGS_DISABLED: "AETHER_SETTINGS_DISABLED",
    SETTINGS_UNAVAILABLE: "AETHER_SETTINGS_DISABLED",
    CAPABILITY_DENIED: "AETHER_SETTINGS_POLICY_DENIED",
    POLICY_DENIED: "AETHER_SETTINGS_POLICY_DENIED",
    POLICY_LOCKED: "AETHER_SETTINGS_POLICY_DENIED",
    TEAM_POLICY_ONLY: "AETHER_SETTINGS_POLICY_DENIED",
    FORBIDDEN_SCOPE: "AETHER_SETTINGS_SCOPE_INVALID",
    INCORRECT_SCOPE: "AETHER_SETTINGS_SCOPE_INVALID",
    INVALID_PROJECT_SCOPE: "AETHER_SETTINGS_SCOPE_INVALID",
    DEVICE_SCOPE_SERVER_REJECTED: "AETHER_SETTINGS_SCOPE_INVALID",
    INVALID_REQUEST: "AETHER_SETTINGS_VALUE_INVALID",
    INVALID_IDEMPOTENCY_KEY: "AETHER_SETTINGS_VALUE_INVALID",
    MODEL_CATALOG_UNAVAILABLE: "AETHER_SETTINGS_OFFLINE",
    SETTINGS_BACKEND_UNAVAILABLE: "AETHER_SETTINGS_OFFLINE",
  },
);

function detailOf(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const outer = body as Record<string, unknown>;
  const inner = outer["detail"];
  if (inner && typeof inner === "object") return inner as Record<string, unknown>;
  return "code" in outer ? outer : null;
}

function conflictsOf(
  detail: Record<string, unknown> | null,
): AetherSettingsConflictDetail[] {
  const raw = detail?.["conflicts"];
  if (!raw || typeof raw !== "object") return [];
  const out: AetherSettingsConflictDetail[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const pair = value as Record<string, unknown>;
    const expected = pair["expected"];
    const actual = pair["actual"];
    if (typeof expected !== "number" || typeof actual !== "number") continue;
    out.push({ key, expectedRevision: expected, actualRevision: actual });
  }
  return out;
}

/**
 * Translate any failure into a stable public error.
 *
 * A transport failure becomes AETHER_SETTINGS_OFFLINE, because from the user's
 * point of view "the server did not answer" and "the server refused" must never
 * look the same: only the second one means their edit was seen.
 */
export function toSettingsError(
  err: unknown,
  keys: readonly string[],
): AetherSettingsError {
  if (err instanceof AetherSettingsError) return err;
  if (err instanceof HttpError) {
    const detail = detailOf(err.body);
    const serverCode =
      typeof detail?.["code"] === "string" ? (detail["code"] as string) : "";
    const message =
      typeof detail?.["message"] === "string"
        ? (detail["message"] as string)
        : err.message;
    const traceId =
      typeof detail?.["traceId"] === "string" ? (detail["traceId"] as string) : undefined;
    // 5xx is the server telling us its own backend is unreachable; that is an
    // availability failure, not a rejection of the edit.
    const mapped: AetherSettingsErrorCode =
      SERVER_CODE_MAP[serverCode] ??
      (err.status >= 500 ? "AETHER_SETTINGS_OFFLINE" : "AETHER_SETTINGS_BACKEND_ERROR");
    return new AetherSettingsError(mapped, message, {
      keys,
      conflicts: conflictsOf(detail),
      traceId,
    });
  }
  return new AetherSettingsError(
    "AETHER_SETTINGS_OFFLINE",
    "Aether Cloud did not answer; the change was not saved",
    { keys },
  );
}

/**
 * Deterministic idempotency key for one exact edit.
 *
 * Deriving it from the request means an interrupted retry of the SAME edit
 * replays the server's original receipt instead of applying twice, while a
 * genuinely different edit gets a different key. Matches the server's required
 * shape: ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$.
 */
export function idempotencyKeyFor(request: {
  operation: "patch" | "reset";
  scope: CloudWritableScope;
  projectId?: string | null;
  values?: Readonly<Record<string, unknown>>;
  keys?: readonly string[];
  expectedRevisions: Readonly<Record<string, number>>;
}): string {
  const sortedKeys = [...(request.keys ?? Object.keys(request.values ?? {}))].sort();
  const canonical = JSON.stringify({
    operation: request.operation,
    scope: request.scope,
    scopeId: request.projectId ?? null,
    keys: sortedKeys,
    values: request.values
      ? Object.fromEntries(sortedKeys.map((k) => [k, request.values?.[k] ?? null]))
      : null,
    expectedRevisions: Object.fromEntries(
      sortedKeys.map((k) => [k, request.expectedRevisions[k] ?? null]),
    ),
  });
  return `s${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 48)}`;
}

export interface CloudSettingsClientDeps {
  readonly api: Pick<ApiClient, "getJson" | "patchJson" | "postJsonWithHeaders">;
}

export class CloudSettingsClient {
  private readonly api: CloudSettingsClientDeps["api"];

  constructor(deps: CloudSettingsClientDeps) {
    this.api = deps.api;
  }

  /** The canonical resolved view. Read-only; never a write path. */
  async effective(
    opts: { projectId?: string | null; signal?: AbortSignal } = {},
  ): Promise<EffectiveSettingsResponse> {
    const query = opts.projectId
      ? `?project_id=${encodeURIComponent(opts.projectId)}`
      : "";
    try {
      return await this.api.getJson<EffectiveSettingsResponse>(
        `${CODE_SETTINGS_BASE}/effective${query}`,
        opts.signal,
      );
    } catch (err) {
      throw toSettingsError(err, []);
    }
  }

  /**
   * Write server-backed settings with compare-and-swap.
   *
   * `expectedRevisions` must be the revisions the caller actually READ. A stale
   * one is refused with AETHER_SETTINGS_REVISION_CONFLICT carrying both
   * revisions; this client never re-reads and retries, because a silent retry
   * is a blind last-write-wins wearing a different name.
   */
  async patch(
    scope: CloudWritableScope,
    request: {
      values: Readonly<Record<string, unknown>>;
      expectedRevisions: Readonly<Record<string, number>>;
      projectId?: string | null;
      availableModels?: readonly string[];
    },
    opts: { signal?: AbortSignal } = {},
  ): Promise<SettingsMutationResponse> {
    const keys = Object.keys(request.values).sort();
    this.assertWritable(scope, keys, request.expectedRevisions);
    const values: Record<string, unknown> = {};
    for (const key of keys) {
      const validateOpts = request.availableModels
        ? { availableModels: request.availableModels }
        : {};
      values[key] = validateCanonicalValue(key, request.values[key], validateOpts);
    }
    const body = {
      ...(request.projectId ? { projectId: request.projectId } : {}),
      values,
      expectedRevisions: Object.fromEntries(
        keys.map((k) => [k, request.expectedRevisions[k]]),
      ),
    };
    const idempotencyKey = idempotencyKeyFor({
      operation: "patch",
      scope,
      projectId: request.projectId ?? null,
      values,
      expectedRevisions: request.expectedRevisions,
    });
    try {
      return await this.api.patchJson<SettingsMutationResponse>(
        `${CODE_SETTINGS_BASE}/${scope}`,
        body,
        { headers: { "Idempotency-Key": idempotencyKey }, ...opts },
      );
    } catch (err) {
      throw toSettingsError(err, keys);
    }
  }

  /** Clear overrides at one scope, under the same CAS contract as patch(). */
  async reset(
    scope: CloudWritableScope,
    request: {
      keys: readonly string[];
      expectedRevisions: Readonly<Record<string, number>>;
      projectId?: string | null;
    },
    opts: { signal?: AbortSignal } = {},
  ): Promise<SettingsMutationResponse> {
    const keys = [...request.keys].sort();
    this.assertWritable(scope, keys, request.expectedRevisions);
    const body = {
      ...(request.projectId ? { projectId: request.projectId } : {}),
      keys,
      expectedRevisions: Object.fromEntries(
        keys.map((k) => [k, request.expectedRevisions[k]]),
      ),
    };
    const idempotencyKey = idempotencyKeyFor({
      operation: "reset",
      scope,
      projectId: request.projectId ?? null,
      keys,
      expectedRevisions: request.expectedRevisions,
    });
    try {
      return await this.api.postJsonWithHeaders<SettingsMutationResponse>(
        `${CODE_SETTINGS_BASE}/${scope}/reset`,
        body,
        { headers: { "Idempotency-Key": idempotencyKey }, ...opts },
      );
    } catch (err) {
      throw toSettingsError(err, keys);
    }
  }

  /**
   * Refuse locally what the server would refuse anyway.
   *
   * This is a courtesy, never an authority: the server re-checks scope, policy
   * and ownership. Checking here keeps a device key from ever being put on the
   * wire at account scope, and keeps a missing revision from being sent as 0 —
   * which would read as "I expect this to be unset" and could clobber a real
   * value the caller never saw.
   */
  private assertWritable(
    scope: CloudWritableScope,
    keys: readonly string[],
    expectedRevisions: Readonly<Record<string, number>>,
  ): void {
    if (keys.length === 0) {
      throw new AetherSettingsError(
        "AETHER_SETTINGS_VALUE_INVALID",
        "a settings write must name at least one key",
      );
    }
    for (const key of keys) {
      const definition = requireCanonicalSetting(key);
      if (definition.persistence !== "server") {
        throw new AetherSettingsError(
          "AETHER_SETTINGS_SCOPE_INVALID",
          `${key} is a device setting and is never written through Aether Cloud`,
          { keys: [key] },
        );
      }
      assertScopeAllowed(key, scope);
      const revision = expectedRevisions[key];
      if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
        throw new AetherSettingsError(
          "AETHER_SETTINGS_REVISION_CONFLICT",
          `${key} was written without the revision it was read at`,
          { keys: [key] },
        );
      }
    }
  }
}
