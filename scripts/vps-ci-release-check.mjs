import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { collectNpmBulkPayload } from "./npm-bulk-audit.mjs";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const packageManifest = await readJson("package.json");
const packageLock = await readJson("package-lock.json");
const lockRoot = packageLock.packages?.[""];
const lockedTypeScript = packageLock.packages?.["node_modules/typescript"];

assert.equal(packageManifest.name, "aether-agents");
assert.match(packageManifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(packageManifest.license, "Apache-2.0");
assert.equal(packageManifest.engines?.node, ">=24");
assert.deepEqual(packageManifest.bin, {
  aether: "dist/src/main.js",
  "aether-agent": "dist/src/main.js",
});
const runtimeDependency = { "aether-ats-skills": "file:packages/ats-skills" };
assert.deepEqual(packageManifest.dependencies, runtimeDependency);
assert.deepEqual(packageManifest.bundledDependencies, ["aether-ats-skills"]);
assert.deepEqual(packageManifest.optionalDependencies ?? {}, {});
assert.deepEqual(packageManifest.peerDependencies ?? {}, {});

assert.equal(packageLock.lockfileVersion, 3);
assert.equal(packageLock.name, packageManifest.name);
assert.equal(packageLock.version, packageManifest.version);
assert.equal(lockRoot?.name, packageManifest.name);
assert.equal(lockRoot?.version, packageManifest.version);
assert.deepEqual(lockRoot?.dependencies, runtimeDependency);
const atsManifest = await readJson("packages/ats-skills/package.json");
assert.equal(atsManifest.name, "aether-ats-skills");
assert.equal(atsManifest.version, "0.1.0");
assert.deepEqual(atsManifest.dependencies, { "aether-browser": "0.2.2", "aether-context": "0.3.1" });
assert.deepEqual(atsManifest.optionalDependencies ?? {}, {});
assert.deepEqual(atsManifest.peerDependencies ?? {}, {});
collectNpmBulkPayload(packageLock); // Validates the one local link and every registry-backed lock entry.

const typeScriptPin = packageManifest.devDependencies?.typescript;
assert.match(typeScriptPin, /^\d+\.\d+\.\d+$/);
assert.equal(lockRoot?.devDependencies?.typescript, typeScriptPin);
assert.equal(lockedTypeScript?.version, typeScriptPin);

for (const script of [
  "build",
  "typecheck",
  "test",
  "smoke",
  "verify:production",
  "release:truth",
  "release:candidate",
]) {
  assert.equal(typeof packageManifest.scripts?.[script], "string");
}
const forbiddenHooks = ["preinstall", "install", "postinstall", "prepare"];
for (const forbiddenHook of forbiddenHooks) {
  assert.equal(packageManifest.scripts?.[forbiddenHook], undefined);
  assert.equal(atsManifest.scripts?.[forbiddenHook], undefined);
}

const publishedFiles = new Set(packageManifest.files ?? []);
for (const path of [
  "dist/src",
  "README.md",
  "COMMANDS.md",
  "docs/generated/commands.md",
  "docs/generated/model-catalogue.md",
  "docs/model-catalogue/catalogue.json",
  "docs/model-catalogue/index.html",
  "LICENSE",
  "NOTICE.md",
]) {
  assert.ok(publishedFiles.has(path), `package files omit ${path}`);
}

for (const path of [
  "src/main.ts",
  "src/index.ts",
  "src/version.ts",
  "scripts/copy-skill-assets.ts",
  "scripts/release-truth.ts",
  "scripts/release-candidate.ts",
  "test/headless_v2.test.ts",
]) {
  await access(path);
}

const versionSource = await readFile("src/version.ts", "utf8");
const sourceVersion = versionSource.match(/export const VERSION = "([^"]+)";/)?.[1];
assert.equal(sourceVersion, packageManifest.version);

console.log(JSON.stringify({
  check: "aether-agent-release-integrity",
  package: `${packageManifest.name}@${packageManifest.version}`,
  node: packageManifest.engines.node,
  typescript: typeScriptPin,
  status: "passed",
}));
