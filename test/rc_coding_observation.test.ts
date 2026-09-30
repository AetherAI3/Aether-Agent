import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Brain, TaskCommand } from "../src/core/brain.js";
import type { BrainEvent } from "../src/core/brain_protocol.js";
import type { ToolExecutor, ToolResult } from "../src/core/tool_executor.js";
import type { ApiClient } from "../src/core/transport.js";
import { createOutbox, enqueueEvent, loadOutbox, saveOutbox } from "../src/core/rc/outbox.js";
import { payloadDigest } from "../src/core/rc/receipts.js";
import { hostLoop } from "../src/commands/code.js";
import { projectRefFor } from "../src/commands/rc.js";
import { openRcCodingObserver } from "../src/commands/rc_observation.js";

const SESSION = "rs_" + "f".repeat(32);
const PRIVATE = "private-prompt-and-model-output";
const task: TaskCommand = { type: "task", text: PRIVATE, cwd: ".", poolGb: 5 };
const exec = { executeAsync: async (): Promise<ToolResult> => ({ output: PRIVATE, exitCode: 0 }) } as unknown as ToolExecutor;

function source(events: readonly BrainEvent[]): Brain {
  return {
    async *run() { yield* events; },
    sendToolResult() {},
    control() {},
    close() {},
  };
}

function seeded(root: string, path: string): void {
  const record = createOutbox({
    session_id: SESSION,
    project_ref: projectRefFor(root),
    device_id: "dev-1",
    epoch: 1,
    project_root: root,
  });
  enqueueEvent(record, "session", { state: "live" });
  enqueueEvent(record, "presence", { role: "host", liveness: "live" });
  saveOutbox(path, record);
}

test("a real coding event stream reaches ordered browser events with private fields removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "rc-code-"));
  const path = join(root, "outbox.json");
  seeded(root, path);
  const received: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
  let sequence = 0;
  const api = {
    async postJson(_path: string, body: { events: Array<{
      host_event_id: string; event_type: string; payload: Record<string, unknown>;
    }> }) {
      received.push(...body.events);
      return {
        session_id: SESSION,
        receipts: body.events.map((event) => ({
          host_event_id: event.host_event_id,
          seq: ++sequence,
          payload_digest: payloadDigest(event.payload),
        })),
      };
    },
  } as unknown as ApiClient;
  const observer = openRcCodingObserver(root, api, path);
  assert.ok(observer);
  const events: BrainEvent[] = [
    { type: "stage", name: "build", face: "" },
    { type: "monologue", text: PRIVATE, depth: 0 },
    { type: "tool_call", id: "1", name: "write_file", args: { path: "src/file.ts", content: PRIVATE } },
    { type: "done", ok: true, result: PRIVATE, remaining: 0, reason: "" },
  ];
  assert.equal(await hostLoop(source(events), exec, (event) => observer.feed(event), task), 0);
  await observer.drain();
  assert.deepEqual(received.map((event) => event.event_type), [
    "session", "presence", "plan", "tool_activity", "done",
  ]);
  assert.equal(received[2]?.payload["title"], "Implementing");
  assert.equal(received[2]?.payload["projection_version"], "1");
  assert.equal(received[3]?.payload["tool"], "write_file");
  assert.equal(received[3]?.payload["target"], "src/file.ts");
  assert.equal(received[4]?.payload["status"], "completed");
  assert.doesNotMatch(JSON.stringify(received), /private-prompt-and-model-output/);
  assert.equal(loadOutbox(path, root).events.length, 0);
});

test("a safe error is queued when the broker is disconnected without delaying the run", async () => {
  const root = mkdtempSync(join(tmpdir(), "rc-code-"));
  const path = join(root, "outbox.json");
  seeded(root, path);
  const api = { postJson: () => new Promise(() => {}) } as unknown as ApiClient;
  const observer = openRcCodingObserver(root, api, path);
  assert.ok(observer);
  const run = hostLoop(source([
    { type: "stage", name: "recon", face: "" },
    { type: "error", msg: PRIVATE },
  ]), exec, (event) => observer.feed(event), task);
  assert.equal(await Promise.race([run, new Promise<number>((resolve) => setTimeout(() => resolve(99), 100))]), 1);
  const saved = loadOutbox(path, root).events;
  assert.deepEqual(saved.map((event) => event.event_type), ["session", "presence", "plan", "error"]);
  assert.equal(saved[3]?.payload["message"], "Agent reported an error");
  assert.doesNotMatch(JSON.stringify(saved), /private-prompt-and-model-output/);
});

test("without rc start there is no observer and no account or upload call", async () => {
  const root = mkdtempSync(join(tmpdir(), "rc-code-"));
  let calls = 0;
  const api = { postJson: () => { calls++; throw new Error("unexpected upload"); } } as unknown as ApiClient;
  const observer = openRcCodingObserver(root, api, join(root, "missing.json"));
  assert.equal(observer, null);
  assert.equal(await hostLoop(source([{ type: "done", ok: true, result: PRIVATE, remaining: 0, reason: "" }]), exec, () => {}, task), 0);
  assert.equal(calls, 0);
});

test("an in-flight receipt cannot turn a locally revoked session back on", async () => {
  const root = mkdtempSync(join(tmpdir(), "rc-code-"));
  const path = join(root, "outbox.json");
  seeded(root, path);
  let accept!: (value: unknown) => void;
  const response = new Promise((resolve) => { accept = resolve; });
  const api = { postJson: () => response } as unknown as ApiClient;
  const observer = openRcCodingObserver(root, api, path);
  assert.ok(observer);
  observer.feed({ type: "stage", name: "execute", face: "" });
  const old = loadOutbox(path, root);
  const receipts = old.events.map((event, index) => ({
    host_event_id: event.host_event_id,
    seq: index + 1,
    payload_digest: payloadDigest(event.payload),
  }));
  old.revoke_pending = true;
  old.events = [];
  saveOutbox(path, old);
  accept({ session_id: SESSION, receipts });
  await observer.drain();
  observer.feed({ type: "done", ok: true, result: "", remaining: 0, reason: "" });
  const current = loadOutbox(path, root);
  assert.equal(current.revoke_pending, true);
  assert.deepEqual(current.events, []);
});
