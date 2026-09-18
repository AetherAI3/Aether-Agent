import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { AgentBrowserSession, browserConnectionEnv, renderBrowserStatus, type AgentBrowserObserver, type AgentBrowserStatus, type AgentBrowserPackage } from "../src/core/agent_browser_session.js";
import { writeManagedChatEvent } from "../src/commands/managed_agents.js";

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function fixture(options: { env?: NodeJS.ProcessEnv; open?: () => Promise<{ state: string; viewUrl: string | null }>; close?: () => Promise<void>; observe?: AgentBrowserPackage["observeBrowser"] } = {}) {
  let output = "", created = 0, closed = 0, launched = 0, snapshots = 0;
  let status: AgentBrowserStatus = { state: "connected", viewerState: "available", ageMs: null, visionStepsRemaining: null };
  const observer: AgentBrowserObserver = {
    open: options.open ?? (async () => ({ state: "connected", viewUrl: "http://127.0.0.1:6080/vnc.html?autoconnect=1" })),
    close: async () => { closed++; await options.close?.(); status = { state: "closed" }; },
    snapshot: async () => { snapshots++; status = { state: "observing", ageMs: 0, visionStepsRemaining: 7, viewerState: "available" }; return {}; },
    status: () => status,
  };
  const session = new AgentBrowserSession({ env: options.env ?? {}, output: text => { output += text; }, openViewer: async () => { launched++; return { launched: true }; },
    load: async () => ({ createBrowserObserver: async () => { created++; return observer; }, observeBrowser: options.observe ?? (async function* (_observer, { signal }) {
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    }) }) });
  return { session, observer, setStatus(value: AgentBrowserStatus) { status = value; }, stats: () => ({ output, created, closed, launched, snapshots }) };
}

test("strict loopback setup works without a token and remote setup requires an environment credential", () => {
  assert.equal(browserConnectionEnv({})["AGENT_BROWSER_URL"], "http://127.0.0.1:8092");
  assert.equal(browserConnectionEnv({}, "http://[::1]:8092")["AGENT_BROWSER_URL"], "http://[::1]:8092");
  for (const url of ["http://localhost:8092", "http://runtime.example", "https://name:secret@runtime.example", "https://runtime.example?token=secret", "https://runtime.example/#secret", "https://runtime.example/path"]) {
    assert.throws(() => browserConnectionEnv({}, url), /HTTPS|loopback|credentials/);
  }
  assert.throws(() => browserConnectionEnv({}, "https://runtime.example"), /environment/);
  assert.equal(browserConnectionEnv({ AGENT_BROWSER_CONTROLLER_TOKEN: "fixture" }, "https://runtime.example")["AGENT_BROWSER_URL"], "https://runtime.example");
});

test("connected sessions are not labeled live before verified observation; open reuses an existing viewer", async () => {
  const f = fixture();
  try {
    await f.session.command("/browser open");
    assert.equal(f.session.status().state, "connecting");
    assert.doesNotMatch(f.stats().output, /● LIVE/);
    await f.session.command("/browser open");
    assert.equal(f.stats().created, 1); assert.equal(f.stats().launched, 2);
    await f.session.command("/browser refresh");
    assert.equal(f.session.status().state, "live");
    assert.match(f.stats().output, /● LIVE/);
    assert.match(f.stats().output, /7 captures left/);
  } finally { await f.session.close(); }
});

test("explicit retry releases first and is the only operation that creates a fresh budget", async () => {
  const f = fixture();
  try {
    await f.session.command("/ats browser open");
    f.setStatus({ state: "budget_exhausted", visionStepsRemaining: 0 });
    await f.session.command("/browser status");
    assert.equal(f.stats().created, 1);
    assert.match(f.stats().output, /BUDGET-EXHAUSTED/);
    await f.session.command("/browser retry");
    assert.equal(f.stats().created, 2); assert.equal(f.stats().closed, 1);
    assert.match(f.stats().output, /fresh bounded vision budget/);
    await f.session.command("/browser stop");
    assert.equal(f.session.status().state, "stopped");
  } finally { await f.session.close(); }
});

