// The registry adapter that routes a canonical account/project setting to Cloud.
//
// The behaviour under test is the Section C rule: a local cached account value
// is never authoritative. When Cloud answers, only Cloud's value is offered as
// a layer; when Cloud does not answer, NO layer is offered at all, and the
// pre-existing local value is reported as an explicitly non-authoritative fact.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AetherSettingsError } from "../src/core/settings_canonical.js";
import type { EffectiveSettingsResponse } from "../src/core/settings_cloud.js";
import {
  cloudScopeFor,
  cloudSettingDefinition,
} from "../src/core/settings_cloud_adapter.js";
import type { SettingChange, SettingValue } from "../src/core/settings_registry.js";

function effective(
  overrides: Record<string, { configured: boolean; value?: unknown; revision: number }> = {},
  extra: Partial<EffectiveSettingsResponse> = {},
): EffectiveSettingsResponse {
  return {
    schema: "aether.settings.effective/1",
    revision: "sha256:abc",
    projectId: null,
    settings: {
      "agent.defaultModel": {
        key: "agent.defaultModel",
        effectiveValue: overrides["account"]?.value ?? "sonnet",
        sourceScope: overrides["account"]?.configured ? "account" : "default",
        sourceId: null,
        revision: overrides["account"]?.revision ?? 0,
        overrides,
        managed: false,
        locked: false,
        reason: null,
        policyRef: null,
        capability: { available: true },
        apply: "next_session",
      },
    },
    ...extra,
  } as EffectiveSettingsResponse;
}

const MUTATION = {
  schema: "aether.settings.mutation/1",
  operation: "patch",
  scope: "account",
  scopeId: null,
  duplicate: false,
  changedKeys: ["agent.defaultModel"],
  revisions: { "agent.defaultModel": 11 },
  revision: "sha256:next",
};

function makeClient(overrides: Partial<Record<"effective" | "patch" | "reset", unknown>> = {}) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const client = {
    effective: async (...args: unknown[]) => {
      calls.push({ op: "effective", args });
      const impl = overrides.effective as ((...a: unknown[]) => unknown) | undefined;
      return (impl ? impl(...args) : effective()) as EffectiveSettingsResponse;
    },
    patch: async (...args: unknown[]) => {
      calls.push({ op: "patch", args });
      const impl = overrides.patch as ((...a: unknown[]) => unknown) | undefined;
      return (impl ? impl(...args) : MUTATION) as never;
    },
    reset: async (...args: unknown[]) => {
      calls.push({ op: "reset", args });
      const impl = overrides.reset as ((...a: unknown[]) => unknown) | undefined;
      return (impl ? impl(...args) : { ...MUTATION, operation: "reset" }) as never;
    },
  };
  return { client: client as never, calls };
}

function defineModelSetting(deps: Parameters<typeof cloudSettingDefinition>[0]["deps"]) {
  return cloudSettingDefinition({
    id: "code.hosted_model",
    canonicalKey: "agent.defaultModel",
    section: "Aether Code",
    label: "Hosted model",
    description: "Hosted model id.",
    valueType: "string",
    deps,
  });
}

function change(
  operation: "set" | "unset",
  scope: "global" | "project" | "session",
  value?: SettingValue,
): SettingChange<SettingValue> {
  return {
    settingId: "code.hosted_model",
    scope,
    operation,
    before: {} as never,
    after: {} as never,
    ...(value === undefined
      ? {}
      : { afterAtScope: { state: "known", scope, source: "cli", rank: 1, value } }),
  } as SettingChange<SettingValue>;
}

const PLAN_CONTEXT = { batchKey: {}, signal: new AbortController().signal };

test("agent writable scopes map onto the canonical Cloud scopes", () => {
  assert.equal(cloudScopeFor("global"), "account");
  assert.equal(cloudScopeFor("project"), "project");
  assert.throws(
    () => cloudScopeFor("session"),
    (err: unknown) =>
      err instanceof AetherSettingsError && err.code === "AETHER_SETTINGS_SCOPE_INVALID",
  );
});

test("a device key has no Cloud adapter at all", () => {
  assert.throws(
    () =>
      cloudSettingDefinition({
        id: "appearance.theme",
        canonicalKey: "editor.fontSize",
        section: "Appearance",
        label: "Font size",
        description: "x",
        valueType: "number",
        deps: { client: makeClient().client },
      }),
    (err: unknown) =>
      err instanceof AetherSettingsError && err.code === "AETHER_SETTINGS_SCOPE_INVALID",
  );
});

test("the declared scopes come from the contract, not from a local guess", () => {
  const definition = defineModelSetting({ client: makeClient().client });
  assert.deepEqual([...definition.scopes], ["default", "global", "project"]);
});

