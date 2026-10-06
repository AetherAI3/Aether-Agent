// src/ui/model_picker.ts — interactive model/orchestrator picker.
// Renders a boxed, provider-grouped menu with arrow-key navigation.
// Takes over stdin temporarily during selection, then restores the REPL listener.

import type { CatalogItem } from "../types.js";
import type { Writable } from "node:stream";
import { theme } from "./theme.js";
import { orange, green, darkBlue, brightWhite, lightBlue, box } from "./box.js";
import { decodeKey, splitKeys, type Key } from "./keys.js";
import { registerRestore } from "./restore.js";
import { sanitizeTerm, sliceVisible, visibleWidth } from "./text.js";

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const CURSOR_SHOW = "\x1b[?25h";

// ── Provider grouping ──────────────────────────

export interface ModelGroup {
  /** Display label for the group header. */
  label: string;
  /** ANSI color function for the group header. */
  color: (s: string) => string;
  /** Items in this group. */
  items: CatalogItem[];
}

/** Map provider strings to display groups. Orchestrators always come first. */
export function groupItems(items: CatalogItem[]): ModelGroup[] {
  const orchItems = items.filter((m) => m.kind === "orchestrator");
  const modelItems = items.filter((m) => m.kind !== "orchestrator");

  const providerMap: Record<string, CatalogItem[]> = {};
  for (const m of modelItems) {
    const p = m.provider ?? "other";
    (providerMap[p] ??= []).push(m);
  }

  const groups: ModelGroup[] = [];

  if (orchItems.length) {
    groups.push({
      label: "Orchestrators",
      color: theme.cyan,
      items: orchItems,
    });
  }

  const PROVIDER_CONFIG: Record<string, { label: string; color: (s: string) => string }> = {
    anthropic: { label: "Claude",   color: orange },
    openai:    { label: "GPT",      color: green },
    deepseek:  { label: "DeepSeek", color: darkBlue },
    moonshot:  { label: "Kimi",     color: brightWhite },
    google:    { label: "Gemma",    color: lightBlue },
  };

  const sortedProviders = Object.keys(providerMap).sort((a, b) => {
    const aOrder = Object.keys(PROVIDER_CONFIG).indexOf(a);
    const bOrder = Object.keys(PROVIDER_CONFIG).indexOf(b);
    if (aOrder === -1 && bOrder === -1) return a.localeCompare(b);
    if (aOrder === -1) return 1;
    if (bOrder === -1) return -1;
    return aOrder - bOrder;
  });

  for (const p of sortedProviders) {
    const cfg = PROVIDER_CONFIG[p];
    groups.push({
      label: cfg?.label ?? p,
      color: cfg?.color ?? theme.dim,
      items: providerMap[p]!,
    });
  }

  return groups;
}

/** Flatten groups into a single array for index-based navigation. */
export function flattenGroups(groups: ModelGroup[]): { item: CatalogItem; groupIdx: number }[] {
  const flat: { item: CatalogItem; groupIdx: number }[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    for (const item of groups[gi]!.items) {
      flat.push({ item, groupIdx: gi });
    }
  }
  return flat;
}

/** Find the index of the currently-active model in the flat list (-1 if not found). */
export function currentIndex(
  flat: { item: CatalogItem }[],
  active: string | undefined,
): number {
  return active ? flat.findIndex((f) => f.item.id === active) : -1;
}

// ── Rendering ─────────────────────────────────

type FlatItem = { item: CatalogItem; groupIdx: number };

export interface ModelPickerState {
  mode: "list" | "filter";
  query: string;
  /** Stable catalogue identity, even while a filter hides the selected row. */
  selectedId: string | null;
  scroll: number;
  savedQuery: string | null;
}

export interface ModelPickerRenderOptions {
  width?: number;
  height?: number;
  query?: string;
  scroll?: number;
  mode?: "list" | "filter";
}

/** Search only the fetched list; catalogue IDs never change with filtering. */
export function filterModels(flat: readonly FlatItem[], query: string): FlatItem[] {
  const q = sanitizeTerm(query).trim().toLowerCase();
  if (!q) return [...flat];
  return flat.filter(({ item }) =>
    [item.label, item.id, item.provider ?? ""]
      .some((part) => sanitizeTerm(part).toLowerCase().includes(q)));
}

export function modelPickerPageSize(height: number): number {
  // Border, title, search, selected-detail, and controls always stay visible.
  return Math.max(1, height - 6);
}

