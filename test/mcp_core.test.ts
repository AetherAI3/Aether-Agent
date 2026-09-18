import test from "node:test";
import assert from "node:assert/strict";
import {
  McpAuthorizationError,
  McpClient,
  MCP_PROVIDERS_PATH,
  MCP_CONNECTIONS_PATH,
  type McpConnection,
} from "../src/core/mcp.js";
import type { ApiClient } from "../src/core/transport.js";

function fakeApi(routes: Record<string, unknown>): ApiClient & {
  calls: Array<{ method: string; path: string; body?: unknown }>;
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const api = {
    calls,
    async getJson(path: string) {
      calls.push({ method: "GET", path });
      if (!(path in routes)) throw Object.assign(new Error("HTTP 404"), { status: 404 });
      return routes[path];
    },
    async postJson(path: string, body: unknown) {
      calls.push({ method: "POST", path, body });
      if (!(path in routes)) throw Object.assign(new Error("HTTP 404"), { status: 404 });
      return routes[path];
    },
  };
  return api as unknown as ApiClient & { calls: typeof calls };
}

test("listProviders + listConnections hit broker paths", async () => {
  const api = fakeApi({
    [MCP_PROVIDERS_PATH]: [{ provider_id: "fal.ai", display_name: "fal.ai", flow: "pat_paste" }],
    [MCP_CONNECTIONS_PATH]: [{ provider_id: "fal.ai", created_at: "t", updated_at: "t" }],
  });
  const c = new McpClient(api);
  assert.equal((await c.listProviders())[0]?.provider_id, "fal.ai");
  assert.equal((await c.listConnections())[0]?.provider_id, "fal.ai");
});

test("startOAuth posts provider_id; patStore posts pat", async () => {
  const api = fakeApi({
    "/mcp-broker/oauth/start": { flow: "pat_paste", validate_endpoint: "/oauth/pat-store" },
    "/mcp-broker/oauth/pat-store": { ok: true },
  });
  const c = new McpClient(api);
  const s = await c.startOAuth("fal.ai");
  assert.equal(s.flow, "pat_paste");
  const r = await c.patStore("fal.ai", "key-123");
  assert.equal(r.ok, true);
  const patCall = api.calls.find((x) => x.path === "/mcp-broker/oauth/pat-store");
  assert.deepEqual(patCall?.body, { provider_id: "fal.ai", pat: "key-123", metadata: {} });
});

test("pollUntilConnected resolves when provider appears", async () => {
  let n = 0;
  const api = {
    async getJson() {
      n++;
      return n >= 3 ? [{ provider_id: "fal.ai", created_at: "t", updated_at: "t" }] : [];
    },
    async postJson() { return {}; },
  } as unknown as ApiClient;
  const c = new McpClient(api);
  const got = await c.pollUntilConnected("fal.ai", async () => {}, { intervalSec: 0, timeoutSec: 5 });
  assert.equal(got.provider_id, "fal.ai");
});

test("pollUntilConnected times out", async () => {
  const api = { async getJson() { return []; }, async postJson() { return {}; } } as unknown as ApiClient;
  const c = new McpClient(api);
  await assert.rejects(
    () => c.pollUntilConnected("fal.ai", async () => {}, { intervalSec: 0, timeoutSec: 0 }),
    /timed out/,
  );
});

