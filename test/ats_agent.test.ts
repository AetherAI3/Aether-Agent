import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createAtsHooks, atsManagedConfig, ATS_PROFILE_MARKER, type AtsHookDeps } from "../src/commands/ats_agent.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { ApiClient } from "../src/core/transport.js";
import { StaticTokenStore } from "../src/core/auth.js";
import type { AppContext } from "../src/core/context.js";
import type { ManagedAgent } from "../src/core/managed_agents.js";
import { bindManagedAgentKeys, cmdManagedAgentChat } from "../src/commands/managed_agents.js";

const ID = "mag_0123456789abcdef";
function context(): AppContext {
  const tokens = new StaticTokenStore("aek_test_cli");
  return { cfg: { ...DEFAULT_CONFIG, baseUrl: "https://example.test/cloud" }, api: new ApiClient("https://example.test/cloud", tokens), tokens,
    flags: { json: false, audit: false, yes: false, cwd: process.cwd() }, confirm: async () => false };
}
const agent = (): ManagedAgent => ({ agent_id: ID, revision: 1, lifecycle_intent: "draft", config: atsManagedConfig("Market Scout"), runtime: { tile_state: "draft", observation: "unavailable" } });
type Package = Awaited<ReturnType<NonNullable<AtsHookDeps["load"]>>>;

function fakePackage(overrides: Partial<Package> = {}): Package {
  return {
    initializeMemory: async (input) => ({ state: "ready", agent_id: input.agentId, directory: input.directory, size_gb: input.sizeGb, persistence_verified: true }),
    scanStrategies: async () => ({ state: "scanned", strategies: [] }),
    createBrowserObserver: async () => ({ open: async () => ({ state: "connected", viewUrl: null }), snapshot: async () => ({}), close: async () => {}, status: () => ({ state: "connected" }) }),
    observeBrowser: async function* () { yield {}; },
    loadSettings: async () => ({ permission_mode: "plan", data_stream: { provider: "none", endpoint: null, api_key_env: null, symbols: [], timeframe: "1m", poll_interval_ms: 5000 } }),
    saveSettings: async () => {},
    cyclePermissionMode: (mode) => mode === "plan" ? "skip" : mode === "skip" ? "danger" : "plan",
    dataStreamStatus: () => ({ state: "unavailable", live_orders_enabled: false }),
    ...overrides,
  };
}

async function fixture(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "aether-ats-hook-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function withCreate(run: () => Promise<void>): Promise<void> {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://example.test/cloud/agent/managed");
    assert.equal(init?.method, "POST");
    return new Response(JSON.stringify({ schema_version: "aether.managed-agents/1", availability: "ok", agent: agent() }), { status: 201 });
  }) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = prior; }
}
function settingsPath(root: string): string {
  const server = createHash("sha256").update("https://example.test").digest("hex").slice(0, 16);
  return join(root, server, ID, "ats.json");
}
async function binding(root: string, override: Record<string, unknown> = {}): Promise<void> {
  const path = settingsPath(root);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ schema_version: "aether.ats.local/1", agent_id: ID, cloud_origin: "https://example.test",
    memory_directory: join(root, "memory"), memory_gb: 5, strategies_directory: join(root, "strategies"), ...override }));
}

test("ATS profile stays an observable, zero-budget draft and never grants trading authority", () => {
  const config = atsManagedConfig("  Market Scout  ");
  assert.equal(config.identity.display_name, "Market Scout");
  assert.equal(config.behavior?.system_prompt?.split("\n")[0], ATS_PROFILE_MARKER);
  assert.equal(config.budget?.total_uvt, 0);
  assert.equal((config["autonomy"] as { mode: string }).mode, "observe");
  assert.equal((config["memory"] as { required_for_activation: boolean }).required_for_activation, true);
  assert.throws(() => atsManagedConfig(" "), /name/);
});

test("ordinary managed agents never load local ATS dependencies", async () => {
  await fixture(async (dir) => {
    let loads = 0;
    const hooks = createAtsHooks({ root: dir, load: async () => { loads++; return fakePackage(); } });
    const ordinary = agent(); ordinary.config.behavior = { system_prompt: "Be helpful." };
    const cleanup = await hooks.beforeChat!(context(), ordinary);
    assert.equal(typeof cleanup, "function");
    await cleanup!();
    assert.equal(loads, 0);
  });
});

