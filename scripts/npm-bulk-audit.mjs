#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BULK_URL = new URL("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk");
const BULK_NETWORK_TIMEOUT_MESSAGE = `network timeout at: ${BULK_URL.href}`;
const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/u;
const BASE64_DIGEST = /^[A-Za-z0-9+/]+={0,2}$/u;
const NPM_SEVERITIES = Object.freeze(["info", "low", "moderate", "high", "critical"]);
const MAX_REQUEST_BYTES = 1_000_000;
// This source package is bundled with the CLI, not fetched from a registry.
// Keep the exception pinned; its runtime dependencies still require registry
// tarballs, sha512 integrity and inclusion in the advisory request below.
const ATS_NAME = "aether-ats-skills";
const ATS_LOCATION = `node_modules/${ATS_NAME}`;
const ATS_TARGET = "packages/ats-skills";
const ATS_VERSION = "0.1.0";
const ATS_DEPENDENCIES = Object.freeze({ "aether-browser": "0.2.2", "aether-context": "0.3.1" });

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  return (
    isRecord(value) &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function assertRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
}

function validatePackageName(name, label) {
  if (typeof name !== "string" || name.length > 214 || !NPM_PACKAGE_NAME.test(name)) {
    throw new Error(`${label} has an invalid npm package name`);
  }
  return name;
}

function hasValidSha512Integrity(value) {
  if (typeof value !== "string") return false;
  return value.trim().split(/\s+/u).some((token) => {
    const digest = token.split("?", 1)[0];
    if (!digest.startsWith("sha512-")) return false;
    const encoded = digest.slice("sha512-".length);
    if (!BASE64_DIGEST.test(encoded)) return false;
    const bytes = Buffer.from(encoded, "base64");
    return bytes.length === 64 && bytes.toString("base64").replace(/=+$/u, "") === encoded.replace(/=+$/u, "");
  });
}

function validateBundledAtsLink(packages, metadata) {
  const reject = () => {
    throw new Error("bundled ATS link must match the pinned root dependency, bundle and target metadata");
  };
  const root = packages[""];
  const target = packages[ATS_TARGET];
  if (
    !hasExactKeys(metadata, ["resolved", "link"]) ||
    metadata.link !== true ||
    metadata.resolved !== ATS_TARGET ||
    !isRecord(root) ||
    !isRecord(root.dependencies) ||
    root.dependencies[ATS_NAME] !== `file:${ATS_TARGET}` ||
    !Array.isArray(root.bundleDependencies) ||
    root.bundleDependencies.length !== 1 ||
    root.bundleDependencies[0] !== ATS_NAME ||
    !isRecord(target) ||
    target.name !== ATS_NAME ||
    target.version !== ATS_VERSION ||
    Object.hasOwn(target, "link") ||
    Object.hasOwn(target, "resolved") ||
    !hasExactKeys(target.dependencies, Object.keys(ATS_DEPENDENCIES)) ||
    Object.entries(ATS_DEPENDENCIES).some(([name, version]) => target.dependencies[name] !== version) ||
    ["optionalDependencies", "peerDependencies", "devDependencies", "bundleDependencies", "bundledDependencies"].some(
      (key) => Object.hasOwn(target, key),
    )
  ) {
    reject();
  }

  for (const [name, version] of Object.entries(ATS_DEPENDENCIES)) {
    // Resolve from the real link target, nearest installation first. Reject
    // absent or mismatched pins even if some other copy is registry-backed.
    const location = [
      `${ATS_TARGET}/node_modules/${name}`,
      `packages/node_modules/${name}`,
      `node_modules/${name}`,
    ].find((candidate) => Object.hasOwn(packages, candidate));
    if (location === undefined) reject();
    const dependency = packages[location];
    if (
      !isRecord(dependency) ||
      dependency.version !== version ||
      (Object.hasOwn(dependency, "name") && dependency.name !== name) ||
      Object.hasOwn(dependency, "link")
    ) {
      reject();
    }
  }
}

