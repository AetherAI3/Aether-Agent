// CloudBrain dev-session protocol — the bidirectional tool round-trip.
//
// Proves the spec Gate-1 client half: session create (effort + capabilities on
// the wire), tool_call frames surfacing as BrainEvents, sendToolResult POSTing
// upstream, seq-based duplicate suppression (a replayed mutating call never
// executes twice), reconnect-from-seq, control(), close() teardown, and the
// legacy fallback split (404/403 → old chat stream; other errors surface).

import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudBrain, checkDevSession, devProtocolVersions } from "../src/core/brain_cloud.js";
import { ApiClient } from "../src/core/transport.js";
import type { BrainEvent } from "../src/core/brain_protocol.js";
import type { TokenStore } from "../src/core/auth.js";

const tokens = { get: async () => "aek_t" } as unknown as TokenStore;

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** A dev-protocol server fake: create → JSON; stream attempts → scripted SSE
 *  bodies (one per reconnect); tool-results/control/DELETE → recorded JSON. */
function devServer(
  streams: string[][],
  opts?: { failToolResultTimes?: number; sessionId?: string | null; protocolVersion?: number | null },
) {
  const calls: Call[] = [];
  let attempt = 0;
  let toolResultFailures = opts?.failToolResultTimes ?? 0;
  // null means "omit the field entirely" — a 200 that answers neither question.
  const sessionId = opts?.sessionId === undefined ? "devs_abc" : opts.sessionId;
  const protocolVersion = opts?.protocolVersion === undefined ? 1 : opts.protocolVersion;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });

    const json = (status: number, payload: unknown): Response =>
      ({
        ok: status < 400,
        status,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify(payload),
        json: async () => payload,
        body: null,
      }) as unknown as Response;

    if (url.endsWith("/agent/dev/sessions") && method === "POST") {
      const created: Record<string, unknown> = { model: "sonnet", tools: ["read_file", "write_file"] };
      if (sessionId !== null) created["session_id"] = sessionId;
      if (protocolVersion !== null) created["protocol_version"] = protocolVersion;
      return json(200, created);
    }
    if (url.includes("/stream") && method === "GET") {
      const frames = streams[Math.min(attempt, streams.length - 1)] ?? [];
      attempt += 1;
      const bytes = new TextEncoder().encode(frames.map((e) => `data: ${e}\n\n`).join(""));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: (async function* (): AsyncIterable<Uint8Array> {
          yield bytes;
        })(),
      } as unknown as Response;
    }
    if (url.includes("/tool-results")) {
      if (toolResultFailures > 0) {
        toolResultFailures -= 1;
        return json(500, { detail: "transient" });
      }
      return json(200, { accepted: true, duplicate: false });
    }
    if (url.includes("/control")) return json(200, { ok: true, state: "running" });
    if (method === "DELETE") return json(200, {});
    return json(404, { detail: "unexpected" });
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

const TASK = { type: "task" as const, text: "fix it", cwd: ".", poolGb: 5, effort: "CODEPRO", model: "sonnet" };

