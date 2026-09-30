import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import {
  AnimationController,
  sequenceFor,
  STAGE_MAP,
  type AnimationSink,
} from "../src/ui/animations.js";
import { HeartbeatIndicator } from "../src/ui/heartbeat.js";
import { computeRegions, TuiLayout } from "../src/ui/tui_layout.js";
import { stripAnsi } from "../src/ui/theme.js";
import { StatusRenderer } from "../src/ui/status_renderer.js";
import {
  mapBrainEvent,
  bindEventSource,
  LocalAgentSource,
  type AgentEvent,
  type AgentSource,
} from "../src/core/agent_events.js";

// --- animations: stage map + controller ------------------------------------
test("STAGE_MAP routes stages to sequences; unknown -> deep_strike", () => {
  assert.equal(STAGE_MAP["recon"], "radar");
  assert.equal(STAGE_MAP["error"], "kernel_panic");
  assert.equal(sequenceFor("totally-unknown").mode, "loop"); // deep_strike fallback
});

test("AnimationController renders a frame on setStage and freezes on stall", () => {
  const frames: Array<[string, string]> = [];
  const sink: AnimationSink = { onFrame: (s, a) => frames.push([s, a]) };
  const anim = new AnimationController(sink);
  anim.setStage("execute");
  assert.ok(frames.length >= 1, "first frame rendered synchronously");
  assert.equal(frames[0]![0], "execute");
  anim.markStalled();
  const last = frames[frames.length - 1]!;
  assert.match(last[1], /waiting/, "stall freezes with a waiting suffix");
  anim.stop();
});

test("one-shot stage renders static, no loop", () => {
  const frames: Array<[string, string]> = [];
  const anim = new AnimationController({ onFrame: (s, a) => frames.push([s, a]) });
  anim.setStage("reveal");
  assert.equal(frames.length, 1, "one-shot renders exactly one frame");
  anim.stop();
});

test("setProgress forwards to onProgress", () => {
  let got: [number, number] | null = null;
  const anim = new AnimationController({ onFrame: () => {}, onProgress: (u, c) => (got = [u, c]) });
  anim.setProgress(100, 500);
  assert.deepEqual(got, [100, 500]);
  anim.stop();
});

// --- heartbeat -------------------------------------------------------------
test("heartbeat: one beat reaches the peak then returns to rest", async () => {
  const seen: string[] = [];
  let hb: HeartbeatIndicator;
  await new Promise<void>((resolve, reject) => {
    let peaked = false;
    const timeout = setTimeout(() => reject(new Error("heartbeat did not settle")), 500);
    hb = new HeartbeatIndicator({
      frameMs: 1,
      onFrame: (glyph) => {
        seen.push(glyph);
        if (glyph === "◉") peaked = true;
        if (peaked && glyph === "·") {
          clearTimeout(timeout);
          resolve();
        }
      },
    });
    hb.beat();
  });
  assert.ok(seen.includes("◉"), "beat reaches the peak glyph");
  assert.equal(hb!.glyph(), "·", "rests between beats");
  hb!.stop();
});

test("heartbeat: stall shows hollow; next beat clears it", () => {
  const hb = new HeartbeatIndicator({ frameMs: 1 });
  hb.markStalled();
  assert.equal(hb.glyph(), "○");
  hb.beat();
  assert.notEqual(hb.glyph(), "○");
  hb.stop();
});

test("heartbeat: counts each beat and reports it to onFrame (thinking timer)", () => {
  const counts: number[] = [];
  const hb = new HeartbeatIndicator({ onFrame: (_g, beats) => counts.push(beats), frameMs: 1 });
  assert.equal(hb.count(), 0);
  hb.beat();
  hb.beat();
  hb.beat();
  assert.equal(hb.count(), 3, "three pulses counted");
  assert.ok(counts.includes(3), "the latest count reached onFrame");
  hb.stop();
});

