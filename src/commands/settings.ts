// `aether settings` — one typed settings surface for humans and automation.
//
// The command never edits a domain file directly. It composes the shared
// registry, stages through a transaction, presents its redacted plan, and only
// then asks the registry to apply. Imports are intentionally preview-only.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Writable } from "node:stream";
import type { CommandFlags } from "../core/command_dispatch.js";
import { configDir } from "../core/config.js";
import type { AppContext } from "../core/context.js";
import { createAgentSettingsRegistry } from "../core/settings_adapters.js";
import {
  redactSettingsArtifact,
  settingsPlanToRedactedJson,
  stableJsonStringify,
  type RedactedSetting,
  type RequiredConfirmation,
  type SettingDescriptor,
  type SettingScope,
  type SettingsBatchReceipt,
  type SettingsRegistry,
  type SettingsTransaction,
  type SettingValueType,
  type WritableSettingScope,
} from "../core/settings_registry.js";
import { AetherSettingsError } from "../core/settings_canonical.js";
import { CloudSettingsClient, type EffectiveSettingsResponse } from "../core/settings_cloud.js";
import {
  buildSettingsStatus,
  renderSettingsStatus,
  type SettingsStatusReport,
} from "../core/settings_status.js";
import { VersionedSettingsStore, type SettingsStorePaths } from "../core/settings_store.js";
import {
  detectTerminalCapabilities,
  type TerminalCapabilities,
} from "../core/terminal_capabilities.js";
import {
  initialSettingsViewState,
  renderSettingsView,
  stepSettingsView,
  type SettingsViewModel,
} from "../ui/settings_view.js";
import { sanitizeTerm } from "../ui/text.js";

type SettingsWriter = Pick<Writable, "write">;

export interface SettingsInteractiveRuntime {
  readonly stdin: typeof process.stdin;
  readonly stdout: typeof process.stdout;
  readonly signals: Pick<NodeJS.Process, "on" | "off">;
}

export const SETTINGS_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
} as const;

const SETTINGS_PROTOCOL = "aether.settings/1";
const MAX_IMPORT_BYTES = 1_048_576;
const MAX_IMPORT_SETTINGS = 1_000;
const USAGE = [
  "usage: aether settings [list [section] | show <id|section> | get <id>]",
  "       aether settings status",
  "       aether settings set <id> <value> [--scope global|project]",
  "       aether settings unset <id> [--scope global|project]",
  "       aether settings reset <section> [--scope global|project] [--preview]",
  "       aether settings doctor [section]",
  "       aether settings export --redacted",
  "       aether settings import <file> --preview",
].join("\n") + "\n";

export interface SettingsCommandOptions {
  /** Parsed global --scope. Defaults to global for legacy-config parity. */
  readonly scope?: string;
  /** Command-owned flags. */
  readonly redacted?: boolean;
  readonly preview?: boolean;
  /** Test/embedder seams. Production callers normally leave these absent. */
  readonly registry?: SettingsRegistry;
  readonly capabilities?: TerminalCapabilities;
  readonly out?: SettingsWriter;
  readonly err?: SettingsWriter;
  readonly interactive?: boolean;
  readonly configRoot?: string;
  readonly sessionId?: string;
  readonly confirmPhrase?: (confirmation: RequiredConfirmation) => Promise<string | null>;
  readonly interactiveRuntime?: SettingsInteractiveRuntime;
  /** Test seam for `settings status`; production leaves this absent. */
  readonly statusDeps?: {
    readonly readEffective?: () => Promise<EffectiveSettingsResponse>;
    readonly store?: Pick<VersionedSettingsStore, "inspect">;
  };
}

/** Convert the settings command's owned flags without reparsing argv. Scope is
 * global today, so the dispatcher passes it separately from AppContext. */
export function settingsOptionsFromFlags(
  flags: CommandFlags,
  scope?: string,
): Pick<SettingsCommandOptions, "scope" | "redacted" | "preview"> {
  return {
    ...(scope === undefined ? {} : { scope }),
    redacted: flags.bool("redacted"),
    preview: flags.bool("preview"),
  };
}

export interface SettingsCommandIo {
  readonly out?: SettingsWriter;
  readonly err?: SettingsWriter;
}

/** Concrete scope paths. Project settings are visibly project-owned; global
 * and process-session settings stay under the existing private config root. */
export function settingsStorePaths(
  ctx: Pick<AppContext, "flags">,
  options: Pick<SettingsCommandOptions, "configRoot" | "sessionId"> = {},
): SettingsStorePaths {
  const projectRoot = resolve(ctx.flags.cwd);
  const root = resolve(options.configRoot ?? configDir());
  const workspaceKey = createHash("sha256").update(projectRoot).digest("hex").slice(0, 20);
  const sessionId = boundedPathSegment(options.sessionId ?? String(process.pid));
  return {
    global: join(root, "settings", "global.json"),
    project: join(projectRoot, ".aether", "settings.json"),
    session: join(root, "settings", "sessions", `${workspaceKey}-${sessionId}.json`),
  };
}

export function createSettingsCommandRegistry(
  ctx: AppContext,
  options: Pick<SettingsCommandOptions, "capabilities" | "configRoot" | "sessionId"> = {},
): SettingsRegistry {
  const capabilities = options.capabilities ?? detectTerminalCapabilities();
  return createAgentSettingsRegistry(ctx, {
    store: new VersionedSettingsStore(settingsStorePaths(ctx, options)),
    terminalCapabilities: capabilities,
  });
}

