// #222 — preview lifecycle reaches an RC viewer without exposing local URLs.
//
// Three groups:
//
//   1. The URL projection   — what may ever be shown as a link
//   2. The publisher        — session binding, durability, no duplicate pile-up
//   3. End to end           — the real `aether preview` supervisor, observed by
//                             a broker stub that enforces the Cloud display/1
//                             contract and rejects (400) anything it would.
//
// The contract helper is local on purpose: several RC producer lanes land in
// parallel, and a shared helper file would be a guaranteed merge conflict.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { parseArgs } from "node:util";

import { findDispatchedCliCommand } from "../src/commands/cli_registry.js";
import { COMMAND_PARSE_OPTIONS } from "../src/commands/command_manifest.js";
import { cmdPreview, PREVIEW_EXIT, previewOptionsFromFlags } from "../src/commands/preview.js";
import { projectRefFor, rcOutboxPath } from "../src/commands/rc.js";
import { openRcCodingObserver } from "../src/commands/rc_observation.js";
import { commandFlags } from "../src/core/command_dispatch.js";
import type { AppContext } from "../src/core/context.js";
import { isLoopbackUrl, PREVIEW_SCHEMA, previewPaths, type PreviewState } from "../src/core/preview_contract.js";
import { createOutbox, loadOutbox, saveOutbox } from "../src/core/rc/outbox.js";
import { openRcPreviewPublisher, previewPublicId, type RcPreviewPublisher } from "../src/core/rc/preview.js";
import { previewDisplayUrl, previewEvent } from "../src/core/rc/producers.js";
import { payloadDigest } from "../src/core/rc/receipts.js";
import type { ApiClient } from "../src/core/transport.js";

// ── Cloud display/1 contract (AETHER-CLOUD lib/remote_session/contracts.py) ──

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "rc-display-v1.json");
const ALLOWED = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { payload_keys: Record<string, string[]> }).payload_keys;
const REQUIRED: Record<string, readonly string[]> = {
  plan: ["title", "status"], subagent: ["subagent_id", "status"], tool_activity: ["tool", "status"],
  diff_summary: ["files_changed", "insertions", "deletions"], tests: ["status"], ci: ["provider", "status"],
  pr_status: ["state"], artifact: ["artifact_id", "kind", "title"], preview: ["phase", "instance_id"],
  done: ["status"], error: ["code", "message"],
};
const COUNTS = new Set(["step", "total_steps", "files_changed", "insertions", "deletions", "passed", "failed", "skipped", "number"]);

/** Every reason the Cloud broker would answer 400 for this display payload. */
function displayViolations(eventType: string, payload: Record<string, unknown>): string[] {
  const allowed = ALLOWED[eventType];
  const required = REQUIRED[eventType];
  if (!allowed || !required) return [`no display/1 projection for ${eventType}`];
  const problems: string[] = [];
  if (payload["projection_version"] !== "1") problems.push("projection_version must be \"1\"");
  for (const key of required) {
    if (!(key in payload)) problems.push(`missing required ${key}`);
    else if (payload[key] === "") problems.push(`empty required ${key}`);
  }
  for (const [key, value] of Object.entries(payload)) {
    if (!allowed.includes(key)) { problems.push(`key not allowlisted: ${key}`); continue; }
    if (key === "projection_version") continue;
    if (COUNTS.has(key)) {
      if (!Number.isSafeInteger(value) || (value as number) < 0) problems.push(`${key} must be a non-negative int`);
    } else if (key !== "files" && (typeof value !== "string" || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value))) {
      problems.push(`${key} must be a bounded single-line string`);
    }
  }
  if (typeof payload["url"] === "string") {
    let url: URL | null = null;
    try { url = new URL(payload["url"]); } catch { problems.push("url malformed"); }
    if (url && (url.protocol !== "https:" || !url.host || url.username || url.password || url.search || url.hash ||
        payload["url"].includes("?") || payload["url"].includes("#"))) {
      problems.push("url must be credential-free HTTPS");
    }
  }
  return problems;
}

// ── fixtures ────────────────────────────────────────────────────────────────

const SESSION = "rs_" + "2".repeat(32);
type Sent = { event_type: string; payload: Record<string, unknown> };

interface Broker {
  api: ApiClient;
  accepted: Sent[];
  rejected: string[];
  setOffline(value: boolean): void;
}

