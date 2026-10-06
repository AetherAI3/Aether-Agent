// RC diff_summary production (#218): measured checkout snapshots that Cloud's
// display/1 contract accepts.
//
// The defect this file pins: a diff_summary that omitted `insertions` or
// `deletions` (binary, untracked or failed reads) is a Cloud 400, and a 400
// keeps the whole batch in the outbox, so every later event wedged behind it —
// including `rc start`'s opening batch. Every emitted payload below is checked
// against a local copy of Cloud's validator, and the untracked and binary cases
// are cross-checked against git's own numstat once the files are staged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cmdRc, projectRefFor, rcOutboxPath } from "../src/commands/rc.js";
import type { CommandFlags } from "../src/core/command_dispatch.js";
import type { AppContext } from "../src/core/context.js";
import { CHECK_ATTR_ARGV_CHARS, readCountAttributes, type AsyncRunner } from "../src/core/diff_counts.js";
import { checkoutDiffSummary } from "../src/core/rc/diff_summary.js";
import { createOutbox, enqueueEvent, loadOutbox } from "../src/core/rc/outbox.js";
import { diffSummaryEvent, type RcProducedEvent } from "../src/core/rc/producers.js";
import { payloadDigest } from "../src/core/rc/receipts.js";
import type { Runner } from "../src/core/worktree.js";
import { tmpWorkspace } from "./tmp_workspace.js";

const haveGit = !spawnSync("git", ["--version"], { encoding: "utf8" }).error;

// ── Cloud display/1 contract (local copy; kept in this file on purpose) ─────
//
// Mirrors AETHER-CLOUD lib/remote_session/contracts.py validate_event_payload:
// exact opening keys, allowlisted display keys, REQUIRED display keys, bounded
// counts and project-relative file identifiers. The allowlist itself comes from
// the shared golden fixture so it cannot drift from the Agent's sanitizer pin.

const DISPLAY_FIXTURE = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "rc-display-v1.json"),
  "utf8",
)) as { payload_keys: Record<string, string[]> };

const CLOUD_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  plan: ["title", "status"],
  subagent: ["subagent_id", "status"],
  tool_activity: ["tool", "status"],
  diff_summary: ["files_changed", "insertions", "deletions"],
  tests: ["status"],
  ci: ["provider", "status"],
  pr_status: ["state"],
  artifact: ["artifact_id", "kind", "title"],
  preview: ["phase", "instance_id"],
  done: ["status"],
  error: ["code", "message"],
};
const CLOUD_OPENING_KEYS: Readonly<Record<string, readonly string[]>> = {
  session: ["base_commit", "branch", "dirty_file_count", "protocol_version", "repo", "session_name", "state"],
  presence: ["device_id", "liveness", "protocol_version", "role"],
};
const CLOUD_COUNT_KEYS = new Set([
  "step", "total_steps", "files_changed", "insertions", "deletions", "passed", "failed", "skipped", "number",
]);
const CONTROL = /[\u0000-\u001f\u007f]/;

function identifierViolation(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > max) return "not a bounded identifier";
  if (CONTROL.test(value)) return "not a single-line identifier";
  if (/^[/\\~]/.test(value) || /^[A-Za-z]:[\\/]/.test(value)) return "absolute local path";
  return null;
}

/** The reason Cloud would answer 400 for this event, or null when it accepts it. */
function cloudContractViolation(eventType: string, payload: Record<string, unknown>): string | null {
  const opening = CLOUD_OPENING_KEYS[eventType];
  if (opening) {
    const keys = Object.keys(payload).sort().join(",");
    return keys === opening.join(",") ? null : `${eventType} opening keys are ${keys}`;
  }
  const allowed = DISPLAY_FIXTURE.payload_keys[eventType];
  if (!allowed) return `no display projection for ${eventType}`;
  if (payload["projection_version"] !== "1") return "projection_version must be \"1\"";
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) return `key not allowlisted: ${key}`;
  for (const key of CLOUD_REQUIRED[eventType] ?? []) {
    if (!(key in payload)) return `missing required key: ${key}`;
    if (payload[key] === "") return `empty required key: ${key}`;
  }
  for (const [key, value] of Object.entries(payload)) {
    if (key === "projection_version") continue;
    if (key === "files") {
      if (!Array.isArray(value) || value.length > 64) return "files must be a bounded list";
      for (const path of value) {
        const violation = identifierViolation(path, 512);
        if (violation) return `files: ${violation}`;
        if ((path as string).replaceAll("\\", "/").split("/").includes("..")) return "files: traversal";
      }
    } else if (CLOUD_COUNT_KEYS.has(key)) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return `${key} must be a bounded count`;
    } else if (typeof value !== "string" || value.length > 512 || CONTROL.test(value)) {
      return `${key} must be a bounded single-line string`;
    }
  }
  if (cloudCanonicalBytes(payload) > 32 * 1024) return "payload too large";
  return null;
}

