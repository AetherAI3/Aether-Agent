import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSlash, invalidateCatalog, primeCatalog } from "../src/commands/slash.js";
import { repl, replLines, resolveBackend } from "../src/commands/chat.js";
import type { AppContext } from "../src/core/context.js";

function localContext(root: string, json = false): AppContext {
  return {
    flags: { cwd: root, json, yes: false, audit: false },
    cfg: { backend: "local", baseUrl: "https://unreachable.aether.invalid", defaultModel: "", localModel: "ollama/first:1b", permissionMode: "ask", autoApply: false, telemetry: false, defaultEffort: "" },
    tokens: { get: async () => null },
    api: new Proxy({}, { get: () => { throw new Error("hosted API contacted"); } }),
    confirm: async () => false,
  } as unknown as AppContext;
}

function output(): { lines: string[]; stream: { write(value: string): void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (value: string) => { lines.push(value); } } };
}

test("offline /models lists only installed tags at a remote Ollama endpoint and never pulls", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-ollama-models-"));
  const oldFetch = globalThis.fetch;
  const oldHost = process.env["OLLAMA_HOST"];
  const requests: string[] = [];
  process.env["OLLAMA_HOST"] = "https://user:secret@remote.example:11434/";
  globalThis.fetch = (async (url) => {
    requests.push(String(url));
    return Response.json({ models: [{ name: "second:7b" }, { name: "first:1b" }, { name: "first:1b" }] });
  }) as typeof fetch;
  try {
    const ctx = localContext(root);
    const shown = output();
    const listed = await handleSlash(ctx, "/models", shown.stream as never);
    assert.equal(listed.modelSwitch, undefined);
    assert.match(shown.lines.join(""), /remote\.example:11434/);
    assert.match(shown.lines.join(""), /ollama\/first:1b/);
    assert.match(shown.lines.join(""), /ollama\/second:7b/);
    assert.doesNotMatch(shown.lines.join(""), /user|secret/);
    assert.deepEqual(requests, ["https://remote.example:11434/api/tags"]);
    const selected = await handleSlash(ctx, "/model 2", output().stream as never);
    assert.equal(selected.modelSwitch?.model, "ollama/second:7b");
    assert.deepEqual(requests, ["https://remote.example:11434/api/tags", "https://remote.example:11434/api/tags"]);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldHost === undefined) delete process.env["OLLAMA_HOST"]; else process.env["OLLAMA_HOST"] = oldHost;
    rmSync(root, { recursive: true, force: true });
  }
});

test("local console startup skips hosted catalogue prefetch", async () => {
  const ctx = localContext(".");
  let hostedCalls = 0;
  ctx.api = { getJson: async () => { hostedCalls++; throw new Error("hosted API contacted"); } } as unknown as AppContext["api"];
  await primeCatalog(ctx);
  assert.equal(hostedCalls, 0);
});

test("hosted /models keeps the account catalogue authoritative", async () => {
  const oldFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async () => { throw new Error("Ollama must not be queried in a hosted session"); }) as typeof fetch;
  try {
    invalidateCatalog();
    const ctx = localContext(".");
    ctx.cfg.backend = "cloud";
    ctx.tokens = { get: async () => "account-token" } as AppContext["tokens"];
    ctx.api = { getJson: async (path: string) => {
      calls.push(path);
      return { tier: "pro", default: "hosted-alpha", models: [{
        id: "hosted-alpha", label: "Hosted Alpha", kind: "model", provider: "aether",
        context_window: 128_000, tier_min: "pro", enabled: true, available: true,
        monthly_uvt_cap: null, is_default: true,
      }] };
    } } as AppContext["api"];
    const shown = output();
    await handleSlash(ctx, "/models", shown.stream as never);
    assert.match(shown.lines.join(""), /hosted-alpha/);
    assert.deepEqual(calls, ["/models"]);
  } finally { globalThis.fetch = oldFetch; }
});

test("explicit --local keeps picker and next-turn backend local when signed in", async () => {
  const oldFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (url) => {
    requests.push(String(url));
    return Response.json({ models: [{ name: "first:1b" }] });
  }) as typeof fetch;
  try {
    const ctx = localContext(".");
    ctx.cfg.backend = "cloud";
    ctx.flags.local = true;
    ctx.tokens = { get: async () => "account-token" } as AppContext["tokens"];
    assert.equal(await resolveBackend(ctx), "local");
    const shown = output();
    await handleSlash(ctx, "/models", shown.stream as never);
    assert.match(shown.lines.join(""), /ollama\/first:1b/);
    assert.deepEqual(requests, ["http://localhost:11434/api/tags"]);
  } finally { globalThis.fetch = oldFetch; }
});

