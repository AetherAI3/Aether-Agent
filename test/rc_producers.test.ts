// RC-02 producers — what a viewer can see, and what it must never see.
//
// Three groups:
//
//   1. The refusals         — the reason this file is safety-critical
//   2. The mappings         — each produced type comes from a real source
//   3. Coverage is declared — refit 12, no phantom features
//
// The refusals come first on purpose. A missing mapping is a feature gap; a
// wrong one publishes the operator's reasoning to a remote screen.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { BrainEvent } from "../src/core/brain_protocol.js";
import {
  RC_PRODUCED_EVENT_TYPES,
  RC_UNPRODUCED_EVENT_TYPES,
  artifactEvent,
  ciEvent,
  diffSummaryEvent,
  hostPresenceEvent,
  mapBrainEventToRc,
  prStatusEvent,
  previewEvent,
  producerCoverage,
  sessionOpenedEvent,
  subagentEvent,
  subagentFinishedEvent,
  testsEvent,
} from "../src/core/rc/producers.js";
import { createOutbox, enqueueEvent } from "../src/core/rc/outbox.js";
import { VIEWER_EVENT_TYPES } from "../src/core/rc/viewer_profile.js";

// ── 1. The refusals ─────────────────────────────────────────────────────────

test("model reasoning is never published", () => {
  // monologue is the transcript in all but name. `transcript` is excluded from
  // the viewer profile precisely so this question has one answer regardless of
  // which producer happens to be wired.
  const monologue: BrainEvent = {
    type: "monologue",
    text: "I should try the admin credentials from the env file",
    depth: 0,
  };
  assert.equal(mapBrainEventToRc(monologue), null);
});

test("private memory frames are never published", () => {
  const memory: BrainEvent = {
    type: "memory",
    subtype: "behavioral",
    text: "the operator keeps their staging key in a dotfile",
  };
  assert.equal(mapBrainEventToRc(memory), null);
});

test("hardware telemetry and per-turn diagnostics are never published", () => {
  const telemetry: BrainEvent = {
    type: "telemetry",
    tokens: 1,
    tps: 2,
    ctxUsed: 3,
    ctxCap: 4,
    vram: 5,
  };
  const turn: BrainEvent = {
    type: "turn",
    n: 1,
    toolCalls: 2,
    malformed: 0,
    invented: 0,
    noCall: false,
    failCount: null,
  };
  const status: BrainEvent = { type: "status", phase: "run", poolUsed: 1, poolCap: 2 };
  for (const event of [telemetry, turn, status]) {
    assert.equal(mapBrainEventToRc(event), null, `${event.type} must not be published`);
  }
});

test("no refused text can be smuggled through by way of the outbox", () => {
  // Belt and braces: even if a caller ignored the null and forced the text in
  // under a plausible type, the allowlist drops it.
  const record = createOutbox({
    session_id: "rs_" + "c".repeat(32),
    project_ref: "p",
    device_id: "d",
    epoch: 1,
    project_root: "/repo",
  });
  const accepted = enqueueEvent(record, "plan", {
    title: "step",
    status: "running",
    text: "I should try the admin credentials",
  });
  assert.equal(accepted, true);
  assert.doesNotMatch(JSON.stringify(record.events[0]!.payload), /admin credentials/);
});

// ── 2. The mappings ─────────────────────────────────────────────────────────

test("a stage becomes a plan step", () => {
  const out = mapBrainEventToRc({ type: "stage", name: "build", face: ":)" });
  assert.deepEqual(out, { event_type: "plan", payload: { title: "build", status: "running" } });
});

test("a tool call becomes tool activity naming the tool, not its arguments", () => {
  const out = mapBrainEventToRc({
    type: "tool_call",
    id: "1",
    name: "write_file",
    args: { path: "src/index.ts", contents: "SECRET-BODY-DO-NOT-SHIP" },
  });
  assert.equal(out?.event_type, "tool_activity");
  assert.equal(out?.payload["tool"], "write_file");
  assert.equal(out?.payload["target"], "src/index.ts");
  assert.doesNotMatch(JSON.stringify(out), /SECRET-BODY-DO-NOT-SHIP/);
});

