import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// main() runs at module load, so exercise the built CLI entry point.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function runConfigSet(dir: string) {
  return spawnSync(
    process.execPath,
    [join(root, "dist", "src", "main.js"), "config", "set", "defaultEffort", "high"],
    {
      encoding: "utf8",
      timeout: 8000,
      env: {
        ...process.env,
        AETHER_CONFIG_DIR: dir,
        AETHER_BASE_URL: "http://127.0.0.1:9",
        AETHER_NO_ANIM: "1",
        NO_COLOR: "1",
      },
    },
  );
}

test("config set refuses malformed JSON and preserves the exact config bytes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aether-corrupt-config-"));
  const config = join(dir, "config.json");
  const original = Buffer.from("{ invalid json\r\n", "utf8");
  writeFileSync(config, original);

  try {
    const result = runConfigSet(dir);

    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "EPERM") {
      t.skip("sandbox blocks child process spawning");
      return;
    }
    assert.equal(result.error, undefined, `CLI failed to start: ${result.error}`);
    assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.deepEqual(readFileSync(config), original, "config set overwrote the malformed file");
    assert.match(result.stderr, /config\.json/i);
    assert.match(result.stderr, /repair|restore|fix|recover/i);
    assert.doesNotMatch(result.stdout, /defaultEffort\s*→\s*HIGH/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config set refuses a config.json path that cannot be read as a file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aether-unreadable-config-"));
  const config = join(dir, "config.json");
  mkdirSync(config);

  try {
    const result = runConfigSet(dir);
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "EPERM") {
      t.skip("sandbox blocks child process spawning");
      return;
    }
    assert.equal(result.error, undefined, `CLI failed to start: ${result.error}`);
    assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.equal(statSync(config).isDirectory(), true, "the existing config entry was replaced");
    assert.match(result.stderr, /config\.json/i);
    assert.match(result.stderr, /repair|restore|fix|recover|move/i);
    assert.doesNotMatch(result.stdout, /defaultEffort\s*→\s*HIGH/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config set updates a valid config and preserves its baseUrl", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aether-valid-config-"));
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ baseUrl: "https://custom.example/cloud", defaultEffort: "" }));

  try {
    const result = runConfigSet(dir);
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "EPERM") {
      t.skip("sandbox blocks child process spawning");
      return;
    }
    assert.equal(result.error, undefined, `CLI failed to start: ${result.error}`);
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /defaultEffort\s*→\s*HIGH/);
    const saved = JSON.parse(readFileSync(config, "utf8")) as { baseUrl: string; defaultEffort: string };
    assert.equal(saved.baseUrl, "https://custom.example/cloud");
    assert.equal(saved.defaultEffort, "HIGH");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