/**
 * Build `aether settings status` without printing anything the user owns.
 *
 * Cloud is read live because a cached account revision is exactly the thing a
 * status command must not report as current. When the read fails the report
 * says so — offline, unauthorized or disabled — rather than showing a stale
 * number as if it were fresh.
 *
 * `statusDeps` is a test seam; production passes nothing and gets the real
 * Cloud client and the real local store.
 */
async function settingsStatusReport(
  ctx: AppContext,
  options: SettingsCommandOptions,
): Promise<SettingsStatusReport> {
  const deps = options.statusDeps;
  let effective: EffectiveSettingsResponse | undefined;
  let cloudError: SettingsStatusInputError;
  try {
    effective = deps?.readEffective
      ? await deps.readEffective()
      : await new CloudSettingsClient({ api: ctx.api }).effective();
  } catch (error) {
    cloudError =
      error instanceof AetherSettingsError ? error.code : "AETHER_SETTINGS_BACKEND_ERROR";
  }

  let device: { status: string; digest?: string | undefined } | undefined;
  try {
    const store =
      deps?.store ?? new VersionedSettingsStore(settingsStorePaths(ctx, options));
    const inspection = store.inspect("global");
    device = { status: inspection.status, digest: inspection.digest };
  } catch {
    // A store that cannot even be inspected is reported, not thrown: the whole
    // point of `status` is to still answer when something is broken.
    device = { status: "unreadable" };
  }

  return buildSettingsStatus({
    ...(effective ? { effective } : {}),
    ...(cloudError ? { cloudError } : {}),
    ...(device ? { device } : {}),
  });
}

type SettingsStatusInputError = Parameters<typeof buildSettingsStatus>[0]["cloudError"];

interface PresentedSetting {
  readonly id: string;
  readonly section: string;
  readonly label: string;
  readonly description: string;
  readonly valueType: SettingValueType;
  readonly scopes: readonly SettingScope[];
  readonly requiresRestart: boolean;
  readonly state: "known" | "unknown" | "unset";
  readonly scope?: SettingScope;
  readonly source?: string;
  readonly value?: unknown;
  readonly issues?: readonly { readonly code: string; readonly message: string }[];
  readonly health: RedactedSetting["health"];
  readonly precedence: RedactedSetting["precedence"];
}

interface ImportIssue {
  readonly index: number;
  readonly code: string;
  readonly message: string;
}

function boundedPathSegment(value: string): string {
  const result = value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80);
  return result || "session";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sectionMatches(actual: string, requested: string): boolean {
  return actual.toLocaleLowerCase("en-US") === requested.toLocaleLowerCase("en-US");
}

function presentedSettings(
  transaction: SettingsTransaction,
  descriptors: readonly SettingDescriptor[],
): PresentedSetting[] {
  const redacted = transaction.exportRedactedObject();
  const snapshot = transaction.snapshot;
  const definitions = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  return Object.keys(snapshot.settings).sort(stableCompare).map((id): PresentedSetting => {
    const effective = snapshot.settings[id]!;
    const descriptor = definitions.get(id);
    const visible = redacted.settings[id];
    if (visible) {
      return {
        id,
        section: visible.section,
        label: descriptor?.label ?? id,
        description: descriptor?.description ?? id,
        valueType: visible.valueType,
        scopes: descriptor?.scopes ?? [],
        requiresRestart: descriptor?.requiresRestart ?? false,
        state: visible.state,
        ...(visible.scope === undefined ? {} : { scope: visible.scope }),
        ...(visible.source === undefined ? {} : { source: visible.source }),
        ...(visible.value === undefined ? {} : { value: visible.value }),
        ...(visible.issues === undefined ? {} : { issues: visible.issues }),
        health: visible.health,
        precedence: visible.precedence,
      };
    }

    // Secret references are deliberately absent from redacted exports. Keep
    // the row useful without exposing provider/name or validator raw values.
    return {
      id,
      section: effective.section,
      label: descriptor?.label ?? id,
      description: descriptor?.description ?? id,
      valueType: effective.valueType,
      scopes: descriptor?.scopes ?? [],
      requiresRestart: descriptor?.requiresRestart ?? false,
      state: effective.state,
      ...(effective.state === "unset" ? {} : { scope: effective.scope, source: effective.source }),
      ...(effective.state === "known" ? { value: "[secret reference hidden]" } : {}),
      health: {
        state: effective.health.state,
        summary: "secret reference health is available; reference details are hidden",
      },
      precedence: [],
    };
  });
}

function settingsViewModel(registry: SettingsRegistry, transaction: SettingsTransaction): SettingsViewModel {
  const redacted = transaction.exportRedactedObject();
  const descriptors = registry.descriptors().map((descriptor) => {
    const effective = transaction.snapshot.settings[descriptor.id];
    const visible = redacted.settings[descriptor.id];
    const rawValue = effective?.state === "known" ? effective.value : undefined;
    const visibleValue = visible?.state === "known" ? visible.value : undefined;
    const redactionChangedValue = effective?.state === "known" &&
      stableJsonStringify(rawValue, 0) !== stableJsonStringify(visibleValue, 0);
    return {
      ...descriptor,
      sensitive: descriptor.sensitive || redactionChangedValue,
    };
  });
  return {
    snapshot: transaction.snapshot,
    staged: transaction.preview(),
    descriptors,
  };
}

function valueLabel(setting: PresentedSetting): string {
  if (setting.state === "unset") return "[unset]";
  if (setting.state === "unknown") return "[unknown]";
  if (setting.value === undefined) return "[hidden]";
  if (typeof setting.value === "object") return "[redacted]";
  return String(setting.value);
}

