// A registry adapter whose authority is the canonical Cloud settings service.
//
// This is what makes the Agent a ROUTER over the canonical scopes rather than a
// second settings product: an account- or project-scoped canonical setting is
// read from Cloud and written to Cloud under the revision/CAS contract, through
// the same registry seam every other Agent setting uses.
//
// The rule this module exists to keep is Section C's: a local cached
// account/project value is NEVER authoritative. When Cloud answers, its value
// is the only layer offered. A pre-existing local value is reported alongside
// as an explicitly non-authoritative fact, so a user can see what would be
// migrated without the Agent quietly acting on it.
//
// Session scope is refused outright. A server-backed setting has no session
// representation, and silently downgrading a `--scope session` write to a
// durable account write is exactly the accident this lane exists to prevent.

import {
  AetherSettingsError,
  requireCanonicalSetting,
  validateCanonicalValue,
} from "./settings_canonical.js";
import type {
  CloudSettingsClient,
  EffectiveSetting,
  EffectiveSettingsResponse,
} from "./settings_cloud.js";
import type {
  AdapterApplyReceipt,
  AdapterApplyResult,
  ConfirmationResolver,
  SettingChange,
  SettingDefinition,
  SettingHealth,
  SettingLayer,
  SettingPlanContext,
  SettingReadResult,
  SettingScope,
  SettingValue,
  SettingValueType,
  SettingsOperationContext,
  ValidationResult,
  WritableSettingScope,
} from "./settings_registry.js";

/** The Cloud scope an Agent writable scope corresponds to. */
export function cloudScopeFor(scope: WritableSettingScope): "account" | "project" {
  if (scope === "global") return "account";
  if (scope === "project") return "project";
  throw new AetherSettingsError(
    "AETHER_SETTINGS_SCOPE_INVALID",
    "a Cloud-backed setting has no session scope",
  );
}

/** What a pre-existing local value looks like to this adapter. */
export interface LegacyLocalValue {
  readonly value: SettingValue;
  /** Where it came from, for the migration report. Never a credential. */
  readonly source: string;
}

export interface CloudSettingAdapterDeps {
  readonly client: Pick<CloudSettingsClient, "effective" | "patch" | "reset">;
  /** The project a project-scoped write targets; null means none is selected. */
  readonly projectId?: () => string | null;
  /** Catalogue for `catalog_model_id` validation; omitted when unknown. */
  readonly availableModels?: () => readonly string[] | undefined;
  /**
   * The value this setting had before it became Cloud-backed.
   *
   * Reported, never uploaded. Section D: a server-backed legacy value is not
   * pushed to Cloud until the user asks, so an offline machine can never
   * resurrect an old choice over a newer one made elsewhere.
   */
  readonly legacy?: () => Promise<LegacyLocalValue | null>;
}

export interface CloudSettingOptions {
  /** The existing user-facing Agent id, kept for compatibility. */
  readonly id: string;
  /** The canonical key it routes to. */
  readonly canonicalKey: string;
  readonly section: string;
  readonly label: string;
  readonly description: string;
  readonly valueType: SettingValueType;
  readonly deps: CloudSettingAdapterDeps;
  readonly confirmation?: ConfirmationResolver<SettingValue>;
}

interface CloudPlan {
  readonly canonicalKey: string;
  readonly cloudScope: "account" | "project";
  readonly projectId: string | null;
  readonly operation: "set" | "unset";
  readonly value?: SettingValue;
  readonly expectedRevision: number;
}

interface CloudRollbackToken {
  readonly canonicalKey: string;
  readonly cloudScope: "account" | "project";
  readonly projectId: string | null;
  /** The revision the write produced; the rollback expects it. */
  readonly revision: number;
  /** What to restore. Absent means the key was unconfigured before. */
  readonly previousValue?: SettingValue;
}

function healthFor(error: AetherSettingsError): SettingHealth {
  switch (error.code) {
    case "AETHER_SETTINGS_OFFLINE":
      return { state: "unavailable", summary: "Aether Cloud is unreachable" };
    case "AETHER_SETTINGS_UNAUTHORIZED":
      return { state: "unconfigured", summary: "sign in to read account settings" };
    case "AETHER_SETTINGS_DISABLED":
      return {
        state: "disabled_by_policy",
        summary: "settings are not enabled for this account",
      };
    default:
      return { state: "degraded", summary: error.code };
  }
}