function frame(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

test("dev session: create carries effort + capabilities; tool_call surfaces and sendToolResult POSTs upstream", async () => {
  const { fetchImpl, calls } = devServer([
    [
      frame({ type: "session", seq: 1, session_id: "devs_abc", protocol_version: 1, model: "sonnet" }),
      frame({ type: "tool_call", seq: 2, tool_call_id: "tc_1", name: "read_file", args: { path: "a.py" }, risk: "read" }),
      frame({ type: "tool_result_ack", seq: 3, tool_call_id: "tc_1" }),
      frame({ type: "delta", seq: 4, text: "done!" }),
      frame({ type: "done", seq: 5, ok: true, uvt: 10, cents: 0.1 }),
    ],
  ]);
  await withFetch(fetchImpl, async () => {
    const brain = new CloudBrain(new ApiClient("https://stub.test", tokens));
    const out: BrainEvent[] = [];
    for await (const ev of brain.run(TASK)) {
      out.push(ev);
      if (ev.type === "tool_call") {
        brain.sendToolResult(ev.id, { output: "print('hi')", exitCode: 0 });
      }
    }
    // give the serialized upstream POST a tick to land
    await new Promise((r) => setTimeout(r, 20));

    const create = calls.find((c) => c.url.endsWith("/agent/dev/sessions"));
    assert.ok(create);
    const createBody = create.body as Record<string, unknown>;
    assert.equal(createBody["effort"], "CODEPRO");
    assert.equal(createBody["surface"], "aether_agent");
    assert.ok(Array.isArray(createBody["capabilities"]));
    assert.ok((createBody["capabilities"] as string[]).includes("run_shell"));
    assert.ok((createBody["capabilities"] as string[]).includes("list_directory"));
    assert.ok((createBody["capabilities"] as string[]).includes("patch_file"));
    assert.equal(createBody["read_file_ranges"], true);

    const tc = out.find((e) => e.type === "tool_call");
    assert.ok(tc && tc.type === "tool_call");
    assert.equal(tc.id, "tc_1");
    assert.equal(tc.name, "read_file");
    assert.deepEqual(tc.args, { path: "a.py" });

    const post = calls.find((c) => c.url.includes("/tool-results"));
    assert.ok(post, "tool result was never POSTed");
    const postBody = post.body as Record<string, unknown>;
    assert.equal(postBody["tool_call_id"], "tc_1");
    assert.equal(postBody["status"], "ok");
    assert.equal(postBody["exit_code"], 0);
    assert.equal(postBody["output"], "print('hi')");

    const done = out.find((e) => e.type === "done");
    assert.ok(done && done.type === "done" && done.ok === true);
  });
});

test("dev session: a replayed frame (seq <= high-water mark) is skipped — a mutating tool_call never fires twice", async () => {
  const tcFrame = frame({ type: "tool_call", seq: 2, tool_call_id: "tc_1", name: "write_file", args: { path: "a", content: "b" }, risk: "write" });
  const { fetchImpl } = devServer([
    [
      frame({ type: "delta", seq: 1, text: "x" }),
      tcFrame,
      tcFrame, // duplicate delivery of the same SSE frame
      frame({ type: "done", seq: 3, ok: true, uvt: 1, cents: 0 }),
    ],
  ]);
  await withFetch(fetchImpl, async () => {
    const brain = new CloudBrain(new ApiClient("https://stub.test", tokens));
    const out: BrainEvent[] = [];
    for await (const ev of brain.run(TASK)) out.push(ev);
    const toolCalls = out.filter((e) => e.type === "tool_call");
    assert.equal(toolCalls.length, 1);
  });
});

for (const scenario of [
  {
    name: "a replay_truncated notice followed by a sequence gap",
    frames: [
      frame({ type: "delta", seq: 1, text: "retained" }),
      frame({ type: "notice", notice: "replay_truncated", oldest_seq: 4 }),
      frame({ type: "tool_call", seq: 4, tool_call_id: "tc_gap", name: "write_file", args: { path: "a", content: "b" }, risk: "write" }),
      frame({ type: "done", seq: 5, ok: true, uvt: 1, cents: 0 }),
    ],
  },
  {
    name: "a mutating tool_call with no sequence",
    frames: [
      frame({ type: "tool_call", tool_call_id: "tc_missing", name: "write_file", args: { path: "a", content: "b" }, risk: "write" }),
      frame({ type: "done", seq: 1, ok: true, uvt: 1, cents: 0 }),
    ],
  },
  {
    name: "a mutating tool_call with a fractional sequence",
    frames: [
      frame({ type: "tool_call", seq: 0.5, tool_call_id: "tc_fractional", name: "write_file", args: { path: "a", content: "b" }, risk: "write" }),
      frame({ type: "done", seq: 1, ok: true, uvt: 1, cents: 0 }),
    ],
  },
  {
    name: "a mutating tool_call after an unannounced sequence gap",
    frames: [
      frame({ type: "delta", seq: 1, text: "before gap" }),
      frame({ type: "tool_call", seq: 3, tool_call_id: "tc_unannounced_gap", name: "write_file", args: { path: "a", content: "b" }, risk: "write" }),
      frame({ type: "done", seq: 4, ok: true, uvt: 1, cents: 0 }),
    ],
  },
] as const) {
  test(`dev session fails closed before ${scenario.name}`, async () => {
    const { fetchImpl } = devServer([[...scenario.frames]]);
    await withFetch(fetchImpl, async () => {
      const brain = new CloudBrain(new ApiClient("https://stub.test", tokens));
      const out: BrainEvent[] = [];
      for await (const ev of brain.run(TASK)) out.push(ev);

      assert.deepEqual(
        out.filter((event) => event.type === "tool_call"),
        [],
        "an untrusted sequence must never reach the host tool executor",
      );
      assert.ok(
        out.some((event) => event.type === "error" || (event.type === "done" && !event.ok)),
        "the sequence violation must make the run observably fail closed",
      );
    });
  });
}

test("dev session: a dropped stream reconnects from last_seq and finishes", async () => {
  const { fetchImpl, calls } = devServer([
    [
      frame({ type: "delta", seq: 1, text: "part one" }),
      // stream ends here with no terminal frame — client must reconnect
    ],
    [
      frame({ type: "delta", seq: 2, text: "part two" }),
      frame({ type: "done", seq: 3, ok: true, uvt: 1, cents: 0 }),
    ],
  ]);
  await withFetch(fetchImpl, async () => {
    const brain = new CloudBrain(new ApiClient("https://stub.test", tokens));
    const out: BrainEvent[] = [];
    for await (const ev of brain.run(TASK)) out.push(ev);

    const streamCalls = calls.filter((c) => c.url.includes("/stream"));
    assert.equal(streamCalls.length, 2);
    assert.ok(!streamCalls[0]!.url.includes("last_seq"));
    assert.match(streamCalls[1]!.url, /last_seq=1/);

    const done = out.find((e) => e.type === "done");
    assert.ok(done && done.type === "done" && done.ok === true);
  });
});

test("dev session: a server error frame ends the run done ok:false (never fabricated success)", async () => {
  const { fetchImpl } = devServer([
    [
      frame({ type: "delta", seq: 1, text: "partial" }),
      frame({ type: "error", seq: 2, msg: "host did not return a result for run_shell within 960s" }),
    ],
  ]);
  await withFetch(fetchImpl, async () => {
    const brain = new CloudBrain(new ApiClient("https://stub.test", tokens));
    const out: BrainEvent[] = [];
    for await (const ev of brain.run(TASK)) out.push(ev);
    const done = out.find((e) => e.type === "done");
    assert.ok(done && done.type === "done");
    assert.equal(done.ok, false);
    assert.match(done.result, /did not return a result/);
  });
});

test("dev session: done ok:false from the server stays ok:false", async () => {
  const { fetchImpl } = devServer([
    [frame({ type: "done", seq: 1, ok: false, uvt: 1, cents: 0 })],
  ]);
  await withFetch(fetchImpl, async () => {
    const brain = new CloudBrain(new ApiClient("https://stub.test", tokens));
    const out: BrainEvent[] = [];
    for await (const ev of brain.run(TASK)) out.push(ev);
    const done = out.find((e) => e.type === "done");
    assert.ok(done && done.type === "done" && done.ok === false);
  });
});

test("dev session: control() fails closed after the server session has ended", async () => {
  const { fetchImpl, calls } = devServer([
    [frame({ type: "done", seq: 1, ok: true, uvt: 1, cents: 0 })],
  ]);
  await withFetch(fetchImpl, async () => {
    const brain = new CloudBrain(new ApiClient("https://stub.test", tokens));
    const out: BrainEvent[] = [];
    for await (const ev of brain.run(TASK)) out.push(ev);
    assert.deepEqual(await brain.control("steer", "skip the billing code"), {
      accepted: false,
      state: "closed",
      error: "cloud dev session is not running",
    });
    assert.ok(!calls.some((c) => c.url.includes("/control")));
  });
});

test("dev session: close() tears the server session down (DELETE)", async () => {
  const { fetchImpl, calls } = devServer([
    [frame({ type: "done", seq: 1, ok: true, uvt: 1, cents: 0 })],
  ]);
  await withFetch(fetchImpl, async () => {
    const brain = new CloudBrain(new ApiClient("https://stub.test", tokens));
    const out: BrainEvent[] = [];
    for await (const ev of brain.run(TASK)) out.push(ev);
    brain.close();
    await new Promise((r) => setTimeout(r, 20));
    const del = calls.find((c) => c.method === "DELETE");
    assert.ok(del, "session was never deleted");
    assert.match(del.url, /\/agent\/dev\/sessions\/devs_abc$/);
  });
});

test("dev session: a transient tool-result POST failure is retried (idempotent upstream)", async () => {
  const { fetchImpl, calls } = devServer(
    [
      [
        frame({ type: "tool_call", seq: 1, tool_call_id: "tc_1", name: "read_file", args: { path: "a" } }),
        frame({ type: "done", seq: 2, ok: true, uvt: 1, cents: 0 }),
      ],
    ],
    { failToolResultTimes: 1 },
  );
  await withFetch(fetchImpl, async () => {
    const brain = new CloudBrain(new ApiClient("https://stub.test", tokens));
    for await (const ev of brain.run(TASK)) {
      if (ev.type === "tool_call") brain.sendToolResult(ev.id, { output: "x", exitCode: 0 });
    }
    await new Promise((r) => setTimeout(r, 1200));
    const posts = calls.filter((c) => c.url.includes("/tool-results"));
    assert.equal(posts.length, 2, "expected one failed POST and one retry");
  });
});

// The degrade now has a precondition: no local-authority contract. A run that
// pinned a model (TASK does) or a caller that asked for local authority
// refuses it instead — see brain_cloud_drift.test.ts. This case keeps the
// fail-soft half honest for a plain, unpinned run.
const UNPINNED = { type: "task" as const, text: "hello", cwd: ".", poolGb: 5 };

test("legacy fallback: a 404 on session create degrades to the one-way chat stream", async () => {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/agent/dev/sessions")) {
      return {
        ok: false,
        status: 404,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ detail: "Not Found" }),
        json: async () => ({ detail: "Not Found" }),
        body: null,
      } as unknown as Response;
    }
    const bytes = new TextEncoder().encode(
      [
        `data: ${frame({ type: "delta", text: "legacy reply" })}\n\n`,
        `data: ${frame({ type: "done", uvt: 1, cents: 0 })}\n\n`,
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

  await withFetch(fetchImpl, async () => {
    const brain = new CloudBrain(new ApiClient("https://stub.test", tokens));
    const out: BrainEvent[] = [];
    for await (const ev of brain.run(UNPINNED)) out.push(ev);
    assert.ok(calls.some((c) => c.url.includes("/agent/chat/stream")));
    // Fail-soft, but never silent.
    assert.ok(out.some((e) => e.type === "routing_drift"), "the degrade must be announced");
    const done = out.find((e) => e.type === "done");
    assert.ok(done && done.type === "done" && done.ok === true);
    // legacy path: no server session, so tool results/control are no-ops
    brain.sendToolResult("tc_x", { output: "x", exitCode: 0 });
    assert.equal((await brain.control("pause")).accepted, false);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!calls.some((c) => c.url.includes("/tool-results")));
    assert.ok(!calls.some((c) => c.url.includes("/control")));
  });
});

