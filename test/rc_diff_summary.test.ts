import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkoutDiffSummary } from "../src/core/rc/diff_summary.js";
import { createOutbox, enqueueEvent } from "../src/core/rc/outbox.js";
import { diffSummaryEvent } from "../src/core/rc/producers.js";
import type { Runner } from "../src/core/worktree.js";
import { tmpWorkspace } from "./tmp_workspace.js";

const haveGit = !spawnSync("git", ["--version"], { encoding: "utf8" }).error;

test("RC publishes measured changed, clean, and binary checkout snapshots", async (t) => {
  if (!haveGit) return t.skip("git not available");
  const dir = tmpWorkspace("aether-rc-diff-");
  const git = (...args: string[]): void => {
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "image.bin"), Buffer.from([0, 1, 2]));
  git("add", "-A");
  git("commit", "-q", "-m", "first");

  const clean = await checkoutDiffSummary(dir);
  assert.deepEqual(clean?.payload, { files_changed: 0, insertions: 0, deletions: 0, files: [] });

  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  const changed = await checkoutDiffSummary(dir);
  assert.deepEqual(changed?.payload, { files_changed: 1, insertions: 1, deletions: 0, files: ["a.txt"] });

  writeFileSync(join(dir, "image.bin"), Buffer.from([0, 1, 9]));
  const binary = await checkoutDiffSummary(dir);
  assert.equal(binary?.payload["files_changed"], 2);
  assert.deepEqual(binary?.payload["files"], ["a.txt", "image.bin"]);
  assert.equal(binary?.payload["insertions"], undefined, "binary line counts are unknown");
  assert.equal(binary?.payload["deletions"], undefined);

  const record = createOutbox({ session_id: "s", project_ref: "p", device_id: "d", epoch: 1, project_root: dir });
  assert.equal(enqueueEvent(record, binary!.event_type, binary!.payload), true);
  assert.deepEqual(record.events[0]?.payload["files"], ["a.txt", "image.bin"]);
});

test("external paths are refused before durable enqueue", async () => {
  const root = "C:/checkout";
  const run: Runner = (_cmd, args) => args.includes("rev-parse")
    ? { status: 0, stdout: `${root}\n`, stderr: "" }
    : { status: 0, stdout: "? /outside/secret.txt\0", stderr: "" };
  assert.equal(await checkoutDiffSummary(root, run), null);
  const record = createOutbox({ session_id: "s", project_ref: "p", device_id: "d", epoch: 1, project_root: root });
  const unsafe = diffSummaryEvent({ additions: 1, deletions: 0, uncounted: [] }, ["/outside/secret.txt"]);
  assert.equal(enqueueEvent(record, unsafe.event_type, unsafe.payload), false);
  assert.equal(record.events.length, 0);
});

test("a failed numstat read never becomes a measured zero", async () => {
  const root = "C:/checkout";
  const run: Runner = (_cmd, args) => args.includes("rev-parse")
    ? { status: 0, stdout: `${root}\n`, stderr: "" }
    : { status: 0, stdout: "? new.txt\0", stderr: "" };
  const event = await checkoutDiffSummary(root, run, async () => ({ status: 1, stdout: "", stderr: "unavailable" }));
  assert.deepEqual(event?.payload, { files_changed: 1, files: ["new.txt"] });
});