test("a quoted ATS marker cannot turn an ordinary agent into a local ATS session", async () => {
  await fixture(async (dir) => {
    const ordinary = agent(); ordinary.config.behavior = { system_prompt: `Explain this marker: ${ATS_PROFILE_MARKER}\nDo not run it.` };
    let loads = 0;
    const hooks = createAtsHooks({ root: dir, load: async () => { loads++; return fakePackage(); } });
    const cleanup = await hooks.beforeChat!(context(), ordinary);
    assert.equal(typeof cleanup, "function");
    await cleanup!();
    assert.equal(loads, 0);
  });
});

test("setup failure preserves the created Cloud draft and never saves a ready local binding", async () => {
  await fixture(async (dir) => {
    let output = "";
    let scans = 0;
    const hooks = createAtsHooks({ root: dir, output: (text) => { output += text; }, setup: async () => ({ memoryGb: 5, strategiesDirectory: join(dir, "strategies") }),
      load: async () => fakePackage({ initializeMemory: async () => ({ state: "unavailable" }), scanStrategies: async () => { scans++; return {}; } }) });
    await withCreate(async () => { assert.equal(await hooks.createATS!(context(), "Market Scout"), 1); });
    assert.match(output, /draft is saved/);
    assert.match(output, /Resume setup/);
    assert.equal(output.includes("ATS setup saved"), false);
    assert.equal(scans, 0);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("successful setup stores an account-scoped binding only after memory and strategy checks", async () => {
  await fixture(async (dir) => {
    const calls: string[] = [];
    const hooks = createAtsHooks({ root: dir, env: {}, output: () => {}, setup: async () => ({ memoryGb: 5, strategiesDirectory: join(dir, "strategies") }),
      load: async () => fakePackage({ initializeMemory: async (input) => { calls.push("memory"); assert.equal(input.agentId, ID); assert.equal(input.sizeGb, 5); return { state: "ready", agent_id: input.agentId, directory: input.directory, size_gb: input.sizeGb, persistence_verified: true }; },
        scanStrategies: async () => { calls.push("scan"); await assert.rejects(readFile(settingsPath(dir)), { code: "ENOENT" }); return { state: "scanned", strategies: [] }; } }) });
    await withCreate(async () => { assert.equal(await hooks.createATS!(context(), "Market Scout"), 0); });
    const saved = JSON.parse(await readFile(settingsPath(dir), "utf8"));
    assert.equal(saved.agent_id, ID);
    assert.equal(saved.cloud_origin, "https://example.test");
    assert.equal(saved.memory_gb, 5);
    assert.deepEqual(calls, ["memory", "scan"]);
  });
});

test("malformed, foreign-agent and foreign-server bindings fail before loading a package", async () => {
  for (const override of [{ agent_id: "mag_fedcba9876543210" }, { cloud_origin: "https://elsewhere.test" }, { memory_gb: 4 }, { memory_directory: "../memory" }]) {
    await fixture(async (dir) => {
      await binding(dir, override);
      const hooks = createAtsHooks({ root: dir, load: async () => { throw new Error("must not load"); } });
      await assert.rejects(hooks.beforeChat!(context(), agent()), /setup is invalid/);
    });
  }
});

test("a symlinked settings ancestor fails closed without invoking package code", async (t) => {
  if (process.platform === "win32") { t.skip("Windows symlink privilege is environment-dependent"); return; }
  await fixture(async (dir) => {
    const target = join(dir, "target"); await mkdir(target);
    const root = join(dir, "link"); await symlink(target, root, "dir");
    const hooks = createAtsHooks({ root, load: async () => { throw new Error("must not load"); } });
    await assert.rejects(hooks.beforeChat!(context(), agent()), /symbolic link/);
  });
});

test("a symlink strategy folder leaves the Cloud draft intact and skips strategy access", async (t) => {
  if (process.platform === "win32") { t.skip("Windows symlink privilege is environment-dependent"); return; }
  await fixture(async (dir) => {
    const target = join(dir, "target"); await mkdir(target);
    const strategies = join(dir, "strategies"); await symlink(target, strategies, "dir");
    let scanned = false;
    const hooks = createAtsHooks({ root: join(dir, "settings"), output: () => {}, setup: async () => ({ memoryGb: 5, strategiesDirectory: strategies }),
      load: async () => fakePackage({ scanStrategies: async () => { scanned = true; return {}; } }) });
    await withCreate(async () => { assert.equal(await hooks.createATS!(context(), "Market Scout"), 1); });
    assert.equal(scanned, false);
  });
});

test("symlink memory folders are refused before native initialization on setup and reopen", async (t) => {
  if (process.platform === "win32") { t.skip("Windows symlink privilege is environment-dependent"); return; }
  await fixture(async (dir) => {
    const target = join(dir, "target"); await mkdir(target);
    const memory = join(dir, "memory"); await symlink(target, memory, "dir");
    const root = join(dir, "settings");
    let initialized = 0;
    const hooks = createAtsHooks({ root, output: () => {}, setup: async () => ({ memoryDirectory: memory, memoryGb: 5, strategiesDirectory: join(dir, "strategies") }),
      load: async () => fakePackage({ initializeMemory: async () => { initialized++; return { state: "ready" }; } }) });
    await withCreate(async () => { assert.equal(await hooks.createATS!(context(), "Market Scout"), 1); });
    await binding(root, { memory_directory: memory });
    await assert.rejects(hooks.beforeChat!(context(), agent()), /symbolic link/);
    assert.equal(initialized, 0);
  });
});

test("native ready receipts must match agent, directory, capacity and verified persistence", async () => {
  for (const override of [{ agent_id: "mag_fedcba9876543210" }, { directory: "/wrong/memory" }, { size_gb: 6 }, { persistence_verified: false }]) {
    await fixture(async (dir) => {
      await binding(dir);
      const hooks = createAtsHooks({ root: dir, env: {}, output: () => {}, load: async () => fakePackage({ initializeMemory: async (input) => ({
        state: "ready", agent_id: input.agentId, directory: input.directory, size_gb: input.sizeGb, persistence_verified: true, ...override,
      }) }) });
      await assert.rejects(hooks.beforeChat!(context(), agent()), /memory|receipt|verified/i);
    });
  }
});

test("ATS mode and data commands persist local settings and invalid requests cannot change them", async () => {
  await fixture(async (dir) => {
    await binding(dir);
    let settings = { permission_mode: "plan", data_stream: { provider: "none", endpoint: null as string | null, api_key_env: null as string | null, symbols: [] as string[], timeframe: "1m", poll_interval_ms: 5000 } };
    let saves = 0;
    let output = "";
    const pack = fakePackage({ loadSettings: async () => structuredClone(settings), saveSettings: async (_path, value) => { saves++; settings = structuredClone(value); } });
    const hooks = createAtsHooks({ root: dir, env: {}, output: (text) => { output += text; }, load: async () => pack });
    assert.equal(await hooks.onChatCommand!(context(), agent(), "/other"), false);
    assert.equal(await hooks.onChatCommand!(context(), agent(), "/ats mode danger"), true);
    assert.equal(settings.permission_mode, "danger");
    await hooks.cycleMode!(context(), agent());
    assert.equal(settings.permission_mode, "plan");
    assert.match(output, /live orders remain disabled/);
    assert.equal(saves, 2);
    await assert.rejects(hooks.onChatCommand!(context(), agent(), "/ats mode live"), /plan\|skip\|danger/);
    await assert.rejects(hooks.onChatCommand!(context(), agent(), "/ats data set bogus"), /Use \/ats data/);
    await assert.rejects(hooks.onChatCommand!(context(), agent(), "/ats data set yfinance https://example.test"), /no endpoint/);
    assert.equal(saves, 2);
    await hooks.onChatCommand!(context(), agent(), "/ats data set yfinance");
    await hooks.onChatCommand!(context(), agent(), "/ats data symbols aapl,msft");
    assert.equal(settings.data_stream.provider, "yfinance");
    assert.deepEqual(settings.data_stream.symbols, ["AAPL", "MSFT"]);
    assert.equal(saves, 4);
  });
});

test("chat without a browser connection keeps storage ready and reports unavailable honestly", async () => {
  await fixture(async (dir) => {
    await binding(dir);
    let output = "";
    const hooks = createAtsHooks({ root: dir, env: {}, output: (text) => { output += text; }, load: async () => fakePackage({ createBrowserObserver: async () => { throw new Error("must not open"); } }) });
    const cleanup = await hooks.beforeChat!(context(), agent());
    assert.equal(typeof cleanup, "function");
    await cleanup!();
    assert.match(output, /Browser unavailable/);
    assert.match(output, /local execution is not connected/);
  });
});

test("browser opening failure releases the observer and keeps text chat available", async () => {
  await fixture(async (dir) => {
    await binding(dir);
    let closes = 0;
    let output = "";
    const hooks = createAtsHooks({ root: dir, env: { AGENT_BROWSER_CONTROLLER_TOKEN: "fixture-token" }, output: (text) => { output += text; },
      load: async () => fakePackage({ createBrowserObserver: async () => ({ open: async () => { throw new Error("no slot"); }, close: async () => { closes++; }, snapshot: async () => ({}), status: () => ({ state: "unavailable" }) }) }) });
    const cleanup = await hooks.beforeChat!(context(), agent());
    assert.equal(typeof cleanup, "function");
    await cleanup!();
    assert.equal(closes, 1);
    assert.match(output, /Browser unavailable.*aether-browser@0.2.2 doctor/);
    assert.match(output, /Text chat remains available/);
  });
});

test("failed browser release is reported and retried when the text chat closes", async () => {
  await fixture(async (dir) => {
    await binding(dir);
    let closes = 0;
    let output = "";
    const hooks = createAtsHooks({ root: dir, env: { AGENT_BROWSER_CONTROLLER_TOKEN: "fixture-token" }, output: (text) => { output += text; },
      load: async () => fakePackage({ createBrowserObserver: async () => ({
        open: async () => { throw new Error("offline"); },
        close: async () => { closes++; if (closes === 1) throw new Error("release failed"); },
        snapshot: async () => ({}), status: () => ({ state: "cleanup_required" }),
      }) }) });
    const cleanup = await hooks.beforeChat!(context(), agent());
    assert.equal(closes, 1);
    assert.equal(typeof cleanup, "function");
    assert.match(output, /cleanup needs attention/);
    await cleanup!();
    assert.equal(closes, 2);
  });
});

test("browser dependency connection failure leaves account chat usable", async () => {
  await fixture(async (dir) => {
    await binding(dir);
    let output = "";
    const hooks = createAtsHooks({ root: dir, env: { AGENT_BROWSER_CONTROLLER_TOKEN: "fixture-token" }, output: (text) => { output += text; },
      load: async () => fakePackage({ createBrowserObserver: async () => { throw new Error("cannot connect"); } }) });
    const cleanup = await hooks.beforeChat!(context(), agent());
    assert.equal(typeof cleanup, "function");
    await cleanup!();
    assert.match(output, /Browser unavailable.*aether-browser@0.2.2 doctor/);
    assert.match(output, /Text chat remains available/);
  });
});

test("chat cleanup aborts the observation iterator and releases its exact browser session", async () => {
  await fixture(async (dir) => {
    await binding(dir);
    let closes = 0;
    let aborted = false;
    let stopped = false;
    const hooks = createAtsHooks({ root: dir, env: { AGENT_BROWSER_CONTROLLER_TOKEN: "fixture-token" }, output: () => {},
      load: async () => fakePackage({
        createBrowserObserver: async () => ({ open: async () => ({ viewUrl: null, state: "connected" }), close: async () => { closes++; }, snapshot: async () => ({}), status: () => ({ state: "connected" }) }),
        observeBrowser: async function* (_observer, { signal }) {
          yield {};
          await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
          aborted = signal.aborted; stopped = true;
        },
      }) });
    const cleanup = await hooks.beforeChat!(context(), agent());
    assert.equal(typeof cleanup, "function");
    await cleanup!();
    assert.equal(closes, 1);
    assert.equal(aborted, true);
    assert.equal(stopped, true);
  });
});

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("Shift-Tab invokes one mode cycle at a time; other keys and repeats cannot grant extra cycles", async () => {
  const input = new EventEmitter();
  let cycles = 0;
  let redraws = 0;
  let release: () => void = () => {};
  const errors: unknown[] = [];
  const remove = bindManagedAgentKeys(input, async () => {
    cycles++;
    await new Promise<void>((resolve) => { release = resolve; });
  }, () => { redraws++; }, (error) => errors.push(error));
  assert.equal(input.listenerCount("keypress"), 1);
  input.emit("keypress", "\t", { name: "tab", shift: false });
  input.emit("keypress", "", { name: "tab", shift: true, ctrl: true });
  assert.equal(cycles, 0);
  input.emit("keypress", "\x1b[Z", { name: "tab", shift: true });
  input.emit("keypress", "\x1b[Z", { name: "tab", shift: true });
  await tick();
  assert.equal(cycles, 1);
  release(); await tick();
  assert.equal(redraws, 1);
  input.emit("keypress", "\x1b[Z", { name: "tab", shift: true });
  await tick();
  assert.equal(cycles, 2);
  remove(); release(); await tick();
  assert.equal(input.listenerCount("keypress"), 0);
  assert.equal(redraws, 1);
  assert.deepEqual(errors, []);
});

test("Shift-Tab failures are reported without unhandled rejections and its listener can be removed before execution", async () => {
  const input = new EventEmitter();
  let calls = 0;
  const errors: unknown[] = [];
  const remove = bindManagedAgentKeys(input, async () => { calls++; throw new Error("mode unavailable"); }, () => {}, (error) => errors.push(error));
  input.emit("keypress", "", { name: "tab", shift: true });
  await tick();
  assert.equal(calls, 1); assert.equal(errors.length, 1);
  input.emit("keypress", "", { name: "tab", shift: true });
  remove(); await tick();
  assert.equal(calls, 1);
});

test("managed chat routes local slash hooks sequentially and never sends their contents as a Cloud DM", async () => {
  const prior = globalThis.fetch;
  const input = new PassThrough();
  let output = "";
  const out = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  const commands: string[] = [];
  let sends = 0;
  let initialized = false;
  let closeSession = false;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/thread")) return new Response(JSON.stringify({ id: "thread-1" }));
    if (String(url).includes("/messages")) {
      if (init?.method === "POST") { sends++; throw new Error("must not send local commands"); }
      if (!initialized) { initialized = true; setImmediate(() => input.end("/ats status\n/ats bad\n/ats scan\n/unknown\n/exit\n")); }
      return new Response(JSON.stringify({ messages: [] }));
    }
    return new Response(JSON.stringify({ schema_version: "aether.managed-agents/1", availability: "ok", agent: agent() }));
  }) as typeof fetch;
  try {
    assert.equal(await cmdManagedAgentChat(context(), ID, "", { input, out, err: out, hooks: {
      beforeChat: async () => async () => { closeSession = true; },
      onChatCommand: async (_ctx, _agent, command) => { commands.push(command + ":start"); await tick(); commands.push(command + ":end"); if (command === "/ats bad") throw new Error("invalid ATS settings"); return command.startsWith("/ats "); },
      help: () => "/ats status · Shift-Tab mode",
    } }), 0, output);
    assert.deepEqual(commands, ["/ats status:start", "/ats status:end", "/ats bad:start", "/ats bad:end", "/ats scan:start", "/ats scan:end", "/unknown:start", "/unknown:end"]);
    assert.equal(sends, 0);
    assert.equal(closeSession, true);
    assert.match(output, /Shift-Tab mode/);
    assert.match(output, /Use \/refresh or \/exit/);
    assert.match(output, /invalid ATS settings/);
    assert.equal(input.listenerCount("keypress"), 0);
  } finally { globalThis.fetch = prior; input.destroy(); }
});

test("managed TTY queues Shift-Tab after the active command and removes its listener on exit", async () => {
  const prior = globalThis.fetch;
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode(_enabled: boolean) { return this; } });
  const out = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const order: string[] = [];
  let started = false;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/thread")) return new Response(JSON.stringify({ id: "thread-1" }));
    if (String(url).includes("/messages")) {
      if (!started) { started = true; setImmediate(() => input.write("/ats wait\n")); }
      return new Response(JSON.stringify({ messages: [] }));
    }
    return new Response(JSON.stringify({ schema_version: "aether.managed-agents/1", availability: "ok", agent: agent() }));
  }) as typeof fetch;
  try {
    const timeout = new AbortController();
    const deadline = setTimeout(() => timeout.abort(), 2000);
    try {
      assert.equal(await cmdManagedAgentChat(context(), ID, "", { input, out, err: out, signal: timeout.signal, hooks: {
        onChatCommand: async () => {
          order.push("command:start");
          input.emit("keypress", "\x1b[Z", { name: "tab", shift: true });
          input.emit("keypress", "\x1b[Z", { name: "tab", shift: true });
          await tick();
          assert.deepEqual(order, ["command:start"]);
          order.push("command:end");
          return true;
        },
        cycleMode: async () => { order.push("cycle"); setImmediate(() => input.end("/exit\n")); },
      } }), 0);
    } finally { clearTimeout(deadline); }
    assert.deepEqual(order, ["command:start", "command:end", "cycle"]);
    assert.equal(input.listenerCount("keypress"), 0);
  } finally { globalThis.fetch = prior; input.destroy(); }
});

