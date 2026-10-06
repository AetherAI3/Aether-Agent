// Truthful settings-domain composition. This file adapts current Agent
// authorities; it does not create server features, runner controls, or a
// second copy of a domain store.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { AetherCiSettingsFile, registerAetherCiSettings } from "./aether_ci_settings.js";
import type { AppContext } from "./context.js";
import { configPath, DEFAULT_CONFIG, saveConfig } from "./config.js";
import { isLocalModelId, localModelId, normalizeOllamaTag, ollamaTagFromId } from "./local_ollama.js";
import { DEFAULT_OLLAMA_HOST, normalizeOllamaHost } from "./ollama.js";
import { LocalMcpStore, type McpStoreInspection } from "./mcp_store.js";
import { discoverSkills } from "./skills/skill_discovery.js";
import {
  loadSkillSettings,
  lookupSkillSetting,
  saveSkillSetting,
  type SkillSetting,
  type SkillSettingsStore,
} from "./skills/skill_settings.js";
import type { SkillDescriptor, SkillIndex } from "./skills/skill_types.js";
import type { TerminalCapabilities } from "./terminal_capabilities.js";
import { detectTerminalCapabilities } from "./terminal_capabilities.js";
import type { AetherConfig } from "../types.js";
import { EFFORT_TIERS, normalizeEffort } from "../ui/effort.js";
import {
  SettingsRegistry,
  booleanValidator,
  enumValidator,
  finiteNumberValidator,
  stringValidator,
  type AdapterApplyResult,
  type ConfirmationMetadata,
  type SettingDefinition,
  type SettingHealth,
  type SettingLayer,
  type SettingPlanContext,
  type SettingScope,
  type SettingValue,
  type SettingValueType,
  type ValidationResult,
  type WritableSettingScope,
} from "./settings_registry.js";
import {
  VersionedSettingsStore,
  type SettingsStoreApplyReceipt,
  type SettingsStoreInspection,
  type SettingsStorePlan,
  type SettingsStoreRollbackToken,
} from "./settings_store.js";
import {
  DEFAULT_VOICE_SETTINGS,
  type VoiceInteractionMode,
  type VoiceLocalFallback,
  type VoiceProfile,
} from "./voice.js";

export const VOICE_SETTINGS_PREREQUISITE =
  "a terminal capture/playback adapter and Voice command wiring that consume this settings store";
export const ONLINE_SETTINGS_PREREQUISITE =
  "an authenticated /online/projects/{project_id}/context adapter and canonical project id";
export const ACTIONS_RUNNER_PREREQUISITE =
  "a published non-Electron Actions local-service/CLI contract or shared runner package";
export const ACTIONS_CI_PREREQUISITE =
  "canonical JSON-subset .aether-ci.yml v1 accepted by the pinned AETHER-CLOUD parser contract";
export const ADAPTIVE_CONTEXT_PREREQUISITE =
  "a bounded compaction/retrieval/persistence runtime contract consumed by Agent turns";

export interface AgentConfigPort {
  readonly source?: string;
  exists(): boolean;
  /** Must return the file value before env precedence, when available. */
  readPersisted?(): AetherConfig | undefined;
  save(config: AetherConfig): void;
}

export interface SkillSettingsPort {
  load(): SkillSettingsStore;
  save(setting: SkillSetting): void;
}

export interface VoiceSettingsRuntime {
  /** Assertion by the runtime owner that turns actually read VersionedSettingsStore. */
  readonly consumesStore: true;
  doctor?(): Promise<SettingHealth>;
}

export interface ServiceSettingsSnapshot {
  readonly value: "available" | "unavailable" | "degraded" | "unknown";
  readonly health: SettingHealth;
  readonly source: string;
  readonly projectId?: string;
}

export interface OllamaSettingsSnapshot {
  readonly health: SettingHealth;
  readonly version?: string;
  readonly installedModels?: readonly string[];
}

export interface AgentSettingsAdapterDependencies {
  readonly store: VersionedSettingsStore;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly terminalCapabilities?: TerminalCapabilities;
  readonly config?: AgentConfigPort;
  readonly mcpStore?: Pick<LocalMcpStore, "inspect" | "filePath">;
  readonly skillIndex?: SkillIndex;
  readonly skillSettings?: SkillSettingsPort;
  readonly voiceRuntime?: VoiceSettingsRuntime;
  readonly ollamaDoctor?: () => Promise<OllamaSettingsSnapshot>;
  readonly onlineDoctor?: () => Promise<ServiceSettingsSnapshot>;
  readonly actionsDoctor?: () => Promise<ServiceSettingsSnapshot>;
  readonly ciConfigPath?: string;
}

interface ConfigPlan<T extends SettingValue> {
  readonly kind: "legacy_config";
  readonly id: string;
  readonly next: T;
}

interface ConfigRollbackToken {
  readonly kind: "legacy_config";
  readonly previous: AetherConfig;
}

interface StoreAdapterRollbackToken {
  readonly kind: "settings_store_apply";
  readonly required: boolean;
  readonly token: SettingsStoreRollbackToken;
}

