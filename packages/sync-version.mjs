#!/usr/bin/env node
// Copies the npm package's version into the PyPI launcher, so a release never ships a
// launcher that installs a different version of the agent than it claims to be.
//
// package.json is the single source of truth: the release flow already owns it, and this
// script only follows it.
//
// Usage: node packages/sync-version.mjs [--check]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packagesDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(packagesDir);
const checkOnly = process.argv.includes("--check");

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error(`package.json has an unusable version: ${version}`);
  process.exit(2);
}

const targets = [
  {
    path: join(packagesDir, "pypi-cli", "pyproject.toml"),
    pattern: /^version = "([^"]+)"$/m,
    label: "packages/pypi-cli/pyproject.toml",
  },
  {
    path: join(packagesDir, "pypi-cli", "src", "aether_agent", "__init__.py"),
    pattern: /^__version__ = "([^"]+)"$/m,
    label: "packages/pypi-cli/src/aether_agent/__init__.py",
  },
];

let drifted = false;
for (const { path, pattern, label } of targets) {
  const raw = readFileSync(path, "utf8");
  const match = raw.match(pattern);
  if (!match) throw new Error(`Could not find a version to sync in ${label}`);
  const from = match[1];
  if (from === version) {
    console.log(`${label}: ${version} (already in sync)`);
    continue;
  }
  drifted = true;
  if (checkOnly) {
    console.error(`${label}: ${from} != package.json ${version}`);
    continue;
  }
  writeFileSync(path, raw.replace(pattern, (full) => full.replace(from, version)));
  console.log(`${label}: ${from} -> ${version}`);
}

if (checkOnly && drifted) {
  console.error("\nRun `node packages/sync-version.mjs` and commit the result.");
  process.exit(1);
}

if (!checkOnly && drifted) {
  console.log(
    "\nNext: review the diff, commit, then publish -- npm: publish the GitHub release as " +
      "usual; PyPI: dispatch publish-pypi.yml.",
  );
}
