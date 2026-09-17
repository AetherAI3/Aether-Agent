import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COMMAND_MANIFEST, type CommandManifestEntry } from "../src/commands/command_manifest.js";
import {
  PUBLIC_CATALOGUE_SCHEMA,
  buildGeneratedOutputs,
  generateDocumentation,
  parseCatalogue,
  renderCommandReference,
  sha256,
} from "../scripts/generate-docs.js";
import { deterministicRepositoryEvidence } from "../scripts/release-truth.js";

const unsignedSource = {
  schema: PUBLIC_CATALOGUE_SCHEMA,
  sourceVersion: "cloud-test-v1",
  generatedAt: "2026-08-23T00:00:00.000Z",
  availabilitySemantics: "listed-not-entitled",
  scopeNote: "A sanitized, dated subset; live availability remains account-scoped.",
  models: [
    { id: "model_a", label: "Model A", provider: "unknown", kind: "model", tierMin: "pro", modality: "unknown", availability: "unknown" },
  ],
} as const;
const sourceContent = ({ generatedAt: _generatedAt, ...content }: { generatedAt: string; [key: string]: unknown }) => content;
const source = { ...unsignedSource, digest: sha256(sourceContent(unsignedSource)) } as const;
const CLOUD_1327_HEAD = "70e0645c96b16dedfefb90dd403daecb3c3d3b25";
const CLOUD_1327_MERGE = "fbb7b98a96682820b85a4bface002dcbf5bf9c37";
const CLOUD_1327_TREE = "9906df6f73b6cd8d8e57e1e552475976394d617f";
const CLOUD_1327_DIGEST = "sha256:80ba3ba1144d301e2cca407ceced74cb2b371f1da6e3982b87305ff12a3d4712";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aether-docgen-"));
  mkdirSync(join(root, "docs", "model-catalogue"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Readme\n\n<!-- MODEL-CATALOGUE:START -->\nold\n<!-- MODEL-CATALOGUE:END -->\n", "utf8");
  writeFileSync(
    join(root, "COMMANDS.md"),
    "# Commands\n\n<!-- GENERATED-COMMAND-REFERENCE:START -->\nold\n<!-- GENERATED-COMMAND-REFERENCE:END -->\n\n" +
      "<!-- CLI-COMMANDS:START -->\nold\n<!-- CLI-COMMANDS:END -->\n\n" +
      "<!-- SLASH-COMMANDS:START -->\nold\n<!-- SLASH-COMMANDS:END -->\n",
    "utf8",
  );
  writeFileSync(join(root, "docs", "model-catalogue", "catalogue.source.json"), `${JSON.stringify(source)}\n`, "utf8");
  return root;
}

test("generated command reference is deterministic and sourced from the canonical manifest", () => {
  const first = renderCommandReference(COMMAND_MANIFEST);
  const second = renderCommandReference(COMMAND_MANIFEST);
  assert.equal(first, second);
  assert.match(first, /manifest-digest: sha256:[a-f0-9]{64}/);
  assert.match(first, /`aether agent \[task \| list \| create \| show \| configure \| chat \| activate \| pause \| resume\]`/);
  assert.match(first, /run the coding agent or manage account agents and shared conversations/);
  assert.match(first, /Aliases: `aether code`/);
  assert.match(first, /`\/agent-create \[ATS\] <name>`/);
  assert.match(first, /reset <section> \[--scope global\|project\] \[--preview\]/);
  assert.match(first, /`\/model <n\|id>`/);
  assert.match(first, /Permission: `local-write`/);
  assert.match(first, /Requires: `aether\.hosted-or-local`/);
});

test("bad command mutations fail before any output is written", () => {
  const root = fixtureRoot();
  const original = readFileSync(join(root, "COMMANDS.md"), "utf8");
  const bad = COMMAND_MANIFEST.map((entry, index) => index === 0 ? { ...entry, summary: "" } : entry) as readonly CommandManifestEntry[];
  assert.throws(() => generateDocumentation({ root, commands: bad }), /command 0 summary is required/);
  assert.equal(readFileSync(join(root, "COMMANDS.md"), "utf8"), original);
});

test("command section, summary, and args reject hostile public content before manifest diagnostics", () => {
  const mutations = [
    { section: "**injected heading**" },
    { summary: "password=hunter2" },
    { args: "[click](https://evil.test) `code` --token=plain-secret-value" },
    { args: "<scr<name>ipt>" },
    { args: "<script>" },
    { args: "</script>" },
    { args: "<img onerror=x>" },
    { args: "<new-undeclared-placeholder>" },
  ] as const;
  for (const mutation of mutations) {
    const mutated = COMMAND_MANIFEST.map((entry, index) => index === 0 ? { ...entry, ...mutation } : entry) as readonly CommandManifestEntry[];
    let message = "";
    try { renderCommandReference(mutated); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    assert.match(message, /contains (?:credential-shaped content|markdown injection)/);
    assert.doesNotMatch(message, /hunter2|plain-secret-value|evil\.test/);
  }
});

test("empty or invalid catalogue refresh preserves the last-known-good output set", () => {
  const root = fixtureRoot();
  generateDocumentation({ root });
  const paths = buildGeneratedOutputs({ root }).map((output) => output.path);
  const before = new Map(paths.map((path) => [path, readFileSync(join(root, path), "utf8")]));
  const empty = JSON.stringify({ ...source, models: [] });
  assert.throws(() => generateDocumentation({ root, catalogueSourceText: empty }), /refresh is empty.*preserved/);
  assert.throws(() => generateDocumentation({ root, catalogueSourceText: "not json" }), /not valid JSON/);
  assert.throws(() => generateDocumentation({ root, catalogueSourceText: JSON.stringify({ ...source, pricing: "invented" }) }), /unsupported fields: pricing/);
  for (const path of paths) assert.equal(readFileSync(join(root, path), "utf8"), before.get(path));
});

test("Cloud projection digest, freshness, schema, and safe model fields are mandatory", () => {
  const root = fixtureRoot();
  generateDocumentation({ root });
  const lastGood = readFileSync(join(root, "docs", "model-catalogue", "catalogue.json"), "utf8");
  const changed = { ...source, digest: `sha256:${"0".repeat(64)}` };
  assert.throws(() => generateDocumentation({ root, catalogueSourceText: JSON.stringify(changed) }), /digest does not match/);
  const genericUnsigned = { ...unsignedSource, models: [{ ...source.models[0], id: "model" }] };
  const generic = { ...genericUnsigned, digest: sha256(sourceContent(genericUnsigned)) };
  assert.throws(() => generateDocumentation({ root, catalogueSourceText: JSON.stringify(generic) }), /invalid or generic id/);
  const staleUnsigned = { ...unsignedSource, generatedAt: "2026-01-01T00:00:00.000Z" };
  assert.throws(() => generateDocumentation({ root, catalogueSourceText: JSON.stringify({ ...staleUnsigned, digest: sha256(sourceContent(staleUnsigned)) }) }), /projection is stale/);
  assert.doesNotThrow(() => generateDocumentation({ root, catalogueLiveSourceText: "network unavailable" }));
  const fallback = JSON.parse(readFileSync(join(root, "docs", "model-catalogue", "catalogue.json"), "utf8")) as Record<string, unknown>;
  assert.equal(fallback["offlineFallback"], true);
  assert.equal(readFileSync(join(root, "docs", "model-catalogue", "catalogue.json"), "utf8"), lastGood);
});

test("Cloud content digests are stable across generatedAt and unsupported row fields fail closed", () => {
  const later = { ...source, generatedAt: "2026-08-24T00:00:00.000Z" };
  assert.equal(later.digest, source.digest);
  assert.doesNotThrow(() => parseCatalogue(JSON.stringify(later), Date.parse(later.generatedAt)));
  const withHosting = { ...source, models: [{ ...source.models[0], hosting: "hosted" }] };
  assert.throws(() => parseCatalogue(JSON.stringify(withHosting), Date.parse(source.generatedAt)), /unsupported fields: hosting/);
});

test("checked-in Cloud #1327 projection remains compatible with the Agent consumer contract", () => {
  const text = readFileSync(join(process.cwd(), "docs", "model-catalogue", "catalogue.source.json"), "utf8");
  const raw = JSON.parse(text) as { generatedAt: string };
  const catalogue = parseCatalogue(text, Date.parse(raw.generatedAt));
  const packet = readFileSync(join(process.cwd(), "docs", "releases", "OPERATOR-PACKET-v0.3.0.md"), "utf8");
  const evidence = packet.match(
    /Cloud catalogue compatibility \| PR #1327 final head `([a-f0-9]{40})`; landed as squash merge `([a-f0-9]{40})`, tree `([a-f0-9]{40})`; safe-field projection digest `(sha256:[a-f0-9]{64})`/,
  );
  assert.ok(evidence, "checked-in Cloud catalogue evidence must record the exact commit and tree identities");
  assert.deepEqual(
    { head: evidence[1], merge: evidence[2], tree: evidence[3], digest: evidence[4] },
    { head: CLOUD_1327_HEAD, merge: CLOUD_1327_MERGE, tree: CLOUD_1327_TREE, digest: CLOUD_1327_DIGEST },
    "Cloud catalogue evidence must bind the declared head, landed merge, tree, and projection digest",
  );
  assert.equal(catalogue.digest, evidence[4], `Cloud #1327 ${CLOUD_1327_HEAD} fixture digest drifted`);
  assert.equal(catalogue.models.length, 51);
  const safeFields = ["availability", "id", "kind", "label", "modality", "provider", "tierMin"];
  for (const model of catalogue.models) assert.deepEqual(Object.keys(model).sort(), safeFields);
  assert.equal(catalogue.models.find((model) => model.id === "aether-vision")?.availability, "unavailable");
});

test("future timestamps and hostile public strings are rejected without leaking their values", () => {
  const root = fixtureRoot();
  const futureUnsigned = { ...unsignedSource, generatedAt: "2999-01-01T00:00:00.000Z" };
  const future = { ...futureUnsigned, digest: sha256(sourceContent(futureUnsigned)) };
  assert.throws(() => generateDocumentation({ root, catalogueSourceText: JSON.stringify(future) }), /materially in the future/);
  const hostile = [
    ["Bearer top.secret.value", /credential-shaped/],
    ["password=hunter2", /credential-shaped/],
    ["token=plain-secret-value", /credential-shaped/],
    ["glpat-abcdefghijklmnop", /credential-shaped/],
    ["https://user:password@example.test/data", /credential-shaped/],
    ["Read \/api\/internal\/models", /internal route/],
    ["Read http://[::1]:8080/models", /internal route/],
    ["Read http://[fd00::1]/models", /internal route/],
    ["The cost per token is low", /pricing assertion/],
    ["Only 9 cents per token", /pricing assertion/],
    ["**injected emphasis**", /markdown injection/],
    ["# injected heading", /markdown injection/],
    ["[click](https://evil.test)", /markdown injection/],
    ["`injected code`", /markdown injection/],
    ["unsafe\u0000text", /control characters/],
  ] as const;
  for (const [scopeNote, expected] of hostile) {
    let message = "";
    const hostileUnsigned = { ...unsignedSource, scopeNote };
    try { generateDocumentation({ root, catalogueSourceText: JSON.stringify({ ...hostileUnsigned, digest: sha256(sourceContent(hostileUnsigned)) }) }); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    assert.match(message, expected);
    assert.doesNotMatch(message, /top\.secret\.value|hunter2|plain-secret-value|abcdefghijklmnop|user:password|evil\.test/);
  }
});

test("docs check detects drift and generation repairs it", () => {
  const root = fixtureRoot();
  generateDocumentation({ root });
  assert.doesNotThrow(() => generateDocumentation({ root, check: true }));
  const path = join(root, "docs", "generated", "commands.md");
  writeFileSync(path, `${readFileSync(path, "utf8")}drift\n`, "utf8");
  assert.throws(() => generateDocumentation({ root, check: true }), /generated documentation drift: docs\/generated\/commands\.md/);
  generateDocumentation({ root });
  assert.doesNotThrow(() => generateDocumentation({ root, check: true }));
});

test("docs check and release digests normalize CRLF checkouts", () => {
  const root = fixtureRoot();
  const outputs = generateDocumentation({ root });
  for (const output of outputs) {
    const path = join(root, output.path);
    writeFileSync(path, readFileSync(path, "utf8").replace(/\n/g, "\r\n"), "utf8");
  }
  assert.doesNotThrow(() => generateDocumentation({ root, check: true }));
  const evidence = deterministicRepositoryEvidence(root);
  assert.equal(evidence.generatedDocs?.state, "available");
  if (evidence.generatedDocs?.state === "available") {
    assert.ok(evidence.generatedDocs.value.every((item) => item.manifestDigest === item.documentDigest));
  }
});

test("release truth independently binds every generated output and the catalogue digest", () => {
  const root = fixtureRoot();
  generateDocumentation({ root });
  const evidence = deterministicRepositoryEvidence(root);
  assert.equal(evidence.generatedDocs?.state, "available");
  if (evidence.generatedDocs?.state !== "available") return;
  assert.equal(evidence.generatedDocs.value.length, 6);
  assert.ok(evidence.generatedDocs.value.every((item) => item.manifestDigest === item.documentDigest));
  assert.equal(evidence.catalogue?.state, "available");
  if (evidence.catalogue?.state !== "available") return;
  assert.equal(evidence.catalogue.value.catalogueDigest, evidence.catalogue.value.renderedDigest);
  const path = join(root, "docs", "generated", "commands.md");
  writeFileSync(path, `${readFileSync(path, "utf8")}drift\n`, "utf8");
  const drifted = deterministicRepositoryEvidence(root);
  assert.equal(drifted.generatedDocs?.state, "available");
  if (drifted.generatedDocs?.state === "available") {
    assert.ok(drifted.generatedDocs.value.some((item) => item.manifestDigest !== item.documentDigest));
  }
});

test("catalogue outputs are sanitized, deterministic, responsive, and useful without JavaScript", () => {
  const root = fixtureRoot();
  generateDocumentation({ root });
  const json = JSON.parse(readFileSync(join(root, "docs", "model-catalogue", "catalogue.json"), "utf8")) as Record<string, unknown>;
  assert.match(String(json["digest"]), /^sha256:[a-f0-9]{64}$/);
  assert.equal(json["generatedAt"], source.generatedAt);
  assert.equal(json["offlineFallback"], true);
  assert.equal((json["source"] as Record<string, unknown>)["kind"], "cloud-public-projection");
  assert.equal(json["availabilitySemantics"], "listed-not-entitled");
  const html = readFileSync(join(root, "docs", "model-catalogue", "index.html"), "utf8");
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<noscript>/);
  assert.match(html, /role="search"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /<article class="card"/);
  for (const id of ["provider", "modality", "tier", "availability"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /id="hosting"|data-hosting=|<dt>Hosting<\/dt>/);
  assert.match(html, /data-modality="unknown" data-tier="pro" data-availability="unknown"/);
  assert.match(html, /No prices or spend caps are asserted/);
  assert.doesNotMatch(html, /AETHER_TOKEN|Bearer\s+[A-Za-z0-9._-]+|\/api\/internal/i);
  assert.doesNotMatch(html, /href="[^\"]*RELEASE_NOTES/);
  const markdown = readFileSync(join(root, "docs", "generated", "model-catalogue.md"), "utf8");
  assert.doesNotMatch(markdown, /\]\([^)]*RELEASE_NOTES/);
  const ids = (json["models"] as Array<Record<string, unknown>>).map((model) => String(model["id"]));
  for (const id of ids) {
    assert.match(html, new RegExp(`<code>${id}</code>`));
    assert.match(markdown, new RegExp("\\| `" + id + "` \\|"));
  }
});
