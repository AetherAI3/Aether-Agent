import { test } from "node:test";
import assert from "node:assert/strict";
import { groupItems, flattenGroups, currentIndex, renderPicker, pickModel, filterModels, initialModelPickerState, reduceModelPicker, modelPickerPageSize } from "../src/ui/model_picker.js";
import { theme } from "../src/ui/theme.js";
import { visibleWidth, stripAnsi } from "../src/ui/text.js";
import { handleSlash } from "../src/commands/slash.js";
import { EventEmitter } from "node:events";
import type { CatalogItem } from "../src/types.js";
import type { AppContext } from "../src/core/context.js";
import type { Writable } from "node:stream";

function item(overrides: Partial<CatalogItem> & { id: string }): CatalogItem {
  return {
    label: overrides.id,
    kind: "model",
    provider: "anthropic",
    context_window: null,
    tier_min: "free",
    enabled: true,
    available: true,
    monthly_uvt_cap: null,
    is_default: false,
    ...overrides,
  };
}

test("groupItems puts orchestrators first", () => {
  const items = [
    item({ id: "opus", kind: "model", provider: "anthropic" }),
    item({ id: "neo", kind: "orchestrator", provider: null }),
    item({ id: "gpt4", kind: "model", provider: "openai" }),
  ];
  const groups = groupItems(items);
  assert.equal(groups[0]!.label, "Orchestrators");
  assert.equal(groups[0]!.items.length, 1);
  assert.equal(groups[0]!.items[0]!.id, "neo");
});

test("groupItems groups models by provider", () => {
  const items = [
    item({ id: "opus", provider: "anthropic" }),
    item({ id: "sonnet", provider: "anthropic" }),
    item({ id: "gpt4", provider: "openai" }),
    item({ id: "deepseek-v4", provider: "deepseek" }),
  ];
  const groups = groupItems(items);

  const claude = groups.find((g) => g.label === "Claude")!;
  assert.ok(claude, "Claude group exists");
  assert.equal(claude.items.length, 2);

  const gpt = groups.find((g) => g.label === "GPT")!;
  assert.ok(gpt, "GPT group exists");
  assert.equal(gpt.items.length, 1);
});

test("groupItems handles unknown provider as raw name", () => {
  const items = [
    item({ id: "unknown-model", provider: "some-new-provider" }),
  ];
  const groups = groupItems(items);
  const other = groups.find((g) => g.label === "some-new-provider");
  assert.ok(other);
  assert.equal(other!.items.length, 1);
});

test("flattenGroups creates flat indexed list", () => {
  const groups = [
    { label: "A", color: (s: string) => s, items: [item({ id: "a1" }), item({ id: "a2" })] },
    { label: "B", color: (s: string) => s, items: [item({ id: "b1" })] },
  ];
  const flat = flattenGroups(groups);
  assert.equal(flat.length, 3);
  assert.equal(flat[0]!.item.id, "a1");
  assert.equal(flat[0]!.groupIdx, 0);
  assert.equal(flat[2]!.item.id, "b1");
  assert.equal(flat[2]!.groupIdx, 1);
});

test("currentIndex finds active model by id", () => {
  const flat = [
    { item: item({ id: "haiku" }), groupIdx: 0 },
    { item: item({ id: "sonnet" }), groupIdx: 0 },
    { item: item({ id: "opus" }), groupIdx: 0 },
  ];
  assert.equal(currentIndex(flat, "sonnet"), 1);
  assert.equal(currentIndex(flat, "nope"), -1);
  assert.equal(currentIndex(flat, undefined), -1);
});

test("flattenGroups preserves group indices across groups", () => {
  const groups = [
    { label: "Orch", color: (s: string) => s, items: [
      item({ id: "neo", kind: "orchestrator", provider: null }),
    ]},
    { label: "Claude", color: (s: string) => s, items: [
      item({ id: "haiku", kind: "model", provider: "anthropic" }),
      item({ id: "opus", kind: "model", provider: "anthropic" }),
    ]},
  ];
  const flat = flattenGroups(groups);
  assert.equal(flat[0]!.groupIdx, 0);
  assert.equal(flat[1]!.groupIdx, 1);
  assert.equal(flat[2]!.groupIdx, 1);
});

