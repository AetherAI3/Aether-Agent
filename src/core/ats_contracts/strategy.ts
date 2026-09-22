// Spec 2 section 9 — Nano source, compile artifact, and activation lifecycle.
//
//   [*] -> Discovered -> Compiled -> Staged -> Active -> Paused -> Retired
//                     -> Rejected              ^__________|
//
// Three documents, three different authorities:
//
//   StrategySourceRecordV1      — a file the operator imported. Mutable on
//                                 disk; identified by the digest of its bytes.
//   StrategyCompileArtifactV1   — an IMMUTABLE, content-addressed compile
//                                 result. Recompiling produces a NEW artifact;
//                                 nothing ever edits one in place.
//   StrategyActivationReceiptV1 — a revisioned record of what the runtime was
//                                 asked to run and what it actually honoured.
//
// The separation is what stops "I edited the file" from silently changing what
// is running. Section 9.4 requires a persistent warning when source differs
// from the staged or active artifact, and that is only expressible because the
// artifact pins `source_sha256` rather than pointing at a path.

import {
  choice,
  closed,
  fail,
  hex64,
  ident,
  integer,
  list,
  nullable,
  schemaTag,
  text,
  timestamp,
  uniqueList,
  version,
} from "./primitives.js";
import { digestWithout } from "./canonical.js";
import { withinRequestedAuthority } from "./mode.js";

export const STRATEGY_SOURCE_SCHEMA = "aether.ats.strategy-source/1" as const;
export const STRATEGY_ARTIFACT_SCHEMA = "aether.ats.strategy-compile-artifact/1" as const;
export const STRATEGY_ACTIVATION_SCHEMA = "aether.ats.strategy-activation/1" as const;

/**
 * Source kinds. Only `nano` is executable. Pine and Python are REFERENCE
 * material: section 9.1 says they are never executed and never reported as
 * compiled Nano, and section 19 lists automatic Pine/Python conversion as a
 * non-goal. The compile validator below enforces that mechanically.
 */
export const STRATEGY_SOURCE_TYPES = ["nano", "pine_reference", "python_reference"] as const;
export type StrategySourceType = (typeof STRATEGY_SOURCE_TYPES)[number];

export const STRATEGY_PROVENANCE = ["user", "bundled"] as const;
export type StrategyProvenance = (typeof STRATEGY_PROVENANCE)[number];

/**
 * A workspace-relative path. Absolute paths, parent traversal, Windows drive
 * letters and UNC prefixes are all refused: a source record is consumed by a
 * file tree and by the local dashboard, and a `..` here would let a strategy
 * listing point outside the operator's own strategy folder. Section 9.4 also
 * forbids symlink imports, which is enforced at the filesystem layer.
 */
const RELATIVE_PATH = /^(?!\/|\\|[A-Za-z]:)(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[A-Za-z0-9._][A-Za-z0-9._/\- ]{0,255}$/;

export function relativePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !RELATIVE_PATH.test(value)) {
    fail(`${name} must be a workspace-relative path without parent traversal.`);
  }
  return value;
}

/** Bar interval a compiled artifact runs on, matching the data timeframe vocabulary. */
const INTERVAL = /^(?:M(?:1|2|3|5|10|15|30)|H(?:1|2|4|6|8|12)|D1|W1)$/;

export interface StrategySourceRecordV1 {
  readonly schema_version: typeof STRATEGY_SOURCE_SCHEMA;
  readonly strategy_id: string;
  readonly display_name: string;
  readonly source_type: StrategySourceType;
  readonly source_sha256: string;
  readonly relative_path: string;
  readonly imported_at: string;
  readonly provenance: StrategyProvenance;
}

const SOURCE_FIELDS = [
  "schema_version", "strategy_id", "display_name", "source_type",
  "source_sha256", "relative_path", "imported_at", "provenance",
] as const;

