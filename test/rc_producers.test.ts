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
  hostPresenceEvent,
  mapBrainEventToRc,
  producerCoverage,
  sessionOpenedEvent,
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

test("each deferred type says which subsystem it waits on", () => {
  for (const [type, reason] of Object.entries(RC_UNPRODUCED_EVENT_TYPES)) {
    assert.ok(reason.length > 20, `${type} needs a real reason, not a placeholder`);
  }
});

test("the produced list stays inside the viewer profile", () => {
  for (const type of RC_PRODUCED_EVENT_TYPES) {
    assert.ok(
      (VIEWER_EVENT_TYPES as readonly string[]).includes(type),
      `${type} is not in the viewer profile`,
    );
  }
});