/** An append route that stores only what the Cloud contract accepts. */
function contractBroker(sessionId = SESSION): Broker {
  const accepted: Sent[] = [];
  const rejected: string[] = [];
  let seq = 0;
  let offline = false;
  const api = {
    async getJson(): Promise<never> { throw new Error("preview publication must not read from the broker"); },
    async postJson(endpoint: string, body: unknown) {
      assert.equal(endpoint, `/remote/sessions/${sessionId}/host/events`);
      if (offline) throw new Error("fetch failed");
      const events = (body as { events: Array<{ host_event_id: string } & Sent> }).events;
      for (const event of events) {
        const problems = displayViolations(event.event_type, event.payload);
        if (problems.length > 0) {
          rejected.push(`${event.event_type}: ${problems.join("; ")}`);
          throw Object.assign(new Error("rejected"), { status: 400 });
        }
      }
      accepted.push(...events.map(({ event_type, payload }) => ({ event_type, payload })));
      return {
        session_id: sessionId,
        receipts: events.map((event) => ({
          host_event_id: event.host_event_id, seq: ++seq, payload_digest: payloadDigest(event.payload),
        })),
      };
    },
  } as unknown as ApiClient;
  return { api, accepted, rejected, setOffline: (value) => { offline = value; } };
}

function tempDir(prefix: string): string { return mkdtempSync(join(tmpdir(), prefix)); }

/** An active RC session for `root`, as `rc start` leaves it. */
function activeOutbox(root: string, options: { revokePending?: boolean; sessionId?: string } = {}): string {
  const path = join(tempDir("rc-preview-outbox-"), "outbox.json");
  const record = createOutbox({
    session_id: options.sessionId ?? SESSION, project_ref: projectRefFor(resolve(root)),
    device_id: "dev-preview", epoch: 1, project_root: resolve(root),
  });
  record.revoke_pending = options.revokePending ?? false;
  saveOutbox(path, record);
  return path;
}

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough(); let value = "";
  stream.on("data", (chunk) => { value += String(chunk); });
  return { stream, text: () => value };
}

function context(cwd: string, api: ApiClient): AppContext {
  return {
    cfg: {} as AppContext["cfg"], api, tokens: {} as AppContext["tokens"],
    flags: { cwd, yes: true, json: false, audit: false }, confirm: async () => true,
  };
}

const SERVER = `
  import { createServer } from "node:http";
  const s = createServer((_q, r) => r.end("ok"));
  s.listen(0, "127.0.0.1", () => console.log("ready http://127.0.0.1:" + s.address().port));
  setInterval(() => {}, 1000);
`;

/** Run `aether preview <sub>` and wait for every RC upload it started. */
async function preview(
  root: string, api: ApiClient, outboxPath: string, sub: string, extra: Record<string, unknown> = {},
): Promise<{ code: number; out: string; err: string }> {
  const out = sink(); const err = sink();
  const publishers: RcPreviewPublisher[] = [];
  const code = await cmdPreview(context(root, api), [sub], {
    noOpen: true, out: out.stream, err: err.stream,
    rc: { outboxPath, opened: (publisher) => publishers.push(publisher) },
    ...extra,
  });
  await Promise.all(publishers.map((publisher) => publisher.drain()));
  return { code, out: out.text(), err: err.text() };
}

function previews(broker: Broker): Array<Record<string, unknown>> {
  return broker.accepted.filter((event) => event.event_type === "preview").map((event) => event.payload);
}

// ── 1. The URL projection ───────────────────────────────────────────────────

