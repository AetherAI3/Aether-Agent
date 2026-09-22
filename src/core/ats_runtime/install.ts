// Spec 2 step 2 — the installation transaction.
//
// manifest.ts decides whether bytes may be trusted and cannot touch the disk.
// This module is the other half. The ordering IS the security property:
//
//   resolve manifest        (from the entitled source)
//   -> verify signature     (against anchors from an INDEPENDENT channel)
//      expiry, compatibility, platform
//   -> fetch archive -> verify size + digest
//   -> clear the INACTIVE slot and extract into it
//   -> verify the extracted tree (no escapes, links, devices, overruns)
//   -> hash the tree, write and fsync that slot's receipt
//   -> switch the active pointer            <-- the commit
//   -> provision the credential, record runtime.json
//
// Nothing before the pointer switch is visible to a launch, and nothing after
// it destroys the previous installation: the other slot stays intact, which is
// what makes rollback a pointer switch rather than a restore. An interruption
// at any point leaves either the previous runtime or the previous runtime —
// never a half-installed one.
//
// TRUST ANCHORS DO NOT COME FROM THE SOURCE. An earlier revision took them
// from the same response as the manifest, which made the signature check
// circular: a compromised source could mint a key, sign its own manifest, and
// hand back the matching anchor. They now arrive through
// `RuntimeTrustAnchorProvider`, whose production implementation is pinned
// build configuration.

import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { DEFAULT_ARCHIVE_LIMITS, verifyExtractedTree, type ArchiveLimits } from "./archive_guard.js";
import {
  installationReceiptFrom,
  pinnedTrustAnchorProvider,
  readManifestResponse,
  resolvePlatform,
  unavailableManifestSource,
  verifyArchive,
  verifyManifest,
  type EntitledManifestSource,
  type ManifestVerdict,
  type RuntimeTrustAnchorProvider,
} from "./manifest.js";
import { refuseSymlinkedPath } from "./paths.js";
import {
  ACTIVE_POINTER_SCHEMA,
  SLOT_RECEIPT_SCHEMA,
  clearSlot,
  computeTreeDigest,
  otherSlot,
  readActivePointer,
  slotDir,
  switchActiveSlot,
  writeSlotReceipt,
  type SlotName,
} from "./slots.js";
import { emptyRuntimeRecord, writeRuntimeRecord, type RuntimeRecordV1 } from "./store.js";
import { newRuntimeInstanceId, provisionRuntimeCredential } from "./supervisor.js";
import type { RequestedExecutionMode } from "../ats_contracts/mode.js";

/** Fetch the archive the manifest committed to. Injected; no default network. */
export interface ArchiveFetcher {
  fetch(input: { artifactSha256: string; sizeBytes: number; signal?: AbortSignal }): Promise<Uint8Array>;
}

/**
 * Unpack verified bytes into a staging slot. Injected; no default format.
 * An implementation MUST confine every write to destination and enforce entry
 * and byte limits before or during extraction. The post-extraction tree walk
 * checks what remains inside the slot; it cannot undo an extractor's write
 * outside the slot or resource exhaustion that occurred during extraction.
 * No production extractor is provided by this PR.
 */
export interface ArchiveExtractor {
  extract(input: { bytes: Uint8Array; destination: string }): Promise<void>;
}

export interface InstallDeps {
  source?: EntitledManifestSource;
  /** Verifying keys, from a channel the manifest source does not control. */
  trustAnchors?: RuntimeTrustAnchorProvider;
  fetcher?: ArchiveFetcher;
  extractor?: ArchiveExtractor;
  limits?: ArchiveLimits;
  now?: () => Date;
}

export interface InstallOutcome {
  readonly ok: boolean;
  readonly record: RuntimeRecordV1 | null;
  /** Bounded, path-free, safe to print and to persist. */
  readonly reason: string | null;
  readonly failure: string | null;
}

export const RUNTIME_INSTALLER_UNAVAILABLE =
  "This Agent build has no ATS runtime installer transport configured.";

