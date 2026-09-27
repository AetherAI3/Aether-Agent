import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  RELEASE_TRUTH_SCHEMA,
  documentedCommands,
  documentedSlashCommands,
  evaluateReleaseTruth,
  releaseTruthFailure,
  derivePublicRegistryClaim,
  runReleaseTruth,
  scanRepositoryTexts,
  type ReleaseTruthInput,
} from "../scripts/release-truth.js";

const commands = [
  { name: "agent", aliases: ["code"], release: { disposition: "existing" as const, note: null } },
  { name: "doctor", release: { disposition: "existing" as const, note: null } },
  { name: "skills", release: { disposition: "existing" as const, note: null } },
  { name: "login", hidden: true, release: { disposition: "internal" as const, note: null } },
] as const;
const slashCommands = [
  { name: "help", release: { disposition: "existing" as const, note: null } },
  { name: "model", aliases: ["models"], release: { disposition: "existing" as const, note: null } },
] as const;

function validInput(): ReleaseTruthInput {
  const packet = [
    "# Operator packet — Aether Agent v0.3.0",
    "",
    "| Proposed tag | `v0.3.0` |",
  ].join("\n");
  const commandsDoc = [
    "# Commands",
    "<!-- CLI-COMMANDS:START -->",
    "`agent` `doctor` `skills`",
    "<!-- CLI-COMMANDS:END -->",
    "<!-- SLASH-COMMANDS:START -->",
    "`help` `model`",
    "<!-- SLASH-COMMANDS:END -->",
  ].join("\n");
  const files = {
    "package.json": JSON.stringify({
      name: "aether-agents", version: "0.3.0", main: "dist/src/main.js", types: "dist/src/index.d.ts",
      bin: { aether: "dist/src/main.js" },
    }),
    "package-lock.json": JSON.stringify({
      name: "aether-agents",
      version: "0.3.0",
      packages: { "": { name: "aether-agents", version: "0.3.0" } },
    }),
    "src/version.ts": 'export const VERSION = "0.3.0";\n',
    "README.md": "Run `aether doctor`, `aether skills list`, or the `aether code` compatibility alias.\n",
    "COMMANDS.md": commandsDoc,
    "RELEASE_NOTES.md": "# Aether Agent v0.3.0 — release truth\n\nUse `aether agent`.\n",
    "docs/releases/OPERATOR-PACKET-v0.3.0.md": packet,
  };
  return {
    files,
    scannedTexts: { ...files, "src/example.ts": "export const safe = true;\n" },
    packedFiles: ["package.json", "README.md", "COMMANDS.md", "dist/src/main.js", "dist/src/index.d.ts"],
    commands,
    slashCommands,
    capabilities: { state: "available", value: [] },
    generatedDocs: { state: "available", value: [] },
    catalogue: { state: "available", value: { catalogueDigest: "abc", renderedDigest: "abc", generatedAt: "2026-08-22T00:00:00Z", observedAt: "2026-08-23T00:00:00Z", maxAgeMs: 172_800_000 } },
    registry: { state: "available", value: { sourceVersion: "0.3.0", publishedVersions: ["0.1.0"], latest: "0.1.0", publicClaim: { sourceVersion: "0.3.0", pinnedRegistryClaims: [] } } },
  };
}

test("release-truth@1 emits a stable machine-readable passing result", () => {
  const result = evaluateReleaseTruth(validInput());
  assert.equal(result.schema, RELEASE_TRUTH_SCHEMA);
  assert.equal(result.status, "pass");
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, { total: 12, passed: 12, failed: 0, unavailable: 0, notApplicable: 0 });
  assert.match(JSON.stringify(result), /aether-agent\/release-truth@1/);
  assert.match(result.humanSummary[0]!, /^PASS/);
});

test("version disagreement fails with exact evidence and remediation", () => {
  const input = validInput();
  input.files = { ...input.files, "src/version.ts": 'export const VERSION = "0.2.0";\n' };
  const result = evaluateReleaseTruth(input);
  const finding = result.checks.find((item) => item.id === "version.agreement");
  assert.equal(result.ok, false);
  assert.equal(finding?.status, "fail");
  assert.match(finding?.evidence.join("\n") ?? "", /src\/version\.ts differs/);
  assert.match(finding?.remediation ?? "", /both lock fields/);
  assert.match(result.humanSummary.join("\n"), /remediation:/);
});

