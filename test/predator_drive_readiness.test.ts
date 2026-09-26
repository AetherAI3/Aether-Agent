import { test } from "node:test";
import assert from "node:assert/strict";
import type { Writable } from "node:stream";
import type { AppContext } from "../src/core/context.js";
import { HttpError } from "../src/core/errors.js";
import { cmdMcp } from "../src/commands/mcp.js";
import {
  diagnosePredatorDrive,
  PREDATOR_DRIVE_DIAGNOSE_PATH,
  renderPredatorDriveReadiness,
} from "../src/core/predator_drive_readiness.js";

const BOARD = {
  mode: "oss",
  requested_host: "auto",
  source: "G0_STATIC_POLICY_INVENTORY",
  decision: "CAPABILITY_BLOCKED",
  global_blockers: ["DURABLE_OPERATOR_LANE_UNWIRED", "HOST_DIRECTIVE_ACK_UNWIRED"],
  candidates: [
    { host: "pilot", dispatch_eligible: false, missing_proofs: ["ISOLATED_PILOT_HOST_UNCHOSEN"] },
  ],
  selection_state: "UNRESOLVED",
  live_occupancy: "NOT_READ",
  selected_host: null,
  reservation_id: null,
  dispatch_eligible: false,
};

function context(token: string | null, response: unknown = BOARD): {
  ctx: AppContext;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    ctx: {
      flags: { yes: false, json: true, audit: false, cwd: process.cwd() },
      tokens: { get: async () => token },
      api: {
        getJson: async (path: string) => {
          calls.push(path);
          if (response instanceof Error) throw response;
          return response;
        },
      },
      confirm: async () => false,
    } as unknown as AppContext,
    calls,
  };
}

test("an Agent API key cannot probe or control the staff Drive route", async () => {
  const { ctx, calls } = context("aek_example_private");
  const report = await diagnosePredatorDrive(ctx);
  assert.deepEqual(calls, []);
  assert.deepEqual(report.blockers, ["STAFF_SESSION_REQUIRED"]);
  assert.equal(report.laneId, null);
  assert.equal(report.paidHold, false);
  assert.equal(report.spentUsd, 0);
  assert.doesNotMatch(JSON.stringify(report), /aek_example_private/);
});

test("a bound staff session reads the same Cloud G0 board and never admits", async () => {
  const { ctx, calls } = context("staff-session", BOARD);
  const report = await diagnosePredatorDrive(ctx);
  assert.deepEqual(calls, [PREDATOR_DRIVE_DIAGNOSE_PATH]);
  assert.equal(report.source, "CLOUD_G0_DIAGNOSE");
  assert.equal(report.decision, "CAPABILITY_BLOCKED");
  assert.deepEqual(report.blockers, [
    "DURABLE_OPERATOR_LANE_UNWIRED",
    "HOST_DIRECTIVE_ACK_UNWIRED",
    "ISOLATED_PILOT_HOST_UNCHOSEN",
  ]);
  assert.match(renderPredatorDriveReadiness(report), /mission: none; host: none/);
});

test("an unverified success-shaped Cloud board fails closed", async () => {
  const { ctx } = context("staff-session", { ...BOARD, dispatch_eligible: true });
  const report = await diagnosePredatorDrive(ctx);
  assert.deepEqual(report.blockers, ["CLOUD_DIAGNOSE_INVALID"]);
  assert.equal(report.missionAdmitted, false);
});

test("staff refusal and Cloud outage have separate non-disclosing blockers", async () => {
  const forbidden = await diagnosePredatorDrive(context("staff-session", new HttpError(403, "secret")).ctx);
  const unavailable = await diagnosePredatorDrive(context("staff-session", new HttpError(504, "secret")).ctx);
  assert.deepEqual(forbidden.blockers, ["STAFF_SESSION_REQUIRED"]);
  assert.deepEqual(unavailable.blockers, ["CLOUD_ROUTE_UNAVAILABLE"]);
  assert.doesNotMatch(JSON.stringify([forbidden, unavailable]), /secret/);
});

test("aether mcp doctor drive emits a typed blocked report", async () => {
  const { ctx, calls } = context("aek_example_private");
  const chunks: string[] = [];
  const out = { write: (value: string) => (chunks.push(value), true) } as unknown as Writable;
  assert.equal(await cmdMcp(ctx, ["doctor", "drive"], { out }), 1);
  assert.deepEqual(calls, []);
  const report = JSON.parse(chunks.join("")) as Record<string, unknown>;
  assert.equal(report["releaseGate"], "G0");
  assert.equal(report["decision"], "CAPABILITY_BLOCKED");
  assert.equal(report["missionAdmitted"], false);
});
