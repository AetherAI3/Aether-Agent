// Exact-source Agent/ATSv2 execution-wire conformance. No service is started.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(agentRoot, "contracts/ats-execution-parity/v1.json"), "utf8"));

function fail(message) {
  throw new Error(message);
}

function command(executable, args, cwd, env = process.env) {
  const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error) fail(executable + " could not start: " + result.error.message);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) fail(executable + " exited " + result.status + " while running " + args.join(" "));
  return result.stdout.trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) fail("Cannot resolve Git HEAD at " + root);
  return result.stdout.trim();
}

const options = { atsv2: null, report: null, allowDirty: false };
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === "--atsv2" || arg === "--report") {
    const value = process.argv[++index];
    if (!value) fail(arg + " requires a path.");
    options[arg.slice(2)] = resolve(value);
  } else if (arg === "--allow-dirty") {
    options.allowDirty = true;
  } else {
    fail("Unknown option: " + arg);
  }
}
if (!options.atsv2) fail("Pass --atsv2 <checkout>.");
const atsv2Root = options.atsv2;
const agentSha = sha(agentRoot);
const atsv2Sha = sha(atsv2Root);
if (manifest.schema !== "aether.ats.execution-parity-manifest/1" || !/^[0-9a-f]{40}$/.test(manifest.atsv2_sha)) {
  fail("Invalid ATS execution parity manifest.");
}
const requiredFixtures = ["execution-foundation", "model-proposal", "browser-order", "execution-v2", "runtime-activation"];
if (!Array.isArray(manifest.fixtures) ||
    JSON.stringify(manifest.fixtures.map(entry => entry.name).sort()) !== JSON.stringify(requiredFixtures.sort())) {
  fail("ATS execution parity manifest must pin all five fixture streams exactly once.");
}
if (atsv2Sha !== manifest.atsv2_sha) fail("ATSv2 checkout mismatch: expected " + manifest.atsv2_sha + ", got " + atsv2Sha);
if (process.env.AETHER_EXPECTED_AGENT_SHA && agentSha !== process.env.AETHER_EXPECTED_AGENT_SHA) {
  fail("Agent checkout mismatch: expected " + process.env.AETHER_EXPECTED_AGENT_SHA + ", got " + agentSha);
}
for (const [label, root] of [["Agent", agentRoot], ["ATSv2", atsv2Root]]) {
  const state = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" });
  if (state.error || state.status !== 0) fail("Cannot inspect " + label + " working tree.");
  if (state.stdout.trim() && !options.allowDirty) fail(label + " checkout has uncommitted source changes; use --allow-dirty only for local development.");
}

const fixtureDigests = {};
const fixtureCounts = {};
for (const entry of manifest.fixtures) {
  const agentBytes = readFileSync(join(agentRoot, entry.agent));
  const atsv2Bytes = readFileSync(join(atsv2Root, entry.atsv2));
  const agentDigest = sha256(agentBytes);
  const atsv2Digest = sha256(atsv2Bytes);
  if (agentDigest !== entry.sha256 || atsv2Digest !== entry.sha256 || !agentBytes.equals(atsv2Bytes)) {
    fail(entry.name + " fixture bytes drifted: expected " + entry.sha256 + ", Agent " + agentDigest + ", ATSv2 " + atsv2Digest);
  }
  fixtureDigests[entry.name] = entry.sha256;
  const parsed = JSON.parse(agentBytes.toString("utf8"));
  fixtureCounts[entry.name] = Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]),
  );
}
console.log("Agent " + agentSha);
console.log("ATSv2 " + atsv2Sha);
console.log("Exact fixture bytes: " + manifest.fixtures.length + " streams");

const python = process.env.AETHER_PARITY_PYTHON || "python";
const nodeTests = [
  "ats_" + "contracts", "ats_contracts_v2", "ats_model_proposal",
  "ats_browser_order", "ats_spec2_contracts", "ats_no_order_tool",
];
command(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], agentRoot);
command(process.execPath, ["--test", ...nodeTests.map(name => "dist/test/" + name + ".test.js")], agentRoot);
for (const script of [
  "ats_contracts_golden_verify.py",
  "ats_browser_order_verify.py",
  "ats_contracts_v2_verify.py",
]) {
  command(python, ["test/fixtures/" + script], agentRoot);
}
const pythonTests = [
  "test_agent_wire_conformance.py",
  "test_agent_browser_ats_order_conformance.py",
  "test_agent_execution_v2_conformance.py",
  "test_agent_foundation_wire.py",
];
command(python, ["-m", "pytest", "-o", "testpaths=", ...pythonTests.map(name => "ats-mcp/tests/" + name), "-q"], atsv2Root);

const report = {
  schema: "aether.ats.execution-parity-evidence/1",
  agent_sha: agentSha,
  atsv2_sha: atsv2Sha,
  fixture_sha256: fixtureDigests,
  fixture_counts: fixtureCounts,
  node_tests: nodeTests,
  python_tests: pythonTests,
  no_order_tool_tested: true,
  passed: true,
};
console.log(JSON.stringify(report));
if (options.report) writeFileSync(options.report, JSON.stringify(report, null, 2) + "\n", { flag: "w" });