test("required public docs must exist in the actual packed file list", () => {
  const input = validInput();
  input.packedFiles = input.packedFiles.filter((path) => path !== "COMMANDS.md");
  const result = evaluateReleaseTruth(input);
  const finding = result.checks.find((item) => item.id === "package.public-docs");
  assert.equal(finding?.status, "fail");
  assert.deepEqual(finding?.evidence, ["COMMANDS.md must exist in the repository and packed package"]);
});

test("canonical docs reject removed commands and require every visible command", () => {
  const input = validInput();
  input.files = {
    ...input.files,
    "COMMANDS.md": [
      "<!-- CLI-COMMANDS:START -->",
      "`agent` `doctor` `removed-command`",
      "<!-- CLI-COMMANDS:END -->",
    ].join("\n"),
  };
  const finding = evaluateReleaseTruth(input).checks.find((item) => item.id === "commands.canonical-index");
  assert.equal(finding?.status, "fail");
  assert.match(finding?.evidence.join("\n") ?? "", /omits shipped commands: skills/);
  assert.match(finding?.evidence.join("\n") ?? "", /removed or nonexistent commands: removed-command/);
});

test("canonical CLI and slash indexes reject duplicate entries", () => {
  const input = validInput();
  input.files = { ...input.files, "COMMANDS.md": String(input.files["COMMANDS.md"]).replace("`agent` `doctor` `skills`", "`agent` `doctor` `doctor` `skills`").replace("`help` `model`", "`help` `help` `model`") };
  const evidence = evaluateReleaseTruth(input).checks.find((item) => item.id === "commands.canonical-index")?.evidence.join("\n") ?? "";
  assert.match(evidence, /CLI index contains duplicate entries: doctor/);
  assert.match(evidence, /slash index contains duplicate entries: help/);
});

test("public examples accept aliases but reject nonexistent commands", () => {
  const input = validInput();
  input.files = { ...input.files, "README.md": "Use `aether code` or `aether teleport`.\n" };
  const finding = evaluateReleaseTruth(input).checks.find((item) => item.id === "commands.public-examples");
  assert.equal(finding?.status, "fail");
  assert.deepEqual(finding?.evidence, ["README.md contains removed or nonexistent command examples: teleport"]);
  assert.deepEqual(documentedCommands("Aether Agent is a product. `aether doctor --live` works."), ["doctor"]);
});

test("command parsing handles environment assignments, global flags, and slash commands", () => {
  assert.deepEqual(documentedCommands("`AETHER_AGENT_DEV_ENABLED=1 aether --json --model sonnet doctor --live`"), ["doctor"]);
  assert.deepEqual(documentedCommands("aether --cwd . --yes skills list"), ["skills"]);
  assert.deepEqual(documentedSlashCommands("Use `/help`, `/models`, and `/model sonnet`."), ["help", "model", "models"]);
  assert.deepEqual(documentedCommands("This removed friction: use `aether teleport`."), ["teleport"]);
  assert.deepEqual(documentedSlashCommands("This was improved: use `/teleport`."), ["teleport"]);
  assert.deepEqual(documentedSlashCommands("Typos get a nudge: `/modle` answers with a suggestion."), []);
  assert.deepEqual(documentedCommands("Expected typo example: `aether auht` suggests `aether auth`."), []);
  assert.deepEqual(documentedCommands("A typo example without the marker still audits `aether auht`."), ["auht"]);
});

test("every command requires release disposition metadata", () => {
  const input = validInput();
  input.commands = [{ name: "agent" }];
  const finding = evaluateReleaseTruth(input).checks.find((item) => item.id === "commands.release-disposition");
  assert.equal(finding?.status, "fail");
  assert.match(finding?.evidence.join("\n") ?? "", /agent has no release disposition/);
});

