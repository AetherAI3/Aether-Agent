// `aether ats doctor` — Spec 2 step 2.7 and the step 7 receipt summary.
//
// The report's job is to be HONEST rather than green. Section 5 step 7 lists
// states like "Configured; not yet verified" and "6 compiled; 0 active", and
// section 17 requires setup to finish with `0 compiled` while leaving strategy
// readiness incomplete. So every axis carries its own state and the overall
// `ready` flag is the AND of the axes that actually gate work — a doctor that
// prints all-clear while nothing can run is worse than no doctor.
//
// Nothing here writes. A diagnostic that repairs on read cannot be run twice
// to compare, and section 12.3 puts runtime restart behind an explicit local
// confirmation rather than a status call.

import { ageProbeReceipt, formatDataTruth, type DataProbeReceiptV1 } from "../ats_contracts/data.js";
import { formatStrategyReadiness, strategiesReady, type StrategyReadiness } from "../ats_contracts/strategy.js";
import { formatRuntimeSnapshot, type RuntimeCapabilitySnapshotV1 } from "../ats_contracts/runtime.js";
import { runtimeStatus, type SupervisorDeps } from "./supervisor.js";
import {
  readDashboardRecord,
  readDataRecord,
  readRuntimeRecord,
  type DashboardRecordV1,
  type DataRecordV1,
  type RuntimeRecordV1,
} from "./store.js";

export const ATS_DOCTOR_SCHEMA = "aether.ats.doctor/1" as const;

/**
 * `ok` means this axis is doing its job. `incomplete` means it is honestly
 * unfinished and the operator has more to do — NOT a failure. `unavailable`
 * means something that should exist does not, and `degraded` means it exists
 * but is not trustworthy right now.
 */
export type AxisState = "ok" | "incomplete" | "degraded" | "unavailable";

export interface DoctorAxis {
  readonly name: string;
  readonly state: AxisState;
  /** Bounded and path-free, so the whole report is safe for a support bundle. */
  readonly detail: string;
  /** Whether this axis gates real work. Informational axes do not. */
  readonly gating: boolean;
}

export interface AtsDoctorReport {
  readonly schema: typeof ATS_DOCTOR_SCHEMA;
  readonly generated_at: string;
  readonly ready: boolean;
  readonly axes: readonly DoctorAxis[];
}

