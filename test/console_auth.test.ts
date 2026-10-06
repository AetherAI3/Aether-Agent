import { test } from "node:test";
import assert from "node:assert/strict";
import { ConsoleAuthRepair, isHosted401 } from "../src/commands/console_auth.js";
import { HttpError } from "../src/core/errors.js";
import { StaticTokenStore } from "../src/core/auth.js";
import { recoverSubmittedPrompt } from "../src/core/turn_lifecycle.js";
import type { AppContext } from "../src/core/context.js";

function fixture(oldAccount: string | null, newAccount = oldAccount) {
  const tokens = new StaticTokenStore("aek_expired");
  let account = oldAccount;
  let modelCalls = 0;
  let sideEffects = 0;
  let catalogCalls = 0;
  const api = {
    getJson: async (path: string) => {
      assert.equal(path, "/models");
      catalogCalls++;
      return { models: [], account_id: account };
    },
    postJson: async (path: string) => {
      if (path === "/auth/device/code") return {
        device_code: "private", user_code: "ABCD", verification_uri: "https://example.test/device",
        verification_uri_complete: "https://example.test/device?code=ABCD", interval: 0, expires_in: 60,
      };
      if (path === "/auth/device/token") {
        account = newAccount;
        return { access_token: "aek_fresh" };
      }
      if (path.startsWith("/agent")) modelCalls++;
      else sideEffects++;
      throw new Error(`unexpected ${path}`);
    },
    stream: async () => { modelCalls++; throw new Error("model must not run during repair"); },
  };
  const ctx = {
    cfg: { baseUrl: "https://example.test", backend: "cloud" },
    flags: { json: false, audit: false, yes: false, cwd: ".", noBrowser: true },
    tokens, api,
  } as unknown as AppContext;
  return { repair: new ConsoleAuthRepair(ctx), counts: () => ({ modelCalls, sideEffects, catalogCalls }), tokens, ctx };
}

test("same-account device login refreshes catalog and continuation is explicit and one-shot", async () => {
  const { repair, counts, tokens } = fixture("account-A");
  await repair.captureAccount();
  repair.markHostedTurnStarted();
  assert.equal(repair.noteFailure(new HttpError(401, "HTTP 401"), "original instruction", undefined, []), true);
  assert.equal(repair.takeContinuation(), null);
  const message = await repair.login(undefined, true);
  assert.match(message, /same account/);
  assert.equal(await tokens.get(), "aek_fresh");
  assert.deepEqual(counts(), { modelCalls: 0, sideEffects: 0, catalogCalls: 2 });
  assert.equal(repair.takeContinuation()?.instruction, "original instruction");
  assert.equal(repair.takeContinuation(), null);
});

test("newer draft stays separate; account switch and unknown prior owner cannot continue", async () => {
  assert.equal(recoverSubmittedPrompt("failed submission", "newer draft"), "newer draft");
  const changed = fixture("account-A", "account-B");
  await changed.repair.captureAccount();
  changed.repair.markHostedTurnStarted();
  changed.repair.noteFailure(new HttpError(401, "HTTP 401"), "failed submission", undefined, []);
  assert.match(await changed.repair.login(undefined, true), /different account/);
  assert.equal(changed.repair.takeContinuation(), null);
  assert.match(changed.repair.startNewConversation(), /New conversation/);
  assert.equal(changed.repair.pending, null);

  const unknown = fixture(null, "account-B");
  await unknown.repair.captureAccount();
  unknown.repair.markHostedTurnStarted();
  unknown.repair.noteFailure(new HttpError(401, "HTTP 401"), "failed submission", undefined, []);
  assert.match(await unknown.repair.login(undefined, true), /could not be proven/);
  assert.equal(unknown.repair.takeContinuation(), null);
});

