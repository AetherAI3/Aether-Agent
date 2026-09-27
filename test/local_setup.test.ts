import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../src/core/context.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import {
  LOCAL_EXIT,
  cmdLocal,
  cmdSetup,
  runStreamingProcess,
  type LocalProcessResult,
  type LocalRuntimeDeps,
} from "../src/commands/local.js";
import {
  localModelId, normalizeOllamaTag, ollamaTagFromId, resolveHostedModel,
  resolveLocalModel, resolveLocalModelSelection,
} from "../src/core/local_ollama.js";
import { SessionLog } from "../src/core/session_log.js";
import { loadSession } from "../src/core/session_resume.js";
import { buildHandoff } from "../src/core/handoff.js";
import { cmdModels } from "../src/commands/models.js";
import { runLocalTurn } from "../src/commands/chat.js";
import { resolveHostedSessionModel } from "../src/commands/code.js";
import type { Brain } from "../src/core/brain.js";

function context(overrides: Partial<AppContext["flags"]> = {}, token: string | null = null): AppContext {
  return {
    cfg: { ...DEFAULT_CONFIG },
    api: {} as AppContext["api"],
    tokens: { get: async () => token, set: async () => {}, clear: async () => {} },
    flags: { json: false, audit: false, yes: false, cwd: process.cwd(), ...overrides },
    confirm: async () => false,
  };
}

function okRun(stdout = "ollama version 1.0.0\n"): LocalProcessResult {
  return { status: 0, stdout, stderr: "" };
}

function deps(overrides: Partial<LocalRuntimeDeps> = {}): LocalRuntimeDeps {
  return {
    run: () => okRun(),
    pull: async () => okRun(),
    requestTags: async () => ({ models: [{ name: "qwen2.5-coder:7b" }, { name: "gemma3:4b" }] }),
    save: () => {},
    ...overrides,
  };
}

