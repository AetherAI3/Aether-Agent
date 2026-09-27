/** Select a real account-bound session for Cloud Drive staff routes.
 *
 * The ordinary `aether auth login` device grant stores an aek_ PAT. It may
 * continue to serve general Agent calls, but it is never forwarded to Drive.
 * An explicitly embedded desktop session wins. A standalone CLI prefers its
 * dedicated Drive sign-in over an older general session on disk. Cloud still
 * validates staff role and lane membership.
 */

import type { AppContext } from "./context.js";
import { EnvOverrideTokenStore } from "./auth.js";
import { ApiClient } from "./transport.js";

export function isOpaqueDesktopSession(token: string | null): token is string {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token);
}

export async function driveStaffContext(ctx: AppContext): Promise<AppContext> {
  const ordinary = await ctx.tokens.get();
  if (ctx.tokens instanceof EnvOverrideTokenStore && isOpaqueDesktopSession(ordinary)) return ctx;
  // A non-session credential, including aek_/agt_/MCP tokens, is never
  // borrowed as staff authority. Contexts without an explicit staff store
  // keep the existing local denial behavior.
  const staff = await ctx.driveStaffTokens?.get() ?? null;
  if (!ctx.driveStaffTokens || !isOpaqueDesktopSession(staff)) return ctx;
  return {
    ...ctx,
    tokens: ctx.driveStaffTokens,
    api: new ApiClient(ctx.cfg.baseUrl, ctx.driveStaffTokens),
  };
}
