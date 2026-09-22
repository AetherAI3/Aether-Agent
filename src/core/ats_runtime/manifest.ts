// Spec 2 step 2 — resolving and VERIFYING an entitled runtime manifest.
//
// The normal installation path must, in order:
//
//   1. resolve an account-entitled runtime manifest,
//   2. verify platform, version, compatibility range, archive digest,
//      manifest digest, and signature,
//   3. only then install.
//
// This module is step 2 in full. It deliberately performs no network I/O and
// no filesystem writes: it takes bytes someone else fetched and answers
// whether they may be trusted. That separation is what makes the security
// decision testable without a network, and it means a caller cannot
// accidentally install first and verify afterwards — there is nothing here
// that can install.
//
// TRUST ANCHORS. There is no baked-in public key. Anchors are supplied by the
// caller, and with none configured verification REFUSES rather than degrading
// to "the digest is fine, skip the signature". A digest proves the bytes match
// the manifest; only a signature proves the manifest came from Aether.
// Treating a self-consistent unsigned manifest as good enough would accept an
// attacker's manifest describing an attacker's archive.

import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";
import {
  choice,
  closed,
  fail,
  hex64,
  ident,
  integer,
  list,
  schemaTag,
  timestamp,
  version as versionString,
} from "../ats_contracts/primitives.js";
import { canonicalJson, digestOf } from "../ats_contracts/canonical.js";
import {
  currentPlatform,
  platformToken,
  RUNTIME_INSTALLATION_SCHEMA,
  validateRuntimeInstallationReceipt,
  type RuntimeComponentVersionsV1,
  type RuntimeInstallationReceiptV1,
} from "../ats_contracts/runtime.js";

export const RUNTIME_MANIFEST_SCHEMA = "aether.ats.runtime-manifest/1" as const;

export interface RuntimeArtifactEntryV1 {
  readonly platform: string;
  readonly artifact_sha256: string;
  readonly size_bytes: number;
  readonly python_version: string;
  readonly component_versions: RuntimeComponentVersionsV1;
}

export interface RuntimeManifestV1 {
  readonly schema_version: typeof RUNTIME_MANIFEST_SCHEMA;
  readonly runtime_version: string;
  readonly agent_compatibility: { readonly min: string; readonly max: string };
  readonly issued_at: string;
  readonly expires_at: string;
  readonly artifacts: readonly RuntimeArtifactEntryV1[];
}

const MANIFEST_FIELDS = [
  "schema_version", "runtime_version", "agent_compatibility", "issued_at", "expires_at", "artifacts",
] as const;
const COMPAT_FIELDS = ["min", "max"] as const;
const ARTIFACT_FIELDS = [
  "platform", "artifact_sha256", "size_bytes", "python_version", "component_versions",
] as const;
const COMPONENT_FIELDS = ["llmre", "features", "ats_mcp"] as const;

