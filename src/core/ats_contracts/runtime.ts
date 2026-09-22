// Spec 2 section 7 — headless ATS runtime contracts.
//
// Two documents live here and they answer different questions:
//
//   RuntimeInstallationReceiptV1  — what was installed, and was its provenance
//                                   actually proven? Written once, at install.
//   RuntimeCapabilitySnapshotV1   — what is the runtime doing RIGHT NOW, and
//                                   what authority does it currently honour?
//                                   Observed, never remembered.
//
// Keeping them apart is the point. An installation receipt is durable evidence
// about bytes on disk; a capability snapshot is a perishable observation about
// a running process. Collapsing them would let a months-old "healthy" survive a
// crash, which is exactly the stale-truth failure Spec 2 section 8 forbids for
// data and section 17 canaries for the runtime.

import {
  bool,
  choice,
  closed,
  fail,
  hex64,
  ident,
  pinned,
  schemaTag,
  text,
  timestamp,
  version,
} from "./primitives.js";
import {
  EFFECTIVE_EXECUTION_MODES,
  REQUESTED_EXECUTION_MODES,
  withinRequestedAuthority,
  type EffectiveExecutionMode,
  type RequestedExecutionMode,
} from "./mode.js";

export const RUNTIME_INSTALLATION_SCHEMA = "aether.ats.runtime-installation/1" as const;
export const RUNTIME_CAPABILITIES_SCHEMA = "aether.ats.runtime-capabilities/1" as const;

/**
 * Platform token, `<os>-<arch>`, matching Node's `process.platform` and
 * `process.arch` spellings. A manifest entry is selected by exact equality
 * against this, so a loose string would let a darwin-arm64 archive install on
 * win32-x64 and fail at first launch instead of at verification.
 */
const PLATFORM = /^(?:aix|darwin|freebsd|linux|openbsd|sunos|win32)-(?:arm|arm64|ia32|x64|ppc64|s390x)$/;

export function platformToken(value: unknown, name: string): string {
  if (typeof value !== "string" || !PLATFORM.test(value)) fail(`${name} must be an <os>-<arch> platform token.`);
  return value;
}

/** This process's own platform token, for manifest selection and receipt writing. */
export function currentPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * The three components Spec 2 step 2.6 requires Agent to verify before it may
 * commit an installation receipt. They are named explicitly rather than held in
 * an open map so a runtime that stops shipping one cannot quietly pass
 * verification by omitting it.
 */
export interface RuntimeComponentVersionsV1 {
  readonly llmre: string;
  readonly features: string;
  readonly ats_mcp: string;
}

export interface RuntimeInstallationReceiptV1 {
  readonly schema_version: typeof RUNTIME_INSTALLATION_SCHEMA;
  readonly installation_id: string;
  readonly runtime_version: string;
  readonly artifact_sha256: string;
  readonly manifest_sha256: string;
  readonly platform: string;
  readonly python_version: string;
  readonly component_versions: RuntimeComponentVersionsV1;
  readonly installed_at: string;
  /**
   * Pinned `true`. Spec 2 step 2 admits exactly one installation path and it
   * verifies platform, version, compatibility range, archive digest, manifest
   * digest and signature before anything is committed. There is therefore no
   * such thing as an installation receipt with unproven provenance: a failed
   * verification produces no receipt at all, not a receipt saying `false`.
   * Pinning the field makes "write the receipt anyway, mark it unverified" a
   * type error rather than a judgement call at a call site.
   */
  readonly provenance_verified: true;
}

const INSTALLATION_FIELDS = [
  "schema_version", "installation_id", "runtime_version", "artifact_sha256", "manifest_sha256",
  "platform", "python_version", "component_versions", "installed_at", "provenance_verified",
] as const;

const COMPONENT_FIELDS = ["llmre", "features", "ats_mcp"] as const;

function componentVersions(value: unknown, name: string): RuntimeComponentVersionsV1 {
  const raw = closed(value, name, COMPONENT_FIELDS);
  return Object.freeze({
    llmre: version(raw.llmre, `${name} llmre version`),
    features: version(raw.features, `${name} feature service version`),
    ats_mcp: version(raw.ats_mcp, `${name} ATS MCP version`),
  });
}

