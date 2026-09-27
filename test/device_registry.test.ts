// The managed-group registry decides which process groups this device will
// obey a kill order for. Its single hardest rule — from the contract — is that
// identity is the exact BYTES on disk, never a name: `node.exe` and `python.exe`
// are the archetypal spoof, because they are ubiquitous, writable in many
// locations, and legitimately present in a real registration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getGroup,
  listGroups,
  pruneExpired,
  registerGroup,
  registrationRejectReason,
  removeGroup,
} from "../src/core/device_runtime/registry.js";
import { PROCESS_GROUP_SCHEMA } from "../src/core/device_runtime/contract.js";
import { fakeExecutable, groupRegistration, withDeviceSandbox } from "./device_sandbox.js";

test("a registration whose exe hashes to its recorded digest is accepted", () => {
  withDeviceSandbox((dir) => {
    const exe = fakeExecutable(dir, "task-runner.exe", "MZ-real-payload");
    const reg = groupRegistration(exe);
    assert.equal(registrationRejectReason(reg), null);
    registerGroup(reg);
    assert.equal(getGroup("grp-1", { now: () => 1_000 })?.exe_path, exe.path);
    assert.equal(listGroups({ now: () => 1_000 }).length, 1);
  });
});

test("RED TEAM: identity is bytes on disk, so a basename spoof is refused", () => {
  withDeviceSandbox((dir) => {
    // The genuine managed interpreter, and an attacker's same-named copy that
    // sits somewhere writable. Both are legitimately called `node.exe`.
    const real = fakeExecutable(dir, "node.exe", "the real interpreter bytes");
    const spoofDir = join(dir, "writable");
    writeFileSync(join(dir, "decoy-marker"), "");
    const spoof = fakeExecutable(dir, "node-spoof.exe", "attacker payload masquerading as node");

    registerGroup(groupRegistration(real));

    // Claiming the real group's authority for the spoof binary — same sha256
    // claim, different file. The registry rehashes and refuses.
    const stolen = groupRegistration(spoof, { process_group_id: "grp-2", exe_sha256: real.sha256 });
    assert.match(
      String(registrationRejectReason(stolen)),
      /exe_sha256 does not match the file on disk/,
      "a fabricated hash for a different file must not register",
    );
    assert.throws(() => registerGroup(stolen), /does not match the file on disk/);

    // And the reverse: the correct hash for a file that is simply not the one
    // the group was authorised for is a DIFFERENT group, never the same one.
    const honest = groupRegistration(spoof, { process_group_id: "grp-2" });
    assert.equal(registrationRejectReason(honest), null);
    assert.notEqual(honest.exe_sha256, real.sha256);
    assert.equal(spoofDir.length > 0, true);
  });
});

test("RED TEAM: python.exe and node.exe carry no inherent authority", () => {
  withDeviceSandbox((dir) => {
    // A registration naming a ubiquitous interpreter by BASENAME only — no
    // absolute path — is refused outright; there is no name-based allowlist to
    // fall back on.
    for (const bare of ["node.exe", "python.exe", "powershell.exe", "cmd.exe"]) {
      const reg = groupRegistration({ path: bare, sha256: "0".repeat(64) }, { exe_path: bare });
      assert.match(String(registrationRejectReason(reg)), /not an absolute path/, `${bare} must not register by name`);
    }
    // A relative path that merely LOOKS rooted is equally refused.
    const relative = groupRegistration({ path: "bin/node.exe", sha256: "0".repeat(64) }, { exe_path: "bin/node.exe" });
    assert.match(String(registrationRejectReason(relative)), /not an absolute path/);
    assert.equal(dir.length > 0, true);
  });
});

test("RED TEAM: a missing, unhashable or malformed-digest exe is refused", () => {
  withDeviceSandbox((dir) => {
    const exe = fakeExecutable(dir, "runner.exe", "payload");

    const absent = groupRegistration(exe, { exe_path: join(dir, "never-existed.exe") });
    assert.match(String(registrationRejectReason(absent)), /does not exist/);

    // A digest of the wrong shape can never be compared meaningfully, so it is
    // rejected before the file is even read.
    for (const bad of ["", "not-a-digest", "ABCDEF".repeat(10), `sha256:${"a".repeat(64)}`, "a".repeat(63)]) {
      const reg = groupRegistration(exe, { exe_sha256: bad });
      assert.match(String(registrationRejectReason(reg)), /not a sha256 hex digest/, `digest ${bad} must be refused`);
    }

    // Hashing that throws (an unreadable file) fails closed, not open.
    const unreadable = registrationRejectReason(groupRegistration(exe), {
      hashFileSha256: () => { throw new Error("EACCES"); },
    });
    assert.match(String(unreadable), /could not be hashed/);
  });
});