test("only an intentionally public HTTPS origin/path survives the preview URL projection", () => {
  assert.equal(previewDisplayUrl("https://preview.example/app", isLoopbackUrl), "https://preview.example/app");
  assert.equal(previewDisplayUrl("https://Preview.Example/app/", isLoopbackUrl), "https://preview.example/app/");
  assert.equal(previewDisplayUrl("https://preview.example", isLoopbackUrl), "https://preview.example/");
  assert.equal(previewDisplayUrl("https://preview.example:8443/a/b", isLoopbackUrl), "https://preview.example:8443/a/b");
  // Ordinary slugs with digits are page names, not capabilities.
  assert.equal(previewDisplayUrl("https://my-app-v2.example.com/release-notes-2024/", isLoopbackUrl),
    "https://my-app-v2.example.com/release-notes-2024/");

  const refused = [
    // loopback, in every spelling the URL parser normalizes to it
    "http://127.0.0.1:5173/", "https://127.0.0.1:5173/", "https://localhost/x", "https://[::1]/", "https://2130706433/",
    "https://dev.localhost/",
    // private, link-local, CGNAT/tailnet and any other IP literal
    "https://10.0.0.5/", "https://192.168.1.2:3000/", "https://172.16.0.1/", "https://100.64.1.1/",
    "https://169.254.1.1/", "https://[fd00::1]/", "https://203.0.113.5/", "https://0.0.0.0/",
    // single-label and private-namespace hosts
    "https://devbox/", "https://app.local/", "https://api.internal/", "https://box.lan/", "https://nas.home.arpa/",
    "https://preview.example./",
    // tailnet MagicDNS (a Funnel name cannot be told apart from a tailnet-only
    // one), reserved TLDs, onion services
    "https://devbox.tail1234.ts.net/", "https://app.test/", "https://x.invalid/", "https://abcdefgh.onion/",
    // public DNS names that resolve to loopback or private addresses
    "https://10.0.0.5.nip.io/", "https://127.0.0.1.nip.io/", "https://app.127-0-0-1.sslip.io/",
    "https://192-168-1-2.example.com/", "https://localtest.me/", "https://app.localtest.me/", "https://lvh.me/",
    // capability-shaped segments split by separators
    "https://preview.example/share/9f86d081-884c-7d65-9a2f-eaa0c55ad015",
    "https://preview.example/s/x7Kp2_Qm9LzR4tVw8YbN-u3", "https://preview.example/k/a1b2c3d4e5f6a7b8",
    // not HTTPS, credential-bearing or signed
    "http://preview.example/app", "ftp://preview.example/app", "https://user:pw@preview.example/app",
    "https://preview.example/app?token=private", "https://preview.example/app?", "https://preview.example/app#frag",
    "https://preview.example/share/9f86d081884c7d659a2feaa0c55ad015",
    "https://preview.example/s/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
    // malformed or unbounded
    "", "https://", "not a url", "https://preview.example/a b", "https://preview.example/\u0000x",
    `https://preview.example/${"a".repeat(520)}`,
  ];
  for (const raw of refused) assert.equal(previewDisplayUrl(raw, isLoopbackUrl), undefined, raw);
});

test("every preview phase projects to a Cloud-valid payload with no local detail", () => {
  const state: PreviewState = {
    schema: PREVIEW_SCHEMA, instanceId: randomUUID(), projectRoot: "/home/someone/repo", commandDigest: "a".repeat(64),
    phase: "failed", supervisorPid: 4242, childPid: 4343, controlPort: 54321,
    startedAt: new Date().toISOString(), error: "dev command exited before readiness (exit 3) at /home/someone",
  };
  for (const phase of ["starting", "ready", "failed", "stopping", "stopped"] as const) {
    const event = previewEvent({ phase, instanceId: "preview-abc", url: "http://127.0.0.1:5173/" }, isLoopbackUrl);
    assert.deepEqual(displayViolations(event.event_type, event.payload), [], phase);
    assert.deepEqual(event.payload, { projection_version: "1", phase, instance_id: "preview-abc" });
  }
  const failed = previewEvent(state, isLoopbackUrl);
  assert.deepEqual(displayViolations(failed.event_type, failed.payload), []);
  assert.doesNotMatch(JSON.stringify(failed.payload), /exited|someone|4242|4343|54321/);
});

// ── 2. The publisher ────────────────────────────────────────────────────────

test("the viewer handle is session-scoped and never the local control identity", async () => {
  const root = tempDir("rc-preview-id-");
  const broker = contractBroker();
  const publisher = openRcPreviewPublisher(broker.api, resolve(root), activeOutbox(root));
  assert.ok(publisher);
  const instanceId = randomUUID();
  publisher.observe({ phase: "starting", instanceId });
  publisher.observe({ phase: "ready", instanceId, publicUrl: "https://preview.example/app" });
  await publisher.drain();

  const sent = previews(broker);
  assert.deepEqual(broker.rejected, []);
  assert.deepEqual(sent.map((payload) => payload["phase"]), ["starting", "ready"]);
  const handle = sent[0]?.["instance_id"];
  assert.match(String(handle), /^preview-[0-9a-f]{24}$/);
  assert.ok(sent.every((payload) => payload["instance_id"] === handle), "one preview must stay one viewer card");
  assert.equal(handle, previewPublicId(SESSION, instanceId));
  assert.notEqual(previewPublicId("rs_" + "9".repeat(32), instanceId), handle, "a later session must not reuse the handle");
  assert.doesNotMatch(JSON.stringify(sent), new RegExp(instanceId));
  assert.equal(sent[0]?.["url"], undefined, "a starting preview is not serving, so it carries no link");
  assert.equal(sent[1]?.["url"], "https://preview.example/app");
});

