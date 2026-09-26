import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { AppContext } from "../src/core/context.js";
import { HttpError } from "../src/core/errors.js";
import { cmdMcpDrive } from "../src/commands/mcp_drive.js";
import {
  DRIVE_ROOT, DriveReadError, getDriveEvents, getDriveMission, previewDrive,
} from "../src/core/predator_drive_client.js";

const LANE = "drv-123";
const PREVIEW = {
  release_gate: "G0", decision: "CAPABILITY_BLOCKED", lane_id: null,
  selected_host: null, paid_hold: false, spent_usd: 0,
  blockers: ["SOURCE_PIN_RESOLVER_UNWIRED", "DRIVE_STAGE_ADAPTER_UNPROVEN"],
};
const STATUS = {
  lane_id: LANE, display_alias: "GPAC repair", state: "WAITING_FOR_CLIENT", reason: "checkpoint",
  mode: "oss", source_repo: "gpac/gpac", source_sha: "a".repeat(40), scope_digest: "b".repeat(64),
  cap_cents: 2000, spent_cents: 125, requested_host: "vps3", selected_host: null,
  driver_mode: "client", team_revision: 2, controller_user_id: "user-1",
  controller_generation: 3, in_flight_step_id: null, step_state: null, host_lease_id: null,
  last_event_cursor: 4, custody_ref: null, paid_hold: false,
};
const EVENTS = {
  lane_id: LANE,
  events: [{ cursor: 5, kind: "controller_handoff", actor_user_id: "user-1",
    reason: "handoff", generation: 3, recorded_at: "2026-09-26T12:00:00Z", custody_ref: null }],
  next_cursor: 5, has_more: false,
};

function fixture(token: string | null, response: unknown): {
  ctx: AppContext; calls: Array<{ method: string; path: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  return {
    ctx: {
      flags: { json: true, yes: false, audit: false, cwd: process.cwd() },
      tokens: { get: async () => token },
      api: {
        getJson: async (path: string) => {
          calls.push({ method: "GET", path });
          if (response instanceof Error) throw response;
          return response;
        },
        postJson: async (path: string, body: unknown) => {
          calls.push({ method: "POST", path, body });
          if (response instanceof Error) throw response;
          return response;
        },
      },
      confirm: async () => false,
    } as unknown as AppContext,
    calls,
  };
}

function capture(): { out: Writable; lines: string[] } {
  const lines: string[] = [];
  return { out: { write: (value: string) => (lines.push(value), true) } as unknown as Writable, lines };
}

test("PAT and device credentials cannot reach any Drive staff read route", async () => {
  for (const token of [null, "aek_private_sentinel", "agt_private_sentinel"]) {
    const { ctx, calls } = fixture(token, PREVIEW);
    await assert.rejects(previewDrive(ctx, { corpus: "gpac/gpac" }), DriveReadError);
    await assert.rejects(getDriveMission(ctx, LANE), DriveReadError);
    await assert.rejects(getDriveEvents(ctx, LANE), DriveReadError);
    assert.deepEqual(calls, []);
  }
});

test("staff preview uses the Cloud intake and refuses a success-shaped response", async () => {
  const { ctx, calls } = fixture("bound-staff-session", PREVIEW);
  assert.deepEqual(await previewDrive(ctx, { corpus: "gpac/gpac" }), PREVIEW);
  assert.deepEqual(calls, [{ method: "POST", path: `${DRIVE_ROOT}/preview`, body: { corpus: "gpac/gpac" } }]);
  const bad = fixture("bound-staff-session", { ...PREVIEW, lane_id: LANE });
  await assert.rejects(previewDrive(bad.ctx, {}), { code: "CLOUD_RESPONSE_INVALID" });
});

test("mission metadata and cursor events stay on the same exact lane", async () => {
  const mission = fixture("bound-staff-session", STATUS);
  assert.deepEqual(await getDriveMission(mission.ctx, LANE), STATUS);
  assert.deepEqual(mission.calls, [{ method: "GET", path: `${DRIVE_ROOT}/missions/${LANE}` }]);
  const page = fixture("bound-staff-session", EVENTS);
  assert.deepEqual(await getDriveEvents(page.ctx, LANE, 4, 10), EVENTS);
  assert.deepEqual(page.calls, [{ method: "GET", path: `${DRIVE_ROOT}/missions/${LANE}/events?after_cursor=4&limit=10` }]);
  await assert.rejects(getDriveEvents(page.ctx, "../other", 0, 10), { code: "LANE_ID_INVALID" });
  assert.equal(page.calls.length, 1);
});

test("out-of-scope lanes and malformed event pages fail without leaking server detail", async () => {
  const secret = "private-secret-from-server";
  const forbidden = fixture("bound-staff-session", new HttpError(403, secret));
  await assert.rejects(getDriveMission(forbidden.ctx, LANE), { code: "STAFF_SESSION_REQUIRED" });
  const missing = fixture("bound-staff-session", new HttpError(404, secret));
  await assert.rejects(getDriveMission(missing.ctx, LANE), { code: "LANE_NOT_FOUND" });
  const invalid = fixture("bound-staff-session", { ...EVENTS, next_cursor: 6 });
  await assert.rejects(getDriveEvents(invalid.ctx, LANE, 4, 10), { code: "CLOUD_RESPONSE_INVALID" });
});

test("CLI preview is bounded, read-only and returns a failing G0 exit code", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "aether-drive-preview-")), "intake.json");
  writeFileSync(path, JSON.stringify({ client_request_id: "r1", corpus: "gpac/gpac", spend_cap_usd: 20,
    instructions: "research" }));
  const { ctx, calls } = fixture("bound-staff-session", PREVIEW);
  const { out, lines } = capture();
  assert.equal(await cmdMcpDrive(ctx, ["preview", path], out), 1);
  assert.deepEqual(JSON.parse(lines.join("")), PREVIEW);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "POST");
  assert.match(calls[0]?.path ?? "", /\/preview$/);
});

test("CLI never prints upstream secrets or claims PAT authority", async () => {
  const { ctx, calls } = fixture("aek_private_sentinel", new HttpError(403, "server-secret"));
  const { out, lines } = capture();
  assert.equal(await cmdMcpDrive(ctx, ["status", LANE], out), 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(JSON.parse(lines.join("")), { error: "STAFF_SESSION_REQUIRED" });
  assert.doesNotMatch(lines.join(""), /aek_private|server-secret/);
});
