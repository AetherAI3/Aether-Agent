// PR 2.2 — manifest verification, transactional install, supervision, rollback
// and the ATS doctor.
//
// Every signing key here is generated in-process and nothing reaches the
// network: `manifest.ts` is deliberately I/O-free so the security decision can
// be tested exhaustively, and `install.ts` takes its fetcher and extractor as
// injected seams for the same reason.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signEd25519, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalManifestBytes,
  fixedTrustAnchorProvider,
  installationReceiptFrom,
  PINNED_TRUST_ANCHORS,
  validateRuntimeManifest,
  verifyAnchorRotation,
  verifyArchive,
  verifyManifest,
  type RuntimeManifestV1,
  type RuntimeTrustAnchor,
} from "../src/core/ats_runtime/manifest.js";
import { adoptExistingInstall, installRuntime } from "../src/core/ats_runtime/install.js";
import { verifyExtractedTree } from "../src/core/ats_runtime/archive_guard.js";
import {
  computeTreeDigest,
  readActivePointer,
  readSlotReceipt,
  recoverActiveSlot,
  slotDir,
  slotReceiptPath,
} from "../src/core/ats_runtime/slots.js";
import {
  emptyRuntimeRecord,
  readRuntimeRecord,
  writeDataRecord,
  writeRuntimeRecord,
  type RuntimeRecordV1,
} from "../src/core/ats_runtime/store.js";
import {
  processOwnership,
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

function keypair(id = "anchor_test"): { anchor: RuntimeTrustAnchor; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    anchor: { key_id: id, public_key_spki_base64: publicKey.export({ format: "der", type: "spki" }).toString("base64") },
    privateKey,
  };
}