test("without an active RC session for this project nothing is opened or written", () => {
  const root = tempDir("rc-preview-inactive-");
  const broker = contractBroker();
  const missing = join(tempDir("rc-preview-missing-"), "outbox.json");
  assert.equal(openRcPreviewPublisher(broker.api, resolve(root), missing), null);
  assert.equal(existsSync(missing), false);
  assert.equal(openRcPreviewPublisher(broker.api, resolve(root), activeOutbox(root, { revokePending: true })), null);
  assert.equal(openRcPreviewPublisher(broker.api, resolve(tempDir("rc-preview-other-")), activeOutbox(root)), null);
});

test("a broker outage keeps observations durable, never throws and never piles up duplicates", async () => {
  const root = tempDir("rc-preview-outage-");
  const path = activeOutbox(root);
  const broker = contractBroker();
  broker.setOffline(true);
  const publisher = openRcPreviewPublisher(broker.api, resolve(root), path);
  assert.ok(publisher);
  const instanceId = randomUUID();
  publisher.observe({ phase: "failed", instanceId });
  await publisher.drain();
  publisher.observe({ phase: "failed", instanceId });
  await publisher.drain();
  assert.deepEqual(loadOutbox(path, resolve(root)).events.map((event) => event.payload["phase"]), ["failed"]);

  broker.setOffline(false);
  publisher.observe({ phase: "stopped", instanceId });
  await publisher.drain();
  assert.deepEqual(previews(broker).map((payload) => payload["phase"]), ["failed", "stopped"]);
  assert.equal(loadOutbox(path, resolve(root)).events.length, 0, "receipted events leave the durable queue");
});

test("a URL the sanitizer would rewrite is omitted rather than published mangled", async () => {
  const root = tempDir("rc-preview-mangle-");
  const broker = contractBroker();
  const previous = process.env["AETHER_PREVIEW_RC_TOKEN"];
  process.env["AETHER_PREVIEW_RC_TOKEN"] = "hunter2hunter";
  try {
    const publisher = openRcPreviewPublisher(broker.api, resolve(root), activeOutbox(root));
    assert.ok(publisher);
    publisher.observe({ phase: "ready", instanceId: randomUUID(), publicUrl: "https://preview.example/hunter2hunter" });
    await publisher.drain();
  } finally {
    if (previous === undefined) delete process.env["AETHER_PREVIEW_RC_TOKEN"];
    else process.env["AETHER_PREVIEW_RC_TOKEN"] = previous;
  }
  const [ready] = previews(broker);
  assert.equal(ready?.["phase"], "ready");
  assert.equal(ready?.["url"], undefined);
  assert.doesNotMatch(JSON.stringify(broker.accepted), /hunter2hunter|REDACTED/);
});

// ── 3. End to end through the real supervisor ───────────────────────────────

test("a loopback preview publishes its lifecycle but never its local URL", { timeout: 45_000 }, async (t) => {
  const root = tempDir("rc-preview-loopback-");
  const script = join(root, "server.mjs");
  writeFileSync(script, SERVER);
  const outbox = activeOutbox(root);
  const broker = contractBroker();
  t.after(async () => { if (existsSync(previewPaths(root).statePath)) await preview(root, broker.api, outbox, "stop"); });

  const started = await preview(root, broker.api, outbox, "start", { command: process.execPath, args: [script], timeoutMs: "15000" });
  assert.equal(started.code, PREVIEW_EXIT.ok, started.err);
  assert.match(started.out, /^http:\/\/127\.0\.0\.1:\d+/m, "the operator still sees the local URL");
  const stopped = await preview(root, broker.api, outbox, "stop");
  assert.equal(stopped.code, PREVIEW_EXIT.ok, stopped.err);

  assert.deepEqual(broker.rejected, []);
  const sent = previews(broker);
  assert.deepEqual(sent.map((payload) => payload["phase"]), ["starting", "ready", "stopping", "stopped"]);
  assert.ok(sent.every((payload) => payload["url"] === undefined), "loopback is never a viewer link");
  assert.equal(new Set(sent.map((payload) => payload["instance_id"])).size, 1);
  const port = started.out.match(/127\.0\.0\.1:(\d+)/)?.[1];
  assert.ok(port);
  assert.doesNotMatch(JSON.stringify(broker.accepted), new RegExp(`127\\.0\\.0\\.1|localhost|:${port}\\b|server\\.mjs`));
});

