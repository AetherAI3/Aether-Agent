// producers.ts — the ONE adapter from agent activity to viewer events.
//
// Spec refit 6: one RC event adapter wired into the existing session/workflow
// events, not per-renderer edits. The repository already has exactly the right
// seam — core/agent_events.ts `mapBrainEvent` turns a BrainEvent into the UI's
// vocabulary — so this is its sibling, consuming the same stream and producing
// the viewer's vocabulary instead. No renderer is touched, and there is one
// place to audit for "what can a viewer see".
//
// THE DEFAULT IS null
//
// Every BrainEvent without an honest home in the viewer profile returns null
// and is never published. That is not laziness, it is the safety argument:
// mapping an event into a type that nearly fits is how a viewer ends up
// rendering model reasoning under a heading that says "tool activity". Four
// categories are refused on purpose:
//
//   monologue   model reasoning text. This is the transcript in all but name,
//               and `transcript` is excluded from the viewer profile precisely
//               because exposing it needs a per-session choice that does not
//               exist yet. Publishing it here would answer "can a viewer read
//               my thinking?" with "depends which producer was wired".
//   memory      private Memory frames. §6.3 forbids them by name.
//   telemetry   vram, tokens/sec, context capacity. Machine detail about the
//               operator's hardware, not observation of the work.
//   turn/status per-turn diagnostics and pool counters. No viewer allowlist
//               has a home for them, and inventing one is a schema change.
//
// WHAT IS NOT PRODUCED YET, STATED RATHER THAN IMPLIED
//
// Refit 12 is explicit that a declared event type with no producer is not a
// delivered feature. RC_PRODUCED_EVENT_TYPES is the honest list, and
// RC_UNPRODUCED_EVENT_TYPES names the rest with the subsystem each one waits
// on. A test pins that the two together cover the viewer profile exactly, so
// the shortfall cannot quietly change: adding a producer means moving a name
// between the lists, and adding an event type without one fails the build.

import type { ActionReceipt, RailRepo } from "../action_rail.js";
import type { BrainEvent } from "../brain_protocol.js";
import type { CountTotal } from "../diff_counts.js";
import type { MediaEntry } from "../media_history.js";
import type { TreeWorker } from "../orchestrator.js";
import type { PreviewState } from "../preview_contract.js";
import type { VerificationReading } from "../verification_record.js";
import { VIEWER_EVENT_TYPES, type ViewerEventType } from "./viewer_profile.js";

/** One event ready for enqueueEvent. `payload` is pre-sanitizer. */
export interface RcProducedEvent {
  event_type: ViewerEventType;
  payload: Record<string, unknown>;
}

/** Event classes this adapter can currently emit. */
export const RC_PRODUCED_EVENT_TYPES = [
  "session",
  "presence",
  "plan",
  "tool_activity",
  "done",
  "error",
  "subagent",
  "diff_summary",
  "tests",
  "ci",
  "pr_status",
  "artifact",
  "preview",
] as const satisfies readonly ViewerEventType[];

/**
 * Declared in the viewer profile, not yet produced here, and why.
 *
 * Each waits on a subsystem that owns the data. None can be derived from a
 * BrainEvent, so wiring them is separate, checkable work rather than something
 * this adapter could approximate.
 */
export const RC_UNPRODUCED_EVENT_TYPES: Readonly<Record<string, string>> = Object.freeze({});

/** Produced plus explicitly-deferred, checked against the viewer profile. */
export function producerCoverage(): { produced: string[]; unproduced: string[]; missing: string[] } {
  const produced = [...RC_PRODUCED_EVENT_TYPES];
  const unproduced = Object.keys(RC_UNPRODUCED_EVENT_TYPES);
  const covered = new Set<string>([...produced, ...unproduced]);
  return {
    produced,
    unproduced,
    missing: VIEWER_EVENT_TYPES.filter((type) => !covered.has(type)),
  };
}