// --- agent_events: adapter + watchdog --------------------------------------
test("mapBrainEvent adapts the bridge vocabulary to the UI slice", () => {
  assert.deepEqual(mapBrainEvent({ type: "stage", name: "recon", face: "" }), {
    type: "stage",
    stage: "recon",
  });
  assert.deepEqual(mapBrainEvent({ type: "tool_call", id: "c1", name: "read_file", args: { path: "a.py" } }), {
    type: "tool",
    name: "read_file",
    args: "a.py",
  });
  assert.deepEqual(mapBrainEvent({ type: "checkpoint", gitSha: "abc1234" }), { type: "commit", sha: "abc1234" });
  assert.deepEqual(mapBrainEvent({ type: "status", phase: "x", poolUsed: 1, poolCap: 2 }), {
    type: "token",
    used: 1,
    cap: 2,
  });
  assert.equal(mapBrainEvent({ type: "done", ok: true, result: "", remaining: 0, reason: "" })!.type, "done");
  assert.equal(mapBrainEvent({ type: "skill", name: "s", reason: "r" })!.type, "log");
  assert.equal(mapBrainEvent({ type: "telemetry", tokens: 0, tps: 0, ctxUsed: 0, ctxCap: 0, vram: 0 }), null);
});

test("mapBrainEvent strips terminal controls from every visible text field", () => {
  const hostile = "ok\u001b]52;c;clipboard\u0007\u009b2J\nnext";
  const events = [
    mapBrainEvent({ type: "stage", name: hostile, face: "" }),
    mapBrainEvent({ type: "tool_call", id: "c1", name: hostile, args: { path: hostile } }),
    mapBrainEvent({ type: "checkpoint", gitSha: hostile }),
    mapBrainEvent({ type: "skill", name: hostile, reason: hostile }),
    mapBrainEvent({ type: "monologue", text: hostile, depth: 0 }),
    mapBrainEvent({ type: "error", msg: hostile }),
  ];
  const visible = JSON.stringify(events);
  assert.doesNotMatch(visible, /[\u001b\u0007\u009b]/);
  assert.doesNotMatch(visible, /\nnext/);
});

test("bindEventSource: cosmetic heartbeats cannot hide a meaningful-progress stall", async () => {
  const calls: string[] = [];
  const anim = {
    setStage: (s: string) => calls.push("stage:" + s),
    setProgress: () => {},
    markStalled: () => calls.push("stalled"),
    resume: () => calls.push("resume"),
    stop: () => {},
  };
  const ui = { log: () => {}, end: () => {} };
  let handler: (e: AgentEvent) => void = () => {};
  const fake: AgentSource = {
    on: (h) => {
      handler = h;
    },
    close: () => {},
  };
  bindEventSource(fake, ui, anim, { heartbeatTimeoutMs: 20 });
  await delay(40);
  assert.ok(calls.includes("stalled"), "watchdog fires markStalled on silence");
  handler({ type: "heartbeat" });
  assert.equal(calls.includes("resume"), false, "heartbeat alone does not claim progress resumed");
  handler({ type: "stage", stage: "execute" });
  assert.ok(calls.includes("resume"), "a meaningful event resumes the stalled UI");
  assert.ok(calls.includes("stage:execute"), "stage dispatched after resume");
});

test("bindEventSource finalizes error once, detaches, and ignores late events", () => {
  const calls: string[] = [];
  let handler: (e: AgentEvent) => void = () => {};
  let detached = 0;
  let closed = 0;
  const fake: AgentSource = {
    on: (next) => {
      handler = next;
      return () => detached++;
    },
    close: () => closed++,
  };
  const unbind = bindEventSource(
    fake,
    { log: (line) => calls.push(line), end: () => calls.push("end") },
    {
      setStage: (stage) => calls.push(`stage:${stage}`),
      setProgress: () => {},
      markStalled: () => {},
      resume: () => {},
      stop: () => calls.push("stop"),
    },
    { heartbeatTimeoutMs: 1000 },
  );
  handler({ type: "error", message: "bounded failure" });
  handler({ type: "log", line: "late write" });
  handler({ type: "done" });
  assert.deepEqual(calls, ["stage:error", "! bounded failure", "stop", "end"]);
  assert.equal(detached, 1, "terminal events detach immediately");
  unbind();
  unbind();
  assert.equal(detached, 1);
  assert.equal(closed, 0, "shared sources are detached but not closed by default");
});