test("a declared public URL is published only while the declared preview is ready", { timeout: 45_000 }, async (t) => {
  const root = tempDir("rc-preview-public-");
  const script = join(root, "server.mjs");
  writeFileSync(script, SERVER);
  mkdirSync(join(root, ".aether"));
  writeFileSync(join(root, ".aether", "preview.json"), JSON.stringify({
    version: 1, command: process.execPath, args: [script], timeoutMs: 15_000, publicUrl: "https://preview.example/app",
  }));
  const outbox = activeOutbox(root);
  const broker = contractBroker();
  t.after(async () => { if (existsSync(previewPaths(root).statePath)) await preview(root, broker.api, outbox, "stop"); });

  const started = await preview(root, broker.api, outbox, "start");
  assert.equal(started.code, PREVIEW_EXIT.ok, started.err);
  const status = await preview(root, broker.api, outbox, "status");
  assert.equal(status.code, PREVIEW_EXIT.ok, status.err);
  const stopped = await preview(root, broker.api, outbox, "stop");
  assert.equal(stopped.code, PREVIEW_EXIT.ok, stopped.err);

  assert.deepEqual(broker.rejected, []);
  const sent = previews(broker);
  assert.deepEqual(sent.map((payload) => payload["phase"]), ["starting", "ready", "ready", "stopping", "stopped"]);
  assert.deepEqual(sent.map((payload) => payload["url"] ?? null),
    [null, "https://preview.example/app", "https://preview.example/app", null, null]);
});

test("a malformed public URL declaration fails closed before anything starts or publishes", { timeout: 20_000 }, async () => {
  for (const publicUrl of [
    "https://user:pw@preview.example/app", "https://preview.example/app?sig=abc", "http://preview.example/app",
    "https://192.168.0.10:5173/", "https://localhost:5173/", "not a url", 42,
  ]) {
    const root = tempDir("rc-preview-malformed-");
    mkdirSync(join(root, ".aether"));
    writeFileSync(join(root, ".aether", "preview.json"), JSON.stringify({
      version: 1, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], publicUrl,
    }));
    const outbox = activeOutbox(root);
    const broker = contractBroker();
    const result = await preview(root, broker.api, outbox, "start");
    assert.equal(result.code, PREVIEW_EXIT.unsafe, String(publicUrl));
    assert.match(result.err, /publicUrl|preview\.json/, String(publicUrl));
    assert.equal(existsSync(previewPaths(root).statePath), false, "a supervisor was started anyway");
    assert.deepEqual(broker.accepted, []);
    assert.equal(loadOutbox(outbox, resolve(root)).events.length, 0);
  }
});

test("malformed persisted preview state publishes nothing", async () => {
  const root = tempDir("rc-preview-badstate-");
  writeFileSync(previewPaths(root).statePath, JSON.stringify({ schema: PREVIEW_SCHEMA, instanceId: "bad", childPid: -1 }), { mode: 0o600 });
  const outbox = activeOutbox(root);
  const broker = contractBroker();
  const result = await preview(root, broker.api, outbox, "status");
  assert.equal(result.code, PREVIEW_EXIT.unsafe);
  assert.deepEqual(broker.accepted, []);
  assert.equal(loadOutbox(outbox, resolve(root)).events.length, 0);
});

test("a failed preview publishes failure without child error text, even while the broker is down", { timeout: 60_000 }, async () => {
  const root = tempDir("rc-preview-failed-");
  const script = join(root, "crash.mjs");
  writeFileSync(script, `console.error("EADDRINUSE secret-path " + process.cwd()); process.exit(3);`);
  const outbox = activeOutbox(root);
  const broker = contractBroker();
  broker.setOffline(true);
  // A generous readiness timeout: the crash ends the start at once, and a slow
  // supervisor spawn on a loaded host must not turn launchFailed into timeout.
  const failed = await preview(root, broker.api, outbox, "start", { command: process.execPath, args: [script], timeoutMs: "20000" });
  assert.equal(failed.code, PREVIEW_EXIT.launchFailed, "RC must not change the preview result");
  assert.match(failed.err, /exited before readiness/);
  const queued = loadOutbox(outbox, resolve(root)).events.filter((event) => event.event_type === "preview");
  assert.equal(queued.at(-1)?.payload["phase"], "failed", "the failure is durable for the next flush");

  broker.setOffline(false);
  const replay = openRcPreviewPublisher(broker.api, resolve(root), outbox);
  assert.ok(replay);
  replay.observe({ phase: "failed", instanceId: randomUUID() });
  await replay.drain();
  assert.deepEqual(broker.rejected, []);
  const sent = previews(broker);
  assert.ok(sent.length >= 2);
  assert.ok(sent.every((payload) => payload["phase"] === "starting" || payload["phase"] === "failed"));
  assert.doesNotMatch(JSON.stringify(broker.accepted), /EADDRINUSE|secret-path|exit|exited|crash\.mjs/);
});

