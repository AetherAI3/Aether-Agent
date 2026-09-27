import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_APPLICABLE_CONTRACTS, deterministicRepositoryEvidence, releaseTruthFromRepository } from "./release-truth.js";
import { validateHeadlessFrames } from "../src/core/headless_protocol.js";

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  main?: unknown;
  types?: unknown;
  bin?: unknown;
  files?: unknown;
  engines?: unknown;
  repository?: unknown;
  dependencies?: unknown;
  scripts?: unknown;
}

export interface PackFile {
  path: string;
  size: number;
}

export interface PackReport {
  name: string;
  version: string;
  filename: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: PackFile[];
}

const REQUIRED_ROOT_FILES = new Set([
  "COMMANDS.md",
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "package.json",
]);

export const REQUIRED_GENERATED_DOCS = [
  "docs/generated/commands.md",
  "docs/generated/model-catalogue.md",
  "docs/model-catalogue/catalogue.json",
  "docs/model-catalogue/index.html",
] as const;
const ALLOWED_GENERATED_DOCS = new Set<string>(REQUIRED_GENERATED_DOCS);
const REQUIRED_PUBLIC_ASSETS = ["assets/aether-agent-hero.png"] as const;
const ALLOWED_PUBLIC_ASSETS = new Set<string>(REQUIRED_PUBLIC_ASSETS);

const MAX_UNPACKED_BYTES = 5_000_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function validateManifest(manifest: PackageManifest, expectedTag?: string): string[] {
  const errors: string[] = [];
  if (manifest.name !== "aether-agents") errors.push("package name must remain aether-agents");
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    errors.push("package version must be valid semver");
  }
  if (expectedTag && `v${String(manifest.version)}` !== expectedTag) {
    errors.push(`release tag ${expectedTag} does not match package version v${String(manifest.version)}`);
  }

  const engines = record(manifest.engines);
  if (engines?.["node"] !== ">=24") errors.push("engines.node must be >=24");

  const repository = record(manifest.repository);
  if (repository?.["url"] !== "https://github.com/AetherAI3/aether-agent") {
    errors.push("package repository.url must match the trusted publisher repository");
  }

  const dependencies = record(manifest.dependencies);
  if (dependencies && Object.keys(dependencies).length > 0) {
    errors.push("runtime dependencies are forbidden by the zero-dependency production contract");
  }

  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (!files.includes("dist/src")) errors.push("package files must include dist/src");
  for (const path of REQUIRED_GENERATED_DOCS) if (!files.includes(path)) errors.push(`package files must include generated public document ${path}`);
  for (const path of REQUIRED_PUBLIC_ASSETS) if (!files.includes(path)) errors.push(`package files must include public asset ${path}`);
  if (files.includes("dist") || files.some((value) => typeof value === "string" && value.includes("test"))) {
    errors.push("package files must not include compiled tests");
  }

  const scripts = record(manifest.scripts);
  if (typeof scripts?.["prepack"] !== "string" || !scripts["prepack"].includes("build")) {
    errors.push("prepack must build the release artifact");
  }
  return errors;
}

