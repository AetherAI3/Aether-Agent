import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repl, replLines } from "../src/commands/chat.js";
import { invalidateCatalog } from "../src/commands/slash.js";
import type { AppContext } from "../src/core/context.js";
import { ConsoleTaskContinuation, accountFingerprint, type ContinuationState, type ModelTarget } from "../src/commands/model_continuation.js";

const source: ContinuationState = {
  workspace: "/repo",
  account: accountFingerprint("account-one"),
  rulesDigest: "rules-one",
  repo: { remote: "origin", branch: "main", head: "abc123" },
};
const target: ModelTarget = { id: "sonnet", label: "Sonnet", contextWindow: 32_000, destination: "cloud" };

test("two coding turns carry approved goal, constraints, host edits and checks exactly once", () => {
  const task = new ConsoleTaskContinuation(source);
  let modelCalls = 0;
  const send = (prompt: string) => { modelCalls++; return prompt; };
  send("Fix the parser");
  task.recordTurn("Fix the parser", [{ name: "write_file", path: "src/parser.ts", exitCode: 0 }], ["changed: src/parser.ts"], "succeeded");
  send("Keep Unicode titles");
  task.recordTurn("Keep Unicode titles", [{ name: "run_tests", exitCode: 0 }], [], "succeeded");
  assert.equal(modelCalls, 2);

  const choice = task.propose(target, "haiku", source);
  assert.equal(choice.status, "ready");
  const brief = choice.proposal!.brief;
  assert.match(brief, /Fix the parser/);
  assert.match(brief, /Keep Unicode titles/);
  assert.match(brief, /host tool write_file succeeded: src\/parser.ts/);
  assert.match(brief, /host run_tests: exit 0/);
  assert.match(brief, /Latest host check completed/);
  const accepted = task.accept(source);
  assert.equal(accepted.ok, true);
  const next = task.promptForNextTurn("Finish review");
  assert.match(next, /Accepted console continuation brief/);
  assert.match(next, /Finish review/);
  assert.equal(task.promptForNextTurn("Another turn"), "Another turn");
  assert.equal(modelCalls, 2, "switch and acceptance do not call a model or replay tools");
});

test("cancellation and same-model selection preserve current state and call no model", () => {
  const task = new ConsoleTaskContinuation(source);
  task.recordTurn("Keep my draft", [], [], "succeeded");
  assert.equal(task.propose({ ...target, id: "haiku" }, "haiku", source).status, "same");
  assert.equal(task.pending, null);
  task.propose(target, "haiku", source);
  task.cancel();
  assert.equal(task.pending, null);
  assert.equal(task.promptForNextTurn("unsent draft"), "unsent draft");
  assert.match(task.propose(target, "haiku", source).proposal!.brief, /Keep my draft/);
});

test("fresh discards task context; account, workspace, branch and rules drift block continuation", () => {
  for (const changed of [
    { ...source, account: accountFingerprint("another-account") },
    { ...source, workspace: "/other" },
    { ...source, rulesDigest: "changed-rules" },
    { ...source, repo: { ...source.repo, branch: "other" } },
  ]) {
    const task = new ConsoleTaskContinuation(source);
    task.propose(target, "haiku", source);
    assert.equal(task.accept(changed).ok, false);
  }
  const accountSwitch = new ConsoleTaskContinuation(source);
  const changedAccount = { ...source, account: accountFingerprint("another-account") };
  assert.equal(accountSwitch.propose(target, "haiku", changedAccount).status, "drift");
  assert.equal(accountSwitch.accept(changedAccount).ok, false);
  assert.equal(accountSwitch.fresh(changedAccount).ok, true);
  const task = new ConsoleTaskContinuation(source);
  task.recordTurn("Old goal", [], [], "succeeded");
  task.propose(target, "haiku", source);
  assert.equal(task.fresh(source).ok, true);
  assert.equal(task.promptForNextTurn("New goal"), "New goal");
  assert.doesNotMatch(task.propose({ ...target, id: "opus" }, "sonnet", source).proposal!.brief, /Old goal/);
});

test("drift after approval blocks the very next model call", () => {
  const task = new ConsoleTaskContinuation(source);
  task.recordTurn("Original goal", [], [], "succeeded");
  task.propose(target, "haiku", source);
  assert.equal(task.accept(source).ok, true);
  assert.throws(() => task.promptForNextTurn("new prompt", { ...source, account: accountFingerprint("new-account") }), /Continuation blocked before the model call/);
  assert.equal(task.hasAcceptedBrief, false);
});

