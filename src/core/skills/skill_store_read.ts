// Shared admission reader for local skill settings and trust. A present store
// is never interpreted as empty when its bytes or schema cannot be understood.
import { readFileSync } from "node:fs";
import { SkillError } from "./skill_errors.js";

export function readSkillStore<T>(
  path: string,
  label: string,
  schemaVersion: number,
  collection: string,
  validEntry: (entry: unknown) => entry is T,
): readonly T[] {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new SkillError({ code: "skill.schema_invalid", detail: `${label} at ${path} cannot be read; repair it before using skills` });
  }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch {
    throw new SkillError({ code: "skill.schema_invalid", detail: `${label} at ${path} is not valid JSON; repair it before using skills` });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SkillError({ code: "skill.schema_invalid", detail: `${label} at ${path} has an invalid shape; repair it before using skills` });
  }
  const object = raw as Record<string, unknown>;
  if (!Number.isInteger(object["schema_version"])) {
    throw new SkillError({ code: "skill.schema_invalid", detail: `${label} at ${path} has no valid schema version; repair it before using skills` });
  }
  if (object["schema_version"] !== schemaVersion) {
    throw new SkillError({ code: "skill.version_incompatible", detail: `${label} at ${path} uses schema ${String(object["schema_version"])}; this CLI supports ${schemaVersion} and will not overwrite it` });
  }
  const entries = object[collection];
  if (!Array.isArray(entries) || !entries.every(validEntry)) {
    throw new SkillError({ code: "skill.schema_invalid", detail: `${label} at ${path} has invalid ${collection}; repair it before using skills` });
  }
  return entries;
}
