// `aether config [show]`            — print current config
// `aether config get <key>`         — print one value
// `aether config set <key> <value>` — set + persist one value

import type { AppContext } from "../core/context.js";
import type { AetherConfig, BackendPref, PermissionMode } from "../types.js";
import { saveConfig } from "../core/config.js";
import { EFFORT_TIERS, normalizeEffort } from "../ui/effort.js";

const BOOL_KEYS = new Set<keyof AetherConfig>(["autoApply", "telemetry", "lfSubmits"]);
const PERMISSION_MODES: PermissionMode[] = ["ask", "auto", "skip"];
const BACKEND_PREFS: BackendPref[] = ["auto", "local", "cloud"];

export async function cmdConfig(ctx: AppContext, argv: string[]): Promise<number> {
  const sub = argv[0] ?? "show";

  if (sub === "show") {
    process.stdout.write(JSON.stringify(ctx.cfg, null, 2) + "\n");
    return 0;
  }

  if (sub === "get") {
    const key = argv[1] as keyof AetherConfig | undefined;
    if (!key || !(key in ctx.cfg)) {
      process.stderr.write("usage: aether config get <key>\n");
      return 2;
    }
    process.stdout.write(String(ctx.cfg[key]) + "\n");
    return 0;
  }

  if (sub === "set") {
    const key = argv[1] as keyof AetherConfig | undefined;
    const value = argv[2];
    if (!key || value === undefined || !(key in ctx.cfg)) {
      process.stderr.write("usage: aether config set <key> <value>\n");
      return 2;
    }
    if (key === "permissionMode") {
      if (!PERMISSION_MODES.includes(value as PermissionMode)) {
        process.stderr.write(`permissionMode must be one of: ${PERMISSION_MODES.join(", ")}\n`);
        return 2;
      }
      ctx.cfg.permissionMode = value as PermissionMode;
    } else if (key === "defaultEffort") {
      const tier = value === "" ? "" : normalizeEffort(value);
      if (tier === null) {
        process.stderr.write(`defaultEffort must be one of: ${EFFORT_TIERS.join(", ")} (or "" to unset)\n`);
        return 2;
      }
      ctx.cfg.defaultEffort = tier;
    } else if (key === "backend") {
      if (!BACKEND_PREFS.includes(value as BackendPref)) {
        process.stderr.write(`backend must be one of: ${BACKEND_PREFS.join(", ")}\n`);
        return 2;
      }
      ctx.cfg.backend = value as BackendPref;
    } else if (BOOL_KEYS.has(key)) {
      if (key === "lfSubmits" && !["true", "false", "1", "0"].includes(value)) {
        process.stderr.write("lfSubmits must be true or false\n");
        return 2;
      }
      (ctx.cfg[key] as boolean) = value === "true" || value === "1";
    } else {
      (ctx.cfg[key] as string) = value;
    }
    saveConfig(ctx.cfg);
    process.stdout.write(`${key} → ${String(ctx.cfg[key])}\n`);
    return 0;
  }

  process.stderr.write("usage: aether config [show|get <key>|set <key> <value>]\n");
  return 2;
}
