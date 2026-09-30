import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { delegateSlash, treeSlash, gatherSlash } from "../src/commands/slash_orchestra.js";
import { projectRefFor, rcOutboxPath } from "../src/commands/rc.js";
import type { AppContext } from "../src/core/context.js";
import type { ApiClient } from "../src/core/transport.js";
import { createOutbox, loadOutbox, saveOutbox } from "../src/core/rc/outbox.js";
import { payloadDigest } from "../src/core/rc/receipts.js";

test("delegate, tree and gather publish one bounded worker lifecycle across reconnects", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-rc-workers-"));
  const path = rcOutboxPath(projectRefFor(root));
  const session = "rs_" + "3".repeat(32);
  const sent: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
  let seq = 0;
  let offline = true;
  let gatherReady = false;
  try {
    saveOutbox(path, createOutbox({
      session_id: session, project_ref: projectRefFor(root), device_id: "dev-test",
      epoch: 1, project_root: root,
    }));
    const api = {
      async getJson(endpoint: string) {
        assert.match(endpoint, /\/agents\/tree/);
        return { orchestrator: "neo", workers: [{
          id: "w-1", model: "private-model", step: "writing tests for secret task and tool output",
          tokens: 100, uvt: 2,
        }] };
      },
      async postJson(endpoint: string, body: unknown) {
        if (endpoint === "/agents/delegate") return { worker_id: "w-1", status: "running" };
        if (endpoint === "/agents/gather") return {
          results: gatherReady ? [{ worker_id: "w-1", files: [], diffs: [], patches: [] }] : [],
        };
        assert.equal(endpoint, `/remote/sessions/${session}/host/events`);
        if (offline) throw new Error("broker offline");
        const events = (body as { events: Array<{
          host_event_id: string; event_type: string; payload: Record<string, unknown>;
        }> }).events;
        sent.push(...events.map(({ event_type, payload }) => ({ event_type, payload })));
        return { session_id: session, receipts: events.map((event) => ({
          host_event_id: event.host_event_id, seq: ++seq, payload_digest: payloadDigest(event.payload),
        })) };
      },
    } as unknown as ApiClient;
    const ctx = { flags: { cwd: root, agent: "neo" }, api } as unknown as AppContext;
    const out = { write: () => true } as never;

    await delegateSlash(ctx, out, "private-model secret task prompt");
    assert.equal(loadOutbox(path, root).events.length, 1, "offline start is durable");
    offline = false;
    await treeSlash(ctx, out);
    assert.equal(loadOutbox(path, root).events.length, 0, "receipted start and progress leave the queue");
    await treeSlash(ctx, out);
    await gatherSlash(ctx, out, "all");
    assert.equal(sent.length, 2, "replayed tree and empty gather do not invent events");
    gatherReady = true;
    await gatherSlash(ctx, out, "all");
    await gatherSlash(ctx, out, "all");
    await treeSlash(ctx, out);
    assert.deepEqual(sent.map((event) => event.payload["status"]), ["running", "running", "done"]);
    assert.deepEqual(sent.map((event) => event.payload["summary"]), ["Delegated", "Testing", undefined]);
    const publicId = sent[0]?.payload["subagent_id"];
    assert.match(String(publicId), /^worker-[0-9a-f]{24}$/);
    assert.ok(sent.every((event) => event.payload["subagent_id"] === publicId));
    assert.equal(loadOutbox(path, root).observed_workers[String(publicId)]?.status, "done");
    assert.doesNotMatch(JSON.stringify(sent), /w-1|secret task|private-model|tool output|tokens|uvt/);
  } finally {
    rmSync(path, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