/**
 * Turn one canonical setting's effective state into registry layers.
 *
 * Only Cloud's answer becomes a layer. A managed policy is reported at
 * `server_policy` so the existing precedence rule — a visible policy value is
 * never silently shadowed — keeps working unchanged.
 */
function layersFor(setting: EffectiveSetting): SettingLayer[] {
  const layers: SettingLayer[] = [];
  const account = setting.overrides["account"];
  if (account?.configured) {
    layers.push({ scope: "global", source: "aether cloud (account)", value: account.value });
  }
  const project = setting.overrides["project"];
  if (project?.configured) {
    layers.push({ scope: "project", source: "aether cloud (project)", value: project.value });
  }
  if (setting.locked || setting.sourceScope === "policy") {
    layers.push({
      scope: "server_policy",
      source: setting.policyRef ?? "aether cloud policy",
      value: setting.effectiveValue,
    });
  }
  return layers;
}

export function cloudSettingDefinition(
  options: CloudSettingOptions,
): SettingDefinition<SettingValue> {
  const { canonicalKey, deps } = options;
  const definition = requireCanonicalSetting(canonicalKey);
  if (definition.persistence !== "server") {
    throw new AetherSettingsError(
      "AETHER_SETTINGS_SCOPE_INVALID",
      `${canonicalKey} is a device setting and has no Cloud adapter`,
      { keys: [canonicalKey] },
    );
  }

  const scopes: SettingScope[] = ["default"];
  if (definition.allowedScopes.includes("account")) scopes.push("global");
  if (definition.allowedScopes.includes("project")) scopes.push("project");
  if (definition.managedPolicy) scopes.push("server_policy");

  const projectId = (): string | null => deps.projectId?.() ?? null;

  async function readEffective(): Promise<EffectiveSettingsResponse> {
    const id = projectId();
    return deps.client.effective(id ? { projectId: id } : {});
  }

  function expectedRevisionFor(
    effective: EffectiveSettingsResponse,
    cloudScope: "account" | "project",
  ): number {
    const setting = effective.settings[canonicalKey];
    // An unconfigured key is revision 0 by the contract, which is exactly what
    // the server expects for a first write.
    return setting?.overrides[cloudScope]?.revision ?? 0;
  }

  return {
    id: options.id,
    section: options.section,
    label: options.label,
    description: options.description,
    valueType: options.valueType,
    scopes,
    ...(options.confirmation ? { confirmation: options.confirmation } : {}),

    async read(): Promise<SettingReadResult> {
      let effective: EffectiveSettingsResponse;
      try {
        effective = await readEffective();
      } catch (error) {
        const settingsError =
          error instanceof AetherSettingsError
            ? error
            : new AetherSettingsError("AETHER_SETTINGS_BACKEND_ERROR", "settings read failed");
        // Cloud did not answer. Report NO layer: an account value this machine
        // happens to remember is not authoritative, and offering it as one is
        // precisely the drift this lane removes. The legacy value is still
        // surfaced, clearly marked, so the user can see it.
        const legacy = (await deps.legacy?.()) ?? null;
        return {
          layers: [],
          health: healthFor(settingsError),
          extensions: {
            canonicalKey,
            cloudAuthoritative: true,
            ...(legacy
              ? {
                  legacyLocalValue: legacy.value,
                  legacyLocalSource: legacy.source,
                  legacyLocalIsAuthoritative: false,
                }
              : {}),
          },
        };
      }

      const setting = effective.settings[canonicalKey];
      const legacy = (await deps.legacy?.()) ?? null;
      return {
        layers: setting ? layersFor(setting) : [],
        health: { state: "verified", summary: "aether cloud" },
        extensions: {
          canonicalKey,
          cloudAuthoritative: true,
          ...(setting
            ? {
                cloudRevision: setting.revision,
                cloudSourceScope: setting.sourceScope,
                ...(setting.managed ? { managed: true } : {}),
                ...(setting.locked ? { locked: true } : {}),
                ...(setting.reason ? { policyReason: setting.reason } : {}),
              }
            : {}),
          ...(legacy
            ? {
                legacyLocalValue: legacy.value,
                legacyLocalSource: legacy.source,
                legacyLocalIsAuthoritative: false,
              }
            : {}),
        },
      };
    },

    validate(value: unknown): ValidationResult<SettingValue> {
      try {
        const models = deps.availableModels?.();
        return {
          ok: true,
          value: validateCanonicalValue(
            canonicalKey,
            value,
            models ? { availableModels: models } : {},
          ),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid value";
        const code =
          error instanceof AetherSettingsError ? error.code : "AETHER_SETTINGS_VALUE_INVALID";
        return { ok: false, issues: [{ code, message }] };
      }
    },

    /** Read-only: capture the revision this change is based on. */
    async plan(
      change: SettingChange<SettingValue>,
      context: SettingPlanContext,
    ): Promise<CloudPlan> {
      const cloudScope = cloudScopeFor(change.scope);
      const id = cloudScope === "project" ? projectId() : null;
      if (cloudScope === "project" && !id) {
        throw new AetherSettingsError(
          "AETHER_SETTINGS_PROJECT_NOT_FOUND",
          "a project-scoped setting needs a selected project",
          { keys: [canonicalKey] },
        );
      }
      context.signal.throwIfAborted();
      const effective = await readEffective();
      const expectedRevision = expectedRevisionFor(effective, cloudScope);
      const after = change.afterAtScope;
      return {
        canonicalKey,
        cloudScope,
        projectId: id,
        operation: change.operation,
        ...(change.operation === "set" && after ? { value: after.value } : {}),
        expectedRevision,
      };
    },

    async apply(
      plan: unknown,
      context?: SettingsOperationContext,
    ): Promise<AdapterApplyResult> {
      const command = plan as CloudPlan;
      try {
        context?.signal.throwIfAborted();
        const models = deps.availableModels?.();
        const previous = await readEffective();
        const before = previous.settings[command.canonicalKey]?.overrides[command.cloudScope];
        const response =
          command.operation === "set"
            ? await deps.client.patch(command.cloudScope, {
                values: { [command.canonicalKey]: command.value },
                expectedRevisions: { [command.canonicalKey]: command.expectedRevision },
                ...(command.projectId ? { projectId: command.projectId } : {}),
                ...(models ? { availableModels: models } : {}),
              })
            : await deps.client.reset(command.cloudScope, {
                keys: [command.canonicalKey],
                expectedRevisions: { [command.canonicalKey]: command.expectedRevision },
                ...(command.projectId ? { projectId: command.projectId } : {}),
              });

        const revision = response.revisions[command.canonicalKey] ?? command.expectedRevision;
        const rollbackToken: CloudRollbackToken = {
          canonicalKey: command.canonicalKey,
          cloudScope: command.cloudScope,
          projectId: command.projectId,
          revision,
          ...(before?.configured ? { previousValue: before.value as SettingValue } : {}),
        };
        return {
          ok: true,
          receipt: {
            rollbackToken,
            summary: response.duplicate
              ? `aether cloud replayed an identical ${command.cloudScope} write`
              : `aether cloud ${command.cloudScope} revision ${revision}`,
            extensions: { canonicalKey: command.canonicalKey, revision },
          },
        };
      } catch (error) {
        // The message is the stable public code, never the value that failed.
        const code =
          error instanceof AetherSettingsError ? error.code : "AETHER_SETTINGS_BACKEND_ERROR";
        return { ok: false, error: code };
      }
    },

    /**
     * Undo one applied write.
     *
     * The rollback carries the revision the write PRODUCED, so if anything else
     * changed the key in between, the server refuses it rather than reverting a
     * value the user never asked to lose.
     */
    async rollback(
      receipt: AdapterApplyReceipt,
      context?: SettingsOperationContext,
    ): Promise<void> {
      const token = receipt.rollbackToken as CloudRollbackToken | undefined;
      if (!token) return;
      context?.signal.throwIfAborted();
      const expectedRevisions = { [token.canonicalKey]: token.revision };
      const scoped = token.projectId ? { projectId: token.projectId } : {};
      if (token.previousValue === undefined) {
        await deps.client.reset(token.cloudScope, {
          keys: [token.canonicalKey],
          expectedRevisions,
          ...scoped,
        });
        return;
      }
      await deps.client.patch(token.cloudScope, {
        values: { [token.canonicalKey]: token.previousValue },
        expectedRevisions,
        ...scoped,
      });
    },

    async doctor(): Promise<SettingHealth> {
      try {
        await readEffective();
        return { state: "verified", summary: "aether cloud reachable" };
      } catch (error) {
        return healthFor(
          error instanceof AetherSettingsError
            ? error
            : new AetherSettingsError("AETHER_SETTINGS_BACKEND_ERROR", "unreachable"),
        );
      }
    },
  };
}