test("non-TTY JSON selection reaches the next local turn with the wire tag", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-ollama-turn-"));
  const oldFetch = globalThis.fetch;
  const input = new PassThrough();
  const requests: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) as unknown : null });
    if (String(url).endsWith("/api/tags")) return Response.json({ models: [{ name: "first:1b" }, { name: "second:7b" }] });
    if (String(url).endsWith("/v1/chat/completions")) return Response.json({ choices: [{ message: { content: "local answer" } }] });
    throw new Error("unexpected network request");
  }) as typeof fetch;
  try {
    const ctx = localContext(root, true);
    const run = replLines(ctx, { noSkills: true }, undefined, input);
    input.end("/models\n/model 2\n/switch fresh\nFix the parser\n/exit\n");
    assert.equal(await run, 0);
    assert.equal(ctx.flags.model, "ollama/second:7b");
    assert.equal(requests.filter(r => r.url.endsWith("/api/tags")).length, 2);
    const turn = requests.find(r => r.url.endsWith("/v1/chat/completions"));
    assert.equal((turn?.body as { model?: string })?.model, "second:7b");
    assert.ok(requests.every(r => r.url.startsWith("http://localhost:11434/") || r.url.startsWith("http://127.0.0.1:11434/")));
  } finally { globalThis.fetch = oldFetch; input.destroy(); rmSync(root, { recursive: true, force: true }); }
});

test("empty, unreachable, malformed, and disappeared models keep the old choice with one next step", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-ollama-errors-"));
  const oldFetch = globalThis.fetch;
  const ctx = localContext(root);
  try {
    for (const [kind, response, expected] of [
      ["empty", () => Response.json({ models: [] }), /aether local pull/],
      ["unreachable", () => { throw new Error("offline"); }, /Start Ollama or check OLLAMA_HOST/],
      ["malformed", () => Response.json({ models: [{ nope: "name" }] }), /Restart or update Ollama/],
    ] as const) {
      globalThis.fetch = (async () => response()) as typeof fetch;
      const shown = output();
      const result = await handleSlash(ctx, "/models", shown.stream as never);
      assert.equal(result.modelSwitch, undefined, kind);
      assert.match(shown.lines.join(""), expected, kind);
      const selected = output();
      const selection = await handleSlash(ctx, "/model second:7b", selected.stream as never);
      assert.equal(selection.modelSwitch, undefined, kind);
      assert.match(selected.lines.join(""), expected, kind);
      assert.equal(ctx.flags.model, undefined);
    }
    let calls = 0;
    globalThis.fetch = (async () => Response.json({ models: ++calls === 1 ? [{ name: "second:7b" }] : [] })) as typeof fetch;
    await handleSlash(ctx, "/models", output().stream as never);
    const shown = output();
    const missing = await handleSlash(ctx, "/model second:7b", shown.stream as never);
    assert.equal(missing.modelSwitch, undefined);
    assert.match(shown.lines.join(""), /not installed.*aether local pull/s);
    assert.equal(ctx.flags.model, undefined);
  } finally { globalThis.fetch = oldFetch; rmSync(root, { recursive: true, force: true }); }
});

test("a failed local picker yields input ownership and a later draft needs explicit submit", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-ollama-draft-"));
  const ctx = localContext(root);
  const oldFetch = globalThis.fetch;
  const oldWrite = process.stdout.write;
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const raw = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
  let observed = "";
  let rejectTags: ((reason?: unknown) => void) | null = null;
  let modelBody = "";
  let running: Promise<number> | null = null;
  const until = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("waiting for local picker: " + observed.slice(-500));
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  try {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => { observed += String(chunk); return true; }) as typeof process.stdout.write;
    globalThis.fetch = (async () => new Promise<Response>((_resolve, reject) => { rejectTags = reject; })) as typeof fetch;
    running = repl(ctx, { noSkills: true });
    await until(() => observed.includes("\x1b[?2004h"));
    process.stdin.emit("data", Buffer.from("/models\r\r"));
    await until(() => rejectTags !== null);
    process.stdin.emit("data", Buffer.from("unsent draft"));
    rejectTags!(new Error("offline"));
    await until(() => observed.includes("Cannot reach Ollama installed models"));
    assert.equal(ctx.flags.model, undefined);
    assert.equal(modelBody, "", "discovery failure did not submit the draft");
    process.stdin.emit("data", Buffer.from("unsent draft")); // composer owns input again after the modal exits
    globalThis.fetch = (async (_url, init) => {
      modelBody = String(init?.body ?? "");
      return Response.json({ choices: [{ message: { content: "done" } }] });
    }) as typeof fetch;
    process.stdin.emit("data", Buffer.from("\r")); // explicit submit after the error
    await until(() => modelBody.length > 0);
    assert.match(modelBody, /unsent draft/);
    await until(() => observed.includes("done"));
    process.stdin.emit("data", Buffer.from("/exit\r\r"));
    assert.equal(await running, 0);
    running = null;
  } finally {
    if (running) {
      process.stdin.emit("data", Buffer.from("\x03\x03\x04"));
      await Promise.race([running.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1_000))]);
    }
    globalThis.fetch = oldFetch;
    process.stdout.write = oldWrite;
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty); else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    if (raw) Object.defineProperty(process.stdin, "setRawMode", raw); else delete (process.stdin as unknown as { setRawMode?: unknown }).setRawMode;
    rmSync(root, { recursive: true, force: true });
  }
});
