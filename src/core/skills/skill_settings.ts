// Per-skill local settings: enabled/disabled + automatic-selection opt-in.
// Local file (<configDir>/skill-settings.json) — like trust, never committed.
// Absence of a record means: enabled, automatic only if the manifest says so
// AND the scope defaults allow it (project skills additionally need trust).

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config.js";
import { readSkillStore } from "./skill_store_read.js";

export const SKILL_SETTINGS_SCHEMA_VERSION = 1;

export interface SkillSetting {
  /** "*" for user/builtin scope, canonical project root for project skills. */
  projectRoot: string;
  skillId: string;
  enabled: boolean;
  /** Explicit opt-in to automatic selection (user + trusted project skills). */
  automatic: boolean;
}

export interface SkillSettingsStore {
  schemaVersion: number;
  settings: readonly SkillSetting[];
}

export function skillSettingsPath(): string {
  return join(configDir(), "skill-settings.json");
}

export function loadSkillSettings(): SkillSettingsStore {
  const settings = readSkillStore(skillSettingsPath(), "skill settings", SKILL_SETTINGS_SCHEMA_VERSION, "settings", (entry): entry is SkillSetting => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return typeof item["projectRoot"] === "string" && typeof item["skillId"] === "string"
      && typeof item["enabled"] === "boolean" && typeof item["automatic"] === "boolean";
  });
  return { schemaVersion: SKILL_SETTINGS_SCHEMA_VERSION, settings };
}

export function saveSkillSetting(setting: SkillSetting): void {
  const store = loadSkillSettings();
  const rest = store.settings.filter(
    (existing) => !(existing.projectRoot === setting.projectRoot && existing.skillId === setting.skillId),
  );
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const path = skillSettingsPath();
  const body = {
    schema_version: SKILL_SETTINGS_SCHEMA_VERSION,
    settings: [...rest, setting],
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function lookupSkillSetting(
  store: SkillSettingsStore,
  projectRoot: string,
  skillId: string,
): SkillSetting | undefined {
  return store.settings.find(
    (setting) => setting.projectRoot === projectRoot && setting.skillId === skillId,
  );
}
