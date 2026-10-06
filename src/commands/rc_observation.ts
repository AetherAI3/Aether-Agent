// Optional RC observer for the shared coding-run event seam. No enrollment or
// network operation occurs unless `rc start` left an active local outbox.

import type { BrainEvent } from "../core/brain_protocol.js";
import { resolve } from "node:path";
import type { ApiClient } from "../core/transport.js";
import { flushOutbox, type RcHostDeps } from "../core/rc/host.js";
import { checkoutDiffSummary } from "../core/rc/diff_summary.js";
import { enqueueEvent, isPublishable, loadOutbox, saveOutbox } from "../core/rc/outbox.js";
import { mapBrainEventToRc, type RcProducedEvent } from "../core/rc/producers.js";
import { projectRefFor, rcOutboxPath } from "./rc.js";

export interface RcCodingObserver {
  /** The project root the outbox is bound to — what its sanitizer relativizes against. */
  readonly projectRoot: string;
  feed(event: BrainEvent): void;
  /**
   * Queue an event another host subsystem produced (the verify gate's tests
   * reading) through the SAME sanitize → persist → flush path as `feed`. In a
   * coding run it must go through this observer rather than a second writer:
   * the observer holds the outbox record in memory and saves it after every
   * receipt, so an event another writer saved meanwhile would be overwritten.
   */
  publish(event: RcProducedEvent): void;
  /** Queue Git's measured checkout snapshot through `publish` (#218). */
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
    let record = loadOutbox(path, root);
    // Only a session this host attached to, read from trustworthy state (#227).
    if (!isPublishable(record, root) || record.project_ref !== projectRefFor(root)) return null;
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

    const publish = (produced: RcProducedEvent): void => {
      if (stopped) return;
      try {
        const current = loadOutbox(path, root);
        if (current.session_id !== record.session_id || current.revoke_pending) {
          stopped = true;
          return;
        }
        // Reload before enqueue. Another writer — a standalone `aether review`,
        // `/review` in this REPL — may have queued events since our last save,
        // and saving our older copy would delete them. While an upload is in
        // flight its record must stay the one it commits receipts to, so that
        // copy is kept: a foreign event saved during an upload can still be
        // overwritten, as can ours by the other writer's own post-receipt save.
        // A single writer per outbox (#223's host pump) is the complete fix.
        if (!flushing) record = current;
        if (!enqueueEvent(record, produced.event_type, produced.payload)) return;
        saveOutbox(path, record); // sanitize and persist before any upload
        flush(); // deliberately never awaited by the coding run
      } catch {
        // A broken or unwritable outbox is an RC failure, not a coding failure.
      }
    };

    return {
      projectRoot: root,
      feed(event): void {
        if (stopped) return;
        try {
          const produced = mapBrainEventToRc(event);
          if (produced) publish(produced);
        } catch {
          // Mapping is pure, but observation must never change the local run.
        }
      },
      publish,
      async publishDiff(checkoutRoot): Promise<void> {
        if (stopped) return;
        try {
          // The same reload → sanitize → persist → flush path as every other
          // event, so a diff never saves an older copy over another writer's.
          const event = await checkoutDiffSummary(checkoutRoot);
          if (event) publish(event);
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