interface ConfigSpec<T extends SettingValue> {
  readonly id: string;
  readonly section: string;
  readonly label: string;
  readonly description: string;
  readonly valueType: SettingValueType;
  readonly defaultValue: T;
  readonly envName?: string;
  readonly scopes?: readonly SettingScope[];
  readonly requiresRestart?: boolean;
  readonly confirmation?: SettingDefinition<T>["confirmation"];
  readonly get: (config: AetherConfig) => T;
  readonly set: (config: AetherConfig, value: T) => void;
  readonly validate: (value: unknown) => ValidationResult<T>;
}

interface SkillPlan {
  readonly kind: "skill_setting";
  readonly projectRoot: string;
  readonly skillId: string;
  readonly field: "enabled" | "automatic";
  readonly value: boolean;
}

interface SkillRollbackToken {
  readonly kind: "skill_setting";
  readonly projectRoot: string;
  readonly skillId: string;
  readonly previous: SkillSetting | null;
}

function failure(code: string, message: string): ValidationResult<never> {
  return { ok: false, issues: [{ code, message }] };
}

function webUrlValidator(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") return failure("type.string", "expected a URL string");
  try {
    const url = new URL(value);
    if (url.username || url.password) return failure("url.credentials", "URL must not embed credentials");
    if (url.protocol === "https:") return { ok: true, value: url.toString().replace(/\/$/, "") };
    if (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""))) {
      return { ok: true, value: url.toString().replace(/\/$/, "") };
    }
    return failure("url.scheme", "remote URLs require https; http is allowed only for loopback");
  } catch {
    return failure("url.invalid", "expected a valid URL");
  }
}

function hostedModelValidator(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") return failure("type.string", "expected a hosted model id");
  const model = value.trim();
  if (isLocalModelId(model)) {
    return failure("model.local_namespace", "hosted model must not use the ollama/ namespace");
  }
  if (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
    return failure("model.invalid", "hosted model id is invalid");
  }
  return { ok: true, value: model };
}

function localModelValidator(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") return failure("type.string", "expected an Ollama model id");
  if (!value.trim()) return { ok: true, value: "" };
  const raw = isLocalModelId(value) ? ollamaTagFromId(value) ?? "" : value;
  try {
    return { ok: true, value: localModelId(normalizeOllamaTag(raw)) };
  } catch (error) {
    return failure("ollama.model", error instanceof Error ? error.message : "invalid Ollama model id");
  }
}

function effortValidator(value: unknown): ValidationResult<string> {
  if (value === "") return { ok: true, value: "" };
  if (typeof value !== "string") return failure("type.enum", "expected an effort tier");
  const effort = normalizeEffort(value);
  return effort
    ? { ok: true, value: effort }
    : failure("effort.invalid", `expected one of ${EFFORT_TIERS.join(", ")} or an empty value`);
}

function cloneConfig(config: AetherConfig): AetherConfig {
  return {
    ...config,
    ...(config.deviceRuntime ? { deviceRuntime: { ...config.deviceRuntime } } : {}),
  };
}

function isConfigPlan<T extends SettingValue>(value: unknown, id: string): value is ConfigPlan<T> {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)["kind"] === "legacy_config" &&
    (value as Record<string, unknown>)["id"] === id;
}

function isConfigRollback(value: unknown): value is ConfigRollbackToken {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)["kind"] === "legacy_config" &&
    typeof (value as Record<string, unknown>)["previous"] === "object";
}

function configDefinition<T extends SettingValue>(
  ctx: Pick<AppContext, "cfg">,
  env: Readonly<Record<string, string | undefined>>,
  port: AgentConfigPort,
  spec: ConfigSpec<T>,
): SettingDefinition<T> {
  return {
    id: spec.id,
    section: spec.section,
    label: spec.label,
    description: spec.description,
    valueType: spec.valueType,
    scopes: spec.scopes ?? ["default", "global", ...(spec.envName ? ["env" as const] : [])],
    ...(spec.requiresRestart === undefined ? {} : { requiresRestart: spec.requiresRestart }),
    ...(spec.confirmation === undefined ? {} : { confirmation: spec.confirmation }),
    async read() {
      const layers: SettingLayer[] = [{ scope: "default", source: "Agent built-in default", value: spec.defaultValue }];
      const envValue = spec.envName ? env[spec.envName] : undefined;
      if (port.exists()) {
        const persisted = port.readPersisted?.();
        // ctx.cfg.baseUrl may already contain the env override. Do not relabel
        // that value as global when the pre-env file value is unavailable.
        if (persisted) layers.push({ scope: "global", source: port.source ?? configPath(), value: spec.get(persisted) });
        else if (envValue === undefined) layers.push({ scope: "global", source: port.source ?? configPath(), value: spec.get(ctx.cfg) });
      }
      if (envValue !== undefined) layers.push({ scope: "env", source: spec.envName as string, value: envValue });
      return {
        layers,
        health: port.exists()
          ? { state: "unknown", summary: "loaded through legacy config API; file integrity was not independently verified" }
          : { state: "unconfigured", summary: "using Agent built-in default" },
      };
    },
    validate: spec.validate,
    async plan(change) {
      let next: T;
      if (change.operation === "set") {
        if (change.afterAtScope?.state !== "known") throw new Error("validated config value is missing");
        next = change.afterAtScope.value;
      } else {
        next = spec.defaultValue;
      }
      return { kind: "legacy_config", id: spec.id, next } satisfies ConfigPlan<T>;
    },
    async apply(plan): Promise<AdapterApplyResult> {
      if (!isConfigPlan<T>(plan, spec.id)) return { ok: false, error: "invalid legacy config plan" };
      const previous = cloneConfig(ctx.cfg);
      const next = cloneConfig(ctx.cfg);
      spec.set(next, plan.next);
      try {
        port.save(next);
        spec.set(ctx.cfg, plan.next);
        return {
          ok: true,
          receipt: {
            rollbackToken: { kind: "legacy_config", previous } satisfies ConfigRollbackToken,
            summary: `saved ${spec.id} through the existing Agent config authority`,
          },
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "legacy config write failed" };
      }
    },
    async rollback(receipt) {
      if (!isConfigRollback(receipt.rollbackToken)) throw new Error("invalid legacy config rollback receipt");
      port.save(receipt.rollbackToken.previous);
      Object.assign(ctx.cfg, cloneConfig(receipt.rollbackToken.previous));
    },
    async doctor() {
      return port.exists()
        ? { state: "unknown", summary: "legacy config exists; use aether config for current compatibility checks" }
        : { state: "unconfigured", summary: "legacy config file is absent" };
    },
  };
}

