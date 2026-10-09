// Local trust store: <configDir()>/skill-trust.json
//
// Trust is a LOCAL decision — never committed to a project. It binds to
// (project identity, skill id, version, exact content digest). A digest change
// moves the skill to "changed · review required"; nothing implicit re-trusts it.
// Built-ins are trusted via the signed package artifact and never appear here.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config.js";
import { readSkillStore } from "./skill_store_read.js";

export const SKILL_TRUST_SCHEMA_VERSION = 1;

export type TrustMethod = "inspect" | "explicit" | "install";

export interface SkillTrustRecord {
  /** Canonical absolute project root the trust applies to ("*" for user-scope skills). */
  projectRoot: string;
  /** Repository host/slug when known, e.g. "github.com/AetherAI3/aether-agent". */
  repository: string | null;
  skillId: string;
  version: string;
  sha256: string;
  trustedAt: string;
  method: TrustMethod;
  /** Requested permission summary shown at trust time — audit trail only. */
  requestedPermissions: readonly string[];
}

export interface SkillTrustStore {
  schemaVersion: number;
  records: readonly SkillTrustRecord[];
}

export function trustStorePath(): string {
  return join(configDir(), "skill-trust.json");
}

export function loadTrustStore(): SkillTrustStore {
  const records = readSkillStore(trustStorePath(), "skill trust", SKILL_TRUST_SCHEMA_VERSION, "records", (entry): entry is SkillTrustRecord => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return typeof item["projectRoot"] === "string" && typeof item["skillId"] === "string"
      && (item["repository"] === null || typeof item["repository"] === "string")
      && typeof item["version"] === "string" && typeof item["sha256"] === "string"
      && typeof item["trustedAt"] === "string"
      && (item["method"] === "inspect" || item["method"] === "explicit" || item["method"] === "install")
      && Array.isArray(item["requestedPermissions"])
      && item["requestedPermissions"].every((permission: unknown) => typeof permission === "string");
  });
  return { schemaVersion: SKILL_TRUST_SCHEMA_VERSION, records };
}

function saveTrustStore(store: SkillTrustStore): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const path = trustStorePath();
  const body = {
    schema_version: SKILL_TRUST_SCHEMA_VERSION,
    records: store.records,
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export type TrustLookup =
  | { state: "trusted"; record: SkillTrustRecord }
  | { state: "changed"; record: SkillTrustRecord }
  | { state: "untrusted" };

/**
 * Look up trust for one (projectRoot, skillId). "changed" means a record exists
 * for this id but with a DIFFERENT digest — the caller must show a diff and
 * require re-trust; it must never treat "changed" as trusted.
 */
export function lookupTrust(
  store: SkillTrustStore,
  projectRoot: string,
  skillId: string,
  sha256: string,
): TrustLookup {
  const matches = store.records.filter(
    (record) => record.projectRoot === projectRoot && record.skillId === skillId,
  );
  const exact = matches.find((record) => record.sha256 === sha256);
  if (exact) return { state: "trusted", record: exact };
  const latest = matches[matches.length - 1];
  if (latest) return { state: "changed", record: latest };
  return { state: "untrusted" };
}

export function recordTrust(record: SkillTrustRecord): void {
  const store = loadTrustStore();
  // One live record per (projectRoot, skillId): re-trusting replaces the old
  // digest binding instead of accumulating stale ones.
  const rest = store.records.filter(
    (existing) => !(existing.projectRoot === record.projectRoot && existing.skillId === record.skillId),
  );
  saveTrustStore({ schemaVersion: SKILL_TRUST_SCHEMA_VERSION, records: [...rest, record] });
}

export function removeTrust(projectRoot: string, skillId: string): boolean {
  const store = loadTrustStore();
  const rest = store.records.filter(
    (existing) => !(existing.projectRoot === projectRoot && existing.skillId === skillId),
  );
  if (rest.length === store.records.length) return false;
  saveTrustStore({ schemaVersion: SKILL_TRUST_SCHEMA_VERSION, records: rest });
  return true;
}
