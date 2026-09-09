// `aether settings status` — the F2 Section L diagnostic.
//
// The reason this has tests of its own is the failure mode it is designed
// against: a status command that prints a cached revision as though it were
// current, or that leaks the user's settings while trying to be helpful.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Writable } from "node:stream";

import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { AppContext } from "../src/core/context.js";
import { runSettingsCommand } from "../src/commands/settings.js";
import { AetherSettingsError } from "../src/core/settings_canonical.js";
import type { EffectiveSettingsResponse } from "../src/core/settings_cloud.js";
import { buildSettingsStatus, renderSettingsStatus } from "../src/core/settings_status.js";

function effective(
  overrides: Partial<EffectiveSettingsResponse> = {},
): EffectiveSettingsResponse {
  return {
    schema: "aether.settings.effective/1",
    revision: "sha256:abc",
    projectId: null,
    settings: {
      "agent.defaultModel": {
        key: "agent.defaultModel",
        effectiveValue: "opus5",
        sourceScope: "account",
        sourceId: null,
        revision: 84,
        overrides: { account: { configured: true, value: "opus5", revision: 84 } },
        managed: false,
        locked: false,
        reason: null,
        policyRef: null,
        capability: { available: true },
        apply: "next_session",
      },
      "agent.defaultEffort": {
        key: "agent.defaultEffort",
        effectiveValue: "medium",
        sourceScope: "default",
        sourceId: null,
        revision: 0,
        overrides: {},
        managed: false,
        locked: false,
        reason: null,
        policyRef: null,
        capability: { available: true },
        apply: "next_session",
      },
      "actions.liveCanvas.autoApply": {
        key: "actions.liveCanvas.autoApply",
        effectiveValue: false,
        sourceScope: "policy",
        sourceId: null,
        revision: 0,
        overrides: {},
        managed: true,
        locked: true,
        reason: "capability unavailable",
        policyRef: "capability:live-canvas",
        capability: { available: false, reason: "capability unavailable" },
        apply: "approval_step_up",
      },
    },
    ...overrides,
  } as EffectiveSettingsResponse;
}

function context(json = false): AppContext {
  return {
    cfg: { ...DEFAULT_CONFIG },
    api: {} as AppContext["api"],
    tokens: {} as AppContext["tokens"],
    flags: { cwd: process.cwd(), json, yes: false, audit: false },
    confirm: async () => false,
  };
}

