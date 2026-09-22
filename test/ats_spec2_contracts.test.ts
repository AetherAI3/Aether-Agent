// Spec 2 contract freeze (PR 2.1, Aether-Agent half).
//
// Two jobs here. The golden-vector block is a DRIFT DETECTOR: the digests in
// test/fixtures/ats_spec2_golden.json are frozen, so renaming a field, adding
// one, or changing canonicalization breaks this file rather than silently
// desynchronising the Python mirror. The behavioural blocks assert the
// invariants the spec states in prose — the ones a reviewer cannot check by
// reading a type.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { digestOf } from "../src/core/ats_contracts/canonical.js";
import {
  offlineCapabilitySnapshot,
  readRuntimeCapabilityReply,
  validateRuntimeCapabilitySnapshot,
  validateRuntimeInstallationReceipt,
} from "../src/core/ats_contracts/runtime.js";
import {
  ageProbeReceipt,
  formatDataTruth,
  probeAdmitsActivation,
  validateDataProbeReceipt,
  validateDataProfile,
} from "../src/core/ats_contracts/data.js";
import {
  activationAdmitted,
  activationTransitionAllowed,
  artifactIdMatches,
  computeArtifactId,
  formatStrategyReadiness,
  sourceMayCompile,
  strategiesReady,
  validateStrategyActivation,
  validateStrategyArtifact,
  validateStrategySource,
} from "../src/core/ats_contracts/strategy.js";
import {
  amendReflection,
  defaultJournalPreferences,
  factsAmendable,
  nextNoteRevision,
  preferencesGrantNoAuthority,
  resolveNoteSave,
  validateHumanNoteRevision,
  validateJournalEntry,
  validateJournalPreferences,
} from "../src/core/ats_contracts/journal.js";

const here = dirname(fileURLToPath(import.meta.url));
interface GoldenVector { name: string; document: Record<string, unknown>; canonical_digest: string }
interface GoldenFile { schema: string; canonical_profile: string; vectors: GoldenVector[] }

const golden = JSON.parse(
  readFileSync(join(here, "..", "..", "test", "fixtures", "ats_spec2_golden.json"), "utf8"),
) as GoldenFile;

function vector(name: string): GoldenVector {
  const found = golden.vectors.find(entry => entry.name === name);
  assert.ok(found, `golden vector missing: ${name}`);
  return found;
}

/** Deep clone so a test that mutates a vector cannot poison a later one. */
function doc(name: string): Record<string, unknown> {
  return structuredClone(vector(name).document);
}

test("every Spec 2 golden vector still canonicalizes to its frozen digest", () => {
  assert.equal(golden.schema, "aether.ats.spec2-golden/1");
  assert.equal(golden.canonical_profile, "rfc8785/1");
  assert.equal(golden.vectors.length, 16);
  for (const entry of golden.vectors) {
    assert.equal(digestOf(entry.document), entry.canonical_digest, `digest drift in ${entry.name}`);
  }
});

// RFC 8785 serializes non-control Unicode literally as UTF-8; the older
// encoder escaped everything non-ASCII. Pinning a vector that actually
// contains non-ASCII is what makes a silent regression to \u-escaping fail
// here rather than at the Python mirror.
test("non-ASCII survives canonicalization literally, not as an escape", () => {
  const entry = vector("trade-journal-multiline-non-ascii");
  const notes = (entry.document["reflection"] as { notes: string }).notes;
  assert.match(notes, /café/);
  assert.match(notes, /日本語/);
  assert.equal(digestOf(entry.document), entry.canonical_digest);
});

// The base moved float rejection out of canonicalJson into the validators, so
// a float now reaches digestOf instead of throwing there. Every numeric field
// in these four contracts is therefore checked explicitly rather than trusted.
test("every numeric field in the Spec 2 contracts refuses a float", () => {
  const cases: Array<[string, () => unknown]> = [
    ["data profile poll_interval_ms", () => validateDataProfile({ ...doc("data-profile-polygon"), poll_interval_ms: 5000.5 })],
    ["data probe sample_count", () => validateDataProbeReceipt({ ...doc("data-probe-verified"), sample_count: 2.5 })],
    ["data probe freshness_ms", () => validateDataProbeReceipt({ ...doc("data-probe-verified"), freshness_ms: 1000.5 })],
    ["activation revision", () => validateStrategyActivation({ ...doc("strategy-activation-observe-active"), revision: 1.5 })],
    ["journal fact_revision", () => validateJournalEntry({ ...doc("trade-journal-controller-entry"), fact_revision: 1.5 })],
    ["journal reflection_revision", () => validateJournalEntry({ ...doc("trade-journal-controller-entry"), reflection_revision: 2.5 })],
    ["note revision", () => validateHumanNoteRevision({ ...doc("human-note-revision-2"), revision: 2.5 })],
    ["preferences prompt_delay_seconds", () => validateJournalPreferences({ ...doc("journal-preferences-default"), prompt_delay_seconds: 1.5 })],
  ];
  for (const [label, run] of cases) {
    assert.throws(run, /whole number/, `${label} accepted a float`);
  }

  // Diagnostic line and column are the only other numbers, and they sit inside
  // an artifact rather than at the top level.
  const artifact = doc("strategy-compile-artifact-compiled");
  assert.throws(() => validateStrategyArtifact({
    ...artifact,
    state: "rejected",
    ir_sha256: "0".repeat(64),
    diagnostics: [{ severity: "error", code: "E_PARSE", message: "bad", line: 3.5, column: 1 }],
  }), /whole number/);
});