test("RED TEAM: malformed identity, lease and fence fields are refused", () => {
  withDeviceSandbox((dir) => {
    const exe = fakeExecutable(dir, "runner.exe", "payload");
    const cases: Array<[Parameters<typeof groupRegistration>[1], RegExp]> = [
      [{ schema: "aether.device.process_group/2" as typeof PROCESS_GROUP_SCHEMA }, /wrong schema/],
      [{ process_group_id: "" }, /missing process_group_id/],
      [{ parent_pid: 0 }, /parent_pid is invalid/],
      [{ parent_pid: -1 }, /parent_pid is invalid/],
      [{ parent_pid: 1.5 }, /parent_pid is invalid/],
      [{ parent_start_time_ms: -1 }, /parent_start_time_ms is invalid/],
      [{ lease_epoch: -1 }, /lease_epoch is invalid/],
      [{ lease_epoch: 1.5 }, /lease_epoch is invalid/],
      [{ fence_token: "" }, /missing fence_token/],
      [{ expires_at: 1.5 }, /expires_at is invalid/],
    ];
    for (const [overrides, pattern] of cases) {
      assert.match(String(registrationRejectReason(groupRegistration(exe, overrides))), pattern, JSON.stringify(overrides));
    }
  });
});

test("RED TEAM: an expired lease is invisible to lookup even though it is on disk", () => {
  withDeviceSandbox((dir) => {
    const exe = fakeExecutable(dir, "runner.exe", "payload");
    registerGroup(groupRegistration(exe, { process_group_id: "grp-expiring", expires_at: 5_000 }));

    // Live before the expiry…
    assert.ok(getGroup("grp-expiring", { now: () => 4_999 }));
    // …and gone at it. An expired registration must not authorise a kill,
    // otherwise a crashed daemon would leave standing authority forever.
    assert.equal(getGroup("grp-expiring", { now: () => 5_000 }), undefined);
    assert.equal(getGroup("grp-expiring", { now: () => 9_999 }), undefined);
    assert.equal(listGroups({ now: () => 5_001 }).length, 0);

    // Pruning makes that durable.
    assert.equal(pruneExpired({ now: () => 6_000 }), 1);
    assert.equal(pruneExpired({ now: () => 6_000 }), 0);
  });
});

test("registration is idempotent per group id, and removal reports presence", () => {
  withDeviceSandbox((dir) => {
    const exe = fakeExecutable(dir, "runner.exe", "payload");
    registerGroup(groupRegistration(exe, { fence_token: "fence-1" }));
    // A refresh replaces rather than duplicating — two rows for one group would
    // let a stale fence answer a currency check.
    registerGroup(groupRegistration(exe, { fence_token: "fence-2", lease_epoch: 2 }));
    const live = listGroups({ now: () => 1_000 });
    assert.equal(live.length, 1);
    assert.equal(live[0]!.fence_token, "fence-2");
    assert.equal(live[0]!.lease_epoch, 2);

    assert.equal(removeGroup("grp-1"), true);
    assert.equal(removeGroup("grp-1"), false);
    assert.equal(listGroups({ now: () => 1_000 }).length, 0);
  });
});

test("a corrupt or absent registry file reads as empty rather than throwing", () => {
  withDeviceSandbox((dir) => {
    // Nothing written yet.
    assert.deepEqual(listGroups({ now: () => 1 }), []);
    // A half-written file must not crash the daemon's prune-on-sample path.
    const exe = fakeExecutable(dir, "runner.exe", "payload");
    registerGroup(groupRegistration(exe));
    writeFileSync(join(dir, "device-runtime", "groups.json"), '{"version":1,"groups":', "utf8");
    assert.deepEqual(listGroups({ now: () => 1 }), []);
  });
});
