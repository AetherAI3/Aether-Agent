// Device identity holds the only long-lived secret on the machine (the device
// token and the command key) plus the per-boot sequence the Cloud uses to
// reject replays. Two properties matter here: the secret file is written with
// the same hardening as the CLI's `.token`, and the boot sequence never repeats
// within a boot — not even across a daemon restart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearEnrollment,
  currentBootState,
  loadEnrollment,
  nextBootSeq,
  parseEnrollment,
  resolveBootIdentity,
  saveEnrollment,
  type EnrollmentRecord,
} from "../src/core/device_runtime/identity.js";
import { enrollmentPath } from "../src/core/device_runtime/paths.js";
import { withDeviceSandbox } from "./device_sandbox.js";

function record(overrides: Partial<EnrollmentRecord> = {}): EnrollmentRecord {
  return {
    device_id: "dev_test_0001",
    device_token: "dt_abcdefghijklmnop",
    device_command_key: "dck_0123456789abcdef",
    display_name: "workstation",
    base_url: "https://api.example.test",
    enrolled_at: 1_700_000_000_000,
    ...overrides,
  };
}

test("the enrollment record round-trips and is written owner-only", () => {
  withDeviceSandbox(() => {
    saveEnrollment(record());
    const loaded = loadEnrollment();
    assert.deepEqual(loaded, record());

    const stat = statSync(enrollmentPath());
    assert.ok(stat.isFile(), "the enrollment record must be a regular file");
    if (process.platform === "win32") {
      // Node maps only the read-only attribute onto st_mode on Windows, so the
      // reported mode is always 0666 and asserting 0600 here would be asserting
      // a fiction. Access control on this file is the 0700 config directory's
      // ACL; what IS meaningful cross-platform is that the write went through
      // O_EXCL|O_NOFOLLOW to a regular file, which the symlink test covers.
      return;
    }
    assert.equal(stat.mode & 0o077, 0, `device.json is group/world accessible: ${(stat.mode & 0o777).toString(8)}`);
  });
});

test("a planted symlink at the enrollment path is refused, not written through", () => {
  withDeviceSandbox((dir) => {
    const target = join(dir, "attacker-readable.json");
    writeFileSync(target, "{}", "utf8");
    try {
      symlinkSync(target, enrollmentPath());
    } catch {
      // Unprivileged Windows cannot create symlinks; nothing to assert there.
      return;
    }
    // Writing through the link would deposit the device token and command key
    // at a path the attacker chose — the classic symlink-swap on a secret file.
    assert.throws(() => saveEnrollment(record()), /symlink or reparse point/);
    assert.equal(readFileSync(target, "utf8"), "{}", "the link target must be untouched");
    // Reading through one is refused too, so a planted link cannot feed the
    // daemon an attacker-chosen device identity.
    assert.equal(loadEnrollment(), null);
  });
});

test("no temp file is left behind by a successful write", () => {
  withDeviceSandbox((dir) => {
    saveEnrollment(record());
    saveEnrollment(record({ device_id: "dev_test_0002" }));
    assert.equal(loadEnrollment()?.device_id, "dev_test_0002");
    // A leaked `.tmp` would be a second copy of the command key on disk.
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftovers, [], `temp files left behind: ${leftovers.join(",")}`);
  });
});

test("a partial or malformed enrollment parses as null rather than half-usable", () => {
  // A record missing its command key cannot verify a single command, so
  // returning a partially-populated object would only defer the failure to the
  // first signature check — with the daemon already running and enrolled.
  assert.equal(parseEnrollment(null), null);
  assert.equal(parseEnrollment("string"), null);
  assert.equal(parseEnrollment([]), null);
  assert.equal(parseEnrollment({}), null);
  assert.equal(parseEnrollment({ ...record(), device_command_key: "" }), null);
  assert.equal(parseEnrollment({ ...record(), device_token: undefined }), null);
  assert.equal(parseEnrollment({ ...record(), device_id: 42 }), null);
  assert.equal(parseEnrollment({ ...record(), base_url: "" }), null);
  assert.deepEqual(parseEnrollment(record()), record());
});

test("an absent or corrupt enrollment file reads as unenrolled", () => {
  withDeviceSandbox(() => {
    assert.equal(loadEnrollment(), null);
    writeFileSync(enrollmentPath(), "{not json", "utf8");
    assert.equal(loadEnrollment(), null);
    writeFileSync(enrollmentPath(), '{"device_id":"only-this"}', "utf8");
    assert.equal(loadEnrollment(), null);
  });
});

