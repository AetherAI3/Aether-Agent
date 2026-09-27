// A WorkspaceHandoff is the one payload that deliberately crosses from this
// machine to another, so it is the natural place for a leak. The contract
// forbids it from carrying absolute paths, credentials, env vars, chat history,
// raw tool logs or unbounded diffs — and the validator fails CLOSED: a handoff
// with any of those is REFUSED, not sanitized. Silently dropping a secret the
// caller handed us would leave the caller believing it travelled.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REMAINING_SUMMARY,
  toWorkspaceHandoffV1,
  workspaceHandoffRejectReason,
  type WorkspaceHandoffInput,
} from "../src/core/device_runtime/handoff_adapter.js";
import { WORKSPACE_HANDOFF_SCHEMA } from "../src/core/device_runtime/contract.js";

function input(overrides: Partial<WorkspaceHandoffInput> = {}): WorkspaceHandoffInput {
  return {
    handoff_id: "ho-1",
    task_id: "task-1",
    lane_id: "lane-1",
    dag_node_id: "node-1",
    fence_token: "fence-1",
    lease_epoch: 2,
    repo: { name: "aether-agent", revision: "abc1234" },
    patch_refs: [{ ref: "patch/0001", sha256: "a".repeat(64), bytes: 2048 }],
    change_digest: `sha256:${"b".repeat(64)}`,
    test_cmd: "npm test",
    test_verified: true,
    remaining_summary: "finish the publisher backoff and re-run the suite",
    policy_digest: `sha256:${"c".repeat(64)}`,
    skill_digest: null,
    protocol_c_refs: ["proof/abc"],
    source_device_id: "dev_1",
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

test("a clean handoff is emitted with exactly the contract's shape", () => {
  const handoff = toWorkspaceHandoffV1(input());
  assert.equal(handoff.schema, WORKSPACE_HANDOFF_SCHEMA);
  assert.equal(workspaceHandoffRejectReason(handoff), null);
  assert.equal(handoff.test_verified, true);
  assert.deepEqual(handoff.repo, { name: "aether-agent", revision: "abc1234" });
  assert.deepEqual(handoff.patch_refs, [{ ref: "patch/0001", sha256: "a".repeat(64), bytes: 2048 }]);
  // Arrays are copied, so a later mutation of the caller's input cannot reach
  // a handoff that already passed validation.
  const refs = ["proof/abc"];
  const copied = toWorkspaceHandoffV1(input({ protocol_c_refs: refs }));
  refs.push("proof/injected-after-validation");
  assert.deepEqual(copied.protocol_c_refs, ["proof/abc"]);
});

test("RED TEAM: absolute paths in every spelling are refused", () => {
  const absolutes: Array<[string, string]> = [
    ["windows drive", "see C:\\Users\\dev\\aether\\src for the rest"],
    ["windows drive forward slash", "see C:/Users/dev/aether for the rest"],
    ["unc share", "artifacts landed on \\\\buildserver\\drops"],
    ["posix root", "the fixture lives at /home/dev/aether/test"],
    ["posix usr", "installed to /usr/local/bin"],
    ["home tilde", "config is at ~/.config/aether"],
    ["home tilde windows", "config is at ~\\aether"],
  ];
  for (const [label, text] of absolutes) {
    // remaining_summary is the field most likely to be written by a model.
    assert.match(String(workspaceHandoffRejectReason(buildRaw({ remaining_summary: text }))), /absolute path/, label);
    // …and the constructor refuses rather than emitting a sanitized version.
    assert.throws(() => toWorkspaceHandoffV1(input({ remaining_summary: text })), /absolute path/, label);
  }
  // Every free-text field is covered, not only the summary.
  assert.throws(() => toWorkspaceHandoffV1(input({ test_cmd: "node C:\\tools\\runner.js" })), /absolute path/);
  assert.throws(() => toWorkspaceHandoffV1(input({ repo: { name: "/srv/repos/aether", revision: "abc" } })), /absolute path/);
  assert.throws(
    () => toWorkspaceHandoffV1(input({ patch_refs: [{ ref: "C:\\tmp\\0001.patch", sha256: "a".repeat(64), bytes: 1 }] })),
    /absolute path/,
  );
  assert.throws(() => toWorkspaceHandoffV1(input({ protocol_c_refs: ["/var/proofs/abc"] })), /absolute path/);

  // A RELATIVE path is legitimate and must still pass — the rule is about
  // machine-specific layout, not about mentioning files at all.
  assert.doesNotThrow(() => toWorkspaceHandoffV1(input({ remaining_summary: "finish src/core/publisher.ts and test/publisher.test.ts" })));
});

test("RED TEAM: environment-variable references are refused", () => {
  for (const blob of [
    "run with $AETHER_TOKEN set",
    "run with ${AETHER_TOKEN} set",
    "set %AETHER_TOKEN% first",
    "PATH=$PATH:/opt/bin",
  ]) {
    assert.throws(() => toWorkspaceHandoffV1(input({ remaining_summary: blob })), /environment-variable reference|absolute path/, blob);
  }
  assert.throws(() => toWorkspaceHandoffV1(input({ test_cmd: "npm test -- --token=$CI_TOKEN" })), /environment-variable reference/);
});

test("RED TEAM: credential-shaped content is refused", () => {
  const secrets = [
    "resume after refreshing Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh.signature",
    "auth with Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "clone from https://user:hunter2@github.com/acme/repo",
    `device_command_key=${"a1b2c3d4".repeat(8)}`,
  ];
  for (const secret of secrets) {
    assert.throws(
      () => toWorkspaceHandoffV1(input({ remaining_summary: secret })),
      /credential-shaped content/,
      `secret must be refused: ${secret.slice(0, 40)}`,
    );
  }
});

test("RED TEAM: oversized fields are refused rather than truncated", () => {
  // Truncating would silently change the meaning of a continuation record.
  assert.throws(
    () => toWorkspaceHandoffV1(input({ remaining_summary: "a".repeat(MAX_REMAINING_SUMMARY + 1) })),
    /remaining_summary exceeds its bound/,
  );
  assert.doesNotThrow(() => toWorkspaceHandoffV1(input({ remaining_summary: "a".repeat(MAX_REMAINING_SUMMARY) })));

  assert.throws(() => toWorkspaceHandoffV1(input({ task_id: "t".repeat(257) })), /identifier field exceeds its bound/);
  assert.throws(() => toWorkspaceHandoffV1(input({ test_cmd: "n".repeat(513) })), /test_cmd exceeds its bound/);
  assert.throws(() => toWorkspaceHandoffV1(input({ repo: { name: "n".repeat(513), revision: "abc" } })), /repo field exceeds its bound/);

  const many = Array.from({ length: 65 }, (_, i) => ({ ref: `patch/${i}`, sha256: "a".repeat(64), bytes: 1 }));
  assert.throws(() => toWorkspaceHandoffV1(input({ patch_refs: many })), /too many patch_refs/);
  assert.throws(() => toWorkspaceHandoffV1(input({ protocol_c_refs: Array.from({ length: 65 }, (_, i) => `p${i}`) })), /too many protocol_c_refs/);
  assert.throws(() => toWorkspaceHandoffV1(input({ protocol_c_refs: ["p".repeat(513)] })), /protocol_c ref exceeds its bound/);
});

test("RED TEAM: patch refs must be digests and byte counts, not inline diffs", () => {
  // A handoff carries REFERENCES to patches. An unbounded diff pasted into a
  // ref is exactly the "unbounded file body" the contract forbids.
  assert.throws(
    () => toWorkspaceHandoffV1(input({ patch_refs: [{ ref: "patch/1", sha256: "not-a-digest", bytes: 1 }] })),
    /patch ref sha256 is not a digest/,
  );
  assert.throws(
    () => toWorkspaceHandoffV1(input({ patch_refs: [{ ref: "patch/1", sha256: "a".repeat(64), bytes: -1 }] })),
    /patch ref byte count is invalid/,
  );
  assert.throws(
    () => toWorkspaceHandoffV1(input({ patch_refs: [{ ref: "patch/1", sha256: "a".repeat(64), bytes: 1.5 }] })),
    /patch ref byte count is invalid/,
  );
});

test("a wrong schema is refused even if every other field is clean", () => {
  const handoff = toWorkspaceHandoffV1(input());
  assert.match(
    String(workspaceHandoffRejectReason({ ...handoff, schema: "aether.workspace-handoff/2" as typeof WORKSPACE_HANDOFF_SCHEMA })),
    /wrong schema/,
  );
});

/** Build the wire object without running the constructor's validation, so a
 *  rejection reason can be inspected directly. */
function buildRaw(overrides: Partial<WorkspaceHandoffInput>): Parameters<typeof workspaceHandoffRejectReason>[0] {
  const i = input(overrides);
  return {
    schema: WORKSPACE_HANDOFF_SCHEMA,
    handoff_id: i.handoff_id,
    task_id: i.task_id,
    lane_id: i.lane_id,
    dag_node_id: i.dag_node_id,
    fence_token: i.fence_token,
    lease_epoch: i.lease_epoch,
    repo: i.repo,
    patch_refs: i.patch_refs,
    change_digest: i.change_digest,
    test_cmd: i.test_cmd,
    test_verified: i.test_verified,
    remaining_summary: i.remaining_summary,
    policy_digest: i.policy_digest,
    skill_digest: i.skill_digest,
    protocol_c_refs: i.protocol_c_refs,
    created_at: i.created_at,
    source_device_id: i.source_device_id,
  };
}
