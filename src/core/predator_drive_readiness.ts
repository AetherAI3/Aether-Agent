/** Read-only Aether Agent bridge to Cloud's staff-owned Drive G0 diagnosis. */

import type { AppContext } from "./context.js";
import { isApiKeyToken } from "./auth.js";
import { HttpError } from "./errors.js";

export const PREDATOR_DRIVE_DIAGNOSE_PATH =
  "/internal/dev/supercluster/predator-drive/diagnose?mode=oss&host=auto";

type DriveBlocker =
  | "AUTH_REQUIRED"
  | "STAFF_SESSION_REQUIRED"
  | "CLOUD_ROUTE_UNAVAILABLE"
  | "CLOUD_DIAGNOSE_INVALID";

export interface DriveReadinessReport {
  schemaVersion: 1;
  source: "LOCAL_CREDENTIAL_GATE" | "CLOUD_G0_DIAGNOSE" | "CLOUD_ROUTE_ERROR";
  releaseGate: "G0";
  decision: "CAPABILITY_BLOCKED" | "INVALID_HOST";
  missionAdmitted: false;
  laneId: null;
  selectedHost: null;
  paidHold: false;
  spentUsd: 0;
  blockers: string[];
  nextStep: string;
}

function blocked(
  source: DriveReadinessReport["source"],
  blockers: string[],
  nextStep: string,
  decision: DriveReadinessReport["decision"] = "CAPABILITY_BLOCKED",
): DriveReadinessReport {
  return {
    schemaVersion: 1,
    source,
    releaseGate: "G0",
    decision,
    missionAdmitted: false,
    laneId: null,
    selectedHost: null,
    paidHold: false,
    spentUsd: 0,
    blockers,
    nextStep,
  };
}

const CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
function codes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 64 || !value.every((item) =>
    typeof item === "string" && CODE.test(item))) return null;
  return value;
}

function fromBoard(value: unknown): DriveReadinessReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return blocked("CLOUD_ROUTE_ERROR", ["CLOUD_DIAGNOSE_INVALID"], "The Cloud diagnosis response failed validation.");
  }
  const board = value as Record<string, unknown>;
  if (board["source"] !== "G0_STATIC_POLICY_INVENTORY" || board["mode"] !== "oss" ||
      board["requested_host"] !== "auto" || board["selection_state"] !== "UNRESOLVED" ||
      board["live_occupancy"] !== "NOT_READ" || board["selected_host"] !== null ||
      board["reservation_id"] !== null || board["dispatch_eligible"] !== false ||
      !["CAPABILITY_BLOCKED", "INVALID_HOST"].includes(String(board["decision"]))) {
    return blocked("CLOUD_ROUTE_ERROR", ["CLOUD_DIAGNOSE_INVALID"], "The Cloud diagnosis response failed validation.");
  }
  const global = codes(board["global_blockers"]);
  const candidates = board["candidates"];
  if (!global || !Array.isArray(candidates) || candidates.length > 3) {
    return blocked("CLOUD_ROUTE_ERROR", ["CLOUD_DIAGNOSE_INVALID"], "The Cloud diagnosis response failed validation.");
  }
  const all = [...global];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return blocked("CLOUD_ROUTE_ERROR", ["CLOUD_DIAGNOSE_INVALID"], "The Cloud diagnosis response failed validation.");
    }
    const row = candidate as Record<string, unknown>;
    const missing = codes(row["missing_proofs"]);
    if (!["pilot", "vps3", "vps6"].includes(String(row["host"])) ||
        row["dispatch_eligible"] !== false || !missing) {
      return blocked("CLOUD_ROUTE_ERROR", ["CLOUD_DIAGNOSE_INVALID"], "The Cloud diagnosis response failed validation.");
    }
    all.push(...missing);
  }
  return blocked(
    "CLOUD_G0_DIAGNOSE",
    [...new Set(all)],
    "Drive is at G0. Use the hosted staff MCP after the runtime and Cloud host fence are proven.",
    board["decision"] as DriveReadinessReport["decision"],
  );
}

/**
 * The installed Agent CLI normally holds an aek_ API key, which cannot grant
 * staff Drive control. Never send it to the staff route or treat an MCP broker
 * connection as execution authority. A bound portal/desktop session may make
 * this one read-only probe; the server still validates the staff role.
 */
export async function diagnosePredatorDrive(ctx: AppContext): Promise<DriveReadinessReport> {
  const token = await ctx.tokens.get();
  if (!token) return blocked("LOCAL_CREDENTIAL_GATE", ["AUTH_REQUIRED"], "Sign in with a bound staff session.");
  if (isApiKeyToken(token) || token.startsWith("agt_")) {
    return blocked(
      "LOCAL_CREDENTIAL_GATE",
      ["STAFF_SESSION_REQUIRED"],
      "Aether Agent's API/device token is not Cloud Predator execute authority. Use a bound staff session.",
    );
  }
  try {
    const board = await ctx.api.getJson<unknown>(PREDATOR_DRIVE_DIAGNOSE_PATH, undefined, 10_000);
    return fromBoard(board);
  } catch (error) {
    const reason: DriveBlocker = error instanceof HttpError && [401, 403].includes(error.status)
      ? "STAFF_SESSION_REQUIRED"
      : "CLOUD_ROUTE_UNAVAILABLE";
    return blocked(
      "CLOUD_ROUTE_ERROR",
      [reason],
      reason === "STAFF_SESSION_REQUIRED"
        ? "Cloud refused this identity. Use a bound staff session with operator role."
        : "The Cloud Drive diagnosis route is unavailable; check the API deployment and VPS2 health.",
    );
  }
}

export function renderPredatorDriveReadiness(report: DriveReadinessReport): string {
  return [
    "Predator Drive: " + report.decision + " (" + report.releaseGate + ")",
    "  authority: " + report.source,
    "  mission: none; host: none; paid hold: no; spend: $0",
    "  blockers: " + report.blockers.join(", "),
    "  next: " + report.nextStep,
  ].join("\n") + "\n";
}
