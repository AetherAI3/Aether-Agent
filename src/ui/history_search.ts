// Pure reverse search over prompt history already loaded for one workspace.
// It never reads storage or runs a model/process. Entries remain complete for
// acceptance; only the examination and terminal display are bounded.
import { HISTORY_CAP } from "../core/history_store.js";
import { sliceVisible, visibleWidth } from "./text.js";

export const HISTORY_SEARCH_BOUNDS = {
  entryBytes: 16 * 1024,
  totalBytes: 1024 * 1024,
  queryBytes: 256,
  displayChars: 512,
} as const;

export interface HistorySearchState {
  readonly entries: readonly string[];
  readonly priorValue: string;
  readonly priorCursor: number;
  readonly query: string;
  readonly matches: readonly number[];
  readonly selected: number;
  readonly skippedOversize: number;
  readonly skippedBudget: number;
  readonly disabled: boolean;
}

function search(state: HistorySearchState, query: string): HistorySearchState {
  const matches: number[] = [];
  let examined = 0;
  let skippedOversize = 0;
  let skippedBudget = 0;
  const countRemainder = (through: number): void => {
    for (let i = through; i >= 0; i--) {
      if (state.entries[i]!.length > HISTORY_SEARCH_BOUNDS.entryBytes) skippedOversize++;
      else skippedBudget++;
    }
  };
  for (let index = state.entries.length - 1; index >= 0; index--) {
    const entry = state.entries[index]!;
    // Check the JS length first so a hostile giant entry is never traversed
    // just to calculate its byte size. Shorter Unicode entries get a byte cap.
    if (entry.length > HISTORY_SEARCH_BOUNDS.entryBytes) { skippedOversize++; continue; }
    if (examined + entry.length > HISTORY_SEARCH_BOUNDS.totalBytes) {
      countRemainder(index);
      break;
    }
    const bytes = Buffer.byteLength(entry, "utf8");
    if (bytes > HISTORY_SEARCH_BOUNDS.entryBytes) { skippedOversize++; continue; }
    if (examined + bytes > HISTORY_SEARCH_BOUNDS.totalBytes) {
      countRemainder(index);
      break;
    }
    examined += bytes;
    if (entry.includes(query)) matches.push(index);
  }
  return { ...state, query, matches, selected: 0, skippedOversize, skippedBudget };
}

/** Empty query selects the newest examinable entry, then Ctrl+R walks older. */
export function openHistorySearch(entries: readonly string[], priorValue: string, priorCursor: number, disabled = false): HistorySearchState {
  return search({ entries: disabled ? [] : entries.slice(-HISTORY_CAP), priorValue, priorCursor,
    query: "", matches: [], selected: 0, skippedOversize: 0, skippedBudget: 0, disabled }, "");
}

export function typeHistoryQuery(state: HistorySearchState, input: string): HistorySearchState {
  let query = state.query;
  for (const ch of input) {
    if (Buffer.byteLength(query + ch, "utf8") > HISTORY_SEARCH_BOUNDS.queryBytes) break;
    query += ch;
  }
  return search(state, query);
}

export function backspaceHistoryQuery(state: HistorySearchState): HistorySearchState {
  return search(state, [...state.query].slice(0, -1).join(""));
}

/** Stops at the oldest match; it does not wrap invisibly. */
export function olderHistoryMatch(state: HistorySearchState): HistorySearchState {
  return { ...state, selected: Math.min(state.selected + 1, Math.max(0, state.matches.length - 1)) };
}

export function selectedHistoryMatch(state: HistorySearchState): string | null {
  const index = state.matches[state.selected];
  return index === undefined ? null : state.entries[index] ?? null;
}

function safeDisplay(value: string): string {
  return value.replace(/\r\n|\r|\n/g, "⏎").replace(/[\x00-\x1f\x7f]/g, "�");
}

function matchPreview(value: string, width: number): string {
  const chars = [...safeDisplay(value)];
  const capped = chars.slice(0, HISTORY_SEARCH_BOUNDS.displayChars).join("");
  if (chars.length <= HISTORY_SEARCH_BOUNDS.displayChars && visibleWidth(capped) <= width) return capped;
  const marker = "… [clipped]";
  return sliceVisible(capped, Math.max(0, width - visibleWidth(marker))) + marker;
}

/** At most two terminal rows, with an explicit clipped/skipped indication. */
export function renderHistorySearch(state: HistorySearchState, cols: number, rows: number): string[] {
  if (rows < 2) return [];
  const width = Math.max(1, cols - 1);
  const query = safeDisplay(state.query) || "(newest)";
  const selected = selectedHistoryMatch(state);
  const status = state.disabled ? "history disabled" : selected === null ? "no match" : `${state.selected + 1}/${state.matches.length}`;
  const skipped = state.skippedOversize + state.skippedBudget;
  const note = skipped ? `skipped ${skipped} (${state.skippedOversize} oversized, ${state.skippedBudget} budget) · ` : "";
  const header = `  Ctrl+R ${note}${query} · ${status}`;
  if (rows === 2) {
    const compact = `R ${sliceVisible(query, Math.max(1, Math.floor(width / 4)))} ${status}${skipped ? ` skip ${skipped}` : ""} · `;
    if (selected === null) return [sliceVisible(compact + "no match", width)];
    return [sliceVisible(compact + matchPreview(selected, Math.max(0, width - visibleWidth(compact))), width)];
  }
  if (selected === null) return [sliceVisible(header, width), sliceVisible("  No matching prompts · Esc restores draft", width)];
  const shown = `> ${matchPreview(selected, Math.max(0, width - 2))}`;
  return [sliceVisible(header, width), sliceVisible(shown, width)];
}