/**
 * Cloud sizes `canonical_json` (json.dumps ensure_ascii=True): every UTF-16
 * unit at or above 0x80 is a six-byte `\uXXXX` escape there, not 2-4 UTF-8
 * bytes. Key order and separators do not change the length.
 */
function cloudCanonicalBytes(payload: Record<string, unknown>): number {
  let bytes = 0;
  for (const char of JSON.stringify(payload).split("")) bytes += char.charCodeAt(0) < 0x80 ? 1 : 6;
  return bytes;
}

/** The payload as the durable outbox stores it, or null when enqueue refuses it. */
function persisted(event: RcProducedEvent, projectRoot = "/repo"): Record<string, unknown> | null {
  const record = createOutbox({ session_id: "s", project_ref: "p", device_id: "d", epoch: 1, project_root: projectRoot });
  return enqueueEvent(record, event.event_type, event.payload) ? record.events[0]!.payload : null;
}

/** Every produced diff_summary must survive enqueue AND satisfy Cloud. */
function assertAccepted(event: RcProducedEvent | null, projectRoot?: string): Record<string, unknown> {
  assert.ok(event, "expected a measured diff_summary");
  assert.equal(event.event_type, "diff_summary");
  const payload = persisted(event, projectRoot);
  assert.ok(payload, "the outbox refused a produced diff_summary");
  assert.equal(cloudContractViolation(event.event_type, payload), null);
  return payload;
}

// ── fixtures ────────────────────────────────────────────────────────────────

interface Checkout {
  dir: string;
  git(...args: string[]): void;
}

