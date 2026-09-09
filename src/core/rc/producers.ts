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

import type { BrainEvent } from "../brain_protocol.js";
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
] as const satisfies readonly ViewerEventType[];

/**
 * Declared in the viewer profile, not yet produced here, and why.
 *
 * Each waits on a subsystem that owns the data. None can be derived from a
 * BrainEvent, so wiring them is separate, checkable work rather than something
 * this adapter could approximate.
 */
export const RC_UNPRODUCED_EVENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  subagent: "swarm/subagent supervision does not emit through BrainEvent",
  diff_summary: "needs the review/diff subsystem's counts, not a checkpoint sha",
  tests: "needs the test runner's structured result, not a done() summary string",
  ci: "needs the CI rail's run state",
  pr_status: "needs the GitHub action rail's PR state",
  artifact: "needs the artifact store's identifiers",
  preview: "needs preview_supervisor's state file",
});

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
