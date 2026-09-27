import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REMAINING_SUMMARY,
  fromPortableHandoff,
  toWorkspaceHandoffV1,
  workspaceHandoffRejectReason,
  type HandoffLaneIdentity,
  type WorkspaceHandoffInput,
} from "../src/core/device_runtime/handoff_adapter.js";
import { WORKSPACE_HANDOFF_SCHEMA } from "../src/core/device_runtime/contract.js";
import { HANDOFF_KIND, HANDOFF_SCHEMA_VERSION, type Handoff } from "../src/core/handoff.js";

function input(overrides: Partial<WorkspaceHandoffInput> = {}): WorkspaceHandoffInput {
  return {
    handoff_id: "ho-1",
    task_id: "task-1",
    lane_id: "lane-1",
    dag_node_id: "node-1",
    fence_token: "fence-1",
    lease_epoch: 2,
    repo: { name: "aether-agent", revision: "abc123" },
    patch_refs: [{ ref: "refs/aether/patch-1", sha256: "c".repeat(64), bytes: 42 }],
    change_digest: "sha256:" + "d".repeat(64),
    test_cmd: "npm test",
    test_verified: true,
    remaining_summary: "Finish wiring the publisher and add tests.",
    policy_digest: "sha256:" + "e".repeat(64),
    skill_digest: null,
    protocol_c_refs: ["proof-1"],
    source_device_id: "dev-1",
    created_at: 1000,
    ...overrides,
  };
}

test("a clean handoff is accepted and carries the frozen schema", () => {
  const h = toWorkspaceHandoffV1(input());
  assert.equal(h.schema, WORKSPACE_HANDOFF_SCHEMA);
  assert.equal(h.task_id, "task-1");
  assert.equal(workspaceHandoffRejectReason(h), null);
});

test("an absolute path anywhere is rejected", () => {
  const win = input({ remaining_summary: "see C:\\Users\\me\\secret.txt" });
  assert.throws(() => toWorkspaceHandoffV1(win), /absolute path/);
  const posix = input({ remaining_summary: "edit /etc/passwd next" });
  assert.throws(() => toWorkspaceHandoffV1(posix), /absolute path/);
});

test("an environment-variable reference is rejected", () => {
  assert.throws(() => toWorkspaceHandoffV1(input({ remaining_summary: "use $HOME/config" })), /environment-variable/);
  assert.throws(() => toWorkspaceHandoffV1(input({ remaining_summary: "read %USERPROFILE% dir" })), /environment-variable/);
});

test("credential-shaped content is rejected", () => {
  const jwt = "eyJhbGciOi.eyJzdWIiOi.SflKxwRJ";
  assert.throws(() => toWorkspaceHandoffV1(input({ remaining_summary: `token ${jwt}` })), /credential/);
});

test("an oversized remaining_summary is rejected", () => {
  const big = "x".repeat(MAX_REMAINING_SUMMARY + 1);
  assert.throws(() => toWorkspaceHandoffV1(input({ remaining_summary: big })), /exceeds its bound/);
});

test("a bad patch-ref digest is rejected", () => {
  assert.throws(
    () => toWorkspaceHandoffV1(input({ patch_refs: [{ ref: "r", sha256: "nothex", bytes: 1 }] })),
    /not a digest/,
  );
});

// ── Adapting the repo's existing portable handoff ───────────────────────────

const IDS: HandoffLaneIdentity = {
  handoff_id: "ho-2",
  task_id: "task-2",
  lane_id: "lane-2",
  dag_node_id: "node-2",
  fence_token: "fence-2",
  lease_epoch: 3,
  policy_digest: "sha256:" + "b".repeat(64),
  source_device_id: "dev-2",
  created_at: 2000,
};

function portable(overrides: Partial<Handoff> = {}): Handoff {
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    kind: HANDOFF_KIND,
    sessionId: "2026-08-28-cloud-1234",
    task: "wire the device daemon",
    model: "",
    brain: "cloud",
    started: "2026-08-28T12:00:00.000Z",
    ended: "2026-08-28T12:30:00.000Z",
    finalStatus: "ok",
    repo: { remote: "https://github.com/AetherAI3/aether-agent.git", branch: "main", head: "f".repeat(40) },
    highlights: ["wrote the publisher", "ran the tests"],
    filesTouched: ["src/core/device_runtime/daemon.ts", "test/device_runtime_daemon.test.ts"],
    testCmd: "npm test",
    ...overrides,
  };
}