/**
 * Compare dotted numeric versions. Only the numeric prefix is compared; a
 * trailing pre-release tag is ignored for ordering, which is intentional: a
 * compatibility WINDOW is about API shape, and refusing `0.4.0-rc.1` inside a
 * `0.4.0`–`0.5.0` window would block the very builds the window exists to
 * qualify. Returns -1, 0 or 1.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string): number[] =>
    (value.split("-", 1)[0] ?? "").split(".").map(piece => {
      const parsed = Number.parseInt(piece, 10);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    });
  const left = parts(a);
  const right = parts(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

function componentVersions(value: unknown, name: string): RuntimeComponentVersionsV1 {
  const raw = closed(value, name, COMPONENT_FIELDS);
  return Object.freeze({
    llmre: versionString(raw.llmre, `${name} llmre version`),
    features: versionString(raw.features, `${name} feature service version`),
    ats_mcp: versionString(raw.ats_mcp, `${name} ATS MCP version`),
  });
}

function artifactEntry(value: unknown, name: string): RuntimeArtifactEntryV1 {
  const raw = closed(value, name, ARTIFACT_FIELDS);
  return Object.freeze({
    platform: platformToken(raw.platform, `${name} platform`),
    artifact_sha256: hex64(raw.artifact_sha256, `${name} artifact digest`),
    // A declared size bounds the download before a byte is read, so a
    // manifest cannot point at an archive that fills the disk.
    size_bytes: integer(raw.size_bytes, `${name} size`, 1, 2 * 1024 ** 3),
    python_version: versionString(raw.python_version, `${name} python version`),
    component_versions: componentVersions(raw.component_versions, `${name} component versions`),
  });
}

export function validateRuntimeManifest(value: unknown, name = "Runtime manifest"): RuntimeManifestV1 {
  const raw = closed(value, name, MANIFEST_FIELDS);
  const compat = closed(raw.agent_compatibility, `${name} compatibility`, COMPAT_FIELDS);
  const min = versionString(compat.min, `${name} minimum agent version`);
  const max = versionString(compat.max, `${name} maximum agent version`);
  if (compareVersions(min, max) > 0) fail(`${name} compatibility range is inverted.`);

  const issuedAt = timestamp(raw.issued_at, `${name} issued at`);
  const expiresAt = timestamp(raw.expires_at, `${name} expires at`);
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) fail(`${name} must expire after it was issued.`);

  const artifacts = list(raw.artifacts, `${name} artifacts`, 32, artifactEntry);
  if (!artifacts.length) fail(`${name} lists no artifacts.`);
  // One entry per platform. Two entries for win32-x64 would make selection
  // order-dependent, and "whichever came first" is not a security decision.
  const platforms = new Set(artifacts.map(entry => entry.platform));
  if (platforms.size !== artifacts.length) fail(`${name} lists a platform more than once.`);

  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, RUNTIME_MANIFEST_SCHEMA, name) as typeof RUNTIME_MANIFEST_SCHEMA,
    runtime_version: versionString(raw.runtime_version, `${name} runtime version`),
    agent_compatibility: Object.freeze({ min, max }),
    issued_at: issuedAt,
    expires_at: expiresAt,
    artifacts: Object.freeze(artifacts),
  });
}

/**
 * The exact bytes a manifest signature covers: the shared canonical encoding,
 * not the received text. Two byte sequences that parse to the same document
 * must verify identically, or a whitespace change between the signer and the
 * reader breaks every install.
 */
export function canonicalManifestBytes(manifest: RuntimeManifestV1): string {
  return canonicalJson(manifest as unknown);
}

/** The manifest digest a receipt binds to, as bare hex. */
export function manifestDigestHex(manifest: RuntimeManifestV1): string {
  return digestOf(manifest as unknown as Record<string, unknown>).replace(/^sha256:/, "");
}

export interface RuntimeTrustAnchor {
  readonly key_id: string;
  /** Ed25519 public key, SPKI DER, base64. Public material only. */
  readonly public_key_spki_base64: string;
}

const ANCHOR_FIELDS = ["key_id", "public_key_spki_base64"] as const;

export function validateTrustAnchor(value: unknown, name = "Runtime trust anchor"): RuntimeTrustAnchor {
  const raw = closed(value, name, ANCHOR_FIELDS);
  const encoded = raw.public_key_spki_base64;
  if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]{32,512}={0,2}$/.test(encoded)) {
    fail(`${name} must carry a base64 SPKI public key.`);
  }
  return Object.freeze({
    key_id: ident(raw.key_id, `${name} key id`),
    public_key_spki_base64: encoded,
  });
}

export type VerificationFailure =
  | "no_trust_anchor"
  | "bad_signature"
  | "manifest_expired"
  | "agent_incompatible"
  | "platform_unsupported"
  | "digest_mismatch"
  | "size_mismatch";

export interface ManifestVerdict {
  readonly ok: boolean;
  readonly failure: VerificationFailure | null;
  /** Operator-readable, bounded, and free of URLs or key material. */
  readonly reason: string | null;
  readonly key_id: string | null;
  readonly artifact: RuntimeArtifactEntryV1 | null;
}

