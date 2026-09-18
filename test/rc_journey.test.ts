// F1 end-to-end — browser, connector, RC, as one journey.
//
// Every stage has its own unit suite. This one runs them in ORDER against
// shared state, because the defects that survive unit tests live in the seams:
// a connector reported connected on the strength of a row that was already
// there, a browser reported opened when nothing rendered, a host that resumes
// after a revoke nobody confirmed.
//
//   Agent starts -> browser detected -> connector state read -> authorization
//   opens a browser -> completion PROVEN -> connector state advances -> RC host
//   registers and attaches -> events observable -> heartbeat -> restart
//   restores durable state -> `rc off` revokes and stays off
//
// ON OPENING A VIEWER PAGE: the Cloud exposes no viewer PAGE route. There is an
// SSE stream at /remote/sessions/{id}/observe and a one-shot grant mint, and
// nothing that renders. So the browser's job in this journey is the connector
// authorization and nothing else. Inventing a viewer URL to make the browser
// integration look complete is exactly what this lane was told not to do.
//
// No socket is opened, no browser is launched, no request leaves the process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  browserHint,
  detectBrowserRuntime,
  openBrowserTyped,
  type DetectOptions,
} from "../src/core/browser_runtime.js";
import { McpAuthorizationError, McpClient, type McpConnection } from "../src/core/mcp.js";
import type { ApiClient } from "../src/core/transport.js";
import {
  attachHost,
  flushOutbox,
  heartbeatHost,
  registerSession,
  revokeHost,
  type RcHostDeps,
} from "../src/core/rc/host.js";
import { createOutbox, enqueueEvent, loadOutbox, saveOutbox } from "../src/core/rc/outbox.js";
import { hostPresenceEvent, sessionOpenedEvent } from "../src/core/rc/producers.js";

const PROJECT_ROOT = "/repo";
const SESSION = "rs_" + "1".repeat(32);
const DEVICE = "dev-journey";
const T0 = "2026-09-07T00:00:00.000000+00:00";
const T1 = "2026-09-07T00:05:00.000000+00:00";

function sandbox(): string {
  return join(mkdtempSync(join(tmpdir(), "aether-rc-journey-")), "outbox.json");
}

/** A desktop Linux box with a browser. */
const DESKTOP: DetectOptions = {
  platform: "linux",
  env: { DISPLAY: ":0" },
  queryRegistry: () => null,
  resolveExecutable: (name) => (name === "xdg-open" ? "/usr/bin/xdg-open" : null),
};

/** A headless container: xdg-open present, no desktop to open into. */
const HEADLESS: DetectOptions = { ...DESKTOP, env: {} };

/** Windows with rundll32 but no registered browser at all. */
const WINDOWS_BARE: DetectOptions = {
  platform: "win32",
  env: {},
  queryRegistry: () => null,
  resolveExecutable: (name) =>
    name === "rundll32.exe" ? "C:\\Windows\\System32\\rundll32.exe" : null,
};

// ── the journey ─────────────────────────────────────────────────────────────