function fixedDefinition<T extends SettingValue>(args: {
  id: string;
  section: string;
  label: string;
  description: string;
  valueType: SettingValueType;
  scopes: readonly SettingScope[];
  validate: (value: unknown) => ValidationResult<T>;
  read: () => Promise<{ layers: readonly SettingLayer[]; health: SettingHealth }>;
}): SettingDefinition<T> {
  return {
    ...args,
    async read() { return await args.read(); },
    async plan() { throw new Error(`${args.id} is read-only`); },
    async apply() { return { ok: false, error: `${args.id} is read-only` }; },
    async doctor() { return (await args.read()).health; },
  };
}

function storeHealth(inspections: readonly SettingsStoreInspection[]): SettingHealth {
  const bad = inspections.find((inspection) => inspection.status !== "ok" && inspection.status !== "missing");
  if (bad) {
    return {
      state: bad.status === "unreadable" ? "unavailable" : "degraded",
      summary: `${bad.scope} settings are ${bad.status}: ${bad.detail ?? "repair required"}`,
    };
  }
  return inspections.some((inspection) => inspection.status === "ok")
    ? { state: "configured", summary: "scoped settings parsed; runtime health not checked" }
    : { state: "unconfigured", summary: "using built-in defaults" };
}

function isStorePlan(value: unknown): value is SettingsStorePlan {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)["schemaVersion"] === 1 &&
    typeof (value as Record<string, unknown>)["settingId"] === "string";
}

function isStoreRollback(value: unknown): value is StoreAdapterRollbackToken {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)["kind"] === "settings_store_apply" &&
    typeof (value as Record<string, unknown>)["required"] === "boolean" &&
    typeof (value as Record<string, unknown>)["token"] === "object";
}

function storeDefinition<T extends SettingValue>(args: {
  store: VersionedSettingsStore;
  id: string;
  section: string;
  label: string;
  description: string;
  valueType: SettingValueType;
  defaultValue: T;
  validate: (value: unknown) => ValidationResult<T>;
  requiresRestart?: boolean;
  confirmation?: SettingDefinition<T>["confirmation"];
  runtimeDoctor?: () => Promise<SettingHealth>;
}): SettingDefinition<T> {
  return {
    id: args.id,
    section: args.section,
    label: args.label,
    description: args.description,
    valueType: args.valueType,
    scopes: ["default", "global", "project", "session"],
    ...(args.requiresRestart === undefined ? {} : { requiresRestart: args.requiresRestart }),
    ...(args.confirmation === undefined ? {} : { confirmation: args.confirmation }),
    async read() {
      const current = args.store.read(args.id);
      const health = storeHealth(current.inspections);
      const invalidStoreLayers: SettingLayer[] = current.inspections
        .filter((inspection) => inspection.status !== "ok" && inspection.status !== "missing")
        .map((inspection) => ({
          scope: inspection.scope,
          source: inspection.path,
          // This intentionally cannot validate as any supported leaf type. It
          // preserves the bad scope in precedence so a corrupt higher layer is
          // unknown, never silently replaced by a healthy-looking default.
          value: { settings_store_status: inspection.status },
        }));
      return {
        layers: [
          { scope: "default", source: "Agent built-in default", value: args.defaultValue },
          ...current.layers,
          ...invalidStoreLayers,
        ],
        health: health.state === "configured" && args.runtimeDoctor
          ? await args.runtimeDoctor()
          : health,
      };
    },
    validate: args.validate,
    async plan(change, context: SettingPlanContext) {
      const value = change.operation === "set" ? change.afterAtScope?.value : undefined;
      return args.store.plan(change.scope, change.operation, args.id, args.valueType, value, context.batchKey);
    },
    async apply(plan): Promise<AdapterApplyResult> {
      if (!isStorePlan(plan) || plan.settingId !== args.id) {
        return { ok: false, error: "invalid scoped settings plan" };
      }
      try {
        const receipt: SettingsStoreApplyReceipt = args.store.apply(plan);
        return {
          ok: true,
          receipt: {
            summary: receipt.summary,
            rollbackToken: {
              kind: "settings_store_apply",
              required: receipt.performedWrite,
              token: receipt.rollbackToken,
            } satisfies StoreAdapterRollbackToken,
          },
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "scoped settings write failed" };
      }
    },
    async rollback(receipt) {
      if (!isStoreRollback(receipt.rollbackToken)) throw new Error("invalid scoped settings rollback receipt");
      if (receipt.rollbackToken.required) args.store.rollback(receipt.rollbackToken.token);
    },
    async doctor() {
      const health = storeHealth(args.store.read(args.id).inspections);
      return health.state === "configured" && args.runtimeDoctor
        ? await args.runtimeDoctor()
        : health;
    },
  };
}

