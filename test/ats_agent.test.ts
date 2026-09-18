import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { managedAgentStorageDirectory } from "../src/core/managed_agent_local.js";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createAtsHooks, atsManagedConfig, ATS_PROFILE_MARKER, askSetup, type AtsHookDeps } from "../src/commands/ats_agent.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { ApiClient } from "../src/core/transport.js";
import { StaticTokenStore } from "../src/core/auth.js";
import type { AppContext } from "../src/core/context.js";
import type { ManagedAgent } from "../src/core/managed_agents.js";
import { bindManagedAgentKeys, cmdManagedAgentChat } from "../src/commands/managed_agents.js";
import { BrowserSessionRecovery } from "aether-ats-skills";

const ID = "mag_0123456789abcdef";
const SUBJECT = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = { cloudOrigin: "https://example.test", accountSubject: SUBJECT };
const identity = (): Response => new Response(JSON.stringify({ schema_version: "aether.terminal-account/1", account_subject: SUBJECT }));
function context(): AppContext {
  const tokens = new StaticTokenStore("aek_test_cli");
  return { cfg: { ...DEFAULT_CONFIG, baseUrl: "https://example.test/cloud" }, api: new ApiClient("https://example.test/cloud", tokens), tokens,
    flags: { json: false, audit: false, yes: false, cwd: process.cwd() }, confirm: async () => false };
}
const agent = (): ManagedAgent => ({ agent_id: ID, revision: 1, lifecycle_intent: "draft", config: atsManagedConfig("Market Scout"), runtime: { tile_state: "draft", observation: "unavailable" } });
type Package = Awaited<ReturnType<NonNullable<AtsHookDeps["load"]>>>;

function memoryReceipt(input: { agentId: string; directory: string; sizeGb: number; ownerScope: typeof ACCOUNT }): Record<string, unknown> {
  return { state: "ready", schema_version: "aether.ats.memory/1", agent_id: input.agentId, directory: input.directory, size_gb: input.sizeGb,
    backend: "aether-context", runtime_version: "0.3.1", persistence_verified: true, ceiling_bytes: input.sizeGb * 1024 ** 3,
    quota_kind: "native_slice_accounting", reserved_bytes: 0, lock_scope: "ats_setup_only", runtime_exclusivity_verified: false,
    verification_kind: "persisted_snapshot_reopen", owner_scope: { cloud_origin: input.ownerScope.cloudOrigin, account_subject: input.ownerScope.accountSubject } };
}

function fakePackage(overrides: Partial<Package> = {}): Package {
  return {
    BrowserSessionRecovery,
    initializeMemory: async (input) => memoryReceipt(input),
    acquireMemoryWriterLease: async (input) => ({ receipt: { state: "leased", lock_scope: "ats_runtime_writer", runtime_exclusivity_verified: true,
      agent_id: input.agentId, directory: input.directory, owner_scope: input.ownerScope }, close: async () => {} }),
    scanStrategies: async () => ({ state: "scanned", compiler: "unavailable", strategies: [{ file: "existing.nano", state: "unavailable" }] }),
    listBundledStrategies: async () => ({ revision: "76c91e4b926c0aa8416cbb6b8724031d8141a8d9", nano_version: "1.0.12", strategies: [], execution_enabled: false }),
    installBundledStrategies: async ({ directory }) => ({ revision: "76c91e4b926c0aa8416cbb6b8724031d8141a8d9", installed: [{ id: "risk/stale_data_halt", file: join(directory, "risk--stale_data_halt.nano") }], execution_enabled: false, permission_granted: false }),
    appendJournalEvent: async () => ({}),
    readJournal: async () => [],
    formatJournal: () => "ATS journal · no local events\n",
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
  const prior = globalThis.fetch;
  globalThis.fetch = (async (url) => { if (String(url).endsWith("/agent/managed/identity")) return identity(); throw new Error(`Unexpected offline fixture request: ${String(url)}`); }) as typeof fetch;
  try { await run(dir); } finally { globalThis.fetch = prior; await rm(dir, { recursive: true, force: true }); }
}
async function withCreate(run: () => Promise<void>): Promise<void> {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/agent/managed/identity")) return identity();
    assert.ok(["https://example.test/cloud/agent/managed", `https://example.test/cloud/agent/managed/${ID}`].includes(String(url)));
    assert.equal(init?.method, String(url).endsWith(ID) ? "GET" : "POST");
    return new Response(JSON.stringify({ schema_version: "aether.managed-agents/1", availability: "ok", agent: agent() }), { status: 201 });
  }) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = prior; }
}
function settingsPath(root: string): string {
  return join(managedAgentStorageDirectory(root, ACCOUNT, ID), "ats.json");
}
async function binding(root: string, override: Record<string, unknown> = {}): Promise<void> {
  const path = settingsPath(root);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ schema_version: "aether.ats.local/2", account_subject: SUBJECT, agent_id: ID, cloud_origin: "https://example.test",
    memory_directory: join(root, "memory"), memory_gb: 5, strategies_directory: join(root, "strategies"), ...override }));
}

