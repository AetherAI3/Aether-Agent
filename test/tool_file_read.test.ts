import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, ftruncateSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ToolExecutor } from "../src/core/tool_executor.js";
import { tmpWorkspace } from "./tmp_workspace.js";

function workspace(run: (dir: string, executor: ToolExecutor) => void): void {
  const dir = tmpWorkspace("aether-read-file-");
  try { run(dir, new ToolExecutor(dir)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function read(executor: ToolExecutor, args: Record<string, unknown>): Record<string, unknown> {
  const result = executor.execute("read_file", args);
  assert.equal(result.exitCode, 0, result.output);
  assert.ok(Buffer.byteLength(result.output) <= 8000);
  return JSON.parse(result.output) as Record<string, unknown>;
}

test("read_file bounds sparse files and states byte continuation", () => workspace((dir, executor) => {
  const path = join(dir, "large.txt");
  const fd = openSync(path, "w");
  try { ftruncateSync(fd, 128 * 1024 * 1024); }
  finally { closeSync(fd); }
  assert.match(executor.execute("read_file", { path: "large.txt" }).output, /binary file/);
  writeFileSync(join(dir, "long.txt"), "a".repeat(16384));
  const first = read(executor, { path: "long.txt" });
  assert.equal(first["content"], "a".repeat(4096));
  assert.equal(first["range_end"], 4096);
  assert.equal(first["size"], 16384);
  assert.equal(first["next_offset"], 4096);
  assert.equal(first["complete"], false);
  assert.equal(first["truncated"], true);
  assert.equal(first["ends_mid_line"], true);
}));

test("read_file tail range retains whole-file and line-boundary metadata", () => workspace((dir, executor) => {
  writeFileSync(join(dir, "line.txt"), "abcdef");
  const first = read(executor, { path: "line.txt", max_bytes: 4 });
  assert.equal(first["next_offset"], 4);
  const last = read(executor, { path: "line.txt", offset: 4 });
  assert.equal(last["content"], "ef");
  assert.equal(last["next_offset"], null);
  assert.equal(last["complete"], false);
  assert.equal(last["truncated"], false);
  assert.equal(last["starts_mid_line"], true);
}));

test("read_file identifies an empty file as complete", () => workspace((dir, executor) => {
  writeFileSync(join(dir, "empty.txt"), "");
  const result = read(executor, { path: "empty.txt" });
  assert.equal(result["content"], "");
  assert.equal(result["range_end"], 0);
  assert.equal(result["complete"], true);
  assert.equal(result["truncated"], false);
}));

test("read_file rejects binary controls and malformed UTF-8", () => workspace((dir, executor) => {
  writeFileSync(join(dir, "nul.bin"), Buffer.from([65, 0, 66]));
  writeFileSync(join(dir, "control.bin"), Buffer.from([65, 1, 66]));
  writeFileSync(join(dir, "invalid.bin"), Buffer.from([65, 0xff, 66]));
  writeFileSync(join(dir, "incomplete.bin"), Buffer.from([65, 0xf0, 0x9f]));
  assert.match(executor.execute("read_file", { path: "nul.bin" }).output, /binary file/);
  assert.match(executor.execute("read_file", { path: "control.bin" }).output, /binary file/);
  assert.match(executor.execute("read_file", { path: "control.bin", start_line: 1 }).output, /binary file/);
  assert.match(executor.execute("read_file", { path: "control.bin", offset: 2 }).output, /binary file/);
  assert.match(executor.execute("read_file", { path: "invalid.bin" }).output, /invalid UTF-8/);
  assert.match(executor.execute("read_file", { path: "incomplete.bin" }).output, /invalid UTF-8/);
}));

test("read_file keeps multibyte characters intact across byte pages", () => workspace((dir, executor) => {
  writeFileSync(join(dir, "unicode.txt"), "a😀z");
  const first = read(executor, { path: "unicode.txt", max_bytes: 4 });
  assert.equal(first["content"], "a");
  assert.equal(first["next_offset"], 1);
  const second = read(executor, { path: "unicode.txt", offset: 1, max_bytes: 4 });
  assert.equal(second["content"], "😀");
  assert.equal(second["next_offset"], 5);
  assert.match(executor.execute("read_file", { path: "unicode.txt", offset: 2 }).output, /splits a UTF-8 character/);
  const final = read(executor, { path: "unicode.txt", offset: 5 });
  assert.equal(final["content"], "z");
  assert.equal(final["complete"], false);
}));

test("read_file reports missing files, directories, and invalid ranges", () => workspace((dir, executor) => {
  writeFileSync(join(dir, "one.txt"), "x");
  for (const args of [{ path: "missing.txt" }, { path: "." }, { path: "one.txt", offset: 2 }, { path: "one.txt", offset: -1 }, { path: "one.txt", max_bytes: 3 }]) {
    assert.equal(executor.execute("read_file", args).exitCode, 1, JSON.stringify(args));
  }
}));
