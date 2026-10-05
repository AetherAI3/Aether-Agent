import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, ftruncateSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ToolExecutor } from "../src/core/tool_executor.js";
import { tmpWorkspace } from "./tmp_workspace.js";

function workspace(run: (dir: string, executor: ToolExecutor) => void): void {
  const dir = tmpWorkspace("aether-read-file-");
  try { run(dir, new ToolExecutor(dir)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function revision(output: string): string {
  const token = /\brevision=(r1_[A-Za-z0-9_-]+)\]/.exec(output)?.[1];
  assert.ok(token, "successful read must return a revision");
  return token;
}

function guarded(executor: ToolExecutor, path: string, token: string) {
  return executor.execute("read_file", { path, offset: 4, max_bytes: 4, expected_revision: token });
}

test("read_file bounds a large sparse file and states its continuation", () => workspace((dir, executor) => {
  const path = join(dir, "large.txt");
  const fd = openSync(path, "w");
  try { ftruncateSync(fd, 128 * 1024 * 1024); }
  finally { closeSync(fd); }
  const result = executor.execute("read_file", { path: "large.txt" });
  assert.equal(result.exitCode, 1, "a sparse file is binary because its range contains NUL bytes");
  assert.match(result.output, /unsupported binary content/);
  assert.ok(result.output.length < 1000);

  writeFileSync(join(dir, "long.txt"), "a".repeat(16384));
  const first = executor.execute("read_file", { path: "long.txt" });
  assert.equal(first.exitCode, 0);
  assert.match(first.output, /range=0\.\.4096 total_bytes=16384 complete=false truncated=true next_offset=4096/);
  assert.match(first.output, /ends_mid_line=true/);
  revision(first.output);
  assert.ok(first.output.length < 5000);
}));

test("read_file continues a final line without claiming the tail is the whole file", () => workspace((dir, executor) => {
  writeFileSync(join(dir, "line.txt"), "abcdef");
  const first = executor.execute("read_file", { path: "line.txt", max_bytes: 4 });
  assert.equal(first.exitCode, 0);
  assert.match(first.output, /range=0\.\.4 total_bytes=6 complete=false truncated=true next_offset=4/);
  assert.match(first.output, /ends_mid_line=true/);
  const last = executor.execute("read_file", { path: "line.txt", offset: 4 });
  assert.equal(last.exitCode, 0);
  assert.match(last.output, /range=4\.\.6 total_bytes=6 complete=false truncated=false next_offset=none starts_mid_line=true/);
  assert.match(last.output, /\nef\n\[\/read_file\]$/);
}));

test("read_file identifies an empty file as complete", () => workspace((dir, executor) => {
  writeFileSync(join(dir, "empty.txt"), "");
  const result = executor.execute("read_file", { path: "empty.txt" });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /range=0\.\.0 total_bytes=0 complete=true truncated=false next_offset=none/);
  revision(result.output);
}));

test("read_file guarded continuation either reads one revision or fails closed on this platform", () => workspace((dir, executor) => {
  const path = join(dir, "ranges.txt");
  writeFileSync(path, "abcdefghijkl");
  const first = executor.execute("read_file", { path: "ranges.txt", max_bytes: 4 });
  const token = revision(first.output);
  const second = guarded(executor, "ranges.txt", token);
  if (process.platform !== "linux") {
    assert.equal(second.exitCode, 1);
    assert.match(second.output, /revision_unsupported/);
    assert.doesNotMatch(second.output, /efgh/);
    return;
  }
  assert.equal(second.exitCode, 0);
  assert.equal(revision(second.output), token);
  assert.match(second.output, /range=4\.\.8 total_bytes=12 complete=false truncated=true next_offset=8/);
  const third = executor.execute("read_file", { path: "ranges.txt", offset: 8, expected_revision: token });
  assert.equal(third.exitCode, 0);
  assert.equal(revision(third.output), token);
  assert.match(third.output, /range=8\.\.12 total_bytes=12 complete=false truncated=false next_offset=none/);
}));

test("read_file rejects changed, appended, truncated, and replaced guarded ranges", () => workspace((dir, executor) => {
  const path = join(dir, "changing.txt");
  const cases: Array<[string, () => void]> = [
    ["same-size rewrite", () => writeFileSync(path, "XXXXXXXXXXXX")],
    ["append", () => writeFileSync(path, "abcdefghijklmnop")],
    ["truncate", () => writeFileSync(path, "abcdef")],
    ["atomic replacement", () => { writeFileSync(join(dir, "replacement.txt"), "YYYYYYYYYYYY"); renameSync(join(dir, "replacement.txt"), path); }],
  ];
  for (const [name, mutate] of cases) {
    writeFileSync(path, "abcdefghijkl");
    const token = revision(executor.execute("read_file", { path: "changing.txt", max_bytes: 4 }).output);
    mutate();
    const result = guarded(executor, "changing.txt", token);
    assert.equal(result.exitCode, 1, name);
    assert.match(result.output, process.platform === "linux" ? /stale_revision/ : /revision_unsupported/, name);
    assert.doesNotMatch(result.output, /\[\/read_file\]/, name);
  }
}));

test("read_file rejects binary and malformed UTF-8", () => workspace((dir, executor) => {
  writeFileSync(join(dir, "nul.bin"), Buffer.from([65, 0, 66]));
  writeFileSync(join(dir, "control.bin"), Buffer.from([65, 1, 66]));
  writeFileSync(join(dir, "invalid.bin"), Buffer.from([65, 0xff, 66]));
  writeFileSync(join(dir, "incomplete.bin"), Buffer.from([65, 0xf0, 0x9f]));
  assert.match(executor.execute("read_file", { path: "nul.bin" }).output, /unsupported binary content/);
  assert.match(executor.execute("read_file", { path: "control.bin" }).output, /unsupported binary content/);
  const invalid = executor.execute("read_file", { path: "invalid.bin" });
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.output, /invalid UTF-8/);
  assert.match(executor.execute("read_file", { path: "incomplete.bin" }).output, /invalid UTF-8/);
}));

