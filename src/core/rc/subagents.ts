// Publish real orchestrator observations through the active RC outbox.
import { createHash } from "node:crypto";
import type { ApiClient } from "../transport.js";
import { flushOutbox } from "./host.js";
import { enqueueEvent, isPublishable, loadOutbox, RC_MAX_OBSERVED_WORKERS, saveOutbox } from "./outbox.js";
import type { RcProducedEvent } from "./producers.js";

const WORKER_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Best-effort viewer publication must never change a local worker command's result. */
export async function publishSubagentEvents(
  api: ApiClient,
  projectRoot: string,
  outboxPath: string,
  observations: readonly RcProducedEvent[],
): Promise<number> {
  try {
    const record = loadOutbox(outboxPath, projectRoot);
    if (!isPublishable(record, projectRoot)) return 0;
    let added = 0;
    for (const event of observations) {
      if (event.event_type !== "subagent") continue;
      const id = event.payload["subagent_id"];
      const status = event.payload["status"];
      const summary = event.payload["summary"] ?? "";
      if (typeof id !== "string" || !WORKER_ID.test(id) || typeof status !== "string" || typeof summary !== "string") continue;
      // Scope the public handle to this RC session. Backend ids may contain
      // identifying text; only the stable opaque handle reaches disk or Cloud.
      const publicId = `worker-${createHash("sha256").update(record.session_id).update("\0").update(id).digest("hex").slice(0, 24)}`;
      const previous = record.observed_workers[publicId];
      if (previous?.status === "done") continue; // a stale tree cannot revive a gathered worker
      if (previous && (status === "queued" || status === "idle") && previous.status === "running") continue;
      if (previous?.status === status && previous.summary === summary) continue;
      if (!previous && Object.keys(record.observed_workers).length >= RC_MAX_OBSERVED_WORKERS) continue;
      if (!enqueueEvent(record, event.event_type, { ...event.payload, subagent_id: publicId })) continue;
      record.observed_workers[publicId] = { status, summary };
      added += 1;
    }
    if (added > 0) saveOutbox(outboxPath, record);
    if (record.events.length > 0) await flushOutbox({ api, outboxPath, projectRoot }, record);
    return added;
  } catch {
    return 0;
  }
}