test("deletion or revision drift after preview requires a new review", () => {
  const clean = { ...source, workspaceStatus: "clean" };
  const task = new ConsoleTaskContinuation(clean);
  task.recordTurn("Preserve current edits", [], [], "succeeded");
  task.propose(target, "haiku", clean);
  const removedFile = { ...clean, workspaceStatus: "deleted-file" };
  const denied = task.accept(removedFile);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.reason, /workspace or revision changed/);
  task.cancel();
  task.propose(target, "haiku", removedFile);
  assert.equal(task.accept(removedFile).ok, true);
  assert.throws(() => task.promptForNextTurn("Continue", { ...removedFile, repo: { ...source.repo, head: "new-commit" } }), /revision changed after approval/);
});

test("signed-out local work may be reviewed for a newly signed-in hosted destination", () => {
  const localSource = { ...source, account: "signed-out" };
  const hostedState = { ...source, account: accountFingerprint("hosted-account") };
  const task = new ConsoleTaskContinuation(localSource);
  task.recordTurn("Fix local build", [], [], "succeeded");
  assert.equal(task.propose(target, "ollama:qwen", hostedState).status, "ready");
  assert.equal(task.accept(hostedState).ok, true);
  assert.match(task.promptForNextTurn("Continue", hostedState), /Fix local build/);
});

test("reviewed local-to-hosted brief redacts credentials and never contains shell history or model prose", () => {
  const task = new ConsoleTaskContinuation(source);
  task.recordTurn("Fix auth, token=supersecret and use ghp_abcdefghijklmnopqrstuvwxyz", [], ["deleted: old.ts"], "failed");
  const brief = task.propose(target, "ollama:local", source).proposal!.brief;
  assert.match(brief, /Destination: cloud/);
  assert.match(brief, /deleted: old.ts/);
  assert.doesNotMatch(brief, /supersecret|ghp_abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(brief, /raw shell history|hidden reasoning/);
});

test("smaller target window reports omitted items and leaves essentials inspectable", () => {
  const task = new ConsoleTaskContinuation(source);
  task.recordTurn("Primary goal", [], Array.from({ length: 40 }, (_, i) => `changed: file-${i}.ts`), "failed");
  const choice = task.propose({ ...target, contextWindow: 2_000 }, "haiku", source);
  assert.equal(choice.status, "ready");
  assert.ok(choice.proposal!.omitted > 0);
  assert.match(choice.proposal!.brief, /optional item\(s\) omitted/);
  assert.match(choice.proposal!.brief, /Primary goal/);
  assert.ok(choice.proposal!.brief.length <= 1_200);
  const tiny = task.propose({ ...target, id: "tiny", contextWindow: 512 }, "haiku", source);
  assert.equal(tiny.status, "ready");
  const tinyAcceptance = task.accept(source);
  assert.equal(tinyAcceptance.ok, false);
  if (!tinyAcceptance.ok) assert.match(tinyAcceptance.reason, /too small/);
});

test("explicit shell-result sharing is excluded from later model continuation", () => {
  const task = new ConsoleTaskContinuation(source);
  task.recordTurn("SECRET SHELL OUTPUT", [], [], "succeeded", false);
  task.recordTurn("Fix the build", [], [], "succeeded");
  const brief = task.propose(target, "haiku", source).proposal!.brief;
  assert.match(brief, /Fix the build/);
  assert.doesNotMatch(brief, /SECRET SHELL OUTPUT/);
});

test("line console sends the reviewed brief on the next model request, without switch-time calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-model-switch-"));
  const input = new PassThrough();
  const requests: Array<Record<string, unknown>> = [];
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
  const ctx = {
    cfg: { baseUrl: "https://stub.test", defaultModel: "haiku", backend: "cloud", permissionMode: "ask", autoApply: false, telemetry: false, defaultEffort: "" },
    flags: { cwd: root, json: true, yes: false, audit: false },
    tokens: { get: async () => "one-account" },
    api: {
      getJson: async () => ({ tier: "pro", default: "haiku", models: [{ id: "sonnet", label: "Sonnet", kind: "model", provider: "fixture", context_window: 32_000, available: true, enabled: true, tier_min: "free", monthly_uvt_cap: null, is_default: false }] }),
      stream: async (_path: string, body: Record<string, unknown>) => {
        requests.push(body);
        return (async function* () { yield new TextEncoder().encode('data: {"type":"done","uvt":0,"cents":0}\n\n'); })();
      },
    },
    confirm: async () => false,
  } as unknown as AppContext;
  try {
    const run = replLines(ctx, { noSkills: true }, undefined, input);
    input.end("Fix parser Unicode handling\nKeep quoted titles\n/model sonnet\n/switch edit outstanding Run the Windows check\n/switch continue\nFinish it\n/exit\n");
    assert.equal(await run, 0);
    assert.equal(requests.length, 3);
    assert.match(output, /Exact continuation brief for review/);
    assert.match(JSON.stringify(requests[2]), /Fix parser Unicode handling/);
    assert.match(JSON.stringify(requests[2]), /Keep quoted titles/);
    assert.match(JSON.stringify(requests[2]), /Run the Windows check/);
    assert.match(JSON.stringify(requests[2]), /sonnet/);
    assert.doesNotMatch(JSON.stringify(requests[0]), /Accepted console continuation brief/);
  } finally {
    process.stdout.write = originalWrite;
    input.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelled line-console switch makes no extra model request", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-model-cancel-"));
  const input = new PassThrough();
  let calls = 0;
  const ctx = {
    cfg: { baseUrl: "https://stub.test", defaultModel: "haiku", backend: "cloud", permissionMode: "ask", autoApply: false, telemetry: false, defaultEffort: "" },
    flags: { cwd: root, json: true, yes: false, audit: false },
    tokens: { get: async () => "one-account" },
    api: {
      getJson: async () => ({ tier: "pro", default: "haiku", models: [{ id: "sonnet", label: "Sonnet", kind: "model", provider: "fixture", context_window: 32_000, available: true, enabled: true, tier_min: "free", monthly_uvt_cap: null, is_default: false }] }),
      stream: async () => { calls++; return (async function* () { yield new TextEncoder().encode('data: {"type":"done","uvt":0,"cents":0}\n\n'); })(); },
    },
    confirm: async () => false,
  } as unknown as AppContext;
  try {
    const run = replLines(ctx, { noSkills: true }, undefined, input);
    input.end("First turn\n/model sonnet\n/switch cancel\n/exit\n");
    assert.equal(await run, 0);
    assert.equal(calls, 1);
    assert.equal(ctx.flags.model, undefined);
  } finally { input.destroy(); rmSync(root, { recursive: true, force: true }); }
});