test("bindEventSource terminates a heartbeat-only source after the meaningful-progress bound", async () => {
  const calls: string[] = [];
  let handler: (e: AgentEvent) => void = () => {};
  let closed = 0;
  const fake: AgentSource = {
    on: (next) => { handler = next; },
    close: () => { closed++; },
  };
  const unbind = bindEventSource(
    fake,
    { log: (line) => calls.push(line), end: () => calls.push("end") },
    {
      setStage: (stage) => calls.push(`stage:${stage}`),
      setProgress: () => {},
      markStalled: () => calls.push("stalled"),
      resume: () => calls.push("resume"),
      stop: () => calls.push("stop"),
    },
    { heartbeatTimeoutMs: 5, meaningfulProgressTimeoutMs: 18, ownsSource: true },
  );
  const heartbeats = setInterval(() => handler({ type: "heartbeat" }), 2);
  await delay(35);
  clearInterval(heartbeats);
  handler({ type: "log", line: "late" });
  assert.equal(calls.filter((call) => call === "end").length, 1);
  assert.equal(calls.filter((call) => call === "stop").length, 1);
  assert.ok(calls.some((call) => /source was cancelled.*aether doctor/i.test(call)));
  assert.equal(calls.includes("late"), false);
  assert.equal(closed, 1);
  unbind();
  assert.equal(closed, 1, "unbind is idempotent after timeout-owned closure");
});

test("bindEventSource ignores alternating stage replays and non-monotonic token cosmetics", async () => {
  const calls: string[] = [];
  const meaningful: string[] = [];
  let handler: (e: AgentEvent) => void = () => {};
  let detached = 0;
  let signalTerminal: (() => void) | undefined;
  const terminal = new Promise<void>((resolve) => { signalTerminal = resolve; });
  const fake: AgentSource = {
    on: (next) => {
      handler = next;
      return () => { detached++; };
    },
    close: () => {},
  };
  const unbind = bindEventSource(
    fake,
    { log: (line) => calls.push(line), end: () => calls.push("end") },
    {
      setStage: () => {},
      setProgress: () => {},
      markStalled: () => {},
      resume: () => {},
      stop: () => calls.push("stop"),
    },
    {
      heartbeatTimeoutMs: 100,
      meaningfulProgressTimeoutMs: 20,
      onMeaningfulEvent: (event) => meaningful.push(
        event.type === "stage" ? `stage:${event.stage}` :
        event.type === "token" ? `token:${event.used}` : event.type,
      ),
      onTerminal: () => signalTerminal?.(),
    },
  );
  handler({ type: "stage", stage: "prepare" });
  handler({ type: "token", used: 1, cap: 10 });
  let alternate = false;
  const cosmeticTick = (): void => {
    alternate = !alternate;
    handler({ type: "heartbeat" });
    handler({ type: "stage", stage: alternate ? "prepare" : "execute" });
    handler({ type: "token", used: 1, cap: alternate ? 10 : 11 });
    handler({ type: "token", used: 0, cap: 11 });
  };
  // Exercise both variants before the short watchdog can fire on a busy host.
  cosmeticTick();
  cosmeticTick();
  const cosmetic = setInterval(cosmeticTick, 2);
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      terminal,
      new Promise<never>((_resolve, reject) => {
        guard = setTimeout(() => reject(new Error("meaningful-progress watchdog did not terminate")), 1_000);
      }),
    ]);
  } catch (error) {
    unbind();
    throw error;
  } finally {
    clearInterval(cosmetic);
    if (guard) clearTimeout(guard);
  }

  assert.deepEqual(meaningful, ["stage:prepare", "token:1", "stage:execute"]);
  assert.equal(calls.filter((call) => call === "end").length, 1);
  assert.equal(calls.filter((call) => /no meaningful progress/.test(call)).length, 1);
  assert.equal(detached, 1);
  unbind();
  assert.equal(detached, 1);
});