function checkout(prefix: string): Checkout {
  const dir = tmpWorkspace(prefix);
  const git = (...args: string[]): void => {
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  return { dir, git };
}

const STATUS_HASH = "0".repeat(40);
/** A porcelain v2 ordinary entry, the shape `git status -z` prints. */
function ordinary(code: string, path: string): string {
  return `1 ${code} N... 100644 100644 100644 ${STATUS_HASH} ${STATUS_HASH} ${path}\0`;
}

function stubRunner(root: string, status: string): Runner {
  return (_cmd, args) => args.includes("rev-parse")
    ? { status: 0, stdout: `${root}\n`, stderr: "" }
    : { status: 0, stdout: status, stderr: "" };
}

function stubAsync(numstat: { staged: string; unstaged: string }, checkAttr?: (paths: string[]) => string | null): AsyncRunner {
  return async (_cmd, args) => {
    if (args.includes("check-attr")) {
      const paths = args.slice(args.indexOf("--") + 1);
      const out = checkAttr ? checkAttr(paths) : paths.map((path) =>
        ["diff", "filter", "working-tree-encoding"].map((name) => `${path}\0${name}\0unspecified\0`).join("")).join("");
      return out === null ? { status: 128, stdout: "", stderr: "fatal" } : { status: 0, stdout: out, stderr: "" };
    }
    return { status: 0, stdout: args.includes("--cached") ? numstat.staged : numstat.unstaged, stderr: "" };
  };
}

// ── measured snapshots through the real diff-count path ─────────────────────

test("a clean checkout publishes a measured zero, never an omitted count", async (t) => {
  if (!haveGit) return t.skip("git not available");
  const { dir, git } = checkout("aether-rc-diff-clean-");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");

  const clean = await checkoutDiffSummary(dir);
  assert.deepEqual(clean?.payload, { projection_version: "1", files_changed: 0, insertions: 0, deletions: 0, files: [] });
  assert.deepEqual(assertAccepted(clean, dir), { projection_version: "1", files_changed: 0, insertions: 0, deletions: 0 });
});

test("a changed text file publishes git's numstat counts", async (t) => {
  if (!haveGit) return t.skip("git not available");
  const { dir, git } = checkout("aether-rc-diff-changed-");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\nfour\n");

  const changed = await checkoutDiffSummary(dir);
  assert.deepEqual(assertAccepted(changed, dir),
    { projection_version: "1", files_changed: 1, insertions: 2, deletions: 1, files: ["a.txt"] });
});

test("a binary file is a changed file with zero lines, alone or beside text", async (t) => {
  if (!haveGit) return t.skip("git not available");
  const { dir, git } = checkout("aether-rc-diff-binary-");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "image.bin"), Buffer.from([0, 1, 2]));
  git("add", "-A");
  git("commit", "-q", "-m", "first");

  writeFileSync(join(dir, "image.bin"), Buffer.from([0, 1, 9]));
  assert.deepEqual(assertAccepted(await checkoutDiffSummary(dir), dir),
    { projection_version: "1", files_changed: 1, insertions: 0, deletions: 0, files: ["image.bin"] });

  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  assert.deepEqual(assertAccepted(await checkoutDiffSummary(dir), dir),
    { projection_version: "1", files_changed: 2, insertions: 1, deletions: 0, files: ["a.txt", "image.bin"] });

  // One measured text side plus one binary side: the text row's lines stand,
  // the binary row contributes none. Nothing is dropped and nothing invented.
  git("restore", "image.bin");
  git("add", "a.txt");
  writeFileSync(join(dir, "a.txt"), Buffer.from([0, 1, 9]));
  assert.deepEqual(assertAccepted(await checkoutDiffSummary(dir), dir),
    { projection_version: "1", files_changed: 1, insertions: 1, deletions: 0, files: ["a.txt"] });
});

test("untracked files are counted exactly as git counts them once staged", async (t) => {
  if (!haveGit) return t.skip("git not available");
  const { dir, git } = checkout("aether-rc-diff-untracked-");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, ".gitattributes"), "*.dat -diff\nforced.txt diff\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");

  writeFileSync(join(dir, "a.txt"), "one\ntwo\n"); // tracked: +1
  writeFileSync(join(dir, "new.txt"), "x\ny\nz"); // no final newline: 3 lines
  writeFileSync(join(dir, "empty.txt"), ""); // 0 lines
  writeFileSync(join(dir, "crlf.txt"), "a\r\nb\r\n"); // 2 lines
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 10, 10])); // binary
  writeFileSync(join(dir, "late-nul.txt"), Buffer.concat([Buffer.alloc(8001, 0x61), Buffer.from([0, 10])])); // text to git
  writeFileSync(join(dir, "attr.dat"), "p\nq\n"); // -diff: binary to git
  writeFileSync(join(dir, "forced.txt"), Buffer.from([0, 0x61, 10, 0x62, 10])); // diff set: text, 2 lines
  mkdirSync(join(dir, "dir"));
  writeFileSync(join(dir, "dir", "nested.txt"), "n\n"); // 1 line

  const untracked = assertAccepted(await checkoutDiffSummary(dir), dir);
  assert.deepEqual(untracked, {
    projection_version: "1",
    files_changed: 9,
    insertions: 1 + 3 + 0 + 2 + 1 + 2 + 1,
    deletions: 0,
    files: ["a.txt", "attr.dat", "blob.bin", "crlf.txt", "dir/nested.txt", "empty.txt", "forced.txt", "late-nul.txt", "new.txt"],
  });

  // Ground truth: the same tree once git itself measures every path.
  git("add", "-A");
  assert.deepEqual(assertAccepted(await checkoutDiffSummary(dir), dir), untracked);
});