export function validateStrategySource(value: unknown, name = "Strategy source record"): StrategySourceRecordV1 {
  const raw = closed(value, name, SOURCE_FIELDS);
  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, STRATEGY_SOURCE_SCHEMA, name) as typeof STRATEGY_SOURCE_SCHEMA,
    strategy_id: ident(raw.strategy_id, `${name} strategy id`),
    // Display names are operator- or vendor-supplied and render in a file tree
    // and the local dashboard. `text` refuses control characters, so a crafted
    // name cannot rewrite a terminal line or smuggle an escape into a log.
    display_name: text(raw.display_name, `${name} display name`, 120),
    source_type: choice(raw.source_type, STRATEGY_SOURCE_TYPES, `${name} source type`),
    source_sha256: hex64(raw.source_sha256, `${name} source digest`),
    relative_path: relativePath(raw.relative_path, `${name} relative path`),
    imported_at: timestamp(raw.imported_at, `${name} imported at`),
    provenance: choice(raw.provenance, STRATEGY_PROVENANCE, `${name} provenance`),
  });
}

export const DIAGNOSTIC_SEVERITIES = ["error", "warning", "info"] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

/**
 * A compiler diagnostic. Section 9.4 wants line and column detail in the Nano
 * workspace, and section 9.2 carries diagnostics on the artifact so a rejected
 * compile explains itself without re-running the compiler.
 */
export interface CompileDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly line: number | null;
  readonly column: number | null;
}

const DIAGNOSTIC_FIELDS = ["severity", "code", "message", "line", "column"] as const;

function diagnostic(value: unknown, name: string): CompileDiagnostic {
  const raw = closed(value, name, DIAGNOSTIC_FIELDS);
  return Object.freeze({
    severity: choice(raw.severity, DIAGNOSTIC_SEVERITIES, `${name} severity`),
    code: ident(raw.code, `${name} code`),
    // Compiler output is untrusted text that reaches a terminal and the local
    // dashboard. Section 9.4 additionally forbids executing diagnostics.
    message: text(raw.message, `${name} message`, 500),
    line: raw.line === null ? null : integer(raw.line, `${name} line`, 1, 1_000_000),
    column: raw.column === null ? null : integer(raw.column, `${name} column`, 1, 1_000_000),
  });
}

export const ARTIFACT_STATES = ["compiled", "rejected"] as const;
export type ArtifactState = (typeof ARTIFACT_STATES)[number];

export interface StrategyCompileArtifactV1 {
  readonly schema_version: typeof STRATEGY_ARTIFACT_SCHEMA;
  readonly artifact_id: string;
  readonly strategy_id: string;
  readonly source_sha256: string;
  readonly compiler_version: string;
  readonly runtime_version: string;
  readonly ir_version: string;
  readonly ir_sha256: string;
  readonly effects: readonly string[];
  readonly required_signals: readonly string[];
  readonly interval: string;
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly state: ArtifactState;
  readonly compiled_at: string;
}

const ARTIFACT_FIELDS = [
  "schema_version", "artifact_id", "strategy_id", "source_sha256", "compiler_version",
  "runtime_version", "ir_version", "ir_sha256", "effects", "required_signals",
  "interval", "diagnostics", "state", "compiled_at",
] as const;

/** The all-zero IR digest a rejected compile carries: it produced no IR. */
export const NO_IR_DIGEST = "0".repeat(64);