export function initialModelPickerState(flat: readonly FlatItem[], activeId?: string): ModelPickerState {
  const selectedId = activeId && flat.some(({ item }) => item.id === activeId)
    ? activeId : flat[0]?.item.id ?? null;
  return { mode: "list", query: "", selectedId, scroll: 0, savedQuery: null };
}

function visibleIndex(state: ModelPickerState, rows: readonly FlatItem[]): number {
  return rows.findIndex(({ item }) => item.id === state.selectedId);
}

function settle(state: ModelPickerState, rows: readonly FlatItem[], page: number): ModelPickerState {
  const index = visibleIndex(state, rows);
  const maxScroll = Math.max(0, rows.length - page);
  let scroll = Math.max(0, Math.min(maxScroll, state.scroll));
  if (index >= 0 && index < scroll) scroll = index;
  if (index >= scroll + page) scroll = index - page + 1;
  return { ...state, scroll };
}

export type ModelPickerAction = "none" | "render" | "choose" | "cancel";

export function reduceModelPicker(
  state: ModelPickerState,
  key: Key,
  flat: readonly FlatItem[],
  page: number,
): { state: ModelPickerState; action: ModelPickerAction } {
  if (key.kind === "interrupt" || key.kind === "eof") return { state, action: "cancel" };
  const rows = filterModels(flat, state.query);
  const move = (delta: number): { state: ModelPickerState; action: ModelPickerAction } => {
    const index = visibleIndex(state, rows);
    const next = index < 0 ? (delta < 0 ? rows.length - 1 : 0)
      : Math.max(0, Math.min(rows.length - 1, index + delta));
    return { state: settle({ ...state, selectedId: rows[next]?.item.id ?? state.selectedId }, rows, page), action: "render" };
  };
  if (state.mode === "filter") {
    switch (key.kind) {
      case "char": {
        const query = sanitizeTerm(state.query + key.value);
        return { state: settle({ ...state, query, scroll: 0 }, filterModels(flat, query), page), action: "render" };
      }
      case "backspace": {
        const query = [...state.query].slice(0, -1).join("");
        return { state: settle({ ...state, query, scroll: 0 }, filterModels(flat, query), page), action: "render" };
      }
      case "kill-start":
        return { state: settle({ ...state, query: "", scroll: 0 }, flat, page), action: "render" };
      case "submit":
        return { state: { ...state, mode: "list", savedQuery: null }, action: "render" };
      case "escape": {
        const query = state.savedQuery ?? "";
        return { state: settle({ ...state, mode: "list", query, savedQuery: null, scroll: 0 }, filterModels(flat, query), page), action: "render" };
      }
      default:
        return { state, action: "none" };
    }
  }
  switch (key.kind) {
    case "up": return move(-1);
    case "down": return move(1);
    case "home": return { state: settle({ ...state, selectedId: rows[0]?.item.id ?? state.selectedId }, rows, page), action: "render" };
    case "end": return { state: settle({ ...state, selectedId: rows.at(-1)?.item.id ?? state.selectedId }, rows, page), action: "render" };
    case "submit": return { state, action: visibleIndex(state, rows) < 0 ? "none" : "choose" };
    case "escape": return { state, action: "cancel" };
    case "kill-start": return { state: settle({ ...state, query: "", scroll: 0 }, flat, page), action: "render" };
    case "char":
      if (key.value === "/") return { state: { ...state, mode: "filter", savedQuery: state.query }, action: "render" };
      return { state, action: "none" };
    default: return { state, action: "none" };
  }
}

function clipped(value: string, width: number): string {
  if (width <= 0) return "";
  const clean = sanitizeTerm(value).replace(/\s+/g, " ").trim();
  return visibleWidth(clean) <= width ? clean : sliceVisible(clean, Math.max(0, width - 1)) + "…";
}

function selectedDetail(item: CatalogItem | undefined): string {
  if (!item) return "Move to a result to select it";
  const lock = item.available ? "" : item.enabled
    ? `LOCKED: requires ${item.tier_min ?? "account access"} · `
    : "LOCKED: provider unavailable · ";
  return `${lock}ID ${item.id}`;
}

