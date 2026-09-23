import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strictTarExtractor } from "../src/core/ats_runtime/tar_extractor.js";

function octal(header: Buffer, position: number, width: number, value: number): void {
  header.write(value.toString(8).padStart(width - 1, "0") + "\0", position, width, "ascii");
}

function entry(path: string, payload: string, flag: string = "0", executable = false): Buffer {
  const bytes = Buffer.from(payload);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  octal(header, 100, 8, executable ? 0o755 : 0o644);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, bytes.length);
  octal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header.write(flag, 156, 1);
  header.write("ustar\0", 257, 6);
  header.write("00", 263, 2);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

function archive(...entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

async function stage(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ats-tar-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "slot"), { mode: 0o700 });
  return dir;
}

test("strict ustar extracts a normal runtime within the private slot", async t => {
  const dir = await stage(t);
  await strictTarExtractor.extract({ bytes: archive(entry("bin/", "", "5"), entry("bin/ats-runtime", "ok", "0", true)),
    destination: join(dir, "slot") });
  assert.equal(await readFile(join(dir, "slot/bin/ats-runtime"), "utf8"), "ok");
  if (process.platform !== "win32") {
    assert.equal((await stat(join(dir, "slot/bin/ats-runtime"))).mode & 0o777, 0o700);
  }
});

test("traversal, absolute, Windows special names and links are rejected before any write", async t => {
  const dir = await stage(t);
  for (const path of ["../escape", "/outside", "C:/outside", "bin\\escape", "NUL", "bin/CON.txt", "bin/name:stream", "bin/../escape"]) {
    await assert.rejects(strictTarExtractor.extract({ bytes: archive(entry("safe", "ok"), entry(path, "attack")),
      destination: join(dir, "slot") }));
    await assert.rejects(stat(join(dir, "slot/safe")));
  }
  await assert.rejects(strictTarExtractor.extract({ bytes: archive(entry("safe", "ok"), entry("link", "", "2")),
    destination: join(dir, "slot") }));
  await assert.rejects(stat(join(dir, "slot/safe")));
});

test("corrupt headers, duplicate files and total output limits refuse before writes", async t => {
  const dir = await stage(t);
  const corrupt = archive(entry("safe", "ok"), entry("next", "payload"));
  corrupt[1024] = corrupt[1024]! ^ 1;
  const candidates = [corrupt, archive(entry("safe", "ok"), entry("safe", "twice")),
    archive(entry("safe", "ok"), entry("next", "payload"))];
  for (const [index, bytes] of candidates.entries()) {
    await assert.rejects(strictTarExtractor.extract({ bytes, destination: join(dir, "slot"),
      ...(index === 2 ? { limits: { maxEntries: 2, maxTotalBytes: 3, maxPathLength: 100 } } : {}) }));
    await assert.rejects(stat(join(dir, "slot/safe")));
  }
});

test("a pre-existing symlinked parent cannot redirect writes outside the slot", async t => {
  const dir = await stage(t);
  await mkdir(join(dir, "outside"));
  await symlink(join(dir, "outside"), join(dir, "slot/bin"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(strictTarExtractor.extract({ bytes: archive(entry("bin/ats-runtime", "attack")),
    destination: join(dir, "slot") }));
  await assert.rejects(stat(join(dir, "outside/ats-runtime")));
});
