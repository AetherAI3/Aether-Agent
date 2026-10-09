import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_SEARCH_BOUNDS, backspaceHistoryQuery, olderHistoryMatch, openHistorySearch,
  renderHistorySearch, selectedHistoryMatch, typeHistoryQuery,
} from "../src/ui/history_search.js";

test("reverse search is newest-first, keeps duplicates, and stops at the oldest match", () => {
  let state = openHistorySearch(["écho\nline", "other", "écho\nline"], "draft", 2);
  assert.equal(selectedHistoryMatch(state), "écho\nline"); // empty query picks newest
  state = typeHistoryQuery(state, "écho");
  assert.deepEqual(state.matches, [2, 0]);
  state = olderHistoryMatch(state);
  assert.equal(state.selected, 1);
  state = olderHistoryMatch(state);
  assert.equal(state.selected, 1);
  state = backspaceHistoryQuery(state);
  assert.equal(state.query, "éch");
  assert.equal(state.selected, 0);
  assert.match(renderHistorySearch(state, 80, 24).join("\n"), /écho⏎line/);
});

test("no match and disabled history are visible without reading or changing drafts", () => {
  const state = typeHistoryQuery(openHistorySearch(["hello"], "kept", 1), "absent");
  assert.equal(selectedHistoryMatch(state), null);
  assert.match(renderHistorySearch(state, 80, 24).join("\n"), /no match|No matching prompts/);
  const disabled = openHistorySearch(["hidden"], "draft", 3, true);
  assert.equal(selectedHistoryMatch(disabled), null);
  assert.match(renderHistorySearch(disabled, 80, 24).join("\n"), /history disabled/);
  assert.equal(disabled.priorValue, "draft");
  assert.equal(disabled.priorCursor, 3);
});

test("oversized entries are skipped, work is bounded, and clipped display retains the full match", () => {
  const large = "L".repeat(HISTORY_SEARCH_BOUNDS.entryBytes + 1) + "needle";
  const full = "needle " + "🛰".repeat(300);
  const many = Array.from({ length: 80 }, (_, i) => `entry ${i} ` + "x".repeat(15_000));
  const state = typeHistoryQuery(openHistorySearch([large, ...many, full], "", 0), "needle");
  assert.equal(state.skippedOversize, 1);
  assert.ok(state.skippedBudget > 0);
  assert.equal(selectedHistoryMatch(state), full);
  const rendered = renderHistorySearch(state, 160, 24).join("\n");
  assert.match(rendered, /skipped/);
  assert.match(rendered, /\[clipped\]/);
  assert.ok(rendered.split("\n").every(line => [...line].length <= 160));
  assert.match(renderHistorySearch(state, 80, 2)[0]!, /\[clipped\]/);
  const capped = typeHistoryQuery(state, "q".repeat(1000));
  assert.ok(Buffer.byteLength(capped.query, "utf8") <= HISTORY_SEARCH_BOUNDS.queryBytes);
});
