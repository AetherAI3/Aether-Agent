import { test } from "node:test";
import assert from "node:assert/strict";
import { mintObserverGrant, RcError, type RcHostDeps } from "../src/core/rc/host.js";
import { observerLink, observerQr } from "../src/core/rc/observer_handoff.js";
import type { ApiClient } from "../src/core/transport.js";

const SESSION = "rs_" + "1".repeat(32);
const DEVICE = "viewer_" + "2".repeat(32);
const TOKEN = "rsgt_" + "a".repeat(48);
function grant() { return {
  session_id: SESSION,
  purpose: "observe" as const,
  device_id: DEVICE,
  token: TOKEN,
  expires_at: new Date(Date.now() + 300_000).toISOString(),
}; }

function deps(response: unknown): RcHostDeps {
  return {
    api: { async postJson(path: string, body: unknown) {
      assert.equal(path, `/remote/sessions/${SESSION}/grants`);
      assert.deepEqual(body, { purpose: "observe", device_id: DEVICE });
      return response;
    } } as unknown as ApiClient,
    outboxPath: "unused",
    projectRoot: "unused",
  };
}

test("observer grant is bound and its token stays in the URL fragment", async () => {
  const minted = await mintObserverGrant(deps(grant()), SESSION, DEVICE);
  const link = new URL(observerLink(minted));
  assert.equal(link.origin, "https://app.aethersystems.net");
  assert.equal(link.pathname, "/rc");
  assert.equal(link.search, "");
  assert.equal(new URLSearchParams(link.hash.slice(1)).get("grant"), TOKEN);
  assert.equal(new URLSearchParams(link.hash.slice(1)).get("device_id"), DEVICE);
});

test("invalid or mismatched broker response never becomes a link", async () => {
  for (const bad of [
    { ...grant(), session_id: "rs_other" },
    { ...grant(), purpose: "control" },
    { ...grant(), device_id: "viewer_other" },
    { ...grant(), token: "short" },
    { ...grant(), expires_at: "invalid" },
    { ...grant(), expires_at: new Date(Date.now() - 1_000).toISOString() },
  ]) {
    await assert.rejects(mintObserverGrant(deps(bad), SESSION, DEVICE),
      (error: unknown) => error instanceof RcError && error.code === "RC_RECEIPTS_UNPROVEN");
  }
});

test("headless and narrow terminals get a link without a broken QR", () => {
  const link = observerLink(grant());
  assert.equal(observerQr(link, undefined), null);
  assert.equal(observerQr(link, 39), null);
  const qr = observerQr(link, 120);
  assert.ok(qr?.includes("\n"));
});
