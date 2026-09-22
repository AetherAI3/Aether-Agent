// PR 2.2 — entitled-manifest verification, installation, supervision and the
// ATS doctor.
//
// Every signing key here is generated in-process, and nothing reaches the
// network: `manifest.ts` is deliberately I/O-free so the security decision can
// be tested exhaustively, and `install.ts` takes its fetcher and extractor as
// injected seams for the same reason.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signEd25519, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalManifestBytes,
  installationReceiptFrom,
  validateRuntimeManifest,
  verifyArchive,
  verifyManifest,
  type RuntimeManifestV1,
  type RuntimeTrustAnchor,
} from "../src/core/ats_runtime/manifest.js";
import { adoptExistingInstall, installRuntime } from "../src/core/ats_runtime/install.js";
import {
  emptyRuntimeRecord,
  readRuntimeRecord,
  writeDataRecord,
  writeRuntimeRecord,
  type RuntimeRecordV1,
} from "../src/core/ats_runtime/store.js";
import {
  rollbackRuntime,
  runtimeStatus,
  startRuntime,
  stopRuntime,
  tearDownForAccountSwitch,
  type SupervisedChild,
  type SupervisorDeps,
} from "../src/core/ats_runtime/supervisor.js";
import { buildAtsDoctorReport, renderAtsDoctorReport } from "../src/core/ats_runtime/doctor.js";

const AGENT_VERSION = "0.4.0";
const NOW = Date.parse("2026-09-22T12:00:00Z");
const clock = (): Date => new Date(NOW);

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aether-ats-spec2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function keypair(): { anchor: RuntimeTrustAnchor; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    anchor: {
      key_id: "anchor_test",
      public_key_spki_base64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    },
    privateKey,
  };
}

function manifestFor(bytes: Uint8Array, platform = "linux-x64"): RuntimeManifestV1 {
  return validateRuntimeManifest({
    schema_version: "aether.ats.runtime-manifest/1",
    runtime_version: "0.4.0",
    agent_compatibility: { min: "0.4.0", max: "0.5.0" },
    issued_at: "2026-09-22T00:00:00Z",
    expires_at: "2026-10-22T00:00:00Z",
    artifacts: [{
      platform,
      artifact_sha256: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.byteLength,
      python_version: "3.12.4",
      component_versions: { llmre: "0.4.0", features: "0.4.0", ats_mcp: "0.4.0" },
    }],
  });
}

function signManifest(manifest: RuntimeManifestV1, privateKey: KeyObject): string {
  return signEd25519(null, Buffer.from(canonicalManifestBytes(manifest), "utf8"), privateKey).toString("base64");
}

// ---------------------------------------------------------------- manifest