function stamp(deps: InstallDeps): string {
  return (deps.now ? deps.now() : new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function failed(failure: string, reason: string): InstallOutcome {
  return { ok: false, record: null, reason, failure };
}

export interface InstallInput {
  readonly recordPath: string;
  /** The install ROOT. Holds active.json and slots/, not the runtime tree itself. */
  readonly installRoot: string;
  readonly agentVersion: string;
  readonly requestedMode: RequestedExecutionMode;
  readonly platform?: string;
  readonly signal?: AbortSignal;
}

/**
 * Install an entitled ATS runtime.
 *
 * Returns an outcome rather than throwing for EXPECTED refusals — no
 * entitlement, no trust anchor, a bad signature, an incompatible build, a
 * hostile archive — because those are things an operator needs printed, not a
 * stack trace. Genuine faults (an unwritable disk) still throw.
 */
export async function installRuntime(input: InstallInput, deps: InstallDeps = {}): Promise<InstallOutcome> {
  const source = deps.source ?? unavailableManifestSource();
  const trust = deps.trustAnchors ?? pinnedTrustAnchorProvider();
  const platform = resolvePlatform(input.platform);

  let response: { manifest: unknown; signatureBase64: string };
  try {
    response = await source.resolve({
      agentVersion: input.agentVersion,
      platform,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch {
    // An unresolvable entitlement is the normal state of a build with no
    // configured source, and is reported as itself rather than dressed up as
    // a verification failure. Transport exceptions may embed tokens or URLs.
    return failed("entitlement_unavailable", "ATS runtime entitlement is unavailable. Check the signed-in account and installer configuration.");
  }

  const parsed = readManifestResponse(response);
  const manifestVerdict = verifyManifest({
    manifest: parsed.manifest,
    signatureBase64: parsed.signatureBase64,
    anchors: trust.anchors(),
    agentVersion: input.agentVersion,
    platform,
    now: Date.parse(stamp(deps)),
  });
  if (!manifestVerdict.ok || !manifestVerdict.artifact) {
    return failed(manifestVerdict.failure ?? "unverified", manifestVerdict.reason ?? "The runtime manifest was refused.");
  }

  if (!deps.fetcher || !deps.extractor) {
    return failed("installer_unavailable", RUNTIME_INSTALLER_UNAVAILABLE);
  }

  const artifact = manifestVerdict.artifact;
  const bytes = await deps.fetcher.fetch({
    artifactSha256: artifact.artifact_sha256,
    sizeBytes: artifact.size_bytes,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const archiveVerdict: ManifestVerdict = verifyArchive(bytes, artifact);
  if (!archiveVerdict.ok) {
    return failed(archiveVerdict.failure ?? "unverified", archiveVerdict.reason ?? "The runtime archive was refused.");
  }

  // ---- everything above is verification; everything below writes ----

  await refuseSymlinkedPath(input.installRoot);
  await mkdir(input.installRoot, { recursive: true, mode: 0o700 });

  // Install into whichever slot is NOT live, so the running one is untouched.
  const current = await readActivePointer(input.installRoot);
  const target: SlotName = current ? otherSlot(current.slot) : "a";
  const targetDir = slotDir(input.installRoot, target);

  await clearSlot(input.installRoot, target);
  await mkdir(targetDir, { recursive: true, mode: 0o700 });

  try {
    await deps.extractor.extract({ bytes, destination: targetDir });
  } catch (error) {
    await clearSlot(input.installRoot, target).catch(() => {});
    throw error;
  }

  const treeVerdict = await verifyExtractedTree(targetDir, deps.limits ?? DEFAULT_ARCHIVE_LIMITS);
  if (!treeVerdict.ok) {
    // A hostile or malformed archive never reaches a receipt, and its bytes do
    // not linger on disk for a later step to trip over.
    await clearSlot(input.installRoot, target).catch(() => {});
    return failed(treeVerdict.violation ?? "unsafe_archive", treeVerdict.detail ?? "The runtime archive was refused.");
  }

  const installedAt = stamp(deps);
  const receipt = installationReceiptFrom({
    manifestVerdict,
    archiveVerdict,
    manifest: parsed.manifest,
    installationId: `inst_${randomUUID().replace(/-/g, "")}`,
    installedAt,
  });
  const treeDigest = await computeTreeDigest(targetDir);

  // Receipt first, pointer second. If the process dies between them, the
  // pointer still names the old slot and recovery finds it consistent.
  await writeSlotReceipt(input.installRoot, {
    schema_version: SLOT_RECEIPT_SCHEMA,
    slot: target,
    installation: receipt,
    tree_sha256: treeDigest,
    committed_at: installedAt,
  });
  await switchActiveSlot(input.installRoot, {
    schema_version: ACTIVE_POINTER_SCHEMA,
    slot: target,
    installation_id: receipt.installation_id,
    tree_sha256: treeDigest,
    switched_at: installedAt,
  });

  // The credential lives at the ROOT, not inside a slot, so a rollback or a
  // reinstall does not revoke a credential the runtime is still using.
  const credentialFile = await provisionRuntimeCredential(input.installRoot);

  const record: RuntimeRecordV1 = {
    ...emptyRuntimeRecord({
      runtimeInstanceId: newRuntimeInstanceId(),
      installDir: input.installRoot,
      requestedMode: input.requestedMode,
      updatedAt: installedAt,
    }),
    installation: receipt,
    credential_file: credentialFile,
  };
  await writeRuntimeRecord(input.recordPath, record);
  return { ok: true, record, reason: null, failure: null };
}

/**
 * Adopt an installation that is already on disk (`Use an existing verified
 * installation` in step 2).
 *
 * This deliberately does NOT write a receipt. A directory an operator points
 * at has no proven provenance — no manifest, no signature, no digest — and
 * `provenance_verified` is pinned true, so fabricating a receipt for it is
 * exactly the lie the contract exists to prevent. The runtime is recorded with
 * `installation: null`, which leaves it unstartable until a verified install
 * happens, and the caller is told so plainly.
 */
export async function adoptExistingInstall(
  input: { recordPath: string; installRoot: string; requestedMode: RequestedExecutionMode },
  deps: InstallDeps = {},
): Promise<InstallOutcome> {
  await refuseSymlinkedPath(input.installRoot);
  if (!(await exists(input.installRoot))) {
    return failed("missing_install", "That directory does not contain an ATS runtime.");
  }
  const record = emptyRuntimeRecord({
    runtimeInstanceId: newRuntimeInstanceId(),
    installDir: input.installRoot,
    requestedMode: input.requestedMode,
    updatedAt: stamp(deps),
  });
  await writeRuntimeRecord(input.recordPath, record);
  return {
    ok: true,
    record,
    reason: "Recorded an existing installation. Its provenance is unverified, so it cannot be started until a verified install runs.",
    failure: null,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Remove an install root entirely. Used by tests and by teardown. */
export async function removeInstallRoot(installRoot: string): Promise<void> {
  await rm(installRoot, { recursive: true, force: true });
}
