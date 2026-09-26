import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { controlledEdgeExecutable, inspectControlledPage } from "../src/core/pc/browser_inspect.js";

test("controlled Edge inspects a real loopback page without returning page text", {
  skip: !controlledEdgeExecutable() ? "Edge Stable is not installed on this runner" : false,
}, async () => {
  const secret = "SENTINEL-PAGE-TEXT-MUST-NOT-LEAK";
  let hits = 0;
  const server = createServer((_req, response) => {
    hits += 1;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<html><head><title>${secret}</title></head><body><nav>Private nav</nav><main><h1>${secret}</h1><form><input type="text"></form></main></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const result = await inspectControlledPage(`http://127.0.0.1:${port}/`, {
      allowHttpLoopback: true, headless: true, timeoutMs: 30_000,
    });
    assert.equal(result.state, "rendered", `${result.reason}; fixture requests=${hits}; cleaned=${result.profileCleaned}`);
    assert.equal(result.finalOrigin, `http://127.0.0.1:${port}`);
    assert.equal(result.browserLaunched, true);
    assert.equal(result.navigationAttempted, true);
    assert.equal(result.profileCleaned, true);
    assert.deepEqual(result.structure, {
      title: true, main: true, heading: true, navigation: true, form: true, passwordField: false,
    });
    assert.ok(result.documentDigest);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("controlled Edge refuses non-HTTPS remote URLs before launching", async () => {
  await assert.rejects(() => inspectControlledPage("http://example.com/"), /clean HTTPS target/);
  await assert.rejects(() => inspectControlledPage("https://user:pass@example.com/"), /clean HTTPS target/);
});

test("controlled Edge stops on a cross-origin redirect without inspecting its structure", {
  skip: !controlledEdgeExecutable() ? "Edge Stable is not installed on this runner" : false,
}, async () => {
  const destination = createServer((_req, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body><main><h1>private destination</h1></main></body></html>");
  });
  await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
  const destinationPort = (destination.address() as AddressInfo).port;
  const source = createServer((_req, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${destinationPort}/` });
    response.end();
  });
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  try {
    const sourcePort = (source.address() as AddressInfo).port;
    const result = await inspectControlledPage(`http://127.0.0.1:${sourcePort}/`, {
      allowHttpLoopback: true, headless: true, timeoutMs: 30_000,
    });
    assert.equal(result.state, "redirected", result.reason);
    assert.equal(result.browserLaunched, true);
    assert.equal(result.navigationAttempted, true);
    assert.equal(result.structure, null);
    assert.equal(result.finalOrigin, null);
    assert.equal(result.profileCleaned, true);
  } finally {
    await new Promise<void>((resolve) => source.close(() => resolve()));
    await new Promise<void>((resolve) => destination.close(() => resolve()));
  }
});