test("the repository-wide retired-product regression guard is case-insensitive", () => {
  const input = validInput();
  input.scannedTexts = {
    ...input.scannedTexts,
    "docs/stale.md": "Visit HTTPS://" + ["AETHERSYSTEMS", "NET/TERMINAL"].join(".") + " today.",
  };
  const finding = evaluateReleaseTruth(input).checks.find((item) => item.id === "links.no-aether-terminal");
  assert.equal(finding?.status, "fail");
  assert.deepEqual(finding?.evidence, ["docs/stale.md contains the retired product URL"]);
  assert.match(finding?.remediation ?? "", /outside Aether Agent/);
});

test("the collector scans every regular text extension and records binary/undecodable skips", () => {
  const root = mkdtempSync(join(tmpdir(), "release-truth-scan-"));
  try {
    const names = ["x.tsx", "x.jsx", "x.xml", "x.csv", "x.ini", "x.conf", ".env", ".npmrc"];
    const forbidden = ["aethersystems", "net/terminal"].join(".");
    for (const name of names) writeFileSync(join(root, name), `${forbidden}-${name}`);
    writeFileSync(join(root, "binary.bin"), new Uint8Array([0, 1, 2]));
    writeFileSync(join(root, "invalid.data"), new Uint8Array([0xc3, 0x28]));
    const scan = scanRepositoryTexts(root);
    for (const name of names) assert.equal(scan.texts[name], `${forbidden}-${name}`);
    assert.equal(scan.skips.find((item) => item.path === "binary.bin")?.reason, "binary");
    assert.equal(scan.skips.find((item) => item.path === "invalid.data")?.reason, "undecodable");
    const input = validInput(); input.scannedTexts = { ...input.scannedTexts, ...scan.texts };
    const finding = evaluateReleaseTruth(input).checks.find((item) => item.id === "links.no-aether-terminal");
    assert.equal(finding?.evidence.length, names.length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bounded scan gaps are unavailable, while binary skips remain explicit evidence", () => {
  const input = validInput();
  input.scanSkips = [{ path: "large.txt", reason: "oversized", detail: "too large" }, { path: "logo.png", reason: "binary", detail: "NUL" }];
  const result = evaluateReleaseTruth(input);
  const finding = result.checks.find((item) => item.id === "scan.coverage");
  assert.equal(result.status, "unavailable");
  assert.equal(finding?.status, "unavailable");
  assert.match(finding?.evidence.join("\n") ?? "", /logo\.png: binary/);
});

test("new evidence lanes fail drift and never turn absent data green", () => {
  const input = validInput();
  input.capabilities = { state: "available", value: [{ id: "preview", shipped: true, documented: false, releaseDisposition: null }] };
  input.generatedDocs = { state: "available", value: [{ id: "commands", manifestDigest: "a", documentDigest: "b" }] };
  input.catalogue = { state: "available", value: { catalogueDigest: "a", renderedDigest: "b", generatedAt: "2026-01-01T00:00:00Z", observedAt: "2026-08-23T00:00:00Z", maxAgeMs: 1 } };
  input.files = { ...input.files, "package.json": JSON.stringify({ name: "aether-agents", version: "0.3.0", main: "dist/src/preview.js" }) };
  input.registry = { state: "unavailable", reason: "network down" };
  const result = evaluateReleaseTruth(input);
  for (const id of ["capabilities.release-disposition", "generated-docs.digest", "catalogue.digest-freshness", "package.claim-inventory"]) assert.equal(result.checks.find((item) => item.id === id)?.status, "fail");
  assert.equal(result.checks.find((item) => item.id === "registry.source-truth")?.status, "unavailable");
  assert.equal(result.ok, false);

  const absent = validInput(); delete absent.capabilities; delete absent.generatedDocs; delete absent.catalogue;
  const absentResult = evaluateReleaseTruth(absent);
  assert.equal(absentResult.checks.find((item) => item.id === "catalogue.digest-freshness")?.status, "unavailable");
  assert.equal(absentResult.ok, false);
});

test("collection failures always return structured release-truth JSON with remediation", async () => {
  const result = await runReleaseTruth(join(tmpdir(), "definitely-missing-release-truth-root"), {}, []);
  assert.equal(result.schema, RELEASE_TRUTH_SCHEMA);
  assert.equal(result.status, "unavailable");
  assert.equal(result.checks[0]?.id, "collection.unavailable");
  assert.match(result.checks[0]?.remediation ?? "", /Restore readable repository files/);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(result)));
  const pack = releaseTruthFailure("pack", new Error("pack exploded"));
  assert.equal(pack.checks[0]?.id, "pack.unavailable");
  assert.match(pack.checks[0]?.remediation ?? "", /npm pack --dry-run --json/);
  const secret = releaseTruthFailure("pack", new Error("AETHER_TOKEN=secret-value Bearer abc.def"));
  assert.doesNotMatch(JSON.stringify(secret), /secret-value|abc\.def/);
});

