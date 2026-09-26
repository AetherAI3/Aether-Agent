/** Read-only Predator Drive client for an already bound Cloud staff session.
 *
 * The ordinary Agent device login produces an aek_ PAT. That credential is
 * refused at the local gate for these staff routes, and an MCP broker grant is
 * not treated as a Cloud operator session. Cloud validates the actual staff
 * identity and observer membership on every request.
 */

import type { AppContext } from "./context.js";
import { isApiKeyToken } from "./auth.js";
import { HttpError } from "./errors.js";

export const DRIVE_ROOT = "/internal/dev/supercluster/predator-drive";
const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,79}$/;

export type DriveReadErrorCode =
  | "AUTH_REQUIRED"
  | "STAFF_SESSION_REQUIRED"
  | "LANE_ID_INVALID"
  | "LANE_NOT_FOUND"
  | "DRIVE_INTAKE_INVALID"
  | "CLOUD_ROUTE_UNAVAILABLE"
  | "CLOUD_RESPONSE_INVALID";

export class DriveReadError extends Error {
  constructor(readonly code: DriveReadErrorCode) {
    super(code);
    this.name = "DriveReadError";
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function codes(value: unknown): string[] | null {
  return Array.isArray(value) && value.length <= 64 &&
    value.every((item) => typeof item === "string" && CODE.test(item))
    ? value as string[] : null;
}

async function requireStaffSession(ctx: AppContext): Promise<void> {
  const token = await ctx.tokens.get();
  if (!token) throw new DriveReadError("AUTH_REQUIRED");
  if (isApiKeyToken(token) || token.startsWith("agt_")) {
    throw new DriveReadError("STAFF_SESSION_REQUIRED");
  }
}

function routeError(error: unknown, laneLookup = false): DriveReadError {
  if (error instanceof DriveReadError) return error;
  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403) return new DriveReadError("STAFF_SESSION_REQUIRED");
    if (error.status === 404 && laneLookup) return new DriveReadError("LANE_NOT_FOUND");
    if (error.status === 422 || error.status === 413) return new DriveReadError("DRIVE_INTAKE_INVALID");
  }
  // Never render the upstream body: it can contain private scope or tokens.
  return new DriveReadError("CLOUD_ROUTE_UNAVAILABLE");
}

export interface DrivePreview {
  release_gate: "G0";
  decision: "CAPABILITY_BLOCKED" | "INVALID_HOST";
  lane_id: null;
  selected_host: null;
  paid_hold: false;
  spent_usd: 0;
  blockers: string[];
}

export async function previewDrive(ctx: AppContext, intake: Record<string, unknown>): Promise<DrivePreview> {
  await requireStaffSession(ctx);
  let value: unknown;
  try {
    value = await ctx.api.postJson<unknown>(`${DRIVE_ROOT}/preview`, intake, undefined, 10_000);
  } catch (error) {
    throw routeError(error);
  }
  const row = object(value);
  const blockers = codes(row?.["blockers"]);
  if (!row || row["release_gate"] !== "G0" ||
      (row["decision"] !== "CAPABILITY_BLOCKED" && row["decision"] !== "INVALID_HOST") ||
      row["lane_id"] !== null || row["selected_host"] !== null ||
      row["paid_hold"] !== false || row["spent_usd"] !== 0 || !blockers || blockers.length === 0) {
    throw new DriveReadError("CLOUD_RESPONSE_INVALID");
  }
  return {
    release_gate: "G0",
    decision: row["decision"],
    lane_id: null,
    selected_host: null,
    paid_hold: false,
    spent_usd: 0,
    blockers,
  };
}

export interface DriveMissionMetadata {
  lane_id: string;
  display_alias: string;
  state: string;
  reason: string;
  mode: string;
  source_repo: string;
  source_sha: string;
  scope_digest: string;
  cap_cents: number;
  spent_cents: number;
  requested_host: string;
  selected_host: string | null;
  driver_mode: string;
  team_revision: number;
  controller_user_id: string;
  controller_generation: number;
  in_flight_step_id: string | null;
  step_state: string | null;
  host_lease_id: string | null;
  last_event_cursor: number;
  custody_ref: string | null;
  paid_hold: boolean;
}

function nonnegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedString(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length <= max;
}

function nullableString(value: unknown): value is string | null {
  return value === null || boundedString(value);
}

function pathForLane(laneId: string): string {
  if (!LANE_ID.test(laneId)) throw new DriveReadError("LANE_ID_INVALID");
  return `${DRIVE_ROOT}/missions/${encodeURIComponent(laneId)}`;
}