test("a tool call with nothing worth naming still reports the tool", () => {
  const out = mapBrainEventToRc({ type: "tool_call", id: "1", name: "list", args: {} });
  assert.equal(out?.payload["target"], undefined);
  assert.equal(out?.payload["tool"], "list");
});

test("done carries pass or fail, not a bare truthy flag", () => {
  const ok = mapBrainEventToRc({
    type: "done",
    ok: true,
    result: "3 tests",
    remaining: 0,
    reason: "",
  });
  const bad = mapBrainEventToRc({
    type: "done",
    ok: false,
    result: "1 failing",
    remaining: 1,
    reason: "unverified",
  });
  assert.equal(ok?.payload["status"], "passed");
  assert.equal(bad?.payload["status"], "failed");
});

test("an error maps to the error type with a code a viewer can group on", () => {
  const out = mapBrainEventToRc({ type: "error", msg: "boom" });
  assert.deepEqual(out, { event_type: "error", payload: { code: "agent_error", message: "boom" } });
});

test("session and presence describe the run without naming a controller", () => {
  const session = sessionOpenedEvent({
    session_name: "s",
    repo: "AetherAI3/aether-agent",
    branch: "main",
    base_commit: "0".repeat(40),
    dirty_file_count: 2,
    protocol_version: "1",
  });
  assert.equal(session.event_type, "session");
  assert.equal(session.payload["state"], "active");

  const presence = hostPresenceEvent("dev-1", "online");
  assert.equal(presence.payload["role"], "host");
  assert.notEqual(presence.payload["role"], "controller");
});

test("every produced payload survives the sanitizer for its own type", () => {
  // A producer emitting keys outside its type's allowlist would be silently
  // reduced to nothing, which reads as a dead feature rather than a bug.
  const record = createOutbox({
    session_id: "rs_" + "d".repeat(32),
    project_ref: "p",
    device_id: "d",
    epoch: 1,
    project_root: "/repo",
  });
  const produced = [
    mapBrainEventToRc({ type: "stage", name: "build", face: "" })!,
    mapBrainEventToRc({ type: "tool_call", id: "1", name: "t", args: { path: "a.ts" } })!,
    mapBrainEventToRc({ type: "done", ok: true, result: "fine", remaining: 0, reason: "" })!,
    mapBrainEventToRc({ type: "error", msg: "boom" })!,
    hostPresenceEvent("dev-1", "online"),
    sessionOpenedEvent({
      session_name: "s",
      repo: "r",
      branch: "b",
      base_commit: "c",
      dirty_file_count: 0,
      protocol_version: "1",
    }),
  ];
  for (const event of produced) {
    assert.equal(
      enqueueEvent(record, event.event_type, event.payload),
      true,
      `${event.event_type} was refused by its own allowlist`,
    );
  }
  assert.equal(record.events.length, produced.length);
});

// ── 3. Coverage is declared, not implied ────────────────────────────────────

test("every viewer event type is either produced or explicitly deferred", () => {
  // Refit 12: a declared event type with no producer is not a delivered
  // feature. This is what stops the gap drifting — adding a type without a
  // producer, or quietly dropping one, fails here.
  const coverage = producerCoverage();
  assert.deepEqual(coverage.missing, [], "these viewer types have neither a producer nor a reason");
  assert.equal(
    coverage.produced.length + coverage.unproduced.length,
    VIEWER_EVENT_TYPES.length,
    "produced and deferred must partition the viewer profile exactly",
  );
});

test("any type still deferred names the subsystem it waits on", () => {
  // Empty once all thirteen have producers. Kept because the invariant is
  // "nothing is deferred without a stated reason", not "nothing is deferred".
  for (const [type, reason] of Object.entries(RC_UNPRODUCED_EVENT_TYPES)) {
    assert.ok(reason.length > 20, `${type} needs a real reason, not a placeholder`);
  }
});

test("all thirteen viewer event types now have a producer", () => {
  const coverage = producerCoverage();
  assert.deepEqual(coverage.unproduced, []);
  assert.equal(coverage.produced.length, VIEWER_EVENT_TYPES.length);
  assert.deepEqual([...coverage.produced].sort(), [...VIEWER_EVENT_TYPES].sort());
});