test("an untracked file that cannot be counted drops the summary instead of under-stating it", async (t) => {
  if (!haveGit) return t.skip("git not available");
  const { dir, git } = checkout("aether-rc-diff-limits-");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");

  writeFileSync(join(dir, "big.txt"), "x".repeat(40) + "\n");
  assert.ok(await checkoutDiffSummary(dir), "positive control: countable within default bounds");
  assert.equal(await checkoutDiffSummary(dir, undefined, undefined, { maxFileBytes: 16 }), null, "too large to count");
  assert.equal(await checkoutDiffSummary(dir, undefined, undefined, { maxTotalBytes: 16 }), null, "snapshot byte budget");

  writeFileSync(join(dir, "second.txt"), "y\n");
  assert.equal(await checkoutDiffSummary(dir, undefined, undefined, { maxUntrackedFiles: 1 }), null, "too many new files");
  rmSync(join(dir, "big.txt"));
  rmSync(join(dir, "second.txt"));

  // A binary file over the byte bound is still binary: git's own probe reads
  // only the first 8000 bytes, so the bound never turns it into "unknown".
  writeFileSync(join(dir, "large.bin"), Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 0x61)]));
  assert.deepEqual(assertAccepted(await checkoutDiffSummary(dir, undefined, undefined, { maxFileBytes: 16 }), dir),
    { projection_version: "1", files_changed: 1, insertions: 0, deletions: 0, files: ["large.bin"] });
});

test("an external-path worktree is refused through the real count path", async (t) => {
  if (!haveGit) return t.skip("git not available");
  const { dir, git } = checkout("aether-rc-diff-external-");
  const outside = tmpWorkspace("aether-rc-diff-outside-");
  writeFileSync(join(outside, "secret.txt"), "private\nprivate\n");
  writeFileSync(join(dir, "a.txt"), "one\n");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "b.txt"), "b\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");

  // A project root nested inside a larger checkout: git's paths are relative
  // to a toplevel outside the project, so nothing is published.
  assert.equal(await checkoutDiffSummary(join(dir, "sub")), null);

  // A junction (a plain directory link elsewhere) is never followed out of the
  // checkout. Git for Windows walks INTO it and reports `linked/secret.txt` as
  // an ordinary untracked file, so only the real-path containment check stands
  // between the counter and a file outside the project; elsewhere git reports
  // the link itself, which is not a regular file. Either way: no summary.
  assert.ok(await checkoutDiffSummary(dir), "positive control before the link exists");
  symlinkSync(outside, join(dir, "linked"), "junction");
  assert.equal(await checkoutDiffSummary(dir), null);
  rmSync(join(dir, "linked"), { recursive: false, force: true });
  assert.ok(await checkoutDiffSummary(dir), "positive control after the link is gone");

  let fileLink = true;
  try {
    symlinkSync(join(outside, "secret.txt"), join(dir, "secret-link.txt"), "file");
  } catch {
    fileLink = false; // Windows without symlink privilege; the junction case above still ran
  }
  if (fileLink) assert.equal(await checkoutDiffSummary(dir), null, "a file symlink is never followed");
});

test("absolute or traversal paths from status are refused before durable enqueue", async () => {
  const root = tmpWorkspace("aether-rc-diff-stub-");
  const run = stubRunner(root, "? /outside/secret.txt\0");
  assert.equal(await checkoutDiffSummary(root, run, stubAsync({ staged: "", unstaged: "" })), null);
  const traversal = stubRunner(root, ordinary(".M", "../private.txt"));
  assert.equal(await checkoutDiffSummary(root, traversal, stubAsync({ staged: "", unstaged: "0\t1\t../private.txt\0" })), null);

  const record = createOutbox({ session_id: "s", project_ref: "p", device_id: "d", epoch: 1, project_root: root });
  const unsafe = diffSummaryEvent({ additions: 1, deletions: 0, uncounted: [] }, ["/outside/secret.txt"]);
  assert.equal(enqueueEvent(record, unsafe.event_type, unsafe.payload), false);
  assert.equal(record.events.length, 0);
});