test("clearing enrollment removes the secret and is safe to repeat", () => {
  withDeviceSandbox(() => {
    saveEnrollment(record());
    assert.ok(existsSync(enrollmentPath()));
    clearEnrollment();
    assert.equal(existsSync(enrollmentPath()), false);
    // Logging out an already-unenrolled device is not an error.
    assert.doesNotThrow(() => clearEnrollment());
  });
});

test("the same boot keeps its boot_id and sequence across daemon restarts", () => {
  withDeviceSandbox(() => {
    const bootTime = 1_700_000_000_000;
    const first = resolveBootIdentity(bootTime, () => bootTime + 1000);
    assert.equal(first.seq, 0);
    assert.match(first.boot_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    assert.equal(nextBootSeq(), 1);
    assert.equal(nextBootSeq(), 2);

    // A daemon restart within the same boot resolves the SAME identity and the
    // sequence continues — reusing a seq would be indistinguishable from a
    // replay to the Cloud.
    const restarted = resolveBootIdentity(bootTime, () => bootTime + 9999);
    assert.equal(restarted.boot_id, first.boot_id);
    assert.equal(restarted.seq, 2);
    assert.equal(nextBootSeq(), 3);
  });
});

test("sub-second probe jitter does not fabricate a new boot", () => {
  withDeviceSandbox(() => {
    const bootTime = 1_700_000_000_000;
    const first = resolveBootIdentity(bootTime);
    // The os.uptime() fallback derives a boot time that wobbles by a few
    // hundred ms between reads. Treating that as a reboot would reset the
    // sequence on every daemon start and make the Cloud discard the device.
    const jittered = resolveBootIdentity(bootTime + 900);
    assert.equal(jittered.boot_id, first.boot_id);
    const stillSame = resolveBootIdentity(bootTime - 4_999);
    assert.equal(stillSame.boot_id, first.boot_id);
  });
});

test("an actual reboot mints a new boot_id and resets the sequence to 0", () => {
  withDeviceSandbox(() => {
    const first = resolveBootIdentity(1_700_000_000_000);
    assert.equal(nextBootSeq(), 1);
    assert.equal(nextBootSeq(), 2);

    // Well past the tolerance: a real reboot.
    const second = resolveBootIdentity(1_700_000_600_000);
    assert.notEqual(second.boot_id, first.boot_id);
    assert.equal(second.seq, 0);
    assert.equal(nextBootSeq(), 1, "a new boot restarts the sequence at 1");
  });
});

test("an unavailable boot probe keeps the prior identity instead of inventing one", () => {
  withDeviceSandbox(() => {
    const first = resolveBootIdentity(1_700_000_000_000);
    assert.equal(nextBootSeq(), 1);
    // The probe failed (a hung PowerShell, a locked-down host). Minting a fresh
    // boot_id here would look like a reboot and throw away the sequence for no
    // reason; keeping the prior identity is the conservative choice.
    const degraded = resolveBootIdentity(null);
    assert.equal(degraded.boot_id, first.boot_id);
    assert.equal(degraded.seq, 1);
  });
});

test("a failed probe on a device with no prior state still yields a usable identity", () => {
  withDeviceSandbox(() => {
    const minted = resolveBootIdentity(null, () => 1_234_567);
    assert.equal(minted.seq, 0);
    assert.ok(minted.boot_id.length > 0);
    assert.equal(currentBootState()?.boot_id, minted.boot_id);
    assert.equal(nextBootSeq(), 1);
  });
});

test("advancing the sequence before the boot identity exists is refused", () => {
  withDeviceSandbox(() => {
    // Publishing a frame with no boot identity would carry a seq the Cloud
    // cannot order against any boot_id.
    assert.throws(() => nextBootSeq(), /before the boot identity is resolved/);
  });
});

test("a corrupt boot-state file is treated as absent, not as seq 0 of the same boot", () => {
  withDeviceSandbox((dir) => {
    resolveBootIdentity(1_700_000_000_000);
    assert.equal(nextBootSeq(), 1);
    writeFileSync(join(dir, "device-runtime", "boot.json"), '{"boot_id":"x","seq":-4}', "utf8");
    // A negative sequence is not salvageable; a fresh boot identity is minted
    // rather than resuming a counter the Cloud may already have seen.
    const recovered = resolveBootIdentity(1_700_000_000_000);
    assert.equal(recovered.seq, 0);
    assert.equal(nextBootSeq(), 1);
  });
});
