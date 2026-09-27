/** Browser OAuth bootstrap for an account-bound Cloud Drive staff session.
 *
 * Cloud already exposes the GitHub desktop loopback handoff. The CLI owns a
 * random localhost listener and SHA-256 handoff verifier; the browser sees
 * only the provider authorization URL. No aek_ PAT is sent to this flow, and
 * the returned opaque session is stored only after Cloud's staff gate accepts
 * it. This does not grant a role or enable Drive execution.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppContext } from "./context.js";
import { StaticTokenStore } from "./auth.js";
import { isOpaqueDesktopSession } from "./drive_staff_session.js";
import { ApiClient, isCredentialSafeUrl } from "./transport.js";
import { HttpError } from "./errors.js";

const START_PATH = "/v1/auth/oauth/github/start";
const COMPLETE_PATH = "/v1/auth/oauth/complete";
const STAFF_PROBE_PATH = "/internal/dev/supercluster/predator-drive/diagnose?mode=oss&host=auto";
const FLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDOFF = /^[A-Za-z0-9_-]{32,256}$/;

export type DriveStaffLoginErrorCode =
  | "SESSION_STORE_UNAVAILABLE" | "OAUTH_UNAVAILABLE" | "OAUTH_CALLBACK_TIMEOUT"
  | "OAUTH_DENIED" | "ACCOUNT_LINK_REQUIRED" | "STAFF_SESSION_REQUIRED"
  | "CLOUD_ROUTE_UNAVAILABLE";

export class DriveStaffLoginError extends Error {
  constructor(readonly code: DriveStaffLoginErrorCode) {
    super(code);
    this.name = "DriveStaffLoginError";
  }
}

export interface DriveStaffLoginDependencies {
  onAuthorizeUrl: (authorizationUrl: string, loopbackUrl: string) => Promise<void> | void;
  fetchImpl?: typeof fetch;
  /** Unit tests may replace the Cloud probe; production always calls Drive. */
  probeStaff?: (token: string) => Promise<void>;
  /** Best-effort cleanup when a minted candidate is refused before storage. */
  revokeSession?: (token: string) => Promise<void>;
  callbackTimeoutMs?: number;
}

type OAuthStart = { flow_id: string; authorization_url: string; expires_in: number };
type OAuthCallback = { flowId: string; handoffCode: string };

function endpoint(baseUrl: string, path: string): string {
  if (!isCredentialSafeUrl(baseUrl)) throw new DriveStaffLoginError("OAUTH_UNAVAILABLE");
  return baseUrl.replace(/\/+$/, "") + path;
}

async function postJson(
  fetchImpl: typeof fetch, url: string, payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await response.text();
    if (raw.length > 8192) throw new Error("oversized OAuth response");
    const parsed: unknown = JSON.parse(raw);
    if (!response.ok || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OAuth response failed");
    }
    return parsed as Record<string, unknown>;
  } catch {
    // The upstream body can carry untrusted text, secrets, or control bytes.
    throw new DriveStaffLoginError("OAUTH_UNAVAILABLE");
  }
}

function parseStart(value: Record<string, unknown>): OAuthStart {
  const flow = value["flow_id"];
  const rawUrl = value["authorization_url"];
  const expires = value["expires_in"];
  if (typeof flow !== "string" || !FLOW_ID.test(flow) ||
      typeof rawUrl !== "string" || rawUrl.length > 4096 || /[\x00-\x1f\x7f]/.test(rawUrl) ||
      typeof expires !== "number" || !Number.isSafeInteger(expires) ||
      expires < 30 || expires > 900) {
    throw new DriveStaffLoginError("OAUTH_UNAVAILABLE");
  }
  let authorization: URL;
  try { authorization = new URL(rawUrl); }
  catch { throw new DriveStaffLoginError("OAUTH_UNAVAILABLE"); }
  if (authorization.protocol !== "https:" || authorization.hostname !== "github.com" ||
      authorization.pathname !== "/login/oauth/authorize" ||
      authorization.username || authorization.password || authorization.hash) {
    throw new DriveStaffLoginError("OAUTH_UNAVAILABLE");
  }
  return { flow_id: flow, authorization_url: authorization.href, expires_in: expires };
}

async function probeCloudStaff(ctx: AppContext, token: string): Promise<void> {
  const api = new ApiClient(ctx.cfg.baseUrl, new StaticTokenStore(token));
  try {
    const row: unknown = await api.getJson(STAFF_PROBE_PATH, undefined, 10_000);
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        (row as Record<string, unknown>)["mode"] !== "oss" ||
        (row as Record<string, unknown>)["requested_host"] !== "auto") {
      throw new DriveStaffLoginError("CLOUD_ROUTE_UNAVAILABLE");
    }
  } catch (error) {
    if (error instanceof DriveStaffLoginError) throw error;
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      throw new DriveStaffLoginError("STAFF_SESSION_REQUIRED");
    }
    throw new DriveStaffLoginError("CLOUD_ROUTE_UNAVAILABLE");
  }
}

async function revokeCloudSession(ctx: AppContext, token: string): Promise<void> {
  const api = new ApiClient(ctx.cfg.baseUrl, new StaticTokenStore(token));
  await api.postJson("/auth/logout", { session_token: token }, undefined, 10_000);
}