test("a required capability missing from independent evidence fails closed", () => {
  const input = validInput();
  input.commands = [{ ...commands[0]!, capabilityRequirements: ["aether.synthetic"] }, ...commands.slice(1)];
  input.capabilities = { state: "available", value: [] };
  const finding = evaluateReleaseTruth(input).checks.find((item) => item.id === "capabilities.release-disposition");
  assert.equal(finding?.status, "fail");
  assert.match(finding?.evidence.join("\n") ?? "", /aether\.synthetic.*no capability evidence/);
});

test("missing package manifest targets fail the independently derived claim inventory", () => {
  const input = validInput();
  input.packedFiles = input.packedFiles.filter((path) => path !== "dist/src/index.d.ts");
  const finding = evaluateReleaseTruth(input).checks.find((item) => item.id === "package.claim-inventory");
  assert.equal(finding?.status, "fail");
  assert.match(finding?.evidence.join("\n") ?? "", /package\.json#types claims dist\/src\/index\.d\.ts/);
});

test("catalogue evidence rejects a materially future generatedAt", () => {
  const input = validInput();
  input.catalogue = { state: "available", value: { catalogueDigest: "a", renderedDigest: "a", generatedAt: "2026-08-24T00:00:00Z", observedAt: "2026-08-23T00:00:00Z", maxAgeMs: 172_800_000 } };
  const finding = evaluateReleaseTruth(input).checks.find((item) => item.id === "catalogue.digest-freshness");
  assert.equal(finding?.status, "fail");
  assert.match(finding?.evidence.join("\n") ?? "", /materially in the future/);
});

test("generated public documents are required independently by package files and public links", () => {
  const input = validInput();
  const generated = [
    "docs/generated/commands.md",
    "docs/generated/model-catalogue.md",
    "docs/model-catalogue/catalogue.json",
    "docs/model-catalogue/index.html",
  ];
  input.files = {
    ...input.files,
    "package.json": JSON.stringify({
      name: "aether-agents", version: "0.3.0", main: "dist/src/main.js", types: "dist/src/index.d.ts",
      bin: { aether: "dist/src/main.js" }, files: ["dist/src", ...generated],
    }),
    "README.md": "[HTML](docs/model-catalogue/index.html) [JSON](docs/model-catalogue/catalogue.json) [Markdown](docs/generated/model-catalogue.md)",
    "COMMANDS.md": `${input.files["COMMANDS.md"]}\n[Generated commands](docs/generated/commands.md)`,
  };
  input.packedFiles = [...input.packedFiles, ...generated.filter((path) => path !== "docs/model-catalogue/index.html")];
  const finding = evaluateReleaseTruth(input).checks.find((item) => item.id === "package.claim-inventory");
  assert.equal(finding?.status, "fail");
  const evidence = finding?.evidence.join("\n") ?? "";
  assert.match(evidence, /package\.json#files.*docs\/model-catalogue\/index\.html/);
  assert.match(evidence, /public-link:README\.md.*docs\/model-catalogue\/index\.html/);
});

test("not_applicable cannot hide a required evidence lane without its explicit contract", () => {
  const input = validInput();
  input.generatedDocs = { state: "not_applicable", reason: "nothing to see", contract: "self-attested" };
  const finding = evaluateReleaseTruth(input).checks.find((item) => item.id === "generated-docs.digest");
  assert.equal(finding?.status, "fail");
  assert.match(finding?.evidence.join("\n") ?? "", /expected release-truth\/v0\.3\.0\/no-generated-docs/);
});

test("packed public docs that pin registry state fail registry source truth", () => {
  const input = validInput();
  input.registry = {
    state: "available",
    value: {
      sourceVersion: "0.3.0", publishedVersions: ["0.1.0"], latest: "0.1.0",
      publicClaim: { sourceVersion: "0.3.0", pinnedRegistryClaims: ["README.md: npm-latest table cell names a fixed version"] },
    },
  };
  const finding = evaluateReleaseTruth(input).checks.find((item) => item.id === "registry.source-truth");
  assert.equal(finding?.status, "fail");
  assert.match(finding?.evidence.join("\n") ?? "", /pin registry state that publishing invalidates: README\.md/);
  assert.match(finding?.remediation ?? "", /never hard-code a dist-tag version/);
});

test("registry source truth still catches a drifting source claim and an unpublished dist-tag", () => {
  const drifted = validInput();
  drifted.registry = {
    state: "available",
    value: { sourceVersion: "0.3.0", publishedVersions: ["0.1.0"], latest: "0.1.0", publicClaim: { sourceVersion: "0.2.0", pinnedRegistryClaims: [] } },
  };
  const driftFinding = evaluateReleaseTruth(drifted).checks.find((item) => item.id === "registry.source-truth");
  assert.equal(driftFinding?.status, "fail");
  assert.match(driftFinding?.evidence.join("\n") ?? "", /public source-build claim 0\.2\.0 differs from the package version 0\.3\.0/);

  const ghost = validInput();
  ghost.registry = {
    state: "available",
    value: { sourceVersion: "0.3.0", publishedVersions: ["0.1.0"], latest: "9.9.9", publicClaim: { sourceVersion: "0.3.0", pinnedRegistryClaims: [] } },
  };
  const ghostFinding = evaluateReleaseTruth(ghost).checks.find((item) => item.id === "registry.source-truth");
  assert.equal(ghostFinding?.status, "fail");
  assert.match(ghostFinding?.evidence.join("\n") ?? "", /observed latest dist-tag 9\.9\.9 is not among published versions/);
});

test("public registry claims are derived from packed docs and reject pre-publish-only wording", () => {
  const pinned = derivePublicRegistryClaim({
    "README.md": [
      "| Install | Version | What you get |",
      "|---|---:|---|",
      "| npm `latest` | **0.1.0** | Published baseline. |",
      "| `main` source build | **0.3.0** | Everything below. |",
      "",
      "> npm `latest` still resolves to **0.1.0**. Wait for a future published 0.3.x release.",
    ].join("\n"),
  });
  assert.equal(pinned.sourceVersion, "0.3.0");
  assert.deepEqual(pinned.pinnedRegistryClaims, [
    "README.md: npm-latest table cell names a fixed version",
    "README.md: prose asserts the source version is unpublished",
    "README.md: prose pins the npm latest dist-tag to a fixed version",
  ]);

  const live = derivePublicRegistryClaim({
    "README.md": [
      "| Install | Version | What you get |",
      "|---|---:|---|",
      "| npm `latest` | [![npm latest](https://img.shields.io/npm/v/aether-agents?label=&color=14b8a6)](https://www.npmjs.com/package/aether-agents) | The live `latest` dist-tag. |",
      "| `main` source build | **0.3.0** | Everything below. |",
      "",
      "> Run `npm view aether-agents version` for the live `latest` dist-tag, and `aether --version` for what you installed. Sections marked \u201csource 0.3.0\u201d require **0.3.0 or newer**.",
    ].join("\n"),
  });
  assert.equal(live.sourceVersion, "0.3.0");
  assert.deepEqual(live.pinnedRegistryClaims, []);
  const maintenance = derivePublicRegistryClaim({
    "README.md": "| `release/0.3` source | **0.3.3** | Check the live npm badge for the published package version. |",
  });
  assert.equal(maintenance.sourceVersion, "0.3.3");
  assert.deepEqual(maintenance.pinnedRegistryClaims, []);
});

test("the shipped README states npm status in a way publishing cannot falsify", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const claim = derivePublicRegistryClaim({ "README.md": readme });
  assert.deepEqual(claim.pinnedRegistryClaims, []);
  assert.equal(claim.sourceVersion, manifest.version);
});
