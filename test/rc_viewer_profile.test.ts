// RC viewer profile — the producer mirror pinned to the Cloud viewer manifest.
//
// test/fixtures/rc-viewer-profile-v1.json is a byte-identical copy of Aether
// Code's site/components/remote-session/rc-viewer-profile-v1.json, the manifest
// its build scan holds the shipped /rc bundles to. Two copies of one contract
// drift silently, so this file closes the loop from the Agent side:
//
//   1. The fixture is the Cloud manifest      — hash-pinned raw bytes
//   2. The producer mirror matches it          — src/core/rc/viewer_profile.ts
//   3. The viewer prefix stays observer-only   — routes, API paths, the link
//
// Changing either copy alone turns the hash red. Changing both without moving
// viewer_profile.ts turns group 2 red. Neither is a test to update casually: a
// new route or event class here is a new thing a remote screen can see.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RC_VIEW_ORIGIN, observerLink } from "../src/core/rc/observer_handoff.js";
import {
  EXCLUDED_EVENT_TYPES,
  FORBIDDEN_VIEWER_TERMS,
  assertViewerManifest,
  isViewerEventType,
  tokenize,
  viewerManifest,
} from "../src/core/rc/viewer_profile.js";

const FIXTURE_SHA256 = "57731a2b019801cc85ee1e34e3e8cacab36e6e0c0528ef3016847831c10ab7a1";

interface ViewerProfileFixture {
  schema: string;
  capabilities: string[];
  grant_purpose: string;
  presence_roles: string[];
  event_types: string[];
  excluded_event_types: string[];
  control_capable: boolean;
  routes: string[];
  api_calls: Array<{ method: string; path: string }>;
  separate_profiles: Record<string, { routes: string[]; gates: string[] }>;
}

const RAW = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures",
  "rc-viewer-profile-v1.json"));
const FIXTURE = JSON.parse(RAW.toString("utf8")) as ViewerProfileFixture;

function isViewerPrefixed(route: string): boolean {
  return route === "/rc" || route.startsWith("/rc/");
}

function forbiddenTokens(entry: string): string[] {
  return tokenize(entry).filter((word) => FORBIDDEN_VIEWER_TERMS.has(word));
}

// ── 1. The fixture is the Cloud manifest ────────────────────────────────────

test("the viewer profile fixture is the Cloud manifest, byte for byte", () => {
  // Checked before the hash so a CRLF checkout says what went wrong rather
  // than printing two unrelated digests. .gitattributes pins this file to LF.
  assert.equal(RAW.includes(0x0d), false, "fixture must have LF line endings");
  assert.equal(createHash("sha256").update(RAW).digest("hex"), FIXTURE_SHA256);
});

test("the fixture declares exactly the profile v1 fields", () => {
  assert.deepEqual(Object.keys(FIXTURE).sort(), [
    "api_calls", "capabilities", "control_capable", "event_types", "excluded_event_types",
    "grant_purpose", "presence_roles", "routes", "schema", "separate_profiles",
  ]);
});

// ── 2. The producer mirror matches it ───────────────────────────────────────

test("viewerManifest() equals the Cloud manifest's profile fields", () => {
  assert.deepEqual(viewerManifest(), {
    schema: FIXTURE.schema,
    capabilities: FIXTURE.capabilities,
    grant_purpose: FIXTURE.grant_purpose,
    presence_roles: FIXTURE.presence_roles,
    event_types: FIXTURE.event_types,
    control_capable: FIXTURE.control_capable,
  });
  assert.equal(FIXTURE.control_capable, false);
});

test("the excluded event types match and never overlap the published ones", () => {
  assert.deepEqual([...EXCLUDED_EVENT_TYPES], FIXTURE.excluded_event_types);
  for (const type of FIXTURE.excluded_event_types) {
    assert.equal(isViewerEventType(type), false, `${type} must not be publishable`);
    assert.ok(!FIXTURE.event_types.includes(type), `${type} is both published and excluded`);
  }
});

// ── 3. The viewer prefix stays observer-only ────────────────────────────────

test("viewer routes and API paths pass the viewer manifest check", () => {
  assertViewerManifest(FIXTURE.routes, "viewer route");
  assertViewerManifest(FIXTURE.api_calls.map((call) => call.path), "viewer api");
});

test("no viewer route or API path carries a forbidden token", () => {
  // Restated token by token so a weakened assertViewerManifest cannot pass
  // this file on its own say-so.
  for (const entry of [...FIXTURE.routes, ...FIXTURE.api_calls.map((call) => call.path)]) {
    assert.deepEqual(forbiddenTokens(entry), [], `${entry} carries control vocabulary`);
  }
});

test("the only non-GET call a viewer makes is redeeming its own observe grant", () => {
  assert.deepEqual(
    FIXTURE.api_calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`),
    ["POST /remote/grants/redeem"],
  );
});

test("every viewer route lives under /rc", () => {
  assert.ok(FIXTURE.routes.length > 0);
  for (const route of FIXTURE.routes) {
    assert.ok(isViewerPrefixed(route), `${route} is outside the viewer prefix`);
  }
});

test("the link `aether rc` prints lands on a viewer route", () => {
  assert.ok(FIXTURE.routes.includes(new URL(RC_VIEW_ORIGIN + "/rc").pathname));
  const link = new URL(observerLink({
    session_id: "rs_" + "1".repeat(32),
    purpose: "observe",
    device_id: "viewer_" + "2".repeat(32),
    token: "rsgt_" + "a".repeat(48),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
  }));
  assert.ok(FIXTURE.routes.includes(link.pathname), `${link.pathname} is not a manifest viewer route`);
});

test("operator profiles are separate, gated, and never under the viewer prefix", () => {
  const profiles = Object.entries(FIXTURE.separate_profiles);
  assert.ok(profiles.length > 0, "the operator surface must be declared, not implied");
  for (const [name, profile] of profiles) {
    assert.ok(profile.gates.length > 0, `${name} profile must be gated`);
    for (const route of profile.routes) {
      assert.equal(isViewerPrefixed(route), false, `${name} route ${route} sits under /rc`);
      assert.ok(!FIXTURE.routes.includes(route), `${name} route ${route} is also a viewer route`);
    }
  }
});