test("ambiguous work receipts disable replay; balance, entitlement, rate limit stay distinct", async () => {
  const { repair, counts } = fixture("account-A");
  await repair.captureAccount();
  repair.markHostedTurnStarted();
  assert.equal(repair.noteFailure(new HttpError(402, "HTTP 402"), "x", undefined, []), false);
  assert.equal(repair.noteFailure(new HttpError(403, "HTTP 403"), "x", undefined, []), false);
  assert.equal(repair.noteFailure(new HttpError(429, "HTTP 429"), "x", undefined, []), false);
  assert.equal(isHosted401(new HttpError(401, "HTTP 401: insufficient UVT balance")), false);
  repair.noteFailure(new HttpError(401, "HTTP 401"), "task with tools", undefined, ["tool result 1"]);
  assert.match(await repair.login(undefined, true), /may have run/);
  assert.equal(repair.takeContinuation(), null);
  assert.deepEqual(counts(), { modelCalls: 0, sideEffects: 0, catalogCalls: 2 });
});

test("cancelled login and environment override diagnostics preserve the task", async () => {
  const { repair, tokens, ctx } = fixture("account-A");
  await repair.captureAccount();
  repair.markHostedTurnStarted();
  repair.noteFailure(new HttpError(401, "HTTP 401"), "task", undefined, []);
  const cancel = new AbortController();
  cancel.abort();
  assert.match(await repair.login(cancel.signal, true), /cancelled or failed/);
  assert.equal(repair.pending?.instruction, "task");
  assert.equal(await tokens.get(), "aek_expired");
  ctx.tokens.sourceInfo = async () => ({ source: "environment", storedCredentialShadowed: true });
  const status = await repair.status();
  assert.match(status, /AETHER_TOKEN environment override \(shadows a saved login\)/);
  assert.doesNotMatch(status, /aek_expired/);
});

test("offline and unavailable API do not consume a model call or lose pending work", async () => {
  const offline = fixture("account-A");
  offline.ctx.flags.local = true;
  assert.match(await offline.repair.login(undefined, true), /Offline mode/);
  assert.equal(offline.counts().modelCalls, 0);

  const broken = fixture("account-A");
  await broken.repair.captureAccount();
  broken.repair.markHostedTurnStarted();
  broken.repair.noteFailure(new HttpError(401, "HTTP 401"), "task", undefined, []);
  broken.ctx.api.postJson = async () => { throw new TypeError("offline"); };
  assert.match(await broken.repair.login(undefined, true), /cancelled or failed/);
  assert.equal(broken.repair.pending?.instruction, "task");
  assert.equal(broken.counts().modelCalls, 0);
});

test("status distinguishes rejected API key, balance, forbidden, rate limit, and network outage", async () => {
  const { repair, ctx } = fixture("account-A");
  for (const [status, expected] of [[401, "API key rejected"], [402, "balance required"],
    [403, "access forbidden"], [429, "rate limited"]] as const) {
    ctx.api.getJson = async () => { throw new HttpError(status, `HTTP ${status}`); };
    assert.match(await repair.status(), new RegExp(expected));
  }
  ctx.api.getJson = async () => { throw new TypeError("network down"); };
  assert.match(await repair.status(), /API unavailable; credential unverified/);
});

test("proactive login to a different account blocks hosted work until explicit new conversation", async () => {
  const { repair, counts } = fixture("account-A", "account-B");
  await repair.captureAccount();
  repair.markHostedTurnStarted();
  assert.match(await repair.login(undefined, true), /different account/);
  assert.equal(repair.submissionBlocked, true);
  assert.equal(counts().modelCalls, 0);
  repair.startNewConversation();
  assert.equal(repair.submissionBlocked, false);
});

test("cancelling device approval wait keeps the credential and pending instruction", async () => {
  const { repair, ctx, tokens, counts } = fixture("account-A");
  await repair.captureAccount();
  repair.markHostedTurnStarted();
  repair.noteFailure(new HttpError(401, "HTTP 401"), "task", undefined, []);
  ctx.api.postJson = (async (path: string) => {
    if (path === "/auth/device/code") return {
      device_code: "private", user_code: "ABCD", verification_uri: "https://example.test/device",
      verification_uri_complete: "https://example.test/device?code=ABCD", interval: 10, expires_in: 60,
    };
    throw new Error("poll should have been cancelled");
  }) as typeof ctx.api.postJson;
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 5);
  assert.match(await repair.login(abort.signal, true), /cancelled or failed/);
  assert.equal(await tokens.get(), "aek_expired");
  assert.equal(repair.pending?.instruction, "task");
  assert.equal(counts().modelCalls, 0);
});
