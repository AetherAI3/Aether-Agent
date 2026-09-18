// CAS, conflict and offline behaviour for the canonical Cloud settings client.
//
// The headline case is F2 Section H: two surfaces read the same revision, one
// writes, and the second must be REFUSED with both revisions surfaced — never
// retried into a silent overwrite.

import { test } from "node:test";
import assert from "node:assert/strict";

import { HttpError } from "../src/core/errors.js";
import { AetherSettingsError } from "../src/core/settings_canonical.js";
import {
  CloudSettingsClient,
  idempotencyKeyFor,
  toSettingsError,
} from "../src/core/settings_cloud.js";

interface Call {
  method: "GET" | "PATCH" | "POST";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A recording fake; no network, no disk. */
function fakeApi(handler: (call: Call) => unknown) {
  const calls: Call[] = [];
  const api = {
    async getJson<T>(path: string): Promise<T> {
      const call: Call = { method: "GET", path };
      calls.push(call);
      return handler(call) as T;
    },
    async patchJson<T>(
      path: string,
      body: unknown,
      opts: { headers?: Record<string, string> } = {},
    ): Promise<T> {
      const call: Call = {
        method: "PATCH",
        path,
        body,
        ...(opts.headers ? { headers: opts.headers } : {}),
      };
      calls.push(call);
      return handler(call) as T;
    },
    async postJsonWithHeaders<T>(
      path: string,
      body: unknown,
      opts: { headers?: Record<string, string> } = {},
    ): Promise<T> {
      const call: Call = {
        method: "POST",
        path,
        body,
        ...(opts.headers ? { headers: opts.headers } : {}),
      };
      calls.push(call);
      return handler(call) as T;
    },
  };
  return { api, calls };
}

const OK_MUTATION = {
  schema: "aether.settings.mutation/1",
  operation: "patch",
  scope: "account",
  scopeId: null,
  duplicate: false,
  changedKeys: ["agent.defaultModel"],
  revisions: { "agent.defaultModel": 11 },
  revision: "sha256:deadbeef",
};

test("a server-backed write carries the expected revision and an idempotency key", async () => {
  const { api, calls } = fakeApi(() => OK_MUTATION);
  const client = new CloudSettingsClient({ api });

  await client.patch("account", {
    values: { "agent.defaultModel": "opus5" },
    expectedRevisions: { "agent.defaultModel": 10 },
  });

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call);
  assert.equal(call.method, "PATCH");
  assert.equal(call.path, "/code/settings/account");
  assert.deepEqual(call.body, {
    values: { "agent.defaultModel": "opus5" },
    expectedRevisions: { "agent.defaultModel": 10 },
  });
  const idem = call.headers?.["Idempotency-Key"] ?? "";
  assert.match(idem, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
});

test("the same edit reuses one idempotency key; a different edit does not", () => {
  const base = {
    operation: "patch" as const,
    scope: "account" as const,
    values: { "agent.defaultModel": "opus5" },
    expectedRevisions: { "agent.defaultModel": 10 },
  };
  assert.equal(idempotencyKeyFor(base), idempotencyKeyFor({ ...base }));
  assert.notEqual(
    idempotencyKeyFor(base),
    idempotencyKeyFor({ ...base, values: { "agent.defaultModel": "sonnet" } }),
  );
  assert.notEqual(
    idempotencyKeyFor(base),
    idempotencyKeyFor({ ...base, expectedRevisions: { "agent.defaultModel": 11 } }),
  );
  assert.notEqual(
    idempotencyKeyFor(base),
    idempotencyKeyFor({ ...base, scope: "project", projectId: "prj_00112233445566aa" }),
  );
});

test("Section H: a stale write is refused with both revisions, and never retried", async () => {
  // Online read 10, this surface read 10, Online wrote -> 11.
  let attempts = 0;
  const { api } = fakeApi(() => {
    attempts += 1;
    throw new HttpError(409, "conflict", {
      detail: {
        code: "REVISION_CONFLICT",
        message: "One or more settings changed before this request",
        conflicts: { "agent.defaultModel": { expected: 10, actual: 11 } },
      },
    });
  });
  const client = new CloudSettingsClient({ api });

  await assert.rejects(
    client.patch("account", {
      values: { "agent.defaultModel": "opus5" },
      expectedRevisions: { "agent.defaultModel": 10 },
    }),
    (err: unknown) => {
      assert.ok(err instanceof AetherSettingsError);
      assert.equal(err.code, "AETHER_SETTINGS_REVISION_CONFLICT");
      assert.deepEqual(
        [...err.conflicts],
        [{ key: "agent.defaultModel", expectedRevision: 10, actualRevision: 11 }],
      );
      return true;
    },
  );
  // The decision belongs to the user; the client must not have tried again.
  assert.equal(attempts, 1);
});

test("a write without the revision it was read at is refused before the wire", async () => {
  const { api, calls } = fakeApi(() => OK_MUTATION);
  const client = new CloudSettingsClient({ api });

  await assert.rejects(
    client.patch("account", {
      values: { "agent.defaultModel": "opus5" },
      expectedRevisions: {},
    }),
    (err: unknown) =>
      err instanceof AetherSettingsError &&
      err.code === "AETHER_SETTINGS_REVISION_CONFLICT",
  );
  assert.equal(calls.length, 0);
});

test("a device setting never reaches the server", async () => {
  const { api, calls } = fakeApi(() => OK_MUTATION);
  const client = new CloudSettingsClient({ api });

  await assert.rejects(
    client.patch("account", {
      values: { "editor.fontSize": 16 },
      expectedRevisions: { "editor.fontSize": 3 },
    }),
    (err: unknown) =>
      err instanceof AetherSettingsError && err.code === "AETHER_SETTINGS_SCOPE_INVALID",
  );
  assert.equal(calls.length, 0);
});

test("an invalid value is refused before the wire", async () => {
  const { api, calls } = fakeApi(() => OK_MUTATION);
  const client = new CloudSettingsClient({ api });

  await assert.rejects(
    client.patch("account", {
      values: { "agent.defaultEffort": "turbo" },
      expectedRevisions: { "agent.defaultEffort": 1 },
    }),
    (err: unknown) =>
      err instanceof AetherSettingsError && err.code === "AETHER_SETTINGS_VALUE_INVALID",
  );
  assert.equal(calls.length, 0);
});

test("a project write sends the project id and targets the project scope", async () => {
  const { api, calls } = fakeApi(() => ({ ...OK_MUTATION, scope: "project" }));
  const client = new CloudSettingsClient({ api });

  await client.patch("project", {
    values: { "agent.defaultEffort": "high" },
    expectedRevisions: { "agent.defaultEffort": 2 },
    projectId: "prj_00112233445566aa",
  });

  const [call] = calls;
  assert.ok(call);
  assert.equal(call.path, "/code/settings/project");
  assert.deepEqual(call.body, {
    projectId: "prj_00112233445566aa",
    values: { "agent.defaultEffort": "high" },
    expectedRevisions: { "agent.defaultEffort": 2 },
  });
});

test("reset uses the same CAS contract on its own route", async () => {
  const { api, calls } = fakeApi(() => ({ ...OK_MUTATION, operation: "reset" }));
  const client = new CloudSettingsClient({ api });

  await client.reset("account", {
    keys: ["agent.defaultModel"],
    expectedRevisions: { "agent.defaultModel": 11 },
  });

  const [call] = calls;
  assert.ok(call);
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/code/settings/account/reset");
  assert.deepEqual(call.body, {
    keys: ["agent.defaultModel"],
    expectedRevisions: { "agent.defaultModel": 11 },
  });
  assert.match(
    call.headers?.["Idempotency-Key"] ?? "",
    /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/,
  );
});

test("the effective read is a plain GET and passes the project id through", async () => {
  const { api, calls } = fakeApi(() => ({
    schema: "aether.settings.effective/1",
    revision: "sha256:abc",
    projectId: "prj_00112233445566aa",
    settings: {},
  }));
  const client = new CloudSettingsClient({ api });

  await client.effective();
  await client.effective({ projectId: "prj_00112233445566aa" });

  assert.equal(calls[0]?.path, "/code/settings/effective");
  assert.equal(
    calls[1]?.path,
    "/code/settings/effective?project_id=prj_00112233445566aa",
  );
});

test("a transport failure is offline, never a rejection of the edit", async () => {
  const { api } = fakeApi(() => {
    throw new TypeError("fetch failed");
  });
  const client = new CloudSettingsClient({ api });

  await assert.rejects(
    client.patch("account", {
      values: { "agent.defaultModel": "opus5" },
      expectedRevisions: { "agent.defaultModel": 10 },
    }),
    (err: unknown) =>
      err instanceof AetherSettingsError && err.code === "AETHER_SETTINGS_OFFLINE",
  );
});

test("a 5xx is offline; a 4xx refusal is not", () => {
  const offline = toSettingsError(new HttpError(503, "unavailable", {}), ["k"]);
  assert.equal(offline.code, "AETHER_SETTINGS_OFFLINE");

  const refused = toSettingsError(new HttpError(400, "bad", {}), ["k"]);
  assert.equal(refused.code, "AETHER_SETTINGS_BACKEND_ERROR");
});

test("server codes map onto the stable public codes", () => {
  const cases: Array<[string, number, string]> = [
    ["UNAUTHORIZED", 401, "AETHER_SETTINGS_UNAUTHORIZED"],
    ["PROJECT_NOT_FOUND", 404, "AETHER_SETTINGS_PROJECT_NOT_FOUND"],
    ["SETTINGS_DISABLED", 403, "AETHER_SETTINGS_DISABLED"],
    ["POLICY_LOCKED", 403, "AETHER_SETTINGS_POLICY_DENIED"],
    ["TEAM_POLICY_ONLY", 403, "AETHER_SETTINGS_POLICY_DENIED"],
    ["DEVICE_SCOPE_SERVER_REJECTED", 400, "AETHER_SETTINGS_SCOPE_INVALID"],
    ["INVALID_REQUEST", 422, "AETHER_SETTINGS_VALUE_INVALID"],
    ["SETTINGS_BACKEND_UNAVAILABLE", 503, "AETHER_SETTINGS_OFFLINE"],
  ];
  for (const [serverCode, status, expected] of cases) {
    const err = toSettingsError(
      new HttpError(status, "x", { detail: { code: serverCode, message: "m" } }),
      ["agent.defaultModel"],
    );
    assert.equal(err.code, expected, serverCode);
  }
});

test("a diagnostic trace id survives, but a setting value never does", () => {
  const err = toSettingsError(
    new HttpError(409, "conflict", {
      detail: {
        code: "REVISION_CONFLICT",
        message: "changed before this request",
        traceId: "trc_0123456789abcdef",
        conflicts: { "agent.defaultModel": { expected: 10, actual: 11 } },
      },
    }),
    ["agent.defaultModel"],
  );
  assert.equal(err.traceId, "trc_0123456789abcdef");
  assert.ok(!JSON.stringify({ ...err }).includes("opus5"));
});

test("a malformed conflict payload degrades to no conflicts, not a crash", () => {
  const err = toSettingsError(
    new HttpError(409, "conflict", {
      detail: {
        code: "REVISION_CONFLICT",
        message: "m",
        conflicts: { "agent.defaultModel": { expected: "ten", actual: null } },
      },
    }),
    ["agent.defaultModel"],
  );
  assert.equal(err.code, "AETHER_SETTINGS_REVISION_CONFLICT");
  assert.equal(err.conflicts.length, 0);
});
