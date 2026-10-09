import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHistory, appendHistory, historyPath } from "../src/core/history_store.js";

const fresh = (): string => join(mkdtempSync(join(tmpdir(), "aether-hist-")), "history");

test("round-trips entries oldest-first and survives a missing file", () => {
  const p = fresh();
  assert.deepEqual(loadHistory(p), []); // no file yet
  appendHistory("first", p);
  appendHistory("second", p);
  assert.deepEqual(loadHistory(p), ["first", "second"]);
  rmSync(join(p, ".."), { recursive: true, force: true });
});

test("workspace paths load separate prompt histories", () => {
  const first = mkdtempSync(join(tmpdir(), "aether-hist-workspace-"));
  const second = mkdtempSync(join(tmpdir(), "aether-hist-workspace-"));
  try {
    const firstPath = historyPath(first);
    const secondPath = historyPath(second);
    assert.notEqual(firstPath, secondPath);
    appendHistory("first workspace only", firstPath);
    assert.deepEqual(loadHistory(firstPath), ["first workspace only"]);
    assert.deepEqual(loadHistory(secondPath), []);
  } finally {
    rmSync(historyPath(first), { force: true });
    rmSync(historyPath(second), { force: true });
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("consecutive duplicates collapse; blanks are never stored", () => {
  const p = fresh();
  appendHistory("same", p);
  appendHistory("same", p);
  appendHistory("   ", p);
  appendHistory("other", p);
  appendHistory("same", p); // non-consecutive repeat IS kept
  assert.deepEqual(loadHistory(p), ["same", "other", "same"]);
});

test("multi-line submissions stay one row per entry and decode back", () => {
  const p = fresh();
  appendHistory("line one\nline two", p);
  appendHistory("plain", p);
  const raw = readFileSync(p, "utf8");
  assert.equal(raw.trim().split("\n").length, 2); // newline was encoded
  assert.deepEqual(loadHistory(p), ["line one\nline two", "plain"]);
});

test("load caps to the newest entries", () => {
  const p = fresh();
  for (let i = 0; i < 30; i++) appendHistory(`cmd ${i}`, p);
  const got = loadHistory(p, 10);
  assert.equal(got.length, 10);
  assert.equal(got[0], "cmd 20");
  assert.equal(got[9], "cmd 29");
});

test("file compacts once it drifts well past the cap", () => {
  const p = fresh();
  for (let i = 0; i < 25; i++) appendHistory(`c${i}`, p);
  const rows = readFileSync(p, "utf8").trim().split("\n");
  assert.ok(rows.length <= 25);
  appendHistory("trigger", p, 10); // 25 ≥ 2*10 → compact to 10
  const after = readFileSync(p, "utf8").trim().split("\n");
  assert.ok(after.length <= 10, `expected compaction, got ${after.length} rows`);
  assert.equal(after[after.length - 1], "trigger");
});
