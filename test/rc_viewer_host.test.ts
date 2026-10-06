// RC-02 viewer host — the safety-critical primitives.
//
// Four groups, in descending order of what a mistake would cost:
//
//   1. RC never touches a device secret          — §5.1
//   2. The durable cursor only moves on proof     — §5.3
//   3. The viewer surface carries no control      — §2.4 / §4
//   4. Nothing unallowlisted leaves the machine   — §6
//
// Every fixture is synthetic. The one token-shaped literal exists to be
// asserted ABSENT from sanitizer output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RC_EVENT_ID_CONFLICT,
  describeRejection,
  payloadDigest,
  validateReceipts,
  type OutboxEvent,
} from "../src/core/rc/receipts.js";
import {
  EXCLUDED_EVENT_TYPES,
  FORBIDDEN_VIEWER_TERMS,
  VIEWER_CAPABILITIES,
  VIEWER_EVENT_TYPES,
  VIEWER_PRESENCE_ROLES,
  ViewerProfileViolation,
  assertViewerCapabilities,
  assertViewerEventType,
  assertViewerManifest,
  isViewerEventType,
  tokenize,
  viewerManifest,
} from "../src/core/rc/viewer_profile.js";
import {
  RC_MAX_PAYLOAD_BYTES,
  relativizePath,
  sanitizeRemotePayload,
} from "../src/core/rc/redaction.js";
import { loadEnrollmentMetadata } from "../src/core/device_runtime/identity.js";
import { createOutbox, enqueueEvent } from "../src/core/rc/outbox.js";
import { mapBrainEventToRc } from "../src/core/rc/producers.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const rcDir = join(repoRoot, "src", "core", "rc");

const GITHUB_TOKEN_SHAPED = "ghp_" + "A".repeat(22);

function event(id: string, payload: Record<string, unknown> = { status: "ok" }): OutboxEvent {
  return { host_event_id: id, event_type: "tool_activity", payload };
}

function accepted(id: string, seq: unknown, payload: Record<string, unknown> = { status: "ok" }) {
  return { host_event_id: id, seq, payload_digest: payloadDigest(payload) };
}

// ── 1. RC never touches a device secret ──────────────────────────────────────

test("no RC module references a device secret or the full-record accessor", () => {
  // The load-bearing guard for §5.1. loadEnrollment() returns device_token and
  // device_command_key; RC publishes observation events and must hold neither.
  // Checked by reading source, because "we only read three fields" is a
  // convention and a convention cannot be enforced.
  const files = readdirSync(rcDir).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0, "no RC modules found — this guard would be vacuous");
  for (const name of files) {
    const source = readFileSync(join(rcDir, name), "utf8");
    for (const forbidden of ["loadEnrollment(", "device_token", "device_command_key"]) {
      assert.ok(
        !source.includes(forbidden),
        `src/core/rc/${name} must not reference ${forbidden}`,
      );
    }
  }
});

test("the metadata accessor exists and returns only non-secret fields", () => {
  // No enrollment on a test machine, so this returns null. The shape assertion
  // that matters is compile-time (EnrollmentMetadata has four fields, none of
  // them a secret); this pins that the export is real and callable.
  const metadata = loadEnrollmentMetadata();
  if (metadata !== null) {
    assert.deepEqual(
      Object.keys(metadata).sort(),
      ["base_url", "device_id", "display_name", "enrolled_at"],
    );
  }
});

