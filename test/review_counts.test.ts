import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnAsyncRun } from "../src/commands/review_counts.js";

test("review runner reports an unavailable executable as 127 without an unhandled stream error", async () => {
  const result = await spawnAsyncRun()(join(tmpdir(), "aether-review-definitely-absent", "executable"), []);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(result.status, 127);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /ENOENT/);
});

test("review runner preserves fast child exit status and both outputs when the parent is delayed", () => {
  // Isolate scheduler injection and any unhandled error from the test process.
  // A delayed parent may resume after its child has already closed stdin. This
  // reproduces the scheduling race that surfaced under the full test workload.
  const moduleUrl = new URL("../src/commands/review_counts.js", import.meta.url).href;
  const script = `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    const realSpawn = childProcess.spawn;
    childProcess.spawn = (...args) => {
      const child = realSpawn(...args);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
      return child;
    };
    syncBuiltinESMExports();
    const { spawnAsyncRun } = await import(${JSON.stringify(moduleUrl)});
    const result = await spawnAsyncRun()(process.execPath, ["-e", "process.stdout.write('review-out'); process.stderr.write('review-err'); process.exitCode = 7;"]);
    await new Promise(resolve => setImmediate(resolve));
    process.stdout.write(JSON.stringify(result));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: 7, stdout: "review-out", stderr: "review-err" });
  assert.doesNotMatch(result.stderr, /EPIPE|Unhandled/);
});

test("review runner provides EOF to children that read stdin and retains zero exit", async () => {
  const result = await spawnAsyncRun()(process.execPath, ["-e", "process.stdin.on('data', () => { throw new Error('unexpected input'); }); process.stdin.on('end', () => process.stdout.write('EOF')); process.stdin.resume();"]);
  assert.deepEqual(result, { status: 0, stdout: "EOF", stderr: "" });
});