export interface DoctorInput {
  readonly runtimeStatePath: string;
  readonly dataProfilePath: string;
  readonly dashboardStatePath: string;
  /** Strategy counts from a scan. Absent when no strategy folder is bound yet. */
  readonly strategies?: StrategyReadiness;
  /** Whether a memory persistence receipt verified, from the existing setup path. */
  readonly memoryVerified?: boolean;
  /** Whether a broker connector is authenticated. Owned by Spec 1; read-only here. */
  readonly brokerageAuthenticated?: boolean;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

function stamp(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function runtimeAxis(record: RuntimeRecordV1 | null, snapshot: RuntimeCapabilitySnapshotV1 | null): DoctorAxis {
  if (!record) {
    return { name: "Runtime", state: "unavailable", detail: "No ATS runtime is configured on this device.", gating: true };
  }
  if (!record.installation) {
    // An adopted-but-unverified install lands here, which is the point: it is
    // present and still cannot be started.
    return {
      name: "Runtime",
      state: "unavailable",
      detail: "No verified ATS runtime installation. Provenance was never proven, so it cannot start.",
      gating: true,
    };
  }
  const version = record.installation.runtime_version;
  if (!snapshot || snapshot.state === "stopped" || snapshot.state === "failed") {
    return {
      name: "Runtime",
      state: "incomplete",
      detail: `Installed ${version}; provenance verified; not running. ${snapshot?.effective_reason ?? ""}`.trim(),
      gating: true,
    };
  }
  if (snapshot.state === "degraded" || snapshot.state === "starting") {
    return { name: "Runtime", state: "degraded", detail: `${version} · ${formatRuntimeSnapshot(snapshot)}`, gating: true };
  }
  return { name: "Runtime", state: "ok", detail: `${version} · ${formatRuntimeSnapshot(snapshot)}`, gating: true };
}

function executionAxis(record: RuntimeRecordV1 | null, snapshot: RuntimeCapabilitySnapshotV1 | null): DoctorAxis {
  const requested = record?.requested_mode ?? "observe";
  const effective = snapshot?.effective_mode ?? "offline";
  // Requested and effective are printed side by side and never collapsed
  // (section 7.2). This axis never gates: a downgrade to observe is a correct
  // outcome, not a fault.
  return {
    name: "Execution",
    state: effective === "offline" ? "incomplete" : "ok",
    detail: `Requested ${requested}; effective ${effective}.`,
    gating: false,
  };
}

function dataAxis(record: DataRecordV1 | null, now: number): DoctorAxis {
  if (!record) {
    return { name: "Data", state: "incomplete", detail: "No data provider configured.", gating: false };
  }
  if (record.profile.provider === "none") {
    return { name: "Data", state: "incomplete", detail: "No data provider selected.", gating: false };
  }
  const probe: DataProbeReceiptV1 | null = record.last_probe ? ageProbeReceipt(record.last_probe, now) : null;
  const truth = formatDataTruth(record.profile, record.last_probe, now).split("\n").join(" · ");
  if (!probe) {
    return { name: "Data", state: "incomplete", detail: truth, gating: false };
  }
  // Data gates ACTIVATION, not setup. Section 5 permits finishing setup with
  // data configured and unverified, so this axis reports the truth without
  // failing the whole report.
  return { name: "Data", state: probe.state === "verified" ? "ok" : "degraded", detail: truth, gating: false };
}

function strategyAxis(counts: StrategyReadiness | undefined): DoctorAxis {
  if (!counts) {
    return { name: "Strategies", state: "incomplete", detail: "No strategy folder scanned.", gating: false };
  }
  return {
    name: "Strategies",
    // Section 5 step 5: zero compiled is a permitted, honestly-reported outcome
    // that leaves readiness incomplete rather than marking setup failed.
    state: strategiesReady(counts) ? "ok" : "incomplete",
    detail: formatStrategyReadiness(counts),
    gating: false,
  };
}

function dashboardAxis(record: DashboardRecordV1 | null): DoctorAxis {
  if (!record || !record.enabled) {
    return { name: "Dashboard", state: "incomplete", detail: "Local dashboard not enabled.", gating: false };
  }
  return { name: "Dashboard", state: "ok", detail: "Available locally on loopback.", gating: false };
}

/**
 * Build the report. Runtime status is OBSERVED here rather than read from the
 * record, so a doctor run after a crash reports `not running` instead of
 * echoing a stale pid.
 */
export async function buildAtsDoctorReport(
  input: DoctorInput,
  deps: SupervisorDeps = {},
): Promise<AtsDoctorReport> {
  const generatedAt = stamp(input.now);
  const now = Date.parse(generatedAt);

  const runtimeRecord = await readRuntimeRecord(input.runtimeStatePath);
  const dataRecord = await readDataRecord(input.dataProfilePath);
  const dashboardRecord = await readDashboardRecord(input.dashboardStatePath);

  const snapshot = runtimeRecord
    ? await runtimeStatus(runtimeRecord, { ...deps, ...(input.now ? { now: input.now } : {}) }, input.signal)
    : null;

  const axes: DoctorAxis[] = [
    {
      name: "Memory",
      state: input.memoryVerified === true ? "ok" : "incomplete",
      detail: input.memoryVerified === true
        ? "Persistence verified."
        : "Persistence not verified in this run.",
      gating: false,
    },
    runtimeAxis(runtimeRecord, snapshot),
    dataAxis(dataRecord, now),
    strategyAxis(input.strategies),
    {
      name: "Brokerage",
      // Owned by Spec 1's connector. The doctor reports it and never asserts
      // it: this module has no broker authority to check with.
      state: input.brokerageAuthenticated === true ? "ok" : "incomplete",
      detail: input.brokerageAuthenticated === true
        ? "A connector is authenticated."
        : "Authentication required. Local execution authority is separate from this report.",
      gating: false,
    },
    executionAxis(runtimeRecord, snapshot),
    dashboardAxis(dashboardRecord),
  ];

  return {
    schema: ATS_DOCTOR_SCHEMA,
    generated_at: generatedAt,
    // Only gating axes decide readiness, so an unverified data feed or zero
    // compiled strategies is reported honestly without claiming the install
    // itself is broken.
    ready: axes.every(axis => !axis.gating || axis.state === "ok"),
    axes,
  };
}

const SYMBOLS: Readonly<Record<AxisState, string>> = Object.freeze({
  ok: "ok",
  incomplete: "incomplete",
  degraded: "degraded",
  unavailable: "unavailable",
});

/**
 * Human rendering. State is spelled out as a word rather than carried by colour
 * alone, because section 13 requires health not to depend on colour.
 */
export function renderAtsDoctorReport(report: AtsDoctorReport): string {
  const width = Math.max(...report.axes.map(axis => axis.name.length));
  const lines = report.axes.map(axis =>
    `  ${axis.name.padEnd(width)}  ${SYMBOLS[axis.state].padEnd(11)}  ${axis.detail}`,
  );
  const headline = report.ready
    ? "ATS ready · runtime verified and running"
    : "ATS not ready · see the axes below";
  return [headline, ...lines, ""].join("\n");
}

/** `--json` output. Stable field names; nothing here is a secret. */
export function atsDoctorJson(report: AtsDoctorReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}