function refuse(failure: VerificationFailure, reason: string): ManifestVerdict {
  return { ok: false, failure, reason, key_id: null, artifact: null };
}

/**
 * Verify a detached Ed25519 signature over the manifest's canonical bytes.
 * A malformed anchor is skipped rather than aborting the loop: one bad entry
 * in a rotation set must not disable the good ones.
 */
export function verifyManifestSignature(
  manifest: RuntimeManifestV1,
  signatureBase64: string,
  anchors: readonly RuntimeTrustAnchor[],
): { verified: boolean; keyId: string | null } {
  if (!anchors.length) return { verified: false, keyId: null };
  const signature = Buffer.from(signatureBase64, "base64");
  if (signature.length !== 64) return { verified: false, keyId: null };
  const message = Buffer.from(canonicalManifestBytes(manifest), "utf8");

  for (const anchor of anchors) {
    try {
      const key = createPublicKey({
        key: Buffer.from(anchor.public_key_spki_base64, "base64"),
        format: "der",
        type: "spki",
      });
      if (verifyEd25519(null, message, key, signature)) return { verified: true, keyId: anchor.key_id };
    } catch {
      continue;
    }
  }
  return { verified: false, keyId: null };
}

export interface ManifestVerificationInput {
  readonly manifest: RuntimeManifestV1;
  readonly signatureBase64: string;
  readonly anchors: readonly RuntimeTrustAnchor[];
  readonly agentVersion: string;
  readonly platform?: string;
  readonly now: number;
}

/**
 * Run every check Spec 2 step 2.2 requires. The signature is checked BEFORE
 * anything is read out of the manifest and acted on, because an unsigned
 * manifest's compatibility range and digests are attacker-chosen values, and
 * deciding anything from them is already too late.
 */
export function verifyManifest(input: ManifestVerificationInput): ManifestVerdict {
  if (!input.anchors.length) {
    return refuse(
      "no_trust_anchor",
      "No ATS runtime trust anchor is configured, so the manifest signature cannot be verified.",
    );
  }
  const signature = verifyManifestSignature(input.manifest, input.signatureBase64, input.anchors);
  if (!signature.verified) {
    return refuse("bad_signature", "The runtime manifest signature did not verify against a configured trust anchor.");
  }
  if (Date.parse(input.manifest.expires_at) <= input.now) {
    return refuse("manifest_expired", "The runtime manifest has expired. Resolve a current one.");
  }

  const compat = input.manifest.agent_compatibility;
  if (compareVersions(input.agentVersion, compat.min) < 0 || compareVersions(input.agentVersion, compat.max) > 0) {
    return refuse("agent_incompatible", "This Agent build is outside the runtime's supported compatibility range.");
  }

  const platform = input.platform ?? currentPlatform();
  const artifact = input.manifest.artifacts.find(entry => entry.platform === platform);
  if (!artifact) {
    return refuse("platform_unsupported", "The runtime manifest has no artifact for this platform.");
  }

  return { ok: true, failure: null, reason: null, key_id: signature.keyId, artifact };
}

/**
 * Verify downloaded bytes against the entry the manifest committed to. Size is
 * checked first so a mismatched length is reported as itself rather than as a
 * confusing digest failure.
 */
export function verifyArchive(bytes: Uint8Array, artifact: RuntimeArtifactEntryV1): ManifestVerdict {
  if (bytes.byteLength !== artifact.size_bytes) {
    return refuse("size_mismatch", "The downloaded runtime archive is not the size the manifest declared.");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.artifact_sha256) {
    return refuse("digest_mismatch", "The downloaded runtime archive does not match its manifest digest.");
  }
  return { ok: true, failure: null, reason: null, key_id: null, artifact };
}

/**
 * Build the installation receipt. This is intentionally the ONLY constructor,
 * and it takes the verdicts rather than booleans so a caller cannot assert
 * provenance it never established. `provenance_verified` is pinned true by the
 * contract, so a refused verdict throws here instead of producing a receipt
 * that lies.
 */
