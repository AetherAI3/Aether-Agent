import { mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { ToolExecutor } from "../src/core/tool_executor.js";
import { tmpWorkspace } from "./tmp_workspace.js";

function workspace(run: (dir: string, executor: ToolExecutor) => void): void {
  const dir = tmpWorkspace("aether-write-file-");
  try { run(dir, new ToolExecutor(dir)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function complete(executor: ToolExecutor, path: string): { revision: string; token: string } {
  const read = executor.execute("read_file", { path });
  assert.equal(read.exitCode, 0, read.output);
  const result = JSON.parse(read.output) as Record<string, unknown>;
  assert.equal(result["complete"], true);
  assert.match(String(result["replace_token"]), /^w1_[A-Za-z0-9_-]+$/);
  return { revision: String(result["revision"]), token: String(result["replace_token"]) };
}

function replace(executor: ToolExecutor, path: string, content: string, proof: { revision: string; token: string }) {
  return executor.execute("write_file", { path, content, expected_revision: proof.revision, replace_token: proof.token });
}

test("complete current read authorizes replacement and reports audit revisions", () => workspace((dir, executor) => {
  const path = join(dir, "é.txt");
  writeFileSync(path, "a😀z");
  chmodSync(path, 0o640);
  const mode = statSync(path).mode & 0o777;
  const proof = complete(executor, "é.txt");
  const result = replace(executor, "é.txt", "é😀done", proof);
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, new RegExp(`prior_revision ${proof.revision}`));
  assert.match(result.output, /new_revision r1_/);
  assert.equal(readFileSync(path, "utf8"), "é😀done");
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, mode);
  assert.deepEqual(readdirSync(dir), ["é.txt"]);
}));

test("empty file has a complete-read replacement proof", () => workspace((dir, executor) => {
  writeFileSync(join(dir, "empty.txt"), "");
  assert.equal(replace(executor, "empty.txt", "filled", complete(executor, "empty.txt")).exitCode, 0);
  assert.equal(readFileSync(join(dir, "empty.txt"), "utf8"), "filled");
}));

test("partial, missing, mismatched, and cross-session proofs never replace", () => workspace((dir, executor) => {
  writeFileSync(join(dir, "prior.txt"), "abcdefgh");
  const page = JSON.parse(executor.execute("read_file", { path: "prior.txt", max_bytes: 4 }).output) as Record<string, unknown>;
  assert.equal(page["complete"], false);
  assert.equal(page["replace_token"], undefined);
  const line = JSON.parse(executor.execute("read_file", { path: "prior.txt", start_line: 1 }).output) as Record<string, unknown>;
  assert.equal(line["replace_token"], undefined);
  const proof = complete(executor, "prior.txt");
  for (const args of [
    { path: "prior.txt", content: "bad" },
    { path: "prior.txt", content: "bad", expected_revision: page["revision"] },
    { path: "prior.txt", content: "bad", expected_revision: proof.revision, replace_token: "w1_fake" },
    { path: "prior.txt", content: "bad", expected_revision: "r1_fake", replace_token: proof.token },
  ]) assert.equal(executor.execute("write_file", args).exitCode, 1);
  const another = new ToolExecutor(dir);
  assert.equal(replace(another, "prior.txt", "bad", proof).exitCode, 1);
  assert.equal(readFileSync(join(dir, "prior.txt"), "utf8"), "abcdefgh");
}));

test("same-size edit and atomic path replacement invalidate a complete read", () => workspace((dir, executor) => {
  const path = join(dir, "prior.txt");
  writeFileSync(path, "abcdefgh");
  const beforeEdit = complete(executor, "prior.txt");
  writeFileSync(path, "abcdWXYZ");
  assert.match(replace(executor, "prior.txt", "bad", beforeEdit).output, /stale_revision/);
  const beforeSwap = complete(executor, "prior.txt");
  writeFileSync(join(dir, "swap.txt"), "abcdWXYZ");
  renameSync(join(dir, "swap.txt"), path);
  assert.match(replace(executor, "prior.txt", "bad", beforeSwap).output, /stale_revision/);
  assert.equal(readFileSync(path, "utf8"), "abcdWXYZ");
}));

test("a path swap while replacement is staged fails before rename", () => workspace((dir, executor) => {
  const path = join(dir, "prior.txt");
  writeFileSync(path, "original");
  const proof = complete(executor, "prior.txt");
  const originalChmod = fs.chmodSync;
  const race = mock.method(fs, "chmodSync", (target: string, mode: number) => {
    writeFileSync(join(dir, "swap.txt"), "new owner");
    renameSync(join(dir, "swap.txt"), path);
    return originalChmod(target, mode);
  });
  syncBuiltinESMExports();
  try {
    assert.match(replace(executor, "prior.txt", "bad", proof).output, /stale_revision/);
    assert.equal(readFileSync(path, "utf8"), "new owner");
    assert.deepEqual(readdirSync(dir), ["prior.txt"]);
  } finally { race.mock.restore(); syncBuiltinESMExports(); }
}));

test("create-only writes preserve a racing creator and refuse a disappeared replacement", () => workspace((dir, executor) => {
  const path = join(dir, "new.txt");
  assert.equal(executor.execute("write_file", { path: "new.txt", content: "first" }).exitCode, 0);
  const result = executor.execute("write_file", { path: "new.txt", content: "second" });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /already exists/);
  assert.equal(readFileSync(path, "utf8"), "first");
  const proof = complete(executor, "new.txt");
  rmSync(path);
  assert.equal(replace(executor, "new.txt", "second", proof).exitCode, 1);
  assert.equal(existsSync(path), false);
}));

test("create-only commit loses safely when another writer creates the path during staging", () => workspace((dir, executor) => {
  const original = fs.linkSync;
  const race = mock.method(fs, "linkSync", (source: string, target: string) => {
    writeFileSync(target, "winner");
    return original(source, target);
  });
  syncBuiltinESMExports();
  try {
    const result = executor.execute("write_file", { path: "raced.txt", content: "loser" });
    assert.equal(result.exitCode, 1);
    assert.equal(readFileSync(join(dir, "raced.txt"), "utf8"), "winner");
    assert.deepEqual(readdirSync(dir), ["raced.txt"]);
  } finally { race.mock.restore(); syncBuiltinESMExports(); }
}));

test("binary and oversized targets cannot obtain a replacement proof", () => workspace((dir, executor) => {
  writeFileSync(join(dir, "binary.bin"), Buffer.from([65, 0, 66]));
  assert.match(executor.execute("read_file", { path: "binary.bin" }).output, /binary file/);
  assert.equal(executor.execute("write_file", { path: "binary.bin", content: "bad" }).exitCode, 1);
  writeFileSync(join(dir, "large.txt"), "a".repeat(5000));
  const page = JSON.parse(executor.execute("read_file", { path: "large.txt" }).output) as Record<string, unknown>;
  assert.equal(page["replace_token"], undefined);
  assert.match(executor.execute("write_file", { path: "large.txt", content: "bad" }).output, /patch_file/);
  assert.equal(statSync(join(dir, "large.txt")).size, 5000);
}));

test("hosted async dispatch rejects legacy replacement through the same executor", async () => {
  const dir = tmpWorkspace("aether-hosted-write-");
  try {
    writeFileSync(join(dir, "existing.txt"), "original");
    const result = await new ToolExecutor(dir).executeAsync("write_file", { path: "existing.txt", content: "legacy" });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /expected_revision.*replace_token/);
    assert.equal(readFileSync(join(dir, "existing.txt"), "utf8"), "original");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("symlink targets and failed rename leave existing bytes intact", () => workspace((dir, executor) => {
  const path = join(dir, "original.txt");
  writeFileSync(path, "original");
  try {
    symlinkSync(path, join(dir, "link.txt"));
    assert.equal(executor.execute("write_file", { path: "link.txt", content: "bad" }).exitCode, 1);
  } catch (error) { if (process.platform !== "win32") throw error; }
  const proof = complete(executor, "original.txt");
  const failure = mock.method(fs, "renameSync", () => { throw Object.assign(new Error("rename denied"), { code: "EPERM" }); });
  syncBuiltinESMExports();
  try {
    const result = replace(executor, "original.txt", "bad", proof);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /rename denied/);
    assert.equal(readFileSync(path, "utf8"), "original");
    assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".aether-write-")), []);
  } finally { failure.mock.restore(); syncBuiltinESMExports(); }
}));

test("staging I/O failure leaves old file untouched", () => workspace((dir, executor) => {
  const path = join(dir, "original.txt");
  writeFileSync(path, "original");
  const proof = complete(executor, "original.txt");
  const failure = mock.method(fs, "writeFileSync", () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); });
  syncBuiltinESMExports();
  try {
    assert.match(replace(executor, "original.txt", "bad", proof).output, /disk full/);
    assert.equal(readFileSync(path, "utf8"), "original");
    assert.deepEqual(readdirSync(dir), ["original.txt"]);
  } finally { failure.mock.restore(); syncBuiltinESMExports(); }
}));