function mcpHealth(inspection: McpStoreInspection): SettingHealth {
  switch (inspection.status) {
    case "missing": return { state: "unconfigured", summary: "local MCP registry is absent" };
    case "ok": return { state: "configured", summary: "registry parsed; endpoints were not probed" };
    case "corrupt": return { state: "degraded", summary: "MCP registry is corrupt; run aether mcp repair" };
    case "unreadable": return { state: "unavailable", summary: "MCP registry cannot be read" };
  }
}

function skillKey(descriptor: SkillDescriptor, field: "enabled" | "automatic"): string {
  return `skills.${descriptor.id.replace("/", ".")}.${field}`;
}

function skillDefault(descriptor: SkillDescriptor, field: "enabled" | "automatic"): boolean {
  if (field === "enabled") return true;
  return descriptor.scope === "builtin" && descriptor.manifest.triggers.automatic;
}

function skillDefinition(
  descriptor: SkillDescriptor,
  field: "enabled" | "automatic",
  port: SkillSettingsPort,
  projectRoot: string,
): SettingDefinition<boolean> {
  const settingsRoot = descriptor.scope === "project" ? projectRoot : "*";
  const valueScope: WritableSettingScope = descriptor.scope === "project" ? "project" : "global";
  const id = skillKey(descriptor, field);
  const defaultValue = skillDefault(descriptor, field);
  const health = (): SettingHealth => {
    if (descriptor.trust === "changed") return { state: "degraded", summary: "skill digest changed; trust review required" };
    if (descriptor.trust === "untrusted") return { state: "degraded", summary: "project skill is not trusted" };
    return { state: "configured", summary: `discovered ${descriptor.id}@${descriptor.version}; digest verified locally` };
  };
  return {
    id,
    section: "Skills",
    label: `${descriptor.name} ${field}`,
    description:
      `${descriptor.description} Source=${descriptor.scope}; version=${descriptor.version}; digest=${descriptor.sha256}; ` +
      `trust=${descriptor.trust}; tools=${descriptor.manifest.tools.allowed.join(",") || "none"}.`,
    valueType: "boolean",
    scopes: ["default", valueScope, ...(field === "automatic" ? ["server_policy" as const] : [])],
    async read() {
      const record = lookupSkillSetting(port.load(), settingsRoot, descriptor.id);
      const layers: SettingLayer[] = [
        { scope: "default", source: `${descriptor.scope} manifest/default`, value: defaultValue },
      ];
      if (record) layers.push({ scope: valueScope, source: "canonical skill-settings.json", value: record[field] });
      if (field === "automatic" && descriptor.scope === "project" && descriptor.trust !== "trusted") {
        layers.push({ scope: "server_policy", source: `skill trust=${descriptor.trust}`, value: false });
      }
      return { layers, health: health() };
    },
    validate: booleanValidator,
    async plan(change) {
      if (change.operation === "unset") {
        return { kind: "skill_setting", projectRoot: settingsRoot, skillId: descriptor.id, field, value: defaultValue } satisfies SkillPlan;
      }
      if (change.afterAtScope?.state !== "known") throw new Error("validated skill setting is missing");
      return {
        kind: "skill_setting",
        projectRoot: settingsRoot,
        skillId: descriptor.id,
        field,
        value: change.afterAtScope.value,
      } satisfies SkillPlan;
    },
    async apply(plan): Promise<AdapterApplyResult> {
      if (!isSkillPlan(plan, descriptor.id, field)) return { ok: false, error: "invalid skill settings plan" };
      const previous = lookupSkillSetting(port.load(), settingsRoot, descriptor.id) ?? null;
      const current: SkillSetting = previous ?? {
        projectRoot: settingsRoot,
        skillId: descriptor.id,
        enabled: true,
        automatic: false,
      };
      try {
        port.save({ ...current, [field]: plan.value });
        return {
          ok: true,
          receipt: {
            rollbackToken: {
              kind: "skill_setting",
              projectRoot: settingsRoot,
              skillId: descriptor.id,
              previous,
            } satisfies SkillRollbackToken,
            summary: `saved ${descriptor.id} ${field} through canonical skill settings`,
          },
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "skill settings write failed" };
      }
    },
    async rollback(receipt) {
      if (!isSkillRollback(receipt.rollbackToken, descriptor.id)) throw new Error("invalid skill rollback receipt");
      port.save(receipt.rollbackToken.previous ?? {
        projectRoot: settingsRoot,
        skillId: descriptor.id,
        enabled: true,
        automatic: false,
      });
    },
    async doctor() { return health(); },
  };
}