test("a top-level path Cloud reads as a home path is refused before durable enqueue", async (t) => {
  // Cloud's `_rc_identifier` refuses ANY leading "~", not just "~/". An Office
  // lock file at the checkout root is enough: `~$Report.docx` used to reach the
  // outbox, Cloud answered 400, and the batch wedged everything behind it.
  if (!haveGit) return t.skip("git not available");
  const { dir, git } = checkout("aether-rc-diff-tilde-");
  writeFileSync(join(dir, "a.txt"), "one\n");
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "~$nested.docx"), "lock\n"); // not leading: an ordinary path
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  writeFileSync(join(dir, "docs", "~$nested.docx"), "lock\nmore\n");
  assert.deepEqual(assertAccepted(await checkoutDiffSummary(dir), dir),
    { projection_version: "1", files_changed: 1, insertions: 1, deletions: 0, files: ["docs/~$nested.docx"] });

  writeFileSync(join(dir, "~$Report.docx"), "lock\n");
  const produced = await checkoutDiffSummary(dir);
  assert.ok(produced === null || cloudContractViolation("diff_summary", persisted(produced, dir) ?? {}) === null,
    "whatever is produced, Cloud must accept it");
  assert.equal(produced, null, "the whole snapshot is refused, as for any path Cloud would not accept");

  for (const path of ["~$Report.docx", "~", "~user/notes.md"]) {
    assert.equal(persisted(diffSummaryEvent({ additions: 1, deletions: 0, uncounted: [] }, [path])), null, path);
  }
});

test("the files sample fits the frame as Cloud measures it, so a long non-ASCII listing never wedges", async () => {
  // Cloud measures 32 KiB of ensure_ascii JSON, where each non-ASCII UTF-16
  // unit costs six bytes. 64 paths of 150 CJK characters are ~29 KiB of UTF-8
  // but ~58 KiB to Cloud: the Agent used to enqueue them and Cloud answered 400.
  const root = tmpWorkspace("aether-rc-diff-wide-");
  const paths = Array.from({ length: 64 }, (_, index) => `${String(index).padStart(2, "0")}${"文".repeat(150)}.txt`);
  const run = stubRunner(root, paths.map((path) => ordinary(".M", path)).join(""));
  const numstat = stubAsync({ staged: "", unstaged: paths.map((path) => `1\t0\t${path}\0`).join("") });

  const payload = assertAccepted(await checkoutDiffSummary(root, run, numstat), root);
  assert.equal(payload["files_changed"], 64, "every changed path is still counted");
  assert.equal(payload["insertions"], 64);
  const listed = payload["files"] as string[];
  assert.ok(listed.length > 0 && listed.length < 64, `a bounded sample is listed (${listed.length})`);
  assert.deepEqual(listed, paths.slice(0, listed.length), "the sample is a prefix of the sorted paths");

  // The outbox itself measures as Cloud does, whoever the producer is.
  const oversized = diffSummaryEvent({ additions: 64, deletions: 0, uncounted: [] }, paths);
  assert.ok(Buffer.byteLength(JSON.stringify(oversized.payload), "utf8") < 32 * 1024, "small in UTF-8");
  assert.equal(persisted(oversized, root), null, "refused, because Cloud would answer 400");
});

test("a failed numstat or attribute read never becomes a measured zero", async () => {
  const root = tmpWorkspace("aether-rc-diff-failed-");
  writeFileSync(join(root, "new.txt"), "a\nb\n");
  const run = stubRunner(root, "? new.txt\0");
  const healthy = stubAsync({ staged: "", unstaged: "" });
  assert.deepEqual(assertAccepted(await checkoutDiffSummary(root, run, healthy), root),
    { projection_version: "1", files_changed: 1, insertions: 2, deletions: 0, files: ["new.txt"] });

  const numstatDown: AsyncRunner = async () => ({ status: 1, stdout: "", stderr: "unavailable" });
  assert.equal(await checkoutDiffSummary(root, run, numstatDown), null);
  const attributesDown = stubAsync({ staged: "", unstaged: "" }, () => null);
  assert.equal(await checkoutDiffSummary(root, run, attributesDown), null);
  const attributesShort = stubAsync({ staged: "", unstaged: "" }, () => "");
  assert.equal(await checkoutDiffSummary(root, run, attributesShort), null, "an unanswered path is unknown");
  const converted = stubAsync({ staged: "", unstaged: "" }, (paths) => paths.map((path) =>
    `${path}\0diff\0unspecified\0${path}\0filter\0lfs\0${path}\0working-tree-encoding\0unspecified\0`).join(""));
  assert.equal(await checkoutDiffSummary(root, run, converted), null, "a clean filter changes what git would count");

  const tracked = stubRunner(root, ordinary(".M", "a.txt"));
  assert.equal(await checkoutDiffSummary(root, tracked, healthy), null, "a changed path git did not measure is unknown");
});