test("raw console cancellation restores a draft typed while the model catalog loads", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-model-draft-"));
  const originalWrite = process.stdout.write;
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const raw = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
  let output = "";
  let resolveCatalog: ((value: unknown) => void) | null = null;
  let catalogCalls = 0;
  let modelCalls = 0;
  const bodies: string[] = [];
  const catalog = { tier: "pro", default: "haiku", models: [{ id: "sonnet", label: "Sonnet", kind: "model", provider: "fixture", context_window: 32_000, available: true, enabled: true, tier_min: "free", monthly_uvt_cap: null, is_default: false }] };
  const ctx = {
    cfg: { baseUrl: "https://stub.test", defaultModel: "haiku", backend: "cloud", permissionMode: "ask", autoApply: false, telemetry: false, defaultEffort: "" },
    flags: { cwd: root, json: true, yes: false, audit: false },
    tokens: { get: async () => "one-account" },
    api: {
      getJson: async () => {
        catalogCalls++;
        return catalogCalls === 1
          ? new Promise(resolve => { resolveCatalog = resolve; })
          : { ...catalog, account_id: "account-one" };
      },
      stream: async (_path: string, body: unknown) => { modelCalls++; bodies.push(JSON.stringify(body)); return (async function* () { yield new TextEncoder().encode('data: {"type":"done","uvt":0,"cents":0}\n\n'); })(); },
    },
    confirm: async () => false,
  } as unknown as AppContext;
  let running: Promise<number> | null = null;
  const submit = (value: string) => process.stdin.emit("data", Buffer.from(value + "\r"));
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("raw console timed out: " + output.slice(-500));
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  try {
    invalidateCatalog();
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
    process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
    running = repl(ctx, { noSkills: true });
    await until(() => output.includes("\x1b[?2004h"));
    submit("/model sonnet");
    await until(() => resolveCatalog !== null);
    submit("queued follow-up");
    process.stdin.emit("data", Buffer.from("unsent draft"));
    resolveCatalog!(catalog);
    await until(() => output.includes("Unsent draft: saved"));
    assert.match(output, /Queued entries: 1/);
    submit("/switch cancel");
    await until(() => output.includes("Model switch cancelled"));
    await until(() => output.slice(output.lastIndexOf("Model switch cancelled")).includes(" draft"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(modelCalls, 0);
    submit(""); // Submit the restored draft behind the older pending entry.
    assert.equal(modelCalls, 0);
    submit("/queue run"); // Explicitly resume the paused FIFO after cancelling the switch.
    await until(() => modelCalls === 2);
    assert.match(bodies[0]!, /queued follow-up/);
    assert.doesNotMatch(bodies[0]!, /Accepted console continuation brief/);
    assert.match(bodies[1]!, /unsent draft/);
    await until(() => output.includes("turn_outcome"));
    submit("/exit");
    assert.equal(await running, 0);
    running = null;
  } finally {
    if (running) {
      process.stdin.emit("data", Buffer.from("\x03\x03\x04"));
      await Promise.race([running.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1_000))]);
    }
    process.stdout.write = originalWrite;
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty); else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    if (raw) Object.defineProperty(process.stdin, "setRawMode", raw); else delete (process.stdin as unknown as { setRawMode?: unknown }).setRawMode;
    rmSync(root, { recursive: true, force: true });
  }
});
