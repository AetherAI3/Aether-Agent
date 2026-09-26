// Transport routing drift — the silent degrade, made loud.
//
// The live defect this pins: against production, `aether agent --model kimi_k3
// "<task>"` POSTed /agent/dev/sessions, got 403 {"detail":"agent dev sessions
// disabled"}, and isLegacyServer() quietly rerouted the run onto the one-way
// /agent/chat/stream — where tools run SERVER-side against the cloud vault,
// not in the user's checkout. The run printed the ordinary neo-lite header, a
// model reply, and exit 0. Nothing anywhere said the transport had changed.
//
// Two invariants are asserted here, both on EVENTS and EXIT CODES, never on
// printed prose alone:
//
//   1. A downgrade is announced BEFORE the first model event (ordering is the
//      whole point — an explanation after the answer is not an explanation).
//   2. A run that needs local authority (`aether agent`, or an explicit
//      --model) REFUSES the downgrade with a stable exit code, and issues no
//      chat-stream request at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CloudBrain, refusalReason, routingDrift } from "../src/core/brain_cloud.js";
import { ApiClient } from "../src/core/transport.js";
import { HostRenderer, routingDriftLines } from "../src/ui/host_render.js";
import { cmdCode, EXIT_ROUTING_REFUSED } from "../src/commands/code.js";
import type { BrainEvent } from "../src/core/brain_protocol.js";
import type { TokenStore } from "../src/core/auth.js";
import type { AppContext } from "../src/core/context.js";

const tokens = { get: async () => "aek_t" } as unknown as TokenStore;

interface Call {
  method: string;
  url: string;
}

/**
 * A server that refuses the dev-session create with `status`/`detail` and
 * answers anything else with a two-frame legacy chat stream. `calls` is the
 * evidence: "no chat-stream request was made" is only assertable against a
 * request log, never against what the terminal happened to print.
 */
function refusingServer(status: number, detail: string) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url });
    if (url.includes("/agent/dev/sessions")) {
      return {
        ok: false,
        status,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ detail }),
        json: async () => ({ detail }),
        body: null,
      } as unknown as Response;
    }
    const bytes = new TextEncoder().encode(
      [
        `data: ${JSON.stringify({ type: "delta", text: "legacy reply" })}\n\n`,
        `data: ${JSON.stringify({ type: "done", uvt: 1, cents: 0 })}\n\n`,
      ].join(""),
    );
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: (async function* (): AsyncIterable<Uint8Array> {
        yield bytes;
      })(),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

/** A server that grants the dev session (the no-drift control case). */
function grantingServer() {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url });
    if (url.endsWith("/agent/dev/sessions")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ session_id: "devs_ok", protocol_version: 1, model: "kimi_k3" }),
        json: async () => ({ session_id: "devs_ok", protocol_version: 1, model: "kimi_k3" }),
        body: null,
      } as unknown as Response;
    }
    const bytes = new TextEncoder().encode(
      `data: ${JSON.stringify({ type: "done", seq: 1, ok: true, uvt: 1, cents: 0 })}\n\n`,
    );
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: (async function* (): AsyncIterable<Uint8Array> {
        yield bytes;
      })(),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

async function withFetch<T>(f: typeof globalThis.fetch, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

/** A chat-shaped task: no pinned model, so the fail-closed contract is off. */
const CHAT_TASK = { type: "task" as const, text: "hello", cwd: ".", poolGb: 5 };
/** A coding task with a hand-pinned model — the live defect's exact shape. */
const AGENT_TASK = { ...CHAT_TASK, text: "fix it", model: "kimi_k3" };

async function drain(brain: CloudBrain, task: typeof CHAT_TASK): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const ev of brain.run(task)) out.push(ev);
  return out;
}

function drift(events: BrainEvent[]): Extract<BrainEvent, { type: "routing_drift" }> | undefined {
  return events.find((e) => e.type === "routing_drift") as
    | Extract<BrainEvent, { type: "routing_drift" }>
    | undefined;
}

// --- 1. the announcement itself -------------------------------------------

test("a 403 dev-session refusal emits a routing_drift event carrying the status and the sanitized server reason", async () => {
  const { fetchImpl } = refusingServer(403, "agent dev sessions disabled");
  await withFetch(fetchImpl, async () => {
    const events = await drain(new CloudBrain(new ApiClient("https://stub.test", tokens)), CHAT_TASK);
    const d = drift(events);
    assert.ok(d, "a silent downgrade is the defect: there must be an event");
    assert.equal(d.kind, "routing_drift");
    assert.equal(d.requested, "dev_session");
    assert.equal(d.resolved, "chat_stream");
    assert.equal(d.status, 403);
    assert.equal(d.reason, "agent dev sessions disabled");
    // The consequence is stated in plain words, not implied by a transport name.
    assert.match(d.consequence, /tools run on the server/);
    assert.match(d.consequence, /no files here will change/);
  });
});

