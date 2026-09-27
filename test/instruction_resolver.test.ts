import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverInstructionSources, parseCursorGlobs } from "../src/core/instructions/instruction_discovery.js";
import {
  applicableSources,
  buildInstructionContextPacket,
  detectConflicts,
  extractTestCommands,
  resolveInstructionGraph,
  sourceAppliesTo,
} from "../src/core/instructions/instruction_resolver.js";
import { SKILL_BOUNDS } from "../src/core/skills/skill_bounds.js";
import { openRunSession } from "../src/core/skills/run_session.js";
import type { InstructionSource } from "../src/core/instructions/instruction_types.js";

function withEnv<T>(key: string, value: string, fn: () => T): T {
  const prior = process.env[key];
  process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prior == null) delete process.env[key];
    else process.env[key] = prior;
  }
}

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "aether-instr-"));
}

test("discovers root AGENTS.md and canonical Aether instructions", () => {
  const root = makeProject();
  writeFileSync(join(root, "AGENTS.md"), "Use npm test for everything.\n");
  mkdirSync(join(root, ".aether"), { recursive: true });
  writeFileSync(join(root, ".aether", "instructions.md"), "Run npm run test:ci before shipping.\n");
  withEnv("AETHER_CONFIG_DIR", mkdtempSync(join(tmpdir(), "aether-cfg-")), () => {
    const { sources, skipped } = discoverInstructionSources(root);
    assert.equal(skipped.length, 0);
    const kinds = sources.map((source) => source.kind).sort();
    assert.deepEqual(kinds, ["aether-project", "agents-root"]);
    for (const source of sources) {
      assert.match(source.sha256, /^[0-9a-f]{64}$/);
      assert.equal(source.parseStatus, "ok");
    }
  });
});

test("nested AGENTS.md scopes to its subtree only", () => {
  const root = makeProject();
  writeFileSync(join(root, "AGENTS.md"), "root guidance\n");
  mkdirSync(join(root, "packages", "web"), { recursive: true });
  writeFileSync(join(root, "packages", "web", "AGENTS.md"), "web guidance\n");
  withEnv("AETHER_CONFIG_DIR", mkdtempSync(join(tmpdir(), "aether-cfg-")), () => {
    const { sources } = discoverInstructionSources(root);
    const nested = sources.find((source) => source.kind === "agents-nested");
    assert.ok(nested);
    assert.equal(nested.scopeDir, "packages/web");
    assert.equal(sourceAppliesTo(nested, "packages/web/app.tsx"), true);
    assert.equal(sourceAppliesTo(nested, "src/other.ts"), false);
    assert.equal(sourceAppliesTo(nested, null), false);
    // Nearest nested outranks root for files in its subtree.
    const ordered = applicableSources(sources, "packages/web/app.tsx");
    assert.equal(ordered[0]?.kind, "agents-nested");
  });
});

test("a wide project stops nested discovery visibly and refuses local tool authority", () => {
  const root = makeProject();
  writeFileSync(join(root, "AGENTS.md"), "Keep the root rule.\n");
  const userDir = mkdtempSync(join(tmpdir(), "aether-cfg-"));
  writeFileSync(join(userDir, "instructions.md"), "Keep the user rule.\n");
  // The old depth-only walk could spend minutes traversing a home directory
  // before even starting the chat pulse. This exceeds the directory budget
  // without depending on a machine-specific stopwatch threshold.
  for (let i = 0; i <= SKILL_BOUNDS.maxNestedInstructionDirectories; i++) {
    mkdirSync(join(root, `child-${String(i).padStart(4, "0")}`));
  }
  withEnv("AETHER_CONFIG_DIR", userDir, () => {
    const graph = resolveInstructionGraph(root);
    assert.equal(graph.nestedScanComplete, false);
    assert.ok(graph.sources.some((source) => source.kind === "agents-root" && source.content.includes("Keep the root rule")));
    assert.ok(graph.sources.some((source) => source.kind === "aether-user" && source.content.includes("Keep the user rule")));
    assert.ok(graph.skipped.some((item) => item.path === "**/AGENTS.md" && item.reason.includes("may be missing")));

    const local = openRunSession({ projectRoot: root, prompt: "edit files" });
    assert.equal(local.ok, false);
    if (!local.ok) assert.equal(local.refusal.code, "skill.instruction_scan_incomplete");

    const cloudChat = openRunSession({ projectRoot: root, prompt: "reply 1", allowIncompleteInstructionDiscovery: true });
    assert.equal(cloudChat.ok, true, cloudChat.ok ? "" : cloudChat.lines.join("\n"));
    if (cloudChat.ok) {
      assert.equal(cloudChat.run.hasWarnings, true);
      assert.match(cloudChat.run.headerLines.join("\n"), /nested project rules may be missing/);
    }
  });
});

