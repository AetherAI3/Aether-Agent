// Publish real preview lifecycle observations through the active RC outbox.
//
// The one-shot producer seam (rc/publish.ts): every observation reads the
// outbox file, queues into what it read, saves (sanitized, durable before any
// upload) and starts a delivery nobody waits for. flushOutbox re-reads the
// file before sending and before committing receipts (#223), so this
// publisher never saves a stale copy over events another writer queued.
//
// Nothing here can change a preview result. Every failure is swallowed after
// the event is either durable in the outbox (and retried by the next flush) or
// refused outright (no active session, sanitizer refusal).

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { isLoopbackUrl } from "../preview_contract.js";
import type { ApiClient } from "../transport.js";
import type { RcHostDeps } from "./host.js";
import { enqueueEvent, isPublishable, loadOutbox, type OutboxRecord } from "./outbox.js";
import { previewEvent, type PreviewDisplayPhase } from "./producers.js";
import { queueForDelivery } from "./publish.js";
import { sanitizeRemotePayload } from "./redaction.js";

export interface PreviewPhaseObservation {
  phase: PreviewDisplayPhase;
  /** The supervisor's local instance id. Never published; see previewPublicId. */
  instanceId: string;
  /** Operator-declared public URL; only ever attached to a `ready` phase. */
  publicUrl?: string;
}

export interface RcPreviewPublisher {
  /** Durable before it returns; the upload it starts is never awaited. */
  observe(observation: PreviewPhaseObservation): void;
  /** Lets tests wait for a started upload; the preview command never does. */
  drain(): Promise<void>;
}

/**
 * The viewer's handle for one preview, scoped to one RC session.
 *
 * Stable across every phase of the same launch, so the viewer updates one card
 * instead of stacking them. Derived rather than copied: the supervisor's
 * instance id is the identity its control channel checks, and a remote viewer
 * has no use for a local control identity even when it is not a credential.
 */
export function previewPublicId(sessionId: string, instanceId: string): string {
  const digest = createHash("sha256").update(sessionId).update("\0").update(instanceId).digest("hex");
  return `preview-${digest.slice(0, 24)}`;
}

/** The sanitized display payload, or null when nothing publishable remains. */
function displayPayload(record: OutboxRecord, observation: PreviewPhaseObservation): Record<string, unknown> | null {
  const url = observation.phase === "ready" ? observation.publicUrl : undefined;
  const event = previewEvent({
    phase: observation.phase,
    instanceId: previewPublicId(record.session_id, observation.instanceId),
    ...(url ? { url } : {}),
  }, isLoopbackUrl);
  const clean = sanitizeRemotePayload(event.event_type, event.payload, { projectRoot: record.project_root });
  if (!clean || clean["url"] === event.payload["url"]) return clean;
  // The scrubber rewrote the link (an env secret, the home path...). A
  // rewritten URL is not the one the operator declared: omit it, keep the phase.
  const withoutUrl: Record<string, unknown> = { ...event.payload };
  delete withoutUrl["url"];
  return sanitizeRemotePayload(event.event_type, withoutUrl, { projectRoot: record.project_root });
}

/** True when the newest queued frame for this preview already says exactly this. */
function alreadyQueued(record: OutboxRecord, payload: Record<string, unknown>): boolean {
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const queued = record.events[index]!;
    if (queued.event_type !== "preview" || queued.payload["instance_id"] !== payload["instance_id"]) continue;
    return isDeepStrictEqual(queued.payload, payload);
  }
  return false;
}

/** Null unless `rc start` left an active session for exactly this project. */
export function openRcPreviewPublisher(
  api: ApiClient,
  projectRoot: string,
  outboxPath: string,
): RcPreviewPublisher | null {
  try {
    const opened = loadOutbox(outboxPath, projectRoot);
    if (!isPublishable(opened, projectRoot)) return null;
    // Bound to the session it opened on: after `rc off` or a new session the
    // seam refuses every later observation, so nothing further is published.
    const sessionId = opened.session_id;
    const deps: RcHostDeps = { api, outboxPath, projectRoot };
    let pending: Promise<void> = Promise.resolve();

    return {
      observe(observation): void {
        try {
          const publication = queueForDelivery(deps, (record) => {
            const payload = displayPayload(record, observation);
            // Offline, a repeated observation would otherwise grow the queue on
            // every `preview status`; the viewer already has this exact frame.
            if (!payload || alreadyQueued(record, payload)) return 0;
            return enqueueEvent(record, "preview", payload) ? 1 : 0;
          }, sessionId);
          // Deliberately never awaited by the preview command.
          if (publication.queued > 0) pending = publication.delivery;
        } catch {
          // A broken or unwritable outbox is an RC failure, not a preview failure.
        }
      },
      drain: () => pending,
    };
  } catch {
    return null;
  }
}