test("a manifest with no configured trust anchor is refused, not trusted on its digest", () => {
  const manifest = manifestFor(Buffer.from("runtime archive"));
  const verdict = verifyManifest({
    manifest, signatureBase64: "", anchors: [], agentVersion: AGENT_VERSION, platform: "linux-x64", now: NOW,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failure, "no_trust_anchor");
});

test("a correctly signed manifest verifies and names the artifact for this platform", () => {
  const manifest = manifestFor(Buffer.from("runtime archive"));
  const { anchor, privateKey } = keypair();
  const verdict = verifyManifest({
    manifest,
    signatureBase64: signManifest(manifest, privateKey),
    anchors: [anchor],
    agentVersion: AGENT_VERSION,
    platform: "linux-x64",
    now: NOW,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.key_id, "anchor_test");
  assert.equal(verdict.artifact?.platform, "linux-x64");
});

test("a manifest edited after signing fails verification", () => {
  const manifest = manifestFor(Buffer.from("runtime archive"));
  const { anchor, privateKey } = keypair();
  const signature = signManifest(manifest, privateKey);

  const tampered = validateRuntimeManifest({ ...manifest, runtime_version: "9.9.9" });
  const verdict = verifyManifest({
    manifest: tampered, signatureBase64: signature, anchors: [anchor],
    agentVersion: AGENT_VERSION, platform: "linux-x64", now: NOW,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failure, "bad_signature");
});

test("a signature from a key outside the anchor set is refused", () => {
  const manifest = manifestFor(Buffer.from("runtime archive"));
  const trusted = keypair();
  const attacker = keypair();
  const verdict = verifyManifest({
    manifest, signatureBase64: signManifest(manifest, attacker.privateKey), anchors: [trusted.anchor],
    agentVersion: AGENT_VERSION, platform: "linux-x64", now: NOW,
  });
  assert.equal(verdict.failure, "bad_signature");
});

test("expiry, compatibility and platform are each refused with their own reason", () => {
  const manifest = manifestFor(Buffer.from("runtime archive"));
  const { anchor, privateKey } = keypair();
  const base = { manifest, signatureBase64: signManifest(manifest, privateKey), anchors: [anchor], platform: "linux-x64" };

  assert.equal(
    verifyManifest({ ...base, agentVersion: AGENT_VERSION, now: Date.parse("2026-11-01T00:00:00Z") }).failure,
    "manifest_expired",
  );
  assert.equal(verifyManifest({ ...base, agentVersion: "0.3.0", now: NOW }).failure, "agent_incompatible");
  assert.equal(
    verifyManifest({ ...base, platform: "win32-x64", agentVersion: AGENT_VERSION, now: NOW }).failure,
    "platform_unsupported",
  );
});

test("a pre-release agent build stays inside its compatibility window", () => {
  const manifest = manifestFor(Buffer.from("runtime archive"));
  const { anchor, privateKey } = keypair();
  const verdict = verifyManifest({
    manifest, signatureBase64: signManifest(manifest, privateKey), anchors: [anchor],
    agentVersion: "0.4.0-rc.1", platform: "linux-x64", now: NOW,
  });
  assert.equal(verdict.ok, true);
});

test("archive bytes are checked for size and digest separately", () => {
  const bytes = Buffer.from("runtime archive");
  const artifact = manifestFor(bytes).artifacts[0]!;

  assert.equal(verifyArchive(bytes, artifact).ok, true);
  assert.equal(verifyArchive(Buffer.from("runtime archiv"), artifact).failure, "size_mismatch");
  assert.equal(verifyArchive(Buffer.from("runtime archivE"), artifact).failure, "digest_mismatch");
});

test("no installation receipt can be built from a refused verdict", () => {
  const manifest = manifestFor(Buffer.from("runtime archive"));
  const refused = { ok: false, failure: "bad_signature" as const, reason: "no", key_id: null, artifact: null };
  assert.throws(
    () => installationReceiptFrom({
      manifestVerdict: refused, archiveVerdict: refused, manifest,
      installationId: "inst_test", installedAt: "2026-09-22T12:00:00Z",
    }),
    /cannot be written for an unverified runtime/,
  );
});

// ---------------------------------------------------------------- install

function installDeps(bytes: Uint8Array, manifest: RuntimeManifestV1, anchor: RuntimeTrustAnchor, signature: string) {
  return {
    source: { resolve: async () => ({ manifest, signatureBase64: signature, anchors: [anchor] }) },
    fetcher: { fetch: async () => bytes },
    extractor: {
      extract: async ({ destination }: { bytes: Uint8Array; destination: string }) => {
        await mkdir(join(destination, "bin"), { recursive: true });
        await writeFile(join(destination, "bin", "ats-runtime"), "#!/bin/sh\n", { mode: 0o700 });
      },
    },
    now: clock,
  };
}

test("install refuses honestly when no entitled source is configured", async t => {
  const root = await temporary(t);
  const outcome = await installRuntime({
    recordPath: join(root, "runtime.json"),
    installDir: join(root, "runtime"),
    previousDir: join(root, "runtime.previous"),
    agentVersion: AGENT_VERSION,
    requestedMode: "observe",
    platform: "linux-x64",
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure, "entitlement_unavailable");
  assert.equal(await readRuntimeRecord(join(root, "runtime.json")), null);
});

test("a verified install writes a provenance receipt and a 0600 credential", async t => {
  const root = await temporary(t);
  const bytes = Buffer.from("runtime archive");
  const manifest = manifestFor(bytes);
  const { anchor, privateKey } = keypair();

  const outcome = await installRuntime({
    recordPath: join(root, "runtime.json"),
    installDir: join(root, "runtime"),
    previousDir: join(root, "runtime.previous"),
    agentVersion: AGENT_VERSION,
    requestedMode: "observe",
    platform: "linux-x64",
  }, installDeps(bytes, manifest, anchor, signManifest(manifest, privateKey)));

  assert.equal(outcome.ok, true);
  const record = await readRuntimeRecord(join(root, "runtime.json"));
  assert.ok(record?.installation);
  assert.equal(record.installation.provenance_verified, true);
  assert.equal(record.installation.runtime_version, "0.4.0");
  assert.equal(record.installation.artifact_sha256, createHash("sha256").update(bytes).digest("hex"));

  // The credential is a path in the record and a secret only on disk.
  assert.ok(record.credential_file);
  const rawRecord = await readFile(join(root, "runtime.json"), "utf8");
  const credential = (await readFile(record.credential_file, "utf8")).trim();
  assert.match(credential, /^[0-9a-f]{64}$/);
  assert.ok(!rawRecord.includes(credential), "the credential value must never enter runtime.json");
  if (process.platform !== "win32") {
    assert.equal((await stat(record.credential_file)).mode & 0o777, 0o600);
  }
});

test("a tampered archive is refused and nothing is installed", async t => {
  const root = await temporary(t);
  const bytes = Buffer.from("runtime archive");
  const manifest = manifestFor(bytes);
  const { anchor, privateKey } = keypair();
  const deps = installDeps(bytes, manifest, anchor, signManifest(manifest, privateKey));

  const outcome = await installRuntime({
    recordPath: join(root, "runtime.json"),
    installDir: join(root, "runtime"),
    previousDir: join(root, "runtime.previous"),
    agentVersion: AGENT_VERSION,
    requestedMode: "observe",
    platform: "linux-x64",
  }, { ...deps, fetcher: { fetch: async () => Buffer.from("evil archive!!") } });

  assert.equal(outcome.ok, false);
  assert.ok(outcome.failure === "digest_mismatch" || outcome.failure === "size_mismatch");
  assert.equal(await readRuntimeRecord(join(root, "runtime.json")), null);
});

test("adopting an existing directory records no provenance receipt", async t => {
  const root = await temporary(t);
  const installDir = join(root, "existing");
  await mkdir(installDir, { recursive: true });

  const outcome = await adoptExistingInstall(
    { recordPath: join(root, "runtime.json"), installDir, requestedMode: "observe" },
    { now: clock },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.record?.installation, null);
  assert.match(outcome.reason ?? "", /provenance is unverified/);
});

// ---------------------------------------------------------------- supervisor

async function installedRecord(root: string): Promise<{ path: string; record: RuntimeRecordV1 }> {
  const bytes = Buffer.from("runtime archive");
  const manifest = manifestFor(bytes);
  const { anchor, privateKey } = keypair();
  const path = join(root, "runtime.json");
  const outcome = await installRuntime({
    recordPath: path,
    installDir: join(root, "runtime"),
    previousDir: join(root, "runtime.previous"),
    agentVersion: AGENT_VERSION,
    requestedMode: "paper",
    platform: "linux-x64",
  }, installDeps(bytes, manifest, anchor, signManifest(manifest, privateKey)));
  assert.ok(outcome.record);
  return { path, record: outcome.record };
}

function fakeChild(pid: number): SupervisedChild {
  return { pid, kill: () => true, unref: () => {} };
}

test("the runtime cannot start without a verified installation", async t => {
  const root = await temporary(t);
  const path = join(root, "runtime.json");
  const record = emptyRuntimeRecord({
    runtimeInstanceId: "rt_none", installDir: join(root, "runtime"),
    requestedMode: "observe", updatedAt: "2026-09-22T12:00:00Z",
  });
  await writeRuntimeRecord(path, record);

  const result = await startRuntime(path, record, { now: clock, spawn: () => fakeChild(4242) });
  assert.equal(result.changed, false);
  assert.match(result.reason ?? "", /No verified ATS runtime is installed/);
});

test("starting records a pid and stopping clears it", async t => {
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  const deps: SupervisorDeps = { now: clock, spawn: () => fakeChild(4242), pidAlive: () => true, terminate: () => {} };

  const started = await startRuntime(path, record, deps);
  assert.equal(started.record.supervisor.pid, 4242);

  const stopped = await stopRuntime(path, started.record, deps);
  assert.equal(stopped.record.supervisor.pid, null);
  assert.equal((await readRuntimeRecord(path))?.supervisor.pid, null);
});

test("status is offline whenever the runtime cannot be observed", async t => {
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  const started = await startRuntime(path, record, { now: clock, spawn: () => fakeChild(4242), pidAlive: () => true });

  // Dead process: the stored pid is a claim, not evidence.
  const dead = await runtimeStatus(started.record, { now: clock, pidAlive: () => false });
  assert.equal(dead.effective_mode, "offline");
  assert.match(dead.effective_reason, /not running/);

  // Alive but no channel — still offline, never the requested mode.
  const noChannel = await runtimeStatus(started.record, { now: clock, pidAlive: () => true });
  assert.equal(noChannel.effective_mode, "offline");
  assert.equal(started.record.requested_mode, "paper");

  // Alive but the probe throws.
  const broken = await runtimeStatus(started.record, {
    now: clock, pidAlive: () => true, probe: async () => { throw new Error("socket /tmp/secret failed"); },
  });
  assert.equal(broken.effective_mode, "offline");
  assert.ok(!broken.effective_reason.includes("/tmp/secret"), "probe failures must not leak paths");
});

test("a runtime-authored snapshot is honoured, and one from another instance is not", async t => {
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  const started = await startRuntime(path, record, { now: clock, spawn: () => fakeChild(4242), pidAlive: () => true });
  const instance = started.record.runtime_instance_id;

  const reply = (id: string): Record<string, unknown> => ({
    schema_version: "aether.ats.runtime-capabilities/1",
    runtime_instance_id: id,
    observed_at: "2026-09-22T12:00:00Z",
    state: "healthy",
    capabilities: {
      status: true, market_data: true, nano_compile: true, nano_activation: true,
      trade_ledger: true, journal: true, paper_controller: false,
    },
    requested_mode: "paper",
    effective_mode: "observe",
    effective_reason: "No execution grant is attached.",
  });

  const honoured = await runtimeStatus(started.record, {
    now: clock, pidAlive: () => true, probe: async () => reply(instance),
  });
  assert.equal(honoured.state, "healthy");
  assert.equal(honoured.effective_mode, "observe");

  const foreign = await runtimeStatus(started.record, {
    now: clock, pidAlive: () => true, probe: async () => reply("rt_someoneelse"),
  });
  assert.equal(foreign.effective_mode, "offline");
});

test("rollback restores the previous tree and clears the receipt", async t => {
  const root = await temporary(t);
  const first = await installedRecord(root);
  await writeFile(join(root, "runtime", "marker"), "v1");

  // A second install parks v1 as runtime.previous.
  const bytes = Buffer.from("runtime archive two");
  const manifest = manifestFor(bytes);
  const { anchor, privateKey } = keypair();
  await installRuntime({
    recordPath: first.path,
    installDir: join(root, "runtime"),
    previousDir: join(root, "runtime.previous"),
    agentVersion: AGENT_VERSION,
    requestedMode: "paper",
    platform: "linux-x64",
  }, installDeps(bytes, manifest, anchor, signManifest(manifest, privateKey)));
  await assert.rejects(stat(join(root, "runtime", "marker")));

  const current = await readRuntimeRecord(first.path);
  assert.ok(current);
  const rolled = await rollbackRuntime(first.path, current, join(root, "runtime.previous"), {
    now: clock, terminate: () => {},
  });
  assert.equal(rolled.changed, true);
  assert.equal(rolled.record.installation, null, "a rolled-back runtime must re-verify before starting");
  assert.equal(await readFile(join(root, "runtime", "marker"), "utf8"), "v1");
});

test("an account switch stops the runtime and revokes its credential", async t => {
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  const deps: SupervisorDeps = { now: clock, spawn: () => fakeChild(4242), pidAlive: () => true, terminate: () => {} };
  const started = await startRuntime(path, record, deps);
  const credential = started.record.credential_file;
  assert.ok(credential);

  const result = await tearDownForAccountSwitch(path, deps);
  assert.equal(result.stopped, true);

  const after = await readRuntimeRecord(path);
  assert.equal(after?.supervisor.pid, null);
  assert.equal(after?.credential_file, null);
  await assert.rejects(stat(credential), "the credential file must be revoked");
  // The receipt survives: the bytes on disk are still what they were.
  assert.ok(after?.installation);
});

// ---------------------------------------------------------------- store

test("a corrupt runtime file throws rather than masquerading as a clean machine", async t => {
  const root = await temporary(t);
  const path = join(root, "runtime.json");
  await writeFile(path, "{not json", { mode: 0o600 });
  await assert.rejects(readRuntimeRecord(path), /unreadable/);
});

test("a probe receipt for another profile cannot be stored against this one", async t => {
  const root = await temporary(t);
  await assert.rejects(writeDataRecord(join(root, "data-profile.json"), {
    schema_version: "aether.ats.data-state/1",
    profile: {
      schema_version: "aether.ats.data-profile/1", profile_id: "dp_one", provider: "yfinance",
      symbols: ["SPY"], timeframe: "M5", poll_interval_ms: 5000, credential_ref: null,
      configured_at: "2026-09-22T12:00:00Z",
    },
    last_probe: {
      schema_version: "aether.ats.data-probe/1", probe_id: "pb_one", profile_id: "dp_other",
      provider: "yfinance", state: "verified", sample_count: 1, symbols_verified: ["SPY"],
      observed_at: "2026-09-22T12:00:00Z", received_at: "2026-09-22T12:00:01Z",
      freshness_ms: 1000, reason: null,
    },
    updated_at: "2026-09-22T12:00:01Z",
  }), /different data profile/);
});

// ---------------------------------------------------------------- doctor

test("the doctor reports an absent runtime as not ready", async t => {
  const root = await temporary(t);
  const report = await buildAtsDoctorReport({
    runtimeStatePath: join(root, "runtime.json"),
    dataProfilePath: join(root, "data-profile.json"),
    dashboardStatePath: join(root, "dashboard.json"),
    now: clock,
  });
  assert.equal(report.ready, false);
  assert.equal(report.axes.find(axis => axis.name === "Runtime")?.state, "unavailable");
  assert.match(renderAtsDoctorReport(report), /ATS not ready/);
});

test("zero compiled strategies is reported honestly without failing the install", async t => {
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  await startRuntime(path, record, { now: clock, spawn: () => fakeChild(4242), pidAlive: () => true });
  const instance = (await readRuntimeRecord(path))!.runtime_instance_id;

  const report = await buildAtsDoctorReport({
    runtimeStatePath: path,
    dataProfilePath: join(root, "data-profile.json"),
    dashboardStatePath: join(root, "dashboard.json"),
    strategies: { compiled: 0, rejected: 2, needs_conversion: 4, unavailable: 0, total: 6 },
    now: clock,
  }, {
    pidAlive: () => true,
    probe: async () => ({
      schema_version: "aether.ats.runtime-capabilities/1",
      runtime_instance_id: instance,
      observed_at: "2026-09-22T12:00:00Z",
      state: "healthy",
      capabilities: {
        status: true, market_data: true, nano_compile: true, nano_activation: true,
        trade_ledger: true, journal: true, paper_controller: false,
      },
      requested_mode: "paper",
      effective_mode: "observe",
      effective_reason: "No execution grant is attached.",
    }),
  });

  const strategies = report.axes.find(axis => axis.name === "Strategies");
  assert.equal(strategies?.state, "incomplete");
  assert.match(strategies?.detail ?? "", /0 compiled/);
  // Strategy readiness does not gate: section 5 permits finishing setup here.
  assert.equal(report.ready, true);
  assert.match(report.axes.find(axis => axis.name === "Execution")?.detail ?? "", /Requested paper; effective observe/);
});