test("LocalAgentSource feeds adapted BrainEvents + a synthetic heartbeat", async () => {
  const seen: string[] = [];
  const src = new LocalAgentSource(10);
  src.on((e) => seen.push(e.type));
  src.feedBrain({ type: "stage", name: "recon", face: "" });
  await delay(25);
  src.close();
  assert.ok(seen.includes("stage"), "stage fired regardless of transport");
  assert.ok(seen.includes("heartbeat"), "synthetic heartbeat present");
});

// --- tui_layout: regions + pager + non-TTY safety --------------------------
test("computeRegions math", () => {
  const r = computeRegions(30, 5);
  assert.equal(r.transTop, 6);
  assert.equal(r.transHeight, 23);
  assert.equal(r.statusRow, 29);
  assert.equal(r.inputRow, 30);
});

test("computeRegions deliberately collapses a tall header in a 20x5 emergency terminal", () => {
  const r = computeRegions(5, 9);
  assert.deepEqual(r, {
    headerTop: 1,
    headerBottom: 2,
    transTop: 3,
    transBottom: 3,
    transHeight: 1,
    statusRow: 4,
    inputRow: 5,
  });
  assert.ok(Object.values(r).every((value) => value >= 1), "no terminal region uses row zero");
});

test("pager preserves position when new output arrives while scrolled up", () => {
  const t = new TuiLayout({ mode: "api" });
  t.tty = true;
  t.regions = computeRegions(10, 1); // transHeight = 7
  for (let i = 0; i < 10; i++) t.transcript.push("L" + i);
  t.offset = 0;
  t.following = true;
  // Suppress the real ANSI writes for this in-memory pager test.
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    t.scrollUp(2);
    const [s1, w1] = t.visibleWindow();
    t.log("L10");
    const [s2, w2] = t.visibleWindow();
    assert.equal(s1, s2, "scroll position held");
    assert.equal(w1[0], w2[0], "top line unchanged");
    assert.equal(t.unseen, 1, "unseen counted");
    assert.equal(t.following, false, "not following while scrolled up");
    t.scrollToBottom();
    assert.equal(t.offset, 0, "End -> bottom");
    assert.equal(t.following, true, "End -> live");
    assert.equal(t.unseen, 0, "End -> unseen cleared");
    assert.equal(t.handleKey("pageup"), true, "PgUp consumed");
    assert.equal(t.handleKey("up"), false, "plain Up left for input editing");
  } finally {
    process.stdout.write = real;
  }
});

test("StatusRenderer non-TTY = plain lines, zero ANSI (keeps §8 logs clean)", () => {
  const prev = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  const out: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  try {
    const sr = new StatusRenderer({ mode: "local" });
    sr.start();
    sr.setAnim("▸▹");
    sr.log("  : run_tests");
    sr.setProgress(100, 500);
    sr.end();
  } finally {
    process.stdout.write = real;
    if (prev) Object.defineProperty(process.stdout, "isTTY", prev);
  }
  assert.ok(out.some((x) => x.includes("run_tests")), "scrollback line written");
  assert.ok(!out.some((x) => x.includes("\x1b[")), "no ANSI in non-TTY");
  assert.ok(!out.some((x) => x.includes("\r")), "no carriage-return pinning in non-TTY");
});

