// Cross-surface parity for the canonical settings contract.
//
// These are the Agent half of the F2 Section M vectors. If AETHER-CLOUD changes
// a canonical key, scope, type or default without re-vendoring
// src/generated/settings_vectors.ts, the digest assertions below fail here; if
// this repository edits the vendored copy by hand, they fail too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  AETHER_SETTINGS_CONTRACT_DIGEST,
  AETHER_SETTINGS_VECTORS,
  AETHER_SETTINGS_VECTORS_DIGEST,
  AETHER_SETTINGS_VECTORS_SOURCE,
} from "../src/generated/settings_vectors.js";
import {
  AGENT_SETTING_ALIASES,
  AetherSettingsError,
  CANONICAL_SETTINGS_SCHEMA,
  CANONICAL_SETTINGS_VECTORS_SCHEMA,
  NON_CANONICAL_AGENT_SETTINGS,
  assertScopeAllowed,
  canonicalAuthority,
  canonicalKeyForAgentSetting,
  canonicalSetting,
  canonicalSettings,
  defaultWriteScope,
  requireCanonicalSetting,
  validateCanonicalValue,
} from "../src/core/settings_canonical.js";

/** The exact recipe the vendored file's header documents. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortKeysDeep(value)), "utf8")
    .digest("hex");
}

test("the vendored vector file reproduces its own pinned digest", () => {
  assert.equal(canonicalDigest(AETHER_SETTINGS_VECTORS), AETHER_SETTINGS_VECTORS_DIGEST);
});

test("the vendored vectors name the contract they were generated from", () => {
  assert.equal(AETHER_SETTINGS_VECTORS.schema, CANONICAL_SETTINGS_VECTORS_SCHEMA);
  assert.equal(AETHER_SETTINGS_VECTORS.contractSchema, CANONICAL_SETTINGS_SCHEMA);
  assert.equal(AETHER_SETTINGS_VECTORS.contractDigest, AETHER_SETTINGS_CONTRACT_DIGEST);
  assert.equal(
    AETHER_SETTINGS_VECTORS.contractVersion,
    AETHER_SETTINGS_VECTORS_SOURCE.contractVersion,
  );
  assert.equal(AETHER_SETTINGS_VECTORS_SOURCE.repo, "AetherAI3/AETHER-CLOUD");
  assert.match(AETHER_SETTINGS_VECTORS_SOURCE.commit, /^[0-9a-f]{40}$/);
});

test("every canonical setting is exposed with its canonical facts intact", () => {
  const exposed = canonicalSettings();
  assert.equal(exposed.length, AETHER_SETTINGS_VECTORS.settings.length);
  for (const pinned of AETHER_SETTINGS_VECTORS.settings) {
    const actual = requireCanonicalSetting(pinned.key);
    assert.equal(actual.valueType, pinned.valueType);
    assert.deepEqual(actual.defaultValue, pinned.defaultValue);
    assert.deepEqual([...actual.allowedScopes], [...pinned.allowedScopes]);
    assert.equal(actual.persistence, pinned.persistence);
    assert.equal(actual.apply, pinned.apply);
    assert.equal(actual.managedPolicy, pinned.managedPolicy);
    assert.equal(actual.deprecated, pinned.deprecated);
  }
});

test("the exposed settings cannot be mutated by a consumer", () => {
  const [first] = canonicalSettings();
  assert.ok(first);
  assert.ok(Object.isFrozen(first));
});

test("routing follows the canonical persistence owner, never a local guess", () => {
  for (const item of canonicalSettings()) {
    const expected = item.persistence === "server" ? "cloud" : "device";
    assert.equal(canonicalAuthority(item.key), expected, item.key);
  }
  assert.equal(canonicalAuthority("agent.defaultModel"), "cloud");
  assert.equal(canonicalAuthority("editor.fontSize"), "device");
});

test("a device key is never account/project scoped and vice versa", () => {
  for (const item of canonicalSettings()) {
    if (item.persistence === "device") {
      assert.deepEqual([...item.allowedScopes], ["device"], item.key);
      assert.equal(defaultWriteScope(item.key), "device", item.key);
    } else {
      assert.ok(!item.allowedScopes.includes("device"), item.key);
      assert.equal(defaultWriteScope(item.key), "account", item.key);
    }
  }
});

test("an out-of-scope write is refused with a stable public code", () => {
  assert.throws(
    () => assertScopeAllowed("editor.fontSize", "account"),
    (err: unknown) =>
      err instanceof AetherSettingsError &&
      err.code === "AETHER_SETTINGS_SCOPE_INVALID" &&
      err.keys.includes("editor.fontSize"),
  );
  assert.throws(
    () => assertScopeAllowed("agent.defaultModel", "device"),
    (err: unknown) =>
      err instanceof AetherSettingsError && err.code === "AETHER_SETTINGS_SCOPE_INVALID",
  );
  assert.doesNotThrow(() => assertScopeAllowed("agent.defaultModel", "project"));
});

test("an unknown key is refused, never invented", () => {
  assert.equal(canonicalSetting("nope.not.a.key"), null);
  assert.throws(
    () => requireCanonicalSetting("nope.not.a.key"),
    (err: unknown) =>
      err instanceof AetherSettingsError && err.code === "AETHER_SETTINGS_KEY_UNKNOWN",
  );
});

test("values are validated against the canonical constraint", () => {
  assert.equal(validateCanonicalValue("editor.wordWrap", true), true);
  assert.equal(validateCanonicalValue("editor.fontSize", 14), 14);
  assert.equal(validateCanonicalValue("agent.defaultEffort", "high"), "high");

  const rejected: Array<[string, unknown]> = [
    ["editor.wordWrap", "true"],
    ["editor.fontSize", 7],
    ["editor.fontSize", 41],
    ["editor.fontSize", 14.5],
    ["editor.tabSize", 0],
    ["agent.defaultEffort", "turbo"],
    ["appearance.themeId", "chartreuse"],
    ["agent.defaultModel", ""],
    ["agent.defaultModel", " opus5 "],
  ];
  for (const [key, value] of rejected) {
    assert.throws(
      () => validateCanonicalValue(key, value),
      (err: unknown) =>
        err instanceof AetherSettingsError &&
        err.code === "AETHER_SETTINGS_VALUE_INVALID",
      `${key} should have rejected ${JSON.stringify(value)}`,
    );
  }
});

test("a model outside the supplied catalog is refused, but only when a catalog is supplied", () => {
  assert.equal(
    validateCanonicalValue("agent.defaultModel", "opus5", { availableModels: ["opus5"] }),
    "opus5",
  );
  assert.throws(
    () =>
      validateCanonicalValue("agent.defaultModel", "opus5", {
        availableModels: ["sonnet"],
      }),
    (err: unknown) =>
      err instanceof AetherSettingsError && err.code === "AETHER_SETTINGS_VALUE_INVALID",
  );
  // Offline: no catalog is available, so shape alone decides.
  assert.equal(validateCanonicalValue("agent.defaultModel", "opus5"), "opus5");
});

test("a typed failure carries keys and never a value", () => {
  const err = new AetherSettingsError("AETHER_SETTINGS_REVISION_CONFLICT", "conflict", {
    keys: ["agent.defaultModel"],
    conflicts: [
      { key: "agent.defaultModel", expectedRevision: 10, actualRevision: 11 },
    ],
    traceId: "trc_0123456789abcdef",
  });
  assert.equal(err.code, "AETHER_SETTINGS_REVISION_CONFLICT");
  assert.deepEqual([...err.keys], ["agent.defaultModel"]);
  assert.equal(err.conflicts[0]?.actualRevision, 11);
  assert.equal(err.traceId, "trc_0123456789abcdef");
  // The error surface has no field that could hold a setting value.
  const allowed = new Set(["name", "code", "keys", "conflicts", "traceId"]);
  for (const field of Object.keys(err)) {
    assert.ok(allowed.has(field), `unexpected field on the error surface: ${field}`);
  }
  assert.ok(!JSON.stringify({ ...err }).includes("opus5"));
});

test("every alias points at a real canonical key", () => {
  for (const [agentId, canonicalKey] of Object.entries(AGENT_SETTING_ALIASES)) {
    assert.ok(
      canonicalSetting(canonicalKey),
      `${agentId} aliases ${canonicalKey}, which is not canonical`,
    );
    assert.equal(canonicalKeyForAgentSetting(agentId), canonicalKey);
  }
  assert.equal(canonicalKeyForAgentSetting("code.backend"), null);
});

test("no agent setting is both aliased and declared non-canonical", () => {
  for (const agentId of Object.keys(AGENT_SETTING_ALIASES)) {
    assert.ok(
      !(agentId in NON_CANONICAL_AGENT_SETTINGS),
      `${agentId} is classified twice`,
    );
  }
  for (const reason of Object.values(NON_CANONICAL_AGENT_SETTINGS)) {
    assert.ok(reason.length > 0, "every exclusion must record a reason");
  }
});

test("code.auto_apply is deliberately not equated with the Live Canvas ceiling", () => {
  assert.equal(canonicalKeyForAgentSetting("code.auto_apply"), null);
  assert.match(
    NON_CANONICAL_AGENT_SETTINGS["code.auto_apply"] ?? "",
    /actions\.liveCanvas\.autoApply/,
  );
});
