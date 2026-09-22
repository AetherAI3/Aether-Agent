// The three durable files Spec 2 section 15 adds beside the immutable
// ats.json: runtime.json, data-profile.json and dashboard.json.
//
// Each read is total — a missing file is `null`, not an exception — because
// every one of these is optional state that a fresh setup simply has not
// written yet. A CORRUPT file is different and does throw: silently treating
// unreadable runtime state as "no runtime" would let a damaged install look
// like a clean machine and get overwritten, losing the receipt that says what
// is actually on disk.

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  choice,
  closed,
  fail,
  ident,
  integer,
  nullable,
  schemaTag,
  text,
  timestamp,
} from "../ats_contracts/primitives.js";
import {
  validateRuntimeInstallationReceipt,
  type RuntimeInstallationReceiptV1,
} from "../ats_contracts/runtime.js";
import { REQUESTED_EXECUTION_MODES, type RequestedExecutionMode } from "../ats_contracts/mode.js";
import {
  validateDataProbeReceipt,
  validateDataProfile,
  type DataProbeReceiptV1,
  type DataProfileV1,
} from "../ats_contracts/data.js";
import {
  defaultJournalPreferences,
  validateJournalPreferences,
  type JournalPreferencesV1,
} from "../ats_contracts/journal.js";
import { refuseSymlinkedPath, writePrivateFile } from "./paths.js";

export const RUNTIME_STATE_SCHEMA = "aether.ats.runtime-state/1" as const;
export const DATA_STATE_SCHEMA = "aether.ats.data-state/1" as const;
export const DASHBOARD_STATE_SCHEMA = "aether.ats.dashboard-state/1" as const;

/**
 * An absolute, already-normalized path. Requiring `resolve(p) === p` rejects
 * `..` segments and trailing separators that would otherwise make two records
 * disagree about whether they point at the same directory.
 */
export function absolutePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.length || value.includes("\0")) {
    fail(`${name} must be an absolute local path.`);
  }
  const path = value as string;
  if (!isAbsolute(path) || resolve(path) !== path) fail(`${name} must be an absolute, normalized path.`);
  return path;
}

export interface SupervisorStateV1 {
  readonly pid: number | null;
  readonly started_at: string | null;
  /**
   * An opaque, platform-supplied identity for the PROCESS START, not just the
   * pid. A pid is reused freely by the OS, so `kill(pid, 0)` proves only that
   * *some* process holds that number — signalling on that basis can terminate
   * an unrelated program. Pairing the pid with its start identity makes
   * reuse detectable: same number, different token, not our process.
   *
   * Null when the platform cannot supply one, in which case the supervisor
   * falls back to requiring an authenticated instance handshake before it will
   * terminate anything.
   */
  readonly start_token: string | null;
  readonly last_exit_code: number | null;
  readonly last_error: string | null;
}

const SUPERVISOR_FIELDS = ["pid", "started_at", "start_token", "last_exit_code", "last_error"] as const;

function supervisorState(value: unknown, name: string): SupervisorStateV1 {
  const raw = closed(value, name, SUPERVISOR_FIELDS);
  const pid = raw.pid === null ? null : integer(raw.pid, `${name} pid`, 1, 2 ** 31 - 1);
  const startedAt = nullable(raw.started_at, `${name} started at`, timestamp);
  // A recorded pid without a start time cannot be aged, and a start time
  // without a pid names nothing to signal. Either both or neither.
  if ((pid === null) !== (startedAt === null)) {
    fail(`${name} must record a pid and a start time together.`);
  }
  const startToken = raw.start_token === null ? null : text(raw.start_token, `${name} start token`, 128);
  // A start token without a pid identifies nothing.
  if (startToken !== null && pid === null) {
    fail(`${name} cannot carry a process start token without a pid.`);
  }
  return Object.freeze({
    pid,
    started_at: startedAt,
    start_token: startToken,
    last_exit_code: raw.last_exit_code === null ? null : integer(raw.last_exit_code, `${name} exit code`, -256, 256),
    // Bounded and redacted by the caller: a spawn failure message can carry a
    // full install path, which section 14 keeps out of diagnostics by default.
    last_error: raw.last_error === null ? null : text(raw.last_error, `${name} last error`, 300),
  });
}

export interface RuntimeRecordV1 {
  readonly schema_version: typeof RUNTIME_STATE_SCHEMA;
  readonly runtime_instance_id: string;
  readonly install_dir: string;
  readonly installation: RuntimeInstallationReceiptV1 | null;
  readonly supervisor: SupervisorStateV1;
  readonly requested_mode: RequestedExecutionMode;
  /** Path to the owner-private credential file. Never the credential itself. */
  readonly credential_file: string | null;
  readonly updated_at: string;
}

const RUNTIME_RECORD_FIELDS = [
  "schema_version", "runtime_instance_id", "install_dir", "installation",
  "supervisor", "requested_mode", "credential_file", "updated_at",
] as const;

