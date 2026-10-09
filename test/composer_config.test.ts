import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("LF submit compatibility can be explicitly enabled and disabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-lf-setting-"));
  const cli = resolve("dist", "src", "main.js");
  try {
    for (const value of ["true", "false"]) {
      const result = spawnSync(process.execPath, [cli, "config", "set", "lfSubmits", value], {
        encoding: "utf8", env: { ...process.env, AETHER_CONFIG_DIR: dir }, timeout: 5_000,
      });
      assert.equal(result.status, 0, String(result.stderr));
      const saved = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as { lfSubmits: boolean };
      assert.equal(saved.lfSubmits, value === "true");
    }
    const invalid = spawnSync(process.execPath, [cli, "config", "set", "lfSubmits", "maybe"], {
      encoding: "utf8", env: { ...process.env, AETHER_CONFIG_DIR: dir }, timeout: 5_000,
    });
    assert.equal(invalid.status, 2);
    assert.match(String(invalid.stderr), /lfSubmits must be true or false/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
