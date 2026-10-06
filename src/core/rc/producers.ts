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
import { TOOLS, type BrainEvent } from "../brain_protocol.js";
import type { CountTotal } from "../diff_counts.js";
import type { MediaEntry } from "../media_history.js";
import type { TreeWorker } from "../orchestrator.js";
import type { PreviewState } from "../preview_contract.js";
import { redactInline } from "../redaction.js";
import type { VerificationCause, VerificationReading, VerificationStatus } from "../verification_record.js";
import { VIEWER_EVENT_TYPES, type ViewerEventType } from "./viewer_profile.js";

/** One event ready for enqueueEvent. `payload` is pre-sanitizer. */
export interface RcProducedEvent {
  event_type: ViewerEventType;
  payload: Record<string, unknown>;
}

/** Flat, bounded display projection shared with the broker and browser. */
export const RC_DISPLAY_PROJECTION_VERSION = "1" as const;

function displayEvent(event_type: ViewerEventType, payload: Record<string, unknown>): RcProducedEvent {
  return { event_type, payload: { projection_version: RC_DISPLAY_PROJECTION_VERSION, ...payload } };
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

/** A path identifier for tool activity, never arbitrary argument text. */
function targetHint(args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file"]) {
    const value = args[key];
    // This only picks WHICH value is worth showing. Relativizing, scrubbing and
    // capping happen in sanitizeRemotePayload; anything not a plain string is
    // skipped because the allowlist would drop it anyway.
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** Collapse free-text activity into a fixed label before it reaches the viewer. */
function activityLabel(source: string): string {
  const step = source.toLowerCase();
  return /\b(tests?|verify|check)\b/.test(step) ? "Testing" :
    /\b(review|inspect)\b/.test(step) ? "Reviewing" :
    /\b(research|search|read)\b/.test(step) ? "Researching" :
    /\b(plan|design)\b/.test(step) ? "Planning" :
    /\b(write|edit|implement|build|code)\b/.test(step) ? "Implementing" :
    step ? "Working" : "Waiting";
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
      return event.name ? displayEvent("plan", { title: activityLabel(event.name), status: "running" }) : null;

    case "tool_call": {
      if (!event.name) return null;
      const target = targetHint(event.args);
      const tool = TOOLS.includes(event.name as (typeof TOOLS)[number]) ? event.name : "other";
      return displayEvent("tool_activity", { tool, status: "started", ...(target ? { target } : {}) });
    }

    case "done":
      // A brain's ok is advisory until host verification. Completion reports
      // that its turn ended; the independent tests frame owns verification.
      return displayEvent("done", { status: event.ok ? "completed" : "failed",
        summary: event.ok ? "Agent turn completed" : "Agent turn failed" });

    case "error":
      // msg can carry model output, tool output or a private command. The
      // viewer receives the occurrence, never those source bytes.
      return displayEvent("error", { code: "agent_error", message: "Agent reported an error" });

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

/** Pinned opening-event payload contract shared with the Cloud broker. */
export const RC_OPENING_PROTOCOL_VERSION = "1" as const;

/** The session-open event: identifiers describing what is being observed.
 * `live` is the broker's state after a successful host attach. */
export function sessionOpenedEvent(fields: {
  session_name: string;
  repo: string;
  branch: string;
  base_commit: string;
  dirty_file_count: number;
  protocol_version: typeof RC_OPENING_PROTOCOL_VERSION;
}): RcProducedEvent {
  return { event_type: "session", payload: { state: "live", ...fields } };
}

/** Host presence. `role` is always "host" — a producer is never a controller.
 * This is an event snapshot; the broker's heartbeat remains liveness authority. */
export function hostPresenceEvent(deviceId: string, liveness: "live" | "offline"): RcProducedEvent {
  return {
    event_type: "presence",
    payload: { protocol_version: RC_OPENING_PROTOCOL_VERSION, role: "host", device_id: deviceId, liveness },
  };
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
 * `step` only selects a fixed activity label; its source text is never sent.
 */
export function subagentEvent(worker: TreeWorker): RcProducedEvent {
  const step = typeof worker.step === "string" ? worker.step : "";
  // The service's free-text step can contain a task prompt or worker message.
  // Publish only a fixed activity category, never any of those source bytes.
  const summary = activityLabel(step);
  return displayEvent("subagent", {
    subagent_id: worker.id,
    status: step ? "running" : "idle",
    summary,
  });
}

/** A successful delegate response proves an identified worker was accepted. */
export function subagentStartedEvent(workerId: string, status: string): RcProducedEvent {
  const safeStatus = status === "running" || status === "queued" ? status : "queued";
  return displayEvent("subagent", { subagent_id: workerId, status: safeStatus, summary: "Delegated" });
}

/** subagent — the terminal fact, from a delegate/gather result. */
export function subagentFinishedEvent(workerId: string, status: string): RcProducedEvent {
  return displayEvent("subagent", { subagent_id: workerId, status });
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
  return displayEvent("diff_summary", {
      files_changed: paths.length,
      insertions: total.additions,
      deletions: total.deletions,
      files: [...paths],
  });
}

const TESTS_STATUS_SUMMARY: Readonly<Record<VerificationStatus, string>> = {
  verified: "Verification passed",
  failed: "Verification failed",
  stale: "Verification is stale",
  unknown: "Verification unavailable",
};

/** Fixed detail per cause, keyed by the ONLY status that cause can explain. */
const TESTS_CAUSE_DETAIL: Readonly<Partial<Record<VerificationStatus, Partial<Record<VerificationCause, string>>>>> = {
  stale: {
    head_moved: "HEAD moved since it ran",
    tree_changed: "the working tree changed since it ran",
  },
  unknown: {
    not_verified: "nothing has verified this working tree",
    unsupported_record: "the stored record is from an unsupported version",
    no_command: "no test runner is configured",
    tree_moved_during_run: "the working tree changed while it ran",
    unattributed: "the working tree could not be identified",
    interrupted: "interrupted before it finished",
    timed_out: "timed out before it finished",
    launch_failed: "the check could not start",
    skipped: "the run ended before verification",
  },
};

/** The bounded "why" for a reading: fixed words plus, for a failure, its exit code. */
function testsSummary(reading: VerificationReading): string {
  const base = TESTS_STATUS_SUMMARY[reading.status] ?? TESTS_STATUS_SUMMARY.unknown;
  if (reading.status === "failed" && reading.cause === "exit_nonzero" && reading.record) {
    // The exit code is the process's own. The record's `remaining` is not
    // quoted: it is the first "<n> failed" anywhere in raw output
    // (verify_gate parseFailCount), a guess rather than a measured tally.
    const { exitCode } = reading.record;
    return typeof exitCode === "number" && Number.isSafeInteger(exitCode) ? `${base}: exit code ${exitCode}` : base;
  }
  const detail = reading.cause ? TESTS_CAUSE_DETAIL[reading.status]?.[reading.cause] : undefined;
  return detail ? `${base}: ${detail}` : base;
}

/**
 * tests — from a verification reading, which is a real run's result.
 *
 * The four statuses are the verifier's own, including "stale" and "unknown",
 * and they travel under the verifier's own names: the shared display fixture
 * (test/fixtures/rc-display-v1.json, mirrored by the Cloud broker and browser)
 * pins "verified", so renaming it to the browser's "passed" is the separate
 * viewer-alignment change, not something a producer does unilaterally.
 * "unknown" and "stale" matter most: collapsing either to pass or fail is
 * precisely the claim RC must not make on a viewer's behalf.
 *
 * The reading's `reason` and its record's `command` can contain the exact test
 * command, so they stay local. The summary is built only from the closed
 * `cause` vocabulary plus, for a failure, the integer exit code; a cause that
 * does not belong to the status adds nothing, so a detail can never soften or
 * contradict the status. No passed/failed/skipped counts are published, in
 * any form: the verifier measures no tally.
 */
export function testsEvent(reading: VerificationReading): RcProducedEvent {
  return displayEvent("tests", { status: reading.status, summary: testsSummary(reading) });
}

/** Strict `owner/name`, so nothing else can be spliced into a URL. */
const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function safeRepoSlug(value: string): boolean {
  if (!REPO_SLUG.test(value)) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== "..");
}

/** The first provider id that looks like a run or PR number, as a string. */
function providerId(receipt: ActionReceipt, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = receipt.provider_object_ids?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function numericProviderId(receipt: ActionReceipt, keys: readonly string[]): string | undefined {
  const value = providerId(receipt, keys);
  return value && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))
    ? value : undefined;
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
  const runId = numericProviderId(receipt, ["run_id", "check_run_id", "workflow_run_id"]);
  return displayEvent("ci", {
      provider: "github",
      status: receipt.reconciled ? "reconciled" : "issued",
      ...(runId ? { run_id: runId } : {}),
  });
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
  const rawNumber = numericProviderId(receipt, ["pull_request_number", "number", "pr_number"]);
  const number = rawNumber ? Number(rawNumber) : undefined;
  const safeRepo = safeRepoSlug(repository) ? repository : undefined;
  return displayEvent("pr_status", {
      ...(safeRepo ? { repo: safeRepo } : {}),
      ...(number ? { number } : {}),
      state: receipt.reconciled ? "reconciled" : "issued",
      ...(safeRepo && number ? { url: `https://github.com/${safeRepo}/pull/${number}` } : {}),
  });
}

const ARTIFACT_KIND_LABEL: Readonly<Record<MediaEntry["kind"], string>> = {
  image: "Image",
  video: "Video",
  "3d": "3D model",
};

/** Well under the Cloud's 512-char display bound; a name, not a description. */
const MAX_ARTIFACT_TITLE = 128;

/**
 * Words a file name can share with almost any prompt without being a slug of
 * it. Everything else a name shares with the prompt is treated as the prompt.
 */
const PROMPT_FILLER: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "over", "that", "this", "its", "are", "was",
  "you", "your", "our", "all", "any", "one", "make", "create", "generate", "render", "please",
  "image", "photo", "picture", "video", "style",
]);

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const UUID_SHAPE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;

