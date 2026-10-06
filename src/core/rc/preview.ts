// Publish real preview lifecycle observations through the active RC outbox.
//
// Same seam as subagents.ts and the coding observer: sanitize into the durable
// outbox first, then start an upload that nobody waits for. While an upload is
// in flight, later observations join its in-memory record, so its receipt save
// cannot drop them; between uploads every observation starts from the outbox
// on disk, so this publisher never saves a stale copy over events another
// writer queued meanwhile. (Two writers whose uploads overlap can still race;
// a single outbox writer is the host pump's job, #223.)
//
// Nothing here can change a preview result. Every failure is swallowed after
// the event is either durable in the outbox (and retried by the next flush) or
// refused outright (no active session, sanitizer refusal).

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { isLoopbackUrl } from "../preview_contract.js";
import type { ApiClient } from "../transport.js";
import { flushOutbox, type RcHostDeps } from "./host.js";
import { enqueueEvent, loadOutbox, saveOutbox, type OutboxRecord } from "./outbox.js";
import { previewEvent, type PreviewDisplayPhase } from "./producers.js";
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

function active(record: OutboxRecord, projectRoot: string): boolean {
  return Boolean(record.session_id) && !record.revoke_pending && record.project_root === projectRoot;
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
    if (!active(opened, projectRoot)) return null;
    const sessionId = opened.session_id;
    const deps: RcHostDeps = { api, outboxPath, projectRoot };
    // The record an upload in flight works on. Between uploads it is re-read
    // from disk before every enqueue: other writers (the coding observer, an
    // orchestra or media publisher, another process) save the same file, and a
    // copy held across their saves would erase their queued events.
    let record = opened;
    let pending: Promise<void> = Promise.resolve();
    let flushing = false;
    let stopped = false;

    /** The outbox on disk while it still belongs to this session, else null. */
    const current = (): OutboxRecord | null => {
      const onDisk = loadOutbox(outboxPath, projectRoot);
      if (onDisk.session_id === sessionId && !onDisk.revoke_pending) return onDisk;
      stopped = true; // `rc off` or a new session: publish nothing further
      return null;
    };

    const flush = (): void => {
      if (flushing || stopped) return;
      flushing = true;
      pending = (async () => {
        try {
          while (record.events.length > 0 && current()) {
            const outcome = await flushOutbox(deps, record);
            // Unreachable, rate limited or unproven: the batch stays durable
            // for the next flush. Retrying here would hold the command open.
            if (!outcome.ok || outcome.sent === 0) return;
          }
        } catch {
          // Observation must never change the local preview result.
        } finally {
          flushing = false;
        }
      })();
    };

    return {
      observe(observation): void {
        if (stopped) return;
        try {
          const onDisk = current();
          if (!onDisk) return;
          // An upload in flight owns `record` and saves it when its receipt
          // lands, so joining it is what keeps this event from being dropped by
          // that save. Otherwise start from the file, never from an older copy.
          if (!flushing) record = onDisk;
          const payload = displayPayload(record, observation);
          // Offline, a repeated observation would otherwise grow the queue on
          // every `preview status`; the viewer already has this exact frame.
          if (!payload || alreadyQueued(record, payload)) return;
          if (!enqueueEvent(record, "preview", payload)) return;
          saveOutbox(outboxPath, record); // durable before any upload
          flush(); // deliberately never awaited by the preview command
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
