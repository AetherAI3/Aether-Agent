import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { controlledEdgeExecutable, inspectControlledPage } from "../src/core/pc/browser_inspect.js";
import { PcActionBroker } from "../src/core/pc/broker.js";
import { PcHostGateway, type PcAuditEntry } from "../src/core/pc/gateway.js";

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
      allowHttpLoopback: true, headless: true, timeoutMs: 45_000,
    });
    assert.equal(result.state, "rendered", `${result.reason}; fixture requests=${hits}; cleaned=${result.profileCleaned}`);
    assert.equal(result.finalOrigin, `http://127.0.0.1:${port}`);
    assert.equal(result.browserLaunched, true);
    assert.equal(result.navigationAttempted, true);
    assert.equal(result.mainDocumentHttpClass, "2xx");
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

test("a pre-cancelled inspection launches no browser", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await inspectControlledPage("https://app.aethersystems.net/", { signal: controller.signal });
  assert.equal(result.state, "failed");
  assert.equal(result.browserLaunched, false);
  assert.equal(result.navigationAttempted, false);
  assert.equal(result.profileCleaned, true);
  assert.match(result.reason, /cancelled/);
});

test("cancellation closes an owned Edge profile before a draft action", {
  skip: !controlledEdgeExecutable() ? "Edge Stable is not installed on this runner" : false,
}, async () => {
  const controller = new AbortController();
  let draftReady = false;
  const pending = inspectControlledPage("http://127.0.0.1:9/", {
    allowHttpLoopback: true, headless: true, timeoutMs: 45_000, signal: controller.signal,
  }, async () => { draftReady = true; });
  setTimeout(() => controller.abort(), 300);
  const result = await pending;
  assert.equal(result.state, "failed");
  assert.match(result.reason, /cancelled/);
  assert.equal(result.profileCleaned, true);
  assert.equal(draftReady, false);
});

test("controlled Edge treats main-document HTTP 4xx and 5xx as errors without inspecting content", {
  skip: !controlledEdgeExecutable() ? "Edge Stable is not installed on this runner" : false,
}, async () => {
  const secret = "HTTP-ERROR-PAGE-MUST-NOT-LEAK";
  let hits = 0;
  const server = createServer((request, response) => {
    hits++;
    response.writeHead(request.url === "/unavailable" ? 503 : 404, { "content-type": "text/html" });
    response.end(`<html><head><title>${secret}</title></head><body><main>${secret}</main></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    for (const [path, expected] of [["missing", "4xx"], ["unavailable", "5xx"]] as const) {
      const result = await inspectControlledPage(`http://127.0.0.1:${port}/${path}`, {
        allowHttpLoopback: true, headless: true, timeoutMs: 45_000,
      });
      assert.equal(result.state, "http-error", `${result.reason}; fixture requests=${hits}`);
      assert.equal(result.mainDocumentHttpClass, expected);
      assert.equal(result.structure, null);
      assert.equal(result.documentDigest, null);
      assert.equal(result.profileCleaned, true);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
      allowHttpLoopback: true, headless: true, timeoutMs: 45_000,
    });
    assert.equal(result.state, "redirected", result.reason);
    assert.equal(result.browserLaunched, true);
    assert.equal(result.navigationAttempted, true);
    assert.equal(result.structure, null);
    assert.equal(result.finalOrigin, null);
    assert.equal(result.mainDocumentHttpClass, null);
    assert.equal(result.profileCleaned, true);
  } finally {
    await new Promise<void>((resolve) => source.close(() => resolve()));
    await new Promise<void>((resolve) => destination.close(() => resolve()));
  }
});