export function validateRuntimeInstallationReceipt(
  value: unknown,
  name = "Runtime installation receipt",
): RuntimeInstallationReceiptV1 {
  const raw = closed(value, name, INSTALLATION_FIELDS);
  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, RUNTIME_INSTALLATION_SCHEMA, name) as typeof RUNTIME_INSTALLATION_SCHEMA,
    installation_id: ident(raw.installation_id, `${name} installation id`),
    runtime_version: version(raw.runtime_version, `${name} runtime version`),
    artifact_sha256: hex64(raw.artifact_sha256, `${name} artifact digest`),
    manifest_sha256: hex64(raw.manifest_sha256, `${name} manifest digest`),
    platform: platformToken(raw.platform, `${name} platform`),
    python_version: version(raw.python_version, `${name} python version`),
    component_versions: componentVersions(raw.component_versions, `${name} component versions`),
    installed_at: timestamp(raw.installed_at, `${name} installed at`),
    provenance_verified: pinned(raw.provenance_verified, true, `${name} provenance`),
  });
}

export const RUNTIME_STATES = ["starting", "healthy", "degraded", "stopped", "failed"] as const;
export type RuntimeState = (typeof RUNTIME_STATES)[number];

/**
 * Capability flags. Every one defaults to absent at the call sites that build a
 * snapshot from a runtime reply: an unadvertised capability is unavailable, so
 * a runtime that answers a probe with silence cannot be read as capable.
 */
export const RUNTIME_CAPABILITY_KEYS = [
  "status", "market_data", "nano_compile", "nano_activation", "trade_ledger", "journal", "paper_controller",
] as const;
export type RuntimeCapabilityKey = (typeof RUNTIME_CAPABILITY_KEYS)[number];
export type RuntimeCapabilitiesV1 = { readonly [K in RuntimeCapabilityKey]: boolean };

export interface RuntimeCapabilitySnapshotV1 {
  readonly schema_version: typeof RUNTIME_CAPABILITIES_SCHEMA;
  readonly runtime_instance_id: string;
  readonly observed_at: string;
  readonly state: RuntimeState;
  readonly capabilities: RuntimeCapabilitiesV1;
  readonly requested_mode: RequestedExecutionMode;
  readonly effective_mode: EffectiveExecutionMode;
  readonly effective_reason: string;
}

const SNAPSHOT_FIELDS = [
  "schema_version", "runtime_instance_id", "observed_at", "state",
  "capabilities", "requested_mode", "effective_mode", "effective_reason",
] as const;

function capabilities(value: unknown, name: string): RuntimeCapabilitiesV1 {
  const raw = closed(value, name, RUNTIME_CAPABILITY_KEYS);
  const out: Record<string, boolean> = {};
  for (const key of RUNTIME_CAPABILITY_KEYS) out[key] = bool(raw[key], `${name} ${key}`);
  return Object.freeze(out) as RuntimeCapabilitiesV1;
}

/**
 * A stopped or failed runtime cannot be advertising capabilities: nothing is
 * listening to serve them. Spec 2 section 12.3 renders runtime health and
 * effective mode side by side, and a card reading "stopped · nano_compile
 * available" would invite an operator to try a compile that cannot land.
 */
function refuseCapabilitiesWhenDown(state: RuntimeState, set: RuntimeCapabilitiesV1, name: string): void {
  if (state !== "stopped" && state !== "failed") return;
  for (const key of RUNTIME_CAPABILITY_KEYS) {
    if (set[key]) fail(`${name} cannot advertise capabilities while the runtime is ${state}.`);
  }
}

