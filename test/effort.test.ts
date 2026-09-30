import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EFFORT_TIERS,
  normalizeEffort,
  renderEffortSlider,
  renderCodeProArt,
} from "../src/ui/effort.js";
import { stripAnsi } from "../src/ui/theme.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { handleSlash } from "../src/commands/slash.js";
import type { AppContext } from "../src/core/context.js";

class Capture extends Writable {
  private readonly chunks: string[] = [];

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk));
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

test("normalizeEffort accepts names (any case) and 1-based indexes", () => {
  assert.equal(normalizeEffort("max"), "MAX");
  assert.equal(normalizeEffort("CodePro"), "CODEPRO");
  assert.equal(normalizeEffort(" ultra "), "ULTRA");
  assert.equal(normalizeEffort("1"), "LOW");
  // HIGH was added at index 3 to match the orchestrator's closed tier set
  // (lib/orchestrator/presets/contracts.py), so the numeric shortcuts shifted:
  // the top of the dial is now 6, and 5 is ULTRA.
  assert.equal(normalizeEffort("3"), "HIGH");
  assert.equal(normalizeEffort("5"), "ULTRA");
  assert.equal(normalizeEffort("6"), "CODEPRO");
  assert.equal(normalizeEffort("0"), null);
  assert.equal(normalizeEffort("7"), null);
  assert.equal(normalizeEffort("zzz"), null);
  assert.equal(normalizeEffort(""), null);
});

test("effort slider marks the current tier and shows the whole scale", () => {
  const s = renderEffortSlider("MAX").map(stripAnsi);
  // Four lines now: title, track, labels, and a legend naming what the dial
  // actually moves. The slider showed a position but never its units.
  assert.equal(s.length, 4);
  assert.ok(s[0]?.includes("effort ▸ MAX"));
  assert.ok(s[1]?.includes("●"));
  assert.ok(s[1]?.includes("▓") && s[1]?.includes("░"));
  for (const tier of EFFORT_TIERS) assert.ok(s[2]?.includes(tier), `labels row missing ${tier}`);
  assert.ok(s[3]?.includes("phases"), "legend should name what the dial controls");
});

test("CODEPRO's legend names the capabilities only it unlocks", () => {
  const legend = stripAnsi(renderEffortSlider("CODEPRO")[3] ?? "");
  assert.match(legend, /System-2/);
  // Every other tier is a budget change, so it must NOT claim those.
  assert.doesNotMatch(stripAnsi(renderEffortSlider("MAX")[3] ?? ""), /System-2/);
});

test("CODEPRO fills the track and swaps the knob for lightning", () => {
  const track = stripAnsi(renderEffortSlider("CODEPRO")[1] ?? "");
  assert.ok(track.includes("⚡"));
  assert.ok(!track.includes("░"), "CODEPRO track should be fully filled");
});

test("unset effort parks the knob at LOW and reads 'default'", () => {
  const s = renderEffortSlider("").map(stripAnsi);
  assert.ok(s[0]?.includes("default"));
  assert.ok(s[1]?.startsWith("  ●"), "knob should sit at the start of the track");
});

test("CODEPRO art is width-safe and announces itself", () => {
  const rows = renderCodeProArt().map(stripAnsi);
  assert.ok(rows.length >= 7);
  for (const row of rows) assert.ok(row.length <= 80, `row wider than 80: ${row.length}`);
  assert.ok(rows.some((r) => r.includes("CODEPRO engaged")));
});

test("/effort <tier> persists to the shared Aether config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-effort-"));
  const prev = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = dir;
  try {
    const ctx = { cfg: { ...DEFAULT_CONFIG } } as unknown as AppContext;
    const out = new Capture();
    await handleSlash(ctx, "/effort max", out);
    assert.equal(ctx.cfg.defaultEffort, "MAX");
    assert.match(stripAnsi(out.text()), /effort → MAX/);
    const saved = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as { defaultEffort: string };
    assert.equal(saved.defaultEffort, "MAX");

    const out2 = new Capture();
    await handleSlash(ctx, "/effort codepro", out2);
    assert.match(stripAnsi(out2.text()), /CODEPRO engaged/);
    assert.equal(ctx.cfg.defaultEffort, "CODEPRO");
  } finally {
    if (prev === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/effort keeps the prior in-memory tier when config save fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aether-effort-corrupt-"));
  const prev = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = dir;
  const path = join(dir, "config.json");
  const original = Buffer.from("{ invalid json\r\n", "utf8");

  try {
    writeFileSync(path, original);
    const ctx = { cfg: { ...DEFAULT_CONFIG, defaultEffort: "LOW" } } as unknown as AppContext;
    const out = new Capture();
    await assert.rejects(handleSlash(ctx, "/effort max", out), /config\.json.*repair/i);
    assert.equal(ctx.cfg.defaultEffort, "LOW");
    assert.deepEqual(readFileSync(path), original);
    assert.doesNotMatch(stripAnsi(out.text()), /effort → MAX|saved/);
  } finally {
    if (prev === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/effort with no arg shows the dial and how to set it", async () => {
  const ctx = { cfg: { ...DEFAULT_CONFIG } } as unknown as AppContext;
  const out = new Capture();
  await handleSlash(ctx, "/effort", out);
  const text = stripAnsi(out.text());
  assert.ok(text.includes("effort ▸"));
  assert.match(text, /set: \/effort </);
});

test("/effort rejects an unknown tier", async () => {
  const ctx = { cfg: { ...DEFAULT_CONFIG } } as unknown as AppContext;
  const out = new Capture();
  await handleSlash(ctx, "/effort turbo", out);
  assert.match(stripAnsi(out.text()), /no such effort tier: turbo/);
});