function sourceLabel(setting: PresentedSetting): string {
  return setting.scope && setting.source ? `${setting.scope}/${setting.source}` : "no source";
}

function serializeJson(value: unknown): string {
  return stableJsonStringify(value, 0) + "\n";
}

function writeJson(out: SettingsWriter, command: string, ok: boolean, data: unknown): void {
  out.write(serializeJson({ command, data: redactSettingsArtifact(data), ok, protocol: SETTINGS_PROTOCOL }));
}

function writeProblem(
  ctx: AppContext,
  out: SettingsWriter,
  err: SettingsWriter,
  command: string,
  message: string,
  code: number,
  details?: unknown,
): number {
  if (ctx.flags.json) writeJson(out, command, false, { code, ...(details === undefined ? {} : { details }), message });
  else err.write(`aether settings: ${message}\n`);
  return code;
}

function usageProblem(ctx: AppContext, out: SettingsWriter, err: SettingsWriter, message?: string): number {
  if (ctx.flags.json) {
    return writeProblem(ctx, out, err, "usage", message ?? "invalid arguments", SETTINGS_EXIT.usage, { usage: USAGE.trimEnd() });
  }
  if (message) err.write(`aether settings: ${message}\n`);
  err.write(USAGE);
  return SETTINGS_EXIT.usage;
}

function parseScope(raw: string | undefined): WritableSettingScope | null {
  const scope = raw ?? "global";
  return scope === "global" || scope === "project" ? scope : null;
}

function parseTypedValue(valueType: SettingValueType, input: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const redacted = redactSettingsArtifact(input);
  if (typeof redacted !== "string" || /\[(?:REDACTED(?:-[A-Z]+)?|SECRET_REFERENCE)\]/.test(redacted)) {
    return {
      ok: false,
      message: "credential-shaped values cannot be stored as ordinary settings; use the owning credential flow",
    };
  }
  switch (valueType) {
    case "boolean":
      if (input === "true") return { ok: true, value: true };
      if (input === "false") return { ok: true, value: false };
      return { ok: false, message: "boolean values must be exactly true or false" };
    case "number": {
      if (!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(input)) {
        return { ok: false, message: "number values must be finite decimal numbers" };
      }
      const value = Number(input);
      return Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, message: "number values must be finite decimal numbers" };
    }
    case "secret_ref":
      return {
        ok: false,
        message: "secret settings cannot be written here; use the owning credential or connection flow",
      };
    case "enum":
    case "path":
    case "string":
      return { ok: true, value: input };
  }
}

function filterSettings(settings: readonly PresentedSetting[], requested?: string): PresentedSetting[] {
  if (!requested) return [...settings];
  const exact = settings.find((setting) => setting.id === requested);
  if (exact) return [exact];
  return settings.filter((setting) => sectionMatches(setting.section, requested));
}

function renderRows(settings: readonly PresentedSetting[], detailed: boolean): string {
  if (!settings.length) return "";
  return sanitizeTerm(settings.map((setting) => {
    const first = `${setting.id}\t${valueLabel(setting)}\t${sourceLabel(setting)}\t${setting.health.state}`;
    if (!detailed) return first;
    const summary = setting.health.summary ? `\n  health: ${setting.health.summary}` : "";
    const issues = setting.issues?.length
      ? `\n  validation: ${setting.issues.map((item) => `${item.code}: ${item.message}`).join("; ")}`
      : "";
    const restart = setting.requiresRestart ? "\n  impact: restart required" : "";
    return `${first}\n  label: ${setting.label}\n  section: ${setting.section}\n  type: ${setting.valueType}\n  scopes: ${setting.scopes.join(", ") || "unknown"}\n  description: ${setting.description}${restart}${summary}${issues}`;
  }).join("\n") + "\n");
}

async function defaultPhrasePrompt(confirmation: RequiredConfirmation): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await reader.question(
      `${confirmation.reason}\nType \"${confirmation.phrase}\" to apply ${confirmation.settingId}: `,
    );
  } finally {
    reader.close();
  }
}

async function defaultValuePrompt(id: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await reader.question(`New value for ${id} (blank is a value; Ctrl+C cancels): `);
  } catch {
    return null;
  } finally {
    reader.close();
  }
}

async function collectConfirmations(
  plan: { readonly confirmations: readonly RequiredConfirmation[] },
  prompt: ((confirmation: RequiredConfirmation) => Promise<string | null>) | undefined,
): Promise<readonly string[] | null> {
  if (!plan.confirmations.length) return [];
  const ask = prompt ?? defaultPhrasePrompt;
  const approved: string[] = [];
  for (const confirmation of plan.confirmations) {
    const answer = await ask(confirmation);
    if (answer !== confirmation.phrase) return null;
    approved.push(answer);
  }
  return approved;
}

function receiptExit(receipt: SettingsBatchReceipt): number {
  return receipt.status === "applied" ? SETTINGS_EXIT.ok : SETTINGS_EXIT.failed;
}

