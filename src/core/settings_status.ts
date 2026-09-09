// `aether settings status` — one diagnostic view of the settings system.
//
// It answers the operator's question ("is this machine agreeing with Cloud, and
// about what revision?") without dumping the user's settings. Values are never
// included: only schema, reachability, revisions, and counts.
//
// Pure: the caller performs the reads and passes the results in, so the report
// is testable without a network or a home directory.

import {
  CANONICAL_SETTINGS_SCHEMA,
  canonicalSettings,
  type AetherSettingsErrorCode,
} from "./settings_canonical.js";
import type { EffectiveSettingsResponse } from "./settings_cloud.js";

/** How the Cloud half of the system is doing right now. */
export type CloudReachability =
  | "connected"
  | "offline"
  | "unauthorized"
  | "disabled"
  | "error";

export interface DeviceStoreStatus {
  /** The local store's own status word, e.g. "ok" | "missing" | "corrupt". */
  readonly status: string;
  /** Opaque CAS token for the local store; never an account revision. */
  readonly digest?: string | undefined;
}

export interface SettingsStatusInput {
  /** Absent when the effective read failed; pair it with `cloudError`. */
  readonly effective?: EffectiveSettingsResponse | undefined;
  readonly cloudError?: AetherSettingsErrorCode | undefined;
  /** Human-facing project label, e.g. "AetherAI3/AETHER-CLOUD". */
  readonly projectLabel?: string | undefined;
  readonly device?: DeviceStoreStatus | undefined;
  /** Edits the user has made that Cloud has not acknowledged. */
  readonly pending?: number | undefined;
  /** Keys currently sitting in a revision conflict. */
  readonly conflicts?: number | undefined;
}

export interface SettingsStatusReport {
  readonly schema: string;
  readonly cloud: CloudReachability;
  readonly accountRevision: number | null;
  readonly project: string | null;
  readonly projectRevision: number | null;
  readonly deviceStatus: string;
  readonly deviceRevision: string | null;
  readonly pending: number;
  readonly conflicts: number;
  /** Canonical keys whose effective value comes from a managed policy. */
  readonly policyLockedKeys: readonly string[];
  /** Canonical keys the contract knows that the server did not return. */
  readonly missingKeys: readonly string[];
}

function reachabilityFor(input: SettingsStatusInput): CloudReachability {
  if (input.effective) return "connected";
  switch (input.cloudError) {
    case "AETHER_SETTINGS_OFFLINE":
      return "offline";
    case "AETHER_SETTINGS_UNAUTHORIZED":
      return "unauthorized";
    case "AETHER_SETTINGS_DISABLED":
      return "disabled";
    case undefined:
      return "offline";
    default:
      return "error";
  }
}

/**
 * The highest configured revision at one scope.
 *
 * There is no single "account revision" in the contract — revisions are per
 * key — so the report shows the newest one, which is what an operator
 * comparing two machines actually needs. Unconfigured keys contribute nothing,
 * so a fresh account reads 0 rather than a misleading number.
 */
function highestRevision(
  effective: EffectiveSettingsResponse | undefined,
  scope: "account" | "project",
): number | null {
  if (!effective) return null;
  let highest = 0;
  for (const setting of Object.values(effective.settings)) {
    const override = setting.overrides[scope];
    if (override?.configured && override.revision > highest) highest = override.revision;
  }
  return highest;
}

export function buildSettingsStatus(input: SettingsStatusInput): SettingsStatusReport {
  const effective = input.effective;
  const returned = new Set(Object.keys(effective?.settings ?? {}));
  const policyLocked = effective
    ? Object.values(effective.settings)
        .filter((item) => item.locked || item.sourceScope === "policy")
        .map((item) => item.key)
        .sort()
    : [];
  // Only meaningful once the server answered; an offline read is missing
  // everything, and reporting that as contract drift would be a false alarm.
  const missing = effective
    ? canonicalSettings()
        .filter((item) => item.persistence === "server" && !returned.has(item.key))
        .map((item) => item.key)
        .sort()
    : [];

  return {
    schema: CANONICAL_SETTINGS_SCHEMA,
    cloud: reachabilityFor(input),
    accountRevision: highestRevision(effective, "account"),
    project: input.projectLabel ?? effective?.projectId ?? null,
    projectRevision: effective?.projectId ? highestRevision(effective, "project") : null,
    deviceStatus: input.device?.status ?? "unknown",
    deviceRevision: input.device?.digest ?? null,
    pending: input.pending ?? 0,
    conflicts: input.conflicts ?? 0,
    policyLockedKeys: policyLocked,
    missingKeys: missing,
  };
}

function row(label: string, value: string): string {
  return `${label.padEnd(14)}${value}`;
}

/**
 * Render the report for a terminal.
 *
 * Deliberately short: no values, and only the lines that carry information. A
 * digest is truncated because its purpose is comparison between two machines,
 * not reconstruction.
 */
export function renderSettingsStatus(report: SettingsStatusReport): string {
  const lines = [row("Schema", report.schema), row("Cloud", report.cloud)];
  lines.push(
    row(
      "Account rev",
      report.accountRevision === null ? "unknown" : String(report.accountRevision),
    ),
  );
  if (report.project) {
    lines.push(row("Project", report.project));
    lines.push(
      row(
        "Project rev",
        report.projectRevision === null ? "unknown" : String(report.projectRevision),
      ),
    );
  }
  lines.push(row("Device", report.deviceStatus));
  if (report.deviceRevision) {
    lines.push(row("Device rev", report.deviceRevision.slice(0, 12)));
  }
  lines.push(row("Pending", String(report.pending)));
  lines.push(row("Conflicts", String(report.conflicts)));
  if (report.policyLockedKeys.length) {
    lines.push(row("Policy locked", report.policyLockedKeys.join(", ")));
  }
  if (report.missingKeys.length) {
    lines.push(row("Not returned", report.missingKeys.join(", ")));
  }
  return lines.join("\n") + "\n";
}
