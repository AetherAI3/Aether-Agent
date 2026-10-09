import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills } from "../src/core/skills/skill_discovery.js";
import { loadSkillSettings, saveSkillSetting, skillSettingsPath } from "../src/core/skills/skill_settings.js";
import { loadTrustStore, recordTrust, removeTrust, trustStorePath } from "../src/core/skills/skill_trust.js";
import { openRunSession } from "../src/core/skills/run_session.js";
import { SkillError } from "../src/core/skills/skill_errors.js";

function fixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "aether-skill-store-"));
  const previous = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = root;
  try { run(root); }
  finally {
    if (previous === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const setting = { projectRoot: "*", skillId: "user/example", enabled: true, automatic: false };
const trust = { projectRoot: "*", repository: null, skillId: "user/example", version: "1.0.0",
  sha256: "a".repeat(64), trustedAt: "2026-10-09T00:00:00Z", method: "inspect" as const, requestedPermissions: [] };

for (const [name, body, expected] of [
  ["future version", '{"schema_version":2,"settings":[{"projectRoot":"*","skillId":"user/example","enabled":false,"automatic":false}]}', "skill.version_incompatible"],
  ["invalid JSON", "{broken", "skill.schema_invalid"],
  ["missing version", '{"settings":[]}', "skill.schema_invalid"],
  ["invalid record", '{"schema_version":1,"settings":[{"projectRoot":"*","skillId":"user/example","enabled":"false","automatic":false}]}', "skill.schema_invalid"],
] as const) {
  test(`settings ${name} refuse reads, writes and turn admission without changing bytes`, () => fixture(root => {
    const path = skillSettingsPath();
    writeFileSync(path, body);
    assert.throws(() => loadSkillSettings(), (error: unknown) => error instanceof SkillError && error.code === expected);
    assert.throws(() => saveSkillSetting(setting), (error: unknown) => error instanceof SkillError && error.code === expected);
    assert.throws(() => discoverSkills({ projectRoot: root }), (error: unknown) => error instanceof SkillError && error.code === expected);
    const opened = openRunSession({ projectRoot: root, prompt: "task", explicitSkill: "user/example" });
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.equal(opened.refusal.code, expected);
    assert.equal(readFileSync(path, "utf8"), body);
  }));
}

for (const [name, body, expected] of [
  ["future version", '{"schema_version":2,"records":[]}', "skill.version_incompatible"],
  ["invalid JSON", "{broken", "skill.schema_invalid"],
  ["missing version", '{"records":[]}', "skill.schema_invalid"],
  ["invalid record", '{"schema_version":1,"records":[{"projectRoot":"*"}]}', "skill.schema_invalid"],
] as const) {
  test(`trust ${name} refuse reads and writes without changing bytes`, () => fixture(root => {
    const path = trustStorePath();
    writeFileSync(path, body);
    assert.throws(() => loadTrustStore(), (error: unknown) => error instanceof SkillError && error.code === expected);
    assert.throws(() => recordTrust(trust), (error: unknown) => error instanceof SkillError && error.code === expected);
    assert.throws(() => removeTrust("*", "user/example"), (error: unknown) => error instanceof SkillError && error.code === expected);
    const opened = openRunSession({ projectRoot: root, prompt: "task", explicitSkill: "user/example" });
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.equal(opened.refusal.code, expected);
    assert.equal(readFileSync(path, "utf8"), body);
  }));
}
