import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cmdCode } from "../src/commands/code.js";
import { runTurn } from "../src/commands/chat.js";
import { renderManifestHelp } from "../src/commands/command_manifest.js";
import type { AppContext } from "../src/core/context.js";
import { tmpWorkspace } from "./tmp_workspace.js";

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 0, String(result.stderr));
  return String(result.stdout);
}

test("planning admits the current checkout without workspace preparation or final tests", async () => {
  const root = tmpWorkspace("aether-planning-");
  const config = join(root, "config");
  mkdirSync(config);
  const tracked = join(root, "tracked.txt");
  writeFileSync(tracked, "original\n");
  git(root, "init", "-q");
  git(root, "add", "tracked.txt");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline");
  const beforeIndex = git(root, "ls-files", "--stage");
  const beforeRefs = git(root, "show-ref", "--head");
  const oldConfig = process.env["AETHER_CONFIG_DIR"];
  const oldMemory = process.env["AETHER_PROJECT_MEMORY_RECEIPTS_ENABLED"];
  process.env["AETHER_CONFIG_DIR"] = config;
  process.env["AETHER_PROJECT_MEMORY_RECEIPTS_ENABLED"] = "0";
  const abort = new AbortController();
  abort.abort(new DOMException("test cancellation", "AbortError"));
  const ctx = {
    cfg: { backend: "local", localModel: "llama3", permissionMode: "skip", autoApply: true, defaultModel: "", defaultEffort: "", baseUrl: "" },
    flags: { cwd: root, local: true, json: true, yes: true },
    confirm: async () => true,
  } as unknown as AppContext;
  let workspaceRunnerCalls = 0;
  try {
    const result = await cmdCode(ctx, "outline the change", {
      local: true, pool: 5, quiet: true, capability: "planning", noSkills: true, noLog: true,
      testCmd: "node -e \"require('fs').writeFileSync('verification-ran', 'bad')\"",
      signal: abort.signal,
    }, () => { workspaceRunnerCalls += 1; throw new Error("workspace preparation or verification ran"); });
    assert.notEqual(result, 0, "the cancelled model turn is not reported as a completed plan");
    assert.equal(workspaceRunnerCalls, 0);
    assert.equal(git(root, "ls-files", "--stage"), beforeIndex);
    assert.equal(git(root, "show-ref", "--head"), beforeRefs);
    assert.equal(readFileSync(tracked, "utf8"), "original\n");
    assert.equal(existsSync(join(root, "verification-ran")), false);
  } finally {
    if (oldConfig === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = oldConfig;
    if (oldMemory === undefined) delete process.env["AETHER_PROJECT_MEMORY_RECEIPTS_ENABLED"];
    else process.env["AETHER_PROJECT_MEMORY_RECEIPTS_ENABLED"] = oldMemory;
    rmSync(root, { recursive: true, force: true });
  }
});

test("planning rejects mutating workspace options before repository preparation", () => {
  const root = tmpWorkspace("aether-planning-flags-");
  const cli = resolve("dist", "src", "main.js");
  assert.match(renderManifestHelp("shell", "agent"), /aether agent --planning/);
  try {
    for (const flags of [["--worktree"], ["--repo", "owner/repo"], ["--resume", "old-session"]]) {
      const result = spawnSync(process.execPath, [cli, "agent", "--planning", "--cwd", root, ...flags, "outline"], { encoding: "utf8", timeout: 5_000 });
      assert.equal(result.status, 2, String(result.stderr));
      assert.match(String(result.stderr), /planning uses the current workspace/);
      assert.equal(existsSync(join(root, ".git")), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("server-executed cloud chat refuses planning before sending a model request", async () => {
  let requests = 0;
  const ctx = {
    cfg: { backend: "cloud", baseUrl: "https://example.invalid" },
    flags: { cwd: process.cwd(), json: true, local: false },
    tokens: { get: async () => "aek_fixture" },
    api: { stream: () => { requests += 1; throw new Error("unrestricted request"); } },
  } as unknown as AppContext;
  await assert.rejects(runTurn(ctx, "return a plan", undefined, undefined, undefined, { capability: "planning", noSkills: true }), /requires host-executed tools/);
  assert.equal(requests, 0);
});