async function mutateOne(
  ctx: AppContext,
  transaction: SettingsTransaction,
  operation: "set" | "unset",
  id: string,
  rawValue: string | undefined,
  scope: WritableSettingScope,
  options: SettingsCommandOptions,
  out: SettingsWriter,
  err: SettingsWriter,
): Promise<number> {
  const setting = transaction.snapshot.settings[id];
  if (!setting) return writeProblem(ctx, out, err, operation, "unknown setting id", SETTINGS_EXIT.failed);

  let staged;
  if (operation === "set") {
    if (rawValue === undefined) return usageProblem(ctx, out, err, "set requires an id and value");
    const parsed = parseTypedValue(setting.valueType, rawValue);
    if (!parsed.ok) return writeProblem(ctx, out, err, operation, parsed.message, SETTINGS_EXIT.failed);
    staged = transaction.stage(id, scope, parsed.value);
  } else {
    staged = transaction.unset(id, scope);
  }

  if (!staged.ok) {
    return writeProblem(ctx, out, err, operation, "setting validation failed", SETTINGS_EXIT.failed, {
      id,
      issues: staged.issues,
      scope,
    });
  }
  if (!staged.changed) {
    const data = { changed: false, id, scope, status: "unchanged" };
    if (ctx.flags.json) writeJson(out, operation, true, data);
    else out.write(`${id} is already unchanged at ${scope} scope\n`);
    return SETTINGS_EXIT.ok;
  }

  let plan;
  try {
    plan = await transaction.createPlan();
  } catch {
    transaction.cancel();
    return writeProblem(ctx, out, err, operation, "could not create a safe settings plan", SETTINGS_EXIT.failed);
  }
  const confirmations = await collectConfirmations(plan, options.confirmPhrase);
  if (confirmations === null) {
    transaction.cancel();
    return writeProblem(
      ctx,
      out,
      err,
      operation,
      "exact confirmation phrase required; --yes never approves destructive or cost-sensitive settings",
      SETTINGS_EXIT.failed,
      {
        confirmations: plan.confirmations.map(({ settingId, impact, phrase, reason }) => ({ settingId, impact, phrase, reason })),
        plan: JSON.parse(settingsPlanToRedactedJson(plan, 0)) as unknown,
      },
    );
  }

  const receipt = await transaction.applyPlan(plan, { confirmations });
  const ok = receipt.status === "applied";
  if (ctx.flags.json) writeJson(out, operation, ok, receipt);
  else if (ok) {
    out.write(`applied ${id} at ${scope} scope${receipt.requiresRestart ? "; restart required" : ""}\n`);
  } else {
    err.write(`aether settings: ${receipt.failure?.message ?? "settings apply failed"}\n`);
  }
  return receiptExit(receipt);
}

interface ResetResult {
  readonly status:
    | "unknown_section"
    | "scope_unsupported"
    | "already_unset"
    | "stage_failed"
    | "plan_unavailable"
    | "previewed"
    | "confirmation_required"
    | SettingsBatchReceipt["status"];
  readonly mutated: boolean | "unknown";
  readonly section: string;
  readonly scope: WritableSettingScope;
  readonly message?: string;
  readonly resetSettingIds?: readonly string[];
  readonly alreadyUnsetSettingIds?: readonly string[];
  readonly plan?: unknown;
  readonly cancellation?: ReturnType<SettingsTransaction["cancel"]>;
  readonly confirmations?: readonly RequiredConfirmation[];
  readonly issues?: readonly { readonly settingId: string; readonly issues: unknown }[];
  readonly receipt?: SettingsBatchReceipt;
}

function writeResetResult(
  ctx: AppContext,
  out: SettingsWriter,
  err: SettingsWriter,
  ok: boolean,
  data: ResetResult,
  humanMessage: string,
): number {
  if (ctx.flags.json) writeJson(out, "reset", ok, data);
  else {
    const safe = sanitizeTerm(String(redactSettingsArtifact(humanMessage)));
    (ok ? out : err).write(`${ok ? "" : "aether settings: "}${safe}\n`);
  }
  return ok ? SETTINGS_EXIT.ok : SETTINGS_EXIT.failed;
}

/** Reset is deliberately a command-layer batch over the registry's existing
 * transaction boundary. Descriptors choose section membership and writable
 * scope; the registry remains the sole authority for validation, planning,
 * confirmation, apply, and compensation. */
