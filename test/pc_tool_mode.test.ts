import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../src/core/tool_executor.js";

test("PC task mode refuses every legacy tool at both executor entry points", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aether-pc-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "secret.txt"), "secret-canary", "utf8");
  const context: { mode: "pc" | "coding" } = { mode: "pc" };
  const executor = new ToolExecutor(dir, "", context);
  context.mode = "coding"; // The constructor must have captured the host mode.

  const calls: Array<[string, Record<string, unknown>]> = [
    ["read_file", { path: "secret.txt" }],
    ["write_file", { path: "written.txt", content: "effect" }],
    ["repo_search", { query: "secret-canary" }],
    ["run_shell", { command: "exit 0" }],
    ["run_tests", { command: "exit 0" }],
    ["git_commit", { message: "effect" }],
    ["web_fetch", { url: "https://example.com" }],
    ["web_search", { query: "effect" }],
    ["unknown_mcp_tool", {}],
  ];
  for (const [name, args] of calls) {
    const sync = executor.execute(name, args);
    const asyncResult = await executor.executeAsync(name, args);
    for (const result of [sync, asyncResult]) {
      assert.equal(result.exitCode, 1, name);
      assert.match(result.output, /PC task mode accepts only registered PC operations/, name);
      assert.doesNotMatch(result.output, /secret-canary/, name);
    }
  }
  assert.equal(existsSync(join(dir, "written.txt")), false);
  assert.equal(readFileSync(join(dir, "secret.txt"), "utf8"), "secret-canary");
});

test("an invalid host execution mode is refused at construction", () => {
  assert.throws(
    () => new ToolExecutor(tmpdir(), "", { mode: "invalid" as "pc" }),
    /invalid tool execution mode/,
  );
});