test("controlled Edge inserts only into one observed empty composer and returns no draft text", {
  skip: !controlledEdgeExecutable() ? "Edge Stable is not installed on this runner" : false,
}, async () => {
  const secret = "DRAFT-SECRET-MUST-NOT-LEAK";
  const server = createServer((_req, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body><main><h1>Draft</h1><textarea></textarea></main></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const entries: PcAuditEntry[] = [];
    const broker = new PcActionBroker("session", "user", { interactive: true, approve: async () => true });
    const gateway = new PcHostGateway(broker, { append: (entry) => { entries.push(entry); } });
    let action: { dispatched: boolean; verified: boolean } | null = null;
    const result = await inspectControlledPage(`http://127.0.0.1:${port}/`, {
      allowHttpLoopback: true, headless: true, timeoutMs: 45_000,
    }, async (composer) => {
      assert.equal(composer.kind, "textarea");
      assert.equal(await composer.observe(), composer.identity);
      const plan = broker.plan({ adapter: "browser.draft", operation: composer.kind,
        target: composer.identity, expectedState: composer.identity });
      const receipt = await gateway.execute(plan, () => composer.observe(), async () => {
        action = await composer.insert(secret);
        return action;
      });
      assert.equal(receipt.status, "succeeded");
    });
    assert.deepEqual(action, { dispatched: true, verified: true }, JSON.stringify(result));
    assert.equal(result.state, "rendered", result.reason);
    assert.equal(result.profileCleaned, true);
    assert.deepEqual(entries.map((entry) => entry.phase), ["intent", "outcome"]);
    assert.equal(entries[1]?.verified, true);
    assert.doesNotMatch(JSON.stringify(entries), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("controlled Edge refuses a replaced composer before text insertion", {
  skip: !controlledEdgeExecutable() ? "Edge Stable is not installed on this runner" : false,
}, async () => {
  let replace = false;
  const server = createServer((request, response) => {
    if (request.url === "/replace") {
      if (request.method === "POST") replace = true;
      response.writeHead(request.method === "POST" ? 204 : 200, { "content-type": "text/plain" });
      response.end(request.method === "POST" ? undefined : replace ? "yes" : "no");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<html><body><main><textarea></textarea></main><script>let replaced=false; setInterval(async () => { if (!replaced && await fetch("/replace").then(r => r.text()) === "yes") { replaced=true; document.querySelector("textarea").replaceWith(document.createElement("textarea")); } }, 50)</script></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    let action: { dispatched: boolean; verified: boolean } | null = null;
    const result = await inspectControlledPage(`http://127.0.0.1:${port}/`, {
      allowHttpLoopback: true, headless: true, timeoutMs: 45_000,
    }, async (composer) => {
      assert.equal(await composer.observe(), composer.identity);
      const triggered = await fetch(`http://127.0.0.1:${port}/replace`, { method: "POST" });
      assert.equal(triggered.status, 204);
      for (let attempt = 0; attempt < 30 && await composer.observe() !== "stale"; attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(await composer.observe(), "stale");
      action = await composer.insert("MUST-NOT-INSERT");
    });
    assert.deepEqual(action, { dispatched: false, verified: false });
    assert.equal(result.profileCleaned, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("declined draft grant has zero input effect and no draft text in the audit", {
  skip: !controlledEdgeExecutable() ? "Edge Stable is not installed on this runner" : false,
}, async () => {
  let inputEffects = 0;
  const server = createServer((request, response) => {
    if (request.url === "/effect") {
      inputEffects++;
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<html><body><main><textarea></textarea></main><script>document.querySelector("textarea").addEventListener("input", () => fetch("/effect", {method:"POST"}))</script></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const entries: PcAuditEntry[] = [];
    const broker = new PcActionBroker("session", "user", { interactive: true, approve: async () => false });
    const gateway = new PcHostGateway(broker, { append: (entry) => { entries.push(entry); } });
    let status: string | null = null;
    const result = await inspectControlledPage(`http://127.0.0.1:${port}/`, {
      allowHttpLoopback: true, headless: true, timeoutMs: 45_000,
    }, async (composer) => {
      const plan = broker.plan({ adapter: "browser.draft", operation: composer.kind,
        target: composer.identity, expectedState: composer.identity });
      const receipt = await gateway.execute(plan, () => composer.observe(), () => composer.insert("SECRET-DRAFT"));
      status = receipt.status;
    });
    assert.equal(status, "denied");
    assert.equal(inputEffects, 0);
    assert.equal(entries.length, 0);
    assert.equal(result.profileCleaned, true);
    assert.doesNotMatch(JSON.stringify(result), /SECRET-DRAFT/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
