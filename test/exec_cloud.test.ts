import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { AppContext } from "../src/core/context.js";
import { CloudBrain } from "../src/core/brain_cloud.js";
import { HttpError } from "../src/core/errors.js";
import { HEADLESS_PROTOCOL_V2, validateHeadlessFrames } from "../src/core/headless_protocol.js";
import { HeadlessCheckpointStore } from "../src/core/headless_session.js";
import { runHeadlessExec } from "../src/commands/exec.js";

const encoder = new TextEncoder();
const successfulVerify = `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;
const hostedTextModel = "sonnet";

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "aether-exec-cloud-"));
  const git = (args: string[]): void => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", shell: false, windowsHide: true });
    assert.equal(result.status, 0, String(result.stderr));
  };
  git(["init", "--quiet"]);
  git(["config", "user.name", "Aether Test"]);
  git(["config", "user.email", "aether-test@example.invalid"]);
  writeFileSync(join(root, "tracked.txt"), "base\n", "utf8");
  git(["add", "tracked.txt"]);
  git(["commit", "--quiet", "-m", "fixture"]);
  return root;
}

function context(cwd: string, api: AppContext["api"], model?: string): AppContext {
  return {
    cfg: {
      baseUrl: "https://stub.test", defaultModel: hostedTextModel, permissionMode: "ask",
      autoApply: false, telemetry: false, defaultEffort: "LOW", backend: "cloud",
    },
    api,
    tokens: {} as AppContext["tokens"],
    flags: { json: false, audit: false, yes: false, cwd, ...(model ? { model } : {}) },
    confirm: async () => false,
  };
}

function sse(...frames: Record<string, unknown>[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield encoder.encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""));
  })();
}

test("cloud controls await and validate the Aether acknowledgement, failing closed on loss", async () => {
  let releaseStream!: () => void;
  const streamGate = new Promise<void>((resolve) => { releaseStream = resolve; });
  let releasePause!: (value: { ok: boolean; state: string }) => void;
  const pauseGate = new Promise<{ ok: boolean; state: string }>((resolve) => { releasePause = resolve; });
  const calls: Array<{ path: string; body: unknown }> = [];
  const api = {
    postJson: async (path: string, body: unknown) => {
      calls.push({ path, body });
      if (path === "/agent/dev/sessions") {
        return { session_id: "devs_cloud", protocol_version: 1, model: hostedTextModel };
      }
      if (path.endsWith("/control")) {
        const action = (body as Record<string, unknown>)["action"];
        if (action === "pause") return pauseGate;
        if (action === "steer") return { ok: true, state: "teleported" };
        throw new HttpError(503, "temporary control failure", { detail: "temporary control failure" });
      }
      return { accepted: true };
    },
    stream: async () => (async function* () {
      await streamGate;
      yield* sse({ type: "done", seq: 1, ok: true, uvt: 1, cents: 0 });
    })(),
    deleteJson: async () => undefined,
  } as unknown as AppContext["api"];
  const brain = new CloudBrain(api, undefined, {
    requireLocalAuthority: true,
    localToolCapabilities: ["read_file"],
  });
  const iterator = brain.run({
    type: "task", text: "inspect", cwd: ".", poolGb: 1, model: hostedTextModel,
  })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "stage");

  let settled = false;
  const pause = brain.control("pause").then((result) => { settled = true; return result; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "control was reported before the server acknowledgement");
  releasePause({ ok: true, state: "paused" });
  assert.deepEqual(await pause, { accepted: true, state: "paused" });
  const failed = await brain.control("resume");
  assert.equal(failed.accepted, false);
  assert.equal(failed.state, "paused");
  assert.match(failed.error ?? "", /temporary control failure/);
  assert.deepEqual(await brain.control("steer", "stay scoped"), {
    accepted: false,
    state: "paused",
    error: "cloud dev session returned an invalid control acknowledgement",
  });

  releaseStream();
  const events = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
  }
  assert.equal(events.filter((event) => event.type === "done").length, 1);
  const create = calls.find((call) => call.path === "/agent/dev/sessions");
  assert.deepEqual((create?.body as Record<string, unknown>)["capabilities"], ["read_file"]);
});

test("packaged cloud driver uses local-authority CloudBrain and emits one terminal", async () => {
  const root = repository();
  const checkpointDirectory = mkdtempSync(join(tmpdir(), "aether-exec-cloud-checkpoint-"));
  const calls: Array<{ path: string; body: unknown }> = [];
  const api = {
    postJson: async (path: string, body: unknown) => {
      calls.push({ path, body });
      return { session_id: "devs_packaged", protocol_version: 1, model: hostedTextModel };
    },
    stream: async () => sse({ type: "done", seq: 1, ok: true, uvt: 1, cents: 0 }),
    deleteJson: async () => undefined,
  } as unknown as AppContext["api"];
  const lines: string[] = [];
  const code = await runHeadlessExec(context(root, api, hostedTextModel), "inspect the repository", {
    permission: "read-only",
    allowedTools: ["read_file"],
    capabilityPacks: ["core.read.v1"],
    timeoutMs: 30_000,
    verifyCommand: successfulVerify,
    driver: "cloud",
    maxUvt: 2_000,
    protocol: HEADLESS_PROTOCOL_V2,
    checkpointDirectory,
    sessionId: "cloud-session",
    writeLine: (line) => lines.push(line.trimEnd()),
  });
  assert.equal(code, 0);
  assert.deepEqual(validateHeadlessFrames(lines, HEADLESS_PROTOCOL_V2), []);
  const frames = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(frames[0]?.["backend"], "aether-cloud-dev-session");
  assert.equal(frames[0]?.["model"], hostedTextModel);
  assert.equal(frames.filter((frame) => frame["type"] === "terminal").length, 1);
  const create = calls.find((call) => call.path === "/agent/dev/sessions");
  assert.ok(create);
  assert.equal((create.body as Record<string, unknown>)["model"], hostedTextModel);
  assert.deepEqual((create.body as Record<string, unknown>)["capabilities"], ["read_file"]);
  assert.equal((create.body as Record<string, unknown>)["max_uvt"], 2_000);
  const checkpoint = JSON.parse(readFileSync(join(checkpointDirectory, "cloud-session.json"), "utf8"));
  assert.equal(checkpoint.driver, "cloud");
  assert.equal(checkpoint.model, hostedTextModel);
  assert.equal(checkpoint.model_tag, null);
  assert.equal(checkpoint.max_uvt, 2_000);
});

test("packaged cloud driver preserves the aether.exec/1 contract", async () => {
  const root = repository();
  const api = {
    postJson: async () => ({ session_id: "devs_v1", protocol_version: 1, model: hostedTextModel }),
    stream: async () => sse({ type: "done", seq: 1, ok: true, uvt: 1, cents: 0 }),
    deleteJson: async () => undefined,
  } as unknown as AppContext["api"];
  const lines: string[] = [];
  const code = await runHeadlessExec(context(root, api, hostedTextModel), "inspect the repository", {
    permission: "read-only",
    allowedTools: ["read_file"],
    capabilityPacks: ["core.read.v1"],
    timeoutMs: 30_000,
    verifyCommand: successfulVerify,
    driver: "cloud",
    maxUvt: 2_000,
    writeLine: (line) => lines.push(line.trimEnd()),
  });
  assert.equal(code, 0);
  assert.deepEqual(validateHeadlessFrames(lines), []);
  const frames = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(frames[0]?.["protocol"], "aether.exec/1");
  assert.equal(frames[0]?.["backend"], "aether-cloud-dev-session");
  assert.equal(frames.filter((frame) => frame["type"] === "terminal").length, 1);
});

test("packaged cloud driver requires an exact hosted model and refuses local model ids", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-exec-cloud-model-"));
  let calls = 0;
  const api = {
    postJson: async () => { calls += 1; return {}; },
    stream: async () => { calls += 1; return sse(); },
    deleteJson: async () => undefined,
  } as unknown as AppContext["api"];
  for (const model of [
    undefined,
    "ollama:qwen2.5-coder:7b",
    "aether-neo-5.1t",
    "aether-kronus-v2.4",
    "aether-vision",
  ]) {
    const lines: string[] = [];
    const code = await runHeadlessExec(context(root, api, model), "inspect", {
      permission: "read-only", allowedTools: ["read_file"], capabilityPacks: [], timeoutMs: 5000,
      driver: "cloud", maxUvt: 2_000, writeLine: (line) => lines.push(line.trimEnd()),
    });
    assert.equal(code, 2);
    assert.deepEqual(lines, []);
  }
  assert.equal(calls, 0, "invalid cloud model selection reached the Aether API");
});

test("v2 cloud checkpoints cannot be created or resumed without an exact hosted model", () => {
  const root = repository();
  const directory = mkdtempSync(join(tmpdir(), "aether-exec-cloud-model-checkpoint-"));
  const store = new HeadlessCheckpointStore(root, directory);
  const input = {
    session: "cloud-model-binding",
    task: "inspect",
    driver: "cloud" as const,
    model: null,
    modelTag: null,
    maxUvt: 2_000,
    effort: "LOW",
    permission: "read-only" as const,
    allowedTools: ["read_file"],
    capabilityPacks: ["core.read.v1"],
    agent: null,
    verifyCommand: successfulVerify,
    authorityTtlMs: 60_000,
  };
  assert.throws(() => store.create(input), /checkpoint model binding is invalid/);
  assert.throws(
    () => store.create({ ...input, model: hostedTextModel, maxUvt: null }),
    /checkpoint UVT budget binding is invalid/,
  );

  const checkpoint = store.create({ ...input, model: hostedTextModel });
  checkpoint.model = null;
  checkpoint.owner_pid = 2_147_483_647;
  store.write(checkpoint);
  assert.throws(() => store.loadForResume("cloud-model-binding"), /checkpoint model binding is invalid/);
});

test("cloud driver requires a positive UVT ceiling and refuses budget override on resume", async () => {
  const root = repository();
  const directory = mkdtempSync(join(tmpdir(), "aether-exec-cloud-budget-"));
  let calls = 0;
  const api = {
    postJson: async () => { calls += 1; return {}; },
    stream: async () => { calls += 1; return sse(); },
    deleteJson: async () => undefined,
  } as unknown as AppContext["api"];
  for (const maxUvt of [undefined, 0, -1, 1.5]) {
    const code = await runHeadlessExec(context(root, api, hostedTextModel), "inspect", {
      permission: "read-only", allowedTools: ["read_file"], capabilityPacks: [], timeoutMs: 5000,
      driver: "cloud", maxUvt, writeLine: () => undefined,
    });
    assert.equal(code, 2, String(maxUvt));
  }

  const store = new HeadlessCheckpointStore(root, directory);
  const checkpoint = store.create({
    session: "cloud-budget-binding", task: "inspect", driver: "cloud", model: hostedTextModel,
    modelTag: null, maxUvt: 2_000, effort: "LOW", permission: "read-only",
    allowedTools: ["read_file"], capabilityPacks: [], agent: null,
    verifyCommand: successfulVerify, authorityTtlMs: 60_000,
  });
  checkpoint.state = "paused";
  checkpoint.owner_pid = 2_147_483_647;
  store.write(checkpoint);
  const code = await runHeadlessExec(context(root, api), "", {
    permission: "deny", allowedTools: [], capabilityPacks: [], timeoutMs: 5000,
    driver: "cloud", maxUvt: 3_000, protocol: HEADLESS_PROTOCOL_V2,
    checkpointDirectory: directory, resume: "cloud-budget-binding",
    verifyCommand: successfulVerify, writeLine: () => undefined,
  });
  assert.equal(code, 2);
  assert.equal(calls, 0, "invalid or overridden cloud budget reached the API");
  const unchanged = JSON.parse(readFileSync(store.path("cloud-budget-binding"), "utf8"));
  assert.equal(unchanged.state, "paused");
  assert.equal(unchanged.owner_pid, 2_147_483_647);
  unchanged.max_uvt = null;
  writeFileSync(store.path("cloud-budget-binding"), JSON.stringify(unchanged), "utf8");
  assert.throws(() => store.loadForResume("cloud-budget-binding"), /checkpoint UVT budget binding is invalid/);
});

test("cloud brain tears down a session whose model acknowledgement drifted", async () => {
  let streams = 0;
  const deleted: string[] = [];
  const api = {
    postJson: async () => ({ session_id: "devs_model_drift", protocol_version: 1, model: "sonnet" }),
    stream: async () => { streams += 1; return sse(); },
    deleteJson: async (path: string) => { deleted.push(path); },
  } as unknown as AppContext["api"];
  const brain = new CloudBrain(api, undefined, { requireLocalAuthority: true, maxUvt: 2_000 });
  const events = [];
  for await (const event of brain.run({
    type: "task", text: "inspect", cwd: ".", poolGb: 1, model: "gpt55",
  })) events.push(event);
  assert.equal(streams, 0);
  assert.deepEqual(deleted, ["/agent/dev/sessions/devs_model_drift"]);
  const errorEvent = events.at(-2);
  assert.equal(errorEvent?.type, "error");
  assert.match(errorEvent?.type === "error" ? errorEvent.msg : "", /did not preserve/);
  const terminalEvent = events.at(-1);
  assert.equal(terminalEvent?.type, "done");
  assert.equal(terminalEvent?.type === "done" ? terminalEvent.ok : true, false);
});

test("packaged cloud driver refuses server-side downgrade without opening legacy chat", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-exec-cloud-refusal-"));
  let streams = 0;
  const api = {
    postJson: async () => { throw new HttpError(403, "dev sessions disabled", { detail: "disabled" }); },
    stream: async () => { streams += 1; return sse(); },
    deleteJson: async () => undefined,
  } as unknown as AppContext["api"];
  const lines: string[] = [];
  const code = await runHeadlessExec(context(root, api, hostedTextModel), "inspect", {
    permission: "read-only", allowedTools: ["read_file"], capabilityPacks: [], timeoutMs: 5000,
    driver: "cloud", maxUvt: 2_000, writeLine: (line) => lines.push(line.trimEnd()),
  });
  assert.equal(code, 1);
  assert.equal(streams, 0, "local-authority driver opened a legacy server-executed stream");
  const frames = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const driftEvent = frames.find((frame) =>
    frame["type"] === "agent_event"
    && (frame["event"] as Record<string, unknown> | undefined)?.["type"] === "routing_drift");
  assert.ok(driftEvent, "refusal was not represented in the headless stream");
  assert.equal(frames.filter((frame) => frame["type"] === "terminal").length, 1);
});