test("ATS profile stays an observable, zero-budget draft and never grants trading authority", () => {
  const config = atsManagedConfig("  Market Scout  ");
  assert.equal(config.identity.display_name, "Market Scout");
  assert.deepEqual(config.profile, { schema_version: "aether.managed-agent.profile/1", kind: "ats" });
  assert.doesNotMatch(config.behavior?.system_prompt ?? "", /aether\.ats\.profile/);
  assert.equal(config.budget?.total_uvt, 0);
  assert.equal((config["autonomy"] as { mode: string }).mode, "observe");
  assert.equal((config["memory"] as { required_for_activation: boolean }).required_for_activation, true);
  assert.throws(() => atsManagedConfig(" "), /name/);
});

test("rejecting the ATS policy stops before draft, storage, strategy and connector setup", async () => {
  await fixture(async (dir) => {
    let setupCalls = 0;
    let loads = 0;
    let output = "";
    const hooks = createAtsHooks({
      root: dir,
      output: text => { output += text; },
      acceptPolicy: async () => false,
      setup: async () => { setupCalls++; return { memoryGb: 5, strategiesDirectory: join(dir, "strategies") }; },
      load: async () => { loads++; return fakePackage(); },
    });
    assert.equal(await hooks.createATS!(context(), "Market Scout"), 2);
    assert.equal(setupCalls, 0);
    assert.equal(loads, 0);
    assert.match(output, /No agent, storage, strategy, datafeed, browser, plugin, or MCP setup was created/);
  });
});

test("ordinary managed agents never load local ATS dependencies", async () => {
  await fixture(async (dir) => {
    let loads = 0;
    const hooks = createAtsHooks({ root: dir, load: async () => { loads++; return fakePackage(); } });
    const ordinary = agent(); delete ordinary.config.profile; ordinary.config.behavior = { system_prompt: "Be helpful." };
    const cleanup = await hooks.beforeChat!(context(), ordinary);
    assert.equal(typeof cleanup, "function");
    await cleanup!();
    assert.equal(loads, 0);
  });
});

test("a quoted ATS marker cannot turn an ordinary agent into a local ATS session", async () => {
  await fixture(async (dir) => {
    const ordinary = agent(); delete ordinary.config.profile; ordinary.config.behavior = { system_prompt: `Explain this marker: ${ATS_PROFILE_MARKER}\nDo not run it.` };
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
    const hooks = createAtsHooks({ root: dir, output: (text) => { output += text; }, acceptPolicy: async () => true, setup: async () => ({ memoryGb: 5, strategiesDirectory: join(dir, "strategies") }),
      load: async () => fakePackage({ initializeMemory: async () => ({ state: "unavailable" }), scanStrategies: async () => { scans++; return {}; } }) });
    await withCreate(async () => { assert.equal(await hooks.createATS!(context(), "Market Scout"), 1); });
    assert.match(output, /agent is saved/);
    assert.match(output, /Resume setup/);
    assert.equal(output.includes("ATS setup saved"), false);
    assert.equal(scans, 0);
    await assert.rejects(readFile(settingsPath(dir)), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(settingsPath(dir) + ".pending", "utf8")).agent_id, ID);
  });
});

