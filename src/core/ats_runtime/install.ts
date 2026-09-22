// Spec 2 step 2 — the installation orchestration.
//
// manifest.ts decides whether bytes may be trusted and cannot touch the disk.
// This module is the other half: it fetches, hands everything to that verifier,
// and only then writes. The ordering is the security property, so it is worth
// stating plainly:
//
//   resolve manifest -> verify signature/expiry/compat/platform
//   -> fetch archive -> verify size + digest
//   -> stage into a scratch directory
//   -> park any existing install as runtime.previous
//   -> swap the staged directory into place
//   -> provision the credential
//   -> commit the receipt
//
// Nothing before the final commit mutates the live install, so an interruption
// at any point leaves either the previous runtime or no runtime — never a
// half-installed one. That is section 17's interrupted-installation canary:
// "Process termination resumes or rolls back without adopting partial runtime."

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  installationReceiptFrom,
  readManifestResponse,
  resolvePlatform,
  unavailableManifestSource,
  verifyArchive,
  verifyManifest,
  type EntitledManifestSource,
  type ManifestVerdict,
} from "./manifest.js";
import { refuseSymlinkedPath } from "./paths.js";
import { emptyRuntimeRecord, writeRuntimeRecord, type RuntimeRecordV1 } from "./store.js";
import { newRuntimeInstanceId, provisionRuntimeCredential } from "./supervisor.js";
import type { RequestedExecutionMode } from "../ats_contracts/mode.js";

/** Fetch the archive the manifest committed to. Injected; no default network. */
export interface ArchiveFetcher {
  fetch(input: { artifactSha256: string; sizeBytes: number; signal?: AbortSignal }): Promise<Uint8Array>;
}

/** Unpack verified bytes into a staging directory. Injected; no default format. */
export interface ArchiveExtractor {
  extract(input: { bytes: Uint8Array; destination: string }): Promise<void>;
}

export interface InstallDeps {
  source?: EntitledManifestSource;
  fetcher?: ArchiveFetcher;
  extractor?: ArchiveExtractor;
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
  readonly installDir: string;
  readonly previousDir: string;
  readonly agentVersion: string;
  readonly requestedMode: RequestedExecutionMode;
  readonly platform?: string;
  readonly signal?: AbortSignal;
}

/**
 * Install an entitled ATS runtime.
 *
 * Returns an outcome rather than throwing for EXPECTED refusals — no
 * entitlement, a bad signature, an incompatible build — because those are
 * things an operator needs printed, not a stack trace. Genuine faults
 * (an unwritable disk) still throw.
 */
export async function installRuntime(input: InstallInput, deps: InstallDeps = {}): Promise<InstallOutcome> {
  const source = deps.source ?? unavailableManifestSource();
  const platform = resolvePlatform(input.platform);

  let response: { manifest: unknown; signatureBase64: string; anchors: readonly unknown[] };
  try {
    response = await source.resolve({
      agentVersion: input.agentVersion,
      platform,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    // An unresolvable entitlement is the normal state of a build with no
    // configured source. It is reported as itself rather than dressed up as a
    // verification failure.
    return failed("entitlement_unavailable", error instanceof Error ? error.message : RUNTIME_INSTALLER_UNAVAILABLE);
  }

  const parsed = readManifestResponse(response);
  const manifestVerdict = verifyManifest({
    manifest: parsed.manifest,
    signatureBase64: parsed.signatureBase64,
    anchors: parsed.anchors,
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

  // Everything above this line is verification. Everything below writes.
  await refuseSymlinkedPath(input.installDir);
  await refuseSymlinkedPath(input.previousDir);

  const staging = join(dirname(input.installDir), `runtime.staging-${randomUUID()}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await deps.extractor.extract({ bytes, destination: staging });

    // Park the current install so a rollback has somewhere to come from. The
    // previous `runtime.previous` is dropped only now, once the new tree is
    // already staged and verified — keeping two known-good versions through
    // the whole risky window.
    if (await exists(input.installDir)) {
      await rm(input.previousDir, { recursive: true, force: true });
      await rename(input.installDir, input.previousDir);
    }
    await rename(staging, input.installDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const credentialFile = await provisionRuntimeCredential(input.installDir);
  const installedAt = stamp(deps);
  const receipt = installationReceiptFrom({
    manifestVerdict,
    archiveVerdict,
    manifest: parsed.manifest,
    installationId: `inst_${randomUUID().replace(/-/g, "")}`,
    installedAt,
  });

  const record: RuntimeRecordV1 = {
    ...emptyRuntimeRecord({
      runtimeInstanceId: newRuntimeInstanceId(),
      installDir: input.installDir,
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
  input: { recordPath: string; installDir: string; requestedMode: RequestedExecutionMode },
  deps: InstallDeps = {},
): Promise<InstallOutcome> {
  await refuseSymlinkedPath(input.installDir);
  if (!(await exists(input.installDir))) {
    return failed("missing_install", "That directory does not contain an ATS runtime.");
  }
  const record = emptyRuntimeRecord({
    runtimeInstanceId: newRuntimeInstanceId(),
    installDir: input.installDir,
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
