// Media commands → RC: hand each committed media-history entry to the active
// RC session for the launch project. The same project resolution the
// orchestra commands use (slash_orchestra.ts publishWorkers): the RC session
// belongs to `ctx.flags.cwd`, and nothing is read or sent unless `rc start`
// left an active outbox for it.

import { resolve } from "node:path";
import type { AppContext } from "../core/context.js";
import type { MediaEntry } from "../core/media_history.js";
import { publishArtifactEntry } from "../core/rc/artifacts.js";
import { projectRefFor, rcOutboxPath } from "./rc.js";

/**
 * A commit observer for recordOutput. Fire-and-forget by design: the media
 * command reports its file as soon as it is recorded, and the event is already
 * durable in the outbox when this returns, so nothing waits on the broker.
 */
export function rcArtifactObserver(ctx: Pick<AppContext, "api" | "flags">): (entry: MediaEntry) => void {
  return (entry) => {
    try {
      const root = resolve(ctx.flags.cwd);
      void publishArtifactEntry(ctx.api, root, rcOutboxPath(projectRefFor(root)), entry);
    } catch {
      // Resolving the RC path is RC's problem, never the media command's.
    }
  };
}
