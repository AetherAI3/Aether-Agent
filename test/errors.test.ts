import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError, StreamIncompleteError, StreamTimeoutError, errorHint } from "../src/core/errors.js";

const BASE = "https://api.aethersystems.net";

test("401 hint points at auth login; 402/403 point at plan/balance instead", () => {
  assert.match(errorHint(new HttpError(401, "HTTP 401"), BASE) ?? "", /aether auth login/);
  assert.match(errorHint(new HttpError(402, "HTTP 402"), BASE) ?? "", /UVT|balance/i);
  assert.match(errorHint(new HttpError(403, "HTTP 403"), BASE) ?? "", /plan|tier/i);
});

test("429 hint points at the tier", () => {
  assert.match(errorHint(new HttpError(429, "HTTP 429"), BASE) ?? "", /\/tier/);
});

test("5xx hint says try again and names the server", () => {
  const h = errorHint(new HttpError(503, "HTTP 503"), BASE) ?? "";
  assert.ok(h.includes(BASE));
  assert.match(h, /try again/);
});

test("network failures hint at /doctor with the base url", () => {
  const fetchFailed = new TypeError("fetch failed");
  assert.match(errorHint(fetchFailed, BASE) ?? "", /\/doctor/);

  const withCause = new Error("request to host failed");
  (withCause as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
  const h = errorHint(withCause, BASE) ?? "";
  assert.ok(h.includes(BASE));
  assert.match(h, /offline\?/);
});

test("REPL TLS trust failure gives the same CA repair", () => {
  const tls = new TypeError("fetch failed", {
    cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" },
  });
  const hint = errorHint(tls, BASE) ?? "";
  assert.match(hint, /TLS certificate trust failed/);
  assert.match(hint, process.platform === "win32" ? /NODE_USE_SYSTEM_CA=1/ : /NODE_EXTRA_CA_CERTS/);
});

test("stream timeouts get a retry/doctor hint, matching error_hints.hintFor (LOOP-06 round 2)", () => {
  // Regression for LOOP-06 round 2: errorHint used to have no branch for
  // StreamTimeoutError, so it fell through to the generic Error branch (no
  // cause.code, no "fetch failed" in the message) and returned null — the
  // REPL's printError showed a bare "stream timed out..." with zero
  // recovery hint, even though the sibling hintFor() handled it correctly.
  const h = errorHint(new StreamTimeoutError(120_000), BASE);
  assert.notEqual(h, null);
  assert.match(h ?? "", /stream went quiet/);
  assert.match(h ?? "", /\/doctor/);
});

// LOOP-06 round 3: a stream that ends without ever sending a terminal
// done/error frame must get the same retry/doctor hint as any other
// unfinished-connectivity failure, matching error_hints.hintFor.
test("a stream ending without a terminal frame gets a retry/doctor hint", () => {
  const h = errorHint(new StreamIncompleteError(), BASE);
  assert.notEqual(h, null);
  assert.match(h ?? "", /retry/);
  assert.match(h ?? "", /\/doctor/);
});

test("errors with nothing better to say get no hint", () => {
  assert.equal(errorHint(new HttpError(404, "HTTP 404"), BASE), null);
  assert.equal(errorHint(new Error("some app error"), BASE), null);
  assert.equal(errorHint("not even an Error", BASE), null);
});
