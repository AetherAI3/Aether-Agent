// publish.ts — the one-shot producer seam outside a coding run (#223).
//
// The outbox FILE is the single truth between everything that writes it: the
// coding run's host pump, /orchestra, and standalone producers — `aether
// review`, an Action Rail receipt, a committed media entry, a preview phase.
// A standalone producer reads the file, queues into exactly what it read,
// saves, and starts a delivery that nobody awaits. flushOutbox re-reads the
// file before it sends and again before it commits receipts, so a writer
// needs no in-flight bookkeeping of its own: whatever another writer queued
// meanwhile is in the file, and is what the next flush sends.
//
// A coding run does NOT publish through here: its observer (commands/
// rc_observation.ts) owns one host pump that heartbeats and delivers for the
// whole run, and a standalone command must not start a second one.

import { flushOutbox, type RcHostDeps } from "./host.js";
import { isPublishable, loadOutbox, saveOutbox, type OutboxRecord } from "./outbox.js";

export interface QueuedPublication {
  /** Events this call queued durably. */
  queued: number;
  /** Settles when this delivery attempt ends. Never rejects; production never awaits it. */
  delivery: Promise<void>;
}

/**
 * Queue events for the active RC session of `deps.projectRoot` and start
 * delivering them.
 *
 * `enqueue` receives the record just read from disk — already known to be
 * publishable for this project (isPublishable, #227) and, when `sessionId` is
 * given, still that session — enqueues into it, and returns how many events
 * it queued. Nothing is written unless it queued one. Never throws: every
 * failure is an RC failure, left durable or refused, never the caller's.
 */
export function queueForDelivery(
  deps: RcHostDeps,
  enqueue: (record: OutboxRecord) => number,
  sessionId?: string,
): QueuedPublication {
  const idle: QueuedPublication = { queued: 0, delivery: Promise.resolve() };
  try {
    const record = loadOutbox(deps.outboxPath, deps.projectRoot);
    if (!isPublishable(record, deps.projectRoot)) return idle;
    if (sessionId !== undefined && record.session_id !== sessionId) return idle;
    const queued = enqueue(record);
    if (queued === 0) return idle;
    saveOutbox(deps.outboxPath, record); // durable before any upload
    return { queued, delivery: deliver(deps, record) };
  } catch {
    return idle;
  }
}

/** Flush until the queue is empty or a flush fails. Never rejects. */
async function deliver(deps: RcHostDeps, record: OutboxRecord): Promise<void> {
  try {
    while (record.events.length > 0) {
      const outcome = await flushOutbox(deps, record);
      // A failed flush leaves the queue durable for the next one, from any
      // producer or the next run. No retry timer keeps a command alive.
      if (!outcome.ok || outcome.sent === 0) return;
    }
  } catch {
    // flushOutbox throws only when a receipt could not be made durable; the
    // events are still queued on disk and are replayed, deduplicated by id.
  }
}