test("precedence: canonical Aether project instruction beats root AGENTS.md", () => {
  const root = makeProject();
  writeFileSync(join(root, "AGENTS.md"), "Always run `npm test`.\n");
  mkdirSync(join(root, ".aether"), { recursive: true });
  writeFileSync(join(root, ".aether", "instructions.md"), "Always run `npm run test:ci`.\n");
  withEnv("AETHER_CONFIG_DIR", mkdtempSync(join(tmpdir(), "aether-cfg-")), () => {
    const graph = resolveInstructionGraph(root);
    assert.equal(graph.conflicts.length, 1);
    const conflict = graph.conflicts[0];
    assert.ok(conflict);
    assert.equal(conflict.topic, "test command");
    assert.equal(conflict.effective, "npm run test:ci");
    assert.match(conflict.reason, /canonical Aether project instruction/);
  });
});

test("extractTestCommands finds common runners and ignores prose", () => {
  const commands = extractTestCommands(
    "Run `npm run test:ci` locally. CI uses pytest tests/api. Never cargo test --all here.\nThis is the greatest codebase.\n",
  );
  assert.ok(commands.includes("npm run test:ci"));
  assert.ok(commands.some((command) => command.startsWith("pytest")));
  assert.ok(commands.some((command) => command.startsWith("cargo test")));
  assert.ok(!commands.some((command) => command.includes("greatest")));
});

test("no conflict when sources agree", () => {
  const root = makeProject();
  writeFileSync(join(root, "AGENTS.md"), "Use `npm test`.\n");
  writeFileSync(join(root, "CLAUDE.md"), "Use `npm test`.\n");
  withEnv("AETHER_CONFIG_DIR", mkdtempSync(join(tmpdir(), "aether-cfg-")), () => {
    const graph = resolveInstructionGraph(root);
    assert.equal(graph.conflicts.length, 0);
  });
});

test("cursor rule with supported globs scopes by pattern", () => {
  const root = makeProject();
  mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
  writeFileSync(
    join(root, ".cursor", "rules", "ts.mdc"),
    "---\nglobs: src/**/*.ts\n---\nPrefer type-only imports.\n",
  );
  withEnv("AETHER_CONFIG_DIR", mkdtempSync(join(tmpdir(), "aether-cfg-")), () => {
    const { sources } = discoverInstructionSources(root);
    const rule = sources.find((source) => source.kind === "cursor-rule");
    assert.ok(rule);
    assert.deepEqual(rule.globs, ["src/**/*.ts"]);
    assert.equal(sourceAppliesTo(rule, "src/core/x.ts"), true);
    assert.equal(sourceAppliesTo(rule, "docs/x.md"), false);
    assert.equal(sourceAppliesTo(rule, null), false);
  });
});

test("cursor rule with unsupported glob syntax warns and is NOT applied globally", () => {
  const parsed = parseCursorGlobs("---\nglobs: [src/**, {a,b}/*.ts]\n---\nbody\n");
  assert.deepEqual(parsed.globs, []);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0] ?? "", /unsupported/);

  const root = makeProject();
  mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
  writeFileSync(join(root, ".cursor", "rules", "bad.mdc"), "---\nglobs: {a,b}/*.ts\n---\nrule body\n");
  withEnv("AETHER_CONFIG_DIR", mkdtempSync(join(tmpdir(), "aether-cfg-")), () => {
    const { sources } = discoverInstructionSources(root);
    const rule = sources.find((source) => source.kind === "cursor-rule");
    assert.ok(rule);
    assert.equal(rule.parseStatus, "unsupported-syntax");
    assert.equal(sourceAppliesTo(rule, "a/x.ts"), false);
    assert.equal(sourceAppliesTo(rule, null), false);
  });
});

test("oversized instruction file is truncated with a visible warning", () => {
  const root = makeProject();
  writeFileSync(join(root, "AGENTS.md"), "x".repeat(SKILL_BOUNDS.maxInstructionFileBytes + 100));
  withEnv("AETHER_CONFIG_DIR", mkdtempSync(join(tmpdir(), "aether-cfg-")), () => {
    const { sources } = discoverInstructionSources(root);
    const source = sources[0];
    assert.ok(source);
    assert.equal(source.parseStatus, "truncated");
    assert.ok(source.warnings.some((warning) => warning.includes("truncated")));
  });
});

