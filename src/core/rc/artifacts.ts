// artifacts.ts — publish committed media-history entries to the active RC session.
//
// The media history (media_history_store.ts) is the durable owner of generated
// results, and its commit observer is the only trigger: an entry is published
// after it is on disk and verified, never for a generation that failed, and
// never by re-reading the history later (that would re-announce old work).
//
// Same publication path as subagents.ts — loadOutbox, enqueueEvent (which
// sanitizes before anything is written), saveOutbox, flushOutbox — with two
// differences that the media commands need:
//
//  1. The upload is NOT awaited by the caller. A media command finishes when
//     its file is recorded; a slow or absent broker must not hold it. The event
//     is durable before this returns, so an upload abandoned at process exit is
//     resent by the next flush and deduplicated by host_event_id.
//
//  2. Publications that overlap within one process share ONE in-memory record
//     and one delivery loop per outbox. A batch generation commits its next
//     file while the previous upload is still in flight; if each publication
//     loaded and saved its own copy, the first receipt write would replace the
//     file with a copy that never contained the second event, and an outage at
//     that moment would lose it for good.
//
// Every failure here is an RC failure, recorded as an event still queued in
// the outbox (rc status shows it), and never reaches the media command.

import { createHash } from "node:crypto";
import type { MediaEntry } from "../media_history.js";
import type { ApiClient } from "../transport.js";
import { flushOutbox, type RcHostDeps } from "./host.js";
import { enqueueEvent, loadOutbox, saveOutbox, type OutboxRecord } from "./outbox.js";
import { artifactEvent } from "./producers.js";
import { sanitizeRemotePayload } from "./redaction.js";

/** Cloud display/1 required keys for `artifact` (lib/remote_session/contracts.py). */
const REQUIRED_KEYS = ["artifact_id", "kind", "title"] as const;

interface Delivery {
  record: OutboxRecord;
  done: Promise<void>;
}

/** At most one delivery loop per outbox path in this process. */
const deliveries = new Map<string, Delivery>();

/**
 * The viewer-facing identity of a history entry: stable for one entry within
 * one RC session, so a resent or replayed event updates the same artifact, and
 * opaque, so the local history id and anything it might encode stay local.
 */
export function publicArtifactId(sessionId: string, artifactId: string): string {
  const digest = createHash("sha256").update(sessionId).update("\0").update(artifactId).digest("hex");
  return `artifact-${digest.slice(0, 24)}`;
}

function isActive(record: OutboxRecord, projectRoot: string): boolean {
  return Boolean(record.session_id) && !record.revoke_pending && record.project_root === projectRoot;
}

/** The payload the Cloud would accept, or null. Refused here, not after a 400. */
function acceptablePayload(entry: MediaEntry, sessionId: string, projectRoot: string): Record<string, unknown> | null {
  const produced = artifactEvent(entry);
  const payload = { ...produced.payload, artifact_id: publicArtifactId(sessionId, entry.artifactId) };
  // enqueueEvent sanitizes again; checking the sanitized shape first means a
  // payload whose required string would come out empty never enters the queue,
  // where a Cloud 400 would hold back every event behind it.
  const clean = sanitizeRemotePayload(produced.event_type, payload, { projectRoot });
  if (!clean) return null;
  return REQUIRED_KEYS.every((key) => typeof clean[key] === "string" && clean[key] !== "") ? payload : null;
}

function startDelivery(deps: RcHostDeps, record: OutboxRecord): Promise<void> {
  const delivery: Delivery = { record, done: Promise.resolve() };
  delivery.done = (async () => {
    try {
      while (record.events.length > 0) {
        const outcome = await flushOutbox(deps, record);
        // A failed flush leaves the queue exactly as it was; the next flush,
        // from any RC producer or the next run, resends it. No retry timer here.
        if (!outcome.ok || outcome.sent === 0) return;
      }
    } catch {
      // flushOutbox reports transport failures as outcomes; anything thrown is
      // local I/O, and the queued events are still on disk.
    } finally {
      if (deliveries.get(deps.outboxPath) === delivery) deliveries.delete(deps.outboxPath);
    }
  })();
  deliveries.set(deps.outboxPath, delivery);
  return delivery.done;
}

/**
 * Queue one committed entry for the active RC session and start delivering it.
 *
 * The enqueue is synchronous and durable: when this returns, the sanitized
 * event is in the outbox on disk. The returned promise settles when the
 * delivery attempt ends; it never rejects, and production callers do not wait
 * for it. Without an active, unrevoked session for this project nothing is
 * read beyond the outbox and nothing is written or sent.
 */
export function publishArtifactEntry(
  api: ApiClient,
  projectRoot: string,
  outboxPath: string,
  entry: MediaEntry,
): Promise<void> {
  try {
    const onDisk = loadOutbox(outboxPath, projectRoot);
    if (!isActive(onDisk, projectRoot)) return Promise.resolve();

    const live = deliveries.get(outboxPath);
    const joining = live !== undefined && live.record.session_id === onDisk.session_id;
    const record = joining ? live.record : onDisk;

    const payload = acceptablePayload(entry, record.session_id, projectRoot);
    if (!payload || !enqueueEvent(record, "artifact", payload)) return Promise.resolve();
    saveOutbox(outboxPath, record); // durable before any network attempt

    // A loop already running on this record will send the new event when its
    // current append returns; starting a second one would race its writes.
    if (joining) return live.done;
    return startDelivery({ api, outboxPath, projectRoot }, record);
  } catch {
    // An unwritable outbox is an RC failure, never a media-command failure.
    return Promise.resolve();
  }
}