test("a terminal failure discovered by status is published, its error text is not", async () => {
  const root = tempDir("rc-preview-stale-");
  const paths = previewPaths(root);
  const instanceId = randomUUID();
  const failed: PreviewState = {
    schema: PREVIEW_SCHEMA, instanceId, projectRoot: dirname(dirname(paths.dir)),
    commandDigest: "b".repeat(64), phase: "failed", supervisorPid: 2_147_483_646, childPid: 0, controlPort: 9,
    startedAt: new Date().toISOString(), error: "dev command exited after readiness (exit 1)",
  };
  writeFileSync(paths.statePath, JSON.stringify(failed), { mode: 0o600 });
  const outbox = activeOutbox(root);
  const broker = contractBroker();
  const result = await preview(root, broker.api, outbox, "status");
  assert.equal(result.code, PREVIEW_EXIT.notRunning);
  assert.deepEqual(broker.rejected, []);
  const sent = previews(broker);
  assert.deepEqual(sent.map((payload) => payload["phase"]), ["failed"]);
  assert.equal(sent[0]?.["instance_id"], previewPublicId(SESSION, instanceId));
  assert.doesNotMatch(JSON.stringify(sent), /exited|readiness|exit 1/);
});

// ── 4. Review findings ──────────────────────────────────────────────────────

/** Poll a condition with a bounded, unref'd wait; never hangs the run. */
async function waitFor(condition: () => boolean, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((done) => setTimeout(done, 50).unref());
  }
}

/** A preview declaration with a long-running loopback server. */
function declaredProject(prefix: string, publicUrl: unknown): string {
  const root = tempDir(prefix);
  const script = join(root, "server.mjs");
  writeFileSync(script, SERVER);
  mkdirSync(join(root, ".aether"));
  writeFileSync(join(root, ".aether", "preview.json"), JSON.stringify({
    version: 1, command: process.execPath, args: [script], timeoutMs: 15_000, publicUrl,
  }));
  return root;
}

test("an idle preview publisher re-reads the outbox and never erases another writer's queued events", async () => {
  // Review finding: the publisher held the record it loaded when it opened and
  // saved it whole on every observation, erasing whatever another writer (the
  // coding observer, an orchestra or media publisher) queued in between.
  const root = tempDir("rc-preview-writers-");
  const path = activeOutbox(root);
  const broker = contractBroker();
  broker.setOffline(true);
  const publisher = openRcPreviewPublisher(broker.api, resolve(root), path);
  assert.ok(publisher, "opened before the other writer queues anything");
  const observer = openRcCodingObserver(resolve(root), broker.api, path);
  assert.ok(observer);

  observer.feed({ type: "stage", name: "execute", face: "" });
  await observer.drain();
  const instanceId = randomUUID();
  publisher.observe({ phase: "starting", instanceId });
  await publisher.drain();
  assert.deepEqual(loadOutbox(path, resolve(root)).events.map((event) => event.event_type), ["plan", "preview"]);

  observer.feed({ type: "stage", name: "verify", face: "" });
  await observer.drain();
  publisher.observe({ phase: "failed", instanceId });
  await publisher.drain();
  const queued = loadOutbox(path, resolve(root)).events;
  assert.ok(queued.some((event) => event.event_type === "plan"), "the coding observer's events survive the preview save");
  assert.equal(queued.at(-1)?.payload["phase"], "failed");
  assert.deepEqual(broker.accepted, []);

  broker.setOffline(false);
  publisher.observe({ phase: "stopped", instanceId });
  await publisher.drain();
  assert.deepEqual(broker.rejected, []);
  assert.ok((broker.accepted as Sent[]).some((event) => event.event_type === "plan"), "the other writer's backlog is delivered too");
  assert.equal(loadOutbox(path, resolve(root)).events.length, 0);
});