test("read_file preserves multibyte characters at byte boundaries", () => workspace((dir, executor) => {
  writeFileSync(join(dir, "unicode.txt"), "a😀z");
  const first = executor.execute("read_file", { path: "unicode.txt", max_bytes: 4 });
  assert.equal(first.exitCode, 0);
  assert.match(first.output, /range=0\.\.1 total_bytes=6 complete=false truncated=true next_offset=1/);
  assert.match(first.output, /\na\n\[\/read_file\]$/);
  const second = executor.execute("read_file", { path: "unicode.txt", offset: 1, max_bytes: 4 });
  assert.equal(second.exitCode, 0);
  assert.match(second.output, /range=1\.\.5 total_bytes=6 complete=false truncated=true next_offset=5/);
  assert.match(second.output, /\n😀\n\[\/read_file\]$/);
  const badOffset = executor.execute("read_file", { path: "unicode.txt", offset: 2 });
  assert.equal(badOffset.exitCode, 1);
  assert.match(badOffset.output, /inside a UTF-8 character/);
  const final = executor.execute("read_file", { path: "unicode.txt", offset: 5 });
  assert.match(final.output, /range=5\.\.6 total_bytes=6 complete=false truncated=false/);
}));

test("read_file reports missing files, directories, and invalid ranges as errors", () => workspace((dir, executor) => {
  writeFileSync(join(dir, "one.txt"), "x");
  for (const args of [{ path: "missing.txt" }, { path: "." }, { path: "one.txt", offset: 2 }, { path: "one.txt", offset: -1 }, { path: "one.txt", max_bytes: 3 }]) {
    assert.equal(executor.execute("read_file", args).exitCode, 1, JSON.stringify(args));
  }
}));