test("prose fields accept newlines and tabs but refuse a carriage return", () => {
  const entry = doc("trade-journal-controller-entry");
  const reflection = entry["reflection"] as Record<string, unknown>;

  // Multi-line notes are the normal case for a human trade journal.
  assert.doesNotThrow(() => validateJournalEntry({
    ...entry,
    reflection: { ...reflection, notes: "First line.\nSecond line.\n\tIndented." },
  }));

  // A carriage return is refused rather than normalized: silently folding CRLF
  // would make a note round-tripped through a Windows editor digest
  // differently from identical-looking text.
  assert.throws(() => validateJournalEntry({
    ...entry,
    reflection: { ...reflection, notes: "First line.\r\nSecond line." },
  }), /carriage return|control character/);
});

test("every Spec 2 golden vector is accepted by its own validator", () => {
  validateRuntimeInstallationReceipt(doc("runtime-installation"));
  validateRuntimeCapabilitySnapshot(doc("runtime-capabilities-healthy-observe"));
  validateRuntimeCapabilitySnapshot(doc("runtime-capabilities-offline"));
  validateDataProfile(doc("data-profile-polygon"));
  validateDataProfile(doc("data-profile-none"));
  validateDataProbeReceipt(doc("data-probe-verified"));
  validateDataProbeReceipt(doc("data-probe-stale"));
  validateDataProbeReceipt(doc("data-probe-unavailable"));
  validateStrategySource(doc("strategy-source-nano"));
  validateStrategySource(doc("strategy-source-pine-reference"));
  validateStrategyArtifact(doc("strategy-compile-artifact-compiled"));
  validateStrategyActivation(doc("strategy-activation-observe-active"));
  validateJournalEntry(doc("trade-journal-controller-entry"));
  validateJournalEntry(doc("trade-journal-multiline-non-ascii"));
  validateHumanNoteRevision(doc("human-note-revision-2"));
  validateJournalPreferences(doc("journal-preferences-default"));
});

test("contracts are closed documents: an unknown field is refused, never ignored", () => {
  const payload = { ...doc("runtime-installation"), extra_field: "smuggled" };
  assert.throws(() => validateRuntimeInstallationReceipt(payload), /unsupported field/);
});

test("an installation receipt cannot exist with unproven provenance", () => {
  const payload = { ...doc("runtime-installation"), provenance_verified: false };
  assert.throws(() => validateRuntimeInstallationReceipt(payload), /provenance/);
});

// Spec 2 section 7.2 — effective mode is ATSv2's to decide, and Agent may never
// derive it from a local preference.
test("a runtime snapshot cannot grant more authority than was requested", () => {
  const payload = doc("runtime-capabilities-healthy-observe");
  payload["requested_mode"] = "observe";
  payload["effective_mode"] = "approve";
  assert.throws(() => validateRuntimeCapabilitySnapshot(payload), /more authority/);
});

test("a stopped runtime must report offline and advertise nothing", () => {
  const stopped = doc("runtime-capabilities-offline");
  stopped["effective_mode"] = "observe";
  assert.throws(() => validateRuntimeCapabilitySnapshot(stopped), /offline/);

  const advertising = doc("runtime-capabilities-offline");
  advertising["capabilities"] = { ...(advertising["capabilities"] as object), nano_compile: true };
  assert.throws(() => validateRuntimeCapabilitySnapshot(advertising), /while the runtime is stopped/);
});

test("paper or higher is refused without an attached paper controller", () => {
  const payload = doc("runtime-capabilities-healthy-observe");
  payload["effective_mode"] = "paper";
  assert.throws(() => validateRuntimeCapabilitySnapshot(payload), /paper controller/);
});

test("silence from the runtime resolves to offline, never to the requested mode", () => {
  const snapshot = offlineCapabilitySnapshot("rt_quiet", "paper", "The ATS runtime is not running.", "2026-09-22T12:00:00Z");
  assert.equal(snapshot.effective_mode, "offline");
  assert.equal(snapshot.state, "stopped");
  assert.equal(snapshot.capabilities.status, false);
});