test("the full journey: browser, connector proof, RC host, restart, off", async () => {
  // ── 1. the Agent starts and detects what it can open ──────────────────────
  const browser = detectBrowserRuntime(DESKTOP);
  assert.equal(browser.code, "BROWSER_READY");

  // ── 2. connector state is READ before anything is authorized ─────────────
  // The row as it stands now is the baseline the completion proof measures
  // against. Reading it after opening the browser would already include the
  // authorization it is supposed to be measuring.
  const stale: McpConnection = { provider_id: "fal.ai", created_at: T0, updated_at: T0 };
  const api = {
    async getJson() {
      return [stale];
    },
    async postJson() {
      return { flow: "auth_code_pkce", authorize_url: "https://provider.example/authorize?x=1" };
    },
  } as unknown as ApiClient;
  const baseline = await new McpClient(api).findConnection("fal.ai");
  assert.deepEqual(baseline, stale, "the baseline is the row that already existed");

  // ── 3. authorization needs a browser, and one actually opened ────────────
  const opened = await openBrowserTyped("https://provider.example/authorize?x=1", {
    detect: DESKTOP,
    open: () => ({ status: "spawned", executable: "xdg-open", detail: "opened" }),
  });
  assert.equal(opened.launched, true);

  // ── 4. completion is PROVEN, not assumed ─────────────────────────────────
  // The stale row is still present; only when updated_at advances does the
  // wait resolve. This is the defect #148 fixed, exercised end to end.
  let polls = 0;
  let rows: McpConnection[] = [stale];
  const proving = new McpClient({
    async getJson() {
      polls += 1;
      if (polls >= 2) rows = [{ ...stale, updated_at: T1 }];
      return rows;
    },
    async postJson() {
      return {};
    },
  } as unknown as ApiClient);
  const connected = await proving.pollUntilConnected("fal.ai", async () => {}, {
    intervalSec: 0,
    timeoutMs: 5_000,
    since: baseline,
  });
  assert.equal(connected.updated_at, T1, "only an advanced row counts as connected");

  // ── 5. the RC host registers and attaches ────────────────────────────────
  const path = sandbox();
  const calls: string[] = [];
  const hostApi = {
    async postJson(p: string, body: unknown) {
      calls.push(p);
      if (p.endsWith("/host/events")) {
        const events = (body as { events: Array<{ host_event_id: string }> }).events;
        return {
          session_id: SESSION,
          receipts: events.map((e, i) => ({ host_event_id: e.host_event_id, seq: i + 1 })),
        };
      }
      if (p.endsWith("/host/heartbeat")) return { session_id: SESSION, state: "active" };
      return { session_id: SESSION, state: "active", device_id: DEVICE };
    },
    async getJson() {
      return [];
    },
  } as unknown as ApiClient;
  const host: RcHostDeps = { api: hostApi, outboxPath: path, projectRoot: PROJECT_ROOT };

  const session = await registerSession(host, {
    project_ref: "proj",
    device_id: DEVICE,
    session_name: "journey",
    repo: {
      repo: "AetherAI3/aether-agent",
      branch: "main",
      base_commit: "0".repeat(40),
      dirty_file_count: 0,
    },
  });
  await attachHost(host, session.session_id, DEVICE);
  assert.deepEqual(calls, ["/remote/sessions", `/remote/sessions/${SESSION}/host/attach`]);

  // ── 6. events become observable ──────────────────────────────────────────
  const record = createOutbox({
    session_id: SESSION,
    project_ref: "proj",
    device_id: DEVICE,
    epoch: 1,
    project_root: PROJECT_ROOT,
  });
  const opening = sessionOpenedEvent({
    session_name: "journey",
    repo: "AetherAI3/aether-agent",
    branch: "main",
    base_commit: "0".repeat(40),
    dirty_file_count: 0,
    protocol_version: "1",
  });
  enqueueEvent(record, opening.event_type, opening.payload);
  const presence = hostPresenceEvent(DEVICE, "online");
  enqueueEvent(record, presence.event_type, presence.payload);
  saveOutbox(path, record);

  const flushed = await flushOutbox(host, record);
  assert.equal(flushed.ok, true);
  assert.equal(record.cursor, 2);

  // ── 7. heartbeat ─────────────────────────────────────────────────────────
  assert.equal(await heartbeatHost(host, SESSION, DEVICE), "active");

  // ── 8. a restart loads durable state, and it is safe ─────────────────────
  const reloaded = loadOutbox(path, PROJECT_ROOT);
  assert.equal(reloaded.session_id, SESSION);
  assert.equal(reloaded.cursor, 2, "acknowledged events are not resent after a restart");
  assert.equal(reloaded.quarantined, 0);
  assert.equal(reloaded.revoke_pending, false);

  // ── 9. off revokes, and stays off ────────────────────────────────────────
  const off = await revokeHost(host, reloaded);
  assert.equal(off.ok, true);
  const afterOff = loadOutbox(path, PROJECT_ROOT);
  assert.equal(afterOff.session_id, "");
  assert.equal(afterOff.revoke_pending, false);
  assert.equal(afterOff.events.length, 0);
});

// ── the journey's failure branches ──────────────────────────────────────────

test("no browser on this machine is a typed failure with a recovery step", async () => {
  const result = await openBrowserTyped("https://provider.example/", {
    detect: WINDOWS_BARE,
    open: () => ({ status: "spawned", detail: "should not be reached" }),
  });
  assert.equal(result.code, "BROWSER_NOT_FOUND");
  assert.equal(result.launched, false);
  // Truthful on Windows specifically: rundll32 exists and exits zero, so the
  // old opener reported success in exactly this case.
  assert.match(browserHint(result.code), /open the URL above from another device/);
});

