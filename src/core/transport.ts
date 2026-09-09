// ApiClient — the ONLY network surface. Talks to the Aether API (public front door).
// Aether's servers enforce usage and sign every request.
//
// Paths are constants so they change in one place.

import {
  HttpError,
  InsecureTransportError,
  MalformedResponseError,
  RequestTimeoutError,
  StreamTimeoutError,
  StreamUnavailableError,
} from "./errors.js";
import { isApiKeyToken, type TokenStore } from "./auth.js";

/**
 * Is `base` a transport we will attach the session token to? https is allowed to
 * any host; plain http is allowed ONLY to loopback (a local-dev backend), so the
 * long-lived `aek_` token never traverses cleartext to a remote host and an
 * attacker-set base URL cannot silently exfiltrate it. Unparseable → unsafe.
 */
export function isCredentialSafeUrl(base: string): boolean {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Does `target` share `baseUrl`'s origin (scheme+host+port)? getBinary() uses
 * this — NOT isCredentialSafeUrl() — to decide whether the live session
 * bearer token should be attached to a caller-supplied absolute URL at all.
 * isCredentialSafeUrl() only checks scheme (any https host passes); reusing
 * it here would attach the token to ANY https host, including a third-party
 * host a server response (or a compromised/malicious one) pointed at, leaking
 * the token to it. A target that isn't the API's own origin gets no
 * Authorization header, regardless of its own scheme.
 */
export function isSameOrigin(target: string, baseUrl: string): boolean {
  try {
    const t = new URL(target);
    const b = new URL(baseUrl);
    return t.protocol === b.protocol && t.host === b.host;
  } catch {
    return false;
  }
}

// Aether API routes.
export const CHAT_STREAM_PATH = "/agent/chat/stream"; // standard chat SSE
export const CHAT_PATH = "/agent/chat"; // non-streaming fail-soft fallback
// Agent dev sessions — the bidirectional coding protocol (API brain, local
// host): downstream SSE with per-session `seq`, upstream idempotent POSTs.
export const DEV_SESSIONS_PATH = "/agent/dev/sessions";
export function devSessionStreamPath(id: string, lastSeq = 0): string {
  const base = `${DEV_SESSIONS_PATH}/${encodeURIComponent(id)}/stream`;
  return lastSeq > 0 ? `${base}?last_seq=${lastSeq}` : base;
}
export function devSessionToolResultsPath(id: string): string {
  return `${DEV_SESSIONS_PATH}/${encodeURIComponent(id)}/tool-results`;
}
export function devSessionControlPath(id: string): string {
  return `${DEV_SESSIONS_PATH}/${encodeURIComponent(id)}/control`;
}
export function devSessionPath(id: string): string {
  return `${DEV_SESSIONS_PATH}/${encodeURIComponent(id)}`;
}
// Auth (session_token via username/password; Bearer on all authed calls).
export const LOGIN_PATH = "/auth/login";
export const LOGOUT_PATH = "/auth/logout";
export const REFRESH_PATH = "/auth/refresh";
// OAuth / account platform: `aether auth login` opens this to sign in and mint
// or copy a CLI API token. Override with AETHER_LOGIN_URL.
export const PLATFORM_URL =
  process.env["AETHER_LOGIN_URL"] ?? "https://aethersystems.net/platform";
// Device Authorization Grant (RFC 8628) — `aether auth login` default flow.
export const DEVICE_CODE_PATH = "/auth/device/code"; // CLI requests a user_code
export const DEVICE_TOKEN_PATH = "/auth/device/token"; // CLI polls until approved
// GitHub Connect (web-canonical GitHub App; Bearer-authed). connect returns an
// install_url the user approves in the browser; status is polled until linked.
// Backend mounts these at root (api_server include_router, no prefix).
export const GITHUB_CONNECT_PATH = "/account/github/connect";
export const GITHUB_STATUS_PATH = "/account/github/status";
export const GITHUB_DISCONNECT_PATH = "/account/github/disconnect";
// request audit (chain of custody) (integrity id = commitment_hash).
export const AUDIT_TRAIL_PATH = "/audit/trail/live"; // entries carry commitment_hash
export const EXPORT_PROOF_PATH = "/audit/export-proof"; // {entry_ids} -> proof package
// Note — no REST model registry route exists yet on the Aether API.
export const MODELS_PATH = "/models";
export const AGENTS_PATH = "/agents";
export const AGENT_DELEGATE_PATH = "/agents/delegate";
export const AGENT_TREE_PATH = "/agents/tree";
export const AGENT_BROADCAST_PATH = "/agents/broadcast";
export const AGENT_GATHER_PATH = "/agents/gather";
export const AGENT_TEST_DRIVE_PATH = "/agents/test-drive";
export const AGENT_BENCH_PATH = "/agents/bench";
// ── Vault (cloud file storage) ─────────────────
export const VAULT_LIST_PATH = "/vault/list";
export const VAULT_BROWSE_PATH = "/vault/browse";
export const VAULT_SPACES_LIST_PATH = "/vault/spaces/list";
export const VAULT_SPACES_USAGE_PATH = "/vault/spaces/usage";
export const VAULT_SPACES_UPLOAD_PATH = "/vault/spaces/upload";
export const VAULT_SPACES_DOWNLOAD_PATH = "/vault/spaces/download";
export const VAULT_SPACES_CONTENT_PATH = "/vault/spaces/content";
export const VAULT_SPACES_DELETE_PATH = "/vault/spaces/delete";
export const VAULT_NOTES_SEARCH_PATH = "/vault/notes/search";
export const VAULT_NOTES_BY_TAG_PATH = "/vault/notes/by-tag";
export const VAULT_NOTES_BY_TYPE_PATH = "/vault/notes/by-type";
export const VAULT_NOTES_BACKLINKS_PATH = "/vault/notes/backlinks";
export const VAULT_NOTES_OUTLINKS_PATH = "/vault/notes/outlinks";
export const VAULT_NOTES_TREE_PATH = "/vault/notes/tree";
export const AGENT_VAULT_SNAPSHOT_PATH = "/agent/vault/snapshot";
export const AGENT_VAULT_SLASH_PATH = "/agent/vault/slash";
export const AGENT_VAULT_STAGING_PATH = "/agent/vault/staging";
export const AGENT_CONTEXT_PATH = "/agent/context";
// ── UVT Commands ────────────────────────────
export const UVT_SCAFFOLD_PATH = "/uvt/scaffold";
export const UVT_PORT_PATH = "/uvt/port";
// ── Project conversion (workflow → project) ─────
export const PROJECT_FROM_WORKFLOW_ASSESS_PATH = "/project/from-workflow/assess";
export const PROJECT_FROM_WORKFLOW_BRAINSTORM_PATH = "/project/from-workflow/brainstorm";
export const PROJECT_FROM_WORKFLOW_PLAN_PATH = "/project/from-workflow/plan";
export const PROJECT_FROM_WORKFLOW_FINALIZE_PATH = "/project/from-workflow/finalize";

export const DEFAULT_STREAM_TIMEOUT_MS = 120_000;
// Non-streaming authed calls (getJson/postJson/deleteJson) — /models, /tier,
// auth status/refresh, device-poll, etc. Much shorter than the stream default
// since these are single request/response round-trips, not a long-lived SSE
// body: a stalled connection here should fail fast, not sit for 2 minutes.
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface StreamOptions {
  signal?: AbortSignal;
  /** Timeout for opening the stream and for each quiet interval between chunks. 0 disables it. */
  timeoutMs?: number;
  /** HTTP method for the stream request. Default POST (body JSON-encoded);
   *  "GET" sends no body (dev-session downstream SSE). */
  method?: "POST" | "GET";
}

interface RefreshFlight {
  readonly usedToken: string;
  readonly controller: AbortController;
  promise: Promise<boolean>;
  waiters: number;
  settled: boolean;
  committing: boolean;
}

export class ApiClient {
  /** In-flight refresh, shared so concurrent 401s trigger ONE /auth/refresh. */
  private refreshing: RefreshFlight | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly tokens: TokenStore,
  ) {}

  /**
   * Transparent recovery for an expired session: on a 401, exchange the stale
   * session token at /auth/refresh and store the fresh one so the caller can
   * retry once. Returns false (never throws) when refresh isn't applicable —
   * no token, an `aek_` API key (those don't expire), a 401 from an /auth/*
   * route itself (no recursion), or a refresh that fails for any reason — so
   * the ORIGINAL 401 is what surfaces to the user.
   */
  private async refreshSession(
    failedPath: string,
    usedToken: string | null,
    signal?: AbortSignal,
  ): Promise<boolean> {
    throwIfAborted(signal);
    if (failedPath.startsWith("/auth/")) return false;
    if (!usedToken || isApiKeyToken(usedToken) || usedToken.startsWith("agt_")) return false;
    // Same fail-closed rule as authHeaders(): never POST a session token over
    // an insecure transport — not even to refresh it.
    if (!isCredentialSafeUrl(this.baseUrl)) return false;
    // A concurrent caller (or another process) already rotated the session
    // while this request was in flight: don't burn a second refresh — on
    // rotation-detecting servers that would invalidate the just-minted token.
    // Just signal "retry with the new token".
    const current = await this.tokens.get();
    throwIfAborted(signal);
    if (current !== usedToken) return current != null;

    let flight = this.refreshing;
    if (!flight || flight.usedToken !== usedToken) {
      const controller = new AbortController();
      flight = {
        usedToken,
        controller,
        promise: Promise.resolve(false),
        waiters: 0,
        settled: false,
        committing: false,
      };
      const owned = flight;
      owned.promise = this.runSessionRefresh(usedToken, owned).finally(() => {
        owned.settled = true;
        if (this.refreshing === owned) this.refreshing = null;
      });
      this.refreshing = owned;
    }

    // Each 401 owns one lease on the shared refresh. A cancelled caller stops
    // waiting immediately. The refresh itself is aborted only after its last
    // interested caller leaves, so one Ctrl+C cannot break a concurrent live
    // request, while a sole cancelled demand cannot rotate credentials later.
    flight.waiters += 1;
    try {
      return await waitForRefreshFlight(flight, signal);
    } finally {
      flight.waiters = Math.max(0, flight.waiters - 1);
      if (flight.waiters === 0 && !flight.settled) flight.controller.abort();
    }
  }

  private async runSessionRefresh(usedToken: string, flight: RefreshFlight): Promise<boolean> {
    const signal = AbortSignal.any([flight.controller.signal, AbortSignal.timeout(10_000)]);
    try {
      const res = await fetch(this.url(REFRESH_PATH), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${usedToken}`,
        },
        body: "{}",
        signal,
      });
      if (flight.controller.signal.aborted || !res.ok) return false;
      let body: { session_token?: string } | undefined;
      try {
        body = (await res.json()) as { session_token?: string };
      } catch {
        return false;
      }
      if (flight.controller.signal.aborted || !body?.session_token) return false;

      // Do not overwrite a rotation performed by another process while this
      // network request was in flight. A matching fresh value already means
      // callers may retry; any other value belongs to a newer authority.
      const current = await this.tokens.get();
      if (flight.controller.signal.aborted) return false;
      if (current !== usedToken) return current === body.session_token;

      // update() (when the store distinguishes it) swaps the ACTIVE token
      // without widening persistence — an automatic refresh must not write a
      // desktop-embedded session over the standalone CLI's on-disk token.
      // From this point the TokenStore contract has no abort/rollback port.
      // Mark the commit boundary so cancellation waits for the write and can
      // never return to the caller before a late credential mutation occurs.
      flight.committing = true;
      await (this.tokens.update?.(body.session_token) ?? this.tokens.set(body.session_token));
      return !flight.controller.signal.aborted;
    } catch {
      return false;
    }
  }

  private url(path: string): string {
    return this.baseUrl.replace(/\/$/, "") + path;
  }

  // Internal retry paths pass the token used by that exact attempt; callers
  // that omit it read the current token from the store.
  private async authHeaders(token?: string | null): Promise<Record<string, string>> {
    return this.bearerFor(token === undefined ? await this.tokens.get() : token);
  }

  private bearerFor(t: string | null): Record<string, string> {
    if (!t) return {};
    // Fail closed: never put the bearer on an insecure transport. Unauthenticated
    // calls (no token) are unaffected — only credentialed requests are refused.
    if (!isCredentialSafeUrl(this.baseUrl)) throw new InsecureTransportError(this.baseUrl);
    return { Authorization: `Bearer ${t}` };
  }

  /** POST a coding envelope, return the raw SSE byte stream for decodeSse().
   *  `signal` aborts a Ctrl+C turn; `timeoutMs` (default 120s, override via
   *  AETHER_STREAM_TIMEOUT_MS or the options form, 0 disables) catches a quiet
   *  connection so a stalled SSE body cannot hang the terminal forever.
   *  Timeout and user-abort are raced as two independent promises (see
   *  raceAgainst) so a timeout can never be mistaken for the user's own
   *  Ctrl+C, or vice versa, no matter which fires first. */
  async stream(
    path: string,
    body: unknown,
    signalOrOptions?: AbortSignal | StreamOptions,
  ): Promise<AsyncIterable<Uint8Array>> {
    const { signal, timeoutMs, method } = normalizeStreamOptions(signalOrOptions);
    // `net` only tells fetch()/the body reader to release the socket on timeout
    // or abort — it is never inspected to pick the error the caller sees. That
    // classification comes solely from raceAgainst racing the caller's own
    // `signal` against an independent timer, so the two can't collide.
    const net = new AbortController();
    const releaseNet = (): void => net.abort();
    if (signal) {
      if (signal.aborted) releaseNet();
      else signal.addEventListener("abort", releaseNet, { once: true });
    }
    const cleanup = (): void => signal?.removeEventListener("abort", releaseNet);
    try {
      let used: string | null = null;
      const open = async (): Promise<Response> => {
        used = await this.tokens.get();
        return raceAgainst(
          fetch(this.url(path), {
            method,
            headers: {
              ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
              Accept: "text/event-stream",
              ...(await this.authHeaders(used)),
            },
            ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
            signal: net.signal,
          }),
          signal,
          timeoutMs,
        );
      };
      let res = await open();
      if (res.status === 401 && (await this.refreshSession(path, used, signal))) {
        // Drop the rejected response's body so the socket is released before
        // the retry (undici keep-alive would otherwise pin the connection).
        void res.body?.cancel().catch(() => {});
        res = await open();
      }
      if (!res.ok) {
        throw await toHttpError(res, signal, timeoutMs, () => new StreamTimeoutError(timeoutMs));
      }
      // Fail-soft: server returns plain JSON `{"stream": false}` instead of an
      // SSE body when it can't/shouldn't stream -> caller falls back to /agent/chat.
      const ct = res.headers.get("content-type") ?? "";
      if (ct.startsWith("application/json")) {
        let body: unknown;
        try {
          body = await raceAgainst(res.json(), signal, timeoutMs);
        } catch (error) {
          if (error instanceof StreamTimeoutError || signal?.aborted) throw error;
          body = undefined;
        }
        throw new StreamUnavailableError(body);
      }
      if (!res.body) throw new HttpError(res.status, "empty stream body");
      return withIdleTimeout(
        res.body as unknown as AsyncIterable<Uint8Array>,
        signal,
        timeoutMs,
        releaseNet,
        cleanup,
      );
    } catch (err) {
      releaseNet();
      cleanup();
      throw err;
    }
  }

  /** `timeoutMs` overrides the default bound (AETHER_REQUEST_TIMEOUT_MS, 30s;
   *  0 disables it) — most callers should omit it. It exists for the rare
   *  non-streaming call that legitimately runs long (e.g. chat.ts's/
   *  brain_cloud.ts's/client.ts's CHAT_PATH fallback for a full LLM turn,
   *  which passes stream()'s own 120s-class bound instead of the 30s default
   *  meant for metadata/auth calls). */
  async postJson<T>(path: string, body: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    return this.request<T>("POST", path, { body, signal, timeoutMs });
  }

  async getJson<T>(path: string, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    return this.request<T>("GET", path, { signal, timeoutMs });
  }

  /**
   * PATCH with caller-supplied headers.
   *
   * `headers` exists for request-identifying metadata a route requires — today
   * only `Idempotency-Key` on the Code settings mutation routes, which reject a
   * request without one. It can never override the Authorization, Content-Type
   * or Accept headers this client sets; see request().
   */
  async patchJson<T>(
    path: string,
    body: unknown,
    opts: {
      headers?: Record<string, string>;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    return this.request<T>("PATCH", path, { body, ...opts });
  }

  /** POST with caller-supplied headers; see patchJson for the header rules. */
  async postJsonWithHeaders<T>(
    path: string,
    body: unknown,
    opts: {
      headers?: Record<string, string>;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    return this.request<T>("POST", path, { body, ...opts });
  }

  async deleteJson<T>(path: string, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    return this.request<T>("DELETE", path, { signal, timeoutMs });
  }

  /**
   * Authed GET for binary/streaming reads — vault file downloads, media asset
   * downloads. Goes through the same refresh-on-401 retry as request()/
   * stream(), and throws HttpError (not a plain Error) on a non-2xx response
   * so errorHint()/hintFor() can classify it (the seam vault.ts and vision.ts
   * used to bypass via a private-member cast — see git history). Accepts
   * either a path relative to this.baseUrl OR an absolute http(s) URL, since
   * media assets can live on a different host than the API itself.
   *
   * The bearer token is attached ONLY when `target` shares baseUrl's origin
   * (isSameOrigin — scheme+host+port), never merely because it's https: a
   * media asset on a different host (a presumably presigned or public CDN)
   * has no business receiving the user's live session token just because
   * that host also happens to be https. A cross-origin target is fetched
   * unauthenticated instead of failing closed — refusing the whole download
   * would be worse than simply not sending credentials it was never entitled
   * to.
   *
   * `timeoutMs` (default AETHER_REQUEST_TIMEOUT_MS, 30s; 0 disables) bounds
   * the connect/response-headers phase, same as request() — this previously
   * had NO timeout at all. Once headers arrive, the body is wrapped with the
   * same idle/quiet-period timeout stream() uses (withIdleTimeout) rather
   * than a flat overall cap, so a large-but-healthy download can't be killed
   * mid-flight just for taking a while.
   */
  async getBinary(pathOrUrl: string, signal?: AbortSignal, timeoutMs?: number): Promise<Response> {
    const target = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : this.url(pathOrUrl);
    const attachAuth = isSameOrigin(target, this.baseUrl);
    const effTimeoutMs = normalizeTimeoutMs(timeoutMs ?? defaultRequestTimeoutMs());
    const net = new AbortController();
    const releaseNet = (): void => net.abort();
    if (signal) {
      if (signal.aborted) releaseNet();
      else signal.addEventListener("abort", releaseNet, { once: true });
    }
    const cleanup = (): void => signal?.removeEventListener("abort", releaseNet);
    try {
      let used: string | null = null;
      const send = async (): Promise<Response> => {
        let headers: Record<string, string> = {};
        if (attachAuth) {
          used = await this.tokens.get();
          headers = await this.authHeaders(used);
        }
        return raceAgainst(
          fetch(target, { headers, signal: net.signal }),
          signal,
          effTimeoutMs,
          () => new RequestTimeoutError(effTimeoutMs),
        );
      };
      let res = await send();
      if (res.status === 401 && (await this.refreshSession(pathOrUrl, used, signal))) {
        void res.body?.cancel().catch(() => {});
        res = await send();
      }
      if (!res.ok) {
        throw await toHttpError(res, signal, effTimeoutMs, () => new RequestTimeoutError(effTimeoutMs));
      }
      if (!res.body) {
        cleanup();
        return res;
      }
      const wrapped = toReadableStream(
        withIdleTimeout(res.body as unknown as AsyncIterable<Uint8Array>, signal, effTimeoutMs, releaseNet, cleanup),
      );
      return new Response(wrapped, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (err) {
      releaseNet();
      cleanup();
      // `target` can be a server-controlled absolute URL (media_url in a
      // generation response) with embedded control bytes. Every OTHER thrown
      // error here is a typed class this module controls the wording of;
      // fetch()'s OWN url-parse failure is a plain TypeError that echoes the
      // raw `target` string verbatim in err.message — the one path an OSC/CSI
      // sequence from a hostile backend could still reach the terminal
      // unsanitized. Strip it the same way every other server-supplied string
      // in this module is stripped (sanitizeServerText).
      if (
        err instanceof Error &&
        !(err instanceof HttpError) &&
        !(err instanceof RequestTimeoutError) &&
        !(err instanceof InsecureTransportError) &&
        !(err instanceof StreamTimeoutError) &&
        !(err instanceof StreamUnavailableError) &&
        err.name !== "AbortError"
      ) {
        throw new Error(sanitizeServerText(err.message));
      }
      throw err;
    }
  }

  /**
   * Authed JSON POST whose successful response is binary (for example the
   * Cloud Voice synthesis route). This deliberately returns a Response so the
   * caller can inspect media-type and provenance headers before consuming the
   * bytes. Authentication refresh, connect timeout, caller abort, typed HTTP
   * errors, and the response-body idle timeout match getBinary().
   */
  async postJsonBinary(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<Response> {
    const effTimeoutMs = normalizeTimeoutMs(timeoutMs ?? defaultRequestTimeoutMs());
    const net = new AbortController();
    const releaseNet = (): void => net.abort();
    if (signal) {
      if (signal.aborted) releaseNet();
      else signal.addEventListener("abort", releaseNet, { once: true });
    }
    const cleanup = (): void => signal?.removeEventListener("abort", releaseNet);
    try {
      let used: string | null = null;
      const send = async (): Promise<Response> => {
        used = await this.tokens.get();
        return raceAgainst(
          fetch(this.url(path), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "audio/*, application/octet-stream",
              ...(await this.authHeaders(used)),
            },
            body: JSON.stringify(body),
            signal: net.signal,
          }),
          signal,
          effTimeoutMs,
          () => new RequestTimeoutError(effTimeoutMs),
        );
      };
      let res = await send();
      if (res.status === 401 && (await this.refreshSession(path, used, signal))) {
        void res.body?.cancel().catch(() => {});
        res = await send();
      }
      if (!res.ok) {
        throw await toHttpError(res, signal, effTimeoutMs, () => new RequestTimeoutError(effTimeoutMs));
      }
      if (!res.body) {
        cleanup();
        return res;
      }
      const wrapped = toReadableStream(
        withIdleTimeout(res.body as unknown as AsyncIterable<Uint8Array>, signal, effTimeoutMs, releaseNet, cleanup),
      );
      return new Response(wrapped, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (err) {
      releaseNet();
      cleanup();
      throw err;
    }
  }

  /**
   * Authed multipart POST — vault file upload. Same refresh-on-401 retry and
   * HttpError classification as request(). Content-Type is left for fetch()
   * itself to set (so it can add the multipart boundary); only the bearer
   * header, if any, is layered on top of the caller's FormData body.
   *
   * `timeoutMs` (default AETHER_REQUEST_TIMEOUT_MS, 30s; 0 disables) bounds
   * the request the same way request() does — this previously had NO timeout
   * at all, so a stalled upload connection would hang forever.
   */
  async postForm<T>(path: string, form: FormData, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    const effTimeoutMs = normalizeTimeoutMs(timeoutMs ?? defaultRequestTimeoutMs());
    const net = new AbortController();
    const releaseNet = (): void => net.abort();
    if (signal) {
      if (signal.aborted) releaseNet();
      else signal.addEventListener("abort", releaseNet, { once: true });
    }
    try {
      let used: string | null = null;
      const send = async (): Promise<Response> => {
        used = await this.tokens.get();
        return raceAgainst(
          fetch(this.url(path), {
            method: "POST",
            headers: await this.authHeaders(used),
            body: form,
            signal: net.signal,
          }),
          signal,
          effTimeoutMs,
          () => new RequestTimeoutError(effTimeoutMs),
        );
      };
      let res = await send();
      if (res.status === 401 && (await this.refreshSession(path, used, signal))) {
        void res.body?.cancel().catch(() => {});
        res = await send();
      }
      if (!res.ok) {
        throw await toHttpError(res, signal, effTimeoutMs, () => new RequestTimeoutError(effTimeoutMs));
      }
      return await parseOkBody<T>(res, signal, effTimeoutMs);
    } finally {
      releaseNet();
      signal?.removeEventListener("abort", releaseNet);
    }
  }

  private async request<T>(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      signal?: AbortSignal;
      timeoutMs?: number;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    // `?? ` (not `||`) so an explicit 0 (disabled) from a caller survives —
    // only an OMITTED timeoutMs falls back to the env-driven default.
    const timeoutMs = normalizeTimeoutMs(opts.timeoutMs ?? defaultRequestTimeoutMs());
    const signal = opts.signal;
    // Bounded by default (AETHER_REQUEST_TIMEOUT_MS, 30s): unlike stream(),
    // this had NO timeout at all — a silently-dropped connection to /models,
    // /auth/refresh, or the device-poll endpoint would hang forever with
    // nothing but the caller's own (often absent) AbortSignal to save it.
    // `net` is a SEPARATE controller from the caller's own `signal` (mirrors
    // stream()) so releasing the socket on timeout can never be mistaken for
    // the caller's own abort.
    const net = new AbortController();
    const releaseNet = (): void => net.abort();
    if (signal) {
      if (signal.aborted) releaseNet();
      else signal.addEventListener("abort", releaseNet, { once: true });
    }
    try {
      let used: string | null = null;
      const send = async (): Promise<Response> => {
        used = await this.tokens.get();
        return raceAgainst(
          fetch(this.url(path), {
            method,
            headers: {
              // Caller headers go FIRST so the client's own transport and
              // credential headers below always win: a caller can add
              // Idempotency-Key, never replace Authorization.
              ...(opts.headers ?? {}),
              ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
              Accept: "application/json",
              ...(await this.authHeaders(used)),
            },
            ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
            signal: net.signal,
          }),
          signal,
          timeoutMs,
          () => new RequestTimeoutError(timeoutMs),
        );
      };
      let res = await send();
      if (res.status === 401 && (await this.refreshSession(path, used, signal))) {
        // Release the rejected response before retrying (see stream()).
        void res.body?.cancel().catch(() => {});
        res = await send();
      }
      if (!res.ok) {
        throw await toHttpError(res, signal, timeoutMs, () => new RequestTimeoutError(timeoutMs));
      }
      return await parseOkBody<T>(res, signal, timeoutMs);
    } finally {
      releaseNet();
      signal?.removeEventListener("abort", releaseNet);
    }
  }
}

/**
 * Parse a 2xx response body for request()/postForm(). An EMPTY body (e.g. 204
 * No Content from deleteJson()) is a legitimate "no data" response and yields
 * `undefined` — but a NON-empty body that still fails to parse as JSON means
 * the server said "ok" and then didn't give usable data (including a
 * connection dropped mid-response, leaving truncated JSON), which is a real
 * problem the caller's own domain check can't be expected to catch (it
 * assumes `T`, not `T | undefined`). That case throws a typed
 * MalformedResponseError instead of silently becoming `undefined as T`, so it
 * flows through errorHint()/hintFor() like any other server-side failure
 * instead of surfacing as a raw property-access TypeError one layer up
 * (e.g. slash.ts's getCatalog -> `cat.models`, auth.ts's authRefresh ->
 * `r.session_token`).
 *
 * Reads the raw text FIRST and only treats a genuinely empty (or
 * whitespace-only) body as "no content" — classifying by the JSON.parse
 * error's message instead (e.g. matching "Unexpected end of JSON input")
 * would also match a truncated-but-nonempty body cut short mid-object, which
 * is exactly the dropped-connection case this fix exists to catch, not a
 * legitimate empty response.
 */
async function parseOkBody<T>(res: Response, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  let text: string;
  try {
    text = await raceAgainst(
      res.text(),
      signal,
      timeoutMs,
      () => new RequestTimeoutError(timeoutMs),
    );
  } catch (error) {
    if (error instanceof RequestTimeoutError || signal?.aborted) throw error;
    throw new MalformedResponseError(res.status);
  }
  if (!text.trim()) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MalformedResponseError(res.status);
  }
}

/**
 * Server-controlled text lands raw in the terminal: strip C0+C1 control chars
 * (ESC, single-byte CSI, newlines) and cap the length. Printable residue of a
 * stripped escape (e.g. "[31m") is harmless text.
 *
 * The one canonical treatment for any raw server-supplied string that may be
 * embedded in an Error message a caller prints to the terminal — shared by
 * toHttpError (below, every non-2xx response) and loginWithPassword's
 * `reason` field (auth.ts), which used to build its thrown Error directly
 * from the unsanitized, uncapped field, bypassing this exact protection
 * (LOOP-06 round 2: an OSC 52 clipboard-hijack payload in a login failure
 * `reason` would otherwise reach the terminal verbatim via login.ts's
 * headless catch).
 */
export function sanitizeServerText(v: string): string {
  return v.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").trim().slice(0, 200);
}

async function toHttpError(
  res: Response,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onTimeout: () => unknown,
): Promise<HttpError> {
  let body: unknown;
  try {
    body = await raceAgainst(res.json(), signal, timeoutMs, onTimeout);
  } catch (error) {
    if (error instanceof RequestTimeoutError || error instanceof StreamTimeoutError || signal?.aborted) throw error;
    body = undefined;
  }
  // Surface the server's own explanation (FastAPI uses `detail`, others
  // `message`/`reason`/`error`) so e.g. a UVT-balance rejection reads as
  // "HTTP 401: insufficient UVT balance" instead of an opaque "HTTP 401".
  let msg = `HTTP ${res.status}`;
  if (body && typeof body === "object") {
    for (const k of ["message", "detail", "reason", "error"]) {
      const v = (body as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) {
        msg = `HTTP ${res.status}: ${sanitizeServerText(v)}`;
        break;
      }
    }
  }
  return new HttpError(res.status, msg, body);
}
function normalizeStreamOptions(signalOrOptions?: AbortSignal | StreamOptions): {
  signal?: AbortSignal;
  timeoutMs: number;
  method: "POST" | "GET";
} {
  const isSignal =
    !!signalOrOptions && "aborted" in signalOrOptions && "addEventListener" in signalOrOptions;
  const opts: StreamOptions = isSignal
    ? { signal: signalOrOptions as AbortSignal }
    : ((signalOrOptions as StreamOptions | undefined) ?? {});
  return {
    signal: opts.signal,
    timeoutMs: normalizeTimeoutMs(opts.timeoutMs ?? defaultStreamTimeoutMs()),
    method: opts.method ?? "POST",
  };
}

/** Exported so tests can pin AETHER_STREAM_TIMEOUT_MS parsing without a live stream. */
export function defaultStreamTimeoutMs(): number {
  const raw = process.env["AETHER_STREAM_TIMEOUT_MS"];
  if (raw == null || raw.trim() === "") return DEFAULT_STREAM_TIMEOUT_MS;
  const parsed = Number(raw);
  // Environment configuration is the production path and may never remove
  // the bound. Library callers/tests can still opt out explicitly with
  // `{timeoutMs: 0}` on one request without making every terminal stream
  // vulnerable to a ping-only infinite wait.
  return normalizeTimeoutMs(parsed) || DEFAULT_STREAM_TIMEOUT_MS;
}

function normalizeTimeoutMs(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
}

/** Exported so tests can pin AETHER_REQUEST_TIMEOUT_MS parsing without a live request. */
export function defaultRequestTimeoutMs(): number {
  const raw = process.env["AETHER_REQUEST_TIMEOUT_MS"];
  if (raw == null || raw.trim() === "") return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = Number(raw);
  // As with stream defaults, an environment value cannot globally disable the
  // production bound. Explicit per-call `{timeoutMs: 0}` remains the narrow
  // embed/test escape hatch.
  return normalizeTimeoutMs(parsed) || DEFAULT_REQUEST_TIMEOUT_MS;
}

/** Races `promise` against the caller's own abort and an independent timeout
 *  timer. Each loses its race with its own error (the caller's real
 *  AbortError, or `onTimeout()`'s error — StreamTimeoutError for stream(),
 *  RequestTimeoutError for request()) — there's no shared mutable "reason"
 *  field for the two to race over, so neither can be mistaken for the other
 *  regardless of which fires first. */
function raceAgainst<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onTimeout: () => unknown = () => new StreamTimeoutError(timeoutMs),
): Promise<T> {
  if (signal?.aborted) {
    // `promise` (e.g. fetch(net.signal), already argument-evaluated by the
    // caller before raceAgainst runs) is being discarded in favor of one
    // consistent abortError(signal) result below -- but it can still go on
    // to reject on its own (net.signal was wired to the same abort). Always
    // attach a swallow-only catch so THAT rejection can never surface as an
    // unhandled promise rejection (mirrors withIdleTimeout's iterator.return()
    // handling below).
    promise.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  const racers: Promise<T>[] = [promise];
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs > 0) {
    racers.push(
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs);
        timer.unref?.();
      }),
    );
  }
  let onAbort: (() => void) | undefined;
  if (signal) {
    racers.push(
      new Promise<T>((_, reject) => {
        onAbort = () => reject(abortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }
  return Promise.race(racers).finally(() => {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  });
}

/** A caller may leave a shared refresh independently. Once the refresh has
 * crossed into TokenStore.update(), however, that interface has no abort or
 * rollback contract; keep the cancelled caller pending until the write has
 * settled so no credential mutation can occur after its request returns. */
function waitForRefreshFlight(
  flight: RefreshFlight,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!signal) return flight.promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let cancelled = false;
    const finish = (error: unknown | null, value?: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error !== null) reject(error);
      else resolve(Boolean(value));
    };
    const onAbort = (): void => {
      cancelled = true;
      if (!flight.committing) finish(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    flight.promise.then(
      (value) => finish(cancelled ? abortError(signal) : null, value),
      (error: unknown) => finish(cancelled ? abortError(signal) : error),
    );
  });
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

async function* withIdleTimeout(
  stream: AsyncIterable<Uint8Array>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  releaseNet: () => void,
  cleanup: () => void,
): AsyncIterable<Uint8Array> {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await raceAgainst(iterator.next(), signal, timeoutMs);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    releaseNet();
    cleanup();
    // iterator.return() can reject (e.g. the body was already aborted) — always
    // attach a handler so a rejecting cleanup can never surface as an unhandled
    // promise rejection (which the REPL's global handler turns into a crash).
    iterator.return?.()?.catch(() => {});
  }
}

/**
 * Wrap an async iterable (withIdleTimeout()'s output) as a Web ReadableStream
 * so getBinary() can hand back a genuine Response whose `.body` still behaves
 * like a normal fetch body for its callers (vault.ts/vision.ts pipe it
 * straight to disk). A pull() rejection — an idle-timeout or abort surfacing
 * from the wrapped iterator — errors the stream instead of hanging it; per
 * the Streams spec a rejected pull() automatically errors the stream with
 * that reason, so no separate try/catch is needed here.
 */
function toReadableStream(iterable: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}