/** A bounded frame: every row fits the measured terminal width and height. */
export function renderPicker(
  _groups: ModelGroup[],
  flat: FlatItem[],
  selectedIdx: number,
  opts: ModelPickerRenderOptions = {},
): string {
  const width = Math.max(6, Math.min(opts.width ?? 64, 100));
  const height = Math.max(3, opts.height ?? 24);
  const rows = filterModels(flat, opts.query ?? "");
  const selected = flat[selectedIdx]?.item;
  const selectedVisible = rows.findIndex(({ item }) => item.id === selected?.id);
  const page = modelPickerPageSize(height);
  const scroll = Math.max(0, Math.min(Math.max(0, rows.length - page), opts.scroll ?? 0));
  const inner = width - 6;
  const compact = width < 68;
  const lines: string[] = [];
  lines.push(theme.bold(clipped(`Select Model · ${rows.length}/${flat.length}`, inner)));
  const query = sanitizeTerm(opts.query ?? "");
  lines.push(theme.cyan(clipped(`Search ${query || "(press /)"}${opts.mode === "filter" ? "▌" : ""}`, inner)));
  if (rows.length === 0) {
    lines.push(theme.dim(clipped("No models match. Backspace or Ctrl+U clears search.", inner)));
  } else {
    for (let i = scroll; i < Math.min(rows.length, scroll + page); i++) {
      const item = rows[i]!.item;
      const active = i === selectedVisible;
      const marker = active ? ">" : " ";
      const lock = item.available ? "" : " [locked]";
      const label = sanitizeTerm(item.label).replace(/\s+/g, " ").trim();
      const id = sanitizeTerm(item.id).replace(/\s+/g, " ").trim();
      let body: string;
      if (compact) {
        body = clipped(`${marker} ${label} · ${id}${lock}`, inner);
      } else {
        const provider = sanitizeTerm(item.provider ?? "");
        const left = clipped(`${marker} ${label}${provider ? ` · ${provider}` : ""}${lock}`, Math.floor(inner * 0.58));
        const right = clipped(id, inner - visibleWidth(left) - 1);
        body = left + " ".repeat(Math.max(1, inner - visibleWidth(left) - visibleWidth(right))) + right;
      }
      lines.push(active ? theme.bold(body) : body);
    }
  }
  // Keep the footer visible even when there are no results. On very short
  // terminals omit detail before ever allowing a wrapped or off-screen row.
  if (height >= 7) lines.push(theme.dim(clipped(selectedDetail(selectedVisible < 0 ? undefined : selected), inner)));
  lines.push(theme.dim(clipped(opts.mode === "filter"
    ? compact ? "type · Enter apply · Esc back · ^U clear" : "Type to filter · Enter apply · Esc restore · Ctrl+U clear"
    : compact ? "↑↓ / search ↵ pick Esc cancel" : "↑↓ move · PgUp/PgDn page · / search · Enter select · Esc cancel", inner)));
  if (height < 7) return lines.slice(0, height).map((line) => clipped(line, width)).join("\n");
  return box(lines, { width });
}

// ── Interactive picker ────────────────────────

/**
 * Launch an interactive model/orchestrator picker.
 *
 * Temporarily removes the REPL's data listener, renders the menu,
 * processes arrow keys, and returns the selected item; null on a deliberate
 * cancel (Escape/no models/non-TTY) — the caller is expected to print its own
 * "kept current session" message for null. Returns undefined on an internal
 * key-handler fault: this function has ALREADY written its own distinct
 * diagnostic in that case, so the caller must NOT also print a generic
 * message (that used to produce two back-to-back lines for one failure).
 * Restores the REPL listener before resolving.
 */