test("attribute reads stay inside the Windows command line and fail closed", async () => {
  const paths = Array.from({ length: 200 }, (_, index) => `deep/${"d".repeat(300)}/file-${index}.txt`);
  const calls: string[][] = [];
  const answer: AsyncRunner = async (_cmd, args) => {
    const asked = args.slice(args.indexOf("--") + 1);
    calls.push(asked);
    const out = asked.map((path, index) => `${path}\0diff\0${index % 2 ? "unset" : "set"}\0` +
      `${path}\0filter\0unspecified\0${path}\0working-tree-encoding\0${index === 3 ? "UTF-16" : "unspecified"}\0`).join("");
    return { status: 0, stdout: out, stderr: "" };
  };
  const read = await readCountAttributes(answer, "/repo", paths);
  assert.ok(read);
  assert.ok(calls.length > 1, "the path list was split across calls");
  for (const asked of calls) {
    assert.ok(asked.reduce((sum, path) => sum + path.length + 1, 0) <= CHECK_ATTR_ARGV_CHARS);
  }
  assert.deepEqual(calls.flat(), paths, "every path is asked exactly once, in order");
  assert.deepEqual(read.get(paths[0]!), { diff: "text", converted: false });
  assert.deepEqual(read.get(paths[1]!), { diff: "binary", converted: false });
  assert.deepEqual(read.get(paths[3]!), { diff: "binary", converted: true });

  const reordered: AsyncRunner = async (cmd, args, cwd) => {
    const result = await answer(cmd, args, cwd);
    const [first, ...rest] = result.stdout.split("\0");
    return { ...result, stdout: [...rest.slice(0, 2), first, ...rest.slice(2)].join("\0") };
  };
  assert.equal(await readCountAttributes(reordered, "/repo", paths.slice(0, 2)), null, "output not matching argv is unknown");
});

test("renames count once, whichever side detected them", async () => {
  const root = tmpWorkspace("aether-rc-diff-rename-");
  const renamed = `2 R. N... 100644 100644 100644 ${STATUS_HASH} ${STATUS_HASH} R100 new.txt\0old.txt\0`;
  const detected = stubAsync({ staged: "1\t0\t\0old.txt\0new.txt\0", unstaged: "" });
  assert.deepEqual(assertAccepted(await checkoutDiffSummary(root, stubRunner(root, renamed), detected), root),
    { projection_version: "1", files_changed: 1, insertions: 1, deletions: 0, files: ["new.txt"] });

  // diff.renames=false: numstat splits what status paired. Both rows count.
  const split = stubAsync({ staged: "0\t3\told.txt\0" + "4\t0\tnew.txt\0", unstaged: "" });
  assert.deepEqual(assertAccepted(await checkoutDiffSummary(root, stubRunner(root, renamed), split), root),
    { projection_version: "1", files_changed: 1, insertions: 4, deletions: 3, files: ["new.txt"] });

  // status split what numstat paired: the origin is measured under the rename.
  const unpaired = ordinary("D.", "old.txt") + ordinary("A.", "new.txt");
  assert.deepEqual(assertAccepted(await checkoutDiffSummary(root, stubRunner(root, unpaired), detected), root),
    { projection_version: "1", files_changed: 2, insertions: 1, deletions: 0, files: ["new.txt", "old.txt"] });
});

