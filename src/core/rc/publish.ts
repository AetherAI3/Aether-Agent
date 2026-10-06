// publish.ts — the one-shot producer seam outside a coding run (#223).
//
// The outbox FILE is the single truth between everything that writes it: the
// coding run's host pump, /orchestra, and standalone producers — `aether
// review`, an Action Rail receipt, a committed media entry, a preview phase.
// A standalone producer reads the file, queues into exactly what it read,
// saves, and starts a delivery that nobody awaits. flushOutbox re-reads the
// file before it sends and again before it commits receipts, so a writer
// needs no in-memory record of anyone else's: whatever another writer queued
// meanwhile is in the file, and is what the next flush sends.
//
// Within one process there is at most ONE delivery loop per outbox. A media
// batch commits its next file while the previous upload is still in flight;
// that publication joins the running loop (it never shares a record), and the
// loop's next flush reads the file and carries it. Two loops would send the
// same batch twice at once — safe (host_event_id dedupe, receipts checked
// against the cursor at send time) but wasteful, and not what a single host
// does.
//
// A coding run does NOT publish through here: its observer (commands/
// rc_observation.ts) owns one host pump that heartbeats and delivers for the
// whole run, and a standalone command must not start a second one.

import { flushOutbox, type RcHostDeps } from "./host.js";
import { isPublishable, loadOutbox, saveOutbox, type OutboxRecord } from "./outbox.js";

export interface QueuedPublication {
  /** Events this call queued durably. */
  queued: number;
  /** Settles when the delivery carrying them ends. Never rejects; production never awaits it. */
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

interface Delivery {
  done: Promise<void>;
  /** Someone queued while this loop ran: read the file once more before ending. */
  again: boolean;
}

/** The running delivery loop per outbox path, in this process. */
const deliveries = new Map<string, Delivery>();

/**
 * Flush until the outbox file is empty or a flush fails, or join the loop
 * already doing that for this outbox. Never rejects.
 */
function deliver(deps: RcHostDeps, record: OutboxRecord): Promise<void> {
  const live = deliveries.get(deps.outboxPath);
  if (live) {
    live.again = true;
    return live.done;
  }
  const delivery: Delivery = { done: Promise.resolve(), again: false };
  delivery.done = (async () => {
    try {
      for (;;) {
        delivery.again = false;
        // flushOutbox adopts the file before sending, so each pass carries
        // whatever any writer has queued by then.
        const outcome = await flushOutbox(deps, record);
        // A failed flush leaves the queue durable for the next one, from any
        // producer or the next run. No retry timer keeps a command alive.
        if (!outcome.ok) return;
        if (outcome.sent === 0 && !delivery.again) return;
      }
    } catch {
      // flushOutbox throws only when a receipt could not be made durable; the
      // events are still queued on disk and are replayed, deduplicated by id.
    } finally {
      if (deliveries.get(deps.outboxPath) === delivery) deliveries.delete(deps.outboxPath);
    }
  })();
  deliveries.set(deps.outboxPath, delivery);
  return delivery.done;
}