export function collectNpmBulkPayload(lockfile) {
  assertRecord(lockfile, "package-lock.json");
  if (lockfile.lockfileVersion !== 2 && lockfile.lockfileVersion !== 3) {
    throw new Error("package-lock.json must use lockfileVersion 2 or 3");
  }
  assertRecord(lockfile.packages, "package-lock.json packages");

  const versionsByName = new Map();
  let nodeModulesEntries = 0;
  for (const [location, metadata] of Object.entries(lockfile.packages)) {
    const markerIndex = location.lastIndexOf("node_modules/");
    if (markerIndex < 0) continue;
    nodeModulesEntries += 1;
    assertRecord(metadata, `locked package entry ${location}`);

    if (Object.hasOwn(metadata, "link")) {
      if (location !== ATS_LOCATION) throw new Error(`unsupported local package link: ${location}`);
      validateBundledAtsLink(lockfile.packages, metadata);
      continue;
    }

    const installedName = validatePackageName(
      location.slice(markerIndex + "node_modules/".length),
      `locked package entry ${location}`,
    );
    const canonicalName = Object.hasOwn(metadata, "name")
      ? validatePackageName(metadata.name, `locked package metadata ${location}`)
      : installedName;
    if (typeof metadata.version !== "string" || !EXACT_SEMVER.test(metadata.version)) {
      throw new Error(`locked package is missing an exact semantic version: ${location}`);
    }
    if (!hasValidSha512Integrity(metadata.integrity)) {
      throw new Error(`locked package is missing a valid sha512 integrity: ${location}`);
    }

    let resolved;
    try {
      resolved = new URL(metadata.resolved);
    } catch {
      throw new Error(`locked package is not registry-backed: ${location}`);
    }
    const packageLeaf = canonicalName.split("/").at(-1);
    const expectedPath = `/${canonicalName}/-/${packageLeaf}-${metadata.version}.tgz`;
    if (
      resolved.origin !== "https://registry.npmjs.org" ||
      resolved.username !== "" ||
      resolved.password !== "" ||
      resolved.search !== "" ||
      resolved.hash !== "" ||
      resolved.pathname !== expectedPath
    ) {
      throw new Error(`locked package is not backed by registry.npmjs.org: ${location}`);
    }

    const versions = versionsByName.get(canonicalName) ?? new Set();
    versions.add(metadata.version);
    versionsByName.set(canonicalName, versions);
  }
  if (nodeModulesEntries === 0 || versionsByName.size === 0) {
    throw new Error("package-lock.json contains no auditable node_modules entries");
  }

  const payload = Object.fromEntries(
    [...versionsByName.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, versions]) => [name, [...versions].sort()]),
  );
  const requestBody = JSON.stringify(payload);
  if (Buffer.byteLength(requestBody) > MAX_REQUEST_BYTES) {
    throw new Error(`npm bulk advisory request exceeds ${MAX_REQUEST_BYTES} bytes`);
  }
  return {
    payload,
    requestBody,
    exactPackageVersions: Object.values(payload).reduce((total, versions) => total + versions.length, 0),
    nodeModulesEntries,
  };
}

