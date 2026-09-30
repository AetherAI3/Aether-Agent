import { test } from "node:test";
import assert from "node:assert/strict";
import { hintFor, isAbortError } from "../src/core/error_hints.js";
import { HttpError, InsecureTransportError, StreamIncompleteError, StreamTimeoutError } from "../src/core/errors.js";

test("HTTP statuses map to actionable hints", () => {
  assert.match(hintFor(new HttpError(401, "HTTP 401"))!, /aether auth login/);
  assert.match(hintFor(new HttpError(403, "HTTP 403"))!, /\/tier/);
  assert.match(hintFor(new HttpError(429, "HTTP 429"))!, /rate limited/i);
  // 5xx wording is intentionally NOT shared with errors.errorHint's >=500
  // branch (that one names the baseUrl; hintFor has none to name) — only
  // 401/402/403/429 are unified via httpStatusHint (LOOP-06 round 1).
  assert.match(hintFor(new HttpError(503, "HTTP 503"))!, /\/doctor/);
  assert.equal(hintFor(new HttpError(404, "HTTP 404")), null);
});

test("network failures point at connectivity", () => {
  // Also intentionally distinct wording from errors.errorHint's network
  // branch, same reasoning as the 5xx case above (LOOP-06 round 1).
  assert.match(hintFor(new TypeError("fetch failed"))!, /aether api/i);
  assert.match(hintFor(new Error("connect ECONNREFUSED 1.2.3.4:443"))!, /network/);
});

test("TLS trust failures get a secure CA repair rather than a network hint", () => {
  const tls = new TypeError("fetch failed", {
    cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" },
  });
  const hint = hintFor(tls) ?? "";
  assert.match(hint, /TLS certificate trust failed/);
  assert.match(hint, process.platform === "win32" ? /NODE_OPTIONS=--use-system-ca/ : /NODE_EXTRA_CA_CERTS/);
  assert.doesNotMatch(hint, /TLS_REJECT_UNAUTHORIZED/);
});

// LOOP-06 round 3: undici puts the failure code on err.cause.code, not in
// the message text, for real fetch failures — errors.errorHint already
// checked this via NETWORK_CODES; hintFor only pattern-matched the message
// and silently returned null for this entire shape. Mirrors
// errors.test.ts's "network failures hint at /doctor with the base url".
test("network failures with the code on err.cause (undici shape) are still detected", () => {
  const withCause = new Error("request to host failed");
  (withCause as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
  assert.match(hintFor(withCause)!, /aether api/i);

  // The code undici throws for a body/socket death after headers were
  // already received — i.e. a mid-stream drop, not a connect-time failure.
  const midStreamDrop = new Error("terminated");
  (midStreamDrop as { cause?: unknown }).cause = { code: "UND_ERR_SOCKET" };
  assert.match(hintFor(midStreamDrop)!, /aether api/i);
});

test("insecure transport points at the base URL", () => {
  assert.match(hintFor(new InsecureTransportError("http://evil"))!, /https/);
});

test("stream timeouts point at connectivity", () => {
  assert.match(hintFor(new StreamTimeoutError(120_000))!, /stream went quiet/);
  assert.match(hintFor(new StreamTimeoutError(120_000))!, /\/doctor/);
});

// LOOP-06 round 3: a stream that ends with no terminal done/error frame gets
// the same retry/doctor hint, mirroring errors.errorHint.
test("a stream ending without a terminal frame points at connectivity", () => {
  assert.match(hintFor(new StreamIncompleteError())!, /retry/);
  assert.match(hintFor(new StreamIncompleteError())!, /\/doctor/);
});

test("aborts are silent (already user-initiated) and detected", () => {
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(hintFor(abort), null);
  assert.equal(isAbortError(abort), true);
  assert.equal(isAbortError(new Error("x")), false);
  assert.equal(isAbortError("nope"), false);
});

test("isAbortError re-exports errors.isAbortError's fuller shapes (LOOP-06 round 1)", () => {
  // Regression for the dead, narrower copy this module used to maintain
  // (only checked err.name === "AbortError"): it returned false for both
  // shapes below. Now that error_hints.isAbortError re-exports
  // errors.isAbortError instead of duplicating the check, it catches them.
  const causeWrapped = new TypeError("The operation was aborted");
  (causeWrapped as { cause?: unknown }).cause = { name: "AbortError" };
  assert.equal(isAbortError(causeWrapped), true);

  const messageOnly = new Error("the operation was aborted due to a signal");
  assert.equal(isAbortError(messageOnly), true);
});

test("unknown errors produce no hint", () => {
  assert.equal(hintFor(new Error("whatever")), null);
  assert.equal(hintFor(42), null);
});