export function installationReceiptFrom(input: {
  manifestVerdict: ManifestVerdict;
  archiveVerdict: ManifestVerdict;
  manifest: RuntimeManifestV1;
  installationId: string;
  installedAt: string;
}): RuntimeInstallationReceiptV1 {
  if (!input.manifestVerdict.ok || !input.archiveVerdict.ok) {
    fail("A runtime installation receipt cannot be written for an unverified runtime.");
  }
  const artifact = input.manifestVerdict.artifact;
  if (!artifact) fail("A verified manifest verdict must name an artifact.");
  return validateRuntimeInstallationReceipt({
    schema_version: RUNTIME_INSTALLATION_SCHEMA,
    installation_id: input.installationId,
    runtime_version: input.manifest.runtime_version,
    artifact_sha256: artifact.artifact_sha256,
    manifest_sha256: manifestDigestHex(input.manifest),
    platform: artifact.platform,
    python_version: artifact.python_version,
    component_versions: { ...artifact.component_versions },
    installed_at: input.installedAt,
    provenance_verified: true,
  });
}

/**
 * How a caller obtains a manifest. Injected rather than hard-wired so the
 * verification pipeline above is testable without a network, and so the
 * account-entitlement transport can land separately without reopening this
 * file. An implementation returns the manifest document and its detached
 * signature exactly as served.
 */
export interface EntitledManifestSource {
  resolve(input: { agentVersion: string; platform: string; signal?: AbortSignal }): Promise<{
    manifest: unknown;
    signatureBase64: string;
    anchors: readonly unknown[];
  }>;
}

export const RUNTIME_ENTITLEMENT_UNAVAILABLE =
  "No entitled ATS runtime source is configured for this account on this device.";

/**
 * The default source: none. Spec 2 step 2 says the public Agent package must
 * not embed or republish private ATS engine source, so there is no bundled
 * archive and no default endpoint baked in here. Until an entitlement source
 * is wired in, `aether ats runtime install` reports honestly that no runtime is
 * available rather than pretending to install one.
 */
export function unavailableManifestSource(): EntitledManifestSource {
  return {
    resolve: async () => {
      throw new Error(RUNTIME_ENTITLEMENT_UNAVAILABLE);
    },
  };
}

/** Parse whatever a source returned, refusing anything malformed. */
export function readManifestResponse(response: {
  manifest: unknown;
  signatureBase64: string;
  anchors: readonly unknown[];
}): { manifest: RuntimeManifestV1; signatureBase64: string; anchors: RuntimeTrustAnchor[] } {
  if (typeof response.signatureBase64 !== "string" || response.signatureBase64.length > 512) {
    fail("The runtime manifest signature is malformed.");
  }
  return {
    manifest: validateRuntimeManifest(response.manifest),
    signatureBase64: response.signatureBase64,
    anchors: list(response.anchors, "Runtime trust anchors", 8, validateTrustAnchor),
  };
}

/** Narrow a caller-supplied platform token, defaulting to this process's own. */
export function resolvePlatform(value?: string): string {
  return value === undefined ? currentPlatform() : platformToken(value, "Runtime platform");
}

/** Exported for the doctor's compatibility axis. */
export function agentWithinCompatibility(manifest: RuntimeManifestV1, agentVersion: string): boolean {
  return compareVersions(agentVersion, manifest.agent_compatibility.min) >= 0
    && compareVersions(agentVersion, manifest.agent_compatibility.max) <= 0;
}

export const VERIFICATION_FAILURES: readonly VerificationFailure[] = [
  "no_trust_anchor", "bad_signature", "manifest_expired",
  "agent_incompatible", "platform_unsupported", "digest_mismatch", "size_mismatch",
];

/** Kept for symmetry with the contract validators. */
export function verificationFailure(value: unknown, name: string): VerificationFailure {
  return choice(value, VERIFICATION_FAILURES, name);
}