export function validateStrategyArtifact(value: unknown, name = "Strategy compile artifact"): StrategyCompileArtifactV1 {
  const raw = closed(value, name, ARTIFACT_FIELDS);
  const state = choice(raw.state, ARTIFACT_STATES, `${name} state`);
  const irDigest = hex64(raw.ir_sha256, `${name} IR digest`);
  const diagnostics = list(raw.diagnostics, `${name} diagnostics`, 500, diagnostic);
  const effects = uniqueList(raw.effects, `${name} effects`, 50, ident);
  const signals = uniqueList(raw.required_signals, `${name} required signals`, 100, ident);
  const interval = text(raw.interval, `${name} interval`, 8);
  if (!INTERVAL.test(interval)) fail(`${name} interval is unsupported.`);

  // A rejected compile produced nothing runnable. Letting it carry an IR digest
  // would make it stageable by a caller that only checks for a digest's
  // presence, and section 9 permits staging a COMPILED artifact only.
  if (state === "rejected") {
    if (irDigest !== NO_IR_DIGEST) fail(`${name} cannot carry an IR digest while rejected.`);
    if (!diagnostics.some(entry => entry.severity === "error")) {
      fail(`${name} cannot be rejected without an error diagnostic.`);
    }
  }
  // Conversely a compiled artifact must have produced real IR, and an error
  // diagnostic contradicts a successful compile.
  if (state === "compiled") {
    if (irDigest === NO_IR_DIGEST) fail(`${name} cannot be compiled without an IR digest.`);
    if (diagnostics.some(entry => entry.severity === "error")) {
      fail(`${name} cannot be compiled while carrying an error diagnostic.`);
    }
  }

  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, STRATEGY_ARTIFACT_SCHEMA, name) as typeof STRATEGY_ARTIFACT_SCHEMA,
    artifact_id: ident(raw.artifact_id, `${name} artifact id`),
    strategy_id: ident(raw.strategy_id, `${name} strategy id`),
    source_sha256: hex64(raw.source_sha256, `${name} source digest`),
    compiler_version: version(raw.compiler_version, `${name} compiler version`),
    runtime_version: version(raw.runtime_version, `${name} runtime version`),
    ir_version: version(raw.ir_version, `${name} IR version`),
    ir_sha256: irDigest,
    effects: Object.freeze(effects),
    required_signals: Object.freeze(signals),
    interval,
    diagnostics: Object.freeze(diagnostics),
    state,
    compiled_at: timestamp(raw.compiled_at, `${name} compiled at`),
  });
}

/**
 * The content address of an artifact: the canonical digest of every field
 * EXCEPT the id itself. Section 9.2 requires artifacts to be immutable and
 * content-addressed, so recompiling the same source with the same compiler
 * yields the same id, and changing any input yields a different one.
 */
export function computeArtifactId(artifact: Omit<StrategyCompileArtifactV1, "artifact_id">): string {
  return digestWithout({ ...artifact } as unknown as Record<string, unknown>, ["artifact_id"]);
}

/**
 * Verify an artifact actually hashes to the id it claims. A caller that skips
 * this can be handed a relabelled artifact whose IR belongs to other source —
 * the exact substitution content addressing exists to prevent.
 */
export function artifactIdMatches(artifact: StrategyCompileArtifactV1): boolean {
  const { artifact_id: claimed, ...rest } = artifact;
  return computeArtifactId(rest as Omit<StrategyCompileArtifactV1, "artifact_id">) === claimed;
}

/**
 * Whether a source may legally produce a COMPILED artifact. Pine and Python are
 * reference material; section 9.1 forbids reporting them as compiled Nano, and
 * section 19 rules out converting them automatically.
 */
export function sourceMayCompile(source: StrategySourceRecordV1): boolean {
  return source.source_type === "nano";
}

/**
 * Bind an artifact to the source it claims to have compiled. Catches both a
 * non-Nano source being passed off as compiled Nano and an artifact pinned to
 * bytes other than the ones on disk.
 */
export function artifactMatchesSource(artifact: StrategyCompileArtifactV1, source: StrategySourceRecordV1): boolean {
  if (artifact.strategy_id !== source.strategy_id) return false;
  if (artifact.source_sha256 !== source.source_sha256) return false;
  if (artifact.state === "compiled" && !sourceMayCompile(source)) return false;
  return true;
}

/**
 * Activation axis. Deliberately NOT the shared EffectiveExecutionMode union:
 * an activation cannot be `emergency_locked` or `orders_paused` — those are
 * runtime-wide halts, not properties of one strategy. Keeping this local means
 * a runtime-wide halt cannot be mistaken for a per-strategy pause.
 */