test("cleanup failure prevents replacement and never renders runtime exception secrets", async () => {
  let failures = 1;
  const f = fixture({ close: async () => { if (failures-- > 0) throw new Error("TOKEN=fixture-private-secret"); } });
  try {
    await f.session.command("/browser open");
    await f.session.command("/browser retry");
    assert.equal(f.stats().created, 1);
    assert.match(f.stats().output, /cleanup needs attention/);
    assert.doesNotMatch(f.stats().output, /fixture-private-secret/);
    await f.session.command("/browser stop");
    assert.equal(f.stats().closed, 2);
  } finally { await f.session.close(); }
});

test("remote loopback viewer remains on the runtime host and never launches locally", async () => {
  const f = fixture({ env: { AGENT_BROWSER_URL: "https://runtime.example", AGENT_BROWSER_CONTROLLER_TOKEN: "fixture-private-secret" }, open: async () => ({ state: "connected", viewUrl: null }) });
  f.setStatus({ state: "connected", viewerState: "remote_loopback" });
  try {
    await f.session.command("/browser open");
    assert.equal(f.stats().launched, 0);
    assert.match(f.stats().output, /runtime's host/);
    assert.doesNotMatch(f.stats().output, /tunnel|fixture-private-secret/);
  } finally { await f.session.close(); }
});

test("browser failures expose recovery text without reflecting runtime errors", async () => {
  const f = fixture({ open: async () => { throw new Error("https://runtime.example?token=fixture-private-secret\x1b]52;c;evil\x07"); } });
  try {
    await f.session.command("/browser open");
    assert.equal(f.session.status().state, "offline");
    assert.equal(f.stats().closed, 1);
    assert.match(f.stats().output, /Browser unavailable.*aether-browser@0.2.2 doctor/);
    assert.doesNotMatch(f.stats().output, /fixture-private-secret|evil/);
  } finally { await f.session.close(); }
});

test("closing during a delayed package load prevents session creation and late output", async () => {
  let release: (value: AgentBrowserPackage) => void = () => {};
  let created = 0, output = "";
  const pack: AgentBrowserPackage = { createBrowserObserver: async () => { created++; throw new Error("must not create"); }, observeBrowser: async function* () {} };
  const session = new AgentBrowserSession({ env: {}, output: text => { output += text; }, load: () => new Promise(resolve => { release = resolve; }) });
  const opening = session.command("/browser open");
  await tick(); await session.close();
  const before = output;
  release(pack); await opening;
  assert.equal(created, 0); assert.equal(output, before);
});

test("browser setup rejects inline secrets without loading dependencies or printing them", async () => {
  const f = fixture();
  try {
    await f.session.command("/browser setup https://runtime.example?token=fixture-private-secret");
    assert.equal(f.stats().created, 0);
    assert.doesNotMatch(f.stats().output, /fixture-private-secret/);
    await f.session.command("/browser setup http://127.0.0.1:8093");
    assert.match(f.stats().output, /Connection configured for this chat/);
  } finally { await f.session.close(); }
});

test("status sanitizes terminal metadata, and stale frames never render live", () => {
  const status = renderBrowserStatus("stale", { state: "stale", ageMs: 16000, observation: { origin: "https://safe.example\x1b]52;c;evil\x07", title: "unused secret", sequence: 3, capturedAt: "", screenshotBytes: 100, width: 10, height: 10 } });
  assert.match(status, /STALE/); assert.match(status, /16s since verified frame/);
  assert.doesNotMatch(status, /LIVE|unused secret|\x1b|evil/);
});

test("asynchronous status clears the whole wrapped draft and redraws without changing input or cursor", () => {
  let output = "", redraws = 0;
  const out = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  const reader = { line: "long draft with a moved cursor", cursor: 5, getCursorPos: () => ({ rows: 2, cols: 4 }), prompt: (preserve?: boolean) => { assert.equal(preserve, true); redraws++; } };
  writeManagedChatEvent(out, reader, "Browser LIVE\n");
  assert.equal(reader.line, "long draft with a moved cursor"); assert.equal(reader.cursor, 5);
  assert.equal(output, "\r\x1b[2A\x1b[0JBrowser LIVE\n"); assert.equal(redraws, 1);
});

test("a delayed viewer launch cannot write after session cleanup", async () => {
  let output = "", release: (value: { launched: boolean }) => void = () => {}, closing = 0;
  const session = new AgentBrowserSession({ env: {}, output: text => { output += text; }, openViewer: () => new Promise(resolve => { release = resolve; }),
    load: async () => ({ createBrowserObserver: async () => ({ open: async () => ({ state: "connected", viewUrl: "http://127.0.0.1:6080/vnc.html" }), close: async () => { closing++; }, snapshot: async () => ({}), status: () => ({ state: "connected" }) }),
      observeBrowser: async function* (_observer, { signal }) { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); },
    }) });
  const opening = session.command("/browser open"); await tick();
  await session.close(); const saved = output;
  release({ launched: true }); await opening;
  assert.equal(closing, 1); assert.equal(output, saved);
});