/** Lower-cased letters and digits only, in any script. */
function folded(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The prompt's meaningful words: 3+ characters, not filler, not a bare number. */
function promptWords(prompt: string): string[] {
  return prompt.toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !PROMPT_FILLER.has(word) && !/^\p{N}+$/u.test(word));
}

/**
 * An object key rather than a name: a UUID, a long letter-and-digit run, or a
 * mixed-case base64url run. With no server filename the label is the media
 * URL's last path segment, and for an unguessable-link CDN that IS the link.
 */
function stemCapabilityShaped(stem: string): boolean {
  if (UUID_SHAPE.test(stem)) return true;
  if ((stem.match(/[A-Za-z0-9]{16,}/g) ?? []).some((run) => /[A-Za-z]/.test(run) && /\d/.test(run))) return true;
  return (stem.match(/[A-Za-z0-9_-]{20,}/g) ?? [])
    .some((run) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run));
}

/** At most `max` UTF-16 units, cut on a code-point boundary. */
function boundedLabel(value: string, max: number): string {
  let out = "";
  for (const char of value) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out;
}

/**
 * What the artifact is called, without echoing how it was made.
 *
 * The label is the file's own name, reduced to a bounded leaf: a stored
 * `displayName` with a directory, a query (`?` cannot appear in a Windows file
 * name, so one here means a URL slipped in), control characters or a broken
 * surrogate is cut down rather than trusted. It falls back to a generic
 * `Image #12` when nothing safe is left, and also when the name could carry
 * what this producer drops on purpose: the model (an unlabelled download is
 * named `<model>_<timestamp>.png`), the prompt (a server-chosen name can be a
 * slug of it — so ANY meaningful prompt word in the name, in any order or
 * concatenated, counts), or a capability-shaped object key. False positives
 * only cost a less specific label. The fallback also means `title` is never
 * empty: an empty required string is a Cloud 400, and a 400 wedges every
 * later event in the outbox.
 */