test("a capability reply from a different runtime instance is refused", () => {
  assert.throws(
    () => readRuntimeCapabilityReply(doc("runtime-capabilities-healthy-observe"), { runtimeInstanceId: "rt_other" }),
    /different runtime instance/,
  );
});

// Spec 2 section 8 — configured is not verified.
test("a data profile has no field that can record a connection verdict", () => {
  const profile = validateDataProfile(doc("data-profile-polygon"));
  assert.ok(!("connected" in profile));
  assert.ok(!("state" in profile));
  assert.throws(() => validateDataProfile({ ...doc("data-profile-polygon"), connected: true }), /unsupported field/);
});

test("a polygon profile stores a credential reference, never a credential", () => {
  const leaked = doc("data-profile-polygon");
  leaked["credential_ref"] = "pk_live_thislookslikeanapikey";
  assert.throws(() => validateDataProfile(leaked), /never a credential value/);
});

test("a verified probe ages into stale and stops admitting activation", () => {
  const receipt = validateDataProbeReceipt(doc("data-probe-verified"));
  const observed = Date.parse(receipt.observed_at ?? "");

  const fresh = ageProbeReceipt(receipt, observed + 1_000);
  assert.equal(fresh.state, "verified");
  assert.equal(probeAdmitsActivation(receipt, observed + 1_000), true);

  const aged = ageProbeReceipt(receipt, observed + 600_000);
  assert.equal(aged.state, "stale");
  assert.equal(probeAdmitsActivation(receipt, observed + 600_000), false);
});

test("an unavailable probe cannot claim samples", () => {
  const payload = doc("data-probe-unavailable");
  payload["sample_count"] = 3;
  assert.throws(() => validateDataProbeReceipt(payload), /cannot report samples/);
});

test("configured and runtime data truth render on separate lines", () => {
  const profile = validateDataProfile(doc("data-profile-polygon"));
  const rendered = formatDataTruth(profile, null, Date.now());
  const lines = rendered.split("\n");
  assert.match(lines[0] ?? "", /^Configured: polygon/);
  assert.match(lines[1] ?? "", /^Runtime:\s+Unverified/);
});

// Spec 2 section 9 — compile is not activation.
test("an artifact is content-addressed and detects relabelling", () => {
  const artifact = validateStrategyArtifact(doc("strategy-compile-artifact-compiled"));
  assert.equal(artifactIdMatches(artifact), true);

  const relabelled = validateStrategyArtifact({ ...doc("strategy-compile-artifact-compiled"), interval: "M15" });
  assert.equal(artifactIdMatches(relabelled), false);
});

test("recompiling identical inputs yields the identical artifact id", () => {
  const body = doc("strategy-compile-artifact-compiled");
  delete body["artifact_id"];
  const first = computeArtifactId(body as never);
  const second = computeArtifactId(structuredClone(body) as never);
  assert.equal(first, second);
});

test("a rejected artifact carries no IR and cannot be activated", () => {
  const rejected = validateStrategyArtifact({
    ...doc("strategy-compile-artifact-compiled"),
    artifact_id: "sha256:" + "0".repeat(64),
    state: "rejected",
    ir_sha256: "0".repeat(64),
    diagnostics: [{ severity: "error", code: "E_PARSE", message: "unexpected token", line: 3, column: 8 }],
  });
  const source = validateStrategySource(doc("strategy-source-nano"));
  const verdict = activationAdmitted({
    artifact: rejected, source, runtimeHealthy: true, dataVerified: true, requestedMode: "observe", grantRef: null,
  });
  assert.equal(verdict.admitted, false);
  assert.match(verdict.reason ?? "", /compiled artifact/);
});

test("Pine and Python sources are reference material and never compile to Nano", () => {
  const pine = validateStrategySource(doc("strategy-source-pine-reference"));
  assert.equal(sourceMayCompile(pine), false);
  assert.equal(sourceMayCompile(validateStrategySource(doc("strategy-source-nano"))), true);
});

test("activation is refused without a healthy runtime and fresh verified data", () => {
  const artifact = validateStrategyArtifact(doc("strategy-compile-artifact-compiled"));
  const source = validateStrategySource(doc("strategy-source-nano"));
  const base = { artifact, source, requestedMode: "observe" as const, grantRef: null };

  assert.equal(activationAdmitted({ ...base, runtimeHealthy: false, dataVerified: true }).admitted, false);
  assert.equal(activationAdmitted({ ...base, runtimeHealthy: true, dataVerified: false }).admitted, false);
  assert.equal(activationAdmitted({ ...base, runtimeHealthy: true, dataVerified: true }).admitted, true);
});