export function validatePack(report: PackReport, manifest: PackageManifest): string[] {
  const errors: string[] = [];
  const paths = new Set(report.files.map((file) => file.path.replaceAll("\\", "/")));
  for (const required of REQUIRED_ROOT_FILES) {
    if (!paths.has(required)) errors.push(`package is missing required file ${required}`);
  }
  for (const required of REQUIRED_GENERATED_DOCS) {
    if (!paths.has(required)) errors.push(`package is missing generated public document ${required}`);
  }
  for (const required of REQUIRED_PUBLIC_ASSETS) {
    if (!paths.has(required)) errors.push(`package is missing public asset ${required}`);
  }
  for (const required of [manifest.main, manifest.types]) {
    if (typeof required === "string" && !paths.has(required.replace(/^\.\//, ""))) {
      errors.push(`package is missing entrypoint ${required}`);
    }
  }
  const bins = record(manifest.bin);
  for (const target of Object.values(bins ?? {})) {
    if (typeof target === "string" && !paths.has(target.replace(/^\.\//, ""))) {
      errors.push(`package is missing binary target ${target}`);
    }
  }

  for (const path of paths) {
    const allowed = REQUIRED_ROOT_FILES.has(path) || ALLOWED_GENERATED_DOCS.has(path) || ALLOWED_PUBLIC_ASSETS.has(path) || path.startsWith("dist/src/");
    if (!allowed) errors.push(`unexpected package content: ${path}`);
    if (/(^|\/)(test|tests|_loopstate)(\/|$)/i.test(path) || /(^|\/)\.env(?:\.|$)/i.test(path)) {
      errors.push(`sensitive or non-runtime package content: ${path}`);
    }
  }
  if (report.unpackedSize > MAX_UNPACKED_BYTES) {
    errors.push(`unpacked package exceeds ${MAX_UNPACKED_BYTES} bytes`);
  }
  return errors;
}

export function validateWorkflowText(name: string, text: string): string[] {
  const errors: string[] = [];
  if (/^\s*pull_request_target\s*:/m.test(text)) errors.push(`${name}: pull_request_target is forbidden`);
  if (!/^permissions:\s*$/m.test(text)) errors.push(`${name}: explicit workflow permissions are required`);
  if (/^\s*permissions:\s*write-all\s*(?:#.*)?$/mi.test(text)) {
    errors.push(`${name}: permissions write-all is forbidden at workflow and job scope`);
  }

  const uses = [...text.matchAll(/^\s*(?:-\s*)?uses:\s+([^\s#]+)(?:\s+#.*)?$/gm)].map((match) => match[1]!);
  for (const action of uses) {
    if (action.startsWith("./") || action.startsWith("docker://")) continue;
    const separator = action.lastIndexOf("@");
    const ref = separator >= 0 ? action.slice(separator + 1) : "";
    if (!/^[0-9a-f]{40}$/.test(ref)) errors.push(`${name}: action is not pinned to a full commit SHA: ${action}`);
  }

  const jobs = (text.match(/^\s+runs-on:/gm) ?? []).length;
  const timeouts = (text.match(/^\s+timeout-minutes:/gm) ?? []).length;
  if (jobs !== timeouts) errors.push(`${name}: every runner job must set timeout-minutes`);

  for (const line of text.split(/\r?\n/)) {
    if (/\bnpm ci(?:\s|$)/.test(line) && !line.trimStart().startsWith("#") && !line.includes("--ignore-scripts")) {
      errors.push(`${name}: npm ci must use --ignore-scripts`);
    }
    const command = line.trimStart();
    const localPublishWrapper = !command.startsWith("#") && (
      /\bnpm\s+run\s+[^\s#]*publish(?:[-_.:]|\b)/i.test(command)
      || /\b(?:node|npx|bash|sh|pwsh|powershell)\b[^#\n]*[/\\_.-]publish(?:[-_.]|\b)/i.test(command)
    );
    if (localPublishWrapper) {
      errors.push(`${name}: indirect publish wrappers are forbidden; use an audited direct npm publish --provenance step`);
    }
  }

  if (/npm publish/.test(text)) {
    if (/^\s*workflow_dispatch\s*:/m.test(text)) errors.push(`${name}: publishing cannot be manually dispatched`);
    if (!/npm publish[^\n]*--provenance/.test(text)) errors.push(`${name}: npm publish must emit provenance`);
    if (!/^\s+runs-on:\s*ubuntu-latest\s*$/m.test(text)) {
      errors.push(`${name}: npm trusted publishing must use a GitHub-hosted ubuntu-latest runner`);
    }
    if (!/^\s+environment:\s*npm-production\s*$/m.test(text)) {
      errors.push(`${name}: publishing must use the npm-production environment`);
    }
    if (!/^\s+id-token:\s*write\s*$/m.test(text)) errors.push(`${name}: publishing needs id-token write`);
    if (!/^\s+attestations:\s*write\s*$/m.test(text)) errors.push(`${name}: publishing needs attestations write`);
    if (/\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\b/.test(text)) {
      errors.push(`${name}: npm trusted publishing must use short-lived OIDC, not a long-lived npm token`);
    }
    if (!/^\s+node-version:\s*['"]>=24\.6\.0 <25['"]\s*$/m.test(text)) {
      errors.push(`${name}: trusted publishing requires the audited Node 24/npm 11.5.1+ release range`);
    }
    if (!/^\s+package-manager-cache:\s*false\s*$/m.test(text) || /^\s+cache:\s*/m.test(text)) {
      errors.push(`${name}: release publishing must disable package-manager caching`);
    }
    if (!/git merge-base --is-ancestor HEAD origin\/main/.test(text)) {
      errors.push(`${name}: release commit ancestry to main must be verified`);
    }
    if (/origin\/release\/0\.3/.test(text)) {
      if (!text.includes('[[ "$RELEASE_TAG" =~ ^v0\\.3\\.[0-9]+$ ]]')) {
        errors.push(`${name}: the release/0.3 exception must be restricted to numeric v0.3.x tags`);
      }
      if (!text.includes('test "$(git rev-parse HEAD)" = "$(git rev-parse origin/release/0.3)"')) {
        errors.push(`${name}: v0.3.x publication must equal the exact release/0.3 head`);
      }
    }
    if (!/npm install --global[^\n]*--ignore-scripts/.test(text)) {
      errors.push(`${name}: the exact tarball must pass an install smoke test`);
    }
  }
  return errors;
}

export function validateInstallerText(name: string, text: string): string[] {
  const errors: string[] = [];
  if (/curl[^\n|]*\|\s*(?:sh|bash)\b/i.test(text) || /\birm\b[^\n|]*\|\s*iex\b/i.test(text)) {
    errors.push(`${name}: pipe-to-shell installation is forbidden`);
  }
  for (const line of text.split(/\r?\n/)) {
    const globalInstall = /\bnpm\s+(?:install|i)\s+(?:--global|-g)\s+["']?aether-agents/.test(line);
    const oneShot = /\bnpx\b[^\n]*\baether-agents/.test(line);
    if ((globalInstall || oneShot) && !line.includes("--ignore-scripts")) {
      errors.push(`${name}: npm execution must disable lifecycle scripts`);
    }
  }
  if (/PIPESTATUS/.test(text)) errors.push(`${name}: bash-only PIPESTATUS is forbidden in the POSIX installer`);
  return errors;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/**
 * What `npm pack` would actually ship from `root`, as a dry run.
 *
 * Exported because the source checkout's `dist/` is NOT the package — the files
 * allowlist is `dist/src` plus four docs — so any gate reasoning about what a
 * user receives has to ask npm rather than read the build directory.
 */
export function createPackReport(root: string): PackReport {
  const npmCli = process.env["npm_execpath"];
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = npmCli
    ? [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"]
    : ["pack", "--dry-run", "--json", "--ignore-scripts"];
  const raw = execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: !npmCli && process.platform === "win32",
  });
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("npm pack returned an unexpected report");
  return parsed[0] as PackReport;
}

function runNpm(root: string, args: string[]): string {
  const npmCli = process.env["npm_execpath"];
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  return execFileSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: !npmCli && process.platform === "win32",
  });
}

function smokeInstallPackage(root: string, expectedVersion: string): string[] {
  const errors: string[] = [];
  const temp = mkdtempSync(join(tmpdir(), "aether-production-"));
  try {
    const packDir = join(temp, "pack");
    const prefix = join(temp, "prefix");
    mkdirSync(packDir);
    const raw = runNpm(root, ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir]);
    const parsed = JSON.parse(raw) as PackReport[];
    const filename = parsed[0]?.filename;
    if (!filename) return ["install smoke could not identify the packed tarball"];
    const tarball = join(packDir, filename);
    runNpm(root, ["install", "--global", "--prefix", prefix, tarball, "--ignore-scripts"]);
    const bin = process.platform === "win32" ? join(prefix, "aether.cmd") : join(prefix, "bin", "aether");
    if (!existsSync(bin)) return [`install smoke did not create ${bin}`];
    const options = {
      cwd: temp,
      encoding: "utf8" as const,
      stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    };
    const launch = process.platform === "win32" ? process.execPath : bin;
    const launchArgs = process.platform === "win32"
      ? [join(prefix, "node_modules", "aether-agents", "dist", "src", "main.js")]
      : [];
    const version = execFileSync(launch, [...launchArgs, "--version"], options).trim();
    if (version !== expectedVersion) errors.push(`installed CLI reported ${version}, expected ${expectedVersion}`);
    execFileSync(launch, [...launchArgs, "--help"], options);
    const verifyCommand = `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;
    const output = execFileSync(launch, [
      ...launchArgs, "exec", "--cwd", temp, "--exec-driver", "selftest",
      "--permission", "read-only", "--test-cmd", verifyCommand,
      "verify the installed headless child protocol",
    ], options);
    const lines = output.trim().split(/\r?\n/);
    const protocolErrors = validateHeadlessFrames(lines);
    if (protocolErrors.length) errors.push(`installed exec protocol invalid: ${protocolErrors.join("; ")}`);
    const frames = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const session = frames[0];
    const terminal = frames.at(-1);
    if (session?.["backend"] !== "bundled-selftest-child") errors.push("installed exec did not use the bundled child selftest driver");
    if ((session?.["tools"] as unknown[] | undefined)?.some((tool) => ["run_shell", "run_tests", "git_commit", "web_search", "web_fetch"].includes(String(tool)))) {
      errors.push("installed exec advertised a shell, git, or network tool");
    }
    if (terminal?.["type"] !== "terminal" || terminal["exit_code"] !== 0 || terminal["ok"] !== true) {
      errors.push("installed exec did not finish with one verified successful terminal frame");
    }
  } catch (error) {
    errors.push(`install smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return errors;
}

export function verifyProduction(root: string, expectedTag?: string): {
  package: string;
  version: string;
  packedFiles: number;
  packedBytes: number;
  workflows: number;
} {
  const manifest = readJson(join(root, "package.json")) as PackageManifest;
  const pack = createPackReport(root);
  const errors = [
    ...validateManifest(manifest, expectedTag),
    ...validatePack(pack, manifest),
  ];
  const truthEvidence = deterministicRepositoryEvidence(root);
  truthEvidence.registry = {
    state: "not_applicable",
    contract: NOT_APPLICABLE_CONTRACTS["registry.source-truth"],
    reason: "deterministic package verification does not use the network; release:truth performs the live npm host probe",
  };
  const releaseTruth = releaseTruthFromRepository(root, pack.files.map((file) => file.path), truthEvidence);
  if (!releaseTruth.ok) {
    for (const item of releaseTruth.checks.filter((check) => check.status === "fail" || check.status === "unavailable")) {
      errors.push(`release truth ${item.id}: ${item.summary}; ${item.remediation}`);
    }
  }

  const workflowDir = join(root, ".github", "workflows");
  const workflowNames = readdirSync(workflowDir).filter((name) => /\.ya?ml$/i.test(name));
  for (const name of workflowNames) {
    errors.push(...validateWorkflowText(name, readFileSync(join(workflowDir, name), "utf8")));
  }
  for (const name of ["install.sh", "install.ps1"]) {
    errors.push(...validateInstallerText(name, readFileSync(join(root, name), "utf8")));
  }
  errors.push(...validateInstallerText("README.md", readFileSync(join(root, "README.md"), "utf8")));

  if (errors.length === 0) errors.push(...smokeInstallPackage(root, String(manifest.version)));

  if (errors.length > 0) throw new Error(`production verification failed:\n- ${errors.join("\n- ")}`);
  return {
    package: String(manifest.name),
    version: String(manifest.version),
    packedFiles: pack.entryCount,
    packedBytes: pack.unpackedSize,
    workflows: workflowNames.length,
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  const tagAt = process.argv.indexOf("--tag");
  const expectedTag = tagAt >= 0 ? process.argv[tagAt + 1] : undefined;
  if (tagAt >= 0 && !expectedTag) throw new Error("--tag requires a value");
  const result = verifyProduction(process.cwd(), expectedTag);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}