test("a portable session handoff projects onto the frozen wire shape", () => {
  const h = fromPortableHandoff(portable(), IDS);
  assert.equal(h.schema, WORKSPACE_HANDOFF_SCHEMA);
  assert.equal(h.task_id, "task-2");
  assert.equal(h.repo.name, "AetherAI3/aether-agent");
  assert.equal(h.repo.revision, "f".repeat(40));
  assert.equal(h.test_cmd, "npm test");
  assert.equal(h.test_verified, true);
  assert.match(h.change_digest, /^sha256:[0-9a-f]{64}$/);
});

test("the projection DROPS narration, prompts and touched paths", () => {
  const h = fromPortableHandoff(portable(), IDS);
  const wire = JSON.stringify(h);
  assert.equal(wire.includes("wire the device daemon"), false, "the operator's prompt must not travel");
  assert.equal(wire.includes("wrote the publisher"), false, "narration must not travel");
  assert.equal(wire.includes("daemon.ts"), false, "touched file paths must not travel");
  assert.equal(wire.includes("2026-08-28-cloud-1234"), false, "the session id must not travel");
  // The change is still identifiable — by digest, not by name.
  const same = fromPortableHandoff(portable(), IDS);
  const different = fromPortableHandoff(portable({ filesTouched: ["src/other.ts"] }), IDS);
  assert.equal(h.change_digest, same.change_digest);
  assert.notEqual(h.change_digest, different.change_digest);
});

test("a CREDENTIAL-bearing remote never reaches the wire", () => {
  const h = fromPortableHandoff(
    portable({
      repo: {
        remote: "https://user:ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/AetherAI3/aether-agent.git",
        head: "f".repeat(40),
      },
    }),
    IDS,
  );
  assert.equal(h.repo.name, "AetherAI3/aether-agent");
  assert.equal(JSON.stringify(h).includes("ghp_"), false);
});

test("a not-green prior run reports remaining work in counts, not narration", () => {
  const h = fromPortableHandoff(portable({ finalStatus: "tests-failed", remaining: 3 }), IDS);
  assert.equal(h.test_verified, false);
  assert.match(h.remaining_summary, /tests-failed/);
  assert.match(h.remaining_summary, /3 failing test\(s\)/);
  assert.match(h.remaining_summary, /2 file\(s\) changed/);
});

test("skill digests collapse to one digest; no skill content travels", () => {
  const withSkills = fromPortableHandoff(
    portable({
      context: {
        skills: [{ id: "s1", version: "1", digest: "sha256:" + "1".repeat(64), invocation: "auto", trust: "t", lock: "l" }],
        instructionSources: ["C:\\Users\\me\\project\\CLAUDE.md"],
        instructionGraphDigest: "sha256:" + "2".repeat(64),
        conflicts: [],
      },
    }),
    IDS,
  );
  assert.match(withSkills.skill_digest ?? "", /^sha256:[0-9a-f]{64}$/);
  // The instruction SOURCE paths are absolute; they must not have travelled.
  assert.equal(JSON.stringify(withSkills).includes("C:\\"), false);
  assert.equal(JSON.stringify(withSkills).includes("CLAUDE.md"), false);
  assert.equal(fromPortableHandoff(portable(), IDS).skill_digest, null);
});

test("a projection that WOULD leak is rejected, not sanitized", () => {
  // A test command that names an absolute path is one of the few free-text
  // fields that survives the projection — and it fails the validator.
  assert.throws(
    () => fromPortableHandoff(portable({ testCmd: "node C:\\tools\\runner.js" }), IDS),
    /refusing to emit workspace handoff/,
  );
  assert.throws(
    () => fromPortableHandoff(portable({ testCmd: "npm test --token=$GITHUB_TOKEN" }), IDS),
    /environment-variable/,
  );
});