function callbackPage(ok: boolean): string {
  const text = ok ? "Aether sign-in received. You may close this tab."
    : "Aether sign-in callback was not recognized.";
  return `<!doctype html><meta charset="utf-8"><title>Aether sign-in</title><body>${text}</body>`;
}

/** Bind loopback before asking Cloud to create a handoff to that exact port. */
async function listenForCallback(): Promise<{
  server: Server; loopbackUrl: string;
  setFlowId: (flowId: string) => void;
  wait: (timeoutMs: number) => Promise<OAuthCallback>;
}> {
  let expectedFlow = "";
  let accepted = false;
  let resolveCallback!: (value: OAuthCallback) => void;
  let rejectCallback!: (error: DriveStaffLoginError) => void;
  const callback = new Promise<OAuthCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (request.method !== "GET" || !request.url || request.url.length > 2048) {
      response.writeHead(404).end(callbackPage(false));
      return;
    }
    let url: URL;
    try { url = new URL(request.url, "http://127.0.0.1"); }
    catch { response.writeHead(404).end(callbackPage(false)); return; }
    const flowId = url.searchParams.get("flow_id") ?? "";
    const handoffCode = url.searchParams.get("handoff_code") ?? "";
    if (accepted || url.pathname !== "/cb" || url.searchParams.get("provider") !== "github" ||
        !expectedFlow || flowId !== expectedFlow || !HANDOFF.test(handoffCode) ||
        !["success", "error"].includes(url.searchParams.get("result") ?? "")) {
      response.writeHead(404).end(callbackPage(false));
      return;
    }
    accepted = true;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(callbackPage(true));
    resolveCallback({ flowId, handoffCode });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch {
    throw new DriveStaffLoginError("OAUTH_UNAVAILABLE");
  }
  const address = server.address() as AddressInfo;
  return {
    server, loopbackUrl: `http://127.0.0.1:${address.port}/cb`,
    setFlowId: (value) => { expectedFlow = value; },
    wait: async (timeoutMs) => {
      const timer = setTimeout(
        () => rejectCallback(new DriveStaffLoginError("OAUTH_CALLBACK_TIMEOUT")), timeoutMs,
      );
      try { return await callback; }
      finally { clearTimeout(timer); }
    },
  };
}

export async function loginDriveStaffSession(
  ctx: AppContext, dependencies: DriveStaffLoginDependencies,
): Promise<void> {
  const store = ctx.driveStaffTokens;
  if (!store) throw new DriveStaffLoginError("SESSION_STORE_UNAVAILABLE");
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
  const loopback = await listenForCallback();
  let candidateToken: string | null = null;
  let committed = false;
  try {
    const start = parseStart(await postJson(fetchImpl, endpoint(ctx.cfg.baseUrl, START_PATH), {
      client: "desktop", intent: "sign_in", handoff_challenge: challenge,
      loopback: loopback.loopbackUrl, post_auth_target: "platform",
    }));
    loopback.setFlowId(start.flow_id);
    await dependencies.onAuthorizeUrl(start.authorization_url, loopback.loopbackUrl);
    const timeoutMs = Math.min(start.expires_in * 1000, dependencies.callbackTimeoutMs ?? 300_000);
    const callback = await loopback.wait(timeoutMs);
    const completed = await postJson(fetchImpl, endpoint(ctx.cfg.baseUrl, COMPLETE_PATH), {
      provider: "github", flow_id: callback.flowId,
      handoff_code: callback.handoffCode, handoff_verifier: verifier,
    });
    if (completed["authenticated"] !== true) {
      throw new DriveStaffLoginError(
        completed["error_code"] === "existing_account_requires_link"
          ? "ACCOUNT_LINK_REQUIRED" : "OAUTH_DENIED",
      );
    }
    const token = completed["session_token"];
    if (typeof token !== "string" || !isOpaqueDesktopSession(token)) {
      throw new DriveStaffLoginError("OAUTH_UNAVAILABLE");
    }
    candidateToken = token;
    await (dependencies.probeStaff ?? ((candidate) => probeCloudStaff(ctx, candidate)))(token);
    await store.set(token);
    committed = true;
  } finally {
    if (candidateToken && !committed) {
      try {
        await (dependencies.revokeSession ?? ((token) => revokeCloudSession(ctx, token)))(candidateToken);
      } catch {
        // Preserve the original login refusal; the candidate was never stored.
      }
    }
    await new Promise<void>((resolve) => loopback.server.close(() => resolve()));
  }
}

export async function logoutDriveStaffSession(ctx: AppContext): Promise<boolean> {
  const store = ctx.driveStaffTokens;
  if (!store) throw new DriveStaffLoginError("SESSION_STORE_UNAVAILABLE");
  const token = await store.get();
  if (!isOpaqueDesktopSession(token)) {
    await store.clear();
    return true;
  }
  let revoked = false;
  try {
    await revokeCloudSession(ctx, token);
    revoked = true;
  } catch {
    // Clear locally even if Cloud is unavailable; report unconfirmed revocation.
  }
  await store.clear();
  return revoked;
}
