// Optional RC observer for the shared coding-run event seam. No enrollment or
// network operation occurs unless `rc start` left an active local outbox.
//
// When one exists, opening the observer binds ONE host lifetime to this coding
// run (#223): a pump that heartbeats the session, drains the durable outbox as
// events arrive, backs off through outages and stops on terminal answers. The
// run feeds events and never waits on any of it; `close()` at the end of the
// run makes one final flush bounded by a short deadline. Events still queued
// stay durable, and the next run's observer resumes delivering them if the
// session is still this host's.

import type { BrainEvent } from "../core/brain_protocol.js";
import { resolve } from "node:path";
import type { ApiClient } from "../core/transport.js";
import type { RcHostDeps } from "../core/rc/host.js";
import { checkoutDiffSummary } from "../core/rc/diff_summary.js";
import { adoptOutbox, enqueueEvent, isPublishable, loadOutbox, saveOutbox } from "../core/rc/outbox.js";
import { mapBrainEventToRc, type RcProducedEvent } from "../core/rc/producers.js";
import {
  RC_FINAL_FLUSH_DEADLINE_MS,
  startHostPump,
  systemClock,
  type RcHostPumpOptions,
} from "../core/rc/pump.js";
import { projectRefFor, rcOutboxPath } from "./rc.js";

export interface RcCodingObserver {
  /** The project root the outbox is bound to — what its sanitizer relativizes against. */
  readonly projectRoot: string;
  feed(event: BrainEvent): void;
  /**
   * Queue an event another host subsystem produced (the verify gate's tests
   * reading) through the SAME read-modify-write → pump path as `feed`, so the
   * run's one host delivers it.
   */
  publish(event: RcProducedEvent): void;
  /**
   * Measure the checkout and queue Git's diff summary through `publish` (#218).
   * The run need not await it: close() waits for it within its deadline.
   */
  publishDiff(checkoutRoot: string): Promise<void>;
  /** Lets integration tests wait for a started upload; the coding run never does. */
  drain(): Promise<void>;
  /**
   * Stop the host: wait for producer work still measuring, then one final
   * flush, all within ONE deadline. Never rejects, never outlasts it.
   */
  close(deadlineMs?: number): Promise<void>;
}

export interface RcCodingObserverOptions extends RcHostPumpOptions {
  /** Measures the checkout for publishDiff; checkoutDiffSummary by default. */
  measureDiff?: (checkoutRoot: string) => Promise<RcProducedEvent | null>;
}

export function openRcCodingObserver(
  projectRoot: string,
  api: ApiClient,
  outboxPath?: string,
  options: RcCodingObserverOptions = {},
): RcCodingObserver | null {
  try {
    const root = resolve(projectRoot);
    const path = outboxPath ?? rcOutboxPath(projectRefFor(root));
    const record = loadOutbox(path, root);
    // Only a session this host attached to, read from trustworthy state (#227).
    if (!isPublishable(record, root) || record.project_ref !== projectRefFor(root)) return null;
    const deps: RcHostDeps = { api, outboxPath: path, projectRoot: root };
    const pump = startHostPump(deps, record, options);
    const clock = options.clock ?? systemClock;
    const measureDiff = options.measureDiff ?? ((checkoutRoot: string) => checkoutDiffSummary(checkoutRoot));
    let stopped = false;
    let closing: Promise<void> | null = null;

    /**
     * Queue one produced event and wake the pump. Read-modify-write the FILE,
     * never a long-lived copy: /orchestra, a standalone `aether review` or a
     * media command may have queued into it since, and saving `record` would
     * erase that. The pump delivers from `record`, which adopts the file.
     */
    const enqueue = (produced: RcProducedEvent): void => {
      // A host that stopped (revoked, expired, not ours, closed) publishes
      // nothing more, so it stops costing the run a disk write per event.
      if (stopped || pump.status().state === "stopped") return;
      try {
        const current = loadOutbox(path, root);
        // A read that failed (a lock that outlasted the retries) proves
        // nothing: this event cannot be queued safely, but the host is not
        // stopped. Damaged bytes, a revoke or another session do stop it.
        if (current.recovery?.reason === "unreadable") return;
        if (current.recovery || current.session_id !== record.session_id || current.revoke_pending) {
          stopped = true;
          void pump.close(0);
          return;
        }
        if (!enqueueEvent(current, produced.event_type, produced.payload)) return;
        saveOutbox(path, current); // sanitize and persist before any upload
        adoptOutbox(record, current); // the pump delivers from this shared record
        pump.kick(); // deliberately never awaited by the coding run
      } catch {
        // A broken or unwritable outbox is an RC failure, not a coding failure.
      }
    };

    // Producer work still measuring when the run ends (the run-end diff). The
    // run never awaits it; close() waits for it inside its one deadline.
    const working = new Set<Promise<void>>();
    const track = (work: Promise<void>): Promise<void> => {
      working.add(work);
      void work.finally(() => working.delete(work));
      return work;
    };

    /** `work` or `ms`, whichever settles first. Never rejects. Like the pump's
     *  own close timer this one is ref'd, and cleared as soon as `work` settles. */
    const within = (work: Promise<unknown>, ms: number): Promise<void> => {
      if (ms <= 0) return Promise.resolve();
      return new Promise<void>((done) => {
        const handle = clock.setTimeout(done, ms);
        void work.then(() => undefined, () => undefined).then(() => {
          clock.clearTimeout(handle);
          done();
        });
      });
    };

    return {
      projectRoot: root,
      feed(event): void {
        if (stopped || closing || pump.status().state === "stopped") return;
        try {
          const produced = mapBrainEventToRc(event);
          if (produced) enqueue(produced);
        } catch {
          // Mapping is pure, but observation must never change the local run.
        }
      },
      publish(event): void {
        if (!closing) enqueue(event);
      },
      publishDiff(checkoutRoot): Promise<void> {
        if (stopped || closing) return Promise.resolve();
        return track((async () => {
          try {
            // The same read-modify-write path as every other event.
            const event = await measureDiff(checkoutRoot);
            if (event) enqueue(event);
          } catch {
            // A diff observation cannot change the local coding result.
          }
        })());
      },
      drain: () => pump.idle(),
      close(deadlineMs: number = RC_FINAL_FLUSH_DEADLINE_MS): Promise<void> {
        if (closing) return closing;
        if (working.size === 0) {
          closing = pump.close(deadlineMs);
          return closing;
        }
        // ONE deadline for everything RC still does at the end of the run:
        // producer work still measuring gets the first part of it (its event
        // then rides the final flush), and the pump's final flush the rest.
        const until = clock.now() + Math.max(0, deadlineMs);
        closing = within(Promise.all([...working]), deadlineMs)
          .then(() => pump.close(Math.max(0, until - clock.now())))
          .catch(() => undefined);
        return closing;
      },
    };
  } catch {
    return null;
  }
}