test("ATS setup surfaces a safe actionable memory-engine failure", async () => {
  await fixture(async (dir) => {
    let output = "";
    const hooks = createAtsHooks({ root: dir, output: (text) => { output += text; }, acceptPolicy: async () => true, setup: async () => ({ memoryGb: 5, strategiesDirectory: join(dir, "strategies") }),
      load: async () => fakePackage({ initializeMemory: async () => ({ state: "unavailable", code: "CONTEXT_ENGINE_UNAVAILABLE", message: "Install the pinned aether-context engine, or select its Python interpreter." }) }) });
    await withCreate(async () => { assert.equal(await hooks.createATS!(context(), "Market Scout"), 1); });
    assert.match(output, /CONTEXT_ENGINE_UNAVAILABLE/);
    assert.match(output, /Install the pinned aether-context engine/);
    assert.doesNotMatch(output, /token|api.?key|aek_/i);
  });
});

test("successful setup stores an account-scoped binding only after memory and strategy checks", async () => {
  await fixture(async (dir) => {
    const calls: string[] = [];
    const hooks = createAtsHooks({ root: dir, env: {}, output: () => {}, acceptPolicy: async () => true, setup: async () => ({ memoryGb: 5, strategiesDirectory: join(dir, "strategies") }),
      load: async () => fakePackage({ initializeMemory: async (input) => { calls.push("memory"); assert.equal(input.agentId, ID); assert.equal(input.sizeGb, 5); return memoryReceipt(input); },
        scanStrategies: async () => { calls.push("scan"); await assert.rejects(readFile(settingsPath(dir)), { code: "ENOENT" }); return { state: "scanned", strategies: [] }; } }) });
    await withCreate(async () => { assert.equal(await hooks.createATS!(context(), "Market Scout"), 0); });
    const saved = JSON.parse(await readFile(settingsPath(dir), "utf8"));
    assert.equal(saved.agent_id, ID);
    assert.equal(saved.cloud_origin, "https://example.test");
    assert.equal(saved.account_subject, SUBJECT);
    assert.equal(saved.schema_version, "aether.ats.local/2");
    assert.equal(saved.memory_gb, 5);
    assert.deepEqual(calls, ["memory", "scan", "scan"]);
  });
});