export function validateRuntimeRecord(value: unknown, name = "Runtime record"): RuntimeRecordV1 {
  const raw = closed(value, name, RUNTIME_RECORD_FIELDS);
  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, RUNTIME_STATE_SCHEMA, name) as typeof RUNTIME_STATE_SCHEMA,
    runtime_instance_id: ident(raw.runtime_instance_id, `${name} runtime instance id`),
    install_dir: absolutePath(raw.install_dir, `${name} install directory`),
    installation: raw.installation === null
      ? null
      : validateRuntimeInstallationReceipt(raw.installation, `${name} installation receipt`),
    supervisor: supervisorState(raw.supervisor, `${name} supervisor state`),
    // The operator's REQUESTED mode. Effective mode is never stored here: it
    // belongs to ATSv2 and is observed fresh, so a stale file cannot answer
    // "what authority does the runtime honour" (section 7.2).
    requested_mode: choice(raw.requested_mode, REQUESTED_EXECUTION_MODES, `${name} requested mode`),
    credential_file: raw.credential_file === null
      ? null
      : absolutePath(raw.credential_file, `${name} credential file`),
    updated_at: timestamp(raw.updated_at, `${name} updated at`),
  });
}

export interface DataRecordV1 {
  readonly schema_version: typeof DATA_STATE_SCHEMA;
  readonly profile: DataProfileV1;
  readonly last_probe: DataProbeReceiptV1 | null;
  readonly updated_at: string;
}

const DATA_RECORD_FIELDS = ["schema_version", "profile", "last_probe", "updated_at"] as const;

export function validateDataRecord(value: unknown, name = "Data record"): DataRecordV1 {
  const raw = closed(value, name, DATA_RECORD_FIELDS);
  const profile = validateDataProfile(raw.profile, `${name} profile`);
  const probe = raw.last_probe === null ? null : validateDataProbeReceipt(raw.last_probe, `${name} last probe`);
  // A probe receipt for a different profile is evidence about something else.
  // Keeping it would let an edited profile inherit the old profile's verified
  // state, which is exactly the configured-reads-as-verified failure of
  // section 8.
  if (probe && probe.profile_id !== profile.profile_id) {
    fail(`${name} carries a probe receipt for a different data profile.`);
  }
  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, DATA_STATE_SCHEMA, name) as typeof DATA_STATE_SCHEMA,
    profile,
    last_probe: probe,
    updated_at: timestamp(raw.updated_at, `${name} updated at`),
  });
}

export interface DashboardRecordV1 {
  readonly schema_version: typeof DASHBOARD_STATE_SCHEMA;
  readonly enabled: boolean;
  readonly journal_preferences: JournalPreferencesV1;
  readonly updated_at: string;
}

const DASHBOARD_RECORD_FIELDS = ["schema_version", "enabled", "journal_preferences", "updated_at"] as const;

export function validateDashboardRecord(value: unknown, name = "Dashboard record"): DashboardRecordV1 {
  const raw = closed(value, name, DASHBOARD_RECORD_FIELDS);
  if (typeof raw.enabled !== "boolean") fail(`${name} enablement must be a boolean.`);
  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, DASHBOARD_STATE_SCHEMA, name) as typeof DASHBOARD_STATE_SCHEMA,
    // Enablement only. No port, no session token, no bound address: the
    // dashboard binds a RANDOM loopback port per run (section 12.1), so a
    // remembered one would be a stale claim about what is listening.
    enabled: raw.enabled,
    journal_preferences: validateJournalPreferences(raw.journal_preferences, `${name} journal preferences`),
    updated_at: timestamp(raw.updated_at, `${name} updated at`),
  });
}

async function readRecord<T>(path: string, validate: (value: unknown) => T): Promise<T | null> {
  await refuseSymlinkedPath(path);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately not `null`. See the module header: a corrupt file must not
    // masquerade as an absent one.
    throw new Error("ATS runtime state is unreadable. Inspect it before continuing; it was not overwritten.");
  }
  return validate(parsed);
}

export function readRuntimeRecord(path: string): Promise<RuntimeRecordV1 | null> {
  return readRecord(path, value => validateRuntimeRecord(value));
}

export function readDataRecord(path: string): Promise<DataRecordV1 | null> {
  return readRecord(path, value => validateDataRecord(value));
}

export function readDashboardRecord(path: string): Promise<DashboardRecordV1 | null> {
  return readRecord(path, value => validateDashboardRecord(value));
}

/** Every write re-validates, so a caller cannot persist a record it built wrong. */
export async function writeRuntimeRecord(path: string, record: RuntimeRecordV1): Promise<void> {
  await writePrivateFile(path, JSON.stringify(validateRuntimeRecord(record), null, 2) + "\n");
}

export async function writeDataRecord(path: string, record: DataRecordV1): Promise<void> {
  await writePrivateFile(path, JSON.stringify(validateDataRecord(record), null, 2) + "\n");
}

export async function writeDashboardRecord(path: string, record: DashboardRecordV1): Promise<void> {
  await writePrivateFile(path, JSON.stringify(validateDashboardRecord(record), null, 2) + "\n");
}

/** A fresh, uninstalled runtime record. Nothing here claims a runtime exists. */
export function emptyRuntimeRecord(input: {
  runtimeInstanceId: string;
  installDir: string;
  requestedMode: RequestedExecutionMode;
  updatedAt: string;
}): RuntimeRecordV1 {
  return validateRuntimeRecord({
    schema_version: RUNTIME_STATE_SCHEMA,
    runtime_instance_id: input.runtimeInstanceId,
    install_dir: input.installDir,
    installation: null,
    supervisor: { pid: null, started_at: null, start_token: null, last_exit_code: null, last_error: null },
    requested_mode: input.requestedMode,
    credential_file: null,
    updated_at: input.updatedAt,
  });
}

export function defaultDashboardRecord(updatedAt: string): DashboardRecordV1 {
  return validateDashboardRecord({
    schema_version: DASHBOARD_STATE_SCHEMA,
    enabled: false,
    journal_preferences: defaultJournalPreferences(),
    updated_at: updatedAt,
  });
}