test("a 404 dev-session refusal emits the same event with status 404", async () => {
  const { fetchImpl } = refusingServer(404, "Not Found");
  await withFetch(fetchImpl, async () => {
    const events = await drain(new CloudBrain(new ApiClient("https://stub.test", tokens)), CHAT_TASK);
    const d = drift(events);
    assert.ok(d);
    assert.equal(d.status, 404);
    assert.equal(d.reason, "Not Found");
    assert.equal(d.resolved, "chat_stream");
  });
});

test("a pre-stream 401 ends with one explicit failed terminal and no legacy fallback", async () => {
  const { fetchImpl, calls } = refusingServer(401, "invalid session");
  await withFetch(fetchImpl, async () => {
    const events = await drain(new CloudBrain(new ApiClient("https://stub.test", tokens)), AGENT_TASK);
    const terminals = events.filter((event) => event.type === "done");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.type === "done" && terminals[0].ok, false);
    assert.ok(events.some((event) => event.type === "error"));
    assert.equal(calls.filter((call) => call.url.includes("/agent/chat/stream")).length, 0);
  });
});

test("chat-shaped runs still degrade, but the drift event PRECEDES the first model event", async () => {
  const { fetchImpl, calls } = refusingServer(403, "agent dev sessions disabled");
  await withFetch(fetchImpl, async () => {
    const events = await drain(new CloudBrain(new ApiClient("https://stub.test", tokens)), CHAT_TASK);
    assert.ok(calls.some((c) => c.url.includes("/agent/chat/stream")), "chat must still work");
    const at = events.findIndex((e) => e.type === "routing_drift");
    const firstModel = events.findIndex((e) => e.type === "monologue");
    assert.notEqual(at, -1, "no drift event");
    assert.notEqual(firstModel, -1, "the legacy stream produced no model output to order against");
    assert.ok(at < firstModel, `drift must precede model output (drift@${at}, model@${firstModel})`);
  });
});

test("a granted dev session emits NO drift event", async () => {
  const { fetchImpl } = grantingServer();
  await withFetch(fetchImpl, async () => {
    const events = await drain(new CloudBrain(new ApiClient("https://stub.test", tokens)), AGENT_TASK);
    assert.equal(drift(events), undefined, "an ungraded run must not warn about a drift that did not happen");
    const done = events.find((e) => e.type === "done");
    assert.ok(done && done.type === "done" && done.ok === true);
  });
});

// --- 2. fail closed where local authority was the point --------------------

test("a run that requires local authority refuses the downgrade: no chat-stream request, terminal done ok:false", async () => {
  const { fetchImpl, calls } = refusingServer(403, "agent dev sessions disabled");
  await withFetch(fetchImpl, async () => {
    const brain = new CloudBrain(new ApiClient("https://stub.test", tokens), undefined, {
      requireLocalAuthority: true,
    });
    const events = await drain(brain, CHAT_TASK);
    const d = drift(events);
    assert.ok(d);
    assert.equal(d.fatal, true);
    assert.equal(d.resolved, "refused");
    assert.match(d.remediation, /AETHER_AGENT_DEV_ENABLED=1/);
    assert.ok(
      !calls.some((c) => c.url.includes("/agent/chat/stream")),
      "a refused run must not send the task to the server-side transport anyway",
    );
    const done = events.find((e) => e.type === "done");
    assert.ok(done && done.type === "done" && done.ok === false);
  });
});

test("an explicitly pinned --model fails closed on its own, without the caller opting in", async () => {
  // Pinning a model is an explicit contract about what runs. The legacy
  // envelope's model_pick_source:"manual" is a request the chat route may
  // ignore, so honoring the pin means refusing the route that cannot honor it.
  const { fetchImpl, calls } = refusingServer(403, "agent dev sessions disabled");
  await withFetch(fetchImpl, async () => {
    const events = await drain(new CloudBrain(new ApiClient("https://stub.test", tokens)), AGENT_TASK);
    const d = drift(events);
    assert.ok(d);
    assert.equal(d.fatal, true);
    assert.ok(!calls.some((c) => c.url.includes("/agent/chat/stream")));
  });
});

// --- 3. server text is never trusted with the terminal ----------------------

test("a server detail carrying terminal escapes is sanitized before it reaches the event", async () => {
  const { fetchImpl } = refusingServer(403, "\x1b[31mdisabled\x1b[0m \x1b]52;c;cGF5bG9hZA==\x07");
  await withFetch(fetchImpl, async () => {
    const events = await drain(new CloudBrain(new ApiClient("https://stub.test", tokens)), CHAT_TASK);
    const d = drift(events);
    assert.ok(d);
    assert.ok(!d.reason.includes("\x1b"), `ESC survived into the drift reason: ${JSON.stringify(d.reason)}`);
    assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(d.reason), "control characters must not reach the terminal");
    assert.match(d.reason, /disabled/, "the readable part of the server's answer is kept");
  });
});

test("refusalReason falls back to the error message when the body carries no explanation", () => {
  const reason = refusalReason(new Error("\x1b[31mboom\x1b[0m"));
  assert.ok(!reason.includes("\x1b"), JSON.stringify(reason));
  assert.match(reason, /boom/);
});