async function resetSection(
  ctx: AppContext,
  registry: SettingsRegistry,
  requestedSection: string,
  scope: WritableSettingScope,
  options: SettingsCommandOptions,
  out: SettingsWriter,
  err: SettingsWriter,
): Promise<number> {
  const inSection = registry.descriptors().filter((descriptor) =>
    sectionMatches(descriptor.section, requestedSection)
  );
  if (!inSection.length) {
    return writeResetResult(ctx, out, err, false, {
      status: "unknown_section",
      mutated: false,
      section: requestedSection,
      scope,
      message: "unknown settings section",
    }, "unknown settings section");
  }

  const section = inSection[0]!.section;
  const writable = inSection.filter((descriptor) => descriptor.scopes.includes(scope));
  if (!writable.length) {
    return writeResetResult(ctx, out, err, false, {
      status: "scope_unsupported",
      mutated: false,
      section,
      scope,
      message: `section has no settings writable at ${scope} scope`,
    }, `section has no settings writable at ${scope} scope`);
  }

  const transaction = await registry.begin();
  const alreadyUnsetSettingIds: string[] = [];
  const stageIssues: Array<{ settingId: string; issues: unknown }> = [];
  for (const descriptor of writable) {
    const staged = transaction.unset(descriptor.id, scope);
    if (!staged.ok) {
      stageIssues.push({ settingId: descriptor.id, issues: staged.issues });
    } else if (!staged.changed) {
      alreadyUnsetSettingIds.push(descriptor.id);
    }
  }
  if (stageIssues.length) {
    transaction.cancel();
    return writeResetResult(ctx, out, err, false, {
      status: "stage_failed",
      mutated: false,
      section,
      scope,
      message: "one or more section settings could not be staged safely",
      alreadyUnsetSettingIds,
      issues: stageIssues,
    }, "one or more section settings could not be staged safely; no settings were changed");
  }

  const staged = transaction.preview();
  if (!staged.length) {
    const cancellation = transaction.cancel();
    return writeResetResult(ctx, out, err, true, {
      status: "already_unset",
      mutated: false,
      section,
      scope,
      message: `section is already unset at ${scope} scope`,
      resetSettingIds: [],
      alreadyUnsetSettingIds,
      cancellation,
    }, `${section} is already unset at ${scope} scope`);
  }

  let plan;
  try {
    // Multi-setting plans are rejected by the transaction before adapter
    // planning when any member lacks rollback support.
    plan = await transaction.createPlan();
  } catch {
    transaction.cancel();
    return writeResetResult(ctx, out, err, false, {
      status: "plan_unavailable",
      mutated: false,
      section,
      scope,
      message: "an atomic settings reset plan is unavailable",
      resetSettingIds: staged.map((change) => change.settingId),
      alreadyUnsetSettingIds,
    }, "an atomic settings reset plan is unavailable; no settings were changed");
  }

  const redactedPlan = JSON.parse(settingsPlanToRedactedJson(plan, 0)) as unknown;
  const resetSettingIds = plan.changes.map((change) => change.settingId);
  if (options.preview) {
    const cancellation = transaction.cancel();
    return writeResetResult(ctx, out, err, true, {
      status: "previewed",
      mutated: false,
      section,
      scope,
      message: "reset plan previewed and cancelled; no settings were changed",
      resetSettingIds,
      alreadyUnsetSettingIds,
      plan: redactedPlan,
      cancellation,
    }, stableJsonStringify(redactSettingsArtifact({
      status: "previewed",
      mutated: false,
      section,
      scope,
      resetSettingIds,
      alreadyUnsetSettingIds,
      plan: redactedPlan,
      cancellation,
    }), 2));
  }

  const confirmations = await collectConfirmations(plan, options.confirmPhrase);
  if (confirmations === null) {
    const cancellation = transaction.cancel();
    return writeResetResult(ctx, out, err, false, {
      status: "confirmation_required",
      mutated: false,
      section,
      scope,
      message: "exact confirmation phrase required; --yes never approves destructive or cost-sensitive settings",
      resetSettingIds,
      alreadyUnsetSettingIds,
      plan: redactedPlan,
      cancellation,
      confirmations: plan.confirmations,
    }, "exact confirmation phrase required; --yes never approves destructive or cost-sensitive settings");
  }

  const receipt = await transaction.applyPlan(plan, { confirmations });
  const ok = receipt.status === "applied";
  const mutated = receipt.status === "applied"
    ? true
    : receipt.status === "compensation_failed"
    ? "unknown"
    : false;
  const data: ResetResult = {
    status: receipt.status,
    mutated,
    section,
    scope,
    resetSettingIds,
    alreadyUnsetSettingIds,
    plan: redactedPlan,
    receipt,
  };
  if (ok) {
    return writeResetResult(
      ctx,
      out,
      err,
      true,
      data,
      `reset ${resetSettingIds.length} setting${resetSettingIds.length === 1 ? "" : "s"} in ${section} at ${scope} scope${receipt.requiresRestart ? "; restart required" : ""}`,
    );
  }
  return writeResetResult(
    ctx,
    out,
    err,
    false,
    { ...data, message: receipt.failure?.message ?? "settings reset failed" },
    receipt.status === "rolled_back" || receipt.status === "cancelled"
      ? `${receipt.failure?.message ?? "settings reset failed"}; completed mutations were rolled back`
      : receipt.failure?.message ?? "settings reset failed",
  );
}

function importEntry(
  entry: unknown,
  fallbackScope: WritableSettingScope,
): { readonly value?: unknown; readonly scope: WritableSettingScope; readonly skip?: true; readonly error?: string } {
  if (!isRecord(entry)) return { value: entry, scope: fallbackScope };
  if (entry["state"] === "unset" || entry["state"] === "unknown") return { scope: fallbackScope, skip: true };
  if (!Object.prototype.hasOwnProperty.call(entry, "value")) {
    return { scope: fallbackScope, error: "structured import entry requires a value" };
  }
  const requestedScope = entry["scope"];
  if (requestedScope !== undefined && requestedScope !== "global" && requestedScope !== "project") {
    return { scope: fallbackScope, error: "import scope must be global or project" };
  }
  return {
    value: entry["value"],
    scope: (requestedScope as WritableSettingScope | undefined) ?? fallbackScope,
  };
}

