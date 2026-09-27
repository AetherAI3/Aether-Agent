import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AppContext } from "../src/core/context.js";
import { EnvOverrideTokenStore, StaticTokenStore } from "../src/core/auth.js";
import { driveStaffContext } from "../src/core/drive_staff_session.js";
import { DriveStaffLoginError, loginDriveStaffSession } from "../src/core/drive_staff_oauth.js";

const FLOW = "11111111-1111-4111-8111-111111111111";
const SESSION = "a".repeat(64);
const HANDOFF = "B".repeat(48);
const AUTHORIZE = "https://github.com/login/oauth/authorize?client_id=test&state=opaque";

function context(staff = new StaticTokenStore("")): {
  ctx: AppContext; ordinary: StaticTokenStore; staff: StaticTokenStore;
} {
  const ordinary = new StaticTokenStore("aek_existing_device_key");
  return {
    ordinary, staff,
    ctx: {
      cfg: { baseUrl: "https://api.aethersystems.net/cloud" },
      tokens: ordinary,
      driveStaffTokens: staff,
      flags: { json: false, yes: false, audit: false, cwd: process.cwd() },
      confirm: async () => false,
    } as unknown as AppContext,
  };
}

function fakeOAuth(completion: Record<string, unknown> = {
  authenticated: true, session_token: SESSION,
}): { fetchImpl: typeof fetch; calls: Array<{ path: string; body: Record<string, unknown> }> } {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>)["Authorization"], undefined,
      "ordinary aek_ PAT must never enter OAuth requests");
    calls.push({ path: url, body });
    if (url.endsWith("/v1/auth/oauth/github/start")) {
      assert.equal(body["client"], "desktop");
      assert.equal(body["intent"], "sign_in");
      assert.match(String(body["loopback"]), /^http:\/\/127\.0\.0\.1:\d+\/cb$/);
      assert.match(String(body["handoff_challenge"]), /^[A-Za-z0-9_-]{43}$/);
      return new Response(JSON.stringify({ flow_id: FLOW, authorization_url: AUTHORIZE, expires_in: 120 }), {
        status: 200,
      });
    }
    assert.ok(url.endsWith("/v1/auth/oauth/complete"));
    assert.equal(body["flow_id"], FLOW);
    assert.equal(body["handoff_code"], HANDOFF);
    const challenge = createHash("sha256").update(String(body["handoff_verifier"]), "utf8")
      .digest("base64url");
    assert.equal(challenge, calls[0]?.body["handoff_challenge"]);
    return new Response(JSON.stringify(completion), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function deliver(loopbackUrl: string, flow = FLOW): Promise<void> {
  const callback = new URL(loopbackUrl);
  callback.searchParams.set("provider", "github");
  callback.searchParams.set("flow_id", flow);
  callback.searchParams.set("handoff_code", HANDOFF);
  callback.searchParams.set("result", "success");
  const response = await fetch(callback);
  assert.equal(response.status, flow === FLOW ? 200 : 404);
  assert.doesNotMatch(await response.text(), /aek_|handoff_code|session_token/);
}

test("GitHub loopback binds a separate staff session after proof; the API key is unchanged", async () => {
  const { ctx, ordinary, staff } = context();
  const oauth = fakeOAuth();
  let loopbackUrl = "";
  await loginDriveStaffSession(ctx, {
    fetchImpl: oauth.fetchImpl,
    onAuthorizeUrl: async (url, loopback) => {
      assert.equal(url, AUTHORIZE);
      loopbackUrl = loopback;
      await deliver(loopback, "22222222-2222-4222-8222-222222222222");
      await deliver(loopback);
    },
    probeStaff: async (token) => assert.equal(token, SESSION),
  });
  assert.equal(oauth.calls.length, 2);
  assert.equal(await ordinary.get(), "aek_existing_device_key");
  assert.equal(await staff.get(), SESSION);
  const selected = await driveStaffContext(ctx);
  assert.equal(await selected.tokens.get(), SESSION);
  assert.notEqual(selected.tokens, ordinary);
  assert.match(loopbackUrl, /^http:\/\/127\.0\.0\.1:\d+\/cb$/);
});

test("unlinked GitHub account and a refused staff probe never persist a session", async () => {
  const unlinked = context();
  const pending = fakeOAuth({ authenticated: false, error_code: "existing_account_requires_link" });
  await assert.rejects(
    loginDriveStaffSession(unlinked.ctx, {
      fetchImpl: pending.fetchImpl,
      onAuthorizeUrl: async (_url, loopback) => deliver(loopback),
      probeStaff: async () => assert.fail("no token should be probed"),
    }),
    { code: "ACCOUNT_LINK_REQUIRED" },
  );
  assert.equal(await unlinked.staff.get(), null);
  const refused = context();
  let revoked: string | null = null;
  await assert.rejects(
    loginDriveStaffSession(refused.ctx, {
      fetchImpl: fakeOAuth().fetchImpl,
      onAuthorizeUrl: async (_url, loopback) => deliver(loopback),
      probeStaff: async () => { throw new DriveStaffLoginError("STAFF_SESSION_REQUIRED"); },
      revokeSession: async (token) => { revoked = token; },
    }),
    { code: "STAFF_SESSION_REQUIRED" },
  );
  assert.equal(await refused.staff.get(), null);
  assert.equal(revoked, SESSION);
  assert.equal(await refused.ordinary.get(), "aek_existing_device_key");
});

test("OAuth start refuses a non-GitHub redirect and closes the loopback listener", async () => {
  const { ctx, staff } = context();
  let port = 0;
  const malicious = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    port = Number(new URL(String(body["loopback"])).port);
    return new Response(JSON.stringify({
      flow_id: FLOW, authorization_url: "https://evil.example/login/oauth/authorize", expires_in: 120,
    }), { status: 200 });
  }) as typeof fetch;
  await assert.rejects(loginDriveStaffSession(ctx, {
    fetchImpl: malicious,
    onAuthorizeUrl: () => assert.fail("untrusted URL must not open"),
  }), { code: "OAUTH_UNAVAILABLE" });
  assert.equal(await staff.get(), null);
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("without an explicit staff store the flow refuses before OAuth start", async () => {
  const { ctx } = context();
  delete ctx.driveStaffTokens;
  await assert.rejects(loginDriveStaffSession(ctx, {
    onAuthorizeUrl: () => assert.fail("no browser when staff store is unavailable"),
  }), { code: "SESSION_STORE_UNAVAILABLE" });
});

test("a standalone Drive login selects its session while an embedded session keeps precedence", async () => {
  const standalone = context(new StaticTokenStore("b".repeat(64)));
  standalone.ctx.tokens = new StaticTokenStore("c".repeat(64));
  const selected = await driveStaffContext(standalone.ctx);
  assert.equal(await selected.tokens.get(), "b".repeat(64));

  const embedded = context(new StaticTokenStore("b".repeat(64)));
  embedded.ctx.tokens = new EnvOverrideTokenStore("c".repeat(64), new StaticTokenStore(""));
  const selectedEmbedded = await driveStaffContext(embedded.ctx);
  assert.equal(await selectedEmbedded.tokens.get(), "c".repeat(64));
});
