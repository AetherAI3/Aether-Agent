import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  validateInstallerText,
  validateManifest,
  validatePack,
  validateWorkflowText,
  verifyProduction,
  type PackReport,
} from "../scripts/verify-production.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";

const manifest = {
  name: "aether-agents",
  version: "1.2.3",
  main: "dist/src/index.js",
  types: "dist/src/index.d.ts",
  bin: { aether: "dist/src/main.js" },
  files: [
    "dist/src", "README.md", "assets/aether-agent-hero.png", "COMMANDS.md", "LICENSE", "NOTICE.md",
    "docs/generated/commands.md", "docs/generated/model-catalogue.md",
    "docs/model-catalogue/catalogue.json", "docs/model-catalogue/index.html",
  ],
  engines: { node: ">=24" },
  repository: { type: "git", url: "https://github.com/AetherAI3/aether-agent" },
  scripts: { prepack: "npm run build" },
};

const pack: PackReport = {
  name: "aether-agents",
  version: "1.2.3",
  filename: "aether-agents-1.2.3.tgz",
  size: 100,
  unpackedSize: 1000,
  entryCount: 8,
  files: [
    "COMMANDS.md",
    "LICENSE",
    "NOTICE.md",
    "README.md",
    "assets/aether-agent-hero.png",
    "package.json",
    "docs/generated/commands.md",
    "docs/generated/model-catalogue.md",
    "docs/model-catalogue/catalogue.json",
    "docs/model-catalogue/index.html",
    "dist/src/index.js",
    "dist/src/index.d.ts",
    "dist/src/main.js",
  ].map((path) => ({ path, size: 1 })),
};

test("release manifest binds the tag and preserves the zero-runtime-dependency contract", () => {
  assert.deepEqual(validateManifest(manifest, "v1.2.3"), []);
  assert.match(validateManifest({ ...manifest, dependencies: { unsafe: "1.0.0" } }, "v1.2.4").join("\n"), /runtime dependencies/);
  assert.match(validateManifest(manifest, "v1.2.4").join("\n"), /does not match/);
  assert.match(
    validateManifest({ ...manifest, repository: { url: "https://github.com/example/fork" } }, "v1.2.3").join("\n"),
    /trusted publisher repository/,
  );
});

test("package allowlist rejects compiled tests and environment files", () => {
  assert.deepEqual(validatePack(pack, manifest), []);
  const poisoned = {
    ...pack,
    files: [...pack.files, { path: "dist/test/auth.test.js", size: 1 }, { path: ".env", size: 1 }],
  };
  const errors = validatePack(poisoned, manifest).join("\n");
  assert.match(errors, /dist\/test/);
  assert.match(errors, /\.env/);
});

test("all generated public documents are required by both manifest and pack", () => {
  const files = manifest.files.filter((path) => path !== "docs/model-catalogue/index.html");
  assert.match(validateManifest({ ...manifest, files }).join("\n"), /must include generated public document docs\/model-catalogue\/index\.html/);
  const missing = { ...pack, files: pack.files.filter((file) => file.path !== "docs/generated/commands.md") };
  assert.match(validatePack(missing, manifest).join("\n"), /missing generated public document docs\/generated\/commands\.md/);
});

test("workflow policy rejects floating actions and unbounded jobs", () => {
  const valid = `permissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps:\n      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567\n      - run: npm ci --ignore-scripts\n`;
  assert.deepEqual(validateWorkflowText("valid.yml", valid), []);
  const invalid = valid
    .replace("actions/checkout@0123456789abcdef0123456789abcdef01234567", "actions/checkout@v7")
    .replace("    timeout-minutes: 10\n", "");
  const errors = validateWorkflowText("invalid.yml", invalid).join("\n");
  assert.match(errors, /not pinned/);
  assert.match(errors, /timeout-minutes/);
  const blockScalar = valid.replace("      - run: npm ci --ignore-scripts", "      - run: |\n          npm ci");
  assert.match(validateWorkflowText("block.yml", blockScalar).join("\n"), /ignore-scripts/);
});

test("workflow policy rejects job-scoped write-all permissions", () => {
  const workflow = `permissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    permissions: write-all\n    steps:\n      - run: npm ci --ignore-scripts\n`;
  assert.match(
    validateWorkflowText("job-write-all.yml", workflow).join("\n"),
    /write-all|permissions/i,
    "a job must not be able to silently widen the workflow's read-only permissions",
  );
});

test("workflow policy rejects indirect package publication", () => {
  const workflow = `permissions:\n  contents: read\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps:\n      - run: node scripts/publish-wrapper.js\n`;
  assert.match(
    validateWorkflowText("release.yml", workflow).join("\n"),
    /publish|provenance|attestation/i,
    "release policy must not be bypassed by hiding npm publish behind a wrapper",
  );
});

