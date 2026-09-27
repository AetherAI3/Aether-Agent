// Error taxonomy for the CLI.

/** Unwrap any thrown value to a display message. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Standard command-handler failure path: print `✗ <message>` (with an
 * optional parenthesized hint line, e.g. "are you logged in? run: ...")
 * and return the conventional non-zero exit code.
 */
export function fail(err: unknown, hint?: string): number {
  const msg = errorMessage(err);
  process.stderr.write(`✗ ${msg}\n${hint ? `  (${hint})\n` : ""}`);
  return 1;
}

/** Thrown by seams that are scaffolded but not yet wired to the the Aether API. */
export class NotWiredError extends Error {
  constructor(what: string) {
    super(`${what} is not wired yet (not implemented yet).`);
    this.name = "NotWiredError";
  }
}

/**
 * Server signalled fail-soft: it returned `{"stream": false}` as plain JSON
 * instead of an SSE body (AETHER_DISABLE_STREAMING, no adapter iter_stream,
 * etc.). The caller MUST fall back to the non-streaming request/response path.
 */
export class StreamUnavailableError extends Error {
  constructor(public body?: unknown) {
    super("streaming unavailable — fall back to request/response");
    this.name = "StreamUnavailableError";
  }
}

/** Streaming response started or continued too slowly for an interactive turn. */
export class StreamTimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`stream timed out after ${Math.round(timeoutMs / 1000)}s with no data`);
    this.name = "StreamTimeoutError";
  }
}

/** A peer sent one SSE event without a delimiter beyond the decoder's cap. */
export class StreamEventTooLargeError extends Error {
  constructor(public maxBytes: number) {
    super(
      `stream event exceeded the ${maxBytes}-byte safety limit; ` +
        "the request was cancelled and the prompt is safe to retry",
    );
    this.name = "StreamEventTooLargeError";
  }
}

/** The connection remained alive, but only cosmetic keepalives arrived. */
export class MeaningfulProgressTimeoutError extends StreamTimeoutError {
  constructor(timeoutMs: number) {
    super(timeoutMs);
    this.name = "MeaningfulProgressTimeoutError";
    this.message =
      `turn stalled after ${Math.round(timeoutMs / 1000)}s with no meaningful progress; ` +
      "the request was cancelled, your prompt is safe to retry, and `aether doctor` can inspect connectivity";
  }
}

/**
 * A chat/agent SSE stream ended (the underlying byte stream closed normally,
 * no throw) without ever delivering a terminal `done` or `error` frame.
 * Distinct from StreamTimeoutError (which fires on an IDLE gap while the
 * connection is still open): this is a clean-looking close — e.g. a
 * proxy/load-balancer that time-boxes the response and drops the socket well
 * within the idle window — that otherwise produces zero complaint and would
 * render a partial answer as a fully successful turn (LOOP-06 round 3).
 */
export class StreamIncompleteError extends Error {
  constructor() {
    super("the connection ended before the server finished responding");
    this.name = "StreamIncompleteError";
  }
}

/**
 * A non-streaming authed call (getJson/postJson/deleteJson) got no response
 * within its bound. Unlike stream()'s StreamTimeoutError, there's no partial
 * data involved — the whole request is unresolved. Distinct name so it can't
 * be confused with a genuine stream timeout in logs/tests.
 */
export class RequestTimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`request timed out after ${Math.round(timeoutMs / 1000)}s with no response`);
    this.name = "RequestTimeoutError";
  }
}

/**
 * Refused to send the session token because the base URL is not a secure
 * transport (non-https to a non-loopback host). Prevents a cleartext credential
 * leak / token exfiltration to an arbitrary host.
 */
export class InsecureTransportError extends Error {
  constructor(public baseUrl: string) {
    super(
      `refusing to send credentials over insecure transport: ${baseUrl} ` +
        `(use https, or http only to localhost)`,
    );
    this.name = "InsecureTransportError";
  }
}

/** Non-2xx HTTP response from the Aether API. Carries status + parsed body when present. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * The server returned a 2xx status but the body wasn't parseable JSON — it
 * said "ok" without giving usable data. Extends HttpError (not a bare Error)
 * so existing `instanceof HttpError` classification still applies, but keeps
 * its own name/message so callers that used to get a silent `undefined` (and
 * then crashed on their own property access, e.g. `cat.models` in slash.ts's
 * getCatalog or `r.session_token` in auth.ts's authRefresh) instead get one
 * coherent, hintable error.
 */