test("durable prior cleanup blocks open until explicit reconciliation and updates the context bar", async () => {
  let pending = true, opens = 0, reconciles = 0, closes = 0, output = "";
  const states: string[] = [];
  const owner = { origin: "https://cloud.example", accountSubject: "account", agentId: "agent", deviceId: "device" };
  const observer: AgentBrowserObserver = {
    open: async () => { assert.equal(pending, false); opens++; return {state:"connected",viewUrl:null}; },
    reconcile: async () => { reconciles++; pending = false; },
    close: async () => { closes++; }, snapshot: async () => ({}), status: () => ({state:"connected"}),
  };
  const session = new AgentBrowserSession({env:{},output:text => {output+=text;},recovery:{directory:"/private/browser",owner},onStatus:state=>states.push(state),
    load:async()=>({BrowserSessionRecovery:class { async status() {return {pending,state:pending?"cleanup_required":"closed"};} },
      createBrowserObserver:async input=>{assert.ok(input?.["recovery"]);return observer;},observeBrowser:async function*(){}})});
  try {
    await session.command("/browser open");
    assert.equal(opens,0);assert.equal(reconciles,0);assert.equal(session.status().state,"cleanup-required");
    await session.command("/browser open");assert.equal(opens,0);
    await session.command("/browser retry");
    assert.equal(reconciles,1);assert.equal(opens,1);assert.equal(closes,1);
    assert.ok(states.includes("cleanup-required"));assert.match(output,/previous browser session/);
  } finally {await session.close();}
});

test("uncertain cleanup survives closing chat and rejects replacement with actionable status", async () => {
  let opens = 0, output = "";
  const session = new AgentBrowserSession({env:{},output:text=>{output+=text;},recovery:{directory:"/private/browser",owner:{origin:"https://cloud.example",accountSubject:"account",agentId:"agent",deviceId:"device"}},
    load:async()=>({BrowserSessionRecovery:class{async status(){return {pending:true,state:"cleanup_required"};}},
      createBrowserObserver:async()=>({open:async()=>{opens++;return {state:"connected",viewUrl:null};},
        reconcile:async()=>{throw Object.assign(new Error("private runtime details"),{code:"BROWSER_RECOVERY_UNKNOWN_CREATE"});},
        close:async()=>{},snapshot:async()=>({}),status:()=>({state:"closed"})}),observeBrowser:async function*(){}})});
  await session.command("/browser open");await session.command("/browser retry");
  assert.equal(opens,0);assert.equal(session.status().state,"cleanup-required");
  assert.match(output,/automatic replacement is blocked/);assert.doesNotMatch(output,/private runtime details/);
  await session.close();assert.equal(session.status().state,"cleanup-required");
});