test("empty first setup installs the reviewed Nano starter pack and journals the result", async () => {
  await fixture(async dir => {
    let scans = 0; let installs = 0; const events: string[] = []; let output = "";
    const hooks = createAtsHooks({ root: dir, env: {}, output: text => { output += text; },
      acceptPolicy: async () => true, setup: async () => ({ memoryGb: 5, strategiesDirectory: join(dir, "strategies") }),
      load: async () => fakePackage({
        scanStrategies: async () => ({ state: "scanned", compiler: "unavailable", strategies: scans++ ? [{ file: "risk--stale_data_halt.nano", state: "unavailable" }] : [] }),
        installBundledStrategies: async ({ directory }) => { installs++; return { revision: "76c91e4b926c0aa8416cbb6b8724031d8141a8d9", installed: [{ id: "risk/stale_data_halt", file: join(directory, "risk--stale_data_halt.nano") }], execution_enabled: false, permission_granted: false }; },
        appendJournalEvent: async (_path, event) => { events.push(event.type); return {}; },
      }) });
    await withCreate(async () => { assert.equal(await hooks.createATS!(context(), "Atlas"), 0); });
    assert.equal(installs, 1); assert.equal(scans, 2);
    assert.deepEqual(events, ["strategy.library_installed", "setup.ready"]);
    assert.match(output, /no execution authority granted/);
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
    const hooks = createAtsHooks({ root: join(dir, "settings"), output: () => {}, acceptPolicy: async () => true, setup: async () => ({ memoryGb: 5, strategiesDirectory: strategies }),
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
    const hooks = createAtsHooks({ root, output: () => {}, acceptPolicy: async () => true, setup: async () => ({ memoryDirectory: memory, memoryGb: 5, strategiesDirectory: join(dir, "strategies") }),
      load: async () => fakePackage({ initializeMemory: async () => { initialized++; return { state: "ready" }; } }) });
    await withCreate(async () => { assert.equal(await hooks.createATS!(context(), "Market Scout"), 1); });
    await binding(root, { memory_directory: memory });
    await assert.rejects(hooks.beforeChat!(context(), agent()), /symbolic link/);
    assert.equal(initialized, 0);
  });
});

test("native ready receipts must match agent, directory, capacity and verified persistence", async () => {
  for (const override of [{ agent_id: "mag_fedcba9876543210" }, { directory: "/wrong/memory" }, { size_gb: 6 }, { persistence_verified: false }, { runtime_version: "0.3.2" }, { backend: "settings-only" }, { owner_scope: { cloud_origin: ACCOUNT.cloudOrigin, account_subject: "22222222-2222-4222-8222-222222222222" } }, { runtime_exclusivity_verified: true }, { reserved_bytes: 5 }]) {
    await fixture(async (dir) => {
      await binding(dir);
      const hooks = createAtsHooks({ root: dir, env: {}, output: () => {}, load: async () => fakePackage({ initializeMemory: async (input) => ({
        ...memoryReceipt(input), ...override,
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

test("ATS chat holds the runtime memory writer lease until its resources close", async () => {
  await fixture(async dir => {
    await binding(dir); let acquired = 0; let released = 0; let memoryContext = "";
    const hooks = createAtsHooks({ root: dir, env: {}, output: () => {}, load: async () => fakePackage({
      acquireMemoryWriterLease: async input => { acquired++; return { receipt: { state: "leased", lock_scope: "ats_runtime_writer", runtime_exclusivity_verified: true, directory: input.directory }, close: async () => { released++; } }; },
    }) });
    const cleanup = await hooks.beforeChat!(context(), agent(), { write: () => {}, signal: new AbortController().signal,
      setContext: context => { memoryContext = context.memory ?? memoryContext; } });
    assert.equal(acquired, 1); assert.equal(released, 0); assert.match(memoryContext, /writer leased 5 GiB/);
    await cleanup!(); assert.equal(released, 1);
  });
});

test("a second local chat cannot steal the first chat's writer lease or browser", async () => {
  await fixture(async dir => {
    await binding(dir); let releases = 0; let browserCloses = 0;
    const hooks = createAtsHooks({ root: dir, env: {}, output: () => {}, load: async () => fakePackage({
      acquireMemoryWriterLease: async input => ({ receipt: { state: "leased", lock_scope: "ats_runtime_writer", runtime_exclusivity_verified: true, directory: input.directory }, close: async () => { releases++; } }),
      createBrowserObserver: async () => ({ open: async () => ({ state: "connected", viewUrl: null }), snapshot: async () => ({}), close: async () => { browserCloses++; }, status: () => ({ state: "connected" }) }),
    }) });
    const first = { write: () => {}, signal: new AbortController().signal };
    const cleanup = await hooks.beforeChat!(context(), agent(), first);
    await assert.rejects(hooks.beforeChat!(context(), agent(), { write: () => {}, signal: new AbortController().signal }), /already has an open local chat/);
    assert.equal(releases, 0); assert.equal(browserCloses, 0);
    await cleanup!(); assert.equal(releases, 1); assert.equal(browserCloses, 1);
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

test("pending browser cleanup is explicit and chat close retries a failed release", async () => {
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
    assert.equal(closes, 0, "opening must not automatically reconcile an uncertain creation");
    assert.match(output, /cleanup is pending/);
    await hooks.onChatCommand!(context(), agent(), "/browser stop");
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
  const priorTerm = process.env["TERM"];
  delete process.env["TERM"];
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
          input.write("\x1b[Z");
          input.write("\x1b[Z");
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
  } finally { globalThis.fetch = prior; input.destroy();
    if (priorTerm === undefined) delete process.env["TERM"]; else process.env["TERM"] = priorTerm;
  }
});

test("ordinary agents gain explicit browser controls without triggering ATS memory setup", async () => {
  await fixture(async (dir) => {
    const ordinary = agent(); delete ordinary.config.profile; ordinary.config.behavior = { system_prompt: "Be helpful." };
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

for (const cancelAt of [-1, 0, 1, 2, 3]) {
  test(`ATS wizard exclusively owns stdin and restores coding input after ${cancelAt < 0 ? "success" : `cancel at question ${cancelAt + 1}`}`, async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: true, setRawMode(raw: boolean) { this.isRaw = raw; return this; } });
    const queued: string[] = [];
    const coding = (chunk: Buffer): void => { queued.push(chunk.toString()); };
    input.on("data", coding);
    const prompts = ["Memory drive/folder", "Memory size in GiB", "Strategy folder", "Data provider:"];
    const asked = new Set<number>();
    const answers = ["/fixture/memory\r", "5\r", "/fixture/strategies\r", "none\r"];
    const out = new Writable({ write(chunk, _encoding, done) {
      const text = String(chunk);
      for (const [index, prompt] of prompts.entries()) {
        if (text.includes(prompt) && !asked.has(index)) {
          asked.add(index);
          setImmediate(() => input.write(index === cancelAt ? "\x03" : answers[index]!));
        }
      }
      done();
    } });
    try {
      if (cancelAt < 0) assert.equal((await askSetup(undefined, input, out)).memoryGb, 5);
      else await assert.rejects(askSetup(undefined, input, out), { name: "AbortError" });
      assert.deepEqual(queued, []);
      assert.equal(input.isRaw, true);
      assert.deepEqual(input.listeners("data"), [coding]);
      input.write("after setup");
      assert.deepEqual(queued, ["after setup"]);
    } finally { input.destroy(); }
  });
}

test("setup checkpoint resumes a verified custom memory location after strategy failure", async () => {
  await fixture(async (dir) => {
    let scans = 0, questions = 0;
    const memory = join(dir, "custom-memory");
    const pack = fakePackage({ scanStrategies: async () => { if (++scans === 1) throw new Error("scan failed"); return { state: "scanned", strategies: [] }; } });
    const deps = { root: dir, env: {}, output: () => {}, load: async () => pack,
      acceptPolicy: async () => true, setup: async () => { questions++; return { memoryDirectory: memory, memoryGb: 5, strategiesDirectory: join(dir, "strategies") }; } };
    await withCreate(async () => { assert.equal(await createAtsHooks(deps).createATS!(context(), "Market Scout"), 1); });
    const canonicalMemory = await realpath(memory);
    const pending = JSON.parse(await readFile(settingsPath(dir) + ".pending", "utf8"));
    assert.equal(pending.memory_directory, canonicalMemory);
    assert.equal(pending.memory_verification.persistence_verified, true);
    const cleanup = await createAtsHooks(deps).beforeChat!(context(), agent());
    await cleanup!();
    assert.equal(questions, 1); assert.equal(scans, 3);
    assert.equal(JSON.parse(await readFile(settingsPath(dir), "utf8")).memory_directory, canonicalMemory);
    await assert.rejects(readFile(settingsPath(dir) + ".pending"), { code: "ENOENT" });
  });
});

test("ATS status reports paused Cloud sync independently of verified local memory", async () => {
  await fixture(async (dir) => {
    await binding(dir); let output = "";
    const hooks = createAtsHooks({ root: dir, load: async () => fakePackage(), output: text => { output += text; } });
    await hooks.onChatCommand!(context(), agent(), "/ats status", { signal: new AbortController().signal,
      write: text => { output += text; }, connection: () => ({ chat: "paused", checkedAt: 1 }) });
    assert.match(output, /Cloud chat: paused/);
    assert.doesNotMatch(output, /chat is synced/);
  });
});

test("setup persists provider configuration through the ATS validator without claiming a connection", async () => {
  await fixture(async (dir) => {
    const packageName = "aether-ats-skills";
    const real = await import(packageName);
    let output = "";
    const hooks = createAtsHooks({ root: dir, env: {}, output: text => { output += text; },
      acceptPolicy: async () => true, setup: async () => ({ memoryGb: 5, strategiesDirectory: join(dir, "strategies"),
        dataStream: { provider: "polygon", endpoint: null, api_key_env: "POLYGON_API_KEY", symbols: ["AAPL", "MSFT"] } }),
      load: async () => fakePackage({ loadSettings: real.loadSettings, saveSettings: real.saveSettings, dataStreamStatus: real.dataStreamStatus }),
    });
    await withCreate(async () => { assert.equal(await hooks.createATS!(context(), "Market Scout"), 0); });
    const settings = await real.loadSettings(join(settingsPath(dir), "..", "settings.json"));
    assert.equal(settings.data_stream.provider, "polygon");
    assert.deepEqual(settings.data_stream.symbols, ["AAPL", "MSFT"]);
    assert.equal(settings.data_stream.api_key_env, "POLYGON_API_KEY");
    assert.match(output, /Data: polygon · unverified/);
    assert.equal(real.dataStreamStatus(settings).connected, false);
  });
});

test("memory and strategy setup receive cancellation and cannot publish a ready binding after abort", async () => {
  await fixture(async (dir) => {
    const controller = new AbortController(); let scans = 0;
    const hooks = createAtsHooks({ root: dir, output: () => {}, acceptPolicy: async () => true, setup: async () => ({ memoryGb: 5, strategiesDirectory: join(dir, "strategies") }),
      load: async () => fakePackage({ initializeMemory: async input => {
        assert.equal(input.signal, controller.signal); controller.abort();
        return memoryReceipt(input);
      }, scanStrategies: async () => { scans++; return {}; } }),
    });
    await withCreate(async () => { assert.equal(await hooks.createATS!(context(), "Market Scout", controller.signal), 130); });
    assert.equal(scans, 0);
    await assert.rejects(readFile(settingsPath(dir)), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(settingsPath(dir) + ".pending", "utf8")).agent_id, ID);
  });
});

test("typed ATS profile survives prompt customization, while an exact legacy marker grants no local tools", async () => {
  await fixture(async (dir) => {
    const typed = agent(); typed.config.behavior = { system_prompt: "Use a concise tone." };
    await binding(dir); let calls = 0;
    const hooks = createAtsHooks({ root: dir, env: {}, output: () => {}, load: async () => { calls++; return fakePackage(); } });
    const cleanup = await hooks.beforeChat!(context(), typed); await cleanup!(); assert.ok(calls > 0);
    const legacy = agent(); delete legacy.config.profile; legacy.config.behavior = { system_prompt: `${ATS_PROFILE_MARKER}\nLegacy prompt` };
    calls = 0; let output = "";
    const legacyHooks = createAtsHooks({ root: dir, output: text => { output += text; }, load: async () => { calls++; return fakePackage(); } });
    const close = await legacyHooks.beforeChat!(context(), legacy); await close!();
    assert.equal(calls, 0); assert.match(output, /explicitly migrate/);
    await legacyHooks.cycleMode!(context(), legacy); assert.equal(calls, 0);
  });
});

test("legacy origin-only memory binding is preserved and cannot be silently adopted", async () => {
  await fixture(async (dir) => {
    const legacy = join(dir, createHash("sha256").update(ACCOUNT.cloudOrigin).digest("hex").slice(0, 16), ID, "ats.json");
    await mkdir(join(legacy, ".."), { recursive: true }); await writeFile(legacy, '{"schema_version":"aether.ats.local/1"}');
    let loads = 0;
    const hooks = createAtsHooks({ root: dir, load: async () => { loads++; return fakePackage(); } });
    await assert.rejects(hooks.beforeChat!(context(), agent()), /Legacy ATS setup.*explicit migration/);
    assert.equal(loads, 0); assert.equal(await readFile(legacy, "utf8"), '{"schema_version":"aether.ats.local/1"}');
  });
});

test("fresh account identity separates memory bindings after sign-in changes and fails closed offline", async () => {
  await fixture(async (dir) => {
    await binding(dir); let loads = 0; let subject = SUBJECT; let identityCalls = 0;
    globalThis.fetch = (async () => { identityCalls++; return new Response(JSON.stringify({ schema_version: "aether.terminal-account/1", account_subject: subject })); }) as typeof fetch;
    const hooks = createAtsHooks({ root: dir, env: {}, output: () => {}, acceptPolicy: async () => true, setup: async () => { throw new Error("new account requires its own setup"); }, load: async () => { loads++; return fakePackage(); } });
    const ctx = context();
    await hooks.onChatCommand!(ctx, agent(), "/ats status"); assert.equal(loads, 1);
    subject = "22222222-2222-4222-8222-222222222222";
    await hooks.onChatCommand!(ctx, agent(), "/ats status"); assert.equal(loads, 1); assert.equal(identityCalls, 2);
    globalThis.fetch = (async () => { throw new Error("identity offline"); }) as typeof fetch;
    await assert.rejects(hooks.onChatCommand!(ctx, agent(), "/ats status"), /identity offline/); assert.equal(loads, 1);
  });
});

test("ATS memory and strategy setup receive the operation cancellation signal and verified account scope", async () => {
  await fixture(async (dir) => {
    const controller = new AbortController(); const calls: string[] = [];
    const hooks = createAtsHooks({ root: dir, env: {}, output: () => {}, acceptPolicy: async () => true, setup: async () => ({ memoryGb: 5, strategiesDirectory: join(dir, "strategies") }), load: async () => fakePackage({
      initializeMemory: async input => { assert.equal(input.signal, controller.signal); assert.deepEqual(input.ownerScope, ACCOUNT); calls.push("memory"); return memoryReceipt(input); },
      scanStrategies: async input => { assert.equal(input.signal, controller.signal); calls.push("strategies"); return { state: "scanned", strategies: [] }; },
    }) });
    await withCreate(async () => { assert.equal(await hooks.createATS!(context(), "Atlas", controller.signal), 0); });
    assert.deepEqual(calls, ["memory", "strategies", "strategies"]);
  });
});

for (const openFirst of [false, true]) test(`a bound chat refuses a second account's browser and releases its own session (opened=${openFirst})`, async () => {
  await fixture(async dir => {
    let subject = SUBJECT, opens = 0, closes = 0;
    globalThis.fetch = (async () => new Response(JSON.stringify({ schema_version: "aether.terminal-account/1", account_subject: subject }))) as typeof fetch;
    const ctx = context(); const ordinary = agent(); delete ordinary.config.profile;
    const surface = { write: () => {}, signal: new AbortController().signal };
    const hooks = createAtsHooks({ root: dir, env: {}, output: () => {}, load: async () => fakePackage({ createBrowserObserver: async () => ({
      open: async () => { opens++; return { state: "connected", viewUrl: null }; }, close: async () => { closes++; }, snapshot: async () => ({}), status: () => ({ state: "connected" }),
    }) }) });
    const cleanup = await hooks.beforeChat!(ctx, ordinary, surface);
    if (openFirst) await hooks.onChatCommand!(ctx, ordinary, "/browser open", surface);
    subject = "22222222-2222-4222-8222-222222222222";
    await assert.rejects(hooks.onChatCommand!(ctx, ordinary, "/browser open", surface), /account.*changed|reopen/i);
    await cleanup!();
    assert.equal(opens, openFirst ? 1 : 0); assert.equal(closes, opens);
    subject = SUBJECT;
    await assert.rejects(hooks.onChatCommand!(ctx, ordinary, "/browser open", surface), /reopen/i, "switching back cannot resurrect the closed chat surface");
  });
});

test("account changes invalidate all bound ATS commands and mode shortcuts before settings access", async () => {
  await fixture(async dir => {
    await binding(dir); let subject = SUBJECT, loads = 0, saves = 0;
    globalThis.fetch = (async () => new Response(JSON.stringify({ schema_version: "aether.terminal-account/1", account_subject: subject }))) as typeof fetch;
    const ctx = context(); const surface = { write: () => {}, signal: new AbortController().signal };
    const hooks = createAtsHooks({ root: dir, env: {}, output: () => {}, load: async () => { loads++; return fakePackage({ saveSettings: async () => { saves++; } }); } });
    const cleanup = await hooks.beforeChat!(ctx, agent(), surface); const before = loads;
    subject = "22222222-2222-4222-8222-222222222222";
    await assert.rejects(hooks.onChatCommand!(ctx, agent(), "/ats mode danger", surface), /account.*changed|reopen/i);
    await assert.rejects(hooks.cycleMode!(ctx, agent(), surface), /reopen/i);
    assert.equal(loads, before); assert.equal(saves, 0); await cleanup!();
  });
});

test("a bound chat closes its browser when fresh account verification fails", async () => {
  await fixture(async dir => {
    let closes = 0;
    const ctx = context(); const ordinary = agent(); delete ordinary.config.profile;
    const surface = { write: () => {}, signal: new AbortController().signal };
    const hooks = createAtsHooks({ root: dir, env: {}, output: () => {}, load: async () => fakePackage({ createBrowserObserver: async () => ({
      open: async () => ({ state: "connected", viewUrl: null }), close: async () => { closes++; }, snapshot: async () => ({}), status: () => ({ state: "connected" }),
    }) }) });
    const cleanup = await hooks.beforeChat!(ctx, ordinary, surface);
    await hooks.onChatCommand!(ctx, ordinary, "/browser open", surface);
    globalThis.fetch = (async () => { throw new Error("account verification offline"); }) as typeof fetch;
    await assert.rejects(hooks.onChatCommand!(ctx, ordinary, "/browser status", surface), /verification offline/);
    assert.equal(closes, 1);
    await assert.rejects(hooks.onChatCommand!(ctx, ordinary, "/browser open", surface), /Reopen/);
    await cleanup!(); assert.equal(closes, 1);
  });
});

test("same-account token rotation preserves a bound chat and explicit reopen admits a new account", async () => {
  await fixture(async dir => {
    let subject = SUBJECT, opens = 0, closes = 0; let token = "aek_A";
    const ctx = context(); ctx.tokens = { get: async () => token, set: async value => { token = value; }, clear: async () => { token = ""; } };
    ctx.api = new ApiClient(ctx.cfg.baseUrl, ctx.tokens);
    globalThis.fetch = (async () => new Response(JSON.stringify({ schema_version: "aether.terminal-account/1", account_subject: subject }))) as typeof fetch;
    const ordinary = agent(); delete ordinary.config.profile;
    const surface = { write: () => {}, signal: new AbortController().signal };
    const hooks = createAtsHooks({ root: dir, env: {}, output: () => {}, load: async () => fakePackage({ createBrowserObserver: async () => ({
      open: async () => { opens++; return { state: "connected", viewUrl: null }; }, close: async () => { closes++; }, snapshot: async () => ({}), status: () => ({ state: "connected" }),
    }) }) });
    const cleanup = await hooks.beforeChat!(ctx, ordinary, surface);
    token = "aek_rotated_A"; await hooks.onChatCommand!(ctx, ordinary, "/browser open", surface); assert.equal(opens, 1);
    subject = "22222222-2222-4222-8222-222222222222"; token = "aek_B";
    await assert.rejects(hooks.onChatCommand!(ctx, ordinary, "/browser open", surface), /account or agent changed/);
    await cleanup!(); assert.equal(closes, 1);
    const freshSurface = { write: () => {}, signal: new AbortController().signal };
    const nextCleanup = await hooks.beforeChat!(ctx, ordinary, freshSurface);
    await hooks.onChatCommand!(ctx, ordinary, "/browser open", freshSurface); assert.equal(opens, 2);
    await nextCleanup!(); assert.equal(closes, 2);
  });
});

test("late cleanup from a closed chat cannot detach a reopened chat's browser", async () => {
  await fixture(async dir => {
    let opens = 0, closes = 0;
    const ctx = context(); const ordinary = agent(); delete ordinary.config.profile;
    const hooks = createAtsHooks({ root: dir, env: {}, output: () => {}, load: async () => fakePackage({ createBrowserObserver: async () => ({
      open: async () => { opens++; return { state: "connected", viewUrl: null }; }, close: async () => { closes++; }, snapshot: async () => ({}), status: () => ({ state: "connected" }),
    }) }) });
    const previous = { write: () => {}, signal: new AbortController().signal };
    const cleanup = await hooks.beforeChat!(ctx, ordinary, previous); await cleanup!();
    const current = { write: () => {}, signal: new AbortController().signal };
    const nextCleanup = await hooks.beforeChat!(ctx, ordinary, current);
    await hooks.onChatCommand!(ctx, ordinary, "/browser open", current); await cleanup!();
    await hooks.onChatCommand!(ctx, ordinary, "/browser open", current);
    assert.equal(opens, 1); await nextCleanup!(); assert.equal(closes, 1);
  });
});
