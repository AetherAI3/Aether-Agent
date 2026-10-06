import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { replLines } from "../src/commands/chat.js";
import { ApiClient } from "../src/core/transport.js";
import { StaticTokenStore } from "../src/core/auth.js";
import type { AppContext } from "../src/core/context.js";

test("console repairs rejected hosted turn without a model call during login, then continues once explicitly", async () => {
  const realFetch = globalThis.fetch;
  const tokens = new StaticTokenStore("aek_expired");
  let modelCalls = 0;
  let deviceCalls = 0;
  let catalogCalls = 0;
  let sideEffects = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === "/models") {
      catalogCalls++;
      return Response.json({ models: [], tier: "free", default: "auto", account_id: "account-A" });
    }
    if (path === "/auth/device/code") {
      deviceCalls++;
      return Response.json({ device_code: "private", user_code: "ABCD", verification_uri: "https://example.test/device",
        verification_uri_complete: "https://example.test/device?code=ABCD", interval: 0, expires_in: 60 });
    }
    if (path === "/auth/device/token") {
      deviceCalls++;
      return Response.json({ access_token: "aek_fresh" });
    }
    if (path === "/agent/chat/stream") {
      modelCalls++;
      if (modelCalls === 1) return Response.json({ detail: "expired" }, { status: 401 });
      return new Response('data: {"type":"done","uvt":0,"cents":0}\n\n', {
        status: 200, headers: { "content-type": "text/event-stream" },
      });
    }
    sideEffects++;
    throw new Error(`unexpected endpoint ${path}`);
  }) as typeof fetch;
  const ctx = {
    cfg: { baseUrl: "https://example.test", backend: "cloud", defaultModel: "", permissionMode: "ask",
      autoApply: false, telemetry: false, defaultEffort: "" },
    flags: { json: true, audit: false, yes: false, cwd: ".", noBrowser: true },
    tokens, api: new ApiClient("https://example.test", tokens),
  } as unknown as AppContext;
  try {
    const input = Readable.from(["make file\n", "/auth login\n", "/auth continue\n", "/exit\n"]);
    assert.equal(await replLines(ctx, {}, undefined, input), 0);
    assert.equal(modelCalls, 2);
    assert.equal(deviceCalls, 2);
    assert.equal(catalogCalls >= 2, true);
    assert.equal(sideEffects, 0);
    assert.equal(await tokens.get(), "aek_fresh");
  } finally {
    globalThis.fetch = realFetch;
  }
});