async function previewImport(
  ctx: AppContext,
  transaction: SettingsTransaction,
  file: string,
  fallbackScope: WritableSettingScope,
  out: SettingsWriter,
  err: SettingsWriter,
): Promise<number> {
  let document: unknown;
  try {
    const path = resolve(ctx.flags.cwd, file);
    if (statSync(path).size > MAX_IMPORT_BYTES) throw new Error("oversize");
    document = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return writeProblem(ctx, out, err, "import", "settings import is unreadable or invalid JSON", SETTINGS_EXIT.failed);
  }
  if (!isRecord(document) || !isRecord(document["settings"])) {
    return writeProblem(ctx, out, err, "import", "settings import must contain an object-valued settings field", SETTINGS_EXIT.failed);
  }
  const schemaVersion = document["schemaVersion"] ?? document["schema_version"];
  if (schemaVersion !== undefined && schemaVersion !== 1) {
    return writeProblem(ctx, out, err, "import", "unsupported settings import schema", SETTINGS_EXIT.failed);
  }
  const entries = Object.entries(document["settings"]);
  if (entries.length > MAX_IMPORT_SETTINGS) {
    return writeProblem(ctx, out, err, "import", "settings import contains too many entries", SETTINGS_EXIT.failed);
  }

  const issues: ImportIssue[] = [];
  for (let index = 0; index < entries.length; index++) {
    const [id, raw] = entries[index]!;
    const effective = transaction.snapshot.settings[id];
    if (!effective) {
      issues.push({ index, code: "setting.unknown", message: "import entry names an unknown setting" });
      continue;
    }
    if (effective.valueType === "secret_ref") {
      issues.push({ index, code: "secret_ref.disallowed", message: "secret references require the owning credential flow" });
      continue;
    }
    const candidate = importEntry(raw, fallbackScope);
    if (candidate.error) {
      issues.push({ index, code: "entry.invalid", message: candidate.error });
      continue;
    }
    if (candidate.skip) continue;
    const staged = transaction.stage(id, candidate.scope, candidate.value);
    if (!staged.ok) {
      issues.push(...staged.issues.map((item) => ({ index, code: item.code, message: item.message })));
    }
  }

  const preview = transaction.preview();
  transaction.cancel();
  const ok = issues.length === 0;
  const data = { issues, mutated: false, preview, status: ok ? "previewed" : "invalid" };
  if (ctx.flags.json) writeJson(out, "import", ok, data);
  else {
    out.write(stableJsonStringify(redactSettingsArtifact(data), 2) + "\n");
    if (!ok) err.write("aether settings: import preview has validation errors; no settings were changed\n");
  }
  return ok ? SETTINGS_EXIT.ok : SETTINGS_EXIT.failed;
}

function keyName(input: Buffer | string): string {
  const value = typeof input === "string" ? input : input.toString("utf8");
  switch (value) {
    case "\u0013": return "ctrl-s";
    case "\u0003": return "ctrl-c";
    case "\u001b": return "escape";
    case "\u001b[A": return "up";
    case "\u001b[B": return "down";
    case "\t": return "tab";
    case "\r":
    case "\n": return "enter";
    case "\u007f": return "backspace";
    case " ": return "space";
    default: return value.length === 1 ? value : "";
  }
}