test("the produced list stays inside the viewer profile", () => {
  for (const type of RC_PRODUCED_EVENT_TYPES) {
    assert.ok(
      (VIEWER_EVENT_TYPES as readonly string[]).includes(type),
      `${type} is not in the viewer profile`,
    );
  }
});

// ── 4. The seven subsystem adapters ─────────────────────────────────────────
//
// For each: it survives its own allowlist (a producer whose payload is filtered
// to nothing is a dead feature), and the fields deliberately dropped stay
// dropped.

function box(): ReturnType<typeof createOutbox> {
  return createOutbox({
    session_id: "rs_" + "f".repeat(32),
    project_ref: "p",
    device_id: "d",
    epoch: 1,
    project_root: "/repo",
  });
}

/** Enqueue and return what actually reached the outbox, or null if refused. */
function persisted(event: {
  event_type: string;
  payload: Record<string, unknown>;
}): Record<string, unknown> | null {
  const record = box();
  const ok = enqueueEvent(record, event.event_type, event.payload);
  return ok ? record.events[0]!.payload : null;
}

test("subagent comes from the orchestrator's worker tree, without the model", () => {
  // Model identity is one of the four identities kept separate from device,
  // account and connector identity. A viewer stream is where they would blur.
  const payload = persisted(
    subagentEvent({ id: "w-1", model: "claude-opus-5", step: "writing tests", tokens: 10, uvt: 2 }),
  );
  assert.ok(payload, "subagent payload was filtered to nothing");
  assert.equal(payload["subagent_id"], "w-1");
  assert.equal(payload["summary"], "writing tests");
  assert.doesNotMatch(JSON.stringify(payload), /claude-opus-5/);
  assert.equal(payload["tokens"], undefined);
  assert.equal(payload["uvt"], undefined);
});

test("a finished subagent reports its terminal status", () => {
  const payload = persisted(subagentFinishedEvent("w-1", "done"));
  assert.equal(payload?.["status"], "done");
});

test("diff_summary carries counts and paths, never a diff body", () => {
  const payload = persisted(
    diffSummaryEvent({ additions: 12, deletions: 3, uncounted: ["img.png"] }, [
      "src/a.ts",
      "img.png",
    ]),
  );
  assert.ok(payload, "diff_summary was filtered to nothing");
  assert.equal(payload["insertions"], 12);
  assert.equal(payload["deletions"], 3);
  assert.equal(payload["files_changed"], 2);
  assert.deepEqual(payload["files"], ["src/a.ts", "img.png"]);
});

test("an absolute path in a diff summary is refused by the sanitizer", () => {
  const payload = persisted(
    diffSummaryEvent({ additions: 1, deletions: 0, uncounted: [] }, ["/home/someone/secret/a.ts"]),
  );
  assert.doesNotMatch(JSON.stringify(payload), /someone/);
});

test("tests reports the verifier's own status, inventing no counts", () => {
  // "unknown" means the tree moved while the command ran. Collapsing that to
  // pass or fail is exactly the claim RC must not make for a viewer.
  const payload = persisted(
    testsEvent({ status: "unknown", reason: "the tree changed during the run", record: null }),
  );
  assert.ok(payload);
  assert.equal(payload["status"], "unknown");
  assert.equal(payload["passed"], undefined, "a count nobody measured must not appear");
  assert.equal(payload["failed"], undefined);
});

test("tests passes through every verifier status unchanged", () => {
  for (const status of ["verified", "failed", "stale"] as const) {
    const payload = persisted(testsEvent({ status, reason: "r", record: null }));
    assert.equal(payload?.["status"], status);
  }
});

const RECEIPT = {
  receipt_id: "rcpt_1",
  plan_id: "plan_1",
  action_digest: "sha256:" + "0".repeat(64),
  repository: "AetherAI3/aether-agent",
  provider_object_ids: {} as Record<string, string | number>,
  reconciled: true,
  issued_at: "2026-09-07T00:00:00.000Z",
};

