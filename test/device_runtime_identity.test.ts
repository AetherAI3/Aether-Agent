import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
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

function withConfigDir<T>(body: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "aether-dev-id-"));
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

const RECORD: EnrollmentRecord = {
  device_id: "dev-xyz",
  device_token: "tok-abc",
  device_command_key: "key-123",
  display_name: "host",
  base_url: "https://api.example.test/cloud",
  enrolled_at: 1_700_000_000_000,
};

test("enrollment round-trips and rejects incomplete records", () => {
  withConfigDir(() => {
    assert.equal(loadEnrollment(), null);
    saveEnrollment(RECORD);
    assert.deepEqual(loadEnrollment(), RECORD);
    clearEnrollment();
    assert.equal(loadEnrollment(), null);
  });
  assert.equal(parseEnrollment({ device_id: "x" }), null);
  assert.equal(parseEnrollment("nope"), null);
  assert.deepEqual(parseEnrollment(RECORD), RECORD);
});

test("enrollment file is written owner-only (0600) on POSIX", { skip: process.platform === "win32" }, () => {
  withConfigDir(() => {
    saveEnrollment(RECORD);
    const mode = statSync(join(process.env["AETHER_CONFIG_DIR"]!, "device.json")).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test("boot identity is stable within a boot and re-minted on a new boot", () => {
  withConfigDir(() => {
    const a = resolveBootIdentity(1000);
    assert.equal(a.seq, 0);
    // Same boot time (within tolerance) keeps the same boot_id.
    const b = resolveBootIdentity(1000);
    assert.equal(b.boot_id, a.boot_id);
    const jittered = resolveBootIdentity(1000 + 3000); // inside default 5s tolerance
    assert.equal(jittered.boot_id, a.boot_id);
    // A clearly different boot time mints a fresh boot_id and resets the sequence.
    const c = resolveBootIdentity(1_000_000);
    assert.notEqual(c.boot_id, a.boot_id);
    assert.equal(c.seq, 0);
  });
});

test("a null probe keeps the prior boot identity", () => {
  withConfigDir(() => {
    const a = resolveBootIdentity(5000);
    const b = resolveBootIdentity(null);
    assert.equal(b.boot_id, a.boot_id);
  });
});

test("nextBootSeq is monotonic and starts at 1", () => {
  withConfigDir(() => {
    resolveBootIdentity(2000);
    assert.equal(nextBootSeq(), 1);
    assert.equal(nextBootSeq(), 2);
    assert.equal(nextBootSeq(), 3);
    assert.equal(currentBootState()?.seq, 3);
    // A new boot resets the sequence to start again at 1.
    resolveBootIdentity(9_000_000);
    assert.equal(nextBootSeq(), 1);
  });
});
