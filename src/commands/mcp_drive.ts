/** Aether Agent's read-only view of the shared Cloud Predator Drive lane. */

import { readFileSync, statSync } from "node:fs";
import type { Writable } from "node:stream";
import type { AppContext } from "../core/context.js";
import {
  DriveReadError, getDriveEvents, getDriveMission, previewDrive,
} from "../core/predator_drive_client.js";
import { driveStaffContext } from "../core/drive_staff_session.js";
import {
  DriveStaffLoginError, loginDriveStaffSession, logoutDriveStaffSession,
} from "../core/drive_staff_oauth.js";
import { browserHint, openBrowserTyped } from "../core/browser.js";
import { sanitizeTerm } from "../ui/text.js";

const MAX_INTAKE_BYTES = 256 * 1024;

function intakeFile(path: string): Record<string, unknown> {
  let raw: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_INTAKE_BYTES) {
      throw new Error("not a bounded file");
    }
    raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_INTAKE_BYTES) throw new Error("too large");
  } catch {
    throw new DriveReadError("DRIVE_INTAKE_INVALID");
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("expected object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new DriveReadError("DRIVE_INTAKE_INVALID");
  }
}

function safe(value: string): string {
  return sanitizeTerm(value).replace(/[\r\n]/g, " ");
}

export function driveMcpUsage(): string {
  return [
    "usage: aether mcp drive login [--no-browser]",
    "       aether mcp drive logout",
    "       aether mcp drive preview <intake.json>",
    "       aether mcp drive status <lane-id>",
    "       aether mcp drive events <lane-id> [after-cursor] [limit]",
    "Browser sign-in binds a separate Cloud staff session after a staff-role probe.",
    "Device-login aek_ API keys cannot control Drive.",
    "Preview is read-only and currently returns a G0 blocker; no mission or spend is created.",
  ].join("\n") + "\n";
}

function parseIntArg(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new DriveReadError("DRIVE_INTAKE_INVALID");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new DriveReadError("DRIVE_INTAKE_INVALID");
  return value;
}

export async function cmdMcpDrive(
  ctx: AppContext, argv: string[], out: Writable = process.stdout,
): Promise<number> {
  const verb = argv[0];
  if (!verb || verb === "help") {
    out.write(driveMcpUsage());
    return verb ? 0 : 2;
  }
  try {
    if (verb === "login" && argv.length === 1) {
      const progress = ctx.flags.json ? process.stderr : out;
      await loginDriveStaffSession(ctx, {
        onAuthorizeUrl: async (url) => {
          progress.write(`Open this GitHub sign-in URL on this computer:\n  ${url}\n`);
          if (!ctx.flags.noBrowser) {
            const opened = await openBrowserTyped(url);
            if (!opened.launched) {
              progress.write(`Browser did not open (${opened.code}): ${browserHint(opened.code)}. Use the URL above.\n`);
            }
          }
          progress.write("Waiting for the browser callback…\n");
        },
      });
      out.write(ctx.flags.json
        ? JSON.stringify({ status: "BOUND", release_gate: "G0", execution_enabled: false }) + "\n"
        : "Cloud staff session bound for Drive reads. Drive execution remains G0 blocked.\n");
      return 0;
    }
    if (verb === "logout" && argv.length === 1) {
      const revoked = await logoutDriveStaffSession(ctx);
      out.write(ctx.flags.json
        ? JSON.stringify({ status: "CLEARED", cloud_revocation_confirmed: revoked }) + "\n"
        : revoked ? "Drive staff session revoked and cleared.\n"
          : "Drive staff session cleared locally; Cloud revocation was not confirmed.\n");
      return revoked ? 0 : 1;
    }
    const driveCtx = await driveStaffContext(ctx);
    if (verb === "preview" && argv.length === 2) {
      const result = await previewDrive(driveCtx, intakeFile(argv[1]!));
      out.write(ctx.flags.json
        ? JSON.stringify(result) + "\n"
        : `Predator Drive preview: ${result.decision} (${result.release_gate})\n` +
          "  mission: none; host: none; paid hold: no; spend: $0\n" +
          `  blockers: ${result.blockers.join(", ")}\n`);
      return 1;
    }
    if (verb === "status" && argv.length === 2) {
      const result = await getDriveMission(driveCtx, argv[1]!);
      out.write(ctx.flags.json
        ? JSON.stringify(result) + "\n"
        : `Predator Drive ${safe(result.lane_id)}: ${safe(result.state)}\n` +
          `  source: ${safe(result.source_repo)}@${safe(result.source_sha)}\n` +
          `  driver: ${safe(result.driver_mode)}; host: ${safe(result.selected_host ?? "none")}\n` +
          `  spend: $${(result.spent_cents / 100).toFixed(2)} / $${(result.cap_cents / 100).toFixed(2)}\n` +
          `  controller generation: ${result.controller_generation}; event cursor: ${result.last_event_cursor}\n`);
      return 0;
    }
    if (verb === "events" && argv.length >= 2 && argv.length <= 4) {
      const afterCursor = parseIntArg(argv[2], 0);
      const limit = parseIntArg(argv[3], 50);
      const result = await getDriveEvents(driveCtx, argv[1]!, afterCursor, limit);
      out.write(ctx.flags.json
        ? JSON.stringify(result) + "\n"
        : `Predator Drive ${safe(result.lane_id)}: ${result.events.length} event(s), next cursor ${result.next_cursor}${result.has_more ? " (more)" : ""}\n` +
          result.events.map((event) =>
            `  ${event.cursor} ${safe(event.kind)} generation ${event.generation}: ${safe(event.reason)}\n`,
          ).join(""));
      return 0;
    }
    out.write(driveMcpUsage());
    return 2;
  } catch (error) {
    const code = error instanceof DriveReadError || error instanceof DriveStaffLoginError
      ? error.code : "CLOUD_ROUTE_UNAVAILABLE";
    const hint = code === "AUTH_REQUIRED" || code === "STAFF_SESSION_REQUIRED"
      ? "Run `aether mcp drive login`; aether auth login device keys are not Drive authority."
      : code === "ACCOUNT_LINK_REQUIRED"
        ? "Link this GitHub identity to your existing Aether account in the portal, then retry."
        : code === "OAUTH_CALLBACK_TIMEOUT"
          ? "Finish GitHub sign-in in the browser on this computer, then retry."
      : code === "CLOUD_ROUTE_UNAVAILABLE"
        ? "Check Cloud deployment and the VPS2 API route."
        : code === "LANE_NOT_FOUND"
          ? "The mission does not exist or this staff session cannot observe it."
          : "Check the request and Cloud Drive contract.";
    out.write(ctx.flags.json ? JSON.stringify({ error: code }) + "\n" : `${code}: ${hint}\n`);
    return 1;
  }
}