test("binary instruction file is skipped with a reason, not applied", () => {
  const root = makeProject();
  writeFileSync(join(root, "AGENTS.md"), Buffer.from([0x41, 0x00, 0x42, 0x00, 0x43]));
  withEnv("AETHER_CONFIG_DIR", mkdtempSync(join(tmpdir(), "aether-cfg-")), () => {
    const { sources, skipped } = discoverInstructionSources(root);
    assert.equal(sources.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]?.reason ?? "", /binary/);
  });
});

test("context packet carries provenance and applies scoping", () => {
  const root = makeProject();
  writeFileSync(join(root, "AGENTS.md"), "root\n");
  mkdirSync(join(root, "api"), { recursive: true });
  writeFileSync(join(root, "api", "AGENTS.md"), "api only\n");
  withEnv("AETHER_CONFIG_DIR", mkdtempSync(join(tmpdir(), "aether-cfg-")), () => {
    const { sources } = discoverInstructionSources(root);
    const packetForApi = buildInstructionContextPacket(sources, "api/server.py");
    assert.equal(packetForApi.contract_version, 1);
    assert.equal(packetForApi.sources.length, 2);
    assert.equal(packetForApi.sources[0]?.kind, "agents-nested");
    assert.match(packetForApi.sources[0]?.digest ?? "", /^sha256:[0-9a-f]{64}$/);
    const packetGlobal = buildInstructionContextPacket(sources, null);
    assert.equal(packetGlobal.sources.length, 1);
    assert.equal(packetGlobal.sources[0]?.kind, "agents-root");
  });
});

test("detectConflicts keeps highest-precedence command as effective", () => {
  const root = makeProject();
  writeFileSync(join(root, "AGENTS.md"), "`npm test`\n");
  writeFileSync(join(root, "CLAUDE.md"), "`pytest tests`\n");
  withEnv("AETHER_CONFIG_DIR", mkdtempSync(join(tmpdir(), "aether-cfg-")), () => {
    const { sources } = discoverInstructionSources(root);
    const conflicts = detectConflicts(applicableSources(sources, null));
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.effective, "npm test");
  });
});

// Regression: CodeQL js/incomplete-sanitization on globToRegExp's escape.
// The escape must treat every regex metacharacter in a glob as a literal, so a
// glob can never widen its own match set. Dropping the escape (or its global
// flag, once a token is longer than one character) makes these assertions fail.
test("glob metacharacters are escaped, never interpreted as regex", () => {
  const ruleWith = (globs: readonly string[]): InstructionSource => ({
    kind: "cursor-rule",
    path: "/p/.cursor/rules/x.mdc",
    displayPath: ".cursor/rules/x.mdc",
    scopeDir: "",
    globs,
    sha256: "0".repeat(64),
    sizeBytes: 0,
    content: "",
    parseStatus: "ok",
    warnings: [],
  });

  // A dot is a literal dot, not "any character".
  const dot = ruleWith(["a.ts"]);
  assert.equal(sourceAppliesTo(dot, "a.ts"), true);
  assert.equal(sourceAppliesTo(dot, "axts"), false, "unescaped . would match axts");

  // Anchors, groups, alternation and quantifiers are literals too.
  for (const [glob, literal, decoy] of [
    ["a+.ts", "a+.ts", "aa.ts"],
    ["a(b).ts", "a(b).ts", "ab.ts"],
    ["a|b.ts", "a|b.ts", "a.ts"],
    ["a{2}.ts", "a{2}.ts", "aa.ts"],
    ["a[b].ts", "a[b].ts", "ab.ts"],
    ["a$b.ts", "a$b.ts", "ab.ts"],
    ["a^b.ts", "a^b.ts", "ab.ts"],
  ] as const) {
    const rule = ruleWith([glob]);
    assert.equal(sourceAppliesTo(rule, literal), true, `${glob} should match itself`);
    assert.equal(sourceAppliesTo(rule, decoy), false, `${glob} must not match ${decoy}`);
  }

  // The supported wildcards still work — escaping must not disarm them.
  const star = ruleWith(["src/**/*.ts"]);
  assert.equal(sourceAppliesTo(star, "src/core/x.ts"), true);
  assert.equal(sourceAppliesTo(star, "docs/x.md"), false);
});