test("pollUntilConnected cancellation interrupts a provider sleep that ignores cancellation", async () => {
  const api = { async getJson() { return []; }, async postJson() { return {}; } } as unknown as ApiClient;
  const c = new McpClient(api);
  const controller = new AbortController();
  const polling = c.pollUntilConnected(
    "fal.ai",
    async () => new Promise<void>(() => {}),
    { signal: controller.signal, timeoutSec: 180 },
  );
  controller.abort();
  await assert.rejects(polling, (error: unknown) => {
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
});

test("broker calls forward the cancellation signal and timeout to ApiClient", async () => {
  let receivedSignal: AbortSignal | undefined;
  let receivedTimeout: number | undefined;
  const api = {
    async getJson(_path: string, signal?: AbortSignal, timeoutMs?: number) {
      receivedSignal = signal;
      receivedTimeout = timeoutMs;
      return [];
    },
    async postJson() { return {}; },
  } as unknown as ApiClient;
  const controller = new AbortController();
  await new McpClient(api).listProviders({ signal: controller.signal, timeoutMs: 321 });
  assert.equal(receivedSignal, controller.signal);
  assert.equal(receivedTimeout, 321);
});

test("broker-absent backend rejects (404 propagates)", async () => {
  const api = fakeApi({});
  const c = new McpClient(api);
  await assert.rejects(() => c.listProviders());
});

// ── authorization completion is proven, not assumed ─────────────────────────
//
// `pollUntilConnected` used to resolve the moment the provider appeared in
// /connections. That is the same condition on a first connection and on a
// RE-authorization, and the two are not the same event: when the operator is
// reconnecting an expired token, a wrong account, or a widened scope, the row
// is already there. So the first poll — issued before the browser had even
// painted the consent screen — found the STALE row and printed "connected",
// whether or not the operator ever finished, or actively cancelled.
//
// The Cloud already distinguishes them. vault_put_connection upserts with
// `updated_at = now()` (aether_mcp_broker/migrations/005_vault_rpcs.sql), and
// /connections returns that column, so a completed authorization always moves
// the timestamp. The fix is to carry the pre-authorization row as `since` and
// require it to have advanced.

const T0 = "2026-01-01T00:00:00.000000+00:00";
const T1 = "2026-01-01T00:05:00.000000+00:00";

function connectionsApi(rows: () => McpConnection[]): ApiClient {
  return {
    async getJson() { return rows(); },
    async postJson() { return {}; },
  } as unknown as ApiClient;
}

test("an already-connected provider is not reported as a fresh authorization", async () => {
  const stale: McpConnection = { provider_id: "fal.ai", created_at: T0, updated_at: T0 };
  const c = new McpClient(connectionsApi(() => [stale]));
  await assert.rejects(
    () =>
      c.pollUntilConnected("fal.ai", async () => {}, {
        intervalSec: 0,
        timeoutSec: 0,
        since: stale,
      }),
    (err: unknown) => {
      if (!(err instanceof McpAuthorizationError)) throw new Error("expected a typed authorization error");
      assert.equal(err.code, "MCP_AUTH_TIMEOUT");
      assert.equal(err.providerId, "fal.ai");
      // The operator must be told the existing connection was left alone,
      // rather than being left to guess whether it was replaced or broken.
      assert.match(err.message, /already connected/i);
      return true;
    },
  );
});

test("a re-authorization is accepted once updated_at advances", async () => {
  const stale: McpConnection = { provider_id: "fal.ai", created_at: T0, updated_at: T0 };
  let polls = 0;
  const c = new McpClient(
    connectionsApi(() => {
      polls += 1;
      return [polls >= 3 ? { ...stale, updated_at: T1 } : stale];
    }),
  );
  const got = await c.pollUntilConnected("fal.ai", async () => {}, {
    intervalSec: 0,
    timeoutSec: 5,
    since: stale,
  });
  assert.equal(got.updated_at, T1);
});

test("a first connection needs no baseline and resolves as before", async () => {
  let polls = 0;
  const c = new McpClient(
    connectionsApi(() => {
      polls += 1;
      return polls >= 2 ? [{ provider_id: "fal.ai", created_at: T1, updated_at: T1 }] : [];
    }),
  );
  const got = await c.pollUntilConnected("fal.ai", async () => {}, {
    intervalSec: 0,
    timeoutSec: 5,
    since: null,
  });
  assert.equal(got.provider_id, "fal.ai");
});

test("an unparseable timestamp still advances when the value changed", async () => {
  // A broker that stops returning ISO-8601 must not strand the flow forever:
  // a different string is still evidence the row was rewritten. Equal strings
  // stay unproven, which fails closed toward a retry rather than a false pass.
  const stale: McpConnection = { provider_id: "x", created_at: "a", updated_at: "a" };
  const c = new McpClient(connectionsApi(() => [{ ...stale, updated_at: "b" }]));
  const got = await c.pollUntilConnected("x", async () => {}, {
    intervalSec: 0,
    timeoutSec: 5,
    since: stale,
  });
  assert.equal(got.updated_at, "b");
});

test("a timeout with no prior connection says so, and is still typed", async () => {
  const c = new McpClient(connectionsApi(() => []));
  await assert.rejects(
    () => c.pollUntilConnected("fal.ai", async () => {}, { intervalSec: 0, timeoutSec: 0 }),
    (err: unknown) => {
      if (!(err instanceof McpAuthorizationError)) throw new Error("expected a typed authorization error");
      assert.equal(err.code, "MCP_AUTH_TIMEOUT");
      assert.doesNotMatch(err.message, /already connected/i);
      return true;
    },
  );
});

test("cancellation is a distinct typed code, not a timeout", async () => {
  const c = new McpClient(connectionsApi(() => []));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      c.pollUntilConnected("fal.ai", async () => {}, {
        intervalSec: 0,
        timeoutSec: 5,
        signal: controller.signal,
      }),
    (err: unknown) => {
      if (!(err instanceof McpAuthorizationError)) throw new Error("cancellation must be typed too");
      assert.equal(err.code, "MCP_AUTH_CANCELLED");
      // AbortError is what every caller's cancellation branch already matches
      // on; renaming it here would route a Ctrl-C into the failure path.
      assert.equal(err.name, "AbortError");
      return true;
    },
  );
});

test("findConnection returns the current row, or null, for the baseline capture", async () => {
  const row: McpConnection = { provider_id: "fal.ai", created_at: T0, updated_at: T0 };
  const c = new McpClient(connectionsApi(() => [row]));
  assert.deepEqual(await c.findConnection("fal.ai"), row);
  const empty = new McpClient(connectionsApi(() => []));
  assert.equal(await empty.findConnection("fal.ai"), null);
});

test("timeoutMs takes precedence over timeoutSec so a sub-second budget is expressible", async () => {
  // The command layer bounds this call inside its own supervisor. Rounding a
  // budget up to whole seconds put the deadline at or past the supervisor's,
  // so the supervisor's generic message always won and the typed one below
  // never reached anybody.
  const c = new McpClient(connectionsApi(() => []));
  const started = Date.now();
  await assert.rejects(
    () =>
      c.pollUntilConnected("fal.ai", async () => {}, {
        intervalSec: 0,
        timeoutSec: 60,
        timeoutMs: 20,
      }),
    (err: unknown) => err instanceof McpAuthorizationError && err.code === "MCP_AUTH_TIMEOUT",
  );
  assert.ok(Date.now() - started < 5_000, "timeoutMs must win over timeoutSec");
});
