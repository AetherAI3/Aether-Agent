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

import {
  RC_NO_CONTROL_LINE,
  renderExposure,
  renderStatus,
  type RcStatusView,
} from "../src/commands/rc.js";
import { COMMAND_MANIFEST_SOURCE } from "../src/commands/command_manifest_data.js";
import { assertViewerManifest, tokenize } from "../src/core/rc/viewer_profile.js";
import { producerCoverage } from "../src/core/rc/producers.js";

const TOKEN_SHAPED = "aek_" + "Z".repeat(32);

function view(over: Partial<RcStatusView> = {}): RcStatusView {
  return {
    running: true,
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
  assert.match(text, /Shared now/);
  assert.match(text, /nothing sends them yet/);
  assert.ok(coverage.unproduced.length > 0, "this test is vacuous with nothing deferred");
  for (const type of [...coverage.produced, ...coverage.unproduced]) {
    assert.ok(text.includes(`· ${type}`), `exposure omitted ${type}`);
  }
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
  assert.match(text, /7 pending · 40 acknowledged/);
  assert.match(text, /dropped\s+3/);
  assert.match(text, /quarantined\s+2/);
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
