// action_receipts.ts — CI and PR status for the viewer, from Action Rail receipts.
//
// The receipt the Cloud returns from `execute` is the only record that a
// GitHub action actually happened (lib/action_rail/service.py build_receipt).
// When a local RC session is active for this project, its CI or PR identity is
// projected through the existing adapters (ciEvent / prStatusEvent) and handed
// to the same durable outbox every other producer uses: enqueueEvent sanitizes
// before anything reaches disk, and flushOutbox moves the cursor only on a
// proven receipt.
//
// THREE RULES
//
//  1. Only a receipt that binds to the plan just executed. plan_id,
//     action_digest and action_type must all match, the action must be a rail
//     mutation, and `reconciled` must be a real boolean: "issued" versus
//     "reconciled" is the one status a receipt states, so a receipt that does
//     not state it publishes nothing rather than a guess.
//
//  2. Nothing the receipt does not carry. No title, checks, deployment or merge
//     state, no provider `status`, no `html_url` (links are BUILT from the
//     validated owner/name and number by prStatusEvent), no branch ref or
//     workflow path, no actor, token fingerprint, body or logs. A workflow
//     dispatch receipt names a path and a branch but no run, so it has no CI or
//     PR identity to show and publishes nothing.
//
//  3. Never a payload the broker will refuse. The sanitizer may rewrite a
//     string that happens to contain the project root, the home directory or a
//     secret env value (a checkout at /app and an "apple/..." repository is
//     enough). A rewritten PR link no longer matches repo/number, the broker
//     answers 400, and RC_EVENT_REJECTED keeps the batch — wedging every later
//     event. So a field is published only if sanitizing leaves it byte-identical,
//     a PR link only while it still matches its identifiers, and an event only
//     while its display/1 required keys survive.
//
// Publication is fire-and-forget: the projection is durable before this
// returns, the upload is started but never awaited by the command, and every
// failure is swallowed — a viewer can never change a Cloud action's result.

import { isMutation, type ActionReceipt } from "../action_rail.js";
import type { ApiClient } from "../transport.js";
import { enqueueEvent } from "./outbox.js";
import { ciEvent, prStatusEvent, RC_DISPLAY_PROJECTION_VERSION, type RcProducedEvent } from "./producers.js";
import { queueForDelivery } from "./publish.js";
import { sanitizeRemotePayload } from "./redaction.js";

/** The plan the receipt must bind to — the stored plan `execute` was approved against. */
export interface ReceiptBinding {
  plan_id: string;
  action_digest: string;
  action_type: string;
}

export interface ReceiptPublication {
  /** Events durably queued for the active session. */
  queued: number;
  /** The started upload. The CLI never awaits it; tests may. */
  delivery: Promise<void>;
}

/** display/1 required keys (Cloud RC_DISPLAY_REQUIRED_KEYS) for the two types produced here. */
const REQUIRED_KEYS: Readonly<Record<string, readonly string[]>> = {
  ci: ["provider", "status"],
  pr_status: ["state"],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Rebuild the receipt from its typed fields only. The server's JSON is
 * untrusted input; extra fields (body, logs, fingerprints) never travel past
 * this point, and provider ids keep only scalar values.
 */
function readReceipt(value: unknown): ActionReceipt | null {
  if (!isPlainObject(value)) return null;
  const { receipt_id, action_type, plan_id, action_digest, repository, provider_object_ids, reconciled } = value;
  if (!nonEmpty(receipt_id) || !nonEmpty(action_type) || !nonEmpty(plan_id) || !nonEmpty(action_digest)) return null;
  if (typeof repository !== "string" || typeof reconciled !== "boolean" || !isPlainObject(provider_object_ids)) {
    return null;
  }
  const ids: Record<string, string | number> = {};
  for (const [key, id] of Object.entries(provider_object_ids)) {
    if (typeof id === "string" || typeof id === "number") ids[key] = id;
  }
  return {
    receipt_id,
    action_type,
    plan_id,
    action_digest,
    repository,
    provider_object_ids: ids,
    reconciled,
    issued_at: typeof value["issued_at"] === "string" ? value["issued_at"] : "",
  };
}

function bindsTo(receipt: ActionReceipt, binding: ReceiptBinding): boolean {
  return nonEmpty(binding.plan_id) && receipt.plan_id === binding.plan_id
    && nonEmpty(binding.action_digest) && receipt.action_digest === binding.action_digest
    && receipt.action_type === binding.action_type
    && isMutation(receipt.action_type);
}

/** Keep only what the sanitizer leaves intact, and only if the broker will accept it. */
function contractSafe(event: RcProducedEvent, projectRoot: string): RcProducedEvent | null {
  const clean = sanitizeRemotePayload(event.event_type, event.payload, { projectRoot });
  if (!clean) return null;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.payload)) {
    if (clean[key] === value) kept[key] = value;
  }
  const linkMatches = event.event_type !== "pr_status"
    || kept["url"] === `https://github.com/${String(kept["repo"])}/pull/${String(kept["number"])}`;
  const { url, ...withoutUrl } = kept;
  const payload = url !== undefined && linkMatches ? kept : withoutUrl;
  if (payload["projection_version"] !== RC_DISPLAY_PROJECTION_VERSION) return null;
  if (!(REQUIRED_KEYS[event.event_type] ?? []).every((key) => nonEmpty(payload[key]))) return null;
  return { event_type: event.event_type, payload };
}

/**
 * The viewer events one Action Rail receipt justifies, already reduced to what
 * the outbox will store unchanged. Empty when the receipt does not bind to the
 * plan, is not a CI or PR action, or does not state issued versus reconciled.
 */
export function receiptDisplayEvents(
  receipt: unknown,
  binding: ReceiptBinding,
  projectRoot: string,
): RcProducedEvent[] {
  const parsed = readReceipt(receipt);
  if (!parsed || !bindsTo(parsed, binding)) return [];
  const events: RcProducedEvent[] = [];
  for (const produced of [ciEvent(parsed), prStatusEvent(parsed)]) {
    const safe = produced ? contractSafe(produced, projectRoot) : null;
    if (safe) events.push(safe);
  }
  return events;
}

let lastDelivery: Promise<void> = Promise.resolve();

/** Lets integration tests wait for a started upload; the CLI never does. */
export function actionReceiptDelivery(): Promise<void> {
  return lastDelivery;
}

/**
 * Queue a receipt's CI/PR projection for the active RC session of `projectRoot`
 * and start (never await) its upload. A no-op without an active, unrevoked
 * session for this exact checkout. Never throws.
 */
export function publishActionReceipt(
  api: ApiClient,
  projectRoot: string,
  outboxPath: string,
  receipt: unknown,
  binding: ReceiptBinding,
): ReceiptPublication {
  const idle: ReceiptPublication = { queued: 0, delivery: Promise.resolve() };
  try {
    const events = receiptDisplayEvents(receipt, binding, projectRoot);
    if (events.length === 0) return idle;
    // The one-shot seam (rc/publish.ts): isPublishable, read-modify-write the
    // outbox file, durable before any upload, delivery never awaited.
    const publication = queueForDelivery({ api, outboxPath, projectRoot }, (record) =>
      events.filter((event) => enqueueEvent(record, event.event_type, event.payload)).length);
    if (publication.queued === 0) return idle;
    lastDelivery = publication.delivery;
    return publication;
  } catch {
    // A broken or unwritable outbox is an RC failure, not a Cloud action failure.
    return idle;
  }
}