export async function getDriveMission(ctx: AppContext, laneId: string): Promise<DriveMissionMetadata> {
  const path = pathForLane(laneId);
  await requireStaffSession(ctx);
  let value: unknown;
  try {
    value = await ctx.api.getJson<unknown>(path, undefined, 10_000);
  } catch (error) {
    throw routeError(error, true);
  }
  const row = object(value);
  if (!row || row["lane_id"] !== laneId || !boundedString(row["display_alias"], 128) ||
      !boundedString(row["state"], 80) || !boundedString(row["reason"]) ||
      !boundedString(row["mode"], 80) || !boundedString(row["source_repo"]) ||
      !boundedString(row["source_sha"], 128) || !boundedString(row["scope_digest"], 128) ||
      !nonnegativeInt(row["cap_cents"]) || !nonnegativeInt(row["spent_cents"]) ||
      !boundedString(row["requested_host"], 80) || !nullableString(row["selected_host"]) ||
      !boundedString(row["driver_mode"], 80) || !nonnegativeInt(row["team_revision"]) ||
      !boundedString(row["controller_user_id"], 128) || !nonnegativeInt(row["controller_generation"]) ||
      !nullableString(row["in_flight_step_id"]) || !nullableString(row["step_state"]) ||
      !nullableString(row["host_lease_id"]) || !nonnegativeInt(row["last_event_cursor"]) ||
      !nullableString(row["custody_ref"]) || typeof row["paid_hold"] !== "boolean") {
    throw new DriveReadError("CLOUD_RESPONSE_INVALID");
  }
  return {
    lane_id: laneId, display_alias: row["display_alias"],
    state: row["state"], reason: row["reason"], mode: row["mode"],
    source_repo: row["source_repo"], source_sha: row["source_sha"], scope_digest: row["scope_digest"],
    cap_cents: row["cap_cents"], spent_cents: row["spent_cents"],
    requested_host: row["requested_host"], selected_host: row["selected_host"],
    driver_mode: row["driver_mode"], team_revision: row["team_revision"],
    controller_user_id: row["controller_user_id"], controller_generation: row["controller_generation"],
    in_flight_step_id: row["in_flight_step_id"], step_state: row["step_state"],
    host_lease_id: row["host_lease_id"], last_event_cursor: row["last_event_cursor"],
    custody_ref: row["custody_ref"], paid_hold: row["paid_hold"],
  };
}

export interface DriveEventPage {
  lane_id: string;
  events: Array<{
    cursor: number;
    kind: string;
    actor_user_id: string;
    reason: string;
    generation: number;
    recorded_at: string;
    custody_ref: string | null;
  }>;
  next_cursor: number;
  has_more: boolean;
}

export async function getDriveEvents(
  ctx: AppContext, laneId: string, afterCursor = 0, limit = 50,
): Promise<DriveEventPage> {
  const path = pathForLane(laneId);
  if (!nonnegativeInt(afterCursor) || !nonnegativeInt(limit) || limit < 1 || limit > 200) {
    throw new DriveReadError("DRIVE_INTAKE_INVALID");
  }
  await requireStaffSession(ctx);
  let value: unknown;
  try {
    value = await ctx.api.getJson<unknown>(
      `${path}/events?after_cursor=${afterCursor}&limit=${limit}`, undefined, 10_000,
    );
  } catch (error) {
    throw routeError(error, true);
  }
  const row = object(value);
  if (!row || row["lane_id"] !== laneId || !Array.isArray(row["events"]) ||
      row["events"].length > limit || !nonnegativeInt(row["next_cursor"]) ||
      typeof row["has_more"] !== "boolean") {
    throw new DriveReadError("CLOUD_RESPONSE_INVALID");
  }
  let previous = afterCursor;
  const events: DriveEventPage["events"] = [];
  for (const value of row["events"]) {
    const event = object(value);
    if (!event || !nonnegativeInt(event["cursor"]) || event["cursor"] <= previous ||
        !boundedString(event["kind"], 80) || !boundedString(event["actor_user_id"], 128) ||
        !boundedString(event["reason"]) || !nonnegativeInt(event["generation"]) ||
        !boundedString(event["recorded_at"], 128) || !nullableString(event["custody_ref"])) {
      throw new DriveReadError("CLOUD_RESPONSE_INVALID");
    }
    previous = event["cursor"];
    events.push({
      cursor: event["cursor"], kind: event["kind"], actor_user_id: event["actor_user_id"],
      reason: event["reason"], generation: event["generation"],
      recorded_at: event["recorded_at"], custody_ref: event["custody_ref"],
    });
  }
  if (row["next_cursor"] !== previous) throw new DriveReadError("CLOUD_RESPONSE_INVALID");
  return { lane_id: laneId, events, next_cursor: previous, has_more: row["has_more"] };
}