async function interactiveView(
  registry: SettingsRegistry,
  capabilities: TerminalCapabilities,
  out: SettingsWriter,
  phrasePrompt?: (confirmation: RequiredConfirmation) => Promise<string | null>,
  runtime: SettingsInteractiveRuntime = {
    stdin: process.stdin,
    stdout: process.stdout,
    signals: process,
  },
): Promise<number> {
  const stdin = runtime.stdin;
  const stdout = runtime.stdout;
  const signals = runtime.signals;
  const wasRaw = Boolean(stdin.isRaw);
  const wasPaused = stdin.isPaused();
  const startupAbort = new AbortController();
  const startup = { exitCode: null as number | null };
  const stopStartup = (code: number): void => {
    if (startup.exitCode !== null) return;
    startup.exitCode = code;
    startupAbort.abort(new Error("settings startup cancelled"));
  };
  const onStartupSigint = (): void => stopStartup(130);
  const onStartupSigterm = (): void => stopStartup(143);
  signals.on("SIGINT", onStartupSigint);
  signals.on("SIGTERM", onStartupSigterm);
  let transaction: SettingsTransaction | undefined;
  try {
    transaction = await registry.begin({ signal: startupAbort.signal });
  } catch {
    // The boundary reports only a static, renderer-safe failure. Adapter
    // diagnostics are intentionally not copied into terminal output here.
  } finally {
    signals.off("SIGINT", onStartupSigint);
    signals.off("SIGTERM", onStartupSigterm);
  }
  if (startup.exitCode !== null) {
    transaction?.cancel();
    out.write("\n");
    return startup.exitCode;
  }
  if (!transaction) {
    out.write("AETHER SETTINGS unavailable: initial snapshot failed safely\n");
    return SETTINGS_EXIT.failed;
  }
  const startupTimedOut = Object.values(transaction.snapshot.settings).some((setting) =>
    setting.health.summary?.startsWith("settings snapshot timed out after ") === true
  );
  if (startupTimedOut) {
    transaction.cancel();
    out.write("AETHER SETTINGS unavailable: initial snapshot timed out; no settings were changed\n");
    return SETTINGS_EXIT.failed;
  }
  const sessionAbort = new AbortController();
  let currentTransaction: SettingsTransaction = transaction;
  let model = settingsViewModel(registry, currentTransaction);
  let state = initialSettingsViewState(model);
  let liveCapabilities = capabilities;
  let active = true;

  const render = (): void => {
    if (!active) return;
    model = settingsViewModel(registry, currentTransaction);
    out.write("\u001b[2J\u001b[H" + renderSettingsView(model, state, liveCapabilities).join("\n"));
  };
  render();
  stdin.setRawMode?.(true);
  stdin.resume();

  return await new Promise<number>((resolveDone) => {
    let settled = false;
    let stopping = false;
    let queue = Promise.resolve();
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = (): void => {
      if (resizeTimer || settled) return;
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (settled) return;
        liveCapabilities = {
          ...liveCapabilities,
          columns: stdout.columns || liveCapabilities.columns,
          rows: stdout.rows || liveCapabilities.rows,
        };
        render();
      }, 0);
      resizeTimer.unref?.();
    };
    const stopAfterCancellation = (code: number): void => {
      if (settled || stopping) return;
      stopping = true;
      sessionAbort.abort(new Error("settings interaction cancelled"));
      void currentTransaction.cancelAndWait().then((outcome) => {
        if (outcome.apply?.status === "compensation_failed") {
          state = { ...state, message: "cancellation could not prove rollback; inspect the receipt" };
          render();
          finish(SETTINGS_EXIT.failed);
          return;
        }
        if (outcome.apply?.status === "applied") {
          state = { ...state, message: "settings apply completed before cancellation took effect" };
          render();
        }
        finish(code);
      }).catch(() => {
        state = { ...state, message: "settings cancellation did not reach a proven terminal state" };
        render();
        finish(SETTINGS_EXIT.failed);
      });
    };
    const onSigint = (): void => stopAfterCancellation(130);
    const onSigterm = (): void => stopAfterCancellation(143);
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      active = false;
      sessionAbort.abort(new Error("settings interaction finished"));
      stdin.off("data", onData);
      stdout.off("resize", onResize);
      signals.off("SIGINT", onSigint);
      signals.off("SIGTERM", onSigterm);
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = null;
      if (!wasRaw) stdin.setRawMode?.(false);
      if (wasPaused) stdin.pause();
      out.write("\n");
      resolveDone(code);
    };
    const whileLineMode = async <T>(work: () => Promise<T>): Promise<T> => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      try {
        return await work();
      } finally {
        if (!settled && !stopping) {
          stdin.setRawMode?.(true);
          stdin.on("data", onData);
          stdin.resume();
        }
      }
    };
    const handle = async (chunk: Buffer | string): Promise<void> => {
      if (settled || stopping) return;
      const key = keyName(chunk);
      if (!key) return;
      if (key === "ctrl-c") {
        stopAfterCancellation(SETTINGS_EXIT.ok);
        return;
      }
      const step = stepSettingsView(state, key, model);
      state = step.state;
      if (step.intent.type === "close") {
        finish(SETTINGS_EXIT.ok);
        return;
      }
      if (step.intent.type === "cancel") {
        currentTransaction.cancel();
        const replacement = await registry.begin({ signal: sessionAbort.signal });
        if (settled || stopping) {
          replacement.cancel();
          return;
        }
        currentTransaction = replacement;
        state = { ...state, message: "staged changes cancelled" };
      } else if (step.intent.type === "toggle") {
        const staged = currentTransaction.stage(step.intent.settingId, step.intent.scope, step.intent.value);
        state = { ...state, message: staged.ok ? "change staged" : staged.issues[0]?.message ?? "cannot stage setting" };
      } else if (step.intent.type === "edit") {
        const settingId = step.intent.settingId;
        const effective = currentTransaction.snapshot.settings[settingId];
        if (!effective) {
          state = { ...state, message: "setting is no longer available" };
        } else if (effective.valueType === "secret_ref") {
          state = { ...state, message: "use the owning credential flow for secret references" };
        } else {
          const answer = await whileLineMode(() => defaultValuePrompt(settingId));
          if (settled || stopping) return;
          if (answer === null) {
            state = { ...state, message: "edit cancelled" };
          } else {
            const parsed = parseTypedValue(effective.valueType, answer);
            if (!parsed.ok) state = { ...state, message: parsed.message };
            else {
              const staged = currentTransaction.stage(settingId, step.intent.scope, parsed.value);
              state = {
                ...state,
                message: staged.ok ? (staged.changed ? "change staged" : "value is unchanged") : staged.issues[0]?.message ?? "cannot stage setting",
              };
            }
          }
        }
      } else if (step.intent.type === "apply") {
        try {
          const plan = await currentTransaction.createPlan({ signal: sessionAbort.signal });
          if (settled || stopping) return;
          const confirmations = plan.confirmations.length
            ? await whileLineMode(() => collectConfirmations(plan, phrasePrompt))
            : [];
          if (settled || stopping) return;
          if (confirmations === null) {
            state = { ...state, message: "exact confirmation phrase was not supplied; nothing applied" };
          } else {
            const receipt = await currentTransaction.applyPlan(plan, {
              confirmations,
              signal: sessionAbort.signal,
            });
            if (settled || stopping) return;
            const replacement = await registry.begin({ signal: sessionAbort.signal });
            if (settled || stopping) {
              replacement.cancel();
              return;
            }
            currentTransaction = replacement;
            state = { ...state, message: receipt.status === "applied" ? "settings applied" : "settings apply failed" };
          }
        } catch {
          if (settled || stopping) return;
          state = { ...state, message: "settings plan could not be created" };
        }
      }
      if (!settled && !stopping) render();
    };
    const onData = (chunk: Buffer | string): void => {
      if (keyName(chunk) === "ctrl-c") {
        stopAfterCancellation(SETTINGS_EXIT.ok);
        return;
      }
      queue = queue.then(() => handle(chunk)).catch(() => {
        if (!stopping) finish(SETTINGS_EXIT.failed);
      });
    };
    stdin.on("data", onData);
    if (out === stdout) stdout.on("resize", onResize);
    signals.on("SIGINT", onSigint);
    signals.on("SIGTERM", onSigterm);
  });
}

/** Public command entry. Callers pass already-parsed flags as data; this file
 * does not parse argv options a second time. */