export const ACTIVATION_REQUESTED_MODES = ["observe", "paper"] as const;
export type ActivationRequestedMode = (typeof ACTIVATION_REQUESTED_MODES)[number];

export const ACTIVATION_EFFECTIVE_MODES = ["observe", "paper", "paused", "rejected"] as const;
export type ActivationEffectiveMode = (typeof ACTIVATION_EFFECTIVE_MODES)[number];

export const ACTIVATION_STATES = ["staged", "active", "paused", "retired", "rejected"] as const;
export type ActivationState = (typeof ACTIVATION_STATES)[number];

/**
 * Legal transitions from section 9's state diagram. `staged` is the only entry
 * point, and `retired` is terminal — a retired activation is not resumed, a new
 * one is created, so its receipt history stays a truthful record of what ran.
 */
const ACTIVATION_TRANSITIONS: Readonly<Record<ActivationState, readonly ActivationState[]>> = Object.freeze({
  staged: ["active", "rejected", "retired"],
  active: ["paused", "retired"],
  paused: ["active", "retired"],
  retired: [],
  rejected: [],
});

export function activationTransitionAllowed(from: ActivationState, to: ActivationState): boolean {
  return (ACTIVATION_TRANSITIONS[from] ?? []).includes(to);
}

export interface StrategyActivationReceiptV1 {
  readonly schema_version: typeof STRATEGY_ACTIVATION_SCHEMA;
  readonly activation_id: string;
  readonly artifact_id: string;
  readonly requested_mode: ActivationRequestedMode;
  readonly effective_mode: ActivationEffectiveMode;
  readonly state: ActivationState;
  readonly data_profile_id: string;
  readonly data_probe_id: string;
  readonly runtime_instance_id: string;
  readonly grant_ref: string | null;
  readonly reason: string | null;
  readonly revision: number;
  readonly recorded_at: string;
}

const ACTIVATION_FIELDS = [
  "schema_version", "activation_id", "artifact_id", "requested_mode", "effective_mode", "state",
  "data_profile_id", "data_probe_id", "runtime_instance_id", "grant_ref", "reason", "revision", "recorded_at",
] as const;

export function validateStrategyActivation(
  value: unknown,
  name = "Strategy activation receipt",
): StrategyActivationReceiptV1 {
  const raw = closed(value, name, ACTIVATION_FIELDS);
  const requested = choice(raw.requested_mode, ACTIVATION_REQUESTED_MODES, `${name} requested mode`);
  const effective = choice(raw.effective_mode, ACTIVATION_EFFECTIVE_MODES, `${name} effective mode`);
  const state = choice(raw.state, ACTIVATION_STATES, `${name} state`);
  const grant = nullable(raw.grant_ref, `${name} grant reference`, ident);
  const reason = raw.reason === null ? null : text(raw.reason, `${name} reason`, 200);

  // Reuse the shared authority ladder rather than re-deriving it. `paused` and
  // `rejected` are outcomes, not authority levels, so they map to the halt
  // states the ladder already permits after any request.
  const ladderEffective = effective === "paused" || effective === "rejected" ? "orders_paused" : effective;
  if (!withinRequestedAuthority(requested, ladderEffective)) {
    fail(`${name} cannot grant more authority than was requested.`);
  }
  // Section 9.3: paper effectiveness additionally requires the separate
  // execution grant and controller from Spec 1. Compile and stage never imply
  // order authority, so an effective paper activation without a grant
  // reference is refused rather than quietly downgraded.
  if (effective === "paper" && grant === null) {
    fail(`${name} cannot be effective in paper without an execution grant reference.`);
  }
  // Observe-mode activation carries no order authority at all, so a grant
  // reference on it is a category error and probably a copy-paste from a
  // paper receipt.
  if (effective === "observe" && grant !== null) {
    fail(`${name} cannot carry an execution grant while effective in observe.`);
  }
  if (state === "rejected" && effective !== "rejected") {
    fail(`${name} must report a rejected effective mode while rejected.`);
  }
  if (state === "paused" && effective !== "paused") {
    fail(`${name} must report a paused effective mode while paused.`);
  }
  // An active activation is actually running, so it cannot simultaneously
  // report that it is paused or rejected.
  if (state === "active" && (effective === "paused" || effective === "rejected")) {
    fail(`${name} cannot be active while its effective mode is ${effective}.`);
  }
  if (requested !== effective && reason === null) {
    fail(`${name} must explain why the effective mode differs from the requested mode.`);
  }

  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, STRATEGY_ACTIVATION_SCHEMA, name) as typeof STRATEGY_ACTIVATION_SCHEMA,
    activation_id: ident(raw.activation_id, `${name} activation id`),
    artifact_id: ident(raw.artifact_id, `${name} artifact id`),
    requested_mode: requested,
    effective_mode: effective,
    state,
    data_profile_id: ident(raw.data_profile_id, `${name} data profile id`),
    data_probe_id: ident(raw.data_probe_id, `${name} data probe id`),
    runtime_instance_id: ident(raw.runtime_instance_id, `${name} runtime instance id`),
    grant_ref: grant,
    reason,
    // Revisions are append-only and strictly increasing, so a stale writer
    // cannot overwrite a newer decision with an older one.
    revision: integer(raw.revision, `${name} revision`, 1, 1_000_000),
    recorded_at: timestamp(raw.recorded_at, `${name} recorded at`),
  });
}