test("ordinary agents gain explicit browser controls without triggering ATS memory setup", async () => {
  await fixture(async (dir) => {
    const ordinary = agent(); ordinary.config.behavior = { system_prompt: "Be helpful." };
    let loads = 0, closes = 0, rendered = "";
    const hooks = createAtsHooks({ root: dir, env: {}, output: () => { throw new Error("must use chat surface"); }, openViewer: async () => ({ launched: true }),
      load: async () => { loads++; return fakePackage({ initializeMemory: async () => { throw new Error("must not initialize ATS memory"); }, createBrowserObserver: async () => ({
        open: async () => ({ state: "connected", viewUrl: "http://127.0.0.1:6080/vnc.html" }), snapshot: async () => ({}), close: async () => { closes++; }, status: () => ({ state: "connected" }),
      }) }); } });
    const surface = { write: (text: string) => { rendered += text; }, signal: new AbortController().signal };
    const cleanup = await hooks.beforeChat!(context(), ordinary, surface);
    assert.equal(loads, 0);
    assert.equal(await hooks.onChatCommand!(context(), ordinary, "/browser open", surface), true);
    assert.equal(loads, 1);
    assert.match(rendered, /Browser viewer launch requested/);
    assert.doesNotMatch(rendered, /local memory verified/);
    await cleanup!(); assert.equal(closes, 1);
  });
});

