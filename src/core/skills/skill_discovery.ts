// Skill discovery: metadata-only indexing of built-in, user, and project skills.
//
// Discovery reads bounded metadata (skill.json) plus the files the digest
// covers — it NEVER executes anything, follows symlinks out of a skill root,
// fetches remote resources, sends content to a model, or mutates trust state.
// SKILL.md bodies are hashed for the digest but the text is not retained here;
// loading happens later, only for a resolved candidate (skill_loader.ts).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "../config.js";
import { SKILL_BOUNDS } from "./skill_bounds.js";
import { calculateSkillDigest } from "./skill_digest.js";
import { validateSkillManifest, type SkillScope } from "./skill_schema.js";
import { loadSkillSettings, lookupSkillSetting, type SkillSettingsStore } from "./skill_settings.js";
import { loadTrustStore, lookupTrust, type SkillTrustStore } from "./skill_trust.js";
import type { SkillDescriptor, SkillIndex, SkillIndexError, SkillTrustState } from "./skill_types.js";

export interface DiscoveryOptions {
  /** Project root (cwd) — project skills live under <root>/.aether/skills/project/. */
  projectRoot: string;
  /** Built-in skill resource root; defaults to the packaged builtin directory. */
  builtinRoot?: string;
  /** Injected for tests. */
  now?: () => Date;
}

export function builtinSkillsRoot(): string {
  // dist/src/core/skills/ → dist/src/skills/builtin/ (compiled tree; assets
  // are copied next to the compiled output by the build, verified by tests).
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "skills", "builtin");
}

export function projectSkillsRoot(projectRoot: string): string {
  return join(projectRoot, ".aether", "skills", "project");
}

export function userSkillsRoot(): string {
  return join(configDir(), "skills", "user");
}

interface ScanTarget {
  scope: SkillScope;
  root: string;
}

function listSkillDirectories(root: string): string[] {
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries.sort()) {
    const full = join(root, entry);
    try {
      if (statSync(full).isDirectory()) out.push(full);
    } catch {
      // unreadable entry — skip, never throw during discovery
    }
  }
  return out;
}

function discoverOne(
  skillRoot: string,
  scope: SkillScope,
  projectRoot: string,
  settings: SkillSettingsStore,
  trustStore: SkillTrustStore,
): { descriptor?: SkillDescriptor; error?: SkillIndexError } {
  const manifestPath = join(skillRoot, "skill.json");
  if (!existsSync(manifestPath)) {
    return { error: { root: skillRoot, scope, errors: ["skill.json not found"] } };
  }
  let stat;
  try {
    stat = statSync(manifestPath);
  } catch {
    return { error: { root: skillRoot, scope, errors: ["skill.json unreadable"] } };
  }
  if (stat.size > SKILL_BOUNDS.maxMetadataBytes) {
    return { error: { root: skillRoot, scope, errors: ["skill.json exceeds " + SKILL_BOUNDS.maxMetadataBytes + " bytes"] } };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { error: { root: skillRoot, scope, errors: ["skill.json is not valid JSON"] } };
  }
  const validation = validateSkillManifest(raw, scope);
  if (!validation.ok) {
    return { error: { root: skillRoot, scope, errors: validation.errors } };
  }
  const manifest = validation.manifest;
  const digest = calculateSkillDigest(skillRoot, manifest, raw);
  if (!digest.ok) {
    return { error: { root: skillRoot, scope, errors: [digest.error] } };
  }

  const trustKey = scope === "project" ? resolve(projectRoot) : "*";
  let trust: SkillTrustState;
  if (scope === "builtin") {
    trust = "builtin";
  } else if (scope === "user") {
    // User skills were created or explicitly installed by the user; trust
    // binds to the digest recorded at install/creation. Absent a record the
    // skill still runs (it is the user's own file) — recorded as trusted.
    trust = "trusted";
  } else {
    const lookup = lookupTrust(trustStore, trustKey, manifest.id, digest.sha256);
    trust = lookup.state;
  }

  const setting = lookupSkillSetting(settings, trustKey, manifest.id);
  const enabled = setting ? setting.enabled : true;
  // Automatic selection: built-ins follow the manifest; user/project skills
  // need an explicit local opt-in, and project skills additionally need trust.
  let automatic = false;
  if (manifest.triggers.automatic) {
    if (scope === "builtin") automatic = true;
    else if (scope === "user") automatic = setting?.automatic === true;
    else automatic = setting?.automatic === true && trust === "trusted";
  }

  return {
    descriptor: {
      id: manifest.id,
      version: manifest.version,
      name: manifest.name,
      description: manifest.description,
      scope,
      root: skillRoot,
      sha256: digest.sha256,
      trust,
      enabled,
      automatic: automatic && enabled,
      approxTokens: manifest.context.maxTokens,
      manifest,
    },
  };
}

/**
 * Build the metadata-only index. Indexing order (builtin, user, project) is for
 * listing only — name collisions are resolved explicitly by the resolver,
 * never silently by source order.
 */
export function discoverSkills(options: DiscoveryOptions): SkillIndex {
  // Read both local authority stores once, even when no skill directory is
  // present. A corrupt/future store is an admission refusal, never an empty
  // index with default-enabled skills.
  const settings = loadSkillSettings();
  const trustStore = loadTrustStore();
  const targets: ScanTarget[] = [
    { scope: "builtin", root: options.builtinRoot ?? builtinSkillsRoot() },
    { scope: "user", root: userSkillsRoot() },
    { scope: "project", root: projectSkillsRoot(options.projectRoot) },
  ];
  const skills: SkillDescriptor[] = [];
  const errors: SkillIndexError[] = [];
  const seenIds = new Set<string>();

  for (const target of targets) {
    for (const skillRoot of listSkillDirectories(target.root)) {
      const result = discoverOne(skillRoot, target.scope, options.projectRoot, settings, trustStore);
      if (result.error) { errors.push(result.error); continue; }
      const descriptor = result.descriptor;
      if (!descriptor) continue;
      if (seenIds.has(descriptor.id)) {
        errors.push({
          root: skillRoot,
          scope: target.scope,
          errors: ["duplicate skill id: " + descriptor.id + " — fully qualified ids must be unique"],
        });
        continue;
      }
      seenIds.add(descriptor.id);
      skills.push(descriptor);
    }
  }

  const now = options.now ? options.now() : new Date();
  return { skills, errors, generatedAt: now.toISOString() };
}