test("when Cloud answers, only Cloud's value is a layer", async () => {
  const { client } = makeClient({
    effective: () => effective({ account: { configured: true, value: "opus5", revision: 10 } }),
  });
  const definition = defineModelSetting({
    client,
    legacy: async () => ({ value: "sonnet", source: "local config" }),
  });

  const read = await definition.read();
  assert.deepEqual(read.layers, [
    { scope: "global", source: "aether cloud (account)", value: "opus5" },
  ]);
  assert.equal(read.health?.state, "verified");
  // The legacy value is visible but explicitly not authoritative.
  assert.equal(read.extensions?.["legacyLocalValue"], "sonnet");
  assert.equal(read.extensions?.["legacyLocalIsAuthoritative"], false);
  assert.equal(read.extensions?.["cloudAuthoritative"], true);
  assert.equal(read.extensions?.["cloudRevision"], 10);
});

test("when Cloud does not answer, there is NO layer to mistake for authority", async () => {
  const { client } = makeClient({
    effective: () => {
      throw new AetherSettingsError("AETHER_SETTINGS_OFFLINE", "no answer");
    },
  });
  const definition = defineModelSetting({
    client,
    legacy: async () => ({ value: "sonnet", source: "local config" }),
  });

  const read = await definition.read();
  assert.deepEqual(read.layers, [], "an offline read must not offer a cached account value");
  assert.equal(read.health?.state, "unavailable");
  assert.equal(read.extensions?.["legacyLocalValue"], "sonnet");
  assert.equal(read.extensions?.["legacyLocalIsAuthoritative"], false);
});

test("each failure code becomes its own health state", async () => {
  const cases: Array<[string, string]> = [
    ["AETHER_SETTINGS_OFFLINE", "unavailable"],
    ["AETHER_SETTINGS_UNAUTHORIZED", "unconfigured"],
    ["AETHER_SETTINGS_DISABLED", "disabled_by_policy"],
    ["AETHER_SETTINGS_BACKEND_ERROR", "degraded"],
  ];
  for (const [code, state] of cases) {
    const { client } = makeClient({
      effective: () => {
        throw new AetherSettingsError(code as never, "x");
      },
    });
    const read = await defineModelSetting({ client }).read();
    assert.equal(read.health?.state, state, code);
  }
});

test("a policy-locked value is reported at server_policy so it is never shadowed", async () => {
  const base = effective();
  const setting = base.settings["agent.defaultModel"]!;
  const withPolicy = {
    ...base,
    settings: {
      "agent.defaultModel": {
        ...setting,
        locked: true,
        managed: true,
        sourceScope: "policy",
        effectiveValue: "sonnet",
        policyRef: "policy:managed-model",
        reason: "managed by your team",
      },
    },
  } as EffectiveSettingsResponse;
  const { client } = makeClient({ effective: () => withPolicy });

  const read = await defineModelSetting({ client }).read();
  assert.deepEqual(read.layers, [
    { scope: "server_policy", source: "policy:managed-model", value: "sonnet" },
  ]);
  assert.equal(read.extensions?.["locked"], true);
  assert.equal(read.extensions?.["policyReason"], "managed by your team");
});

test("planning is read-only and captures the revision the change is based on", async () => {
  const { client, calls } = makeClient({
    effective: () => effective({ account: { configured: true, value: "sonnet", revision: 10 } }),
  });
  const definition = defineModelSetting({ client });

  const plan = (await definition.plan(change("set", "global", "opus5"), PLAN_CONTEXT)) as {
    expectedRevision: number;
    cloudScope: string;
    operation: string;
  };
  assert.equal(plan.expectedRevision, 10);
  assert.equal(plan.cloudScope, "account");
  assert.equal(plan.operation, "set");
  assert.ok(
    calls.every((c) => c.op === "effective"),
    "plan must not mutate",
  );
});

test("an unconfigured key plans revision 0, which is a first write", async () => {
  const { client } = makeClient({ effective: () => effective() });
  const plan = (await defineModelSetting({ client }).plan(
    change("set", "global", "opus5"),
    PLAN_CONTEXT,
  )) as { expectedRevision: number };
  assert.equal(plan.expectedRevision, 0);
});

test("a project write without a selected project is refused", async () => {
  const { client } = makeClient();
  const definition = defineModelSetting({ client, projectId: () => null });
  await assert.rejects(
    definition.plan(change("set", "project", "opus5"), PLAN_CONTEXT),
    (err: unknown) =>
      err instanceof AetherSettingsError && err.code === "AETHER_SETTINGS_PROJECT_NOT_FOUND",
  );
});

test("apply sends the captured revision and returns a rollback token", async () => {
  const { client, calls } = makeClient({
    effective: () => effective({ account: { configured: true, value: "sonnet", revision: 10 } }),
  });
  const definition = defineModelSetting({ client });
  const plan = await definition.plan(change("set", "global", "opus5"), PLAN_CONTEXT);

  const result = await definition.apply(plan);
  assert.equal(result.ok, true);
  const patch = calls.find((c) => c.op === "patch");
  assert.ok(patch);
  assert.deepEqual(patch.args[0], "account");
  assert.deepEqual((patch.args[1] as Record<string, unknown>)["values"], {
    "agent.defaultModel": "opus5",
  });
  assert.deepEqual((patch.args[1] as Record<string, unknown>)["expectedRevisions"], {
    "agent.defaultModel": 10,
  });
  if (result.ok) {
    const token = result.receipt.rollbackToken as { revision: number; previousValue?: unknown };
    assert.equal(token.revision, 11);
    assert.equal(token.previousValue, "sonnet");
  }
});

