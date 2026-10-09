import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { parseOneTurnSkill } from "../src/commands/one_turn_skill.js";
import { ChatTurnError, repl, runTurn } from "../src/commands/chat.js";
import { contextSlash } from "../src/commands/slash_context.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { ApiClient } from "../src/core/transport.js";
import { saveSkillSetting } from "../src/core/skills/skill_settings.js";
import { getRegistry } from "../src/core/context_registry.js";
import type { AppContext } from "../src/core/context.js";
import type { TokenStore } from "../src/core/auth.js";

test("/skill parses only its reference and preserves every task-suffix byte", () => {
  const raw = "/skill user/demo  \n  /clear !echo `x` $(whoami) \"quoted\"  ";
  assert.deepEqual(parseOneTurnSkill(raw), {
    kind: "invoke", reference: "user/demo", task: " \n  /clear !echo `x` $(whoami) \"quoted\"  ", source: raw,
  });
  assert.equal(parseOneTurnSkill("look at /skill user/demo task"), null);
  assert.equal(parseOneTurnSkill("/skills list"), null);
  assert.deepEqual(parseOneTurnSkill("/skill user/demo"), { kind: "usage", message: "usage: /skill <qualified-id> <task>" });
});

function installUserSkill(configRoot: string): void {
  const root = join(configRoot, "skills", "user", "demo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "skill.json"), JSON.stringify({
    schema_version: 1, id: "user/demo", version: "1.0.0", name: "Demo", description: "One turn fixture",
    triggers: { commands: [], phrases: [], automatic: false },
    tools: { allowed: ["read_file"], required: [], denied: [] },
    permissions: { requires: [], may_request: [], forbids: [] },
    context: { max_tokens: 500, resources: [] },
    outputs: { kinds: ["diagnosis"], verification: [] },
    dependencies: { skills: [] },
    compatibility: { min_agent_version: "0.1.0", capability_contract: 1 }, health: {},
  }));
  writeFileSync(join(root, "SKILL.md"), "# ONE_TURN_SKILL_MARKER\nRead only.\n");
}

test("a supported local turn gets the skill once, then normal defaults resume", async () => {
  const base = mkdtempSync(join(tmpdir(), "aether-one-turn-skill-"));
  const config = join(base, "config");
  mkdirSync(config);
  installUserSkill(config);
  const priorConfig = process.env["AETHER_CONFIG_DIR"];
  const priorBackend = process.env["AETHER_BACKEND"];
  const priorFetch = globalThis.fetch;
  process.env["AETHER_CONFIG_DIR"] = config;
  process.env["AETHER_BACKEND"] = "local";
  const requests: Record<string, unknown>[] = [];
  let failNext = false;
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (failNext) { failNext = false; throw new Error("fixture model failure"); }
    return Response.json({ choices: [{ message: { content: "done" } }] });
  }) as typeof fetch;
  const tokens = { get: async () => null } as unknown as TokenStore;
  const ctx = { cfg: { ...DEFAULT_CONFIG, backend: "local" }, flags: { cwd: base, local: true, json: true, yes: false, audit: false },
    tokens, api: new ApiClient("https://example.invalid", tokens), confirm: async () => false } as AppContext;
  try {
    const task = "  /clear !echo $(whoami)\nsecond line  ";
    await runTurn(ctx, task, undefined, undefined, undefined,
      { explicitSkill: "user/demo", requireHostSkillEnforcement: true });
    assert.equal(requests.length, 1);
    const first = JSON.stringify(requests[0]);
    assert.match(first, /ONE_TURN_SKILL_MARKER/);
    assert.match(first, /user\/demo/);
    assert.match(first, /read_file/);
    const messages = requests[0]?.["messages"] as Array<{ content: string }>;
    assert.ok(messages.some(message => message.content.includes(task)), "literal task suffix must reach the model");
    assert.deepEqual(getRegistry().lastAdmitted?.descriptor.skills.map(skill => skill.id), ["user/demo"]);
    assert.match(getRegistry().lastAdmitted?.descriptor.skills[0]?.digest ?? "", /^sha256:[a-f0-9]{64}$/);
    const preview = new PassThrough();
    let previewText = "";
    preview.on("data", chunk => { previewText += String(chunk); });
    await contextSlash(ctx, preview, "next /skill user/demo fresh task", { backend: "local" });
    assert.match(previewText, /Next-draft preview \(not admitted or sent\)/);
    assert.match(previewText, /user\/demo · sha256:[a-f0-9]{64} · explicit/);
    assert.equal(requests.length, 1, "context preview makes no model request");
    const unsupported = new PassThrough();
    let unsupportedText = "";
    unsupported.on("data", chunk => { unsupportedText += String(chunk); });
    await contextSlash(ctx, unsupported, "next /skill user/demo task", { backend: "cloud" });
    assert.match(unsupportedText, /preview refused: \/skill requires host-executed tools/);
    await runTurn(ctx, "next ordinary task");
    assert.equal(requests.length, 2);
    assert.doesNotMatch(JSON.stringify(requests[1]), /ONE_TURN_SKILL_MARKER/);
    assert.deepEqual(getRegistry().lastAdmitted?.descriptor.skills.filter(skill => skill.id === "user/demo"), []);
    failNext = true;
    await assert.rejects(runTurn(ctx, "failing selected task", undefined, undefined, undefined,
      { explicitSkill: "user/demo", requireHostSkillEnforcement: true }));
    await runTurn(ctx, "after model failure");
    assert.equal(requests.length, 4);
    assert.doesNotMatch(JSON.stringify(requests[3]), /ONE_TURN_SKILL_MARKER/);
    saveSkillSetting({ projectRoot: "*", skillId: "user/demo", enabled: false, automatic: false });
    await assert.rejects(runTurn(ctx, "refused", undefined, undefined, undefined,
      { explicitSkill: "user/demo", requireHostSkillEnforcement: true }), /skill.disabled/);
    assert.equal(requests.length, 4, "disabled selection must not reach the model");
    await runTurn(ctx, "after refusal");
    assert.equal(requests.length, 5);
    assert.doesNotMatch(JSON.stringify(requests[4]), /ONE_TURN_SKILL_MARKER/);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorConfig === undefined) delete process.env["AETHER_CONFIG_DIR"]; else process.env["AETHER_CONFIG_DIR"] = priorConfig;
    if (priorBackend === undefined) delete process.env["AETHER_BACKEND"]; else process.env["AETHER_BACKEND"] = priorBackend;
    rmSync(base, { recursive: true, force: true });
  }
});