function artifactTitle(entry: MediaEntry): string {
  const generic = `${ARTIFACT_KIND_LABEL[entry.kind] ?? "Artifact"} #${entry.sequence}`;
  const leaf = entry.displayName.split(/[\\/]/).pop() ?? "";
  const label = boundedLabel(
    (leaf.split("?")[0] ?? "")
      .replace(LONE_SURROGATE, "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
    MAX_ARTIFACT_TITLE,
  ).trim();
  if (!label || label === "." || label === "..") return generic;

  const stem = label.replace(/\.[A-Za-z0-9]{1,8}$/, "");
  const name = folded(stem);
  const model = folded(entry.model.replace(/^vision_/i, ""));
  const promptPrefix = folded(entry.prompt).slice(0, 16);
  if (
    (model.length >= 4 && name.includes(model))
    || (promptPrefix.length >= 8 && name.includes(promptPrefix))
    || promptWords(entry.prompt).some((word) => name.includes(word))
    || stemCapabilityShaped(stem)
  ) {
    return generic;
  }
  return label;
}

/**
 * artifact — from the media history, the durable owner of generated results.
 *
 * Four of the entry's fields are deliberately dropped. `filePath` is an
 * absolute path carrying a username and the machine's layout; `url` can be a
 * signed, credential-bearing link; `prompt` is the operator's own words; and
 * `model` is model identity again. `metadata` is private bookkeeping. What a
 * viewer needs is that an artifact of some kind exists and what it is called.
 *
 * `artifact_id` here is the history entry's own id. The publisher
 * (rc/artifacts.ts) replaces it with a session-scoped handle derived from that
 * id, so a replayed or resent event updates one artifact in the viewer while
 * the local id stays local. The size is reported only when it is a real byte
 * count: the history stores 0 for "could not stat", and "0 bytes" would be a
 * claim the host never measured.
 */
export function artifactEvent(entry: MediaEntry): RcProducedEvent {
  const size = entry.sizeBytes;
  const measured = Number.isSafeInteger(size) && size > 0;
  return displayEvent("artifact", {
      artifact_id: entry.artifactId,
      kind: entry.kind,
      title: artifactTitle(entry),
      ...(measured ? { summary: `${entry.kind} · ${size} bytes` } : {}),
  });
}

/** The supervisor's phases plus the one the CLI proves: its state was removed. */
export type PreviewDisplayPhase = PreviewState["phase"] | "stopped";

/** A phase the preview command observed, already bound to a viewer handle. */
export interface PreviewObservation {
  phase: PreviewDisplayPhase;
  instanceId: string;
  url?: string;
}

/** The Cloud display bound for a single string, URLs included. */
const MAX_DISPLAY_URL = 512;
/**
 * Hosts that only resolve inside a machine, a LAN, a tailnet or a private
 * namespace, plus the reserved `.test`/`.invalid` names and onion services. A
 * Tailscale Funnel name is public, but nothing in a `*.ts.net` name tells it
 * from a tailnet-only MagicDNS name, so the whole suffix is refused.
 */
const PRIVATE_HOST =
  /(?:^|\.)(?:localhost|localdomain|local|internal|intranet|lan|home|corp|private|home\.arpa|ts\.net|test|invalid|onion)$/;
/** Public wildcard-DNS names that resolve to loopback or to the address spelled in the name. */
const LOOPBACK_DNS = /(?:^|\.)(?:localtest\.me|lvh\.me|vcap\.me|nip\.io|sslip\.io|xip\.io|traefik\.me)$/;
/** An IPv4 address spelled inside a DNS name: `10.0.0.5.example`, `192-168-1-2.example`. */
const EMBEDDED_IPV4 = /(?:^|[.-])\d{1,3}(?:[.-]\d{1,3}){3}(?:[.-]|$)/;
const UUID_SHAPED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * A capability token, not a page name: a UUID, a 20+ run of letters and
 * digits, a 16+ hex digest, or a 20+ mixed-case base64url run. Ordinary slugs
 * (`release-notes-2024`) are none of these.
 */
function urlPartCapabilityShaped(part: string): boolean {
  const mixed = (run: string): boolean => /\d/.test(run) && /[A-Za-z]/.test(run);
  if (UUID_SHAPED.test(part)) return true;
  if ((part.match(/[A-Za-z0-9]{20,}/g) ?? []).some(mixed)) return true;
  if ((part.match(/[0-9a-f]{16,}/gi) ?? []).some(mixed)) return true;
  return (part.match(/[A-Za-z0-9_-]{20,}/g) ?? [])
    .some((run) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run));
}