function isSkillPlan(value: unknown, id: string, field: string): value is SkillPlan {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)["kind"] === "skill_setting" &&
    (value as Record<string, unknown>)["skillId"] === id &&
    (value as Record<string, unknown>)["field"] === field &&
    typeof (value as Record<string, unknown>)["value"] === "boolean";
}

function isSkillRollback(value: unknown, id: string): value is SkillRollbackToken {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)["kind"] === "skill_setting" &&
    (value as Record<string, unknown>)["skillId"] === id;
}

function statusValue(
  id: string,
  section: string,
  label: string,
  description: string,
  value: string,
  health: SettingHealth,
  source = "Agent capability audit",
): SettingDefinition<string> {
  return fixedDefinition({
    id,
    section,
    label,
    description,
    valueType: "string",
    scopes: ["default"],
    validate: stringValidator,
    read: async () => ({ layers: [{ scope: "default", source, value }], health }),
  });
}

function registerConfigSettings(
  registry: SettingsRegistry,
  ctx: Pick<AppContext, "cfg">,
  env: Readonly<Record<string, string | undefined>>,
  port: AgentConfigPort,
): void {
  const costConfirmation: ConfirmationMetadata = {
    impact: "cost_sensitive",
    phrase: "APPLY HOSTED COST SETTING",
    reason: "hosted model effort can change UVT usage",
    approvalFlag: "--approve cost",
  };
  const destructiveConfirmation: ConfirmationMetadata = {
    impact: "destructive",
    phrase: "ENABLE AUTOMATIC EDITS",
    reason: "automatic apply can write workspace files without a per-edit prompt",
    approvalFlag: "--approve destructive",
  };
  registry.register(configDefinition(ctx, env, port, {
    id: "agent.api_base_url", section: "Agent", label: "Aether API URL",
    description: "Existing Agent API front door. AETHER_BASE_URL remains a visible read-only override.",
    valueType: "string", defaultValue: DEFAULT_CONFIG.baseUrl, envName: "AETHER_BASE_URL",
    get: (config) => config.baseUrl, set: (config, value) => { config.baseUrl = value; }, validate: webUrlValidator,
  }));
  registry.register(configDefinition(ctx, env, port, {
    id: "agent.telemetry", section: "Agent", label: "Anonymous telemetry",
    description: "Existing Agent anonymous telemetry opt-in.", valueType: "boolean",
    defaultValue: DEFAULT_CONFIG.telemetry, get: (config) => config.telemetry,
    set: (config, value) => { config.telemetry = value; }, validate: booleanValidator,
  }));
  registry.register(configDefinition(ctx, env, port, {
    id: "code.hosted_model", section: "Aether Code", label: "Hosted model",
    description: "Hosted model id; local Ollama ids cannot enter this slot.", valueType: "string",
    defaultValue: DEFAULT_CONFIG.defaultModel, get: (config) => config.defaultModel,
    set: (config, value) => { config.defaultModel = value; }, validate: hostedModelValidator,
    confirmation: costConfirmation,
  }));
  registry.register(configDefinition(ctx, env, port, {
    id: "code.effort", section: "Aether Code", label: "Default effort",
    description: "Closed Aether Code effort tier; empty delegates to the server default.", valueType: "enum",
    defaultValue: DEFAULT_CONFIG.defaultEffort, get: (config) => config.defaultEffort,
    set: (config, value) => { config.defaultEffort = value; }, validate: effortValidator,
    confirmation: costConfirmation,
  }));
  registry.register(configDefinition(ctx, env, port, {
    id: "code.backend", section: "Aether Code", label: "Backend preference",
    description: "Existing explicit auto/local/cloud route. AETHER_BACKEND remains a visible read-only override.",
    valueType: "enum", defaultValue: DEFAULT_CONFIG.backend, envName: "AETHER_BACKEND",
    get: (config) => config.backend, set: (config, value) => { config.backend = value; },
    validate: enumValidator(["auto", "local", "cloud"] as const),
    confirmation: (change) => change.afterAtScope?.state === "known" && change.afterAtScope.value === "cloud"
      ? costConfirmation
      : undefined,
  }));
  registry.register(configDefinition(ctx, env, port, {
    id: "code.permission_mode", section: "Aether Code", label: "Permission mode",
    description: "Existing ask/auto/skip permission gate; this setting cannot widen the session authority envelope.",
    valueType: "enum", defaultValue: DEFAULT_CONFIG.permissionMode,
    get: (config) => config.permissionMode, set: (config, value) => { config.permissionMode = value; },
    validate: enumValidator(["ask", "auto", "skip"] as const),
    confirmation: (change) => change.afterAtScope?.state === "known" && change.afterAtScope.value === "skip"
      ? { impact: "destructive", phrase: "ALLOW SKIP PERMISSIONS", reason: "removes per-tool confirmation within the existing envelope" }
      : undefined,
  }));
  registry.register(configDefinition(ctx, env, port, {
    id: "code.auto_apply", section: "Aether Code", label: "Automatic edit apply",
    description: "Existing autoApply behavior. Enabling requires an explicit destructive approval phrase.",
    valueType: "boolean", defaultValue: DEFAULT_CONFIG.autoApply,
    get: (config) => config.autoApply, set: (config, value) => { config.autoApply = value; },
    validate: booleanValidator,
    confirmation: (change) => change.afterAtScope?.state === "known" && change.afterAtScope.value
      ? destructiveConfirmation
      : undefined,
  }));
  registry.register(configDefinition(ctx, env, port, {
    id: "ollama.selected_model", section: "Ollama", label: "Selected local model",
    description: "Existing namespaced localModel slot. Selecting a model never pulls it or changes the backend.",
    valueType: "string", defaultValue: DEFAULT_CONFIG.localModel ?? "",
    get: (config) => config.localModel ?? "", set: (config, value) => { config.localModel = value; },
    validate: localModelValidator,
  }));
}

