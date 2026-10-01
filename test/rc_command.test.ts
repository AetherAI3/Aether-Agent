// RC-02 command surface — what the operator reads before letting somebody
// watch them work, and what the CLI refuses to expose.
//
// Three groups:
//
//   1. The manifest carries no control vocabulary  — exit proof 2
//   2. The disclosure is honest                    — §7
//   3. Nothing rendered can carry a credential     — exit proof 6
//
// Nothing here runs git or touches the network: the renderers are pure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RC_NO_CONTROL_LINE,
  cmdRc,
  renderExposure,
  renderStatus,
  renderStatusJson,
  type RcStatusView,
} from "../src/commands/rc.js";
import { COMMAND_MANIFEST_SOURCE } from "../src/commands/command_manifest_data.js";
import { assertViewerManifest, tokenize } from "../src/core/rc/viewer_profile.js";
import { producerCoverage } from "../src/core/rc/producers.js";
import { payloadDigest } from "../src/core/rc/receipts.js";
import type { AppContext } from "../src/core/context.js";
import type { CommandFlags } from "../src/core/command_dispatch.js";

const TOKEN_SHAPED = "aek_" + "Z".repeat(32);

function view(over: Partial<RcStatusView> = {}): RcStatusView {
  return {
    running: true,
    browser: "BROWSER_READY",
    connector: "connected",
    last_receipt: "2026-09-07T00:00:00.000Z",
    device_id: "dev-1",
    device_name: "laptop",
    session_id: "rs_" + "e".repeat(32),
    project_ref: "proj",
    repo: {
      repo: "AetherAI3/aether-agent",
      branch: "main",
      base_commit: "0".repeat(40),
      dirty_file_count: 3,
    },
    state: "active",
    expires_at: "2026-09-08T00:00:00.000Z",
    observers: 2,
    pending: 4,
    acked: 12,
    dropped: 0,
    quarantined: 0,
    revoke_pending: false,
    ...over,
  };
}

const rcEntry = COMMAND_MANIFEST_SOURCE.find((entry) => entry.key === "shell:rc");

// ── 1. The manifest carries no control vocabulary ───────────────────────────

test("the rc command is registered with a runtime handler", () => {
  assert.ok(rcEntry, "shell:rc is missing from the command manifest");
  assert.equal(rcEntry!.name, "rc");
  assert.equal(rcEntry!.handler.id, "handler:shell:rc");
});

test("the help text is rc's own, not a template it was copied from", () => {
  // The manifest entry was cloned from `device`; an unreplaced field would
  // ship device's help under `aether rc --help`, which is how a command ends
  // up documenting a surface it does not have.
  assert.match(rcEntry!.detailedHelp, /^aether rc /);
  assert.ok(!rcEntry!.detailedHelp.includes("device"), "rc still carries device's help");
  assert.ok(!rcEntry!.summary.includes("device"));
});