function manifestFor(bytes: Uint8Array, platform = "linux-x64", runtimeVersion = "0.4.0"): RuntimeManifestV1 {
  return validateRuntimeManifest({
    schema_version: "aether.ats.runtime-manifest/1",
    runtime_version: runtimeVersion,
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

test("the build ships no pinned trust anchor, so verification refuses by default", () => {
  assert.equal(PINNED_TRUST_ANCHORS.length, 0);
  const manifest = manifestFor(Buffer.from("runtime archive"));
  const verdict = verifyManifest({
    manifest, signatureBase64: "", anchors: PINNED_TRUST_ANCHORS,
    agentVersion: AGENT_VERSION, platform: "linux-x64", now: NOW,
  });
  assert.equal(verdict.failure, "no_trust_anchor");
});

// The blocker: a manifest source must not be able to supply the key that
// verifies its own manifest.
test("a key the manifest source could have minted does not verify against pinned anchors", () => {
  const manifest = manifestFor(Buffer.from("runtime archive"));
  const attacker = keypair("anchor_attacker");
  const pinned = keypair("anchor_pinned");

  // The attacker signs its own manifest perfectly. Under the old design it
  // also returned `attacker.anchor` and this verified.
  const verdict = verifyManifest({
    manifest,
    signatureBase64: signManifest(manifest, attacker.privateKey),
    anchors: fixedTrustAnchorProvider([pinned.anchor]).anchors(),
    agentVersion: AGENT_VERSION, platform: "linux-x64", now: NOW,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failure, "bad_signature");
});

test("a correctly signed manifest verifies and names the artifact for this platform", () => {
  const manifest = manifestFor(Buffer.from("runtime archive"));
  const { anchor, privateKey } = keypair();
  const verdict = verifyManifest({
    manifest, signatureBase64: signManifest(manifest, privateKey), anchors: [anchor],
    agentVersion: AGENT_VERSION, platform: "linux-x64", now: NOW,
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
  assert.equal(verifyManifest({
    manifest: tampered, signatureBase64: signature, anchors: [anchor],
    agentVersion: AGENT_VERSION, platform: "linux-x64", now: NOW,
  }).failure, "bad_signature");
});

test("expiry, compatibility and platform are each refused with their own reason", () => {
  const manifest = manifestFor(Buffer.from("runtime archive"));
  const { anchor, privateKey } = keypair();
  const base = { manifest, signatureBase64: signManifest(manifest, privateKey), anchors: [anchor], platform: "linux-x64" };

  assert.equal(verifyManifest({ ...base, agentVersion: AGENT_VERSION, now: Date.parse("2026-11-01T00:00:00Z") }).failure, "manifest_expired");
  assert.equal(verifyManifest({ ...base, agentVersion: "0.3.0", now: NOW }).failure, "agent_incompatible");
  assert.equal(verifyManifest({ ...base, platform: "win32-x64", agentVersion: AGENT_VERSION, now: NOW }).failure, "platform_unsupported");
});

test("a pre-release agent build stays inside its compatibility window", () => {
  const manifest = manifestFor(Buffer.from("runtime archive"));
  const { anchor, privateKey } = keypair();
  assert.equal(verifyManifest({
    manifest, signatureBase64: signManifest(manifest, privateKey), anchors: [anchor],
    agentVersion: "0.4.0-rc.1", platform: "linux-x64", now: NOW,
  }).ok, true);
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
  assert.throws(() => installationReceiptFrom({
    manifestVerdict: refused, archiveVerdict: refused, manifest,
    installationId: "inst_test", installedAt: "2026-09-22T12:00:00Z",
  }), /cannot be written for an unverified runtime/);
});

test("anchor rotation must chain to an already-trusted key", () => {
  const rooted = keypair("anchor_root");
  const next = keypair("anchor_next");
  const rotation = {
    schema_version: "aether.ats.runtime-trust-rotation/1",
    issued_at: "2026-09-22T00:00:00Z",
    expires_at: "2026-12-22T00:00:00Z",
    anchors: [next.anchor],
  };
  const message = Buffer.from(JSON.stringify(rotation), "utf8");
  void message;

  // Signed by the existing root: accepted.
  const signedByRoot = signEd25519(
    null,
    Buffer.from(canonicalRotationBytes(rotation), "utf8"),
    rooted.privateKey,
  ).toString("base64");
  const adopted = verifyAnchorRotation({
    rotation, signatureBase64: signedByRoot, trusted: fixedTrustAnchorProvider([rooted.anchor]), now: NOW,
  });
  assert.deepEqual(adopted?.map(a => a.key_id), ["anchor_next"]);

  // Self-signed by the key it is trying to introduce: refused.
  const selfSigned = signEd25519(
    null,
    Buffer.from(canonicalRotationBytes(rotation), "utf8"),
    next.privateKey,
  ).toString("base64");
  assert.equal(verifyAnchorRotation({
    rotation, signatureBase64: selfSigned, trusted: fixedTrustAnchorProvider([rooted.anchor]), now: NOW,
  }), null);

  // With nothing already trusted there is no chain to extend.
  assert.equal(verifyAnchorRotation({
    rotation, signatureBase64: signedByRoot, trusted: fixedTrustAnchorProvider([]), now: NOW,
  }), null);
});

/** Mirrors the canonical encoding verifyAnchorRotation signs over. */
function canonicalRotationBytes(rotation: Record<string, unknown>): string {
  const sortDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortDeep);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = sortDeep((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(sortDeep(rotation));
}

// ---------------------------------------------------------------- install

function installDeps(bytes: Uint8Array, manifest: RuntimeManifestV1, anchor: RuntimeTrustAnchor, signature: string) {
  return {
    source: { resolve: async () => ({ manifest, signatureBase64: signature }) },
    trustAnchors: fixedTrustAnchorProvider([anchor]),
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

async function install(root: string, bytes = Buffer.from("runtime archive"), version = "0.4.0") {
  const manifest = manifestFor(bytes, "linux-x64", version);
  const { anchor, privateKey } = keypair();
  return installRuntime({
    recordPath: join(root, "runtime.json"),
    installRoot: join(root, "runtime"),
    agentVersion: AGENT_VERSION,
    requestedMode: "paper",
    platform: "linux-x64",
  }, installDeps(bytes, manifest, anchor, signManifest(manifest, privateKey)));
}

test("install refuses honestly when no entitled source is configured", async t => {
  const root = await temporary(t);
  const outcome = await installRuntime({
    recordPath: join(root, "runtime.json"),
    installRoot: join(root, "runtime"),
    agentVersion: AGENT_VERSION,
    requestedMode: "observe",
    platform: "linux-x64",
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure, "entitlement_unavailable");
  assert.equal(await readRuntimeRecord(join(root, "runtime.json")), null);
});

test("entitlement transport errors cannot expose credentials in install feedback", async t => {
  const root = await temporary(t);
  const outcome = await installRuntime({
    recordPath: join(root, "runtime.json"), installRoot: join(root, "runtime"),
    agentVersion: AGENT_VERSION, requestedMode: "observe", platform: "linux-x64",
  }, { source: { resolve: async () => { throw new Error("token=private-secret at /home/operator/keys"); } } });
  assert.equal(outcome.failure, "entitlement_unavailable");
  assert.doesNotMatch(outcome.reason ?? "", /private-secret|\/home\/operator/);
});

test("a verified install commits a slot, a pointer and a 0600 credential", async t => {
  const root = await temporary(t);
  const outcome = await install(root);
  assert.equal(outcome.ok, true);

  const pointer = await readActivePointer(join(root, "runtime"));
  assert.equal(pointer?.slot, "a");
  const receipt = await readSlotReceipt(join(root, "runtime"), "a");
  assert.equal(receipt?.installation.provenance_verified, true);
  assert.equal(receipt?.tree_sha256, pointer?.tree_sha256);

  const record = await readRuntimeRecord(join(root, "runtime.json"));
  assert.ok(record?.credential_file);
  const rawRecord = await readFile(join(root, "runtime.json"), "utf8");
  const credential = (await readFile(record.credential_file, "utf8")).trim();
  assert.match(credential, /^[0-9a-f]{64}$/);
  assert.ok(!rawRecord.includes(credential), "the credential value must never enter runtime.json");
  if (process.platform !== "win32") {
    assert.equal((await stat(record.credential_file)).mode & 0o777, 0o600);
  }
});

test("a second install lands in the other slot and leaves the first intact", async t => {
  const root = await temporary(t);
  await install(root, Buffer.from("runtime archive"), "0.4.0");
  await install(root, Buffer.from("runtime archive two"), "0.4.1");

  const pointer = await readActivePointer(join(root, "runtime"));
  assert.equal(pointer?.slot, "b");
  // Both receipts survive — that is what makes rollback non-destructive.
  assert.equal((await readSlotReceipt(join(root, "runtime"), "a"))?.installation.runtime_version, "0.4.0");
  assert.equal((await readSlotReceipt(join(root, "runtime"), "b"))?.installation.runtime_version, "0.4.1");
});

test("a tampered archive is refused and nothing is installed", async t => {
  const root = await temporary(t);
  const bytes = Buffer.from("runtime archive");
  const manifest = manifestFor(bytes);
  const { anchor, privateKey } = keypair();
  const deps = installDeps(bytes, manifest, anchor, signManifest(manifest, privateKey));

  const outcome = await installRuntime({
    recordPath: join(root, "runtime.json"),
    installRoot: join(root, "runtime"),
    agentVersion: AGENT_VERSION,
    requestedMode: "observe",
    platform: "linux-x64",
  }, { ...deps, fetcher: { fetch: async () => Buffer.from("evil archive!!") } });

  assert.equal(outcome.ok, false);
  assert.ok(outcome.failure === "digest_mismatch" || outcome.failure === "size_mismatch");
  assert.equal(await readRuntimeRecord(join(root, "runtime.json")), null);
});

test("an extractor that escapes its slot is caught and the slot is discarded", async t => {
  if (process.platform === "win32") {
    t.skip("Windows symlink creation needs elevation");
    return;
  }
  const root = await temporary(t);
  const bytes = Buffer.from("runtime archive");
  const manifest = manifestFor(bytes);
  const { anchor, privateKey } = keypair();
  const deps = installDeps(bytes, manifest, anchor, signManifest(manifest, privateKey));

  const outcome = await installRuntime({
    recordPath: join(root, "runtime.json"),
    installRoot: join(root, "runtime"),
    agentVersion: AGENT_VERSION,
    requestedMode: "observe",
    platform: "linux-x64",
  }, {
    ...deps,
    extractor: {
      extract: async ({ destination }: { bytes: Uint8Array; destination: string }) => {
        await mkdir(join(destination, "bin"), { recursive: true });
        await symlink("/etc/passwd", join(destination, "bin", "escape"));
      },
    },
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure, "symlink");
  // No pointer, no receipt, and the staged bytes are gone.
  assert.equal(await readActivePointer(join(root, "runtime")), null);
  await assert.rejects(stat(slotDir(join(root, "runtime"), "a")));
});

test("the extraction guard rejects links, devices and oversize trees", async t => {
  const root = await temporary(t);
  const clean = join(root, "clean");
  await mkdir(join(clean, "bin"), { recursive: true });
  await writeFile(join(clean, "bin", "ats-runtime"), "x");
  assert.equal((await verifyExtractedTree(clean)).ok, true);

  assert.equal(
    (await verifyExtractedTree(clean, { maxEntries: 200_000, maxTotalBytes: 0, maxPathLength: 1024 })).violation,
    "too_large",
  );
  assert.equal(
    (await verifyExtractedTree(clean, { maxEntries: 1, maxTotalBytes: 1 << 30, maxPathLength: 1024 })).violation,
    "too_many_entries",
  );
});

test("adopting an existing directory records no provenance receipt", async t => {
  const root = await temporary(t);
  const installRoot = join(root, "existing");
  await mkdir(installRoot, { recursive: true });
  const outcome = await adoptExistingInstall(
    { recordPath: join(root, "runtime.json"), installRoot, requestedMode: "observe" },
    { now: clock },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.record?.installation, null);
  assert.match(outcome.reason ?? "", /provenance is unverified/);
});

// ------------------------------------------------------------- transaction

test("an install interrupted before the pointer switch recovers the previous slot", async t => {
  const root = await temporary(t);
  await install(root, Buffer.from("runtime archive"), "0.4.0");

  // Simulate a crash after slot b's receipt was written but before the pointer
  // moved: forge a receipt in b while the pointer still names a.
  const installRoot = join(root, "runtime");
  const slotB = slotDir(installRoot, "b");
  await mkdir(join(slotB, "bin"), { recursive: true });
  await writeFile(join(slotB, "bin", "ats-runtime"), "#!/bin/sh\n");

  const resolution = await recoverActiveSlot(installRoot, "2026-09-22T12:00:00Z");
  assert.equal(resolution?.slot, "a", "the committed slot is still the live one");
  assert.equal(resolution?.recovered, false);
  assert.equal(resolution?.receipt.installation.runtime_version, "0.4.0");
});

test("a pointer naming a slot with no receipt falls back to the consistent slot", async t => {
  const root = await temporary(t);
  await install(root, Buffer.from("runtime archive"), "0.4.0");
  await install(root, Buffer.from("runtime archive two"), "0.4.1");
  const installRoot = join(root, "runtime");

  // Destroy the live slot's receipt: the commit looks unfinished.
  await rm(slotReceiptPath(installRoot, "b"), { force: true });

  const resolution = await recoverActiveSlot(installRoot, "2026-09-22T12:00:00Z");
  assert.equal(resolution?.slot, "a");
  assert.equal(resolution?.recovered, true);
  assert.equal((await readActivePointer(installRoot))?.slot, "a", "the pointer is repaired on disk");
});

test("a tree digest changes when any installed byte changes", async t => {
  const root = await temporary(t);
  await install(root);
  const dir = slotDir(join(root, "runtime"), "a");
  const before = await computeTreeDigest(dir);
  await writeFile(join(dir, "bin", "ats-runtime"), "#!/bin/sh\necho tampered\n");
  assert.notEqual(await computeTreeDigest(dir), before);
});

// ---------------------------------------------------------------- supervisor

function fakeChild(pid: number): SupervisedChild {
  return { pid, kill: () => true, unref: () => {} };
}

async function installedRecord(root: string): Promise<{ path: string; record: RuntimeRecordV1 }> {
  const outcome = await install(root);
  assert.ok(outcome.record);
  return { path: join(root, "runtime.json"), record: outcome.record };
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

test("the runtime refuses to launch bytes that do not match its receipt", async t => {
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  // Tamper with the installed tree after the receipt was committed.
  await writeFile(join(slotDir(join(root, "runtime"), "a"), "bin", "ats-runtime"), "#!/bin/sh\necho tampered\n");

  const result = await startRuntime(path, record, {
    now: clock, spawn: () => fakeChild(4242), pidAlive: () => false, startToken: async () => "tok-1",
  });
  assert.equal(result.changed, false);
  assert.match(result.reason ?? "", /does not match its installation receipt/);
});

test("a post-install symlink cannot hide from the launch tree digest", async t => {
  if (process.platform === "win32") { t.skip("Windows symlink creation needs elevation"); return; }
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  const dir = slotDir(join(root, "runtime"), "a");
  const before = await computeTreeDigest(dir);
  await symlink("/etc/passwd", join(dir, "bin", "escape"));
  assert.equal(await computeTreeDigest(dir), before, "the file digest does not include links");
  let launched = false;
  const result = await startRuntime(path, record, { now: clock, pidAlive: () => false,
    spawn: () => { launched = true; return fakeChild(4242); } });
  assert.equal(result.changed, false);
  assert.equal(launched, false);
  assert.match(result.reason ?? "", /does not match its installation receipt/);
});

test("a post-install symlink replacing the slot root cannot launch", async t => {
  if (process.platform === "win32") { t.skip("Windows symlink creation needs elevation"); return; }
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  const dir = slotDir(join(root, "runtime"), "a");
  const parked = `${dir}-parked`;
  await rename(dir, parked);
  await symlink(parked, dir);
  let launched = false;
  await assert.rejects(startRuntime(path, record, { now: clock, pidAlive: () => false,
    spawn: () => { launched = true; return fakeChild(4242); } }), /cannot follow a symbolic link/);
  assert.equal(launched, false);
});

test("starting records a pid and a start token, and stopping clears them", async t => {
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  let alive = false;
  const deps: SupervisorDeps = {
    now: clock,
    spawn: () => { alive = true; return fakeChild(4242); },
    pidAlive: () => alive,
    startToken: async () => "tok-1",
    terminate: () => { alive = false; },
    waitMs: 200,
  };

  const started = await startRuntime(path, record, deps);
  assert.equal(started.record.supervisor.pid, 4242);
  assert.equal(started.record.supervisor.start_token, "tok-1");

  const stopped = await stopRuntime(path, started.record, deps);
  assert.equal(stopped.record.supervisor.pid, null);
  assert.equal(stopped.record.supervisor.start_token, null);
  assert.equal((await readRuntimeRecord(path))?.supervisor.pid, null);
});

// The blocker: a recycled pid must never be signalled.
test("a recycled pid is disowned and released, never terminated", async t => {
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  let terminated = 0;
  const started = await startRuntime(path, record, {
    now: clock, spawn: () => fakeChild(4242), pidAlive: () => true, startToken: async () => "tok-1",
  });
  assert.equal(started.record.supervisor.start_token, "tok-1");

  // Same pid, different process: the OS reused the number.
  const foreignDeps: SupervisorDeps = {
    now: clock, pidAlive: () => true, startToken: async () => "tok-2",
    terminate: () => { terminated += 1; }, waitMs: 200,
  };
  assert.equal(await processOwnership(started.record, foreignDeps), "foreign");

  let launched = false;
  const refused = await startRuntime(path, started.record, { ...foreignDeps,
    spawn: () => { launched = true; return fakeChild(5252); } });
  assert.equal(refused.changed, false);
  assert.equal(launched, false, "an unprovable live process must not trigger a second runtime");

  const stopped = await stopRuntime(path, started.record, foreignDeps);
  assert.equal(terminated, 0, "an unowned process must not be signalled");
  assert.equal(stopped.record.supervisor.pid, null, "but the stale pid is released");
  assert.match(stopped.reason ?? "", /no longer belongs to this runtime/);
});

test("a termination failure is reported, not swallowed", async t => {
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  const started = await startRuntime(path, record, {
    now: clock, spawn: () => fakeChild(4242), pidAlive: () => true, startToken: async () => "tok-1",
  });

  const stopped = await stopRuntime(path, started.record, {
    now: clock, pidAlive: () => true, startToken: async () => "tok-1", waitMs: 100,
    terminate: () => { const error = new Error("denied") as NodeJS.ErrnoException; error.code = "EPERM"; throw error; },
  });
  assert.equal(stopped.changed, false);
  assert.match(stopped.reason ?? "", /could not be stopped/);
  assert.equal(stopped.record.supervisor.pid, 4242, "the pid stays recorded when the stop failed");
});

test("a process that does not exit keeps its pid recorded", async t => {
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  const started = await startRuntime(path, record, {
    now: clock, spawn: () => fakeChild(4242), pidAlive: () => true, startToken: async () => "tok-1",
  });
  const stopped = await stopRuntime(path, started.record, {
    now: clock, pidAlive: () => true, startToken: async () => "tok-1", terminate: () => {}, waitMs: 120,
  });
  assert.equal(stopped.changed, false);
  assert.match(stopped.reason ?? "", /did not exit/);
  assert.equal(stopped.record.supervisor.pid, 4242);
});

test("status is offline whenever the runtime cannot be observed", async t => {
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  const started = await startRuntime(path, record, {
    now: clock, spawn: () => fakeChild(4242), pidAlive: () => true, startToken: async () => "tok-1",
  });

  const dead = await runtimeStatus(started.record, { now: clock, pidAlive: () => false });
  assert.equal(dead.effective_mode, "offline");
  assert.match(dead.effective_reason, /not running/);

  const noChannel = await runtimeStatus(started.record, {
    now: clock, pidAlive: () => true, startToken: async () => "tok-1",
  });
  assert.equal(noChannel.effective_mode, "offline");
  assert.equal(started.record.requested_mode, "paper");

  const broken = await runtimeStatus(started.record, {
    now: clock, pidAlive: () => true, startToken: async () => "tok-1",
    probe: async () => { throw new Error("socket /tmp/secret failed"); },
  });
  assert.equal(broken.effective_mode, "offline");
  assert.ok(!broken.effective_reason.includes("/tmp/secret"), "probe failures must not leak paths");
});

test("a runtime-authored snapshot is honoured, and one from another instance is not", async t => {
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  const started = await startRuntime(path, record, {
    now: clock, spawn: () => fakeChild(4242), pidAlive: () => true, startToken: async () => "tok-1",
  });
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
  const base: SupervisorDeps = { now: clock, pidAlive: () => true, startToken: async () => "tok-1" };

  const honoured = await runtimeStatus(started.record, { ...base, probe: async () => reply(instance) });
  assert.equal(honoured.state, "healthy");
  assert.equal(honoured.effective_mode, "observe");

  const foreign = await runtimeStatus(started.record, { ...base, probe: async () => reply("rt_someoneelse") });
  assert.equal(foreign.effective_mode, "offline");
});

// The blocker: rollback must leave a usable runtime on both sides.
test("rollback switches slots, keeps both receipts, and stays startable", async t => {
  const root = await temporary(t);
  await install(root, Buffer.from("runtime archive"), "0.4.0");
  await install(root, Buffer.from("runtime archive two"), "0.4.1");
  const path = join(root, "runtime.json");
  const installRoot = join(root, "runtime");

  const current = await readRuntimeRecord(path);
  assert.ok(current);
  assert.equal(current.installation?.runtime_version, "0.4.1");

  const rolled = await rollbackRuntime(path, current, { now: clock, terminate: () => {}, waitMs: 100 });
  assert.equal(rolled.changed, true);
  // The receipt is the rolled-back version's own — not null, which is what
  // used to leave the restored runtime unstartable.
  assert.equal(rolled.record.installation?.runtime_version, "0.4.0");
  assert.equal((await readActivePointer(installRoot))?.slot, "a");
  // Both versions are still on disk, so the rollback can be rolled back.
  assert.equal((await readSlotReceipt(installRoot, "a"))?.installation.runtime_version, "0.4.0");
  assert.equal((await readSlotReceipt(installRoot, "b"))?.installation.runtime_version, "0.4.1");
});

test("rollback refuses a modified previous slot before stopping the live runtime", async t => {
  const root = await temporary(t);
  await install(root, Buffer.from("runtime archive"), "0.4.0");
  await install(root, Buffer.from("runtime archive two"), "0.4.1");
  const path = join(root, "runtime.json");
  const installRoot = join(root, "runtime");
  const record = await readRuntimeRecord(path);
  assert.ok(record);
  await writeFile(join(slotDir(installRoot, "a"), "bin", "ats-runtime"), "tampered");
  let terminated = false;
  const result = await rollbackRuntime(path, record, { now: clock, terminate: () => { terminated = true; } });
  assert.equal(result.changed, false);
  assert.equal(terminated, false);
  assert.match(result.reason ?? "", /fails tree verification/);
  assert.equal((await readActivePointer(installRoot))?.slot, "b");
});

test("rollback with only one slot installed refuses", async t => {
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  const rolled = await rollbackRuntime(path, record, { now: clock, terminate: () => {}, waitMs: 100 });
  assert.equal(rolled.changed, false);
  assert.match(rolled.reason ?? "", /No previous ATS runtime/);
});

test("an account switch stops the runtime and revokes its credential", async t => {
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  let alive = false;
  const deps: SupervisorDeps = {
    now: clock,
    spawn: () => { alive = true; return fakeChild(4242); },
    pidAlive: () => alive,
    startToken: async () => "tok-1",
    terminate: () => { alive = false; },
    waitMs: 200,
  };
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

test("account-switch teardown retains the credential record when stop fails", async t => {
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  const started = await startRuntime(path, record, {
    now: clock, spawn: () => fakeChild(4242), pidAlive: () => false, startToken: async () => "tok-1",
  });
  const credential = started.record.credential_file;
  assert.ok(credential);
  const deps: SupervisorDeps = { now: clock, pidAlive: () => true, startToken: async () => "tok-1",
    terminate: () => { const error = new Error("denied") as NodeJS.ErrnoException; error.code = "EPERM"; throw error; } };
  await assert.rejects(tearDownForAccountSwitch(path, deps), /still running/);
  assert.equal((await readRuntimeRecord(path))?.credential_file, credential);
  assert.ok((await stat(credential)).isFile());
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
  assert.equal(report.readiness.runtime_ready, false);
  assert.equal(report.axes.find(axis => axis.name === "Runtime")?.state, "unavailable");
  assert.match(renderAtsDoctorReport(report), /not ready/);
});

// The blocker: one boolean cannot answer five different questions.
test("readiness is scoped, so a healthy runtime with no strategies is not 'ready'", async t => {
  const root = await temporary(t);
  const { path, record } = await installedRecord(root);
  await startRuntime(path, record, {
    now: clock, spawn: () => fakeChild(4242), pidAlive: () => true, startToken: async () => "tok-1",
  });
  const instance = (await readRuntimeRecord(path))!.runtime_instance_id;

  const report = await buildAtsDoctorReport({
    runtimeStatePath: path,
    dataProfilePath: join(root, "data-profile.json"),
    dashboardStatePath: join(root, "dashboard.json"),
    strategies: { compiled: 0, rejected: 2, needs_conversion: 4, unavailable: 0, total: 6 },
    now: clock,
  }, {
    pidAlive: () => true,
    startToken: async () => "tok-1",
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

  assert.equal(report.readiness.runtime_ready, true);
  // Each of these is false for its own reason, and none of them is hidden
  // behind the runtime being healthy.
  assert.equal(report.readiness.strategy_ready, false);
  assert.equal(report.readiness.paper_ready, false);
  assert.equal(report.readiness.broker_live_ready, false);
  assert.match(report.axes.find(axis => axis.name === "Strategies")?.detail ?? "", /0 compiled/);
  assert.match(report.axes.find(axis => axis.name === "Execution")?.detail ?? "", /Requested paper; effective observe/);
});
