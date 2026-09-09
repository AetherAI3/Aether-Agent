// MCP broker client — connections, OAuth/PAT flows, tool catalog. The broker
// is mounted at /mcp-broker on the Aether API (flag-gated server-side); a 404
// on these paths means "backend broker not enabled yet" and callers degrade.

import type { ApiClient } from "./transport.js";

export const MCP_PROVIDERS_PATH = "/mcp-broker/oauth/providers";
export const MCP_CONNECTIONS_PATH = "/mcp-broker/oauth/connections";
export const MCP_OAUTH_START_PATH = "/mcp-broker/oauth/start";
export const MCP_PAT_STORE_PATH = "/mcp-broker/oauth/pat-store";
export const MCP_DISCONNECT_PATH = "/mcp-broker/oauth/disconnect";
export const MCP_TOOLS_PATH = "/mcp-broker/tools"; // + "/{provider_id}"

export interface McpProvider {
  provider_id: string;
  display_name: string;
  flow: "pat_paste" | "auth_code_pkce";
}

export interface McpConnection {
  provider_id: string;
  created_at: string;
  updated_at: string;
}

export interface StartOAuthResponse {
  flow: "pat_paste" | "auth_code_pkce";
  authorize_url?: string;
  validate_endpoint?: string;
}

export interface PatStoreResult {
  ok: boolean;
  reason?: string;
}

export interface ToolDescriptor {
  name: string;
  description?: string;
}

export interface PollOpts {
  intervalSec?: number;
  timeoutSec?: number;
  /**
   * Deadline in milliseconds. Takes precedence over `timeoutSec`, which can
   * only express whole seconds: rounding a sub-second budget UP put this
   * function's deadline at or beyond its caller's supervisor, so the
   * supervisor's generic timeout always won the race and the specific
   * "already connected, left untouched" message was unreachable.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  /**
   * The connection row as it stood BEFORE the browser was opened, or null when
   * the provider was not connected. Capture it with `findConnection` and pass
   * it here: without it, a re-authorization resolves against the row that was
   * already there. See pollUntilConnected.
   */
  since?: McpConnection | null;
}

/** Why an authorization wait ended without a connection. */
export type McpAuthCode = "MCP_AUTH_TIMEOUT" | "MCP_AUTH_CANCELLED";

/**
 * A browser authorization that did not complete.
 *
 * Typed because the two outcomes need different handling and different words:
 * a cancellation is the operator's own Ctrl-C and is not a failure, while a
 * timeout may or may not have left an earlier connection intact. `name` stays
 * "AbortError" for the cancelled case because every cancellation branch in
 * this CLI already matches on that name.
 */
export class McpAuthorizationError extends Error {
  constructor(
    readonly code: McpAuthCode,
    readonly providerId: string,
    message: string,
  ) {
    super(message);
    this.name = code === "MCP_AUTH_CANCELLED" ? "AbortError" : "McpAuthorizationError";
  }
}

/**
 * True when `after` is evidence that the connection row was rewritten.
 *
 * Timestamps are compared as instants, not strings: PostgREST can render the
 * same instant with different precision or offset, and a lexicographic compare
 * would call that a change. When neither value parses — a broker that stopped
 * returning ISO-8601 — a different string is still evidence of a rewrite, and
 * an identical one stays unproven. Unproven fails closed toward "keep waiting,
 * then time out", because a false timeout costs a retry while a false success
 * tells the operator a credential was replaced when it was not.
 */
export function connectionAdvanced(
  before: McpConnection | null | undefined,
  after: McpConnection,
): boolean {
  if (!before) return true;
  const a = Date.parse(before.updated_at);
  const b = Date.parse(after.updated_at);
  if (Number.isFinite(a) && Number.isFinite(b)) return b > a;
  return after.updated_at !== before.updated_at;
}

export interface McpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class McpClient {
  constructor(private readonly api: ApiClient) {}

  listProviders(options: McpRequestOptions = {}): Promise<McpProvider[]> {
    return this.api.getJson<McpProvider[]>(MCP_PROVIDERS_PATH, options.signal, options.timeoutMs);
  }

  listConnections(options: McpRequestOptions = {}): Promise<McpConnection[]> {
    return this.api.getJson<McpConnection[]>(MCP_CONNECTIONS_PATH, options.signal, options.timeoutMs);
  }

  startOAuth(providerId: string, options: McpRequestOptions = {}): Promise<StartOAuthResponse> {
    return this.api.postJson<StartOAuthResponse>(MCP_OAUTH_START_PATH, {
      provider_id: providerId,
    }, options.signal, options.timeoutMs);
  }