/**
 * Whether a NEW activation may be admitted. Section 9: only an immutable
 * compiled artifact can be staged, and only a staged artifact with verified
 * runtime and data inputs can activate. This is the single gate both the CLI
 * and the local dashboard call, so neither can invent a looser rule.
 *
 * `dataVerified` is supplied by the caller from a freshly aged probe receipt
 * (see data.ts `probeAdmitsActivation`) rather than read off a stored verdict,
 * because section 8.2 forbids treating an old probe as perpetual evidence.
 */
export function activationAdmitted(input: {
  artifact: StrategyCompileArtifactV1;
  source: StrategySourceRecordV1;
  runtimeHealthy: boolean;
  dataVerified: boolean;
  requestedMode: ActivationRequestedMode;
  grantRef: string | null;
}): { admitted: boolean; reason: string | null } {
  if (input.artifact.state !== "compiled") {
    return { admitted: false, reason: "Only a compiled artifact can be staged and activated." };
  }
  if (!artifactIdMatches(input.artifact)) {
    return { admitted: false, reason: "The artifact does not hash to the id it claims." };
  }
  if (!artifactMatchesSource(input.artifact, input.source)) {
    return { admitted: false, reason: "The artifact does not match the source it claims to compile." };
  }
  if (!input.runtimeHealthy) {
    return { admitted: false, reason: "The ATS runtime is not healthy." };
  }
  if (!input.dataVerified) {
    return { admitted: false, reason: "The data profile has no fresh verified probe." };
  }
  if (input.requestedMode === "paper" && input.grantRef === null) {
    return { admitted: false, reason: "Paper activation requires a separate execution grant." };
  }
  return { admitted: true, reason: null };
}

/** Counts a caller can trust, replacing a bare "number of files found". */
export interface StrategyReadiness {
  readonly compiled: number;
  readonly rejected: number;
  readonly needs_conversion: number;
  readonly unavailable: number;
  readonly total: number;
}

/**
 * Render readiness honestly. Section 5 step 5 requires exact counts and permits
 * setup to finish with zero compiled strategies — but only if it SAYS
 * `0 compiled` and leaves readiness incomplete.
 */
export function formatStrategyReadiness(counts: StrategyReadiness): string {
  return `Strategies · ${counts.compiled} compiled · ${counts.rejected} rejected · `
    + `${counts.needs_conversion} need Nano conversion · ${counts.unavailable} unavailable · ${counts.total} found`;
}

/** Readiness is complete only when something can actually run. */
export function strategiesReady(counts: StrategyReadiness): boolean {
  return counts.compiled > 0;
}