test("paper activation requires a separate execution grant, and observe forbids one", () => {
  const artifact = validateStrategyArtifact(doc("strategy-compile-artifact-compiled"));
  const source = validateStrategySource(doc("strategy-source-nano"));
  const verdict = activationAdmitted({
    artifact, source, runtimeHealthy: true, dataVerified: true, requestedMode: "paper", grantRef: null,
  });
  assert.equal(verdict.admitted, false);
  assert.match(verdict.reason ?? "", /execution grant/);

  const payload = doc("strategy-activation-observe-active");
  payload["grant_ref"] = "grant_01HZY8N4Q7";
  assert.throws(() => validateStrategyActivation(payload), /cannot carry an execution grant/);
});

test("the activation state machine matches the spec diagram", () => {
  assert.equal(activationTransitionAllowed("staged", "active"), true);
  assert.equal(activationTransitionAllowed("active", "paused"), true);
  assert.equal(activationTransitionAllowed("paused", "active"), true);
  assert.equal(activationTransitionAllowed("paused", "retired"), true);
  // A retired activation is terminal; a new one is created instead.
  assert.equal(activationTransitionAllowed("retired", "active"), false);
  // Nothing skips staging.
  assert.equal(activationTransitionAllowed("staged", "paused"), false);
});

test("readiness reports zero compiled honestly and stays incomplete", () => {
  const counts = { compiled: 0, rejected: 2, needs_conversion: 4, unavailable: 0, total: 6 };
  assert.match(formatStrategyReadiness(counts), /0 compiled/);
  assert.equal(strategiesReady(counts), false);
  assert.equal(strategiesReady({ ...counts, compiled: 1 }), true);
});

// Spec 2 section 10 — immutable facts, editable human context.
test("authority facts are not amendable and manual entries are", () => {
  const controller = validateJournalEntry(doc("trade-journal-controller-entry"));
  assert.equal(factsAmendable(controller), false);

  const manual = validateJournalEntry({
    ...doc("trade-journal-controller-entry"),
    source: "manual",
    confidence: "manual",
  });
  assert.equal(factsAmendable(manual), true);
});

test("a manual entry cannot claim authority-grade confidence", () => {
  const payload = { ...doc("trade-journal-controller-entry"), source: "manual" };
  assert.throws(() => validateJournalEntry(payload), /manual confidence/);
});

test("editing a reflection advances only the reflection revision", () => {
  const entry = validateJournalEntry(doc("trade-journal-controller-entry"));
  const edited = amendReflection(
    entry,
    { ...entry.reflection, notes: "Revised after review." },
    "2026-09-22T13:00:00Z",
  );
  assert.equal(edited.reflection_revision, entry.reflection_revision + 1);
  assert.equal(edited.fact_revision, entry.fact_revision);
  assert.equal(edited.reflection.notes, "Revised after review.");
});

test("note revisions append and never skip a predecessor", () => {
  const second = validateHumanNoteRevision(doc("human-note-revision-2"));
  const third = nextNoteRevision(second, "Third thought.", "req_next", "2026-09-22T13:00:00Z");
  assert.equal(third.revision, 3);
  assert.equal(third.supersedes_revision, 2);

  const gap = { ...doc("human-note-revision-2"), revision: 4, supersedes_revision: 1 };
  assert.throws(() => validateHumanNoteRevision(gap), /preceding revision/);
});

test("a save from a stale base is a conflict, and a replay is idempotent", () => {
  const current = validateHumanNoteRevision(doc("human-note-revision-2"));

  const conflict = resolveNoteSave({
    current, baseRevision: 1, body: "My edit", clientRequestId: "req_mine", createdAt: "2026-09-22T13:00:00Z",
  });
  assert.equal(conflict.kind, "conflict");
  if (conflict.kind === "conflict") {
    assert.equal(conflict.mine, "My edit");
    assert.equal(conflict.theirs.revision, 2);
  }

  const replay = resolveNoteSave({
    current, baseRevision: 2, body: current.body, clientRequestId: current.client_request_id, createdAt: "2026-09-22T13:00:00Z",
  });
  assert.equal(replay.kind, "applied");
  if (replay.kind === "applied") assert.equal(replay.revision.revision, 2);

  const applied = resolveNoteSave({
    current, baseRevision: 2, body: "Next edit", clientRequestId: "req_new", createdAt: "2026-09-22T13:00:00Z",
  });
  assert.equal(applied.kind, "applied");
  if (applied.kind === "applied") assert.equal(applied.revision.revision, 3);
});

test("journal preferences grant no authority and refuse an off-but-prompting state", () => {
  assert.equal(preferencesGrantNoAuthority(defaultJournalPreferences()), true);
  assert.throws(
    () => validateJournalPreferences({ ...doc("journal-preferences-default"), prompt_style: "off", prompt_after_close: true }),
    /prompt style is off/,
  );
});