async function capture(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: unknown) => ((stdout += String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => ((stderr += String(chunk)), true)) as typeof process.stderr.write;
  try {
    return { code: await run(), stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function settle(ms = 500): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function processTreeScript(root: string): string {
  const grandchild = join(root, "pull-grandchild.cjs");
  writeFileSync(grandchild, "console.log('GRANDCHILD:' + process.pid); setInterval(() => {}, 1000);\n");
  const child = join(root, "pull-child.cjs");
  writeFileSync(
    child,
    "const { spawn } = require('node:child_process');\n" +
      "console.log('CHILD:' + process.pid);\n" +
      `spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'inherit' });\n` +
      "setInterval(() => {}, 1000);\n",
  );
  return child;
}

test("local ids are namespaced and hosted defaults never become Ollama tags", () => {
  assert.equal(localModelId("qwen2.5-coder:7b"), "ollama:qwen2.5-coder:7b");
  assert.equal(ollamaTagFromId("ollama:gemma3:4b"), "gemma3:4b");
  assert.equal(ollamaTagFromId("gpt-5.6-sol"), null);
  assert.equal(resolveLocalModel(undefined, "gpt-5.6-sol"), "qwen2.5-coder:7b");
  assert.equal(resolveLocalModel(undefined, "ollama:gemma3:4b"), "gemma3:4b");
  assert.throws(() => resolveLocalModel("legacy-bare:7b", "gpt-5.6-sol"), /--local/);
  assert.equal(resolveLocalModel("legacy-bare:7b", "", { allowBareExplicit: true }), "legacy-bare:7b");
  assert.throws(() => resolveLocalModel("ollama:", ""));
  assert.deepEqual(resolveLocalModelSelection(undefined, "ollama:gemma3:4b"), {
    tag: "gemma3:4b",
    id: "ollama:gemma3:4b",
  });
  assert.throws(() => resolveHostedModel("ollama:gemma3:4b"), /local-only/);
  assert.throws(() => normalizeOllamaTag("--bad"));
  assert.throws(() => normalizeOllamaTag("bad tag"));
});

test("resolved local and configured hosted models survive session and handoff provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "aether-local-provenance-"));
  try {
    const cases = [
      { model: resolveLocalModelSelection(undefined, "ollama:gemma3:4b").id, brain: "local" as const },
      { model: resolveHostedSessionModel(undefined, "gpt-5.6-sol"), brain: "cloud" as const },
    ];
    for (const [index, selected] of cases.entries()) {
      const log = new SessionLog(
        { task: "fix it", model: selected.model, poolGb: 5, brain: selected.brain, cwd: root },
        `2026-08-23T12:0${index}:00.000Z`,
        root,
        () => undefined,
      );
      log.close("unverified", `2026-08-23T12:0${index}:30.000Z`);
      const loaded = loadSession(log.sessionId, root, root);
      assert.equal(loaded.manifest.model, selected.model);
      assert.equal(buildHandoff(loaded).model, selected.model);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosted model selection rejects an Ollama namespace before network or config writes", async () => {
  const ctx = context();
  ctx.api = new Proxy({} as AppContext["api"], { get: () => { throw new Error("hosted API touched"); } });
  const result = await capture(() => cmdModels(ctx, ["use", "ollama:gemma3:4b"]));
  assert.equal(result.code, LOCAL_EXIT.usage);
  assert.match(result.stderr, /local-only/);
  assert.equal(ctx.cfg.defaultModel, "");
});

test("hosted model catalogue failures are actionable and never save unavailable choices", async () => {
  const signedOut = context({}, null);
  signedOut.api = new Proxy({} as AppContext["api"], { get: () => { throw new Error("hosted API touched"); } });
  const noAuth = await capture(() => cmdModels(signedOut, []));
  assert.equal(noAuth.code, 1);
  assert.match(noAuth.stderr, /aether auth login.*aether models/s);

  const ctx = context({}, "aek_test");
  ctx.api = {
    getJson: async () => ({
      tier: "free",
      default: "model-ready",
      models: [
        {
          id: "model-ready", label: "Ready", kind: "model", provider: "test",
          context_window: 1000, tier_min: "free", enabled: true, available: true,
          monthly_uvt_cap: 100, is_default: true,
        },
        {
          id: "model-locked", label: "Locked", kind: "model", provider: "test",
          context_window: 1000, tier_min: "pro", enabled: true, available: false,
          monthly_uvt_cap: null, is_default: false,
        },
      ],
    }),
  } as unknown as AppContext["api"];

  const missing = await capture(() => cmdModels(ctx, ["use", "model-missing"]));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /not in the live catalogue.*aether models/);
  assert.equal(ctx.cfg.defaultModel, "");

  const locked = await capture(() => cmdModels(ctx, ["use", "model-locked"]));
  assert.equal(locked.code, 1);
  assert.match(locked.stderr, /unavailable for this account.*requires pro.*aether models/);
  assert.equal(ctx.cfg.defaultModel, "");
});

test("auto-local rejects a bare explicit model before starting a brain", async () => {
  const ctx = context({ model: "gpt-5.6-sol", local: false });
  await assert.rejects(
    runLocalTurn(ctx, "hello", undefined, { brain: {} as Brain }),
    /not a local model id/,
  );
});

test("truly signed-out doctor normalizes OLLAMA_HOST without hosted API access", async () => {
  const previous = process.env["OLLAMA_HOST"];
  process.env["OLLAMA_HOST"] = "0.0.0.0:11434/";
  try {
    let tokenReads = 0;
    const ctx = context({}, null);
    ctx.tokens.get = async () => { tokenReads += 1; return null; };
    ctx.api = new Proxy({} as AppContext["api"], { get: () => { throw new Error("hosted API touched"); } });
    const result = await capture(() => cmdLocal(ctx, ["doctor"], {}, deps()));
    assert.equal(result.code, LOCAL_EXIT.ok);
    assert.match(result.stdout, /http:\/\/127\.0\.0\.1:11434/);
    assert.match(result.stdout, /hosted auth\s+signed-out/);
    assert.equal(tokenReads, 1);
  } finally {
    if (previous === undefined) delete process.env["OLLAMA_HOST"];
    else process.env["OLLAMA_HOST"] = previous;
  }
});

test("doctor and mutation plans strip terminal control bytes from saved labels", async () => {
  const ctx = context({ yes: true });
  ctx.cfg.backend = "cloud\u001b[31m" as typeof ctx.cfg.backend;
  ctx.cfg.defaultModel = "hosted\u001b[2J";
  const doctor = await capture(() => cmdLocal(ctx, ["doctor"], {}, deps()));
  assert.equal(doctor.code, LOCAL_EXIT.ok);
  assert.doesNotMatch(doctor.stdout + doctor.stderr, /\u001b/);
  const use = await capture(() => cmdLocal(ctx, ["use", "gemma3:4b"], {}, deps()));
  assert.equal(use.code, LOCAL_EXIT.ok);
  assert.doesNotMatch(use.stdout + use.stderr, /\u001b/);
});

test("doctor has stable exit codes for absent binary, down server, empty and missing selection", async () => {
  const absent = await capture(() => cmdLocal(context(), ["doctor"], {}, deps({
    run: () => ({ status: null, stdout: "", stderr: "", errorCode: "ENOENT" }),
  })));
  assert.equal(absent.code, LOCAL_EXIT.binaryAbsent);
  assert.match(absent.stderr, /Install Ollama/);

  const denied = await capture(() => cmdLocal(context(), ["doctor"], {}, deps({
    run: () => ({ status: null, stdout: "", stderr: "", errorCode: "EACCES" }),
  })));
  assert.equal(denied.code, LOCAL_EXIT.operationFailed);
  assert.match(denied.stderr, /could not run.*EACCES/);

  const down = await capture(() => cmdLocal(context(), ["doctor"], {}, deps({
    requestTags: async () => { throw new Error("ECONNREFUSED"); },
  })));
  assert.equal(down.code, LOCAL_EXIT.serverDown);

  const empty = await capture(() => cmdLocal(context(), ["doctor"], {}, deps({
    requestTags: async () => ({ models: [] }),
  })));
  assert.equal(empty.code, LOCAL_EXIT.emptyModels);

  const missingCtx = context();
  missingCtx.cfg.localModel = "ollama:missing:7b";
  const missing = await capture(() => cmdLocal(missingCtx, ["doctor"], {}, deps()));
  assert.equal(missing.code, LOCAL_EXIT.selectedMissing);
  assert.match(missing.stderr, /local pull missing:7b/);
});

test("timeout, malformed response, and invalid host are distinct failures", async () => {
  const timeout = await capture(() => cmdLocal(context(), ["doctor"], {}, deps({
    requestTags: async () => { const error = new Error("request timed out"); error.name = "AbortError"; throw error; },
  })));
  assert.equal(timeout.code, LOCAL_EXIT.timeout);

  const causeTimeout = await capture(() => cmdLocal(context(), ["doctor"], {}, deps({
    requestTags: async () => {
      const cause = Object.assign(new Error("connect"), { code: "UND_ERR_CONNECT_TIMEOUT" });
      throw new Error("fetch failed", { cause });
    },
  })));
  assert.equal(causeTimeout.code, LOCAL_EXIT.timeout);

  const binaryTimeout = await capture(() => cmdLocal(context(), ["doctor"], {}, deps({
    run: () => ({ status: null, stdout: "", stderr: "", timedOut: true, errorCode: "ETIMEDOUT" }),
  })));
  assert.equal(binaryTimeout.code, LOCAL_EXIT.timeout);
  assert.match(binaryTimeout.stderr, /binary check timed out/);

  const malformed = await capture(() => cmdLocal(context(), ["doctor"], {}, deps({
    requestTags: async () => ({ models: [{ nope: "name" }] }),
  })));
  assert.equal(malformed.code, LOCAL_EXIT.malformedResponse);

  const previous = process.env["OLLAMA_HOST"];
  process.env["OLLAMA_HOST"] = "file:///tmp/socket";
  try {
    const badHost = await capture(() => cmdLocal(context(), ["doctor"], {}, deps()));
    assert.equal(badHost.code, LOCAL_EXIT.malformedResponse);
    assert.match(badHost.stderr, /unsupported scheme/);
  } finally {
    if (previous === undefined) delete process.env["OLLAMA_HOST"];
    else process.env["OLLAMA_HOST"] = previous;
  }
});

test("models and use return actionable server and empty-model errors", async () => {
  const down = await capture(() => cmdLocal(context(), ["models"], {}, deps({
    requestTags: async () => { throw new Error("ECONNREFUSED"); },
  })));
  assert.equal(down.code, LOCAL_EXIT.serverDown);
  assert.match(down.stderr, /server is down/);

  const empty = await capture(() => cmdLocal(context({ yes: true }), ["use", "gemma3:4b"], {}, deps({
    requestTags: async () => ({ models: [] }),
  })));
  assert.equal(empty.code, LOCAL_EXIT.emptyModels);
  assert.match(empty.stderr, /No local models/);
});

test("local use shows a plan, requires approval, writes a namespaced id, and never switches backend", async () => {
  const ctx = context();
  ctx.cfg.backend = "cloud";
  ctx.cfg.defaultModel = "gpt-5.6-sol";
  let saves = 0;
  const declined = await capture(() => cmdLocal(ctx, ["use", "gemma3:4b"], {}, deps({ save: () => { saves += 1; } })));
  assert.equal(declined.code, LOCAL_EXIT.declined);
  assert.match(declined.stderr, /Plan/);
  assert.equal(saves, 0);
  assert.equal(ctx.cfg.localModel, "");

  ctx.flags.yes = true;
  const accepted = await capture(() => cmdLocal(ctx, ["use", "gemma3:4b"], {}, deps({ save: () => { saves += 1; } })));
  assert.equal(accepted.code, LOCAL_EXIT.ok);
  assert.equal(ctx.cfg.localModel, "ollama:gemma3:4b");
  assert.equal(ctx.cfg.defaultModel, "gpt-5.6-sol");
  assert.equal(ctx.cfg.backend, "cloud");
  assert.equal(saves, 1);
  assert.match(accepted.stdout, /Backend was not changed/);
});

test("local pull uses argv-only runner, displays plan, and does not download without approval", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const fake = deps({
    run: (command, args) => {
      calls.push({ command, args });
      return okRun();
    },
    pull: async (command, args, _timeout, progress) => {
      calls.push({ command, args });
      progress("pulling layers 50%\n");
      return okRun("pull complete\n");
    },
  });
  const ctx = context();
  const declined = await capture(() => cmdLocal(ctx, ["pull", "qwen2.5-coder:7b"], {}, fake));
  assert.equal(declined.code, LOCAL_EXIT.declined);
  assert.deepEqual(calls, []);
  assert.match(declined.stderr, /may download model data/);

  ctx.flags.yes = true;
  const accepted = await capture(() => cmdLocal(ctx, ["pull", "qwen2.5-coder:7b"], {}, fake));
  assert.equal(accepted.code, LOCAL_EXIT.ok);
  assert.deepEqual(calls, [
    { command: "ollama", args: ["--version"] },
    { command: "ollama", args: ["pull", "qwen2.5-coder:7b"] },
  ]);
  assert.match(accepted.stderr, /pulling layers 50%/);
  assert.match(accepted.stdout, /Selection and backend were not changed/);

  const timed = await capture(() => cmdLocal(ctx, ["pull", "qwen2.5-coder:7b"], {}, deps({
    pull: async () => ({ status: null, stdout: "", stderr: "", errorCode: "ETIMEDOUT" }),
  })));
  assert.equal(timed.code, LOCAL_EXIT.timeout);
  assert.match(timed.stderr, /timed out/);

  const cancelled = await capture(() => cmdLocal(ctx, ["pull", "qwen2.5-coder:7b"], {}, deps({
    pull: async () => ({ status: null, stdout: "", stderr: "", cancelled: true }),
  })));
  assert.equal(cancelled.code, LOCAL_EXIT.cancelled);
  assert.match(cancelled.stderr, /process tree was stopped/);
});

test("streaming runner retains bounded receipts and classifies timeout", async () => {
  let progress = "";
  const completed = await runStreamingProcess(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(50000)); process.stderr.write('done\\n')"],
    5_000,
    (chunk) => { progress += chunk; },
  );
  assert.equal(completed.status, 0);
  assert.ok(completed.stdout.length <= 8 * 1024);
  assert.match(progress, /done/);

  const timed = await runStreamingProcess(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10000)"],
    25,
    () => {},
  );
  assert.equal(timed.timedOut, true);
});

