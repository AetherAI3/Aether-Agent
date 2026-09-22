// Machine-local resource names never confer managed-run or device authority.
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ApiClient } from "./transport.js";
import type { AppContext } from "./context.js";
import { ManagedAgentsClient, MANAGED_AGENT_ID } from "./managed_agents.js";
import { loadEnrollmentMetadata, type EnrollmentMetadata } from "./device_runtime/identity.js";

export interface ManagedAccountScope {
  cloudOrigin: string;
  accountSubject: string;
}

export interface LocalBrowserOwner {
  origin: string;
  accountSubject: string;
  agentId: string;
  deviceId: string;
}

const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Accept only the canonical subject returned by the authenticated identity API. */
export function managedAccountScope(baseUrl: string, accountSubject: string): ManagedAccountScope {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) {
    throw new Error("Managed local resources require a verified HTTPS or local Cloud origin.");
  }
  if (!SUBJECT.test(accountSubject)) throw new Error("Cloud returned an invalid canonical account identity.");
  return { cloudOrigin: url.origin, accountSubject };
}

export function managedAgentStorageDirectory(root: string, scope: ManagedAccountScope, agentId: string): string {
  if (!isAbsolute(root) || root.includes("\0")) throw new Error("Managed local storage requires an absolute directory.");
  if (!MANAGED_AGENT_ID.test(agentId)) throw new Error("Invalid managed agent identity.");
  const verified = managedAccountScope(scope.cloudOrigin, scope.accountSubject);
  const account = createHash("sha256").update(JSON.stringify([verified.cloudOrigin, verified.accountSubject])).digest("hex");
  return join(resolve(root), account, agentId);
}

/** Reuse enrollment metadata when present; otherwise name only this local install.
 * The local fallback is a resource namespace, never an enrollment or run lease.
 */
export function managedBrowserOwner(
  root: string, scope: ManagedAccountScope, agentId: string,
  deps: { enrollment?: () => EnrollmentMetadata | null; hostname?: () => string } = {},
): LocalBrowserOwner {
  managedAgentStorageDirectory(root, scope, agentId);
  const enrollment = (deps.enrollment ?? loadEnrollmentMetadata)();
  let deviceId: string | undefined;
  if (enrollment && /^scdev_[0-9a-f]{16}$/.test(enrollment.device_id)) {
    try { if (new URL(enrollment.base_url).origin === scope.cloudOrigin) deviceId = enrollment.device_id; } catch { /* Not this origin. */ }
  }
  deviceId ??= "local_" + createHash("sha256").update(JSON.stringify([resolve(root), (deps.hostname ?? hostname)()])).digest("hex").slice(0, 32);
  return { origin: scope.cloudOrigin, accountSubject: scope.accountSubject, agentId, deviceId };
}

/** Freeze authentication for one identity-bound operation. The shared token store
 * can change at any await boundary; dispatch must never re-read it for this run.
 * Session refresh may fail this operation, but cannot replace either credential.
 */
export async function managedAccountOperation(ctx: AppContext, signal?: AbortSignal): Promise<{
  account: ManagedAccountScope;
  client: ManagedAgentsClient;
  assertCurrent(): Promise<void>;
}> {
  signal?.throwIfAborted();
  const baseUrl = ctx.cfg.baseUrl;
  const token = await ctx.tokens.get();
  if (!token) throw new Error("Sign in with `aether auth login` before opening local agent resources.");
  const rejectMutation = async (): Promise<never> => { throw new Error("The operation credential cannot refresh. Sign in again and retry."); };
  const fixedTokens = Object.freeze({ get: async () => token, set: rejectMutation, update: rejectMutation, clear: rejectMutation });
  const client = new ManagedAgentsClient(new ApiClient(baseUrl, fixedTokens));
  const assertCurrent = async (): Promise<void> => {
    signal?.throwIfAborted();
    if (await ctx.tokens.get() !== token || ctx.cfg.baseUrl !== baseUrl) {
      throw new Error("Sign-in changed during this account operation. Reopen the agent from the current account; pending state is preserved.");
    }
  };
  const account = managedAccountScope(baseUrl, await client.identity(signal));
  await assertCurrent();
  return { account, client, assertCurrent };
}
