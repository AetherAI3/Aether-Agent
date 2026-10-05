import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpWorkspace } from "./tmp_workspace.js";
import { ToolExecutor } from "../src/core/tool_executor.js";
import { TOOLS } from "../src/core/brain_protocol.js";
import { ollamaToolSchemas } from "../src/core/brain_ollama.js";
import { EXEC_V1_TOOLS } from "../src/commands/exec.js";

function workspace(run: (dir: string, exec: ToolExecutor) => void): void {
  const dir = tmpWorkspace("aether-filesystem-");
  try { run(dir, new ToolExecutor(dir)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function read(exec: ToolExecutor, path: string, options: Record<string, unknown> = {}): Record<string, unknown> {
  const result = exec.execute("read_file", { path, ...options });
  assert.equal(result.exitCode, 0, result.output);
  return JSON.parse(result.output) as Record<string, unknown>;
}

test("paginated listings preserve Unicode/spaces, identify types, and reject changed cursors", () => workspace((dir, exec) => {
  mkdirSync(join(dir, "empty"));
  mkdirSync(join(dir, "sub dir"));
  writeFileSync(join(dir, "é space.txt"), "é");
  writeFileSync(join(dir, "z.txt"), "z");
  assert.deepEqual(JSON.parse(exec.execute("list_directory", { path: "empty" }).output).entries, []);
  const first = JSON.parse(exec.execute("list_directory", { path: ".", limit: 2 }).output);
  assert.equal(first.entries.length, 2);
  assert.ok(first.next_cursor);
  const second = JSON.parse(exec.execute("list_directory", { path: ".", limit: 2, cursor: first.next_cursor }).output);
  const entries = [...first.entries, ...second.entries];
  assert.ok(entries.some((entry) => entry.path === "./é space.txt" && entry.type === "file" && entry.size === 2));
  assert.ok(entries.some((entry) => entry.path === "./sub dir" && entry.type === "directory"));
  writeFileSync(join(dir, "another.txt"), "new");
  assert.match(exec.execute("list_directory", { path: ".", cursor: first.next_cursor }).output, /conflict/);
}));

test("bounded line and byte reads expose a digest usable for an exact patch", () => workspace((dir, exec) => {
  writeFileSync(join(dir, "é file.txt"), "first\nsecond\nthird\n");
  const ranged = read(exec, "é file.txt", { start_line: 2, max_lines: 1 });
  assert.equal(ranged["content"], "second");
  assert.equal(ranged["next_start_line"], 3);
  const bytes = read(exec, "é file.txt", { offset: 0, max_bytes: 5 });
  assert.equal(bytes["content"], "first");
  assert.equal(bytes["next_offset"], 5);
  assert.equal(ranged["sha256"], bytes["sha256"]);
  const patch = { path: "é file.txt", expected_sha256: ranged["sha256"], old_text: "second", new_text: "SECOND" };
  const preview = exec.previewPatch(patch);
  assert.equal(preview.exitCode, 0);
  assert.match(preview.output, /- "second"\n\+ "SECOND"/);
  assert.equal(exec.execute("patch_file", patch).exitCode, 0);
  assert.equal(readFileSync(join(dir, "é file.txt"), "utf8"), "first\nSECOND\nthird\n");
}));

test("reads stay bounded for sparse files and report continuations at UTF-8 and final-line boundaries", () => workspace((dir, exec) => {
  const sparse = join(dir, "large.txt");
  writeFileSync(sparse, "start");
  truncateSync(sparse, 32 * 1024 * 1024);
  const large = read(exec, "large.txt", { offset: 0, max_bytes: 4 });
  assert.equal(large["content"], "star");
  assert.equal(large["next_offset"], 4);
  assert.equal(large["size"], 32 * 1024 * 1024);
  assert.equal(large["sha256"], null, "oversized files cannot be patch targets");
  assert.equal(large["validation_scope"], "returned_range", "bytes outside the requested range were not checked for binary content");
  writeFileSync(join(dir, "unicode.txt"), "a😀b");
  assert.deepEqual([read(exec, "unicode.txt", { max_bytes: 4 })["content"], read(exec, "unicode.txt", { offset: 1, max_bytes: 4 })["content"]], ["a", "😀"]);
  assert.match(exec.execute("read_file", { path: "unicode.txt", offset: 2, max_bytes: 4 }).output, /splits a UTF-8 character/);
  writeFileSync(join(dir, "lines.txt"), "first\nlast");
  assert.equal(read(exec, "lines.txt", { start_line: 1, max_lines: 1 })["next_start_line"], 2);
  assert.equal(read(exec, "lines.txt", { start_line: 2, max_lines: 1 })["next_start_line"], null);
  assert.match(exec.execute("read_file", { path: "lines.txt", start_line: 3 }).output, /beyond EOF/);
  writeFileSync(join(dir, "empty.txt"), "");
  assert.equal(read(exec, "empty.txt")["content"], "");
  assert.equal(read(exec, "empty.txt", { start_line: 1 })["content"], "");
  writeFileSync(join(dir, "binary.dat"), Buffer.from([65, 0, 66]));
  assert.match(exec.execute("read_file", { path: "binary.dat" }).output, /binary file/);
  writeFileSync(join(dir, "invalid.txt"), Buffer.from([65, 0xff, 66]));
  assert.match(exec.execute("read_file", { path: "invalid.txt" }).output, /invalid UTF-8/);
  writeFileSync(join(dir, "long.txt"), "a".repeat(7000) + "\nnext");
  assert.match(String(read(exec, "long.txt", { start_line: 1 })["note"]), /line exceeds 6000 bytes/);
  assert.notEqual(exec.execute("read_file", { path: "missing.txt" }).exitCode, 0);
}));

test("stale, nonmatching, and ambiguous patches leave the file unchanged", () => workspace((dir, exec) => {
  const path = join(dir, "same.txt");
  writeFileSync(path, "same\nsame\n");
  const digest = read(exec, "same.txt")["sha256"];
  const base = { path: "same.txt", expected_sha256: digest, new_text: "new" };
  assert.match(exec.execute("patch_file", { ...base, old_text: "same" }).output, /ambiguous/);
  assert.match(exec.execute("patch_file", { ...base, old_text: "missing" }).output, /does not match/);
  writeFileSync(path, "user edit\n");
  assert.match(exec.execute("patch_file", { ...base, old_text: "same\n" }).output, /conflict/);
  assert.equal(readFileSync(path, "utf8"), "user edit\n");
  assert.deepEqual(readdirSync(dir), ["same.txt"]);
}));

test("patching a UTF-8 BOM file preserves bytes outside the matched hunk", () => workspace((dir, exec) => {
  const path = join(dir, "bom.txt");
  writeFileSync(path, "\uFEFFfirst\ntarget\n", "utf8");
  const firstPage = read(exec, "bom.txt", { max_bytes: 4 });
  assert.equal(firstPage["content"], "\uFEFFf");
  assert.equal(firstPage["next_offset"], 4);
  const patch = { path: "bom.txt", expected_sha256: firstPage["sha256"], old_text: "target", new_text: "changed" };
  assert.equal(exec.execute("patch_file", patch).exitCode, 0);
  assert.deepEqual(readFileSync(path), Buffer.from("\uFEFFfirst\nchanged\n", "utf8"));
}));

test("patches work at both file boundaries, preserve mode, and refuse symlinks", () => workspace((dir, exec) => {
  const path = join(dir, "bounds.txt");
  writeFileSync(path, "middle\n");
  chmodSync(path, 0o640);
  const mode = statSync(path).mode & 0o777;
  const first = read(exec, "bounds.txt")["sha256"];
  assert.equal(exec.execute("patch_file", { path: "bounds.txt", expected_sha256: first, old_text: "", new_text: "first\n", start_line: 1 }).exitCode, 0);
  const second = read(exec, "bounds.txt")["sha256"];
  assert.equal(exec.execute("patch_file", { path: "bounds.txt", expected_sha256: second, old_text: "", new_text: "last\n", start_line: 3 }).exitCode, 0);
  assert.equal(readFileSync(path, "utf8"), "first\nmiddle\nlast\n");
  assert.equal(statSync(path).mode & 0o777, mode);
  try {
    symlinkSync(path, join(dir, "link.txt"));
    assert.notEqual(exec.execute("patch_file", { path: "link.txt", expected_sha256: second, old_text: "middle", new_text: "bad" }).exitCode, 0);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}));

test("a failed staging write leaves the original file and no temp sibling", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) { t.skip("directory mode enforcement requires an unprivileged POSIX process"); return; }
  workspace((dir, exec) => {
    const path = join(dir, "locked.txt");
    writeFileSync(path, "original\n");
    const digest = read(exec, "locked.txt")["sha256"];
    chmodSync(dir, 0o500);
    try {
      const result = exec.execute("patch_file", { path: "locked.txt", expected_sha256: digest, old_text: "original", new_text: "changed" });
      assert.notEqual(result.exitCode, 0);
      assert.equal(readFileSync(path, "utf8"), "original\n");
      assert.deepEqual(readdirSync(dir), ["locked.txt"]);
    } finally { chmodSync(dir, 0o700); }
  });
});

test("local model, hosted capabilities, and headless allowlist advertise the new contract", () => {
  const schemas = ollamaToolSchemas().map((schema) => schema.function.name);
  for (const name of ["read_file", "list_directory", "patch_file"]) {
    assert.ok(TOOLS.includes(name as (typeof TOOLS)[number]));
    assert.ok(schemas.includes(name));
    assert.ok((EXEC_V1_TOOLS as readonly string[]).includes(name));
  }
});