test("a conflicting apply fails with the stable public code and no value", async () => {
  const { client } = makeClient({
    effective: () => effective({ account: { configured: true, value: "sonnet", revision: 10 } }),
    patch: () => {
      throw new AetherSettingsError("AETHER_SETTINGS_REVISION_CONFLICT", "changed", {
        keys: ["agent.defaultModel"],
        conflicts: [{ key: "agent.defaultModel", expectedRevision: 10, actualRevision: 11 }],
      });
    },
  });
  const definition = defineModelSetting({ client });
  const plan = await definition.plan(change("set", "global", "opus5"), PLAN_CONTEXT);

  const result = await definition.apply(plan);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "AETHER_SETTINGS_REVISION_CONFLICT");
    assert.ok(!result.error.includes("opus5"));
  }
});

test("rollback restores the previous value under the revision the write produced", async () => {
  const { client, calls } = makeClient({
    effective: () => effective({ account: { configured: true, value: "sonnet", revision: 10 } }),
  });
  const definition = defineModelSetting({ client });
  const plan = await definition.plan(change("set", "global", "opus5"), PLAN_CONTEXT);
  const result = await definition.apply(plan);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  await definition.rollback?.(result.receipt);
  const rollbackPatch = calls.filter((c) => c.op === "patch").at(-1);
  assert.ok(rollbackPatch);
  assert.deepEqual((rollbackPatch.args[1] as Record<string, unknown>)["values"], {
    "agent.defaultModel": "sonnet",
  });
  // The rollback expects the revision the write produced, so a concurrent
  // change elsewhere refuses it rather than reverting a value nobody chose.
  assert.deepEqual((rollbackPatch.args[1] as Record<string, unknown>)["expectedRevisions"], {
    "agent.defaultModel": 11,
  });
});

test("rolling back a first write clears the key instead of inventing a value", async () => {
  const { client, calls } = makeClient({ effective: () => effective() });
  const definition = defineModelSetting({ client });
  const plan = await definition.plan(change("set", "global", "opus5"), PLAN_CONTEXT);
  const result = await definition.apply(plan);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  await definition.rollback?.(result.receipt);
  const reset = calls.find((c) => c.op === "reset");
  assert.ok(reset, "an unconfigured key must be reset, not patched to a guess");
});

test("unset routes to the canonical reset with the same CAS contract", async () => {
  const { client, calls } = makeClient({
    effective: () => effective({ account: { configured: true, value: "opus5", revision: 10 } }),
  });
  const definition = defineModelSetting({ client });
  const plan = await definition.plan(change("unset", "global"), PLAN_CONTEXT);

  const result = await definition.apply(plan);
  assert.equal(result.ok, true);
  const reset = calls.find((c) => c.op === "reset");
  assert.ok(reset);
  assert.deepEqual((reset.args[1] as Record<string, unknown>)["keys"], ["agent.defaultModel"]);
  assert.deepEqual((reset.args[1] as Record<string, unknown>)["expectedRevisions"], {
    "agent.defaultModel": 10,
  });
});

test("validation uses the canonical constraint and the supplied catalogue", () => {
  const { client } = makeClient();
  const definition = defineModelSetting({ client, availableModels: () => ["opus5"] });
  assert.deepEqual(definition.validate("opus5"), { ok: true, value: "opus5" });
  const rejected = definition.validate("not-in-catalog");
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.issues[0]?.code, "AETHER_SETTINGS_VALUE_INVALID");
  }
});

test("a duplicate write is reported as a replay, not as a fresh change", async () => {
  const { client } = makeClient({
    effective: () => effective({ account: { configured: true, value: "sonnet", revision: 10 } }),
    patch: () => ({ ...MUTATION, duplicate: true }),
  });
  const definition = defineModelSetting({ client });
  const plan = await definition.plan(change("set", "global", "opus5"), PLAN_CONTEXT);
  const result = await definition.apply(plan);
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.receipt.summary ?? "", /replayed/);
});

test("doctor reports reachability without changing anything", async () => {
  const { client, calls } = makeClient();
  assert.equal((await defineModelSetting({ client }).doctor?.())?.state, "verified");
  assert.ok(calls.every((c) => c.op === "effective"));

  const { client: broken } = makeClient({
    effective: () => {
      throw new AetherSettingsError("AETHER_SETTINGS_OFFLINE", "x");
    },
  });
  assert.equal((await defineModelSetting({ client: broken }).doctor?.())?.state, "unavailable");
});