test("background visual status preserves an edited TTY draft through the real readline chat loop", async () => {
  const previous = globalThis.fetch;
  const previousTerm = process.env["TERM"];
  process.env["TERM"] = "xterm";
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode(_enabled: boolean) { return this; } });
  let rendered = "", emitStatus: (text: string) => void = () => {}, started = false;
  const sent: string[] = [];
  const out = Object.assign(new Writable({ write(chunk, _encoding, done) { rendered += String(chunk); done(); } }), { columns: 20 });
  const timeout = new AbortController();
  const deadline = setTimeout(() => timeout.abort(), 2000);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/thread")) return new Response(JSON.stringify({ id: "thread-1" }));
    if (String(url).includes("/messages")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)); sent.push(body.body);
        return new Response(JSON.stringify({ message: { id: "message-1", body: body.body }, admission: { state: "saved" } }));
      }
      if (!started) {
        started = true;
        setImmediate(() => {
          input.write("keep this long visual draft");
          input.write("\x1b[D\x1b[D");
          emitStatus("Browser  ● LIVE\nFresh frame verified\n");
          input.end("X\n/exit\n");
        });
      }
      return new Response(JSON.stringify({ messages: [] }));
    }
    return new Response(JSON.stringify({ schema_version: "aether.managed-agents/1", availability: "ok", agent: agent() }));
  }) as typeof fetch;
  try {
    assert.equal(await cmdManagedAgentChat(context(), ID, "", { input, out, err: out, signal: timeout.signal, hooks: {
      beforeChat: async (_ctx, _agent, surface) => { emitStatus = surface!.write; },
    } }), 0, rendered);
    assert.deepEqual(sent, ["keep this long visual draXft"]);
    assert.match(rendered, /Fresh frame verified/);
    assert.equal(input.listenerCount("keypress"), 0);
  } finally {
    clearTimeout(deadline); globalThis.fetch = previous; input.destroy();
    if (previousTerm === undefined) delete process.env["TERM"]; else process.env["TERM"] = previousTerm;
  }
});