test("ci comes from a CI action receipt and carries only the run identity", () => {
  const event = ciEvent({
    ...RECEIPT,
    action_type: "aether.github.ci.rerun_failed",
    provider_object_ids: { run_id: 42 },
  });
  assert.ok(event);
  const payload = persisted(event);
  assert.ok(payload);
  assert.equal(payload["provider"], "github");
  assert.equal(payload["run_id"], "42");
  assert.equal(payload["status"], "reconciled");
});

test("a non-CI receipt does not become a ci event", () => {
  assert.equal(ciEvent({ ...RECEIPT, action_type: "aether.github.pr.create" }), null);
});

test("pr_status builds its URL from the receipt, never from a branch name", () => {
  const event = prStatusEvent({
    ...RECEIPT,
    action_type: "aether.github.pr.create",
    provider_object_ids: { number: 149 },
  });
  assert.ok(event);
  const payload = persisted(event);
  assert.ok(payload);
  assert.equal(payload["repo"], "AetherAI3/aether-agent");
  assert.equal(payload["number"], 149);
  assert.equal(payload["url"], "https://github.com/AetherAI3/aether-agent/pull/149");
});

test("a repository that is not a plain owner/name yields no URL", () => {
  // Nothing may be spliced into a link a viewer might click.
  const event = prStatusEvent({
    ...RECEIPT,
    repository: "evil.example/../../x?a=b",
    action_type: "aether.github.pr.update",
    provider_object_ids: { number: 1 },
  });
  assert.ok(event);
  const payload = persisted(event);
  assert.equal(payload?.["url"], undefined);
  assert.equal(payload?.["repo"], undefined);
});

test("a non-PR receipt does not become a pr_status event", () => {
  assert.equal(prStatusEvent({ ...RECEIPT, action_type: "aether.github.ci.rerun_failed" }), null);
});

const MEDIA = {
  artifactId: "art_1",
  sequence: "1",
  createdAt: "2026-09-07T00:00:00.000Z",
  kind: "image" as const,
  displayName: "diagram.png",
  filePath: "/home/someone/out/diagram.png",
  url: "https://cdn.example/signed?token=SIGNED-URL-CANARY",
  model: "some-image-model",
  prompt: "a private prompt the operator typed",
  sizeBytes: 1024,
  source: "agent-media" as const,
};

test("artifact publishes identifiers, never the path, URL, prompt or model", () => {
  const payload = persisted(artifactEvent(MEDIA));
  assert.ok(payload);
  assert.equal(payload["artifact_id"], "art_1");
  assert.equal(payload["kind"], "image");
  assert.equal(payload["title"], "diagram.png");
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /someone/);
  assert.doesNotMatch(text, /SIGNED-URL-CANARY/);
  assert.doesNotMatch(text, /a private prompt/);
  assert.doesNotMatch(text, /some-image-model/);
});

const PREVIEW = {
  schema: "aether.preview/1" as const,
  instanceId: "11111111-1111-4111-8111-111111111111",
  projectRoot: "/repo",
  commandDigest: "0".repeat(64),
  phase: "ready" as const,
  supervisorPid: 1,
  childPid: 2,
  controlPort: 3,
  startedAt: "2026-09-07T00:00:00.000Z",
};

test("preview publishes a public URL but never a loopback one", () => {
  // A localhost URL is useless to somebody on another machine and still
  // discloses a local port.
  const local = persisted(previewEvent({ ...PREVIEW, url: "http://127.0.0.1:5173/" }, () => true));
  assert.equal(local?.["url"], undefined);
  assert.equal(local?.["phase"], "ready");

  const remote = persisted(
    previewEvent({ ...PREVIEW, url: "https://preview.example/app" }, () => false),
  );
  assert.equal(remote?.["url"], "https://preview.example/app");
});

test("preview never publishes pids, ports or the child's error text", () => {
  const payload = persisted(
    previewEvent(
      { ...PREVIEW, phase: "failed", error: "ECONNREFUSED at /home/someone" },
      () => true,
    ),
  );
  assert.ok(payload);
  assert.equal(payload["phase"], "failed");
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /ECONNREFUSED/);
  assert.doesNotMatch(text, /someone/);
  assert.equal(payload["controlPort"], undefined);
  assert.equal(payload["supervisorPid"], undefined);
});