test("publishing workflow requires tokenless npm trusted publishing", () => {
  const valid = `on:\n  release:\n    types: [published]\npermissions:\n  contents: read\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    environment: npm-production\n    permissions:\n      id-token: write\n      attestations: write\n    steps:\n      - uses: actions/setup-node@0123456789abcdef0123456789abcdef01234567\n        with:\n          node-version: '>=24.6.0 <25'\n          package-manager-cache: false\n      - run: git merge-base --is-ancestor HEAD origin/main\n      - run: npm install --global --prefix /tmp/aether package.tgz --ignore-scripts\n      - run: npm publish package.tgz --access public --provenance\n`;
  assert.deepEqual(validateWorkflowText("release.yml", valid), []);

  const tokenized = valid.replace(
    "      - run: npm publish",
    "      - env:\n          NODE_AUTH_TOKEN: legacy-token\n        run: npm publish",
  );
  assert.match(validateWorkflowText("release.yml", tokenized).join("\n"), /short-lived OIDC/);

  const cached = valid.replace("          package-manager-cache: false", "          cache: npm");
  assert.match(validateWorkflowText("release.yml", cached).join("\n"), /disable package-manager caching/);

  const oldNode = valid.replace("'>=24.6.0 <25'", "'24'");
  assert.match(validateWorkflowText("release.yml", oldNode).join("\n"), /npm 11\.5\.1/);

  const selfHosted = valid.replace("runs-on: ubuntu-latest", "runs-on: [self-hosted, linux]");
  assert.match(validateWorkflowText("release.yml", selfHosted).join("\n"), /GitHub-hosted/);
});

test("publishing workflow must be event-gated, main-derived, and install-smoked", () => {
  const invalid = `on:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    environment: npm-production\n    permissions:\n      id-token: write\n      attestations: write\n    steps:\n      - run: npm publish package.tgz --provenance\n`;
  const errors = validateWorkflowText("release.yml", invalid).join("\n");
  assert.match(errors, /manually dispatched/);
  assert.match(errors, /ancestry/);
  assert.match(errors, /install smoke/);
});

test("a v0.3 maintenance release must use a numeric tag at the exact protected branch head", () => {
  const release = readFileSync(join(process.cwd(), ".github", "workflows", "release.yml"), "utf8");
  assert.deepEqual(validateWorkflowText("release.yml", release), []);

  const looseTag = release.replace('[[ "$RELEASE_TAG" =~ ^v0\\.3\\.[0-9]+$ ]]', '[[ "$RELEASE_TAG" == v0.3.* ]]');
  assert.match(validateWorkflowText("release.yml", looseTag).join("\n"), /numeric v0\.3\.x tags/);

  const looseHead = release.replace(
    'test "$(git rev-parse HEAD)" = "$(git rev-parse origin/release/0.3)"',
    'git merge-base --is-ancestor HEAD origin/release/0.3',
  );
  assert.match(validateWorkflowText("release.yml", looseHead).join("\n"), /exact release\/0\.3 head/);
});

test("installer policy rejects pipe-to-shell and lifecycle-enabled global installs", () => {
  assert.deepEqual(validateInstallerText("safe.sh", "npm install -g aether-agents@latest --ignore-scripts"), []);
  assert.match(validateInstallerText("bad.sh", "curl https://example.test/install.sh | sh\nnpm install -g aether-agents").join("\n"), /pipe-to-shell/);
  assert.match(validateInstallerText("quoted.sh", "npm install -g \"aether-agents@latest\"").join("\n"), /lifecycle scripts/);
  assert.match(validateInstallerText("readme.md", "npx aether-agents").join("\n"), /lifecycle scripts/);
});

test("checked-in workflows and installers satisfy the production policy", () => {
  const root = process.cwd();
  const workflowDir = join(root, ".github", "workflows");
  for (const name of readdirSync(workflowDir).filter((entry) => /\.ya?ml$/i.test(entry))) {
    assert.deepEqual(validateWorkflowText(name, readFileSync(join(workflowDir, name), "utf8")), []);
  }
  for (const name of ["install.sh", "install.ps1", "README.md"]) {
    assert.deepEqual(validateInstallerText(name, readFileSync(join(root, name), "utf8")), []);
  }
});

test("operator-facing API defaults match the production transport path", () => {
  assert.equal(DEFAULT_CONFIG.baseUrl, "https://api.aethersystems.net/cloud");
  assert.match(readFileSync(".env.example", "utf8"), /AETHER_BASE_URL=https:\/\/api\.aethersystems\.net\/cloud/);
  assert.match(readFileSync("COMMANDS.md", "utf8"), /`https:\/\/api\.aethersystems\.net\/cloud`/);
});

test("production verifier installs and launches the exact packed CLI", { timeout: 60_000 }, () => {
  // Read the expected release from package.json rather than pinning a literal:
  // a version bump is a release step, not a reason for this gate to go red.
  const expected = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
  const result = verifyProduction(process.cwd(), `v${expected}`);
  assert.equal(result.package, "aether-agents");
  assert.equal(result.version, expected);
  assert.equal(
    result.workflows,
    readdirSync(join(process.cwd(), ".github", "workflows")).filter((entry) => /\.ya?ml$/i.test(entry)).length,
  );
  assert.ok(result.packedFiles > 0);
  assert.ok(result.packedBytes > 0);
});