test("start publishes a stale supervisor failure before it replaces the state", { timeout: 60_000 }, async (t) => {
  // Review finding: `preview start` removed a terminal failed state (e.g. the
  // dev server exited after ready) without telling the viewer, which kept
  // showing the old preview as ready.
  const root = tempDir("rc-preview-stale-start-");
  const script = join(root, "server.mjs");
  writeFileSync(script, SERVER);
  const paths = previewPaths(root);
  const staleId = randomUUID();
  const stale: PreviewState = {
    schema: PREVIEW_SCHEMA, instanceId: staleId, projectRoot: dirname(dirname(paths.dir)),
    commandDigest: "c".repeat(64), phase: "failed", supervisorPid: 2_147_483_646, childPid: 0, controlPort: 9,
    startedAt: new Date().toISOString(), error: "dev command exited after readiness (exit 1)",
  };
  writeFileSync(paths.statePath, JSON.stringify(stale), { mode: 0o600 });
  const outbox = activeOutbox(root);
  const broker = contractBroker();
  t.after(async () => { if (existsSync(paths.statePath)) await preview(root, broker.api, outbox, "stop"); });

  const started = await preview(root, broker.api, outbox, "start", { command: process.execPath, args: [script], timeoutMs: "15000" });
  assert.equal(started.code, PREVIEW_EXIT.ok, started.err);
  assert.deepEqual(broker.rejected, []);
  const sent = previews(broker);
  assert.deepEqual(sent.map((payload) => payload["phase"]), ["failed", "starting", "ready"]);
  assert.equal(sent[0]?.["instance_id"], previewPublicId(SESSION, staleId), "the old card is the one marked failed");
  assert.notEqual(sent[1]?.["instance_id"], sent[0]?.["instance_id"], "the new launch is a new card");
  assert.doesNotMatch(JSON.stringify(sent), /exited|readiness|exit 1/);
});

test("previewOptionsFromFlags passes args only when --arg was given", () => {
  const found = findDispatchedCliCommand("preview");
  assert.ok(found);
  const parse = (args: string[]) => commandFlags(found, parseArgs({
    args: ["preview", ...args], allowPositionals: true, strict: true, options: COMMAND_PARSE_OPTIONS,
  }).values as Record<string, unknown>);
  assert.equal(previewOptionsFromFlags(parse(["start"])).args, undefined, "no --arg must not erase declared args");
  assert.deepEqual(previewOptionsFromFlags(parse(["start", "--arg", "x", "--arg", "y"])).args, ["x", "y"]);
});

