import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpWorkspace } from "./tmp_workspace.js";
import { TOOLS } from "../src/core/brain_protocol.js";
import { ToolExecutor } from "../src/core/tool_executor.js";
import {
  TOOL_DEFINITIONS,
  toolDefinition,
  validateToolCall,
  validateToolDefinitionCoverage,
} from "../src/core/tool_registry.js";

test("typed tool definitions cover the frozen protocol exactly", () => {
  assert.deepEqual(validateToolDefinitionCoverage(), []);
  assert.deepEqual(Object.keys(TOOL_DEFINITIONS).sort(), [...TOOLS].sort());
  assert.equal(toolDefinition("write_file")?.sideEffect, "write");
  assert.equal(toolDefinition("run_shell")?.sideEffect, "shell");
  assert.equal(toolDefinition("git_commit")?.sideEffect, "git");
  assert.equal(toolDefinition("web_fetch")?.sideEffect, "network");
});

test("validators accept every canonical tool shape", () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ["read_file", { path: "a.ts" }],
    ["read_file", { path: "a.ts", offset: 4096, max_bytes: 1024 }],
    ["write_file", { path: "a.ts", content: "" }],
    ["run_shell", { command: "git status" }],
    ["run_tests", {}],
    ["repo_search", { query: "needle" }],
    ["git_commit", { message: "test: safe" }],
    ["web_search", { query: "docs", limit: 3 }],
    ["web_fetch", { url: "https://example.test/" }],
  ];
  for (const [name, args] of calls) {
    assert.equal(validateToolCall(name, args).ok, true, name);
  }
});

test("validators reject unknown, malformed, oversized, and extra arguments", () => {
  assert.deepEqual(validateToolCall("invented", {}), { ok: false, error: "unknown tool" });
  assert.deepEqual(validateToolCall("read_file", []), {
    ok: false,
    error: "arguments must be an object",
  });
  assert.deepEqual(validateToolCall("read_file", {}), {
    ok: false,
    error: "missing argument: path",
  });
  assert.deepEqual(validateToolCall("read_file", { path: 7 }), {
    ok: false,
    error: "path must be a string",
  });
  assert.deepEqual(validateToolCall("read_file", { path: "" }), {
    ok: false,
    error: "path must not be empty",
  });
  assert.match(
    (validateToolCall("write_file", { path: "x", content: "x".repeat(1024 * 1024 + 1) }) as { error: string }).error,
    /exceeds/,
  );
  assert.deepEqual(validateToolCall("web_search", { query: "x", limit: 11 }), {
    ok: false,
    error: "limit must be from 1 to 10",
  });
  assert.deepEqual(validateToolCall("repo_search", { query: "x", command: "whoami" }), {
    ok: false,
    error: "unknown argument: command",
  });
});

test("executor rejects malformed calls before filesystem side effects", () => {
  const dir = tmpWorkspace("aether-tool-schema-");
  const executor = new ToolExecutor(dir);
  const result = executor.execute("write_file", { path: "created.txt", content: 42 });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /rejected/);
  assert.equal(existsSync(join(dir, "created.txt")), false);
});
