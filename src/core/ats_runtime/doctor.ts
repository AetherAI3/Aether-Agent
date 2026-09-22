// `aether ats doctor` — Spec 2 step 2.7 and the step 7 receipt summary.
//
// The report's job is to be HONEST rather than green. Section 5 step 7 lists
// states like "Configured; not yet verified" and "6 compiled; 0 active", and
// section 17 requires setup to finish with `0 compiled` while leaving strategy
// readiness incomplete. So every axis carries its own state, and readiness is
// SCOPED rather than a single flag — a doctor that prints all-clear while
// nothing can run is worse than no doctor.
//
// Nothing here writes. A diagnostic that repairs on read cannot be run twice
// to compare, and section 12.3 puts runtime restart behind an explicit local
// confirmation rather than a status call.

import { ageProbeReceipt, formatDataTruth, type DataProbeReceiptV1 } from "../ats_contracts/data.js";
import { formatStrategyReadiness, strategiesReady, type StrategyReadiness } from "../ats_contracts/strategy.js";
import { formatRuntimeSnapshot, type RuntimeCapabilitySnapshotV1 } from "../ats_contracts/runtime.js";
import { runtimeStatus, type SupervisorDeps } from "./supervisor.js";
import { readSetupState, setupComplete } from "./wizard.js";
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
}

/**
 * Scoped readiness. There is deliberately no single `ready` boolean.
 *
 * An earlier version had one, computed from the runtime axis alone, so the
 * report could say "ATS ready" with zero compiled strategies, no verified data
 * and no broker authentication. That is the same dishonest-readiness failure
 * section 2.1 calls out for strategy counts, one level up: a single flag
 * cannot answer five different questions, so it ends up answering the easiest
 * one and implying the rest.
 *
 * Each field answers exactly one question and none of them hides behind
 * another.
 */
export interface AtsReadiness {
  /** Every wizard step finished. Says nothing about whether anything runs. */
  readonly setup_complete: boolean;
  /** A provenance-verified runtime is installed AND currently healthy. */
  readonly runtime_ready: boolean;
  /** At least one strategy actually compiled. */
  readonly strategy_ready: boolean;
  /** Everything an observe/paper activation needs: runtime, data, a strategy. */
  readonly paper_ready: boolean;
  /** Live broker execution. Always false in this release; see section 19. */
  readonly broker_live_ready: boolean;
}

export interface AtsDoctorReport {
  readonly schema: typeof ATS_DOCTOR_SCHEMA;
  readonly generated_at: string;
  readonly readiness: AtsReadiness;
  readonly axes: readonly DoctorAxis[];
}

export interface DoctorInput {
  readonly runtimeStatePath: string;
  readonly dataProfilePath: string;
  readonly dashboardStatePath: string;
  /** Wizard progress. Absent when setup has not been started on this device. */
  readonly setupStatePath?: string;
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
    return { name: "Runtime", state: "unavailable", detail: "No ATS runtime is configured on this device." };
  }
  if (!record.installation) {
    // An adopted-but-unverified install lands here, which is the point: it is
    // present and still cannot be started.
    return {
      name: "Runtime",
      state: "unavailable",
      detail: "No verified ATS runtime installation. Provenance was never proven, so it cannot start.",
    };
  }
  const version = record.installation.runtime_version;
  if (!snapshot || snapshot.state === "stopped" || snapshot.state === "failed") {
    return {
      name: "Runtime",
      state: "incomplete",
      detail: `Installed ${version}; provenance verified; not running. ${snapshot?.effective_reason ?? ""}`.trim(),
    };
  }
  if (snapshot.state === "degraded" || snapshot.state === "starting") {
    return { name: "Runtime", state: "degraded", detail: `${version} · ${formatRuntimeSnapshot(snapshot)}` };
  }
  return { name: "Runtime", state: "ok", detail: `${version} · ${formatRuntimeSnapshot(snapshot)}` };
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
  };
}

