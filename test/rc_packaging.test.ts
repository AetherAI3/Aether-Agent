// F1 packaging — would the published package actually carry this, and only
// this?
//
// CI already runs `npm pack --dry-run` on ubuntu. That proves a tarball can be
// built; it does not prove the tarball contains the new modules, that RC
// introduced no dependency, or that nothing here reaches for a package that
// only exists in a source checkout. Those are the ways a lane passes CI and
// then fails on a user's first clean install.
//
// This runs on both operating systems because that is where the claim has to
// hold, and it reads only — nothing is packed or installed from here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  version: string;
  files: string[];
  dependencies?: Record<string, string>;
  engines?: { node?: string };
};

/** Everything F1 added that has to reach a user's machine. */
const NEW_MODULES = [
  "src/core/browser_runtime.ts",
  "src/core/rc/outbox.ts",
  "src/core/rc/host.ts",
  "src/core/rc/producers.ts",
  "src/commands/rc.ts",
];

// ── the manifest carries the new modules ────────────────────────────────────

test("every new module is covered by the published files list", () => {
  // `files` lists directories, so the check is that each module's compiled
  // output falls under one of them. A module that compiles but ships nowhere
  // is the failure this catches — the CLI would throw MODULE_NOT_FOUND on a
  // user's first `aether rc`.
  for (const module of NEW_MODULES) {
    const compiled = `dist/${module.replace(/\.ts$/, ".js")}`;
    const covered = pkg.files.some((entry) => compiled.startsWith(entry.replace(/\/$/, "")));
    assert.ok(covered, `${compiled} is not covered by package.json "files"`);
  }
});

test("the compiled output for every new module exists after a build", () => {
  for (const module of NEW_MODULES) {
    const compiled = join(repoRoot, "dist", module.replace(/\.ts$/, ".js"));
    assert.doesNotThrow(
      () => readFileSync(compiled, "utf8"),
      `${module} produced no compiled output`,
    );
  }
});

// ── zero dependencies, and nothing reaching outside them ────────────────────

test("the package still declares no runtime dependencies", () => {
  // Deliberate, and load-bearing for the supply-chain story: every import in
  // this CLI is a node: builtin or a relative path.
  assert.deepEqual(pkg.dependencies ?? {}, {});
});

/** Import specifiers in one source file, from its static imports. */
function importsOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+["']([^"']+)["']/g)) {
    found.push(match[1]!);
  }
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) {
    found.push(match[1]!);
  }
  return found;
}

test("no RC or browser module imports a package that is not declared", () => {
  // A source-only import — resolvable in the worktree because it sits in
  // devDependencies or node_modules, but absent from a user's install — is
  // invisible to typecheck and fatal at runtime.
  const rcDir = join(repoRoot, "src", "core", "rc");
  const files = [
    ...readdirSync(rcDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(rcDir, name)),
    join(repoRoot, "src", "core", "browser_runtime.ts"),
    join(repoRoot, "src", "commands", "rc.ts"),
  ];
  assert.ok(files.length > 5, "module list collapsed — this guard would be vacuous");

  for (const file of files) {
    for (const specifier of importsOf(readFileSync(file, "utf8"))) {
      const ok = specifier.startsWith("node:") || specifier.startsWith(".");
      assert.ok(ok, `${file} imports ${specifier}, which is neither a builtin nor relative`);
    }
  }
});

test("the engines floor is still declared, so a clean install fails loudly on old Node", () => {
  assert.match(String(pkg.engines?.node ?? ""), /\d/);
});

// ── the two halves release together ─────────────────────────────────────────

test("the PyPI launcher version tracks package.json", () => {
  const pyproject = readFileSync(join(repoRoot, "packages", "pypi-cli", "pyproject.toml"), "utf8");
  const version = /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1];
  assert.equal(version, pkg.version, "the npm and PyPI halves would ship out of step");
});

test("the PyPI shim declares no runtime dependencies either", () => {
  const pyproject = readFileSync(join(repoRoot, "packages", "pypi-cli", "pyproject.toml"), "utf8");
  assert.match(pyproject, /^dependencies\s*=\s*\[\]/m);
});

// ── no credential material anywhere near the shipped surface ────────────────

test("no RC or browser module contains a credential-shaped literal", () => {
  // A seeded canary in shipped source would travel to every user. These
  // modules are checked because they are what this lane added; the repository
  // has its own broader secret scanning.
  const rcDir = join(repoRoot, "src", "core", "rc");
  const patterns: Array<[string, RegExp]> = [
    ["GitHub token", /ghp_[A-Za-z0-9]{20,}/],
    ["Aether key", /aek_[A-Za-z0-9]{20,}/],
    ["OpenAI key", /\bsk-[A-Za-z0-9]{20,}/],
    ["Slack token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
    ["private key", /BEGIN [A-Z ]*PRIVATE KEY/],
  ];
  const files = [
    ...readdirSync(rcDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(rcDir, name)),
    join(repoRoot, "src", "commands", "rc.ts"),
    join(repoRoot, "src", "core", "browser_runtime.ts"),
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const [label, pattern] of patterns) {
      assert.ok(!pattern.test(source), `${file} contains something shaped like a ${label}`);
    }
  }
});