test("legacy uncertain receipt is cleanup-required even when preparation cannot create an observer", async () => {
  let created=0,output="";
  const session = new AgentBrowserSession({env:{},output:text=>{output+=text;},recovery:{directory:"/private/browser",owner:{origin:"https://cloud.example",accountSubject:"account",agentId:"agent",deviceId:"device"}},
    load:async()=>({BrowserSessionRecovery:class{async status():Promise<{pending:boolean;state:string}>{throw Object.assign(new Error("hidden storage details"),{code:"BROWSER_RECOVERY_UNKNOWN_CREATE"});}},
      createBrowserObserver:async()=>{created++;throw new Error("must not create");},observeBrowser:async function*(){}})});
  await session.command("/browser open");assert.equal(session.status().state,"cleanup-required");
  await session.command("/browser stop");assert.equal(created,0);
  assert.match(output,/Idle health cannot release it/);assert.doesNotMatch(output,/hidden storage details|Browser unavailable/);
  await session.close();assert.equal(session.status().state,"cleanup-required");
});

async function realObserverCtor(): Promise<new (options: Record<string, unknown>) => AgentBrowserObserver> {
  const dependency = "aether-ats-skills";
  return (await import(dependency)).AtsBrowserObserver;
}

test("chat cancellation reaches real observer health and prevents post-cancel session admission", async () => {
  const Observer = await realObserverCtor();
  const parent = new AbortController();
  let transportSignal: AbortSignal | undefined, created = 0, ended = 0;
  let releaseHealth: () => void = () => {};
  const health = { api_version: "v1", status: "ok", browser_ready: true, session_active: false, slots_available: 1 };
  const observer = new Observer({ baseUrl: "http://127.0.0.1:8092", browser: {
    health: ({ signal }: { signal?: AbortSignal } = {}) => new Promise((resolve, reject) => {
      transportSignal = signal;
      releaseHealth = () => resolve(health);
      if (signal?.aborted) reject(new Error("aborted"));
      else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    createSession: async () => { created++; return { id: "fixture", end: async () => { ended++; } }; },
  } });
  const session = new AgentBrowserSession({ env: {}, output: () => {}, signal: parent.signal,
    load: async () => ({ createBrowserObserver: async () => observer, observeBrowser: async function* () {} }) });
  const opening = session.command("/browser open"); await tick();
  parent.abort(); await tick();
  // Release even on regression so the test leaves no unbounded work behind.
  releaseHealth(); await opening; await session.close();
  assert.equal(transportSignal?.aborted, true);
  assert.equal(created, 0); assert.equal(ended, 0);
});

test("cancellation during admitted create receives the real observer identity and releases exactly once", async () => {
  const Observer = await realObserverCtor();
  const parent = new AbortController();
  let admitted = false, ended = 0;
  let resolveCreate: (value: unknown) => void = () => {};
  const observer = new Observer({ baseUrl: "http://127.0.0.1:8092", browser: {
    health: async () => ({ api_version: "v1", status: "ok", browser_ready: true, session_active: false, slots_available: 1 }),
    createSession: () => { admitted = true; return new Promise(resolve => { resolveCreate = resolve; }); },
  } });
  const session = new AgentBrowserSession({ env: {}, output: () => {}, signal: parent.signal,
    load: async () => ({ createBrowserObserver: async () => observer, observeBrowser: async function* () {} }) });
  const opening = session.command("/browser open"); await tick();
  assert.equal(admitted, true); parent.abort();
  const now = Date.now();
  resolveCreate({ id: "11111111-1111-4111-8111-111111111111", viewUrl: "http://127.0.0.1:6080/vnc.html", maxVisionSteps: 100,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), end: async () => { ended++; } });
  await opening; await session.close();
  assert.equal(ended, 1); assert.equal(observer.status().state, "closed");
});
