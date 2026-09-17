import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_MANIFEST } from "../src/commands/command_manifest.js";
import { buildGeneratedOutputs, normalizeEol, sha256 } from "./generate-docs.js";

export const RELEASE_TRUTH_SCHEMA = "aether-agent/release-truth@1" as const;
export const NOT_APPLICABLE_CONTRACTS = {
  "generated-docs.digest": "release-truth/v0.3.0/no-generated-docs",
  "catalogue.digest-freshness": "release-truth/v0.3.0/live-catalogue-only",
  "registry.source-truth": "release-truth/offline/no-network",
} as const;
export type Evidence<T> =
  | { state: "available"; value: T }
  | { state: "unavailable"; reason: string }
  | { state: "not_applicable"; reason: string; contract: string };
export interface ReleaseTruthCommand {
  name: string;
  aliases?: readonly string[];
  hidden?: boolean;
  capabilityRequirements?: readonly string[];
  release?: { disposition: "existing" | "new" | "changed" | "deprecated" | "internal"; note: string | null } | null;
}
export interface ScanSkip { path: string; reason: "binary" | "undecodable" | "oversized" | "budget" | "non_regular" | "excluded_directory"; detail: string }
export interface CapabilityDisposition { id: string; shipped: boolean; documented: boolean; releaseDisposition: "announced" | "exempt" | "removed" | null }
export interface GeneratedDocDigest { id: string; manifestDigest: string; documentDigest: string }
export interface CatalogueTruth { catalogueDigest: string; renderedDigest: string; generatedAt: string; observedAt: string; maxAgeMs: number }
export interface PackedClaim { id: string; source: string; requiredPaths: readonly string[] }
export interface PublicRegistryClaim { sourceVersion: string | null; pinnedRegistryClaims: readonly string[] }
export interface RegistryTruth { sourceVersion: string; publishedVersions: readonly string[]; latest: string | null; publicClaim: PublicRegistryClaim }
export interface ReleaseTruthEvidence {
  capabilities?: Evidence<readonly CapabilityDisposition[]>;
  generatedDocs?: Evidence<readonly GeneratedDocDigest[]>;
  catalogue?: Evidence<CatalogueTruth>;
  registry?: Evidence<RegistryTruth>;
}
export interface ReleaseTruthInput extends ReleaseTruthEvidence {
  files: Readonly<Record<string, string>>;
  scannedTexts: Readonly<Record<string, string>>;
  scanSkips?: readonly ScanSkip[];
  packedFiles: readonly string[];
  commands: readonly ReleaseTruthCommand[];
  slashCommands?: readonly ReleaseTruthCommand[];
}
export type CheckStatus = "pass" | "fail" | "unavailable" | "not_applicable";
export interface ReleaseTruthCheck { id: string; status: CheckStatus; summary: string; remediation: string; evidence: string[] }
export interface ReleaseTruthResult {
  schema: typeof RELEASE_TRUTH_SCHEMA;
  status: "pass" | "fail" | "unavailable";
  ok: boolean;
  version: string | null;
  summary: { total: number; passed: number; failed: number; unavailable: number; notApplicable: number };
  checks: ReleaseTruthCheck[];
  humanSummary: string[];
}