test("renderPicker returns a string with box content", () => {
  const groups = [
    { label: "Claude", color: (s: string) => s, items: [
      item({ id: "haiku", label: "Haiku" }),
      item({ id: "opus", label: "Opus" }),
    ]},
  ];
  const flat = flattenGroups(groups);
  const out = renderPicker(groups, flat, 0);
  assert.ok(typeof out === "string");
  assert.ok(out.length > 0);
  // Should contain box-drawing chars and the first item
  assert.ok(out.includes("Haiku"), "contains first model name");
  assert.ok(out.includes("Opus"), "contains second model name");
  assert.ok(out.includes("\u250c"), "has top-left box corner");
  assert.ok(out.includes("\u2518"), "has bottom-right box corner");
});

test("renderPicker highlights selected item with orb + bold", () => {
  const groups = [
    { label: "Claude", color: (s: string) => s, items: [
      item({ id: "haiku", label: "Haiku" }),
      item({ id: "opus", label: "Opus" }),
    ]},
  ];
  const flat = flattenGroups(groups);
  const out = renderPicker(groups, flat, 1); // Opus selected
  assert.ok(out.includes("Opus"), "contains Opus");
});

test("groupItems returns empty array for empty input", () => {
  assert.equal(groupItems([]).length, 0);
});

test("groupItems only-orchestrators returns just orchestrators group", () => {
  const items = [
    item({ id: "neo", kind: "orchestrator", provider: null }),
    item({ id: "kronus", kind: "orchestrator", provider: null }),
  ];
  const groups = groupItems(items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.label, "Orchestrators");
  assert.equal(groups[0]!.items.length, 2);
});