function registerStoreStatus(registry: SettingsRegistry, store: VersionedSettingsStore): void {
  for (const scope of ["global", "project", "session"] as const) {
    registry.register(fixedDefinition({
      id: `settings.${scope}_store`,
      section: "Settings",
      label: `${scope} settings store`,
      description: "Versioned scoped store status; corruption remains visible and is never replaced by defaults.",
      valueType: "string",
      scopes: ["default"],
      validate: stringValidator,
      read: async () => {
        const inspection = store.inspect(scope);
        return {
          layers: [{ scope: "default", source: inspection.path, value: inspection.status }],
          health: storeHealth([inspection]),
        };
      },
    }));
  }
}

function registerVoice(
  registry: SettingsRegistry,
  deps: AgentSettingsAdapterDependencies,
  capabilities: TerminalCapabilities,
): void {
  const functional = deps.voiceRuntime?.consumesStore === true && capabilities.audioInput;
  registry.register(statusValue(
    "voice.availability", "Voice", "Voice availability",
    "Voice is writable only when a proven terminal host adapter consumes the scoped settings store.",
    functional ? "available" : "unavailable",
    functional
      ? { state: "configured", summary: "terminal capture and store-consuming Voice runtime were injected" }
      : { state: "unavailable", summary: `requires ${VOICE_SETTINGS_PREREQUISITE}` },
  ));
  if (!functional || !deps.voiceRuntime) return;
  const doctor = deps.voiceRuntime.doctor;
  const runtimeDoctor = doctor ? async (): Promise<SettingHealth> => await doctor() : undefined;
  const common = { store: deps.store, section: "Voice", ...(runtimeDoctor ? { runtimeDoctor } : {}) };
  registry.register(storeDefinition({
    ...common, id: "voice.enabled", label: "Voice enabled",
    description: "Enables the shared Voice lifecycle; Cloud remains authoritative for STT/TTS billing.",
    valueType: "boolean", defaultValue: DEFAULT_VOICE_SETTINGS.enabled, validate: booleanValidator,
    confirmation: (change) => change.afterAtScope?.state === "known" && change.afterAtScope.value
      ? { impact: "cost_sensitive", phrase: "ENABLE VOICE BILLING", reason: "final STT and remote TTS may consume UVT" }
      : undefined,
  }));
  registry.register(storeDefinition<VoiceInteractionMode>({
    ...common, id: "voice.interaction_mode", label: "Interaction mode",
    description: "Push-to-talk, toggle-to-talk, or conversation mode supported by the Voice state machine.",
    valueType: "enum", defaultValue: DEFAULT_VOICE_SETTINGS.interactionMode,
    validate: enumValidator(["push-to-talk", "toggle-to-talk", "conversation"] as const),
  }));
  registry.register(storeDefinition({
    ...common, id: "voice.hotkey", label: "Voice hotkey",
    description: "Bounded terminal gesture label; host key-release capability determines hold versus toggle semantics.",
    valueType: "string", defaultValue: DEFAULT_VOICE_SETTINGS.hotkey,
    validate: (value) => typeof value === "string" && value.trim() && value.length <= 64
      ? { ok: true, value: value.trim() }
      : failure("voice.hotkey", "hotkey must be a non-empty string of at most 64 characters"),
  }));
  registry.register(storeDefinition<VoiceProfile>({
    ...common, id: "voice.profile", label: "Voice profile",
    description: "Aether voice profile; provider/model routing remains server-owned.", valueType: "enum",
    defaultValue: DEFAULT_VOICE_SETTINGS.voiceProfile,
    validate: enumValidator(["auto", "clear", "warm", "bright"] as const),
  }));
  if (capabilities.audioOutput) {
    registry.register(storeDefinition({
      ...common, id: "voice.speech_output", label: "Speech output",
      description: "Plays ordered synthesized speech through the proven host playback adapter.",
      valueType: "boolean", defaultValue: DEFAULT_VOICE_SETTINGS.speechOutput, validate: booleanValidator,
    }));
    registry.register(storeDefinition<VoiceLocalFallback>({
      ...common, id: "voice.local_fallback", label: "Local speech fallback",
      description: "System fallback only; it never changes server-side provider routing.", valueType: "enum",
      defaultValue: DEFAULT_VOICE_SETTINGS.localFallback,
      validate: enumValidator(["disabled", "system"] as const),
    }));
  }
  registry.register(storeDefinition({
    ...common, id: "voice.end_of_turn_silence_ms", label: "End-of-turn silence",
    description: "Finite VAD silence window from 400 to 3000 milliseconds.", valueType: "number",
    defaultValue: DEFAULT_VOICE_SETTINGS.endOfTurnSilenceMs,
    validate: (value) => {
      const checked = finiteNumberValidator(value);
      if (!checked.ok) return checked;
      return Number.isInteger(checked.value) && checked.value >= 400 && checked.value <= 3000
        ? checked
        : failure("voice.silence", "end-of-turn silence must be an integer from 400 to 3000 ms");
    },
  }));
}

