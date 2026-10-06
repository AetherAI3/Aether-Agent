// artifacts.ts — publish committed media-history entries to the active RC session.
//
// The media history (media_history_store.ts) is the durable owner of generated
// results, and its commit observer is the only trigger: an entry is published
// after it is on disk and verified, never for a generation that failed, and
// never by re-reading the history later (that would re-announce old work).
//
// The one-shot producer seam (rc/publish.ts): read the outbox file, enqueue
// (which sanitizes before anything is written), save, and start delivery.
// The upload is NOT awaited by the caller: a media command finishes when its
// file is recorded, and a slow or absent broker must not hold it. The event is
// durable before this returns, so an upload abandoned at process exit is
// resent by the next flush and deduplicated by host_event_id. A batch
// generation that commits its next file while an upload is in flight joins
// that delivery; flushOutbox re-reads the file before sending and before
// committing receipts, so no receipt write can drop the later commit (#223).
//
// Every failure here is an RC failure, recorded as an event still queued in
// the outbox (rc status shows it), and never reaches the media command.

import { createHash } from "node:crypto";
import type { MediaEntry } from "../media_history.js";
import type { ApiClient } from "../transport.js";
import { enqueueEvent } from "./outbox.js";
import { artifactEvent } from "./producers.js";
import { queueForDelivery } from "./publish.js";
import { sanitizeRemotePayload } from "./redaction.js";

/** Cloud display/1 required keys for `artifact` (lib/remote_session/contracts.py). */
const REQUIRED_KEYS = ["artifact_id", "kind", "title"] as const;

/**
 * The viewer-facing identity of a history entry: stable for one entry within
 * one RC session, so a resent or replayed event updates the same artifact, and
 * opaque, so the local history id and anything it might encode stay local.
 */
export function publicArtifactId(sessionId: string, artifactId: string): string {
  const digest = createHash("sha256").update(sessionId).update("\0").update(artifactId).digest("hex");
  return `artifact-${digest.slice(0, 24)}`;
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
    return queueForDelivery({ api, outboxPath, projectRoot }, (record) => {
      const payload = acceptablePayload(entry, record.session_id, projectRoot);
      return payload && enqueueEvent(record, "artifact", payload) ? 1 : 0;
    }).delivery;
  } catch {
    // An unwritable outbox is an RC failure, never a media-command failure.
    return Promise.resolve();
  }
}