/** A short hint at what a tool acted on. Never the arguments themselves. */
function targetHint(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file", "target", "url", "name"]) {
    const value = args[key];
    // This only picks WHICH value is worth showing. Relativizing, scrubbing and
    // capping happen in sanitizeRemotePayload; anything not a plain string is
    // skipped because the allowlist would drop it anyway.
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/**
 * Map one BrainEvent to a viewer event, or null to publish nothing.
 *
 * Deliberately shaped like core/agent_events.ts `mapBrainEvent` so the two read
 * side by side, and the difference between what the operator's terminal shows
 * and what a remote viewer sees is one diff rather than an investigation.
 */
export function mapBrainEventToRc(event: BrainEvent): RcProducedEvent | null {
  switch (event.type) {
    case "stage":
      return { event_type: "plan", payload: { title: event.name, status: "running" } };

    case "tool_call": {
      const target = targetHint(event.args);
      return {
        event_type: "tool_activity",
        payload: { tool: event.name, status: "started", ...(target ? { target } : {}) },
      };
    }

    case "done":
      return {
        event_type: "done",
        payload: { status: event.ok ? "passed" : "failed", summary: event.result },
      };

    case "error":
      // `msg` can carry tool or model output. It reaches the allowlisted
      // `message` key and is scrubbed and capped by sanitizeRemotePayload on
      // the way into the outbox; nothing is published from here directly.
      return { event_type: "error", payload: { code: "agent_error", message: event.msg } };

    // Refused on purpose — see the header. Listed rather than folded into the
    // default so a new BrainEvent variant shows up here as a decision to make,
    // not a silent no-op somebody later "fixes" by publishing it.
    case "monologue":
    case "memory":
    case "telemetry":
    case "turn":
    case "status":
    case "skill":
    case "checkpoint":
      return null;

    default:
      return null;
  }
}

/** The session-open event: identifiers describing what is being observed. */
export function sessionOpenedEvent(fields: {
  session_name: string;
  repo: string;
  branch: string;
  base_commit: string;
  dirty_file_count: number;
  protocol_version: string;
}): RcProducedEvent {
  return { event_type: "session", payload: { state: "active", ...fields } };
}

/** Host presence. `role` is always "host" — a producer is never a controller. */
export function hostPresenceEvent(deviceId: string, state: "online" | "offline"): RcProducedEvent {
  return { event_type: "presence", payload: { role: "host", device_id: deviceId, state } };
}

// ═══════════════════════════════════════════════════════════════════════════
// The seven subsystem adapters
// ═══════════════════════════════════════════════════════════════════════════
//
// Each takes the result object the owning subsystem ALREADY produces and
// projects it onto the viewer allowlist. They are pure, and the source types
// are imported type-only, so RC gains no runtime dependency on any of these
// subsystems and none of them has to know RC exists — the caller that already
// holds the result passes it in.
//
// Type-only is also what makes this checkable: if `PreviewState.phase` or
// `CountTotal.additions` is renamed, this file stops compiling rather than
// silently publishing `undefined` to a viewer.
//
// THE RULE FOR EVERY ONE: project, never enrich. Nothing here computes a fact
// the subsystem did not already establish. A field the source does not carry
// is omitted, not inferred — an omitted `passed` count reads as "not reported",
// while a guessed one reads as evidence.

/**
 * subagent — from the orchestrator's worker tree.
 *
 * `model` is deliberately NOT published. Model identity is one of the four
 * identities this program keeps separate from device, account and connector
 * identity, and a viewer stream is exactly where they would start to blur.
 * `step` carries what the worker is doing, which is the observable fact.
 */
export function subagentEvent(worker: TreeWorker): RcProducedEvent {
  return {
    event_type: "subagent",
    payload: {
      subagent_id: worker.id,
      status: worker.step ? "running" : "idle",
      summary: worker.step,
    },
  };
}

/** subagent — the terminal fact, from a delegate/gather result. */
export function subagentFinishedEvent(workerId: string, status: string): RcProducedEvent {
  return { event_type: "subagent", payload: { subagent_id: workerId, status } };
}

/**
 * diff_summary — from the real numstat counts, never a diff body.
 *
 * `files` carries paths only, and every one goes through relativizePath in the
 * sanitizer, which rewrites a path under the project root and REFUSES one
 * outside it. `uncounted` is folded into files_changed because a binary that
 * changed is still a file that changed; hiding it would make the count a lie
 * of omission.
 */
export function diffSummaryEvent(total: CountTotal, paths: readonly string[]): RcProducedEvent {
  return {
    event_type: "diff_summary",
    payload: {
      files_changed: paths.length,
      insertions: total.additions,
      deletions: total.deletions,
      files: [...paths],
    },
  };
}

/**
 * tests — from a verification reading, which is a real run's result.
 *
 * The four statuses are the verifier's own, including "stale" and "unknown".
 * Those two matter most: "unknown" means the tree moved while the command ran,
 * and collapsing it to pass or fail is precisely the claim RC must not make on
 * a viewer's behalf. Counts are omitted because the verifier records a status
 * and a reason, not a parsed tally — inventing 0/0/0 would read as evidence
 * that nothing failed.
 */
export function testsEvent(reading: VerificationReading): RcProducedEvent {
  return {
    event_type: "tests",
    payload: { status: reading.status, summary: reading.reason },
  };
}

/** Strict `owner/name`, so nothing else can be spliced into a URL. */
const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** The first provider id that looks like a run or PR number, as a string. */
function providerId(receipt: ActionReceipt, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = receipt.provider_object_ids?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/**
 * ci — from an Action Rail receipt for a CI action.
 *
 * The receipt is the canonical record that the Cloud performed the action; RC
 * never asks a provider directly and never shells out. Only the run identity
 * travels: no logs, no tokens, no arbitrary provider payload.
 */
export function ciEvent(receipt: ActionReceipt): RcProducedEvent | null {
  if (!receipt.action_type.startsWith("aether.github.ci.")) return null;
  const runId = providerId(receipt, ["run_id", "check_run_id", "workflow_run_id"]);
  return {
    event_type: "ci",
    payload: {
      provider: "github",
      status: receipt.reconciled ? "reconciled" : "issued",
      ...(runId ? { run_id: runId } : {}),
    },
  };
}

/**
 * pr_status — from an Action Rail receipt for a pull-request action.
 *
 * Nothing is inferred from a branch name and no `gh` binary is invoked: the
 * repository and the PR number both come from the receipt the Cloud issued.
 * The URL is BUILT from those two rather than accepted from anywhere, and only
 * when the repository matches a strict owner/name shape, so no value can be
 * spliced into it. `title` and `checks_summary` are omitted because the receipt
 * does not carry them.
 */
export function prStatusEvent(receipt: ActionReceipt, repo?: RailRepo | null): RcProducedEvent | null {
  if (!receipt.action_type.startsWith("aether.github.pr.")) return null;
  const repository = repo?.repository ?? receipt.repository;
  const number = providerId(receipt, ["pull_request_number", "number", "pr_number"]);
  const safeRepo = REPO_SLUG.test(repository) ? repository : undefined;
  return {
    event_type: "pr_status",
    payload: {
      ...(safeRepo ? { repo: safeRepo } : {}),
      ...(number ? { number: Number(number) } : {}),
      state: receipt.reconciled ? "reconciled" : "issued",
      ...(safeRepo && number ? { url: `https://github.com/${safeRepo}/pull/${number}` } : {}),
    },
  };
}

/**
 * artifact — from the media history, the durable owner of generated results.
 *
 * Four of the entry's fields are deliberately dropped. `filePath` is an
 * absolute path carrying a username and the machine's layout; `url` can be a
 * signed, credential-bearing link; `prompt` is the operator's own words; and
 * `model` is model identity again. What a viewer needs is that an artifact of
 * some kind exists and what it is called.
 */
export function artifactEvent(entry: MediaEntry): RcProducedEvent {
  return {
    event_type: "artifact",
    payload: {
      artifact_id: entry.artifactId,
      kind: entry.kind,
      title: entry.displayName,
      summary: `${entry.kind} · ${entry.sizeBytes} bytes`,
    },
  };
}

/**
 * preview — from the supervisor's own state file.
 *
 * The URL is published ONLY when it is not loopback. A `http://127.0.0.1:5173`
 * is useless to somebody watching from another machine and still discloses a
 * local port, so it is dropped rather than shown. `error` is omitted: it is
 * free text from a child process, and the phase already says "failed".
 */
export function previewEvent(state: PreviewState, isLoopback: (url: string) => boolean): RcProducedEvent {
  const url = state.url && !isLoopback(state.url) ? state.url : undefined;
  return {
    event_type: "preview",
    payload: {
      phase: state.phase,
      instance_id: state.instanceId,
      ...(url ? { url } : {}),
    },
  };
}
