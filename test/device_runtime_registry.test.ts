import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getGroup,
  listGroups,
  pruneExpired,
  registerGroup,
  registrationRejectReason,
  removeGroup,
  type RegistryDeps,
} from "../src/core/device_runtime/registry.js";
import { PROCESS_GROUP_SCHEMA, type ProcessGroupRegistration } from "../src/core/device_runtime/contract.js";

function withConfigDir<T>(body: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "aether-dev-reg-"));
  const prior = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = dir;
  try {
    return body();
  } finally {
    if (prior === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = prior;
    rmSync(dir, { recursive: true, force: true });
  }
}

const ABS = process.platform === "win32" ? "C:\\real\\node.exe" : "/real/node";
const SHA = "a".repeat(64);

function reg(overrides: Partial<ProcessGroupRegistration> = {}): ProcessGroupRegistration {
  return {
    schema: PROCESS_GROUP_SCHEMA,
    process_group_id: "grp-1",
    device_id: "dev-1",
    owner: "op",
    project: "proj",
    workspace_id: "ws",
    task_id: "task",
    exe_path: ABS,
    exe_sha256: SHA,
    trusted_publisher: null,
    parent_pid: 1234,
    parent_start_time_ms: 111,
    job_object_name: "aether-dev-grp-1",
    command_classes: ["throttle"],
    lease_epoch: 1,
    fence_token: "fence-1",
    expires_at: 10_000,
    policy_digest: "sha256:" + "0".repeat(64),
    registered_at: 0,
    ...overrides,
  };
}

const okDeps: RegistryDeps = { hashFileSha256: () => SHA, fileExists: () => true, now: () => 0 };

test("a valid registration is accepted", () => {
  assert.equal(registrationRejectReason(reg(), okDeps), null);
});

test("NEVER allowlist by basename: a non-absolute exe_path is rejected", () => {
  assert.match(registrationRejectReason(reg({ exe_path: "node.exe" }), okDeps) ?? "", /absolute/);
});

test("a missing exe file is rejected", () => {
  assert.match(
    registrationRejectReason(reg(), { ...okDeps, fileExists: () => false }) ?? "",
    /does not exist/,
  );
});

test("basename spoof: a sha256 that does not match the file on disk is rejected", () => {
  assert.match(
    registrationRejectReason(reg({ exe_sha256: "b".repeat(64) }), okDeps) ?? "",
    /does not match/,
  );
});

test("register / get / remove round-trip with expiry filtering", () => {
  withConfigDir(() => {
    registerGroup(reg({ expires_at: 10_000 }), okDeps);
    assert.equal(getGroup("grp-1", { now: () => 0 })?.process_group_id, "grp-1");
    // Expired groups are not returned.
    assert.equal(getGroup("grp-1", { now: () => 20_000 }), undefined);
    assert.equal(listGroups({ now: () => 0 }).length, 1);
    assert.equal(removeGroup("grp-1"), true);
    assert.equal(getGroup("grp-1", { now: () => 0 }), undefined);
  });
});

test("pruneExpired drops only past-expiry registrations", () => {
  withConfigDir(() => {
    registerGroup(reg({ process_group_id: "live", expires_at: 100_000 }), okDeps);
    registerGroup(reg({ process_group_id: "dead", expires_at: 5 }), okDeps);
    const removed = pruneExpired({ now: () => 10_000 });
    assert.equal(removed, 1);
    assert.equal(listGroups({ now: () => 10_000 }).map((g) => g.process_group_id).sort().join(","), "live");
  });
});

test("registerGroup throws on an invalid registration", () => {
  withConfigDir(() => {
    assert.throws(() => registerGroup(reg({ exe_path: "relative" }), okDeps), /refusing/);
  });
});