test("the outbox refuses any diff_summary missing a count Cloud requires", () => {
  // The wedge itself: these payloads are Cloud 400s, so they must never reach
  // durable storage where a rejected batch blocks every later event.
  const complete: Record<string, unknown> = {
    projection_version: "1", files_changed: 1, insertions: 0, deletions: 0, files: ["a.txt"],
  };
  assert.ok(persisted({ event_type: "diff_summary", payload: complete }));
  for (const key of ["files_changed", "insertions", "deletions"]) {
    const missing = Object.fromEntries(Object.entries(complete).filter(([name]) => name !== key));
    assert.equal(persisted({ event_type: "diff_summary", payload: missing }), null, `${key} omitted`);
    for (const bad of [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(persisted({ event_type: "diff_summary", payload: { ...complete, [key]: bad } }), null, `${key}=${String(bad)}`);
    }
  }
  for (const counts of [{ additions: 0, deletions: 0 }, { additions: 7, deletions: 2 }]) {
    assert.equal(cloudContractViolation("diff_summary",
      persisted(diffSummaryEvent({ ...counts, uncounted: [] }, ["src/a.ts"]))!), null);
  }
});

test("rc start's opening batch with an untracked file is accepted by a contract-checking broker", async (t) => {
  if (!haveGit) return t.skip("git not available");
  const { dir, git } = checkout("aether-rc-diff-start-");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "notes.md"), "alpha\nbeta\ngamma\n"); // untracked

  const config = tmpWorkspace("aether-rc-diff-config-");
  const priorConfig = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = config;
  const sessionId = "rs_" + "2".repeat(32);
  const delivered: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
  const rejected: string[] = [];
  const errors: string[] = [];
  const api = {
    async postJson(path: string, body: unknown): Promise<unknown> {
      if (path === "/remote/sessions") return { session_id: sessionId, state: "pending_host" };
      if (path.endsWith("/host/attach")) return { session_id: sessionId, state: "live" };
      if (path.endsWith("/host/events")) {
        const events = (body as { events: Array<{ host_event_id: string; event_type: string; payload: Record<string, unknown> }> }).events;
        for (const event of events) {
          const violation = cloudContractViolation(event.event_type, event.payload);
          if (violation) {
            rejected.push(`${event.event_type}: ${violation}`);
            throw Object.assign(new Error("rejected"), { status: 400, detail: violation });
          }
        }
        const base = delivered.length;
        delivered.push(...events);
        return { session_id: sessionId, receipts: events.map((event, index) => ({
          host_event_id: event.host_event_id, seq: base + index + 1, payload_digest: payloadDigest(event.payload),
        })) };
      }
      if (path.endsWith("/grants")) return {
        session_id: sessionId, purpose: "observe", device_id: (body as { device_id: string }).device_id,
        token: "rsgt_" + "b".repeat(48), expires_at: new Date(Date.now() + 300_000).toISOString(),
      };
      throw new Error(`unexpected route ${path}`);
    },
  };
  const ctx = { api, flags: { cwd: dir, json: true } } as unknown as AppContext;
  const flags = { str: () => undefined } as unknown as CommandFlags;
  try {
    const code = await cmdRc(ctx, ["start"], flags, {
      cwd: dir,
      enrollment: () => ({ device_id: "dev-1", display_name: "test" }),
      repo: () => ({ repo: "fixture", branch: "main", base_commit: "0".repeat(40), dirty_file_count: 2 }),
      connector: () => null,
      browser: () => null,
      out: () => undefined,
      err: (value: string) => void errors.push(value),
      isTTY: false,
      columns: undefined,
    });
    assert.equal(code, 0);
    assert.deepEqual(rejected, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(delivered.map((event) => event.event_type), ["session", "presence", "diff_summary"]);
    assert.deepEqual(delivered[2]!.payload,
      { projection_version: "1", files_changed: 2, insertions: 4, deletions: 0, files: ["a.txt", "notes.md"] });
    const record = loadOutbox(rcOutboxPath(projectRefFor(dir)), dir);
    assert.equal(record.events.length, 0, "the opening batch was fully acknowledged, nothing is wedged");
    assert.equal(record.cursor, 3);
  } finally {
    if (priorConfig === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = priorConfig;
    rmSync(config, { recursive: true, force: true });
  }
});
