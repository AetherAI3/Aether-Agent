import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSelection, handleSlash, primeCatalog, confirmSwitch } from "../src/commands/slash.js";
import type { CatalogItem } from "../src/types.js";
import type { AppContext } from "../src/core/context.js";

function item(id: string): CatalogItem {
  return {
    id,
    label: id,
    kind: "model",
    provider: "anthropic",
    context_window: null,
    tier_min: "free",
    enabled: true,
    available: true,
    monthly_uvt_cap: null,
    is_default: false,
  };
}

const list = [item("haiku"), item("sonnet"), item("opus")];

test("resolveSelection picks by 1-based index", () => {
  assert.equal(resolveSelection(list, "2")?.id, "sonnet");
  assert.equal(resolveSelection(list, "1")?.id, "haiku");
});

test("resolveSelection picks by id", () => {
  assert.equal(resolveSelection(list, "opus")?.id, "opus");
});

test("resolveSelection rejects out-of-range index and unknown id", () => {
  assert.equal(resolveSelection(list, "9"), null);
  assert.equal(resolveSelection(list, "0"), null);
  assert.equal(resolveSelection(list, "nope"), null);
  assert.equal(resolveSelection(list, ""), null);
});

function fakeCtx(answer: boolean): AppContext {
  return {
    flags: { yes: false, json: false, audit: false, cwd: "." },
    cfg: { defaultModel: "haiku", baseUrl: "x" },
    api: { getJson: async () => ({ tier: "pro", default: "haiku", models: [item("opus")] }) },
    confirm: async () => answer,
  } as unknown as AppContext;
}

test("/model switch prompts and, on yes, signals a restart", async () => {
  const out: string[] = [];
  const res = await handleSlash(fakeCtx(true), "/model opus", {
    write: (s: string) => out.push(s),
  } as never);
  assert.deepEqual(res.restart, { model: "opus" });
  assert.match(out.join(""), /restart the session and clear context/i);
});

test("/model switch on no does NOT restart", async () => {
  const res = await handleSlash(fakeCtx(false), "/model opus", { write: () => {} } as never);
  assert.equal(res.restart, undefined);
});

test("/mcp no longer prints coming soon", async () => {
  const out: string[] = [];
  // non-TTY test environment: handler must fall back to a helpful message
  // instead of opening the interactive menu.
  const res = await handleSlash(fakeCtx(false), "/mcp", {
    write: (s: string) => out.push(s),
  } as never);
  assert.equal(res.exit, false);
  assert.doesNotMatch(out.join(""), /coming soon/i);
});

test("primeCatalog swallows fetch errors (never blocks the prompt)", async () => {
  const ctx = {
    api: {
      getJson: async () => {
        throw new Error("offline");
      },
    },
  } as unknown as AppContext;
  await primeCatalog(ctx); // must not throw
  assert.ok(true);
});

test("/delegate rejects when no orchestrator active", async () => {
  const out: string[] = [];
  const res = await handleSlash(fakeCtx(true), "/delegate haiku build schema", {
    write: (s: string) => out.push(s),
  } as never);
  assert.equal(res.exit, false);
  assert.match(out.join(""), /requires an active orchestrator/i);
});

test("/tree rejects when no orchestrator active", async () => {
  const out: string[] = [];
  const res = await handleSlash(fakeCtx(true), "/tree", { write: (s: string) => out.push(s) } as never);
  assert.equal(res.exit, false);
  assert.match(out.join(""), /requires an active orchestrator/i);
});

test("/broadcast rejects when no orchestrator active", async () => {
  const out: string[] = [];
  const res = await handleSlash(fakeCtx(true), "/broadcast change bg color", { write: (s: string) => out.push(s) } as never);
  assert.equal(res.exit, false);
  assert.match(out.join(""), /requires an active orchestrator/i);
});

test("/gather rejects when no orchestrator active", async () => {
  const out: string[] = [];
  const res = await handleSlash(fakeCtx(true), "/gather all", { write: (s: string) => out.push(s) } as never);
  assert.equal(res.exit, false);
  assert.match(out.join(""), /requires an active orchestrator/i);
});

// ── confirmSwitch: a locked (tier-gated) item (LOOP-06) ──
//
// Tested directly against confirmSwitch (rather than through handleSlash)
// because the module-level catalog cache in slash.ts is populated once per
// process by the /model tests above and never refetched for a plain id — a
// second, differently-available "opus" wouldn't reach the handler at all.
// confirmSwitch is the exact function this fix touches, so this exercises it
// without fighting that cache.

test("confirmSwitch: a locked item never signals a restart", async () => {
  const out: string[] = [];
  const ctx = { flags: { yes: false }, confirm: async () => true } as unknown as AppContext;
  const locked = item("gpt5-pro");
  locked.available = false;
  const res = await confirmSwitch(ctx, { write: (s: string) => out.push(s) } as never, locked, "model", "free");
  assert.equal(res, null, "a locked item must not produce a restart signal");
});

test("confirmSwitch: locked-item message matches the 403 tier-restriction wording", async () => {
  const out: string[] = [];
  const ctx = { flags: { yes: false }, confirm: async () => true } as unknown as AppContext;
  const locked = item("gpt5-pro");
  locked.available = false;
  await confirmSwitch(ctx, { write: (s: string) => out.push(s) } as never, locked, "model", "free");
  const printed = out.join("");
  assert.match(printed, /gpt5-pro is locked on tier free/);
  // Same actionable pointer as httpStatusHint(403) in errors.ts, so a
  // tier-lock reached via the picker reads the same as one reached over
  // the wire, not as a dead end with no next step.
  assert.match(printed, /check: \/tier or `aether models`/);
  // theme is disabled (non-TTY) in this test harness, so theme.dim() is a
  // no-op passthrough here and the plain wording above is the reachable
  // proxy for "goes through the same theme.dim(...) call the restart
  // warning two lines down already uses" — see the ANSI-wrapping assertions
  // in test/theme_factory.test.ts for that half of the behavior.
});

test("managed browser and ATS commands give a scoped handoff in the coding REPL without touching account or browser APIs", async () => {
  const inaccessible = new Proxy({}, { get() { throw new Error("coding REPL must not execute a managed-chat browser/ATS command"); } });
  for (const input of ["/browser open", "/browser setup https://example.invalid?token=must-not-reflect", "/ats mode danger"]) {
    const output: string[] = [];
    const result = await handleSlash(inaccessible as AppContext, input, { write: (s: string) => output.push(s) } as never);
    assert.deepEqual(result, { exit: false });
    assert.match(output.join(""), /managed agent chat/i);
    assert.match(output.join(""), /aether agent chat/);
    assert.doesNotMatch(output.join(""), /must-not-reflect|Unknown command/);
  }
});