test("the real CLI flag path launches declared args and publishes the declared public URL at ready", { timeout: 60_000 }, async (t) => {
  // Review finding: `args: flags.list("arg")` is [] without --arg, and [] beat
  // the declaration, so the bare executable launched and a declared publicUrl
  // could never match the launch digest. Driven exactly as main.ts does.
  const root = declaredProject("rc-preview-cli-", "https://preview.example/app");
  const configDir = tempDir("rc-preview-config-");
  const previousConfig = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = configDir;
  const outbox = rcOutboxPath(projectRefFor(resolve(root)));
  saveOutbox(outbox, createOutbox({
    session_id: SESSION, project_ref: projectRefFor(resolve(root)), device_id: "dev-preview", epoch: 1,
    project_root: resolve(root),
  }));
  const broker = contractBroker();
  t.after(async () => {
    if (existsSync(previewPaths(root).statePath)) await preview(root, broker.api, outbox, "stop");
    if (previousConfig === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = previousConfig;
  });

  const found = findDispatchedCliCommand("preview");
  assert.ok(found);
  const { values } = parseArgs({
    args: ["preview", "start", "--no-open"], allowPositionals: true, strict: true, options: COMMAND_PARSE_OPTIONS,
  });
  const handler = await found.load();
  let printed = "";
  const writes = { out: process.stdout.write, err: process.stderr.write };
  const capture = ((chunk: unknown) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
  process.stdout.write = capture;
  process.stderr.write = capture;
  let code: number;
  try {
    code = await handler(context(root, broker.api), ["start"], commandFlags(found, values as Record<string, unknown>));
  } finally {
    process.stdout.write = writes.out;
    process.stderr.write = writes.err;
  }
  assert.equal(code, PREVIEW_EXIT.ok, printed);
  assert.match(printed, /server\.mjs/, "the declared args are in the launched argv");
  await waitFor(() => previews(broker).some((payload) => payload["phase"] === "ready"), "the ready frame");
  assert.deepEqual(broker.rejected, []);
  const ready = previews(broker).find((payload) => payload["phase"] === "ready");
  assert.equal(ready?.["url"], "https://preview.example/app");
});

test("an invalid publicUrl blocks start only while an RC session is active", { timeout: 60_000 }, async (t) => {
  // Review finding: publicUrl matters only to RC, yet an invalid one failed a
  // purely local `preview start`. Without a session it is ignored with a
  // warning; with one it still fails closed (see the malformed test above).
  const root = declaredProject("rc-preview-local-only-", "https://192.168.0.10:5173/?sig=abc");
  const missing = join(tempDir("rc-preview-nosession-"), "outbox.json");
  const broker = contractBroker();
  t.after(async () => { if (existsSync(previewPaths(root).statePath)) await preview(root, broker.api, missing, "stop"); });

  const started = await preview(root, broker.api, missing, "start");
  assert.equal(started.code, PREVIEW_EXIT.ok, started.err);
  assert.match(started.err, /publicUrl/);
  assert.doesNotMatch(started.err, /192\.168|sig=abc/, "the refused value is not echoed");
  assert.equal(existsSync(missing), false, "no outbox is created without a session");
  assert.deepEqual(broker.accepted, []);
});

test("a cancelled start publishes stopped only once the supervisor's state is gone", { timeout: 60_000 }, async (t) => {
  // Review finding: cancel published `stopped` right after terminateProcessTree
  // (SIGTERM on Unix, a forced kill on Windows), before cleanup was confirmed.
  const root = tempDir("rc-preview-cancel-");
  const script = join(root, "slow.mjs");
  writeFileSync(script, "setInterval(() => {}, 1000);"); // never prints a ready URL
  const paths = previewPaths(root);
  const outbox = activeOutbox(root);
  const broker = contractBroker();
  const statePresentAtStopped: boolean[] = [];
  const post = broker.api.postJson.bind(broker.api) as (...args: unknown[]) => Promise<unknown>;
  (broker.api as unknown as { postJson: (...args: unknown[]) => Promise<unknown> }).postJson = async (...args: unknown[]) => {
    for (const event of (args[1] as { events: Sent[] }).events) {
      if (event.event_type === "preview" && event.payload["phase"] === "stopped") {
        statePresentAtStopped.push(existsSync(paths.statePath));
      }
    }
    return post(...args);
  };

  // The test runner listens for SIGTERM itself; detach it while the preview's
  // own handler is the only one, so the signal cancels the start and nothing else.
  const runnerListeners = process.listeners("SIGTERM");
  process.removeAllListeners("SIGTERM");
  try {
    const running = preview(root, broker.api, outbox, "start", { command: process.execPath, args: [script], timeoutMs: "30000" });
    await waitFor(() => previews(broker).some((payload) => payload["phase"] === "starting"), "the starting frame", 20_000);
    process.emit("SIGTERM", "SIGTERM");
    const result = await running;
    assert.equal(result.code, 130, result.err);
  } finally {
    for (const listener of runnerListeners) process.on("SIGTERM", listener as NodeJS.SignalsListener);
  }
  t.after(() => {
    // A forced kill (Windows) can leave the state file behind; nothing runs.
    try { if (existsSync(paths.statePath)) rmSync(paths.statePath, { force: true }); } catch { /* best effort */ }
  });
  // `stopped` may follow later (the confirmation never holds the command), and
  // only once the state file is gone. On Unix SIGTERM lets the supervisor
  // clean up; a forced kill (Windows) leaves the file, and the viewer rightly
  // stays at `stopping`.
  const gone = await waitFor(() => !existsSync(paths.statePath), "state file removal", 6_000).then(() => true, () => false);
  if (gone) await waitFor(() => previews(broker).some((payload) => payload["phase"] === "stopped"), "stopped after cleanup");
  assert.deepEqual(broker.rejected, []);
  assert.deepEqual(previews(broker).map((payload) => payload["phase"]),
    gone ? ["starting", "stopping", "stopped"] : ["starting", "stopping"]);
  assert.deepEqual(statePresentAtStopped.filter(Boolean), [], "stopped was published while the state file still existed");
});