/**
 * The approved viewer-link projection: public HTTPS origin + path, or nothing.
 *
 * Refusal is the default answer, and a refused URL is OMITTED, never repaired.
 * Stripping a signed link's query would publish a different URL than the one
 * that works, and "fixing" a private host is not possible. Refused:
 *   - anything not https, or carrying userinfo, a query or a fragment (even an
 *     empty `?`/`#`) — that is where signatures and credentials travel;
 *   - every IP literal (the parser normalizes `2130706433` and `0x7f.1`), so
 *     loopback, RFC 1918, link-local, CGNAT/tailnet and machine addresses are
 *     all out without enumerating ranges;
 *   - single-label hosts and private namespaces (`.local`, `.internal`,
 *     `.ts.net`, `.test`, `.onion`, ...);
 *   - public DNS names that resolve to loopback or a private address
 *     (`localtest.me`, `*.nip.io`, any name spelling an IPv4 address);
 *   - token-shaped host labels or path segments (long random runs, UUIDs, hex
 *     digests), because a capability link is a credential even without a
 *     query string;
 *   - a projection longer than the Cloud's 512-character display bound, or one
 *     the inline secret scrubber would rewrite.
 */
export function previewDisplayUrl(raw: string, isLoopback: (url: string) => boolean): string | undefined {
  if (typeof raw !== "string" || !raw || raw.length > MAX_DISPLAY_URL) return undefined;
  if (/[\u0000- \u007f-\u009f?#]/.test(raw) || isLoopback(raw)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
  const host = parsed.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".") || host.startsWith("[") || /^[\d.]+$/.test(host)) return undefined;
  if (PRIVATE_HOST.test(host) || LOOPBACK_DNS.test(host) || EMBEDDED_IPV4.test(host)) return undefined;
  const projected = `${parsed.origin}${parsed.pathname}`;
  if (projected.length > MAX_DISPLAY_URL || isLoopback(projected)) return undefined;
  if ([...host.split("."), ...parsed.pathname.split("/")].some(urlPartCapabilityShaped)) return undefined;
  return redactInline(projected) === projected ? projected : undefined;
}

/**
 * preview — a phase the preview command observed from the supervisor.
 *
 * The supervisor only ever records a loopback URL, and a loopback URL is
 * useless to somebody on another machine while still disclosing a local port,
 * so it never becomes a link. A URL appears only when the caller passes an
 * operator-declared public URL AND it survives previewDisplayUrl. `error`,
 * pids and the control port are omitted: the error is free text from a child
 * process, and the phase already says "failed".
 */
export function previewEvent(
  state: PreviewState | PreviewObservation,
  isLoopback: (url: string) => boolean,
): RcProducedEvent {
  const url = state.url ? previewDisplayUrl(state.url, isLoopback) : undefined;
  return displayEvent("preview", {
      phase: state.phase,
      instance_id: state.instanceId,
      ...(url ? { url } : {}),
  });
}