const EXCLUDED_DIRECTORIES = new Set([".git", ".aether-output", "coverage", "dist", "node_modules"]);
const CLI_MARKERS = ["<!-- CLI-COMMANDS:START -->", "<!-- CLI-COMMANDS:END -->"] as const;
const SLASH_MARKERS = ["<!-- SLASH-COMMANDS:START -->", "<!-- SLASH-COMMANDS:END -->"] as const;
const FORBIDDEN_URL = ["aethersystems", "net/terminal"].join(".");
const FORBIDDEN_PATTERN = new RegExp(FORBIDDEN_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
const VALUE_FLAGS = new Set(["--model", "--agent", "--cwd", "--token", "--username", "--password", "--license-key", "--pool", "--effort", "--test-cmd", "--repo", "--swarm", "--resume", "--out", "--skill", "--junit", "--scope"]);

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null;
  try { const value = JSON.parse(text) as unknown; return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
  catch { return null; }
}
const headingVersion = (text: string | undefined): string | null => text?.split(/\r?\n/).find((line) => /^#\s+\S/.test(line))?.match(/\bv(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
const releaseHeadingVersion = (line: string): string | null => line.match(/^#\s+Aether Agent v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
const firstVersionedHeading = (text: string | undefined): string | null => text?.split(/\r?\n/).map(releaseHeadingVersion).find((value) => value !== null) ?? null;
function packetEvidenceState(text: string | undefined): "candidate" | "frozen-prerelease" | null {
  if (text === undefined) return null;
  const rows = text.split(/\r?\n/).filter((line) => /^\|\s*Evidence state\s*\|/u.test(line));
  if (rows.length !== 1) return null;
  return rows[0]!.match(/^\|\s*Evidence state\s*\|\s*`(candidate|frozen-prerelease)`\s*\|\s*$/u)?.[1] as "candidate" | "frozen-prerelease" | undefined ?? null;
}
function releaseNotesOrderingFailure(text: string | undefined): string | null {
  if (text === undefined) return null;
  const headings = text.split(/\r?\n/).filter((line) => /^#\s+\S/.test(line));
  const unreleased = headings.map((line, index) => /^#\s+Unreleased\b/i.test(line) ? index : -1).filter((index) => index >= 0);
  const versioned = headings.findIndex((line) => releaseHeadingVersion(line) !== null);
  if (unreleased.length > 1) return "RELEASE_NOTES.md contains multiple Unreleased sections";
  return unreleased.length === 1 && versioned >= 0 && unreleased[0]! > versioned
    ? "RELEASE_NOTES.md places Unreleased below a versioned release"
    : null;
}
const sourceVersion = (text: string | undefined): string | null => text?.match(/export\s+const\s+VERSION\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
function check(id: string, failures: readonly string[], success: string, remediation: string): ReleaseTruthCheck {
  return failures.length ? { id, status: "fail", summary: failures[0]!, remediation, evidence: [...failures] } : { id, status: "pass", summary: success, remediation, evidence: [] };
}
function evidenceCheck<T>(id: string, source: Evidence<T> | undefined, inspect: (value: T) => string[], success: string, remediation: string): ReleaseTruthCheck {
  const evidence: Evidence<T> = source ?? { state: "unavailable", reason: "no evidence was supplied" };
  if (evidence.state === "not_applicable") {
    const expected = NOT_APPLICABLE_CONTRACTS[id as keyof typeof NOT_APPLICABLE_CONTRACTS];
    if (!expected || evidence.contract !== expected) {
      return {
        id, status: "fail", summary: "not_applicable evidence has no recognized contract", remediation,
        evidence: [`received ${evidence.contract || "no contract"}; expected ${expected ?? "an applicable evidence lane"}`],
      };
    }
    return { id, status: evidence.state, summary: evidence.reason, remediation, evidence: [`${evidence.contract}: ${evidence.reason}`] };
  }
  if (evidence.state !== "available") return { id, status: evidence.state, summary: evidence.reason, remediation, evidence: [evidence.reason] };
  return check(id, inspect(evidence.value), success, remediation);
}
function indexNames(text: string | undefined, markers: readonly [string, string]): string[] | null {
  if (text === undefined) return null;
  const start = text.indexOf(markers[0]); const end = text.indexOf(markers[1]);
  if (start < 0 || end <= start) return null;
  return [...text.slice(start + markers[0].length, end).matchAll(/`([a-z0-9-]+)`/g)].map((match) => match[1]!);
}
function indexFailures(label: string, indexed: string[] | null, registry: readonly ReleaseTruthCommand[]): string[] {
  if (indexed === null) return [`COMMANDS.md is missing the canonical ${label} index markers`];
  const failures: string[] = [];
  const duplicates = [...new Set(indexed.filter((name, at) => indexed.indexOf(name) !== at))].sort();
  if (duplicates.length) failures.push(`${label} index contains duplicate entries: ${duplicates.join(", ")}`);
  const visible = registry.filter((item) => !item.hidden).map((item) => item.name).sort(); const unique = [...new Set(indexed)].sort();
  const missing = visible.filter((name) => !unique.includes(name)); const removed = unique.filter((name) => !visible.includes(name));
  if (missing.length) failures.push(`${label} index omits shipped commands: ${missing.join(", ")}`);
  if (removed.length) failures.push(`${label} index documents removed or nonexistent commands: ${removed.join(", ")}`);
  return failures;
}

function invocationCommand(value: string): string | null {
  const words: string[] = [...(value.replace(/^\s*(?:\$|>)\s*/, "").match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g) ?? [])];
  const at = words.indexOf("aether");
  if (at < 0 || words.slice(0, at).some((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) return null;
  for (let index = at + 1; index < words.length; index += 1) {
    const word = words[index]!;
    if (VALUE_FLAGS.has(word)) { index += 1; continue; }
    if (word.startsWith("-")) continue;
    return /^[a-z][a-z0-9-]*$/.test(word) ? word : null;
  }
  return null;
}
export function documentedCommands(markdown: string): string[] {
  const found = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    // Typo examples are negative tests, not advertised command invocations.
    // The marker must be on the same line as the example so a broad prose
    // exemption cannot accidentally hide commands elsewhere in the document.
    if (/\bexpected typo example\b/i.test(line)) continue;
    const fragments = [...line.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1]!);
    if (/^\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*(?:\$\s*)?aether\b/.test(line)) fragments.push(line);
    for (const fragment of fragments) { const name = invocationCommand(fragment); if (name) found.add(name); }
  }
  return [...found].sort();
}
export function documentedSlashCommands(markdown: string): string[] {
  const found = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*Typos get a nudge:/i.test(line)) continue;
    const fragments = [...line.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1]!);
    if (/^\s*\/[a-z]/.test(line)) fragments.push(line.trim());
    for (const fragment of fragments) {
      const match = /^\/([a-z][a-z0-9-]*)(?:\s|$)/.exec(fragment.trim());
      if (match) found.add(match[1]!);
    }
  }
  return [...found].sort();
}

const CAPABILITY_DOC_MARKERS = ["<!-- CAPABILITY-DOCS:START -->", "<!-- CAPABILITY-DOCS:END -->"] as const;
const CAPABILITY_RELEASE_MARKERS = ["<!-- CAPABILITY-RELEASE:START -->", "<!-- CAPABILITY-RELEASE:END -->"] as const;

function markedCapabilityNames(text: string | undefined, markers: readonly [string, string]): string[] {
  if (text === undefined) return [];
  const start = text.indexOf(markers[0]); const end = text.indexOf(markers[1]);
  if (start < 0 || end <= start) return [];
  return [...text.slice(start + markers[0].length, end).matchAll(/`([a-z][a-z0-9._:-]+)`/g)]
    .map((match) => match[1]!);
}

export function capabilityEvidenceFromSources(
  commands: readonly ReleaseTruthCommand[],
  commandsDoc: string | undefined,
  releaseNotes: string | undefined,
): CapabilityDisposition[] {
  const required = new Set(commands.flatMap((command) => command.capabilityRequirements ?? []));
  const documented = new Set(markedCapabilityNames(commandsDoc, CAPABILITY_DOC_MARKERS));
  const dispositions = new Map<string, CapabilityDisposition["releaseDisposition"]>();
  if (releaseNotes !== undefined) {
    const start = releaseNotes.indexOf(CAPABILITY_RELEASE_MARKERS[0]);
    const end = releaseNotes.indexOf(CAPABILITY_RELEASE_MARKERS[1]);
    if (start >= 0 && end > start) {
      const block = releaseNotes.slice(start + CAPABILITY_RELEASE_MARKERS[0].length, end);
      for (const match of block.matchAll(/`([a-z][a-z0-9._:-]+)`[^\r\n]*`(announced|exempt|removed)`/g)) {
        dispositions.set(match[1]!, match[2] as CapabilityDisposition["releaseDisposition"]);
      }
    }
  }
  const ids = new Set([...required, ...documented, ...dispositions.keys()]);
  return [...ids].sort().map((id) => ({
    id,
    shipped: required.has(id),
    documented: documented.has(id),
    releaseDisposition: dispositions.get(id) ?? null,
  }));
}

function packageTargetClaims(value: unknown, source: string, claims: PackedClaim[]): void {
  if (typeof value === "string") {
    const path = value.replace(/^\.\//, "");
    if (path !== "package.json") claims.push({ id: source, source, requiredPaths: [path] });
    return;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) packageTargetClaims(nested, `${source}.${key}`, claims);
}

/** Claims come from package.json/public-document contracts, never the pack report being checked. */
export function packageClaimsFromFiles(files: Readonly<Record<string, string>>): PackedClaim[] {
  const manifest = parseJson(files["package.json"]); const claims: PackedClaim[] = [];
  if (manifest) {
    packageTargetClaims(manifest["main"], "package.json#main", claims);
    packageTargetClaims(manifest["types"], "package.json#types", claims);
    packageTargetClaims(manifest["bin"], "package.json#bin", claims);
    packageTargetClaims(manifest["exports"], "package.json#exports", claims);
    if (Array.isArray(manifest["files"])) {
      for (const item of manifest["files"]) {
        if (item === "packages/ats-skills") {
          claims.push({ id: "package.json#files:packages/ats-skills", source: "package.json#files", requiredPaths: [
            "package.json", "README.md", "LICENSE", "SETTINGS.md", "src/index.js", "src/index.d.ts",
            "src/browser.js", "src/browser_transport.js", "src/vision_skill.js", "src/settings.js", "python/bridge.py", "bin/aether-ats-skills.js",
          ].map((path) => `packages/ats-skills/${path}`) });
          continue;
        }
        if (typeof item === "string" && item !== "dist/src" && !item.endsWith("/")) {
          claims.push({ id: `package.json#files:${item}`, source: "package.json#files", requiredPaths: [item.replace(/^\.\//, "")] });
        }
      }
    }
  }
  for (const path of ["README.md", "COMMANDS.md"]) {
    const text = files[path];
    if (text !== undefined) {
      claims.push({ id: `public-doc:${path}`, source: path, requiredPaths: [path] });
      for (const match of text.matchAll(/\[[^\]]+\]\((docs\/(?:generated|model-catalogue)\/[A-Za-z0-9._/-]+)\)/g)) {
        claims.push({ id: `public-link:${path}:${match[1]!}`, source: path, requiredPaths: [match[1]!] });
      }
    }
  }
  const seen = new Set<string>();
  return claims.filter((claim) => {
    const key = `${claim.source}\u0000${claim.requiredPaths.join("\u0000")}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function evaluateReleaseTruth(input: ReleaseTruthInput): ReleaseTruthResult {
  const manifest = parseJson(input.files["package.json"]); const lock = parseJson(input.files["package-lock.json"]);
  const version = typeof manifest?.["version"] === "string" ? manifest["version"] : null; const name = manifest?.["name"];
  const packages = lock?.["packages"] !== null && typeof lock?.["packages"] === "object" ? lock["packages"] as Record<string, unknown> : null;
  const lockRoot = packages?.[""] !== null && typeof packages?.[""] === "object" ? packages[""] as Record<string, unknown> : null;
  const versions: string[] = [];
  if (!version) versions.push("package.json has no string version");
  if (lock?.["name"] !== name) versions.push("package-lock.json root name differs from package.json");
  if (lock?.["version"] !== version) versions.push("package-lock.json root version differs from package.json");
  if (lockRoot?.["version"] !== version) versions.push('package-lock.json packages[""] version differs from package.json');
  if (sourceVersion(input.files["src/version.ts"]) !== version) versions.push("src/version.ts differs from package.json");
  if (firstVersionedHeading(input.files["RELEASE_NOTES.md"]) !== version) versions.push(`RELEASE_NOTES.md does not lead with versioned release v${String(version)}`);
  const releaseNotesOrder = releaseNotesOrderingFailure(input.files["RELEASE_NOTES.md"]); if (releaseNotesOrder) versions.push(releaseNotesOrder);
  let currentPacketState: "candidate" | "frozen-prerelease" | null = null;
  if (version) {
    const packetPath = `docs/releases/OPERATOR-PACKET-v${version}.md`; const packet = input.files[packetPath];
    if (headingVersion(packet) !== version) versions.push(`${packetPath} does not lead with v${version}`);
    if (packet && !new RegExp("\\|\\s*Proposed tag\\s*\\|\\s*`v" + version.replaceAll(".", "\\.") + "`").test(packet)) versions.push(`${packetPath} does not bind proposed tag v${version}`);
    currentPacketState = packetEvidenceState(packet);
    if (packet && currentPacketState === null) versions.push(`${packetPath} has no valid Evidence state`);
  }
  const packed = new Set(input.packedFiles.map((path) => path.replaceAll("\\", "/").replace(/^\.\//, "")));
  const publicDocs = ["README.md", "COMMANDS.md"].filter((path) => input.files[path] === undefined || !packed.has(path)).map((path) => `${path} must exist in the repository and packed package`);
  const slash = input.slashCommands ?? [];
  const indexes = [...indexFailures("CLI", indexNames(input.files["COMMANDS.md"], CLI_MARKERS), input.commands), ...(slash.length ? indexFailures("slash", indexNames(input.files["COMMANDS.md"], SLASH_MARKERS), slash) : [])];
  const acceptedCli = new Set(input.commands.flatMap((item) => [item.name, ...(item.aliases ?? [])])); const acceptedSlash = new Set(slash.flatMap((item) => [item.name, ...(item.aliases ?? [])]));
  const examples: string[] = [];
  for (const path of ["README.md", "COMMANDS.md", "RELEASE_NOTES.md"] as const) {
    const text = input.files[path]; if (text === undefined) { examples.push(`${path} is missing`); continue; }
    const badCli = documentedCommands(text).filter((item) => !acceptedCli.has(item)); const badSlash = slash.length ? documentedSlashCommands(text).filter((item) => !acceptedSlash.has(item)) : [];
    if (badCli.length) examples.push(`${path} contains removed or nonexistent command examples: ${badCli.join(", ")}`);
    if (badSlash.length) examples.push(`${path} contains removed or nonexistent slash-command examples: ${badSlash.join(", ")}`);
  }
  const commandDispositions = [...input.commands, ...slash].flatMap((item) => {
    if (!item.release) return [`${item.name} has no release disposition`];
    if (["new", "changed", "deprecated"].includes(item.release.disposition) && !item.release.note?.trim()) {
      return [`${item.name} is ${item.release.disposition} without a release-note disposition`];
    }
    return [];
  });
  const requiredCapabilities = [...new Set([...input.commands, ...slash].flatMap((item) => item.capabilityRequirements ?? []))].sort();
  const forbidden = Object.entries(input.scannedTexts).filter(([, text]) => FORBIDDEN_PATTERN.test(text)).map(([path]) => `${path} contains the retired product URL`).sort();
  const skips = input.scanSkips ?? []; const partial = skips.filter((item) => item.reason === "oversized" || item.reason === "budget");
  const scanCheck: ReleaseTruthCheck = partial.length ? { id: "scan.coverage", status: "unavailable", summary: "repository scan reached a safety bound", remediation: "Reduce oversized text artifacts or raise the reviewed bound; never treat a partial scan as green.", evidence: skips.map((item) => `${item.path}: ${item.reason} (${item.detail})`) } : { id: "scan.coverage", status: "pass", summary: "all bounded repository text was inspected", remediation: "Inspect skipped-file evidence when adding binary formats.", evidence: skips.map((item) => `${item.path}: ${item.reason} (${item.detail})`) };
  const checks: ReleaseTruthCheck[] = [
    check("version.agreement", versions, "all release version sources agree", "Align the manifest, both lock fields, src/version.ts, leading release note, and operator packet."),
    check("package.public-docs", publicDocs, "required public documents exist in the packed package", "Keep README.md and COMMANDS.md in package.json files and npm pack output."),
    check("commands.canonical-index", indexes, "CLI and slash indexes exactly match visible registries", "Regenerate both canonical indexes and remove duplicate entries."),
    check("commands.public-examples", examples, "public CLI and slash examples resolve", "Replace stale examples or register and release-disposition the intended command."),
    check("commands.release-disposition", commandDispositions, "every shipped command has a release disposition", "Populate command manifest release metadata; new, changed, and deprecated commands require a non-empty note."),
    check("links.no-aether-terminal", forbidden, "the retired product URL is absent", `Remove every ${FORBIDDEN_URL} reference; that product is outside Aether Agent.`),
    scanCheck,
    evidenceCheck("capabilities.release-disposition", input.capabilities, (items) => {
      const byId = new Map(items.map((item) => [item.id, item])); const failures: string[] = [];
      for (const id of requiredCapabilities) {
        const item = byId.get(id);
        if (!item) { failures.push(`${id} is required by a shipped command but has no capability evidence`); continue; }
        if (!item.shipped) failures.push(`${id} is required by a shipped command but evidence says it is not shipped`);
      }
      for (const item of items.filter((candidate) => candidate.shipped)) {
        if (!item.documented) failures.push(`${item.id} ships without independent public documentation`);
        if (!["announced", "exempt"].includes(item.releaseDisposition ?? "")) failures.push(`${item.id} ships without a release disposition`);
      }
      return failures;
    }, "capabilities have documentation and release dispositions", "Document every command requirement and classify it in the release notes."),
    evidenceCheck("generated-docs.digest", input.generatedDocs, (items) => items.filter((item) => !item.manifestDigest || item.manifestDigest !== item.documentDigest).map((item) => `${item.id} generated digest differs from its manifest`), "generated command/model docs match manifests", "Regenerate documents from canonical manifests."),
    evidenceCheck("catalogue.digest-freshness", input.catalogue, (item) => { const failures: string[] = []; if (!item.catalogueDigest || item.catalogueDigest !== item.renderedDigest) failures.push("catalogue rendered digest differs from canonical digest"); const generated = Date.parse(item.generatedAt); const observed = Date.parse(item.observedAt); if (!Number.isFinite(generated) || !Number.isFinite(observed)) failures.push("catalogue timestamps are invalid"); else if (generated - observed > 5 * 60_000) failures.push("catalogue generatedAt is materially in the future"); else if (observed - generated > item.maxAgeMs) failures.push("catalogue snapshot is stale"); return failures; }, "catalogue digest and freshness are valid", "Refresh authoritative catalogue data and regenerate outputs."),
    check("package.claim-inventory", packageClaimsFromFiles(input.files).flatMap((claim) => claim.requiredPaths.filter((path) => !packed.has(path)).map((path) => `${claim.id} claims ${path} from ${claim.source}, but it is absent from the package`)), "packed contents satisfy independently derived package and public claims", "Package every manifest target and required public document, or correct its authoritative source."),
    evidenceCheck("registry.source-truth", input.registry, (item) => {
      const failures: string[] = [];
      if (item.sourceVersion !== version) failures.push("registry evidence source version differs from package");
      if (item.publicClaim.sourceVersion !== null && item.publicClaim.sourceVersion !== item.sourceVersion) failures.push(`public source-build claim ${item.publicClaim.sourceVersion} differs from the package version ${item.sourceVersion}`);
      for (const claim of item.publicClaim.pinnedRegistryClaims) failures.push(`packed public docs pin registry state that publishing invalidates: ${claim}`);
      if (item.latest !== null && !item.publishedVersions.includes(item.latest)) failures.push(`observed latest dist-tag ${item.latest} is not among published versions`);
      const sourceIsPublished = item.publishedVersions.includes(item.sourceVersion);
      if (sourceIsPublished && currentPacketState !== "frozen-prerelease") failures.push("published source version requires a frozen-prerelease operator packet");
      if (!sourceIsPublished && currentPacketState !== "candidate") failures.push("unpublished source version requires a candidate operator packet");
      return failures;
    }, "packed public docs and operator evidence state track registry truth", "Report npm state with live registry evidence; never hard-code a dist-tag version; mark unpublished packets candidate and published packets frozen-prerelease."),
  ];
  return resultFromChecks(version, checks);
}

function resultFromChecks(version: string | null, checks: ReleaseTruthCheck[]): ReleaseTruthResult {
  const failed = checks.filter((item) => item.status === "fail").length; const unavailable = checks.filter((item) => item.status === "unavailable").length; const notApplicable = checks.filter((item) => item.status === "not_applicable").length; const passed = checks.filter((item) => item.status === "pass").length;
  const result: ReleaseTruthResult = { schema: RELEASE_TRUTH_SCHEMA, status: failed ? "fail" : unavailable ? "unavailable" : "pass", ok: failed === 0 && unavailable === 0, version, summary: { total: checks.length, passed, failed, unavailable, notApplicable }, checks, humanSummary: [] };
  result.humanSummary = renderReleaseTruthSummary(result); return result;
}
export function renderReleaseTruthSummary(result: ReleaseTruthResult): string[] {
  const lines = [`${result.status.toUpperCase()} ${result.schema}: ${result.summary.passed}/${result.summary.total} passed, ${result.summary.failed} failed, ${result.summary.unavailable} unavailable`];
  for (const item of result.checks.filter((candidate) => candidate.status === "fail" || candidate.status === "unavailable")) { lines.push(`[${item.id}] ${item.status}: ${item.summary}`); for (const evidence of item.evidence) lines.push(`  - ${evidence}`); lines.push(`  remediation: ${item.remediation}`); }
  return lines;
}

export interface ScanOptions { maxFileBytes?: number; maxTotalBytes?: number }
export function scanRepositoryTexts(root: string, options: ScanOptions = {}): { texts: Record<string, string>; skips: ScanSkip[] } {
  const texts: Record<string, string> = {}; const skips: ScanSkip[] = []; const maxFile = options.maxFileBytes ?? 1_048_576; const maxTotal = options.maxTotalBytes ?? 33_554_432; let total = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name); const repoPath = relative(root, path).replaceAll("\\", "/");
      if (entry.isDirectory()) { if (EXCLUDED_DIRECTORIES.has(entry.name)) skips.push({ path: repoPath + "/", reason: "excluded_directory", detail: "explicit generated/dependency directory" }); else visit(path); continue; }
      if (!entry.isFile()) { skips.push({ path: repoPath, reason: "non_regular", detail: "symlink or special file" }); continue; }
      const size = statSync(path).size; if (size > maxFile) { skips.push({ path: repoPath, reason: "oversized", detail: `${size} bytes exceeds ${maxFile}` }); continue; } if (total + size > maxTotal) { skips.push({ path: repoPath, reason: "budget", detail: `${total + size} bytes exceeds ${maxTotal}` }); continue; }
      const bytes = readFileSync(path); if (bytes.includes(0)) { skips.push({ path: repoPath, reason: "binary", detail: "contains NUL byte" }); continue; }
      try { texts[repoPath] = new TextDecoder("utf-8", { fatal: true }).decode(bytes); total += size; } catch { skips.push({ path: repoPath, reason: "undecodable", detail: "not valid UTF-8 text" }); }
    }
  };
  visit(root); return { texts, skips };
}
const manifestCommands = (surface: "shell" | "slash"): ReleaseTruthCommand[] => COMMAND_MANIFEST
  .filter((entry) => entry.surface === surface)
  .map((entry) => ({
    name: entry.name,
    aliases: entry.aliases,
    hidden: entry.hidden,
    capabilityRequirements: entry.availability.capabilityRequirements,
    ...(entry.release ? { release: entry.release } : {}),
  }));

export function collectReleaseTruthInput(
  root: string,
  packedFiles: readonly string[],
  commands: readonly ReleaseTruthCommand[] = manifestCommands("shell"),
  slashCommands: readonly ReleaseTruthCommand[] = manifestCommands("slash"),
  evidence: ReleaseTruthEvidence = {},
): ReleaseTruthInput {
  const scan = scanRepositoryTexts(root); const files: Record<string, string> = {};
  for (const path of ["package.json", "package-lock.json", "src/version.ts", "README.md", "COMMANDS.md", "RELEASE_NOTES.md"]) if (scan.texts[path] !== undefined) files[path] = scan.texts[path]!;
  const manifest = parseJson(files["package.json"]); const version = typeof manifest?.["version"] === "string" ? manifest["version"] : null;
  if (version) { const packet = `docs/releases/OPERATOR-PACKET-v${version}.md`; if (scan.texts[packet] !== undefined) files[packet] = scan.texts[packet]!; }
  return { files, scannedTexts: scan.texts, scanSkips: scan.skips, packedFiles, commands, slashCommands, ...evidence };
}
export function releaseTruthFromRepository(root: string, packedFiles: readonly string[], evidence: ReleaseTruthEvidence = {}): ReleaseTruthResult {
  return evaluateReleaseTruth(collectReleaseTruthInput(root, packedFiles, manifestCommands("shell"), manifestCommands("slash"), evidence));
}
function safeFailureDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\b(?:AETHER_TOKEN|NPM_TOKEN|GITHUB_TOKEN|API_KEY|ACCESS_TOKEN)\s*=\s*[^\s,;]+/gi, "credential=[redacted]")
    .replace(/\b(?:aek_|gh[opusr]_|Bearer\s+)[A-Za-z0-9._-]+/gi, "[redacted credential]")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .slice(0, 240);
}
export function releaseTruthFailure(stage: "collection" | "pack", error: unknown): ReleaseTruthResult {
  const detail = safeFailureDetail(error); return resultFromChecks(null, [{ id: `${stage}.unavailable`, status: "unavailable", summary: `${stage} evidence could not be collected`, remediation: stage === "pack" ? "Run npm pack --dry-run --json after a successful build and inspect its error." : "Restore readable repository files and rerun collection.", evidence: [detail] }]);
}
export async function runReleaseTruth(root: string, evidence: ReleaseTruthEvidence = {}, packedFiles?: readonly string[]): Promise<ReleaseTruthResult> {
  let paths = packedFiles; if (!paths) { try { const { createPackReport } = await import("./verify-production.js"); paths = createPackReport(root).files.map((file) => file.path); } catch (error) { return releaseTruthFailure("pack", error); } }
  try { return releaseTruthFromRepository(root, paths, evidence); } catch (error) { return releaseTruthFailure("collection", error); }
}
export function deterministicRepositoryEvidence(root: string = process.cwd()): ReleaseTruthEvidence {
  const commands = [...manifestCommands("shell"), ...manifestCommands("slash")];
  let capabilities: Evidence<readonly CapabilityDisposition[]>;
  try {
    capabilities = {
      state: "available",
      value: capabilityEvidenceFromSources(
        commands,
        readFileSync(join(root, "COMMANDS.md"), "utf8"),
        readFileSync(join(root, "RELEASE_NOTES.md"), "utf8"),
      ),
    };
  } catch (error) {
    capabilities = { state: "unavailable", reason: `capability evidence could not be read: ${safeFailureDetail(error)}` };
  }
  const evidence: ReleaseTruthEvidence = {
    capabilities,
  };
  try {
    const outputs = buildGeneratedOutputs({ root });
    evidence.generatedDocs = {
      state: "available",
      value: outputs.map((output) => ({
        id: output.path,
        manifestDigest: sha256(normalizeEol(output.content)),
        documentDigest: existsSync(join(root, output.path)) ? sha256(normalizeEol(readFileSync(join(root, output.path), "utf8"))) : "",
      })),
    };
    const catalogue = parseJson(readFileSync(join(root, "docs", "model-catalogue", "catalogue.json"), "utf8"));
    const digest = typeof catalogue?.["digest"] === "string" ? catalogue["digest"] : "";
    const generatedAt = typeof catalogue?.["generatedAt"] === "string" ? catalogue["generatedAt"] : "";
    const rendered = ["docs/model-catalogue/index.html", "docs/generated/model-catalogue.md"]
      .every((path) => existsSync(join(root, path)) && readFileSync(join(root, path), "utf8").includes(digest));
    evidence.catalogue = {
      state: "available",
      value: {
        catalogueDigest: digest,
        renderedDigest: rendered ? digest : "",
        generatedAt,
        observedAt: new Date().toISOString(),
        maxAgeMs: 90 * 24 * 60 * 60 * 1_000,
      },
    };
  } catch {
    evidence.generatedDocs = { state: "unavailable", reason: "generated documentation evidence could not be collected; run npm run docs:generate" };
    evidence.catalogue = { state: "unavailable", reason: "public catalogue evidence could not be collected; run npm run docs:generate" };
  }
  return evidence;
}

const PACKED_PUBLIC_DOCS = ["README.md", "COMMANDS.md", "NOTICE.md", "docs/generated/commands.md", "docs/generated/model-catalogue.md"] as const;

/**
 * Registry state is owner-controlled and flips the moment a release is published, so packed
 * documentation must describe it with a live source (the npm badge, `npm view`) rather than a
 * literal version. Anything that pins a dist-tag version, or asserts that the source version is
 * still unpublished, is a publish-order landmine even while it is momentarily accurate.
 */
const PINNED_REGISTRY_CLAIM_PATTERNS: readonly { id: string; pattern: RegExp }[] = [
  { id: "npm-latest table cell names a fixed version", pattern: /\|\s*npm\s+`latest`\s*\|[^|\n]*?\bv?\d+\.\d+\.\d+/i },
  { id: "prose pins the npm latest dist-tag to a fixed version", pattern: /npm\s+`?latest`?[^.\n|]{0,40}?(?:resolves to|remains|is still|is)\s+\*{0,2}v?\d+\.\d+\.\d+/i },
  { id: "prose asserts the source version is unpublished", pattern: /\b(?:future published|not yet published|once (?:it is |we |this )?published?)\b/i },
];

export function derivePublicRegistryClaim(docs: Record<string, string>): PublicRegistryClaim {
  const readme = docs["README.md"] ?? "";
  const sourceVersion = /\|\s*`main`\s+source build\s*\|\s*\*\*([^*]+)\*\*/i.exec(readme)?.[1]?.trim() ?? null;
  const pinnedRegistryClaims = Object.entries(docs)
    .flatMap(([path, text]) => PINNED_REGISTRY_CLAIM_PATTERNS.filter((candidate) => candidate.pattern.test(text)).map((candidate) => `${path}: ${candidate.id}`))
    .sort();
  return { sourceVersion, pinnedRegistryClaims };
}

export async function observeNpmRegistry(root: string): Promise<Evidence<RegistryTruth>> {
  try {
    const manifest = parseJson(readFileSync(join(root, "package.json"), "utf8"));
    const source = typeof manifest?.["version"] === "string" ? manifest["version"] : "";
    const response = await fetch("https://registry.npmjs.org/aether-agents", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { state: "unavailable", reason: `npm registry returned HTTP ${response.status}` };
    const body = await response.json() as { versions?: Record<string, unknown>; "dist-tags"?: Record<string, unknown> };
    const versions = Object.keys(body.versions ?? {}).sort();
    const latest = typeof body["dist-tags"]?.["latest"] === "string" ? body["dist-tags"]["latest"] : null;
    const packedDocs: Record<string, string> = {};
    for (const path of PACKED_PUBLIC_DOCS) {
      try { packedDocs[path] = readFileSync(join(root, path), "utf8"); } catch { /* absent docs are caught by package.public-docs */ }
    }
    return {
      state: "available",
      value: {
        sourceVersion: source,
        publishedVersions: versions,
        latest,
        publicClaim: derivePublicRegistryClaim(packedDocs),
      },
    };
  } catch (error) {
    return { state: "unavailable", reason: safeFailureDetail(error) || "npm registry observation failed" };
  }
}

async function main(): Promise<void> {
  const root = process.cwd();
  const evidence = deterministicRepositoryEvidence(root);
  evidence.registry = await observeNpmRegistry(root);
  const result = await runReleaseTruth(root, evidence);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.stderr.write(`${result.humanSummary.join("\n")}\n`);
  if (!result.ok) process.exitCode = 1;
}
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) void main();