  patStore(providerId: string, pat: string, options: McpRequestOptions = {}): Promise<PatStoreResult> {
    return this.api.postJson<PatStoreResult>(MCP_PAT_STORE_PATH, {
      provider_id: providerId,
      pat,
      metadata: {},
    }, options.signal, options.timeoutMs);
  }

  disconnect(providerId: string, options: McpRequestOptions = {}): Promise<{ ok: boolean }> {
    return this.api.postJson<{ ok: boolean }>(MCP_DISCONNECT_PATH, {
      provider_id: providerId,
    }, options.signal, options.timeoutMs);
  }

  listTools(providerId: string, options: McpRequestOptions = {}): Promise<ToolDescriptor[]> {
    return this.api.getJson<ToolDescriptor[]>(
      `${MCP_TOOLS_PATH}/${encodeURIComponent(providerId)}`,
      options.signal,
      options.timeoutMs,
    );
  }

  /** The current connection row for `providerId`, or null. Call this BEFORE
   *  opening the browser and hand the result to `pollUntilConnected` as
   *  `since`, so a re-authorization is proven rather than assumed. */
  async findConnection(
    providerId: string,
    options: McpRequestOptions = {},
  ): Promise<McpConnection | null> {
    const conns = await this.listConnections(options);
    return conns.find((c) => c.provider_id === providerId) ?? null;
  }

  /**
   * Wait for the browser authorization to complete.
   *
   * "Complete" is not "the provider appears in /connections". On a
   * re-authorization — an expired token, a widened scope, the wrong account —
   * the row is already there, so the first poll, issued before the consent
   * screen had even painted, used to resolve against the stale row and report
   * success whether or not the operator finished or cancelled. `opts.since`
   * carries the pre-authorization row and the row must have advanced past it;
   * the Cloud's vault upsert sets updated_at on every write, so a completed
   * authorization always moves it.
   *
   * `sleep` injected for testability — mirrors core/github.ts.
   */
  async pollUntilConnected(
    providerId: string,
    sleep: (ms: number) => Promise<void>,
    opts: PollOpts = {},
  ): Promise<McpConnection> {
    const intervalMs = (opts.intervalSec ?? 2) * 1000;
    const budgetMs = opts.timeoutMs ?? (opts.timeoutSec ?? 180) * 1000;
    const deadline = Date.now() + budgetMs;
    const signal = opts.signal;
    const baseline = opts.since;
    while (Date.now() < deadline) {
      try {
        await abortableSleep(sleep, Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
      } catch (error) {
        // abortableSleep raises its own bare AbortError. Convert it so every
        // exit from this function carries a code, but only when the signal
        // really fired — a sleep implementation that threw for its own reasons
        // must not be relabelled as the operator cancelling.
        if (signal?.aborted) throw cancelled(providerId);
        throw error;
      }
      if (signal?.aborted) throw cancelled(providerId);
      let conns: McpConnection[];
      try {
        conns = await this.listConnections({
          signal,
          timeoutMs: Math.max(
            1,
            Math.min(opts.requestTimeoutMs ?? 10_000, Math.max(1, deadline - Date.now())),
          ),
        });
      } catch (error) {
        if (signal?.aborted) throw cancelled(providerId);
        continue; // transient — retry until deadline
      }
      const hit = conns.find((c) => c.provider_id === providerId);
      if (hit && connectionAdvanced(baseline, hit)) return hit;
    }
    if (signal?.aborted) throw cancelled(providerId);
    // Naming the surviving connection matters: the operator has to know
    // whether the credential they were replacing still works.
    const stillConnected = baseline
      ? `; ${providerId} was already connected and that connection was left untouched`
      : "";
    throw new McpAuthorizationError(
      "MCP_AUTH_TIMEOUT",
      providerId,
      `timed out waiting for ${providerId} authorization${stillConnected}`,
    );
  }
}

function cancelled(providerId: string): McpAuthorizationError {
  return new McpAuthorizationError(
    "MCP_AUTH_CANCELLED",
    providerId,
    `${providerId} authorization was cancelled`,
  );
}

function abortError(): Error {
  const error = new Error("MCP operation aborted");
  error.name = "AbortError";
  return error;
}

async function abortableSleep(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortError();
  if (!signal) {
    await sleep(ms);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => finish(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => sleep(ms))
      .then(() => finish(), (error: unknown) => finish(error));
  });
}
