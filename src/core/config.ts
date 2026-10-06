// Config load/save: ~/.config/aether/config.json
// Override the directory with AETHER_CONFIG_DIR (used by tests).

import { homedir } from "node:os";
import { isUtf8 } from "node:buffer";
import { join } from "node:path";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { AetherConfig } from "../types.js";
import { isLocalModelId } from "./local_ollama.js";

// The public API front door. The backend is served under the `/cloud` path; the
// apex returns an info blob, so the `/cloud` suffix is required for every API
// call (auth, chat, github connect). Override with AETHER_BASE_URL.
export const DEFAULT_CONFIG: AetherConfig = {
  baseUrl: "https://api.aethersystems.net/cloud",
  defaultModel: "",
  localModel: "",
  permissionMode: "ask",
  autoApply: false,
  telemetry: true,
  defaultEffort: "",
  // Local-first: 'auto' runs the cloud brain when signed in, else local Ollama.
  // A config.json written before this key existed merges to this default.
  backend: "auto",
};

export function configDir(): string {
  return process.env["AETHER_CONFIG_DIR"] ?? join(homedir(), ".config", "aether");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function loadConfig(): AetherConfig {
  const cfg = loadConfigFile();
  // Migrate the brief pre-release shape that stored an Ollama id in the
  // hosted default slot. This is in-memory until the next explicit config
  // write; no read-only command rewrites the user's file.
  if (!cfg.localModel && isLocalModelId(cfg.defaultModel)) {
    cfg.localModel = cfg.defaultModel;
    cfg.defaultModel = "";
  }
  // AETHER_BASE_URL is documented to override the config's baseUrl (a single
  // env var can point every API call at a staging/self-hosted backend without
  // editing config.json). This is a distinct concern from AETHER_BACKEND
  // (local-vs-cloud brain choice, read where `backend` is consumed) — do not
  // conflate the two. saveConfig() below takes care not to persist this
  // override back into config.json.
  const envBase = process.env["AETHER_BASE_URL"];
  if (envBase) cfg.baseUrl = envBase;
  return cfg;
}

function readConfigFile(): AetherConfig | undefined {
  const path = configPath();
  let contents: Buffer;
  try {
    contents = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A missing file is normal on first use. A dangling symlink is an
      // existing config entry, however, and must not be replaced by rename().
      try {
        lstatSync(path);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      }
    }
    throw error;
  }
  if (!isUtf8(contents)) throw new Error("config.json must be UTF-8");
  const raw: unknown = JSON.parse(contents.toString("utf8"));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.json must contain a JSON object");
  }
  return { ...DEFAULT_CONFIG, ...raw };
}

function loadConfigFile(): AetherConfig {
  try {
    return readConfigFile() ?? { ...DEFAULT_CONFIG };
  } catch {
    // Corrupt config must never brick the CLI — fall back to defaults.
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: AetherConfig): void {
  const path = configPath();
  let persisted: AetherConfig | undefined;
  try {
    // Re-read at save time: config may have become corrupt since startup.
    persisted = readConfigFile();
  } catch (error) {
    throw new Error(
      `Cannot save settings: ${path} is unreadable or invalid. Repair it or move it aside, then retry. The original file was not changed.`,
      { cause: error },
    );
  }
  const dir = configDir();
  // 0700: this directory also holds the .token credential — keep it owner-only.
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Never persist the AETHER_BASE_URL env override: a one-off
  // `AETHER_BASE_URL=http://localhost aether models use x` must not rewrite
  // config.json's baseUrl and silently point every future run at localhost.
  const out = { ...cfg };
  const envBase = process.env["AETHER_BASE_URL"];
  if (envBase && out.baseUrl === envBase) {
    out.baseUrl = persisted ? persisted.baseUrl : DEFAULT_CONFIG.baseUrl;
  }

  // Write-then-rename instead of an in-place truncate: two processes saving
  // at once (e.g. `/effort` in one REPL, `config set` in another) could tear
  // the file, and a reader parsing a torn JSON file falls back to defaults —
  // silently resetting baseUrl to production. rename() is atomic on both
  // POSIX and NTFS.
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // Preserve the original write/rename failure; the caller must see that
      // the mutation did not complete rather than a best-effort cleanup error.
    }
    throw error;
  }
}