test("a non-404 create failure surfaces as an error, not a silent legacy downgrade", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/agent/dev/sessions")) {
      return {
        ok: false,
        status: 402,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({ detail: "quota exhausted" }),
        json: async () => ({ detail: "quota exhausted" }),
        body: null,
      } as unknown as Response;
    }
    throw new Error("legacy path must not be reached");
  }) as typeof globalThis.fetch;

  await withFetch(fetchImpl, async () => {
    const brain = new CloudBrain(new ApiClient("https://stub.test", tokens));
    const out: BrainEvent[] = [];
    for await (const ev of brain.run(TASK)) out.push(ev);
    assert.ok(out.some((e) => e.type === "error"));
    assert.ok(!out.some((e) => e.type === "monologue"));
  });
});

test("devProtocolVersions reads the accepted set from the capability contract", () => {
  // The contract has always carried this list; until now nothing consumed it.
  assert.deepEqual(devProtocolVersions({ dev_session_protocol_versions: [1, 2] }), [1, 2]);
  // Packaged contract when no resolved contract is supplied.
  assert.deepEqual(devProtocolVersions(), [1]);
  // A contract with a missing or unusable list still leaves the client with the
  // version it actually declares on the wire, never an empty accept-set.
  assert.deepEqual(devProtocolVersions({}), [1]);
  assert.deepEqual(devProtocolVersions({ dev_session_protocol_versions: ["two"] }), [1]);
});