test("streaming pull timeout kills its detached grandchild process tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-local-pull-tree-"));
  try {
    const result = await runStreamingProcess(process.execPath, [processTreeScript(root)], 1_500, () => {});
    assert.equal(result.timedOut, true);
    const child = /CHILD:(\d+)/.exec(result.stdout)?.[1];
    const grandchild = /GRANDCHILD:(\d+)/.exec(result.stdout)?.[1];
    assert.ok(child, `missing child pid: ${result.stdout}`);
    assert.ok(grandchild, `missing grandchild pid: ${result.stdout}`);
    await settle();
    assert.equal(processAlive(Number(child)), false, "pull child survived timeout");
    assert.equal(processAlive(Number(grandchild)), false, "pull grandchild survived timeout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("streaming pull cancellation kills its detached grandchild process tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-local-pull-cancel-"));
  try {
    const controller = new AbortController();
    let progress = "";
    const result = await runStreamingProcess(
      process.execPath,
      [processTreeScript(root)],
      60_000,
      (chunk) => {
        progress += chunk;
        if (/CHILD:\d+/.test(progress) && /GRANDCHILD:\d+/.test(progress)) controller.abort();
      },
      controller.signal,
    );
    assert.equal(result.cancelled, true);
    const child = /CHILD:(\d+)/.exec(result.stdout)?.[1];
    const grandchild = /GRANDCHILD:(\d+)/.exec(result.stdout)?.[1];
    assert.ok(child, `missing child pid: ${result.stdout}`);
    assert.ok(grandchild, `missing grandchild pid: ${result.stdout}`);
    await settle();
    assert.equal(processAlive(Number(child)), false, "cancelled pull child survived");
    assert.equal(processAlive(Number(grandchild)), false, "cancelled pull grandchild survived");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exit codes are unique and config write failure rolls state back", async () => {
  const values = Object.values(LOCAL_EXIT);
  assert.equal(new Set(values).size, values.length);
  const ctx = context({ yes: true });
  const failed = await capture(() => cmdLocal(ctx, ["use", "gemma3:4b"], {}, deps({
    save: () => { throw new Error("disk full"); },
  })));
  assert.equal(failed.code, LOCAL_EXIT.mutationFailed);
  assert.equal(ctx.cfg.localModel, "");
  assert.match(failed.stderr, /Could not save.*disk full/);
});

test("read-only commands reject trailing arguments", async () => {
  assert.equal((await capture(() => cmdSetup(context({ local: true }), ["extra"], {}, deps()))).code, LOCAL_EXIT.usage);
  assert.equal((await capture(() => cmdLocal(context(), ["doctor", "extra"], {}, deps()))).code, LOCAL_EXIT.usage);
  assert.equal((await capture(() => cmdLocal(context(), ["models", "extra"], {}, deps()))).code, LOCAL_EXIT.usage);
});

test("setup is explicitly local and remains read-only", async () => {
  const noFlag = await capture(() => cmdSetup(context(), [], {}, deps()));
  assert.equal(noFlag.code, LOCAL_EXIT.usage);
  assert.match(noFlag.stderr, /setup --local/);

  let saves = 0;
  const ready = await capture(() => cmdSetup(context({ local: true }), [], {}, deps({ save: () => { saves += 1; } })));
  assert.equal(ready.code, LOCAL_EXIT.ok);
  assert.equal(saves, 0);
  assert.match(ready.stdout, /aether agent --local/);
});