function dataAxis(record: DataRecordV1 | null, now: number): DoctorAxis {
  if (!record) {
    return { name: "Data", state: "incomplete", detail: "No data provider configured." };
  }
  if (record.profile.provider === "none") {
    return { name: "Data", state: "incomplete", detail: "No data provider selected." };
  }
  const probe: DataProbeReceiptV1 | null = record.last_probe ? ageProbeReceipt(record.last_probe, now) : null;
  const truth = formatDataTruth(record.profile, record.last_probe, now).split("\n").join(" · ");
  if (!probe) {
    return { name: "Data", state: "incomplete", detail: truth };
  }
  if (probe.state === "verified" && !dataFullyVerified(record, now)) {
    return { name: "Data", state: "degraded", detail: `${truth} · not every configured symbol was verified; run a full probe` };
  }
  // Data gates ACTIVATION, not setup. Section 5 permits finishing setup with
  // data configured and unverified, so this axis reports the truth without
  // failing the whole report.
  return { name: "Data", state: probe.state === "verified" ? "ok" : "degraded", detail: truth };
}

function dataFullyVerified(record: DataRecordV1, now: number): boolean {
  const { profile, last_probe: probe } = record;
  return profile.provider !== "none"
    && profile.symbols.length > 0
    && probe !== null
    && probe.profile_id === profile.profile_id
    && probe.provider === profile.provider
    && ageProbeReceipt(probe, now).state === "verified"
    && profile.symbols.every(symbol => probe.symbols_verified.includes(symbol));
}

function strategyAxis(counts: StrategyReadiness | undefined): DoctorAxis {
  if (!counts) {
    return { name: "Strategies", state: "incomplete", detail: "No strategy folder scanned." };
  }
  return {
    name: "Strategies",
    // Section 5 step 5: zero compiled is a permitted, honestly-reported outcome
    // that leaves readiness incomplete rather than marking setup failed.
    state: strategiesReady(counts) ? "ok" : "incomplete",
    detail: formatStrategyReadiness(counts),
  };
}

function dashboardAxis(record: DashboardRecordV1 | null): DoctorAxis {
  if (!record || !record.enabled) {
    return { name: "Dashboard", state: "incomplete", detail: "Local dashboard not enabled." };
  }
  return { name: "Dashboard", state: "ok", detail: "Available locally on loopback." };
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
    },
    executionAxis(runtimeRecord, snapshot),
    dashboardAxis(dashboardRecord),
  ];

  const runtimeReady = runtimeRecord !== null
    && runtimeRecord.installation !== null
    && snapshot !== null
    && snapshot.state === "healthy";
  const strategyReady = input.strategies !== undefined && strategiesReady(input.strategies);
  const dataVerified = dataRecord ? dataFullyVerified(dataRecord, now) : false;

  const setupState = input.setupStatePath ? await readSetupState(input.setupStatePath) : null;

  return {
    schema: ATS_DOCTOR_SCHEMA,
    generated_at: generatedAt,
    readiness: {
      // Progress through the wizard, and nothing more. A finished wizard whose
      // runtime step was skipped is still `setup_complete`.
      setup_complete: setupState !== null && setupComplete(setupState),
      runtime_ready: runtimeReady,
      strategy_ready: strategyReady,
      // Everything an observe or paper activation actually needs. Section 9
      // admits an activation only with a compiled artifact, a healthy runtime
      // and a FRESH verified probe, so all three are required here rather than
      // implied by the runtime being up.
      paper_ready: runtimeReady && strategyReady && dataVerified,
      // Section 19 lists live trading as a non-goal for this release, so this
      // is pinned false rather than computed. Making it derivable would invite
      // a future change to quietly turn it true.
      broker_live_ready: false,
    },
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
  const r = report.readiness;
  // Every scope is printed. A reader must not have to infer that paper is
  // blocked because they happened to notice the strategy axis.
  const scopes = [
    `setup ${r.setup_complete ? "complete" : "incomplete"}`,
    `runtime ${r.runtime_ready ? "ready" : "not ready"}`,
    `strategies ${r.strategy_ready ? "ready" : "not ready"}`,
    `paper ${r.paper_ready ? "ready" : "not ready"}`,
    `live ${r.broker_live_ready ? "ready" : "not ready"}`,
  ].join(" · ");
  const headline = r.paper_ready
    ? "ATS ready for observe and paper activation"
    : "ATS not ready · see the scopes and axes below";
  return [headline, `  ${scopes}`, "", ...lines, ""].join("\n");
}

/** `--json` output. Stable field names; nothing here is a secret. */
export function atsDoctorJson(report: AtsDoctorReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}