export async function cmdSettings(
  ctx: AppContext,
  argv: string[] = [],
  options: SettingsCommandOptions = {},
): Promise<number> {
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;
  const capabilities = options.capabilities ?? detectTerminalCapabilities();
  const registry = options.registry ?? createSettingsCommandRegistry(ctx, { ...options, capabilities });
  const subcommand = argv[0];

  try {
    if (options.redacted && subcommand !== "export") {
      return usageProblem(ctx, out, err, "--redacted is valid only with settings export");
    }
    if (options.preview && subcommand !== "import" && subcommand !== "reset") {
      return usageProblem(ctx, out, err, "--preview is valid only with settings import or settings reset");
    }

    if (subcommand === undefined) {
      if (ctx.flags.json) {
        const transaction = await registry.begin();
        writeJson(out, "view", true, { settings: presentedSettings(transaction, registry.descriptors()) });
        return SETTINGS_EXIT.ok;
      }
      const shouldInteract = options.interactive ??
        (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && out === process.stdout);
      if (shouldInteract) {
        return await interactiveView(
          registry,
          capabilities,
          out,
          options.confirmPhrase,
          options.interactiveRuntime,
        );
      }
      const transaction = await registry.begin();
      const model = settingsViewModel(registry, transaction);
      out.write(renderSettingsView(model, initialSettingsViewState(model), capabilities).join("\n") + "\n");
      return SETTINGS_EXIT.ok;
    }

    if (subcommand === "list" || subcommand === "show" || subcommand === "get") {
      const expected = subcommand === "list" ? 2 : 2;
      if (argv.length > expected || (subcommand !== "list" && !argv[1])) return usageProblem(ctx, out, err);
      const transaction = await registry.begin();
      const all = presentedSettings(transaction, registry.descriptors());
      const found = filterSettings(all, argv[1]);
      if (!found.length) return writeProblem(ctx, out, err, subcommand, "setting or section not found", SETTINGS_EXIT.failed);
      if (subcommand === "get" && (found.length !== 1 || found[0]?.id !== argv[1])) {
        return writeProblem(ctx, out, err, subcommand, "get requires an exact setting id", SETTINGS_EXIT.failed);
      }
      if (ctx.flags.json) writeJson(out, subcommand, true, { settings: found });
      else out.write(renderRows(found, subcommand === "show"));
      return SETTINGS_EXIT.ok;
    }

    if (subcommand === "status") {
      if (argv.length > 1) return usageProblem(ctx, out, err);
      const report = await settingsStatusReport(ctx, options);
      if (ctx.flags.json) writeJson(out, "status", true, { status: report });
      else out.write(renderSettingsStatus(report));
      return SETTINGS_EXIT.ok;
    }

    const scope = parseScope(options.scope);
    if (!scope) return usageProblem(ctx, out, err, "--scope must be global or project");

    if (subcommand === "set") {
      if (argv.length !== 3) return usageProblem(ctx, out, err, "set requires an id and one value");
      return await mutateOne(ctx, await registry.begin(), "set", argv[1]!, argv[2], scope, options, out, err);
    }
    if (subcommand === "unset") {
      if (argv.length !== 2) return usageProblem(ctx, out, err, "unset requires one id");
      return await mutateOne(ctx, await registry.begin(), "unset", argv[1]!, undefined, scope, options, out, err);
    }
    if (subcommand === "reset") {
      if (argv.length !== 2 || !argv[1]) return usageProblem(ctx, out, err, "reset requires one section");
      return await resetSection(ctx, registry, argv[1], scope, options, out, err);
    }
    if (subcommand === "doctor") {
      if (argv.length > 2) return usageProblem(ctx, out, err);
      const transaction = await registry.begin({ doctor: true });
      const settings = filterSettings(presentedSettings(transaction, registry.descriptors()), argv[1]);
      if (!settings.length) return writeProblem(ctx, out, err, "doctor", "section not found", SETTINGS_EXIT.failed);
      const failed = settings.some((setting) => ["degraded", "unavailable", "unknown"].includes(setting.health.state));
      if (ctx.flags.json) writeJson(out, "doctor", !failed, { settings });
      else out.write(renderRows(settings, true));
      return failed ? SETTINGS_EXIT.failed : SETTINGS_EXIT.ok;
    }
    if (subcommand === "export") {
      if (argv.length !== 1 || !options.redacted) return usageProblem(ctx, out, err, "export requires --redacted");
      const transaction = await registry.begin();
      // The export object is already redacted by the registry and has stable
      // key ordering here. Do not wrap it with values from the raw snapshot.
      out.write(transaction.exportRedacted(ctx.flags.json ? 0 : 2) + "\n");
      return SETTINGS_EXIT.ok;
    }
    if (subcommand === "import") {
      if (argv.length !== 2 || !argv[1] || !options.preview) {
        return usageProblem(ctx, out, err, "import requires a file and --preview");
      }
      return await previewImport(ctx, await registry.begin(), argv[1], scope, out, err);
    }

    return usageProblem(ctx, out, err, `unknown subcommand: ${subcommand}`);
  } catch {
    return writeProblem(ctx, out, err, subcommand ?? "view", "settings command failed safely", SETTINGS_EXIT.failed, {
      mutated: false,
      state: "failed",
    });
  }
}

/** Shared shell/slash entry used by the central dispatcher and Voice's
 * settings shortcut. IO is separate so slash output stays in its own sink. */
export async function runSettingsCommand(
  ctx: AppContext,
  argv: string[] = [],
  options: SettingsCommandOptions = {},
  io: SettingsCommandIo = {},
): Promise<number> {
  return cmdSettings(ctx, argv, {
    ...options,
    ...(io.out === undefined ? {} : { out: io.out }),
    ...(io.err === undefined ? {} : { err: io.err }),
  });
}