function captureIo() {
  let stdout = "";
  const writer: Pick<Writable, "write"> = {
    write: ((chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as Writable["write"],
  };
  return { io: { out: writer, err: writer }, out: () => stdout };
}

const OK_STORE = { inspect: () => ({ status: "ok", digest: "a1b2c3d4" }) } as never;

test("the account revision is the newest configured one, not a guess", () => {
  const report = buildSettingsStatus({
    effective: effective(),
    device: { status: "ok", digest: "a1b2c3d4e5f6a7b8" },
  });
  assert.equal(report.schema, "aether.settings/1");
  assert.equal(report.cloud, "connected");
  assert.equal(report.accountRevision, 84);
  // No project was requested, so there is no project revision to report.
  assert.equal(report.project, null);
  assert.equal(report.projectRevision, null);
  assert.equal(report.deviceStatus, "ok");
  assert.equal(report.deviceRevision, "a1b2c3d4e5f6a7b8");
});

test("a fresh account reads 0, never a misleading number", () => {
  const bare = effective();
  const stripped = {
    ...bare,
    settings: { "agent.defaultEffort": bare.settings["agent.defaultEffort"]! },
  } as EffectiveSettingsResponse;
  const report = buildSettingsStatus({ effective: stripped });
  assert.equal(report.accountRevision, 0);
});

test("a project read reports the project and its own revision", () => {
  const base = effective();
  const withProject = {
    ...base,
    projectId: "prj_00112233445566aa",
    settings: {
      ...base.settings,
      "agent.defaultEffort": {
        ...base.settings["agent.defaultEffort"]!,
        overrides: { project: { configured: true, value: "high", revision: 21 } },
      },
    },
  } as EffectiveSettingsResponse;
  const report = buildSettingsStatus({ effective: withProject });
  assert.equal(report.project, "prj_00112233445566aa");
  assert.equal(report.projectRevision, 21);
});

test("a policy-locked key is named so an operator stops hunting for it", () => {
  const report = buildSettingsStatus({ effective: effective() });
  assert.deepEqual([...report.policyLockedKeys], ["actions.liveCanvas.autoApply"]);
});

test("an unreachable Cloud is reported, never shown as a current revision", () => {
  const report = buildSettingsStatus({
    cloudError: "AETHER_SETTINGS_OFFLINE",
    device: { status: "ok", digest: "a1b2c3d4e5f6a7b8" },
  });
  assert.equal(report.cloud, "offline");
  assert.equal(report.accountRevision, null);
  assert.equal(report.projectRevision, null);
  // Device settings still work offline, so the device half is still answered.
  assert.equal(report.deviceStatus, "ok");
  // Nothing came back, so "not returned" would be noise rather than drift.
  assert.equal(report.missingKeys.length, 0);
});

test("each failure code becomes its own reachability word", () => {
  const cases: Array<[Parameters<typeof buildSettingsStatus>[0]["cloudError"], string]> = [
    ["AETHER_SETTINGS_OFFLINE", "offline"],
    ["AETHER_SETTINGS_UNAUTHORIZED", "unauthorized"],
    ["AETHER_SETTINGS_DISABLED", "disabled"],
    ["AETHER_SETTINGS_BACKEND_ERROR", "error"],
  ];
  for (const [code, expected] of cases) {
    assert.equal(buildSettingsStatus({ cloudError: code }).cloud, expected, String(code));
  }
});

test("a server key the contract knows but the server omitted is flagged as drift", () => {
  const base = effective();
  const partial = {
    ...base,
    settings: {
      "agent.defaultModel": base.settings["agent.defaultModel"]!,
      "agent.defaultEffort": base.settings["agent.defaultEffort"]!,
    },
  } as EffectiveSettingsResponse;
  const report = buildSettingsStatus({ effective: partial });
  assert.deepEqual([...report.missingKeys], ["actions.liveCanvas.autoApply"]);
});

test("the rendered report contains no setting value", () => {
  const text = renderSettingsStatus(
    buildSettingsStatus({
      effective: effective(),
      device: { status: "ok", digest: "a1b2c3d4e5f6a7b8" },
    }),
  );
  assert.ok(!text.includes("opus5"), "the configured model must not be printed");
  assert.ok(!text.includes("medium"), "the configured effort must not be printed");
  assert.match(text, /^Schema {8}aether\.settings\/1$/m);
  assert.match(text, /^Cloud {9}connected$/m);
  assert.match(text, /^Account rev {3}84$/m);
  assert.match(text, /^Pending {7}0$/m);
  assert.match(text, /^Conflicts {5}0$/m);
});

test("a long device digest is truncated; it is for comparison, not reconstruction", () => {
  const text = renderSettingsStatus(
    buildSettingsStatus({
      effective: effective(),
      device: { status: "ok", digest: "0123456789abcdef0123456789abcdef" },
    }),
  );
  assert.match(text, /^Device rev {4}0123456789ab$/m);
  assert.ok(!text.includes("0123456789abcdef0123456789abcdef"));
});

test("`settings status` prints the report and exits ok", async () => {
  const { io, out } = captureIo();
  const code = await runSettingsCommand(
    context(),
    ["status"],
    { statusDeps: { readEffective: async () => effective(), store: OK_STORE } },
    io,
  );
  assert.equal(code, 0);
  assert.match(out(), /^Cloud {9}connected$/m);
  assert.ok(!out().includes("opus5"));
});

test("`settings status --json` emits the same value-free report", async () => {
  const { io, out } = captureIo();
  const code = await runSettingsCommand(
    context(true),
    ["status"],
    { statusDeps: { readEffective: async () => effective(), store: OK_STORE } },
    io,
  );
  assert.equal(code, 0);
  const payload = JSON.parse(out());
  assert.equal(payload.ok, true);
  assert.equal(payload.command, "status");
  assert.equal(payload.protocol, "aether.settings/1");
  assert.equal(payload.data.status.cloud, "connected");
  assert.equal(payload.data.status.accountRevision, 84);
  assert.deepEqual(payload.data.status.policyLockedKeys, ["actions.liveCanvas.autoApply"]);
  assert.ok(!out().includes("opus5"));
});

test("`settings status` still answers when Cloud is unreachable", async () => {
  const { io, out } = captureIo();
  const code = await runSettingsCommand(
    context(),
    ["status"],
    {
      statusDeps: {
        readEffective: async () => {
          throw new AetherSettingsError("AETHER_SETTINGS_OFFLINE", "no answer");
        },
        store: OK_STORE,
      },
    },
    io,
  );
  assert.equal(code, 0);
  assert.match(out(), /^Cloud {9}offline$/m);
  assert.match(out(), /^Account rev {3}unknown$/m);
});

test("`settings status` takes no arguments", async () => {
  const { io } = captureIo();
  const code = await runSettingsCommand(context(), ["status", "extra"], {}, io);
  assert.equal(code, 2);
});