test("cloud host-enforcement and --no-skills refuse before any model request", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-one-turn-cloud-"));
  const priorFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected model request"); }) as typeof fetch;
  const tokens = { get: async () => "token" } as unknown as TokenStore;
  const ctx = { cfg: { ...DEFAULT_CONFIG, backend: "cloud" }, flags: { cwd: root, json: true, yes: false, audit: false },
    tokens, api: new ApiClient("https://example.invalid", tokens), confirm: async () => false } as AppContext;
  try {
    await assert.rejects(runTurn(ctx, "task", undefined, undefined, undefined,
      { explicitSkill: "user/demo", requireHostSkillEnforcement: true }),
    (error: unknown) => error instanceof ChatTurnError && error.outcome?.state === "failed" && /host-executed tools/.test(error.message));
    await assert.rejects(runTurn(ctx, "task", undefined, undefined, undefined,
      { explicitSkill: "user/demo", noSkills: true, requireHostSkillEnforcement: true }), /--no-skills/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = priorFetch; rmSync(root, { recursive: true, force: true }); }
});

test("idle TTY /skill admits one literal task; a busy queued turn keeps normal defaults", async () => {
  const base = mkdtempSync(join(tmpdir(), "aether-one-turn-tty-"));
  const config = join(base, "config");
  mkdirSync(config);
  installUserSkill(config);
  const priorConfig = process.env["AETHER_CONFIG_DIR"];
  const priorBackend = process.env["AETHER_BACKEND"];
  const priorFetch = globalThis.fetch;
  const priorWrite = process.stdout.write;
  const priorErrWrite = process.stderr.write;
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const raw = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
  const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  let output = "";
  const requests: Record<string, unknown>[] = [];
  const firstGate: { release?: () => void } = {};
  let pending: Promise<number> | null = null;
  const until = async (check: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for TTY skill turn: " + output.slice(-600));
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const send = (text: string): void => { process.stdin.emit("data", Buffer.from(text)); };
  process.env["AETHER_CONFIG_DIR"] = config;
  process.env["AETHER_BACKEND"] = "local";
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
  Object.defineProperty(process.stdout, "columns", { value: 200, configurable: true });
  process.stdout.write = ((text: string | Uint8Array) => { output += String(text); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((text: string | Uint8Array) => { output += String(text); return true; }) as typeof process.stderr.write;
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (requests.length === 1) await new Promise<void>(resolve => { firstGate.release = resolve; });
    return Response.json({ choices: [{ message: { content: "done" } }] });
  }) as typeof fetch;
  const tokens = { get: async () => null } as unknown as TokenStore;
  const ctx = { cfg: { ...DEFAULT_CONFIG, backend: "local" }, flags: { cwd: base, local: true, json: true, yes: false, audit: false },
    tokens, api: new ApiClient("https://example.invalid", tokens), confirm: async () => false } as AppContext;
  try {
    pending = repl(ctx);
    await until(() => output.includes("\x1b[?2004h"));
    send("\x1b[200~/skill user/demo  /clear !literal\nline  \x1b[201~\r");
    await until(() => requests.length === 1);
    send("ordinary queued task\r");
    await until(() => output.includes("Queued q2 (chat"));
    firstGate.release?.();
    await until(() => requests.length === 2);
    await until(() => (output.match(/"type":"turn_outcome"/g) ?? []).length === 2);
    const firstMessages = requests[0]?.["messages"] as Array<{ content: string }>;
    assert.ok(firstMessages.some(message => message.content.includes("ONE_TURN_SKILL_MARKER")));
    assert.ok(firstMessages.some(message => message.content.includes(" /clear !literal\nline  ")));
    assert.doesNotMatch(JSON.stringify(requests[1]), /ONE_TURN_SKILL_MARKER/);
    send("/exit\r\r");
    assert.equal(await pending, 0);
    pending = null;
  } finally {
    firstGate.release?.();
    if (pending) { send("\x03\x03\x04"); await Promise.race([pending.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1_000))]); }
    globalThis.fetch = priorFetch;
    process.stdout.write = priorWrite;
    process.stderr.write = priorErrWrite;
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (raw) Object.defineProperty(process.stdin, "setRawMode", raw); else delete (process.stdin as { setRawMode?: unknown }).setRawMode;
    if (columns) Object.defineProperty(process.stdout, "columns", columns); else delete (process.stdout as { columns?: number }).columns;
    if (priorConfig === undefined) delete process.env["AETHER_CONFIG_DIR"]; else process.env["AETHER_CONFIG_DIR"] = priorConfig;
    if (priorBackend === undefined) delete process.env["AETHER_BACKEND"]; else process.env["AETHER_BACKEND"] = priorBackend;
    rmSync(base, { recursive: true, force: true });
  }
});