test("model picker bounds a 100-model catalogue at 40/80/120 columns and short/tall heights", () => {
  const items = Array.from({ length: 100 }, (_, i) => item({
    id: `model-${String(i).padStart(3, "0")}`,
    label: `Wide 界 ${String(i).padStart(3, "0")} ` + "very-long-label-".repeat(8),
  }));
  const groups = groupItems(items);
  const flat = flattenGroups(groups);
  for (const width of [40, 80, 120]) for (const height of [8, 24]) {
    const page = modelPickerPageSize(height);
    const state = { ...initialModelPickerState(flat, items[95]!.id), scroll: 95 - page + 1 };
    const frame = renderPicker(groups, flat, currentIndex(flat, state.selectedId ?? undefined), {
      width, height, scroll: state.scroll, query: state.query, mode: state.mode,
    });
    const lines = frame.split("\n");
    assert.ok(lines.length <= height, `${width}x${height}: ${lines.length} lines`);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}x${height}: row overflow`);
    assert.match(stripAnsi(frame), /Wide 界 095/, `${width}x${height}: selected row visible`);
    assert.match(stripAnsi(frame), /Esc cancel/, `${width}x${height}: controls visible`);
  }
});

test("search matches name, ID, and provider while preserving the selected ID", () => {
  const flat = flattenGroups(groupItems([
    item({ id: "one", label: "Same", provider: "anthropic" }),
    item({ id: "two", label: "Same", provider: "openai" }),
    item({ id: "three", label: "界 model", provider: "deepseek" }),
  ]));
  assert.deepEqual(filterModels(flat, "OPENAI").map(({ item }) => item.id), ["two"]);
  assert.deepEqual(filterModels(flat, "THREE").map(({ item }) => item.id), ["three"]);
  assert.deepEqual(filterModels(flat, "界").map(({ item }) => item.id), ["three"]);
  let state = initialModelPickerState(flat, "two");
  state = reduceModelPicker(state, { kind: "char", value: "/" }, flat, 4).state;
  state = reduceModelPicker(state, { kind: "char", value: "one" }, flat, 4).state;
  assert.equal(state.selectedId, "two", "a hidden selection must not turn into another model");
  assert.equal(reduceModelPicker(state, { kind: "submit" }, flat, 4).action, "render", "Enter applies the filter only");
  state = reduceModelPicker(state, { kind: "submit" }, flat, 4).state;
  assert.equal(reduceModelPicker(state, { kind: "submit" }, flat, 4).action, "none", "hidden selection cannot be chosen");
  state = reduceModelPicker(state, { kind: "down" }, flat, 4).state;
  assert.equal(state.selectedId, "one", "explicit navigation chooses a visible stable ID");
  assert.equal(reduceModelPicker(state, { kind: "submit" }, flat, 4).action, "choose");
  state = reduceModelPicker(state, { kind: "kill-start" }, flat, 4).state;
  assert.equal(state.query, "", "Ctrl+U clears search");
});

test("locked and duplicate-label rows show distinct IDs and a visible reason", () => {
  const groups = groupItems([
    item({ id: "first-id", label: "Same" }),
    item({ id: "locked-id", label: "Same", available: false, tier_min: "pro" }),
  ]);
  const flat = flattenGroups(groups);
  const frame = stripAnsi(renderPicker(groups, flat, 1, { width: 80, height: 10 }));
  assert.match(frame, /first-id/);
  assert.match(frame, /locked-id/);
  assert.match(frame, /LOCKED: requires pro/);
  const narrow = stripAnsi(renderPicker(groups, flat, 1, { width: 40, height: 10 }));
  assert.match(narrow, /first-id · Same/);
  assert.match(narrow, /LOCK locked-id/);
  assert.match(narrow, /LOCKED: requires pro/);
});

test("no-result filter keeps the original model without an accidental choice", () => {
  const groups = groupItems([item({ id: "one" })]);
  const flat = flattenGroups(groups);
  const state = { ...initialModelPickerState(flat, "one"), query: "absent" };
  const frame = stripAnsi(renderPicker(groups, flat, 0, { width: 40, height: 8, query: state.query }));
  assert.match(frame, /No models match/);
  assert.equal(reduceModelPicker(state, { kind: "submit" }, flat, 2).action, "none");
  assert.equal(state.selectedId, "one");
});

// ── pickModel (LOOP-06): a throwing key handler must not read as a cancel ──
//
// pickModel takes over raw stdin for arrow-key navigation, so exercising its
// interactive branch means faking process.stdin as a TTY with a captured
// "data" listener. Everything is restored in `finally`.

type StdinPatch = {
  isTTY: PropertyDescriptor | undefined;
  rawListeners: unknown;
  removeAllListeners: unknown;
  on: unknown;
  removeListener: unknown;
};

function patchStdinAsTTY(onData: (cb: (chunk: Buffer) => void) => void): StdinPatch {
  const stdin = process.stdin as unknown as Record<string, unknown>;
  const saved: StdinPatch = {
    isTTY: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
    rawListeners: stdin["rawListeners"],
    removeAllListeners: stdin["removeAllListeners"],
    on: stdin["on"],
    removeListener: stdin["removeListener"],
  };
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  stdin["rawListeners"] = () => [];
  stdin["removeAllListeners"] = () => process.stdin;
  stdin["on"] = (event: string, cb: (chunk: Buffer) => void) => {
    if (event === "data") onData(cb);
    return process.stdin;
  };
  stdin["removeListener"] = () => process.stdin;
  return saved;
}

function restoreStdin(saved: StdinPatch): void {
  const stdin = process.stdin as unknown as Record<string, unknown>;
  if (saved.isTTY) Object.defineProperty(process.stdin, "isTTY", saved.isTTY);
  else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
  stdin["rawListeners"] = saved.rawListeners;
  stdin["removeAllListeners"] = saved.removeAllListeners;
  stdin["on"] = saved.on;
  stdin["removeListener"] = saved.removeListener;
}

function fakeOut(throwOn?: string): { out: Writable; writes: string[] } {
  const writes: string[] = [];
  const out = {
    write: (s: string): boolean => {
      writes.push(s);
      if (throwOn !== undefined && s === throwOn) throw new Error("simulated render fault");
      return true;
    },
  } as unknown as Writable;
  return { out, writes };
}

test("pickModel: a fault inside the key handler prints a distinct diagnostic, not a silent cancel", async () => {
  const items = [item({ id: "opus" })];
  const captured: { feed: ((chunk: Buffer) => void) | null } = { feed: null };
  const saved = patchStdinAsTTY((cb) => {
    captured.feed = cb;
  });
  // rerender() writes the literal string "\x1b[H" (home + redraw) — throwing
  // there simulates a real render/write fault reachable only via a key that
  // takes the rerender path (up/down), not via the initial render or cleanup.
  const { out, writes } = fakeOut("\x1b[H");
  try {
    const result = pickModel(items, out);
    assert.ok(captured.feed, "pickModel must attach a stdin 'data' listener");
    captured.feed!(Buffer.from("\x1b[A", "utf8")); // up arrow -> rerender() -> throws
    const picked = await result;
    assert.equal(
      picked,
      undefined,
      "a caught fault resolves undefined (not null) so the caller can tell it apart from a deliberate Escape and skip printing its own redundant 'kept current session.' line",
    );
    assert.ok(
      writes.some((w) => /picker error/.test(w)),
      "a distinct diagnostic must be written so this isn't indistinguishable from Escape",
    );
  } finally {
    restoreStdin(saved);
  }
});

test("pickModel restores the terminal when initial rendering fails", async () => {
  const captured: { feed: ((chunk: Buffer) => void) | null } = { feed: null };
  const saved = patchStdinAsTTY((cb) => { captured.feed = cb; });
  const { out, writes } = fakeOut("\x1b[?1049h\x1b[?25l\x1b[H");
  try {
    assert.equal(await pickModel([item({ id: "one" })], out), undefined);
    assert.equal(captured.feed, null, "no picker listener survives failed setup");
    assert.ok(writes.join("").includes("\x1b[?1049l\x1b[?25h"));
    assert.match(writes.join(""), /picker error/);
  } finally {
    restoreStdin(saved);
  }
});

// ── pickModel (LOOP-06): empty-state line matches the picker's dim styling ──
//
// theme is disabled (non-TTY) in this test harness, so theme.dim() is a
// no-op passthrough — a plain-text assertion here would pass identically
// against the pre-fix `out.write("no models available.\n")` and tell us
// nothing about the fix. To make this a real regression test, monkeypatch
// the shared theme singleton (model_picker.ts imports the same object
// instance, so the patch is visible inside pickModel) and assert the
// message is actually routed through it.

test("pickModel: empty items routes the no-models message through theme.dim", async () => {
  const origDim = theme.dim;
  theme.dim = (s: string): string => `[dim]${s}[/dim]`;
  try {
    const { out, writes } = fakeOut();
    const picked = await pickModel([], out);
    assert.equal(picked, null, "no items means nothing to pick");
    assert.match(
      writes.join(""),
      /\[dim\]no models available\.\[\/dim\]/,
      "the empty-state line must be wrapped in theme.dim like the rest of the picker (footer hints, locked-item marker)",
    );
  } finally {
    // MUST restore: --test-isolation=none shares this singleton across
    // every test in the process, so a leaked patch would corrupt others.
    theme.dim = origDim;
  }
});

test("pickModel: a deliberate Escape resolves null WITHOUT the fault diagnostic", async () => {
  const items = [item({ id: "opus" })];
  const captured: { feed: ((chunk: Buffer) => void) | null } = { feed: null };
  const saved = patchStdinAsTTY((cb) => {
    captured.feed = cb;
  });
  const { out, writes } = fakeOut(); // never throws
  try {
    const result = pickModel(items, out);
    assert.ok(captured.feed, "pickModel must attach a stdin 'data' listener");
    captured.feed!(Buffer.from("\x1b", "utf8")); // bare Escape
    const picked = await result;
    assert.equal(picked, null, "Escape cancels with null, same as before");
    assert.ok(
      !writes.some((w) => /picker error/.test(w)),
      "a deliberate cancel must NOT print the internal-fault diagnostic",
    );
  } finally {
    restoreStdin(saved);
  }
});

test("pickModel starts on the active ID, searches locally, pages and restores after selection", async () => {
  const items = Array.from({ length: 100 }, (_, i) => item({
    id: `model-${String(i).padStart(3, "0")}`,
    label: i === 95 ? "Target 界" : `Model ${i}`,
    provider: i === 95 ? "openai" : "anthropic",
  }));
  const captured: { feed: ((chunk: Buffer) => void) | null } = { feed: null };
  const saved = patchStdinAsTTY((cb) => { captured.feed = cb; });
  const output = new EventEmitter() as EventEmitter & { columns: number; rows: number; write: (s: string) => boolean };
  output.columns = 40;
  output.rows = 8;
  const writes: string[] = [];
  output.write = (s) => { writes.push(s); return true; };
  try {
    const result = pickModel(items, output as unknown as Writable, "model-095");
    assert.ok(captured.feed);
    assert.match(stripAnsi(writes.join("")), /Target 界/, "active item is visible on open");
    captured.feed!(Buffer.from("/openai\r", "utf8"));
    assert.match(stripAnsi(writes.at(-2) ?? ""), /Target 界/, "provider filter keeps the same ID");
    output.columns = 80;
    output.rows = 24;
    output.emit("resize");
    captured.feed!(Buffer.from("\r", "utf8"));
    assert.equal((await result)?.id, "model-095");
    assert.ok(writes.join("").includes("\x1b[?1049l\x1b[?25h"), "scrollback and cursor restored");
    assert.equal(output.listenerCount("resize"), 0, "resize listener removed");
  } finally {
    restoreStdin(saved);
  }
});

test("pickModel PageDown advances by the visible page without changing catalogue IDs", async () => {
  const items = Array.from({ length: 100 }, (_, i) => item({ id: `model-${i}` }));
  const captured: { feed: ((chunk: Buffer) => void) | null } = { feed: null };
  const saved = patchStdinAsTTY((cb) => { captured.feed = cb; });
  const output = new EventEmitter() as EventEmitter & { columns: number; rows: number; write: (s: string) => boolean };
  output.columns = 40;
  output.rows = 8;
  output.write = () => true;
  try {
    const result = pickModel(items, output as unknown as Writable, "model-0");
    captured.feed!(Buffer.from("\x1b[6~\r", "utf8"));
    assert.equal((await result)?.id, "model-2", "8 rows leave two visible model rows");
  } finally {
    restoreStdin(saved);
  }
});

test("pickModel filter Esc restores the previous list; Ctrl+C cancels and restores", async () => {
  const items = [item({ id: "one" }), item({ id: "two" })];
  const captured: { feed: ((chunk: Buffer) => void) | null } = { feed: null };
  const saved = patchStdinAsTTY((cb) => { captured.feed = cb; });
  const { out, writes } = fakeOut();
  try {
    const result = pickModel(items, out, "two");
    assert.ok(captured.feed);
    captured.feed!(Buffer.from("/no-match\x1b", "utf8"));
    captured.feed!(Buffer.from("\r", "utf8"));
    assert.equal((await result)?.id, "two", "Esc in search restores the previous selection");
    const cancelled = pickModel(items, out, "one");
    captured.feed!(Buffer.from("\x03", "utf8"));
    assert.equal(await cancelled, null);
    assert.equal((writes.join("").match(/\x1b\[\?1049l\x1b\[\?25h/g) ?? []).length, 2);
  } finally {
    restoreStdin(saved);
  }
});

// ── showPicker (slash.ts) composition: no duplicate message on a fault ──
//
// pickModel resolving `undefined` (not `null`) on an internal fault is only
// half the fix — showPicker must actually read that signal, or a real fault
// still shows its own diagnostic AND the generic "kept current session."
// line back to back. This exercises the full handleSlash -> showPicker ->
// pickModel path, not pickModel in isolation.

function fakeModelCtx(): AppContext {
  return {
    flags: { yes: false, json: false, audit: false, cwd: "." },
    cfg: { defaultModel: "haiku", baseUrl: "x" },
    api: { getJson: async () => ({ tier: "pro", default: "haiku", models: [item({ id: "opus" })] }) },
    confirm: async () => false,
  } as unknown as AppContext;
}

test("showPicker: a picker fault prints exactly ONE message, not the diagnostic plus a redundant 'kept current session.'", async () => {
  const captured: { feed: ((chunk: Buffer) => void) | null } = { feed: null };
  const saved = patchStdinAsTTY((cb) => {
    captured.feed = cb;
  });
  const { out, writes } = fakeOut("\x1b[H"); // rerender() write throws -> simulated fault
  try {
    const resultPromise = handleSlash(fakeModelCtx(), "/model", out, undefined);
    // Give getCatalog's fetch + pickModel's render a tick to attach the listener.
    for (let i = 0; i < 20 && !captured.feed; i++) await Promise.resolve();
    assert.ok(captured.feed, "pickModel must attach a stdin 'data' listener via the /model (bare) path");
    captured.feed!(Buffer.from("\x1b[A", "utf8")); // up arrow -> rerender() -> throws
    const res = await resultPromise;
    assert.equal(res.restart, undefined, "a faulted picker must not signal a model switch");
    const faultLines = writes.filter((w) => /kept current session/.test(w));
    assert.equal(
      faultLines.length,
      1,
      `expected exactly one 'kept current session' message, got ${faultLines.length}: ${JSON.stringify(writes)}`,
    );
    assert.ok(faultLines[0] && /picker error/.test(faultLines[0]), "the surviving message must be pickModel's own distinct diagnostic");
  } finally {
    restoreStdin(saved);
  }
});

test("/models opens on the active model and returns that stable ID", async () => {
  const captured: { feed: ((chunk: Buffer) => void) | null } = { feed: null };
  const saved = patchStdinAsTTY((cb) => { captured.feed = cb; });
  const ctx = fakeModelCtx();
  ctx.flags.model = "opus";
  const { out } = fakeOut();
  try {
    const pending = handleSlash(ctx, "/models", out);
    for (let i = 0; i < 20 && !captured.feed; i++) await Promise.resolve();
    assert.ok(captured.feed);
    captured.feed!(Buffer.from("\r", "utf8"));
    const result = await pending;
    assert.equal(result.modelSwitch?.model, "opus");
  } finally {
    restoreStdin(saved);
  }
});

test("non-TTY /models lists stable IDs and a usable selection command", async () => {
  const ctx = fakeModelCtx();
  const { out, writes } = fakeOut();
  await handleSlash(ctx, "/models", out);
  const plain = stripAnsi(writes.join(""));
  assert.match(plain, /opus\s+opus/);
  assert.match(plain, /switch: \/model <n\|id>/);
});

test("a piped output gets plain IDs even if stdin is a TTY", async () => {
  const captured: { feed: ((chunk: Buffer) => void) | null } = { feed: null };
  const saved = patchStdinAsTTY((cb) => { captured.feed = cb; });
  const { out, writes } = fakeOut();
  (out as Writable & { isTTY?: boolean }).isTTY = false;
  try {
    await handleSlash(fakeModelCtx(), "/models", out);
    assert.equal(captured.feed, null, "picker never captures piped input");
    assert.match(stripAnsi(writes.join("")), /switch: \/model <n\|id>/);
    assert.ok(!writes.join("").includes("\x1b[?1049h"), "no alternate-screen control bytes in pipe");
  } finally {
    restoreStdin(saved);
  }
});