function registerAppearance(
  registry: SettingsRegistry,
  env: Readonly<Record<string, string | undefined>>,
  capabilities: TerminalCapabilities,
): void {
  const appearance = [
    {
      id: "appearance.color", label: "Color", value: capabilities.color,
      source: env["NO_COLOR"] !== undefined || env["FORCE_COLOR"] === "0" ? "NO_COLOR/FORCE_COLOR" : "terminal capability detection",
    },
    {
      id: "appearance.unicode", label: "Unicode", value: capabilities.unicode,
      source: env["AETHER_ASCII"] === "1" || env["TERM"] === "dumb" ? "AETHER_ASCII/TERM" : "terminal capability detection",
    },
    {
      id: "appearance.animation", label: "Animation", value: env["AETHER_NO_ANIM"] !== "1",
      source: env["AETHER_NO_ANIM"] === "1" ? "AETHER_NO_ANIM" : "Agent default",
    },
  ] as const;
  for (const item of appearance) {
    registry.register(fixedDefinition({
      id: item.id,
      section: "Appearance",
      label: item.label,
      description: "Read-only current runtime fact; persisted appearance controls are not wired in Agent yet.",
      valueType: "boolean",
      scopes: ["default"],
      validate: booleanValidator,
      read: async () => ({
        layers: [{ scope: "default", source: item.source, value: item.value }],
        health: { state: "configured", summary: `effective from ${item.source}` },
      }),
    }));
  }
}

function registerMcp(
  registry: SettingsRegistry,
  store: Pick<LocalMcpStore, "inspect" | "filePath">,
): void {
  registry.register(fixedDefinition({
    id: "mcp.registry_state", section: "MCP", label: "Local MCP registry",
    description: "Canonical local MCP registry state. Server edits remain in aether mcp until the schema supports reversible settings leaves.",
    valueType: "string", scopes: ["default"], validate: stringValidator,
    read: async () => {
      const inspection = store.inspect();
      return { layers: [{ scope: "default", source: store.filePath(), value: inspection.status }], health: mcpHealth(inspection) };
    },
  }));
  registry.register(fixedDefinition({
    id: "mcp.local_server_count", section: "MCP", label: "Local server count",
    description: "Configured server count only; zero never means broker unavailable or endpoints verified.",
    valueType: "number", scopes: ["default"], validate: finiteNumberValidator,
    read: async () => {
      const inspection = store.inspect();
      return {
        layers: [{
          scope: "default",
          source: store.filePath(),
          // A corrupt/unreadable registry has an unknown count. Supplying zero
          // here used to turn failed observation into a false known fact.
          value: inspection.status === "ok" || inspection.status === "missing"
            ? inspection.servers.length
            : { mcp_registry_status: inspection.status },
        }],
        health: mcpHealth(inspection),
      };
    },
  }));
  registry.register(statusValue(
    "mcp.broker_availability", "MCP", "Broker availability",
    "Broker/OAuth status needs authenticated diagnostics and is never inferred from an empty local registry.",
    "unknown",
    { state: "unknown", summary: "run authenticated aether mcp doctor; no broker probe was injected" },
  ));
}

function registerSkills(
  registry: SettingsRegistry,
  index: SkillIndex,
  port: SkillSettingsPort,
  projectRoot: string,
): void {
  registry.register(fixedDefinition({
    id: "skills.catalog_health", section: "Skills", label: "Skill catalog",
    description: "Discovery errors remain visible; catalog status never grants tool or permission authority.",
    valueType: "string", scopes: ["default"], validate: stringValidator,
    read: async () => ({
      layers: [{ scope: "default", source: `skill discovery ${index.generatedAt}`, value: index.errors.length ? "degraded" : "ready" }],
      health: index.errors.length
        ? { state: "degraded", summary: `${index.errors.length} skill discovery error(s)` }
        : { state: "configured", summary: `${index.skills.length} skill(s) discovered; execution not probed` },
    }),
  }));
  for (const descriptor of index.skills) {
    registry.register(skillDefinition(descriptor, "enabled", port, projectRoot));
    // Built-in automatic selection is manifest-owned and ignores the local
    // `automatic` field, so exposing an editor for it would be decorative.
    if (descriptor.scope !== "builtin" && descriptor.manifest.triggers.automatic) {
      registry.register(skillDefinition(descriptor, "automatic", port, projectRoot));
    }
  }
}