test("TuiLayout non-TTY stays plain (no ANSI)", () => {
  const prev = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  const out: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  try {
    const nt = new TuiLayout({ mode: "api" });
    nt.mount();
    nt.log("agent line");
    nt.setHeartbeat("●");
  } finally {
    process.stdout.write = real;
    if (prev) Object.defineProperty(process.stdout, "isTTY", prev);
  }
  assert.ok(out.some((x) => x.includes("agent line")), "plain line written");
  assert.ok(!out.some((x) => x.includes("\x1b[")), "no ANSI in non-TTY");
});

test("pager reflows long lines into wrapped rows (cropping loses nothing)", () => {
  const t = new TuiLayout({ mode: "api", cols: 20, rows: 10 });
  t.tty = true;
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    t.log("x".repeat(50)); // 50 cols at width 20 -> 3 rows
    const [, rows] = t.visibleWindow();
    assert.equal(rows.length, 3, "long line wrapped into 3 display rows");
    assert.ok(rows.every((r) => stripAnsi(r).length <= 20), "every row fits");
  } finally {
    process.stdout.write = real;
  }
});

test("pager re-wraps on resize so all content stays reachable", () => {
  const t = new TuiLayout({ mode: "api", cols: 40, rows: 10 });
  t.tty = true;
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    t.log("y".repeat(40)); // exactly one row at 40 cols
    assert.equal(t.visibleWindow()[1].length, 1);
    t.handleResize(10, 10); // crop the window
    const [, rows] = t.visibleWindow();
    assert.equal(rows.length, 4, "re-wrapped to 4 rows at width 10");
    assert.equal(rows.map((r) => stripAnsi(r)).join(""), "y".repeat(40), "no content lost");
  } finally {
    process.stdout.write = real;
  }
});

test("pager preserves a stable logical entry/offset anchor across rewrap", () => {
  const t = new TuiLayout({ mode: "api", cols: 24, rows: 8 });
  t.tty = true;
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    t.log("before");
    t.log("x".repeat(96));
    for (let i = 0; i < 7; i++) t.log(`after-${i}`);
    t.scrollUp(5);
    const before = t.viewportAnchor();
    assert.equal(before?.entryId, "entry:2");
    t.handleResize(12, 8);
    assert.deepEqual(t.viewportAnchor(), before, "same logical content remains at the top after rewrap");
  } finally {
    process.stdout.write = real;
  }
});

test("status row is clamped to the terminal width", () => {
  const t = new TuiLayout({ mode: "api", cols: 30, rows: 10, now: () => 0 });
  t.tty = true;
  const out: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  try {
    t.setVerb("Reconnoitring the perimeter fences", "( ⚆ _ ⚆ )");
    t.setUvt(123456, 999999);
    const status = out[out.length - 1]!;
    const visible = stripAnsi(status);
    assert.ok(visible.length <= 30, `status fits 30 cols (got ${visible.length})`);
  } finally {
    process.stdout.write = real;
  }
});

test("unmount removes the resize listener", () => {
  const t = new TuiLayout({ mode: "api", cols: 40, rows: 10 });
  t.tty = true;
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const before = process.stdout.listenerCount("resize");
    t.mount();
    assert.equal(process.stdout.listenerCount("resize"), before + 1);
    t.unmount();
    assert.equal(process.stdout.listenerCount("resize"), before, "listener detached");
  } finally {
    process.stdout.write = real;
  }
});

test("TuiLayout clamps hostile status metrics before formatting or drawing bars", () => {
  const t = new TuiLayout({ mode: "api", cols: 100, rows: 10, now: () => 0 });
  t.tty = true;
  const out: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    t.setStreamed(Number.POSITIVE_INFINITY);
    t.setUvt(-1, 10);
    const normalized = stripAnsi(out[out.length - 1] ?? "");
    assert.match(normalized, /UVT 0\/10/);
    assert.doesNotMatch(normalized, /Infinity|NaN/);
    assert.doesNotThrow(() => t.setUvt(Number.MAX_VALUE, Number.MIN_VALUE));
  } finally {
    process.stdout.write = real;
  }
});