export class MalformedResponseError extends HttpError {
  constructor(status: number) {
    super(status, "malformed response from server");
    this.name = "MalformedResponseError";
  }
}

// Network-cause codes that mean "the server never answered" (undici surfaces
// these on err.cause.code for fetch failures). Exported so error_hints.hintFor
// can check the same set instead of pattern-matching err.message substrings
// only — undici puts the code on err.cause.code, not in the message text
// (LOOP-06 round 3).
export const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNRESET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** TLS failures are different from offline/network failures. Keep verification on. */
const TLS_CA_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
]);

export function tlsCaHint(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  if (typeof code !== "string" || !TLS_CA_CODES.has(code)) return null;
  return process.platform === "win32"
    ? "TLS certificate trust failed — set NODE_USE_SYSTEM_CA=1 for Aether Agent so Node uses the Windows trust store"
    : "TLS certificate trust failed — install the trusted issuer or configure NODE_EXTRA_CA_CERTS";
}

/**
 * True when `err` is the client-side cancellation of an in-flight turn
 * (AbortController fired). Undici surfaces this two ways depending on where
 * the stream was when it died: a DOMException named AbortError, or a
 * TypeError whose `cause` is the AbortError. Pure — unit-testable.
 */
export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  const causeName = (err.cause as { name?: string } | undefined)?.name;
  if (causeName === "AbortError") return true;
  return /operation was aborted/i.test(err.message);
}

/**
 * The ONE wording per auth/plan-shaped HTTP status, shared by errorHint (REPL)
 * and error_hints.hintFor (embedders/one-shot CLI) so a 401 can't read two
 * different ways in the same session. `/tier` only exists in the REPL, so the
 * standalone-CLI alternative is always named too.
 */
export function httpStatusHint(status: number): string | null {
  if (status === 401) return "session expired or invalid — run `aether auth login` to sign in again";
  if (status === 402) return "out of UVT balance — top up or check your plan: /tier or `aether models`";
  if (status === 403) return "your plan/tier may not include this — check: /tier or `aether models`";
  if (status === 429) return "rate limited — give it a moment, or check your plan: /tier or `aether models`";
  return null;
}

/**
 * The ONE wording for the baseUrl-independent thrown-error shapes (malformed
 * response, stream timeout, incomplete stream, request timeout) — shared by
 * errorHint (REPL) and error_hints.hintFor (embedders/one-shot CLI). These
 * hints never mention baseUrl, unlike the HttpError-5xx and network-outage
 * branches each caller keeps separately (see errorHint's/hintFor's own doc
 * comments for why those two stay per-surface) — so hand-duplicating THESE
 * branches instead of sharing them serves no purpose and risks exactly the
 * kind of silent wording drift the RequestTimeoutError branch had picked up
 * (this function used to be two copies with two different strings for it).
 * Checked before the generic HttpError branch in both callers
 * (MalformedResponseError extends HttpError): a malformed 2xx body isn't one
 * of the auth/plan statuses httpStatusHint knows about, so the generic
 * branch would otherwise return null and print the message with no
 * actionable next step at all.
 */
export function nonHttpErrorHint(err: unknown): string | null {
  const tlsHint = tlsCaHint(err);
  if (tlsHint !== null) return tlsHint;
  if (err instanceof MalformedResponseError) return "retry, or /doctor to check connectivity";
  if (err instanceof StreamEventTooLargeError) return "retry, or /doctor to inspect the server stream";
  if (err instanceof StreamTimeoutError) return "the stream went quiet - retry, or /doctor to check connectivity";
  if (err instanceof StreamIncompleteError) return "retry, or /doctor to check connectivity";
  if (err instanceof RequestTimeoutError) return "the request went quiet - retry, or /doctor to check connectivity";
  return null;
}

/**
 * One actionable next step for a failed turn, or null when there is nothing
 * better to say than the error itself. Pure — safe to unit test without a
 * network or a TTY. Consumed under the ✗ line as a dim hint.
 */
export function errorHint(err: unknown, baseUrl: string): string | null {
  const shared = nonHttpErrorHint(err);
  if (shared !== null) return shared;
  if (err instanceof HttpError) {
    if (err.status >= 500) return `the server at ${baseUrl} had a problem — try again shortly`;
    return httpStatusHint(err.status);
  }
  if (err instanceof Error) {
    const code = (err.cause as { code?: string } | undefined)?.code ?? "";
    if (NETWORK_CODES.has(code) || /fetch failed/i.test(err.message)) {
      return `can't reach ${baseUrl} — offline? check with /doctor (or aether auth status)`;
    }
  }
  return null;
}