test("checkDevSession names both versions so the message is actionable", () => {
  assert.equal(checkDevSession({ session_id: "s", protocol_version: 1 }, [1]), null);
  const mismatch = checkDevSession({ session_id: "s", protocol_version: 2 }, [1]);
  assert.ok(mismatch);
  assert.match(mismatch, /v2/);
  assert.match(mismatch, /v1/);
  assert.match(mismatch, /upgrade/i);
  assert.match(String(checkDevSession({ protocol_version: 1 }, [1])), /session_id/);
  assert.match(String(checkDevSession({ session_id: "  ", protocol_version: 1 }, [1])), /session_id/);
});

test("a create response with no session_id fails the run instead of streaming /undefined/stream", async () => {
  const { fetchImpl, calls } = devServer([[]], { sessionId: null });
  await withFetch(fetchImpl, async () => {
    const brain = new CloudBrain(new ApiClient("https://stub.test", tokens));
    const out: BrainEvent[] = [];
    for await (const ev of brain.run(TASK)) out.push(ev);
    assert.ok(out.some((e) => e.type === "error"), "must surface an error");
    assert.ok(
      !calls.some((c) => c.url.includes("undefined")),
      "must never build a request path out of an absent session id",
    );
  });
});

test("an unsupported dev protocol version fails the run and does NOT downgrade to legacy", async () => {
  // A version mismatch is not "this server has no dev route". Folding it into
  // the 404/403 downgrade would trade a loud, fixable incompatibility for a
  // silent loss of the local tool round-trip.
  const { fetchImpl, calls } = devServer([[]], { protocolVersion: 2 });
  await withFetch(fetchImpl, async () => {
    const brain = new CloudBrain(new ApiClient("https://stub.test", tokens));
    const out: BrainEvent[] = [];
    for await (const ev of brain.run(TASK)) out.push(ev);
    const err = out.find((e) => e.type === "error");
    assert.ok(err && err.type === "error");
    assert.match(err.msg, /v2/);
    assert.match(err.msg, /v1/);
    assert.ok(!calls.some((c) => c.url.includes("/agent/chat/stream")), "must not fall back to the legacy stream");
    assert.ok(!calls.some((c) => c.url.includes("/stream") && c.method === "GET"), "must not attach to the dev stream");
  });
});

test("a build whose contract advertises v2 attaches to a v2 session", async () => {
  // The accepted set comes from the resolved contract, so a client shipped with
  // a newer contract negotiates upward without another edit to brain_cloud.ts.
  const { fetchImpl, calls } = devServer(
    [[frame({ type: "done", seq: 1, ok: true, uvt: 1, cents: 0 })]],
    { protocolVersion: 2 },
  );
  await withFetch(fetchImpl, async () => {
    const brain = new CloudBrain(new ApiClient("https://stub.test", tokens), {
      contract: { contract_version: 1, dev_session_protocol_versions: [1, 2] },
      digest: "test",
      source: "fallback",
      overlay: null,
      warnings: [],
    });
    const out: BrainEvent[] = [];
    for await (const ev of brain.run(TASK)) out.push(ev);
    assert.ok(!out.some((e) => e.type === "error"), JSON.stringify(out));
    assert.ok(calls.some((c) => c.url.includes("/stream") && c.method === "GET"));
    const done = out.find((e) => e.type === "done");
    assert.ok(done && done.type === "done" && done.ok === true);
  });
});