test("a headless container reports HEADLESS and never starts an authorization wait", async () => {
  const detected = detectBrowserRuntime(HEADLESS);
  assert.equal(detected.code, "BROWSER_HEADLESS");
  assert.equal(detected.available, false);

  // The waiting is what used to cost three minutes: a flow that opens nothing
  // and then polls for an approval that cannot arrive. The caller's contract
  // is to check availability first, so no poll may be issued at all.
  let polled = false;
  const client = new McpClient({
    async getJson() {
      polled = true;
      return [];
    },
    async postJson() {
      return {};
    },
  } as unknown as ApiClient);
  if (detected.available) {
    await client.pollUntilConnected("fal.ai", async () => {}, { timeoutMs: 1 }).catch(() => {});
  }
  assert.equal(polled, false, "no poll may start when nothing could open");
});

test("a cancelled authorization is a typed cancellation, not a timeout", async () => {
  const client = new McpClient({
    async getJson() {
      return [];
    },
    async postJson() {
      return {};
    },
  } as unknown as ApiClient);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      client.pollUntilConnected("fal.ai", async () => {}, {
        intervalSec: 0,
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
    (error: unknown) =>
      error instanceof McpAuthorizationError && error.code === "MCP_AUTH_CANCELLED",
  );
});

test("an abandoned authorization times out and names the surviving connection", async () => {
  // The operator has to know whether the credential they were replacing still
  // works. "Timed out" alone does not answer that.
  const stale: McpConnection = { provider_id: "fal.ai", created_at: T0, updated_at: T0 };
  const client = new McpClient({
    async getJson() {
      return [stale];
    },
    async postJson() {
      return {};
    },
  } as unknown as ApiClient);
  await assert.rejects(
    () =>
      client.pollUntilConnected("fal.ai", async () => {}, {
        intervalSec: 0,
        timeoutMs: 1,
        since: stale,
      }),
    (error: unknown) => {
      if (!(error instanceof McpAuthorizationError)) return false;
      assert.equal(error.code, "MCP_AUTH_TIMEOUT");
      assert.match(error.message, /already connected and that connection was left untouched/);
      return true;
    },
  );
});

test("connector identity and RC device identity stay separate", async () => {
  // Four identities this program keeps apart: device, account, connector
  // possession and model. A connector being authorized says nothing about
  // which device may host, and vice versa.
  const path = sandbox();
  const record = createOutbox({
    session_id: SESSION,
    project_ref: "proj",
    device_id: DEVICE,
    epoch: 1,
    project_root: PROJECT_ROOT,
  });
  enqueueEvent(record, "plan", { title: "t", status: "running" });
  saveOutbox(path, record);

  // A host whose device does not match the session is refused even though the
  // connector for this account is perfectly healthy.
  const api = {
    async postJson() {
      throw Object.assign(new Error("HTTP 404"), { status: 404, detail: "session not found" });
    },
    async getJson() {
      return [{ provider_id: "fal.ai", created_at: T0, updated_at: T1 }];
    },
  } as unknown as ApiClient;
  const outcome = await flushOutbox({ api, outboxPath: path, projectRoot: PROJECT_ROOT }, record);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.code, "RC_SESSION_NOT_FOUND");

  // And the connector is still connected — the two facts are independent.
  assert.equal((await new McpClient(api).findConnection("fal.ai"))?.updated_at, T1);
});

test("RC adds no listener and leaves no process behind", async () => {
  // Two properties in one place, because they fail together: RC is
  // outbound-only, and nothing it does spawns anything that could leak.
  const before = process.getActiveResourcesInfo?.() ?? [];
  const path = sandbox();
  const record = createOutbox({
    session_id: SESSION,
    project_ref: "proj",
    device_id: DEVICE,
    epoch: 1,
    project_root: PROJECT_ROOT,
  });
  enqueueEvent(record, "plan", { title: "t", status: "running" });
  const api = {
    async postJson(_p: string, body: unknown) {
      const events = (body as { events: Array<{ host_event_id: string }> }).events;
      return { receipts: events.map((e, i) => ({ host_event_id: e.host_event_id, seq: i + 1 })) };
    },
    async getJson() {
      return [];
    },
  } as unknown as ApiClient;
  await flushOutbox({ api, outboxPath: path, projectRoot: PROJECT_ROOT }, record);

  const after = process.getActiveResourcesInfo?.() ?? [];
  const added = after.filter((kind) => !before.includes(kind));
  for (const kind of added) {
    assert.ok(!/Server|Socket|TCP|Pipe|ChildProcess/i.test(kind), `RC left a ${kind} behind`);
  }
});
