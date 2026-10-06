// rc_verification.ts — the host's test verdicts, published to an active RC
// session (issue #219).
//
// The viewer's Tests panel shows one kind of fact: what the host's OWN verifier
// proved, about which tree. Two places produce such a reading, and both
// publish through the existing RC observer seam (rc_observation.ts) — no new
// publication path:
//
//   - `aether agent`'s final verification gate (code.ts
//     verifyCodeTurnInCheckout → publishCodingVerification), through the run's
//     OWN observer, never a second writer. It publishes the same check the
//     footer renders (#275's CheckReading): in a git checkout the reading
//     verifyAndRecord recorded for the review rail, otherwise what the check
//     reading alone can prove. Nothing here runs, reads or records a tree.
//   - `aether review verify` / `aether review` (review.ts →
//     publishVerificationReading), which hand over the reading they display —
//     a completed run's, or a stored one read against the tree (the only
//     source of "stale"). A verify that ran nothing publishes nothing.
//
// THE RULES (each one a test in test/rc_verification.test.ts)
//
//   - RC publication never decides, delays or changes a local result. Every
//     RC step is caught; nothing here is awaited by a coding run; no timer is
//     created.
//   - With no RC session nothing extra happens at all.
//   - A check that did not complete — killed at its deadline, cancelled, never
//     started, or unable to start — is "unknown", as is a completed check that
//     no recorded run attributes to a tree. Neither is ever a pass.
//   - Only `testsEvent` builds the frame, so the command line, its output and
//     the local reason text never reach the outbox.
//   - The frame is sent exactly as built or not at all. The outbox sanitizer
//     rewrites any string holding a secret env value, the project root or the
//     home directory; a rewritten status would be a different claim (and a
//     rewritten required field is how a Cloud 400 wedges the whole outbox).
//     So a field survives only if sanitizing leaves it byte-identical, and a
//     reading whose status does not survive is not published.

import { resolve } from "node:path";
import type { ApiClient } from "../core/transport.js";
import type { CheckReading } from "../core/verify_gate.js";
import type { VerificationReading } from "../core/verification_record.js";
import { checkInterruption } from "../core/verify_run.js";
import { testsEvent, type RcProducedEvent } from "../core/rc/producers.js";
import { enqueueEvent } from "../core/rc/outbox.js";
import { queueForDelivery } from "../core/rc/publish.js";
import { sanitizeRemotePayload } from "../core/rc/redaction.js";
import type { RcCodingObserver } from "./rc_observation.js";
import { projectRefFor, rcOutboxPath } from "./rc.js";

/**
 * The tests frame for `reading`, holding only fields the outbox sanitizer
 * (bound to `projectRoot`, as the outbox is) leaves byte-identical — or null
 * when the status itself would not survive.
 */
export function verificationEvent(reading: VerificationReading, projectRoot: string): RcProducedEvent | null {
  const built = testsEvent(reading);
  const clean = sanitizeRemotePayload(built.event_type, built.payload, { projectRoot });
  if (!clean) return null;
  const payload = Object.fromEntries(Object.entries(built.payload).filter(([key, value]) => clean[key] === value));
  if (payload["projection_version"] !== "1" || !payload["status"]) return null;
  return { event_type: built.event_type, payload };
}

/** Queue one reading on an open observer. An RC failure is never the caller's. */
export function publishVerification(observer: RcCodingObserver | null, reading: VerificationReading): void {
  if (!observer) return;
  try {
    const event = verificationEvent(reading, observer.projectRoot);
    if (event) observer.publish(event);
  } catch {
    // The observer already contains its own failures; this is defence in depth.
  }
}

const SKIPPED: Readonly<VerificationReading> = Object.freeze({
  status: "unknown",
  reason: "the run ended before its verification gate ran",
  record: null,
  cause: "skipped",
});

/** The coding run ended before its gate ran: say so rather than leave an older verdict standing. */
export function publishSkippedVerification(observer: RcCodingObserver | null): void {
  publishVerification(observer, { ...SKIPPED });
}

/**
 * The viewer's reading of an `aether agent` run's final check.
 *
 * `recorded` is what verifyAndRecord read when the check ran in a git
 * checkout — the reading the review rail now holds, with its attribution
 * rules (a moved or unidentifiable tree is "unknown"). Without one, only the
 * CheckReading speaks: it says how the check ended, but no tree was
 * identified around it, so a completed check is "unattributed", never a pass.
 */
export function codingVerificationReading(check: CheckReading, recorded: VerificationReading | null): VerificationReading {
  if (recorded) return recorded;
  const interruption = checkInterruption(check);
  if (interruption) return { status: "unknown", reason: check.reason, record: null, cause: interruption };
  switch (check.state) {
    case "unconfigured":
      return { status: "unknown", reason: "no verification command is configured", record: null, cause: "no_command" };
    case "not_run":
      return { ...SKIPPED };
    case "launch_failed":
      return { status: "unknown", reason: check.reason, record: null, cause: "launch_failed" };
    default:
      return {
        status: "unknown",
        reason: "the working tree around the check was not identified",
        record: null,
        cause: "unattributed",
      };
  }
}

/** Queue the settled check of a coding run. A no-op without an RC session. */
export function publishCodingVerification(
  observer: RcCodingObserver | null,
  check: CheckReading,
  recorded: VerificationReading | null,
): void {
  if (!observer) return;
  try {
    publishVerification(observer, codingVerificationReading(check, recorded));
  } catch {
    // Observation must never change the local coding result.
  }
}

/**
 * A reading the review rail already produced, for the active session of the
 * project the command was launched in (the same root `rc start` and the coding
 * observer key on).
 *
 * A standalone command is a second writer of the outbox, so it goes through
 * the one-shot seam (rc/publish.ts): read the file, queue into what it read,
 * save, deliver. It never opens a coding observer, whose host pump would
 * heartbeat for as long as the process lives (a REPL's `/review`).
 *
 * Fire-and-forget: the event is sanitized and persisted synchronously, the
 * upload starts in the background, and the returned promise exists for tests.
 * A broker that never answers delays the command by nothing; the persisted
 * frame is delivered by a later flush.
 */
export function publishVerificationReading(
  api: ApiClient | undefined,
  projectRoot: string,
  reading: VerificationReading,
  outboxPath?: string,
): Promise<void> {
  try {
    if (!api) return Promise.resolve();
    const root = resolve(projectRoot);
    const deps = { api, outboxPath: outboxPath ?? rcOutboxPath(projectRefFor(root)), projectRoot: root };
    return queueForDelivery(deps, (record) => {
      const event = verificationEvent(reading, root);
      return event && enqueueEvent(record, event.event_type, event.payload) ? 1 : 0;
    }).delivery;
  } catch {
    return Promise.resolve();
  }
}
