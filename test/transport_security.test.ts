import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClient, isCredentialSafeUrl } from "../src/core/transport.js";
import { StaticTokenStore } from "../src/core/auth.js";

test("isCredentialSafeUrl: https any host ok; http only loopback; junk unsafe", () => {
  assert.equal(isCredentialSafeUrl("https://api.aethersystems.net/cloud"), true);
  assert.equal(isCredentialSafeUrl("https://evil.example.com"), true);
  assert.equal(isCredentialSafeUrl("http://localhost:8080"), true);
  assert.equal(isCredentialSafeUrl("http://127.0.0.1:9000/cloud"), true);
  assert.equal(isCredentialSafeUrl("http://[::1]:9000"), true);
  // The leak vectors: cleartext to a remote host.
  assert.equal(isCredentialSafeUrl("http://evil.example.com"), false);
  assert.equal(isCredentialSafeUrl("http://api.aethersystems.net"), false);
  // Non-http(s) schemes and garbage.
  assert.equal(isCredentialSafeUrl("ftp://localhost"), false);
  assert.equal(isCredentialSafeUrl("not a url"), false);
  assert.equal(isCredentialSafeUrl(""), false);
});

test("ApiClient refuses to send the bearer over insecure transport (no network)", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("This fixture must never reach the network");
  });
  const api = new ApiClient("http://evil.example.com", new StaticTokenStore("aek_test_synthetic"));
  await assert.rejects(() => api.getJson("/models"), /insecure transport/);
  assert.equal(network.mock.callCount(), 0);
});

test("ApiClient with no token skips the transport guard without network access", async (t) => {
  // Validate the request at an entirely in-process fetch boundary. A DNS or
  // HTTP failure cannot prove which credential headers would have been sent.
  const network = t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return new Response(JSON.stringify({ models: [] }), { status: 200 });
  });
  const api = new ApiClient("http://evil.example.com", new StaticTokenStore(""));
  assert.deepEqual(await api.getJson("/models"), { models: [] });
  assert.equal(network.mock.callCount(), 1);
});