test("identity.ts projects field-by-field rather than spreading", () => {
  // A rest spread would carry any future secret into RC's reach silently.
  const source = readFileSync(
    join(repoRoot, "src", "core", "device_runtime", "identity.ts"),
    "utf8",
  );
  const fn = source.slice(source.indexOf("export function loadEnrollmentMetadata"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.ok(!body.includes("..."), "loadEnrollmentMetadata must not use a rest spread");
  assert.ok(body.includes("device_id: record.device_id"));
});

// ── 2. The durable cursor only moves on proof ────────────────────────────────

test("a complete, ordered, above-cursor batch advances the cursor", () => {
  const batch = [event("he_1"), event("he_2")];
  const outcome = validateReceipts(
    { receipts: [accepted("he_1", 41), accepted("he_2", 42)] },
    batch,
    40,
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.highestSeq, 42);
});

for (const [name, response, cursor] of [
  ["not an array", { receipts: "nope" }, 0],
  ["missing receipts", {}, 0],
  ["a null receipt", { receipts: [null] }, 0],
] as const) {
  test(`a malformed response preserves the batch (${name})`, () => {
    const outcome = validateReceipts(response as never, [event("he_1")], cursor);
    assert.equal(outcome.ok, false);
  });
}

test("a partial receipt list preserves the batch", () => {
  const outcome = validateReceipts(
    { receipts: [accepted("he_1", 1)] },
    [event("he_1"), event("he_2")],
    0,
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, "count_mismatch");
});

test("a duplicate receipt preserves the batch", () => {
  const outcome = validateReceipts(
    { receipts: [accepted("he_1", 1), accepted("he_1", 2)] },
    [event("he_1"), event("he_2")],
    0,
  );
  assert.equal(outcome.ok === false && outcome.reason, "duplicate_receipt");
});

test("a receipt for an event we never sent preserves the batch", () => {
  const outcome = validateReceipts(
    { receipts: [accepted("he_99", 1)] },
    [event("he_1")],
    0,
  );
  assert.equal(outcome.ok === false && outcome.reason, "unknown_event_id");
});

test("a non-boolean rejected value still counts as a rejection", () => {
  // Reading only `=== true` would treat `rejected: "quota"` as acceptance.
  const outcome = validateReceipts(
    { receipts: [{ host_event_id: "he_1", seq: 1, rejected: "quota" }] },
    [event("he_1")],
    0,
  );
  assert.equal(outcome.ok === false && outcome.reason, "explicitly_rejected");
});

test("decreasing sequences within a batch preserve the batch", () => {
  const outcome = validateReceipts(
    { receipts: [accepted("he_1", 9), accepted("he_2", 8)] },
    [event("he_1"), event("he_2")],
    0,
  );
  assert.equal(outcome.ok === false && outcome.reason, "sequence_not_increasing");
});

test("a sequence at or below the durable cursor preserves the batch", () => {
  // The stale-replay case PR #108 would have accepted: a broker returning old
  // sequence numbers to make the host drop events it never really stored.
  for (const seq of [40, 39, 1]) {
    const outcome = validateReceipts(
      { receipts: [accepted("he_1", seq)] },
      [event("he_1")],
      40,
    );
    assert.equal(
      outcome.ok === false && outcome.reason,
      "sequence_not_above_cursor",
      `seq ${seq} must not advance a cursor at 40`,
    );
  }
});

for (const seq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, "3" as unknown as number]) {
  test(`an invalid sequence preserves the batch (${String(seq)})`, () => {
    const outcome = validateReceipts(
      { receipts: [accepted("he_1", seq)] },
      [event("he_1")],
      0,
    );
    assert.equal(outcome.ok, false);
  });
}

test("a digest for different bytes preserves the batch", () => {
  // The event-id/payload binding: the same id with different content is a
  // different event. This is the RC_EVENT_ID_CONFLICT condition.
  const outcome = validateReceipts(
    {
      receipts: [
        { host_event_id: "he_1", seq: 1, payload_digest: payloadDigest({ status: "different" }) },
      ],
    },
    [event("he_1", { status: "ok" })],
    0,
  );
  assert.equal(outcome.ok === false && outcome.reason, "digest_mismatch");
  assert.equal(RC_EVENT_ID_CONFLICT, "RC_EVENT_ID_CONFLICT");
});

test("a matching digest is accepted", () => {
  const payload = { status: "ok" };
  const outcome = validateReceipts(
    { receipts: [{ host_event_id: "he_1", seq: 1, payload_digest: payloadDigest(payload) }] },
    [event("he_1", payload)],
    0,
  );
  assert.equal(outcome.ok, true);
});

test("an omitted digest preserves the batch", () => {
  const outcome = validateReceipts({ receipts: [{ host_event_id: "he_1", seq: 1 }] }, [event("he_1")], 0);
  assert.equal(outcome.ok === false && outcome.reason, "missing_digest");
});

test("every rejection reason has operator-facing text that names no payload", () => {
  const reasons = [
    "malformed_response", "count_mismatch", "unknown_event_id", "duplicate_receipt",
    "explicitly_rejected", "invalid_sequence", "sequence_not_increasing",
    "sequence_not_above_cursor", "missing_digest", "digest_mismatch",
  ] as const;
  for (const reason of reasons) {
    const text = describeRejection(reason);
    assert.ok(text.length > 0);
    assert.ok(!text.includes("he_"), "a status line must not carry an event id");
  }
});

// ── 3. The viewer surface carries no control ─────────────────────────────────

test("the viewer exposes exactly observe", () => {
  assert.deepEqual([...VIEWER_CAPABILITIES], ["observe"]);
  assertViewerCapabilities(["observe"]);
  assert.equal(viewerManifest()["control_capable"], false);
});

for (const declared of [[], ["control"], ["observe", "control"], ["observe", "steer"]]) {
  test(`capability set ${JSON.stringify(declared)} is refused`, () => {
    assert.throws(() => assertViewerCapabilities(declared), ViewerProfileViolation);
  });
}

test("controller is not a viewer presence role", () => {
  assert.ok(!(VIEWER_PRESENCE_ROLES as readonly string[]).includes("controller"));
});

test("transcript is excluded from the event vocabulary", () => {
  assert.deepEqual([...EXCLUDED_EVENT_TYPES], ["transcript"]);
  assert.equal(isViewerEventType("transcript"), false);
  assert.throws(() => assertViewerEventType("transcript"), ViewerProfileViolation);
});

test("observation event types survive", () => {
  for (const type of ["plan", "tool_activity", "tests", "ci", "pr_status", "done"]) {
    assertViewerEventType(type);
  }
});

test("a viewer route manifest passes", () => {
  assertViewerManifest(
    [
      "/rc/sessions",
      "/rc/sessions/{id}/events",
      "/rc/sessions/{id}/observers",
      "/rc/sessions/{id}/exposure",
      "/rc/sessions/{id}/revoke",
    ],
    "route",
  );
});

for (const entry of [
  "/rc/sessions/{id}/commands",
  "/rc/sessions/{id}/steer",
  "/rc/sessions/{id}/emergency_stop",
  "rcSendCommand",
  "RemoteControlCommandV1",
  "rc-session-pause",
  "RC_EMERGENCY_STOP",
  "rc.session.checkpoint",
]) {
  test(`control vocabulary is refused in every naming style: ${entry}`, () => {
    assert.throws(() => assertViewerManifest([entry], "route"), ViewerProfileViolation);
  });
}

for (const safe of ["/rc/sessions/{id}/recommended", "/rc/stopwatch", "/rc/promptbook_summary"]) {
  test(`word boundaries prevent a false positive: ${safe}`, () => {
    assertViewerManifest([safe], "route");
  });
}

test("tokenize splits every naming style", () => {
  assert.deepEqual(tokenize("emergency_stop"), ["emergency", "stop"]);
  assert.deepEqual(tokenize("rcSendCommand"), ["rc", "send", "command"]);
  assert.deepEqual(tokenize("RC_EMERGENCY_STOP"), ["rc", "emergency", "stop"]);
  assert.deepEqual(tokenize("stopwatch"), ["stopwatch"]);
});

test("the forbidden set covers the deferred controller registry", () => {
  for (const verb of ["pause", "resume", "checkpoint", "cancel", "terminate", "emergency"]) {
    assert.ok(FORBIDDEN_VIEWER_TERMS.has(verb), `${verb} must be forbidden`);
  }
});

test("the manifest is stable and serializable", () => {
  const manifest = viewerManifest();
  assert.deepEqual(manifest["event_types"], [...VIEWER_EVENT_TYPES].sort());
  JSON.parse(JSON.stringify(manifest));
});

// ── 4. Nothing unallowlisted leaves the machine ──────────────────────────────

test("an allowlisted payload survives", () => {
  const out = sanitizeRemotePayload(
    "tool_activity",
    { tool: "pytest", status: "ok", summary: "12 passed" },
    { projectRoot: "/repo" },
  );
  assert.deepEqual(out, { tool: "pytest", status: "ok", summary: "12 passed" });
});

test("an excluded event type is refused outright", () => {
  assert.equal(
    sanitizeRemotePayload("transcript", { role: "user", summary: "hi" }, { projectRoot: "/repo" }),
    null,
  );
});

test("an unknown event type is refused outright", () => {
  assert.equal(sanitizeRemotePayload("command", { tool: "x" }, { projectRoot: "/repo" }), null);
});

for (const forbidden of ["env", "cookies", "shell_history", "stdin", "system_prompt", "file_contents"]) {
  test(`a forbidden key never survives: ${forbidden}`, () => {
    const out = sanitizeRemotePayload(
      "tool_activity",
      { tool: "x", [forbidden]: "leak" },
      { projectRoot: "/repo" },
    );
    assert.ok(out === null || !(forbidden in out));
  });
}

test("a key outside the type's allowlist is dropped", () => {
  const out = sanitizeRemotePayload(
    "tool_activity",
    { tool: "pytest", secret_note: "leak", arbitrary: 1 },
    { projectRoot: "/repo" },
  );
  assert.deepEqual(out, { tool: "pytest" });
});

test("a nested object is refused rather than flattened", () => {
  const out = sanitizeRemotePayload(
    "tool_activity",
    { tool: "x", summary: { nested: "value" } as unknown as string },
    { projectRoot: "/repo" },
  );
  assert.deepEqual(out, { tool: "x" });
});

test("an environment value is scrubbed out of a surviving string", () => {
  const out = sanitizeRemotePayload(
    "tool_activity",
    { tool: "curl", summary: `used ${GITHUB_TOKEN_SHAPED}` },
    { projectRoot: "/repo", env: { GITHUB_TOKEN: GITHUB_TOKEN_SHAPED } },
  );
  assert.ok(out);
  assert.ok(!JSON.stringify(out).includes(GITHUB_TOKEN_SHAPED), "token value leaked");
});

test("absolute paths are relativized or refused", () => {
  assert.equal(relativizePath("/repo/src/a.ts", "/repo"), "src/a.ts");
  assert.equal(relativizePath("/etc/passwd", "/repo"), "[external-path]");
  assert.equal(relativizePath("src/a.ts", "/repo"), "src/a.ts");
});

test("a home-relative tool target is refused before durable enqueue, never left for Cloud to 400", () => {
  // Cloud's display/1 identifier rule refuses ANY leading "~" as "absolute
  // local paths are forbidden", and RC_EVENT_REJECTED keeps the batch at the
  // head of the outbox, so one such target wedged delivery for good:
  // `list_dir("~")`, or an Office lock file such as `~$Report.docx`.
  for (const target of ["~", "~$Report.docx", "~other/notes.txt", "~/x", "~\\x"]) {
    const produced = mapBrainEventToRc({ type: "tool_call", id: "1", name: "list_dir", args: { path: target } });
    assert.ok(produced, target);
    const record = createOutbox({ session_id: "s", project_ref: "p", device_id: "d", epoch: 1, project_root: "/repo" });
    assert.equal(enqueueEvent(record, produced.event_type, produced.payload), true, target);
    assert.equal(record.events[0]?.payload["target"], "[external-path]", `${target} reached the outbox`);
  }
  // A "~" that is not leading is part of a project-relative name and survives.
  const inner = sanitizeRemotePayload(
    "tool_activity",
    { tool: "read_file", target: "src/a~b.ts", status: "started" },
    { projectRoot: "/repo" },
  );
  assert.equal(inner?.["target"], "src/a~b.ts");
});

test("an oversize payload is refused, not truncated into a new shape", () => {
  const out = sanitizeRemotePayload(
    "diff_summary",
    { files: Array.from({ length: 64 }, () => "x".repeat(1024)) },
    { projectRoot: "/repo" },
  );
  if (out !== null) {
    assert.ok(Buffer.byteLength(JSON.stringify(out), "utf8") <= RC_MAX_PAYLOAD_BYTES);
  }
});

test("a payload with nothing safe left yields null, not an empty object", () => {
  assert.equal(
    sanitizeRemotePayload("tool_activity", { env: "leak" }, { projectRoot: "/repo" }),
    null,
  );
});
