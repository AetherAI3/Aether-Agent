// Optional RC observer for the shared coding-run event seam. No enrollment or
// network operation occurs unless `rc start` left an active local outbox.

import type { BrainEvent } from "../core/brain_protocol.js";
import { resolve } from "node:path";
import type { ApiClient } from "../core/transport.js";
import { flushOutbox, type RcHostDeps } from "../core/rc/host.js";
import { checkoutDiffSummary } from "../core/rc/diff_summary.js";
import { enqueueEvent, loadOutbox, saveOutbox } from "../core/rc/outbox.js";
import { mapBrainEventToRc } from "../core/rc/producers.js";
import { projectRefFor, rcOutboxPath } from "./rc.js";

export interface RcCodingObserver {
  feed(event: BrainEvent): void;
  publishDiff(checkoutRoot: string): Promise<void>;
  /** Lets integration tests wait for a started upload; the coding run never does. */
  drain(): Promise<void>;
}

export function openRcCodingObserver(
  projectRoot: string,
  api: ApiClient,
  outboxPath?: string,
): RcCodingObserver | null {
  try {
    const root = resolve(projectRoot);
    const path = outboxPath ?? rcOutboxPath(projectRefFor(root));
    const record = loadOutbox(path, root);
    if (!record.session_id || record.revoke_pending || record.project_ref !== projectRefFor(root) || record.project_root !== root) return null;
    const deps: RcHostDeps = { api, outboxPath: path, projectRoot: root };
    let pending: Promise<void> = Promise.resolve();
    let flushing = false;
    let stopped = false;

    const flush = (): void => {
      if (flushing || stopped) return;
      flushing = true;
      pending = (async () => {
        try {
          while (record.events.length > 0) {
            const current = loadOutbox(path, root);
            if (current.session_id !== record.session_id || current.revoke_pending) {
              stopped = true;
              return;
            }
            const outcome = await flushOutbox(deps, record);
            if (!outcome.ok) return;
          }
        } catch {
          // Observation must never change the local coding result.
        } finally {
          flushing = false;
        }
      })();
    };

    return {
      feed(event): void {
        if (stopped) return;
        try {
          const produced = mapBrainEventToRc(event);
          if (!produced) return;
          const current = loadOutbox(path, root);
          if (current.session_id !== record.session_id || current.revoke_pending) {
            stopped = true;
            return;
          }
          if (!enqueueEvent(record, produced.event_type, produced.payload)) return;
          saveOutbox(path, record); // sanitize and persist before any upload
          flush(); // deliberately never awaited by the coding run
        } catch {
          // A broken or unwritable outbox is an RC failure, not a coding failure.
        }
      },
      async publishDiff(checkoutRoot): Promise<void> {
        if (stopped) return;
        try {
          const event = await checkoutDiffSummary(checkoutRoot);
          if (!event) return;
          const current = loadOutbox(path, root);
          if (current.session_id !== record.session_id || current.revoke_pending) {
            stopped = true;
            return;
          }
          if (!enqueueEvent(record, event.event_type, event.payload)) return;
          saveOutbox(path, record);
          flush();
        } catch {
          // A diff observation cannot change the local coding result.
        }
      },
      drain: () => pending,
    };
  } catch {
    return null;
  }
}