function validAuditReport(decoded) {
  if (
    decoded.auditReportVersion !== 2 ||
    !isRecord(decoded.vulnerabilities) ||
    !isRecord(decoded.metadata) ||
    !isRecord(decoded.metadata.vulnerabilities)
  ) {
    return false;
  }

  const counts = decoded.metadata.vulnerabilities;
  if (
    ![...NPM_SEVERITIES, "total"].every(
      (key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0,
    )
  ) {
    return false;
  }
  const vulnerabilityEntries = Object.values(decoded.vulnerabilities);
  if (
    counts.total !== NPM_SEVERITIES.reduce((total, severity) => total + counts[severity], 0) ||
    counts.total !== vulnerabilityEntries.length
  ) {
    return false;
  }

  const observedCounts = Object.fromEntries(NPM_SEVERITIES.map((severity) => [severity, 0]));
  for (const vulnerability of vulnerabilityEntries) {
    if (!isRecord(vulnerability) || !NPM_SEVERITIES.includes(vulnerability.severity)) return false;
    observedCounts[vulnerability.severity] += 1;
  }
  return NPM_SEVERITIES.every((severity) => observedCounts[severity] === counts[severity]);
}

export function classifyNpmAuditResult(rawOutput, auditStatus) {
  if (!Number.isSafeInteger(auditStatus) || auditStatus < 0 || auditStatus > 255) {
    return { disposition: "fail", reason: "invalid-npm-exit-status" };
  }

  let decoded;
  try {
    decoded = JSON.parse(rawOutput);
  } catch {
    return { disposition: "fail", reason: "npm-output-is-not-json" };
  }
  if (!isRecord(decoded)) return { disposition: "fail", reason: "npm-output-is-not-an-object" };

  const hasAuditFields = ["auditReportVersion", "vulnerabilities", "metadata"].some((key) =>
    Object.hasOwn(decoded, key),
  );
  if (hasAuditFields) {
    if (!validAuditReport(decoded)) return { disposition: "fail", reason: "npm-audit-report-is-inconsistent" };
    if (auditStatus !== 0) return { disposition: "fail", reason: "npm-audit-report-has-nonzero-exit" };
    const counts = decoded.metadata.vulnerabilities;
    if (counts.high !== 0 || counts.critical !== 0) {
      return { disposition: "fail", reason: "npm-audit-report-has-blocking-vulnerabilities" };
    }
    return { disposition: "pass", reason: "npm-audit-report-clean-at-high-threshold" };
  }
  if (auditStatus === 0) return { disposition: "fail", reason: "npm-zero-exit-without-valid-audit-report" };

  if (
    auditStatus === 1 &&
    hasExactKeys(decoded, ["message", "error"]) &&
    decoded.message === BULK_NETWORK_TIMEOUT_MESSAGE &&
    hasExactKeys(decoded.error, ["summary", "detail"]) &&
    decoded.error.summary === "" &&
    decoded.error.detail === ""
  ) {
    return { disposition: "retry", reason: "npm-advisory-endpoint-network-timeout" };
  }

  const message = typeof decoded.message === "string" ? decoded.message : "";
  const messageMatch = message.match(
    /^(50[234])\s[^\r\n]*\s-\s(POST)\s(https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/security\/advisories\/bulk)(?:\s-\s[^\r\n]*)?$/u,
  );
  if (!messageMatch) {
    return { disposition: "fail", reason: "npm-failure-is-not-an-explicit-advisory-endpoint-502-504" };
  }

  const observedRecords = [decoded, decoded.error].filter(isRecord);
  for (const record of observedRecords) {
    if (Object.hasOwn(record, "statusCode") && Number(record.statusCode) !== Number(messageMatch[1])) {
      return { disposition: "fail", reason: "npm-service-status-fields-contradict-message" };
    }
    if (Object.hasOwn(record, "method") && record.method !== messageMatch[2]) {
      return { disposition: "fail", reason: "npm-service-method-fields-contradict-message" };
    }
    if (Object.hasOwn(record, "uri") && record.uri !== messageMatch[3]) {
      return { disposition: "fail", reason: "npm-service-uri-fields-contradict-message" };
    }
  }
  return { disposition: "retry", reason: "npm-advisory-endpoint-502-504" };
}

export async function queryNpmBulkAdvisories({
  requestBody,
  expectedPackageNames,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
}) {
  if (typeof requestBody !== "string" || Buffer.byteLength(requestBody) > MAX_REQUEST_BYTES) {
    throw new Error("invalid npm bulk advisory request body");
  }
  if (!(expectedPackageNames instanceof Set) || expectedPackageNames.size === 0) {
    throw new Error("expectedPackageNames must be a non-empty Set");
  }
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  let requestPayload;
  try {
    requestPayload = JSON.parse(requestBody);
  } catch {
    throw new Error("npm bulk advisory request body is not valid JSON");
  }
  assertRecord(requestPayload, "npm bulk advisory request");
  const requestNames = Object.keys(requestPayload);
  if (
    requestNames.length !== expectedPackageNames.size ||
    requestNames.some((name) => !expectedPackageNames.has(name)) ||
    requestNames.some(
      (name) =>
        !Array.isArray(requestPayload[name]) ||
        requestPayload[name].length === 0 ||
        requestPayload[name].some((version) => typeof version !== "string" || !EXACT_SEMVER.test(version)),
    )
  ) {
    throw new Error("npm bulk advisory request body does not match the exact package set");
  }

  const response = await fetchImpl(BULK_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "aether-agent-supply-chain-audit",
    },
    body: requestBody,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  if (response.status !== 200) {
    const detail = body.replace(/\s+/gu, " ").slice(0, 300);
    throw new Error(`npm bulk advisory endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  let decoded;
  try {
    decoded = JSON.parse(body);
  } catch {
    throw new Error("npm bulk advisory endpoint returned invalid JSON");
  }
  assertRecord(decoded, "npm bulk advisory response");

  const advisoryPackages = Object.keys(decoded).sort();
  for (const packageName of advisoryPackages) {
    if (!expectedPackageNames.has(packageName) || !Array.isArray(decoded[packageName])) {
      throw new Error("npm bulk advisory endpoint returned an unexpected response shape");
    }
  }
  return advisoryPackages;
}

export async function auditLockfile({
  lockfilePath = "package-lock.json",
  fetchImpl = globalThis.fetch,
  writeReport = (line) => process.stdout.write(line),
} = {}) {
  const rawLockfile = await readFile(lockfilePath, "utf8");
  let lockfile;
  try {
    lockfile = JSON.parse(rawLockfile);
  } catch {
    throw new Error(`${lockfilePath} is not valid JSON`);
  }

  const collected = collectNpmBulkPayload(lockfile);
  const advisoryPackages = await queryNpmBulkAdvisories({
    requestBody: collected.requestBody,
    expectedPackageNames: new Set(Object.keys(collected.payload)),
    fetchImpl,
  });
  const report = {
    schema: "aether.npm-bulk-audit/v1",
    source: BULK_URL.href,
    request_encoding: "identity",
    lockfile_sha256: createHash("sha256").update(rawLockfile).digest("hex"),
    node_modules_entries: collected.nodeModulesEntries,
    exact_package_versions: collected.exactPackageVersions,
    requested_package_names: Object.keys(collected.payload).length,
    advisory_packages: advisoryPackages,
  };
  writeReport(`${JSON.stringify(report)}\n`);
  if (advisoryPackages.length > 0) {
    throw new Error(`npm bulk advisory endpoint returned advisories for ${advisoryPackages.length} package(s)`);
  }
  return report;
}

async function main(args = process.argv.slice(2)) {
  try {
    if (args[0] === "--classify-npm-audit-result") {
      if (args.length !== 3) throw new Error("--classify-npm-audit-result requires an exit status and JSON file");
      const classification = classifyNpmAuditResult(await readFile(args[2], "utf8"), Number(args[1]));
      process.stdout.write(`${JSON.stringify(classification)}\n`);
      if (classification.disposition === "retry") process.exitCode = 10;
      if (classification.disposition === "fail") process.exitCode = 1;
      return;
    }
    if (args.length !== 0) throw new Error("unsupported arguments");
    await auditLockfile();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`npm-bulk-audit: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