function registerOllama(
  registry: SettingsRegistry,
  env: Readonly<Record<string, string | undefined>>,
  doctor: (() => Promise<OllamaSettingsSnapshot>) | undefined,
): void {
  registry.register(fixedDefinition({
    id: "ollama.host", section: "Ollama", label: "Ollama host",
    description: "Current host authority. OLLAMA_HOST is visible but cannot be overwritten locally by settings.",
    valueType: "string", scopes: ["default", "env"], validate: webUrlValidator,
    read: async () => {
      const layers: SettingLayer[] = [{ scope: "default", source: "Ollama default", value: DEFAULT_OLLAMA_HOST }];
      if (env["OLLAMA_HOST"] !== undefined) {
        try {
          layers.push({ scope: "env", source: "OLLAMA_HOST", value: normalizeOllamaHost(env["OLLAMA_HOST"]) });
        } catch {
          layers.push({ scope: "env", source: "OLLAMA_HOST", value: env["OLLAMA_HOST"] });
        }
      }
      const snapshot = doctor ? await doctor() : undefined;
      return {
        layers,
        health: snapshot?.health ?? { state: "unknown", summary: "not probed; run aether local doctor" },
      };
    },
  }));
  registry.register(statusValue(
    "ollama.adaptive_context", "Ollama", "Adaptive Context",
    "A finite model window is not an unlimited session; no decorative num_ctx infinity toggle is exposed.",
    "unavailable",
    { state: "unavailable", summary: `requires ${ADAPTIVE_CONTEXT_PREREQUISITE}` },
  ));
}

function registerRemoteDomains(
  registry: SettingsRegistry,
  deps: AgentSettingsAdapterDependencies,
  cwd: string,
): void {
  registry.register(fixedDefinition({
    id: "online.availability", section: "Aether Online", label: "Online availability",
    description: "Read-only deployment/entitlement state; unavailable is never rendered as an empty project list.",
    valueType: "string", scopes: ["default", "server_policy"], validate: stringValidator,
    read: async () => {
      const snapshot = deps.onlineDoctor ? await deps.onlineDoctor() : undefined;
      return snapshot
        ? { layers: [{ scope: "server_policy", source: snapshot.source, value: snapshot.value }], health: snapshot.health }
        : {
            layers: [{ scope: "default", source: "Agent capability audit", value: "unavailable" }],
            health: { state: "unavailable", summary: `requires ${ONLINE_SETTINGS_PREREQUISITE}` },
          };
    },
  }));
  registry.register(statusValue(
    "code.remote_execution", "Aether Code", "Hosted dev-session controls",
    "Agent has hosted turn streaming but no settings endpoint for Desktop-local editor/dev-session controls.",
    "unavailable",
    { state: "unavailable", summary: "requires a deployed, entitled settings/dev-session endpoint and exact canary" },
  ));

  registry.register(fixedDefinition({
    id: "actions.runner_availability", section: "Aether Actions / CI", label: "Local Actions runner",
    description: "Read-only capability state. Agent never imports Electron IPC or forks the Desktop runner.",
    valueType: "string", scopes: ["default", "server_policy"], validate: stringValidator,
    read: async () => {
      const snapshot = deps.actionsDoctor ? await deps.actionsDoctor() : undefined;
      return snapshot
        ? { layers: [{ scope: "server_policy", source: snapshot.source, value: snapshot.value }], health: snapshot.health }
        : {
            layers: [{ scope: "default", source: "Agent capability audit", value: "unavailable" }],
            health: { state: "unavailable", summary: `requires ${ACTIONS_RUNNER_PREREQUISITE}` },
          };
    },
  }));
  const ciPath = deps.ciConfigPath ?? join(cwd, ".aether-ci.yml");
  registerAetherCiSettings(registry, new AetherCiSettingsFile(ciPath));
}

/**
 * Compose the current Agent settings domains without wiring a command or UI.
 * New runtimes opt in through narrow capability ports; absent ports produce
 * read-only unavailable definitions with an exact prerequisite.
 */
export function createAgentSettingsRegistry(
  ctx: Pick<AppContext, "cfg" | "flags">,
  deps: AgentSettingsAdapterDependencies,
): SettingsRegistry {
  const env = deps.env ?? process.env;
  const capabilities = deps.terminalCapabilities ?? detectTerminalCapabilities({ env });
  const configPort: AgentConfigPort = deps.config ?? {
    source: configPath(),
    exists: () => existsSync(configPath()),
    save: saveConfig,
  };
  const mcpStore = deps.mcpStore ?? new LocalMcpStore();
  const skillIndex = deps.skillIndex ?? discoverSkills({ projectRoot: ctx.flags.cwd });
  const skillPort: SkillSettingsPort = deps.skillSettings ?? {
    load: loadSkillSettings,
    save: saveSkillSetting,
  };

  const registry = new SettingsRegistry();
  registerStoreStatus(registry, deps.store);
  registerConfigSettings(registry, ctx, env, configPort);
  registerVoice(registry, deps, capabilities);
  registerAppearance(registry, env, capabilities);
  registerMcp(registry, mcpStore);
  registerSkills(registry, skillIndex, skillPort, ctx.flags.cwd);
  registerOllama(registry, env, deps.ollamaDoctor);
  registerRemoteDomains(registry, deps, ctx.flags.cwd);
  return registry;
}
