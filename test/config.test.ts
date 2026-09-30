import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aether-cfg-"));
  process.env["AETHER_CONFIG_DIR"] = dir;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env["AETHER_CONFIG_DIR"];
});

test("loadConfig returns defaults when no file exists", async () => {
  const { loadConfig, DEFAULT_CONFIG } = await import("../src/core/config.js");
  const cfg = loadConfig();
  assert.equal(cfg.permissionMode, DEFAULT_CONFIG.permissionMode);
  assert.equal(cfg.autoApply, false);
});

test("saveConfig then loadConfig round-trips", async () => {
  const { loadConfig, saveConfig, DEFAULT_CONFIG } = await import("../src/core/config.js");
  saveConfig({ ...DEFAULT_CONFIG, defaultModel: "claude-opus-4-8", permissionMode: "skip" });
  const cfg = loadConfig();
  assert.equal(cfg.defaultModel, "claude-opus-4-8");
  assert.equal(cfg.permissionMode, "skip");
});

test("legacy namespaced local selection migrates out of the hosted default in memory", async () => {
  const { loadConfig, saveConfig, DEFAULT_CONFIG } = await import("../src/core/config.js");
  saveConfig({ ...DEFAULT_CONFIG, defaultModel: "ollama:gemma3:4b", localModel: "" });
  const cfg = loadConfig();
  assert.equal(cfg.defaultModel, "");
  assert.equal(cfg.localModel, "ollama:gemma3:4b");
});

// The env override must never leak into the persisted file: load-with-env
// then save (what /effort and `models use` do) must keep the file's baseUrl.
test("saveConfig does not persist the AETHER_BASE_URL override", async () => {
  const { loadConfig, saveConfig, DEFAULT_CONFIG } = await import("../src/core/config.js");
  saveConfig({ ...DEFAULT_CONFIG, baseUrl: "https://real.example" });
  const prev = process.env["AETHER_BASE_URL"];
  process.env["AETHER_BASE_URL"] = "http://localhost:1234";
  try {
    const cfg = loadConfig(); // baseUrl = env override
    cfg.defaultEffort = "MAX"; // unrelated change, like /effort does
    saveConfig(cfg);
  } finally {
    if (prev === undefined) delete process.env["AETHER_BASE_URL"];
    else process.env["AETHER_BASE_URL"] = prev;
  }
  const after = loadConfig();
  assert.equal(after.baseUrl, "https://real.example", "env override leaked into config.json");
  assert.equal(after.defaultEffort, "MAX", "the real change must still persist");
});

// AETHER_BASE_URL is documented to override baseUrl — the CLI must actually
// honor it (it used to be SDK-only, silently no-oping for the CLI).
test("AETHER_BASE_URL overrides the config's baseUrl", async () => {
  const { loadConfig, saveConfig, DEFAULT_CONFIG } = await import("../src/core/config.js");
  saveConfig({ ...DEFAULT_CONFIG, baseUrl: "https://from-file.example" });
  const prev = process.env["AETHER_BASE_URL"];
  process.env["AETHER_BASE_URL"] = "http://127.0.0.1:9999";
  try {
    assert.equal(loadConfig().baseUrl, "http://127.0.0.1:9999");
  } finally {
    if (prev === undefined) delete process.env["AETHER_BASE_URL"];
    else process.env["AETHER_BASE_URL"] = prev;
  }
  assert.equal(loadConfig().baseUrl, "https://from-file.example");
});

test("saveConfig writes via rename (no leftover .tmp, no truncate-in-place)", async () => {
  const { loadConfig, saveConfig, DEFAULT_CONFIG } = await import("../src/core/config.js");
  saveConfig({ ...DEFAULT_CONFIG, defaultModel: "a" });
  saveConfig({ ...DEFAULT_CONFIG, defaultModel: "b" });
  saveConfig({ ...DEFAULT_CONFIG, defaultModel: "c" });
  assert.equal(loadConfig().defaultModel, "c");
  const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], `stray tmp files: ${leftovers.join(", ")}`);
});

test("loadConfig can still use defaults without changing malformed config bytes", async () => {
  const { loadConfig, DEFAULT_CONFIG } = await import("../src/core/config.js");
  const path = join(dir, "config.json");
  const original = Buffer.from("{ invalid json\r\n", "utf8");
  writeFileSync(path, original);

  const cfg = loadConfig();
  assert.equal(cfg.defaultEffort, DEFAULT_CONFIG.defaultEffort);
  assert.equal(cfg.permissionMode, DEFAULT_CONFIG.permissionMode);
  assert.deepEqual(readFileSync(path), original);
});

test("saveConfig preserves malformed config bytes with AETHER_BASE_URL set", async () => {
  const { saveConfig, DEFAULT_CONFIG } = await import("../src/core/config.js");
  const path = join(dir, "config.json");
  const original = Buffer.from("{ invalid json\r\n", "utf8");
  writeFileSync(path, original);

  const prev = process.env["AETHER_BASE_URL"];
  process.env["AETHER_BASE_URL"] = "http://127.0.0.1:9";
  try {
    assert.throws(
      () => saveConfig({ ...DEFAULT_CONFIG, baseUrl: process.env["AETHER_BASE_URL"]!, defaultEffort: "HIGH" }),
      /config\.json.*(repair|restore|fix|recover)|(repair|restore|fix|recover).*config\.json/i,
    );
    assert.deepEqual(readFileSync(path), original, "the original malformed config bytes changed");
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.endsWith(".tmp")),
      [],
      "a failed save left a temporary config file",
    );
  } finally {
    if (prev === undefined) delete process.env["AETHER_BASE_URL"];
    else process.env["AETHER_BASE_URL"] = prev;
  }
});

test("saveConfig refuses an existing config.json that cannot be read as a file", async () => {
  const { loadConfig, saveConfig, DEFAULT_CONFIG } = await import("../src/core/config.js");
  const path = join(dir, "config.json");
  rmSync(path, { force: true });
  mkdirSync(path);

  assert.equal(loadConfig().defaultEffort, DEFAULT_CONFIG.defaultEffort);
  assert.throws(
    () => saveConfig({ ...DEFAULT_CONFIG, defaultEffort: "HIGH" }),
    /config\.json.*(repair|restore|fix|recover|move)/i,
  );
  assert.equal(statSync(path).isDirectory(), true, "the config path was replaced");
});

test("saveConfig preserves config bytes that are invalid UTF-8", async () => {
  const { saveConfig, DEFAULT_CONFIG } = await import("../src/core/config.js");
  const path = join(dir, "config.json");
  if (existsSync(path)) {
    if (statSync(path).isDirectory()) rmdirSync(path);
    else rmSync(path, { force: true });
  }
  // {"x":" followed by a broken two-byte sequence, then ("}.
  const original = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  writeFileSync(path, original);

  assert.throws(
    () => saveConfig({ ...DEFAULT_CONFIG, defaultEffort: "HIGH" }),
    /config\.json.*(repair|restore|fix|recover|move)/i,
  );
  assert.deepEqual(readFileSync(path), original, "invalid UTF-8 bytes were rewritten");
});