// --- 4. what the user and machines actually receive ------------------------

test("the rendered line carries the literal token ROUTING_DRIFT, not colour alone", () => {
  const lines = routingDriftLines(routingDrift(403, "agent dev sessions disabled", true));
  const joined = lines.join("\n");
  assert.ok(joined.includes("ROUTING_DRIFT"), joined);
  // Strip every SGR sequence: the meaning must survive on a dumb terminal.
  const plain = joined.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(plain.includes("ROUTING_DRIFT"));
  assert.match(plain, /HTTP 403/);
  assert.match(plain, /no files here will change/);
  assert.match(plain, /AETHER_AGENT_DEV_ENABLED=1/);
});

test("--json carries the drift as a structured record, not a printed sentence", () => {
  const out = new PassThrough();
  const err = new PassThrough();
  let stdout = "";
  out.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
  const renderer = new HostRenderer({ poolGb: 5, json: true, out, err });
  renderer.event(routingDrift(403, "agent dev sessions disabled", true));
  const record = JSON.parse(stdout.trim()) as Record<string, unknown>;
  assert.equal(record["kind"], "routing_drift");
  assert.equal(record["requested"], "dev_session");
  assert.equal(record["status"], 403);
  assert.equal(record["reason"], "agent dev sessions disabled");
  assert.equal(record["fatal"], true);
});

test("the non-json renderer writes the drift to stderr, leaving piped stdout clean", () => {
  const out = new PassThrough();
  const err = new PassThrough();
  let stdout = "";
  let stderr = "";
  out.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
  err.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
  new HostRenderer({ poolGb: 5, out, err }).event(routingDrift(404, "Not Found", false));
  assert.ok(stderr.includes("ROUTING_DRIFT"), stderr);
  assert.equal(stdout, "");
});

// --- 5. the exit code a script can act on ----------------------------------

test("`aether agent` against a server with dev sessions disabled exits 3 and makes no chat request", async () => {
  const { fetchImpl, calls } = refusingServer(403, "agent dev sessions disabled");
  const dir = mkdtempSync(join(tmpdir(), "aether-drift-"));
  const ctx = {
    cfg: { backend: "cloud", permissionMode: "ask" },
    api: new ApiClient("https://stub.test", tokens),
    tokens,
    confirm: async () => false,
    flags: { json: false, audit: false, yes: false, cwd: dir, model: "kimi_k3" },
  } as unknown as AppContext;
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stderr.write = ((s: string) => ((captured += s), true)) as typeof process.stderr.write;
  process.stdout.write = ((s: string) => ((captured += s), true)) as typeof process.stdout.write;
  try {
    const code = await withFetch(fetchImpl, () =>
      cmdCode(ctx, "reply with the single word DONE", {
        local: false,
        pool: 5,
        quiet: true,
        noLog: true,
      }),
    );
    assert.equal(code, EXIT_ROUTING_REFUSED, captured);
    assert.equal(EXIT_ROUTING_REFUSED, 3);
    assert.ok(
      !calls.some((c) => c.url.includes("/agent/chat/stream")),
      "the coding task must never be sent to the server-side transport",
    );
    assert.ok(captured.includes("ROUTING_DRIFT"), captured);
    assert.match(captured, /AETHER_AGENT_DEV_ENABLED=1/);
  } finally {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JSON `aether agent` appends one parseable failed turn outcome after fatal routing drift", async () => {
  const { fetchImpl, calls } = refusingServer(403, "agent dev sessions disabled");
  const dir = mkdtempSync(join(tmpdir(), "aether-drift-json-"));
  const prompt = "private prompt must not be copied into the outcome";
  const ctx = {
    cfg: { backend: "cloud", permissionMode: "ask" },
    api: new ApiClient("https://stub.test", tokens),
    tokens,
    confirm: async () => false,
    flags: { json: true, audit: false, yes: false, cwd: dir, model: "kimi_k3" },
  } as unknown as AppContext;
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  let stdout = "";
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.stdout.write = ((chunk: unknown) => ((stdout += String(chunk)), true)) as typeof process.stdout.write;
  try {
    const code = await withFetch(fetchImpl, () =>
      cmdCode(ctx, prompt, {
        local: false,
        pool: 5,
        quiet: true,
        noLog: true,
      }),
    );
    assert.equal(code, EXIT_ROUTING_REFUSED);
    assert.ok(!calls.some((call) => call.url.includes("/agent/chat/stream")));
    const records = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records[0]?.["kind"], "routing_drift");
    const outcome = records.at(-1);
    assert.equal(outcome?.["protocol"], "aether.turn/1");
    assert.equal(outcome?.["type"], "turn_outcome");
    assert.equal(outcome?.["state"], "failed");
    assert.equal(outcome?.["prompt_preserved"], true);
    assert.equal("prompt" in (outcome ?? {}), false);
    assert.equal(JSON.stringify(outcome).includes(prompt), false);
    assert.equal(records.filter((record) => record["type"] === "turn_outcome").length, 1);
  } finally {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
    rmSync(dir, { recursive: true, force: true });
  }
});