test("TuiLayout requires explicit mouse attestation", () => {
  const out: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    const defaultLayout = new TuiLayout({ cols: 40, rows: 10 });
    defaultLayout.tty = true;
    defaultLayout.mount();
    defaultLayout.dispose();
    assert.doesNotMatch(out.join(""), /\?1000h|\?1006h/, "TTY presence alone never enables mouse capture");

    out.length = 0;
    const attestedLayout = new TuiLayout({ cols: 40, rows: 10, mouse: true });
    attestedLayout.tty = true;
    attestedLayout.mount();
    attestedLayout.dispose();
    assert.match(out.join(""), /\?1000h/);
    assert.match(out.join(""), /\?1006h/);
  } finally {
    process.stdout.write = real;
  }
});

test("unmounted and disposed layouts cannot repaint from late events or resize", async () => {
  const t = new TuiLayout({ mode: "api", cols: 40, rows: 10 });
  t.tty = true;
  const out: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    t.mount();
    process.stdout.emit("resize"); // queued resize must be cancelled by unmount
    t.unmount();
    const afterUnmount = out.join("").length;
    t.log("late line");
    t.setHeartbeat("late");
    t.setVerb("late", "late");
    t.setInput("late", 2);
    t.handleResize(20, 5);
    t.renderAll();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(out.join("").length, afterUnmount, "no callback writes after unmount");

    t.mount();
    t.dispose();
    const afterDispose = out.join("").length;
    t.mount();
    t.log("later still");
    t.handleResize(80, 24);
    assert.equal(out.join("").length, afterDispose, "dispose is a permanent write barrier");
  } finally {
    t.dispose();
    process.stdout.write = real;
  }
});

test("live resize bursts coalesce to one repaint per event-loop turn", async () => {
  const t = new TuiLayout({ mode: "api", cols: 40, rows: 10 });
  t.tty = true;
  const out: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    t.mount();
    const before = out.filter((chunk) => chunk.includes("\x1b[2J")).length;
    for (let i = 0; i < 100; i++) process.stdout.emit("resize");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const after = out.filter((chunk) => chunk.includes("\x1b[2J")).length;
    assert.equal(after - before, 1);
  } finally {
    t.dispose();
    process.stdout.write = real;
  }
});

test("100 mount/dispose cycles have zero listener growth and duplicate mount is idempotent", () => {
  const t = new TuiLayout({ mode: "api", cols: 40, rows: 12 });
  t.tty = true;
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  const baseline = {
    resize: process.stdout.listenerCount("resize"),
    exit: process.listenerCount("exit"),
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM"),
  };
  try {
    for (let i = 0; i < 100; i++) {
      t.mount();
      t.mount();
      t.unmount();
      t.unmount();
    }
    assert.deepEqual(
      {
        resize: process.stdout.listenerCount("resize"),
        exit: process.listenerCount("exit"),
        sigint: process.listenerCount("SIGINT"),
        sigterm: process.listenerCount("SIGTERM"),
      },
      baseline,
    );
  } finally {
    t.unmount();
    process.stdout.write = real;
  }
});

test("a colored header line keeps its visible width (ANSI-safe slicing invariant)", () => {
  const colored = "\x1b[38;2;135;215;255mAETHER\x1b[0m";
  assert.equal(stripAnsi(colored).length, 6);
});

test("TuiLayout setVerb/setStreamed are silent off-TTY (no stray writes)", () => {
  const prev = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  const out: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  try {
    const t = new TuiLayout({ mode: "api", now: () => 0 });
    t.setVerb("Forging", "(ง'̀-'́)ง");
    t.setStreamed(33_000);
    assert.equal(out.length, 0, "status setters write nothing when not a TTY");
  } finally {
    process.stdout.write = real;
    if (prev) Object.defineProperty(process.stdout, "isTTY", prev);
  }
});