export async function pickModel(
  items: CatalogItem[],
  out: Writable,
  activeId?: string,
): Promise<CatalogItem | null | undefined> {
  if (items.length === 0) {
    out.write(theme.dim("no models available.") + "\n");
    return null;
  }

  // In non-TTY mode (pipe, CI), arrow-key navigation is impossible.
  // Degrade gracefully: return null so the caller can fall back to a flat list.
  if (!process.stdin.isTTY || (out as Writable & { isTTY?: boolean }).isTTY === false ||
      (out === process.stdout && !process.stdout.isTTY)) {
    return null;
  }

  const groups = groupItems(items);
  const flat = flattenGroups(groups);
  if (flat.length === 0) {
    out.write(theme.dim("no models available.") + "\n");
    return null;
  }

  // Save and remove existing stdin listeners (the REPL's onData)
  const oldListeners = process.stdin.rawListeners("data");
  process.stdin.removeAllListeners("data");

  let state = initialModelPickerState(flat, activeId);
  const dimensions = (): { width: number; height: number } => {
    const terminal = out as Writable & { columns?: number; rows?: number };
    return {
      width: terminal.columns ?? process.stdout.columns ?? 64,
      height: terminal.rows ?? process.stdout.rows ?? 24,
    };
  };
  const frame = (): string => {
    const { width, height } = dimensions();
    const selectedIdx = currentIndex(flat, state.selectedId ?? undefined);
    return renderPicker(groups, flat, selectedIdx, {
      width, height, query: state.query, scroll: state.scroll, mode: state.mode,
    });
  };
  state = settle(state, flat, modelPickerPageSize(dimensions().height));

  // Alt-screen, not 2J: the user's scrollback (the conversation they're
  // mid-way through) survives the picker and reappears on exit.
  const unregister = registerRestore(() => {
    out.write(ALT_OFF + CURSOR_SHOW);
  });
  try {
    out.write(ALT_ON + "\x1b[?25l\x1b[H");
    out.write(frame() + "\n");
  } catch {
    unregister();
    for (const l of oldListeners) process.stdin.on("data", l as (...args: unknown[]) => void);
    try { out.write(ALT_OFF + CURSOR_SHOW); } catch { /* output failed */ }
    try { out.write(theme.dim("  picker error — kept current session.") + "\n"); } catch { /* output failed */ }
    return undefined;
  }

  return new Promise((resolve) => {
    let done = false;
    // Returns true when the picker is finished (resolved) and onKey must stop.
    const handleOne = (k: Key): boolean => {
      const { height } = dimensions();
      const step = reduceModelPicker(state, k, flat, modelPickerPageSize(height));
      state = step.state;
      switch (step.action) {
        case "choose": {
          const picked = filterModels(flat, state.query).find(({ item }) => item.id === state.selectedId);
          finish(picked?.item ?? null);
          return true;
        }
        case "cancel":
          finish(null);
          return true;
        case "render":
          rerender();
          return false;
        default:
          return false;
      }
    };

    const onKey = (chunk: Buffer): void => {
      try {
        // Tokenize: held-arrow key-repeat arrives as one batched chunk.
        for (const seq of splitKeys(chunk.toString("utf8"))) {
          if (seq === "\x1b[5~" || seq === "\x1b[6~") {
            const rows = filterModels(flat, state.query);
            const index = visibleIndex(state, rows);
            const page = modelPickerPageSize(dimensions().height);
            const direction = seq === "\x1b[5~" ? -1 : 1;
            const next = index < 0 ? (direction < 0 ? rows.length - 1 : 0)
              : Math.max(0, Math.min(rows.length - 1, index + direction * page));
            state = settle({ ...state, selectedId: rows[next]?.item.id ?? state.selectedId }, rows, page);
            rerender();
            continue;
          }
          const key = decodeKey(seq);
          const keys: Key[] = key.kind === "char"
            ? [...key.value].map((value): Key => ({ kind: "char", value })) : [key];
          for (const one of keys) if (handleOne(one)) return;
        }
      } catch {
        // If anything throws in the key handler (render, decode), bail out
        // and restore the REPL listeners so the session isn't bricked. Write
        // a distinct diagnostic first, then resolve undefined (not null) so
        // the caller (slash.ts's showPicker) can tell this apart from a
        // deliberate Escape and skip ITS OWN generic "kept current session."
        // message — resolving null there produced two back-to-back lines
        // for a single fault.
        finish(undefined);
        try { out.write(theme.dim("  picker error — kept current session.") + "\n"); } catch { /* output failed */ }
      }
    };

    const rerender = (): void => {
      // Home + redraw + erase-below: stale rows can't survive a shrinking menu.
      out.write("\x1b[H");
      out.write(frame());
      out.write("\n\x1b[0J");
    };

    const cleanup = (): void => {
      unregister();
      process.stdin.removeListener("data", onKey);
      out.removeListener?.("resize", onResize);
      // Re-attach the REPL's original listeners
      for (const l of oldListeners) {
        process.stdin.on("data", l as (...args: unknown[]) => void);
      }
      try { out.write(ALT_OFF + CURSOR_SHOW); } catch { /* output already failed */ }
    };

    const finish = (value: CatalogItem | null | undefined): void => {
      if (done) return;
      done = true;
      try { cleanup(); } finally { resolve(value); }
    };

    const onResize = (): void => {
      try {
        const rows = filterModels(flat, state.query);
        state = settle(state, rows, modelPickerPageSize(dimensions().height));
        rerender();
      } catch {
        finish(undefined);
        try { out.write(theme.dim("  picker error — kept current session.") + "\n"); } catch { /* output failed */ }
      }
    };

    try {
      process.stdin.on("data", onKey);
      out.on?.("resize", onResize);
    } catch {
      finish(undefined);
      try { out.write(theme.dim("  picker error — kept current session.") + "\n"); } catch { /* output failed */ }
    }
  });
}