export function validateRuntimeCapabilitySnapshot(
  value: unknown,
  name = "Runtime capability snapshot",
): RuntimeCapabilitySnapshotV1 {
  const raw = closed(value, name, SNAPSHOT_FIELDS);
  const state = choice(raw.state, RUNTIME_STATES, `${name} state`);
  const set = capabilities(raw.capabilities, `${name} capabilities`);
  const requested = choice(raw.requested_mode, REQUESTED_EXECUTION_MODES, `${name} requested mode`);
  const effective = choice(raw.effective_mode, EFFECTIVE_EXECUTION_MODES, `${name} effective mode`);

  refuseCapabilitiesWhenDown(state, set, name);
  if (!withinRequestedAuthority(requested, effective)) {
    fail(`${name} cannot grant more authority than was requested.`);
  }
  // A runtime that is not running has no authority to project. Spec 2 section
  // 7.2 lists `offline` precisely for this, so anything else here is a runtime
  // contradicting itself and the snapshot is refused rather than reconciled.
  if ((state === "stopped" || state === "failed") && effective !== "offline") {
    fail(`${name} must report an offline effective mode while the runtime is ${state}.`);
  }
  // Order submission needs a live controller. `paper_controller` is the flag
  // that says one is attached, so an effective mode at or above paper without
  // it is an unbacked claim of execution capability.
  if (!set.paper_controller && (effective === "paper" || effective === "approve" || effective === "auto")) {
    fail(`${name} cannot report ${effective} without an attached paper controller.`);
  }

  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, RUNTIME_CAPABILITIES_SCHEMA, name) as typeof RUNTIME_CAPABILITIES_SCHEMA,
    runtime_instance_id: ident(raw.runtime_instance_id, `${name} runtime instance id`),
    observed_at: timestamp(raw.observed_at, `${name} observed at`),
    state,
    capabilities: set,
    requested_mode: requested,
    effective_mode: effective,
    // Always required. Spec 2 section 7.2 types it as a plain string, and an
    // operator staring at "requested paper, effective observe" is owed the
    // reason every time — including when the two agree, where the reason is
    // simply the runtime confirming what it honoured.
    effective_reason: text(raw.effective_reason, `${name} effective reason`, 200),
  });
}

/**
 * The snapshot an Agent uses when it has NOT heard from a runtime. Spec 2
 * section 7.2 puts effective mode under ATSv2's authority and forbids Agent
 * deriving it from a local preference, so silence resolves to offline with no
 * capabilities — never to the operator's requested mode.
 */
export function offlineCapabilitySnapshot(
  runtimeInstanceId: string,
  requested: RequestedExecutionMode,
  reason: string,
  observedAt: string,
): RuntimeCapabilitySnapshotV1 {
  const none: Record<string, boolean> = {};
  for (const key of RUNTIME_CAPABILITY_KEYS) none[key] = false;
  return validateRuntimeCapabilitySnapshot({
    schema_version: RUNTIME_CAPABILITIES_SCHEMA,
    runtime_instance_id: runtimeInstanceId,
    observed_at: observedAt,
    state: "stopped",
    capabilities: none,
    requested_mode: requested,
    effective_mode: "offline",
    effective_reason: reason,
  });
}

/**
 * Parse a runtime-authored capability reply. This is the ONLY supported way to
 * obtain a non-offline snapshot: it takes an untrusted payload from the runtime
 * and either returns a validated observation or throws. There is deliberately
 * no constructor that accepts a local settings object, because Spec 2 section
 * 7.2 forbids Agent deriving effective mode from `plan`, `skip`, `danger` or
 * any other UI preference.
 */
export function readRuntimeCapabilityReply(
  payload: unknown,
  expect: { runtimeInstanceId: string },
): RuntimeCapabilitySnapshotV1 {
  const snapshot = validateRuntimeCapabilitySnapshot(payload, "Runtime capability reply");
  if (snapshot.runtime_instance_id !== expect.runtimeInstanceId) {
    fail("Runtime capability reply came from a different runtime instance than the one supervised here.");
  }
  return snapshot;
}

/** Operator-facing one-liner. Requested and effective are never collapsed. */
export function formatRuntimeSnapshot(snapshot: RuntimeCapabilitySnapshotV1): string {
  return `Runtime: ${snapshot.state} · Requested: ${snapshot.requested_mode} · Effective: ${snapshot.effective_mode} · ${snapshot.effective_reason}`;
}