test("every identifier rc exposes is free of control vocabulary", () => {
  // Exit proof 2, checked with the Cloud tokenizer's own rules.
  //
  // SCOPE, stated rather than assumed. This covers what RC introduces and what
  // a viewer-facing surface would mirror: the command name, its arguments,
  // summary, help body, flags, documented usage and subcommand vocabulary. It
  // deliberately does NOT cover `key` and `telemetryName`, because every
  // command in this CLI carries the `shell:` surface prefix — `shell:help`,
  // `shell:device` — naming the terminal surface, long predating RC. Feeding
  // those to a tokenizer that forbids the word "shell" would fail on
  // `aether help` too, and a guard that must be suppressed everywhere teaches
  // people to suppress it.
  const identifiers = [
    rcEntry!.name,
    rcEntry!.args,
    rcEntry!.summary,
    rcEntry!.detailedHelp,
    rcEntry!.docs.usage,
    ...Object.keys(rcEntry!.ownedFlags),
    ...rcEntry!.aliases,
    "start",
    "status",
    "exposure",
    "viewers",
    "off",
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  assert.ok(identifiers.length >= 8, "the identifier set collapsed; this guard would be vacuous");
  assertViewerManifest(identifiers, "aether rc");
});

test("the subcommand vocabulary contains no deferred controller verb", () => {
  // pause/resume/checkpoint are the first controller registry RC-CTRL would
  // add. None may appear here, in any casing.
  const forbidden = ["pause", "resume", "checkpoint", "cancel", "stop", "kill", "send"];
  for (const sub of ["start", "status", "exposure", "viewers", "off"]) {
    for (const word of tokenize(sub)) {
      assert.ok(!forbidden.includes(word), `subcommand ${sub} carries controller vocabulary`);
    }
  }
});

// ── 2. The disclosure is honest ─────────────────────────────────────────────

test("both surfaces print the no-control guarantee verbatim", () => {
  // §7 requires the literal line. It lives in the rendered output rather than
  // in the manifest help, because the manifest is checked against a tokenizer
  // that forbids the words "terminal" and "control" — the disclaimer has to
  // say them, and an identifier never may.
  assert.ok(renderStatus(view()).includes(RC_NO_CONTROL_LINE));
  assert.ok(renderExposure(view()).includes(RC_NO_CONTROL_LINE));
});

test("exposure separates what is actually sent from what is merely declared", () => {
  // Listing all thirteen viewer types under one "shared" heading would tell an
  // operator a viewer can watch their CI and test results when nothing emits
  // either yet. This screen is what somebody trusts before letting another
  // person watch them work, so the gap is shown rather than smoothed over.
  const text = renderExposure(view());
  const coverage = producerCoverage();
  // Every declared type appears, and anything without a producer appears under
  // its OWN heading rather than being listed as shared. With full coverage the
  // second heading is absent, which is the honest rendering of "nothing is
  // deferred" -- not a heading with nothing under it.
  for (const type of [...coverage.produced, ...coverage.unproduced]) {
    assert.ok(text.includes(`· ${type}`), `exposure omitted ${type}`);
  }
  assert.equal(
    text.includes("nothing sends them yet"),
    coverage.unproduced.length > 0,
    "the deferred heading must appear exactly when something is deferred",
  );
});

test("exposure and status report coverage as a computed fraction", () => {
  // "13 / 13 available" is a claim about producers that exist. Computing it
  // every time is what stops it becoming a lie when a type is added.
  const coverage = producerCoverage();
  const total = coverage.produced.length + coverage.unproduced.length;
  const expected = `${coverage.produced.length} / ${total} available`;
  assert.ok(renderStatus(view()).includes(expected));
  assert.ok(renderExposure(view()).includes(expected));
});

test("both surfaces state Control NONE and Inbound socket NONE", () => {
  for (const text of [renderStatus(view()), renderExposure(view())]) {
    assert.match(text, /Control\s+NONE/);
    assert.match(text, /Inbound socket\s+NONE/);
  }
});

test("status reports the browser and connector it was given", () => {
  const text = renderStatus(view({ browser: "BROWSER_NOT_FOUND", connector: "disconnected" }));
  assert.match(text, /Browser\s+BROWSER_NOT_FOUND/);
  assert.match(text, /Connector\s+disconnected/);
});

test("an unknown browser or connector renders as unknown, never as ready", () => {
  const text = renderStatus(view({ browser: null, connector: null }));
  assert.doesNotMatch(text, /Browser\s+ready/);
  assert.doesNotMatch(text, /Connector\s+connected/);
});

test("exposure names the categories that are never shared", () => {
  const text = renderExposure(view());
  for (const phrase of [
    "model reasoning",
    "private memory",
    "file contents",
    "shell history",
    "environment variables",
    "absolute paths",
  ]) {
    assert.ok(text.includes(phrase), `exposure must name "${phrase}" as never shared`);
  }
});

test("status shows the counters an operator needs to spot a gap", () => {
  const text = renderStatus(view({ pending: 7, acked: 40, dropped: 3, quarantined: 2 }));
  assert.match(text, /Outbox\s+7 pending \/ 2 quarantined/);
  assert.match(text, /dropped\s+3/);
});

test("an unreachable broker reports unknown observers, never zero", () => {
  // Reporting that nobody is watching when we simply could not ask is the one
  // wrong answer this screen can give.
  const text = renderStatus(view({ observers: null }));
  assert.match(text, /observers\s+unknown \(broker unreachable\)/);
  assert.doesNotMatch(text, /observers\s+0/);
});

test("an unconfirmed revoke is stated, with the fact that it will not resume", () => {
  const text = renderStatus(view({ revoke_pending: true }));
  assert.match(text, /not confirmed revocation/i);
  assert.match(text, /will not resume automatically/i);
});

test("status renders with nothing running and invents no session", () => {
  const text = renderStatus(
    view({ running: false, session_id: null, project_ref: null, repo: null, observers: null }),
  );
  assert.match(text, /state\s+off/);
  assert.match(text, /session\s+—/);
});

test("machine status binds session and device without replaying an invitation", () => {
  const data = JSON.parse(renderStatusJson(view())) as Record<string, unknown>;
  assert.equal(data["schema"], "aether.cli.rc/1");
  assert.equal(data["session_id"], "rs_" + "e".repeat(32));
  assert.equal(data["device_id"], "dev-1");
  assert.equal(data["host_state"], "active");
  assert.deepEqual(data["viewer_capabilities"], ["observe"]);
  assert.equal(data["observer"], null);
  assert.ok(!renderStatusJson(view()).includes("rsgt_"));
});

test("machine handoff carries a one-time link only in the requested start or link result", () => {
  const url = "https://app.aethersystems.net/rc#grant=rsgt_canary";
  const data = JSON.parse(renderStatusJson(view(), {
    url,
    expires_at: "2026-09-07T00:05:00.000Z",
  })) as { observer: { url: string; expires_at: string } };
  assert.equal(data.observer.url, url);
  assert.equal(data.observer.expires_at, "2026-09-07T00:05:00.000Z");
});

test("json start and status bind one RC host without replaying the one-time link", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aether-rc-json-"));
  const priorConfig = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = directory;
  const output: string[] = [];
  const sessionId = "rs_" + "1".repeat(32);
  const grantToken = "rsgt_" + "a".repeat(48);
  const api = {
    async postJson(path: string, body: unknown): Promise<unknown> {
      if (path === "/remote/sessions") return { session_id: sessionId, state: "pending_host" };
      if (path.endsWith("/host/attach")) return { session_id: sessionId, state: "live" };
      if (path.endsWith("/host/events")) {
        const events = (body as { events: Array<{ host_event_id: string; payload: Record<string, unknown> }> }).events;
        return { session_id: sessionId, receipts: events.map((event, index) => ({
          host_event_id: event.host_event_id, seq: index + 1, payload_digest: payloadDigest(event.payload),
        })) };
      }
      if (path.endsWith("/grants")) return {
        session_id: sessionId, purpose: "observe", device_id: (body as { device_id: string }).device_id,
        token: grantToken, expires_at: new Date(Date.now() + 300_000).toISOString(),
      };
      if (path.endsWith("/revoke")) return {};
      throw new Error(`unexpected route ${path}`);
    },
  };
  const ctx = { api, flags: { cwd: directory, json: true } } as unknown as AppContext;
  const flags = { str: () => undefined } as unknown as CommandFlags;
  const overrides = {
    cwd: directory,
    enrollment: () => ({ device_id: "dev-1", display_name: "test" }),
    repo: () => ({ repo: "fixture", branch: "main", base_commit: "0".repeat(40), dirty_file_count: 0 }),
    connector: () => null,
    browser: () => null,
    out: (value: string) => output.push(value),
    err: (value: string) => { throw new Error(value); },
    isTTY: false,
    columns: undefined,
  };
  try {
    assert.equal(await cmdRc(ctx, ["start"], flags, overrides), 0);
    assert.equal(output.length, 1);
    const started = JSON.parse(output.pop()!) as { session_id: string; device_id: string; observer: { url: string } };
    assert.equal(started.session_id, sessionId);
    assert.equal(started.device_id, "dev-1");
    assert.equal(new URL(started.observer.url).search, "");
    assert.ok(started.observer.url.includes(`#grant=${grantToken}`));

    assert.equal(await cmdRc(ctx, ["status"], flags, overrides), 0);
    assert.equal(output.length, 1);
    const status = JSON.parse(output[0]!) as { session_id: string; observer: unknown };
    assert.equal(status.session_id, sessionId);
    assert.equal(status.observer, null);
    assert.ok(!output[0]!.includes(grantToken));

    output.length = 0;
    assert.equal(await cmdRc(ctx, ["link"], flags, overrides), 0);
    assert.equal(output.length, 1);
    const linked = JSON.parse(output.pop()!) as { session_id: string; observer: { url: string } };
    assert.equal(linked.session_id, sessionId);
    assert.ok(linked.observer.url.includes(grantToken));

    assert.equal(await cmdRc(ctx, ["off"], flags, overrides), 0);
    assert.equal(output.length, 1);
    const closed = JSON.parse(output[0]!) as { session_id: string | null; host_state: string };
    assert.equal(closed.session_id, null);
    assert.equal(closed.host_state, "off");
  } finally {
    if (priorConfig === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = priorConfig;
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── 3. Nothing rendered can carry a credential ──────────────────────────────

test("no rendered surface exposes a secret-bearing field", () => {
  // The view type has no field that could hold a credential — that is the
  // actual guarantee, and it is a compile-time one. This pins the runtime half:
  // even with every identifier field poisoned, no secret-shaped KEY appears in
  // the output, so a future field added to the view cannot leak unnoticed.
  const poisoned = view({
    device_id: TOKEN_SHAPED,
    device_name: TOKEN_SHAPED,
    session_id: TOKEN_SHAPED,
    project_ref: TOKEN_SHAPED,
  });
  for (const text of [renderStatus(poisoned), renderExposure(poisoned)]) {
    for (const forbidden of [
      "host_secret",
      "secret_ref",
      "device_token",
      "command_key",
      "redemption",
      "grant_token",
    ]) {
      assert.ok(!text.includes(forbidden), `rendered output contained ${forbidden}`);
    }
  }
});
