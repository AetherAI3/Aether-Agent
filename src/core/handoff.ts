// src/core/handoff.ts — the portable continuation record.
//
// A session log (session_log.ts) is the human's record of one run: append-only
// JSONL plus a rendered monologue, keyed to one absolute working directory on
// one machine. `aether resume` could already REPLAY it to the screen, but the
// brain never saw a byte of it — resuming meant re-typing the story so far.
//
// A handoff is the machine-facing half of that record: a small, self-contained
// JSON document distilled from a session (what the task was, which model ran
// it, what it touched, whether the tests were green, what is still failing)
// plus the repository identity it belongs to. Two things follow:
//
//   1. `aether agent --resume <id> "<next task>"` prepends the CONTINUATION
//      BRIEF built from it, so a different model picks the thread up with the
//      project context already in hand.
//   2. `aether resume export` writes it to a file. Copy that file anywhere —
//      another checkout, another machine, another OS — and
//      `aether agent --resume <file>` continues there. Nothing in it is keyed
//      to an absolute path, so the receiving side needs no matching layout.
//
// Deliberately NOT a transcript: full chat history is large, leaks file
// contents and shell commands, and is exactly what the session log already
// redacts. The brief is a summary a human could have written, which is what
// makes it safe to move between machines.
//
// A handoff read back in is UNTRUSTED input — it arrived from another machine.
// Every field is validated on the way in, and every string is run through the
// terminal sanitizer, because these strings are both printed and prepended to
// the brain's prompt.

import type { BrainEvent } from "./brain_protocol.js";
import { decodeEvent } from "./brain_protocol.js";
import { atomicWriteFile, readJsonFile } from "./durable_store.js";
import type { SessionContext } from "./session_resume.js";
import { loadSession, replayLines, type LoadedSession } from "./session_resume.js";
import { logsRoot, repoFrom, type RepoIdentity } from "./session_log.js";
import { requireOpaqueId } from "./workspace_scope.js";
import type { SessionIndexEntry } from "./session_index.js";
import { clipCodePoints } from "../ui/theme.js";
import { sanitizeTerm } from "../ui/text.js";

export const HANDOFF_SCHEMA_VERSION = 1;
export const HANDOFF_KIND = "aether-agent-handoff";

/** Where the work lives, expressed so it survives the trip to another machine.
 *  The same record the session manifest stores — one shape with one spelling,
 *  so a handoff and a library row cannot describe a repository differently. */
export type HandoffRepo = RepoIdentity;

export interface Handoff {
  schemaVersion: number;
  kind: typeof HANDOFF_KIND;
  sessionId: string;
  /** The task the prior run was given. */
  task: string;
  /** Resolved model id (`ollama:<tag>` locally; "" for hosted auto-routing). */
  model: string;
  brain: "local" | "cloud";
  started: string;
  ended: string | null;
  /** The prior run's verify-gate verdict — "ok" only if its tests were green. */
  finalStatus: string;
  /** Failing tests the prior run left behind, when it left any. */
  remaining?: number;
  repo?: HandoffRepo;
  /** Compacted narration of what the prior run actually did. */
  highlights: string[];
  /** Files the prior run wrote. */
  filesTouched: string[];
  /** The command the verify gate ran, when the prior run named one. */
  testCmd?: string;
  /**
   * The rules and skills the prior run was conducted under. Digests, never
   * content: a handoff crosses machines, and a project's prose is not ours to
   * carry. What travels is enough to tell the receiving machine whether it is
   * about to continue the work under DIFFERENT instructions.
   */
  context?: SessionContext;
}

/** Bounds for the context record. A handoff is untrusted input on the way in. */
const MAX_CONTEXT_SKILLS = 16;
const MAX_CONTEXT_SOURCES = 24;
const MAX_CONTEXT_CONFLICTS = 24;

/** Highlights are a summary, not a transcript — these bounds keep it one. */
const MAX_HIGHLIGHTS = 40;
const MAX_HIGHLIGHT_CHARS = 300;
const MAX_FILES = 60;

/** Flatten, sanitize, and bound one line of untrusted narration. */
function clip(text: string, max = MAX_HIGHLIGHT_CHARS): string {
  return clipCodePoints(sanitizeTerm(text).replace(/\s+/g, " ").trim(), max);
}

/** True when this event is the host writing a file — the ONE definition of
 *  "the run changed something", shared with cmdCode's live blast-radius set. */
export function wroteFile(ev: BrainEvent): string | null {
  if (ev.type !== "tool_call" || (ev.name !== "write_file" && ev.name !== "patch_file")) return null;
  const path = ev.args["path"];
  return typeof path === "string" && path ? path : null;
}

/** The narration worth carrying forward: stages entered, what the model said it
 *  was doing, checkpoints, and the terminal result. Tool spam is dropped — the
 *  next model will re-read the files itself, and it is the DECISIONS that do not
 *  survive a fresh context. */
export function summarizeEvents(events: Array<Record<string, unknown>>): {
  highlights: string[];
  filesTouched: string[];
} {
  const highlights: string[] = [];
  // Keep the TAIL: the end of a run is what the next one builds on. Bounding as
  // we go means a 10k-event session never holds 10k clipped strings at once.
  const remember = (line: string): void => {
    highlights.push(line);
    if (highlights.length > MAX_HIGHLIGHTS) highlights.shift();
  };
  const files = new Set<string>();
  for (const raw of events) {
    const ev: BrainEvent | null = decodeEvent(raw);
    if (!ev) continue;
    const written = wroteFile(ev);
    if (written) {
      if (files.size < MAX_FILES) files.add(written);
      continue;
    }
    if (ev.type === "tool_call") continue;
    if (ev.type === "stage") remember(`stage: ${clip(ev.name)}`);
    else if (ev.type === "monologue" && ev.text.trim()) remember(clip(ev.text));
    else if (ev.type === "checkpoint") remember(`checkpoint ${clip(ev.gitSha, 40)}`);
    else if (ev.type === "done") {
      // The final answer usually arrives twice — once as the closing monologue,
      // once inside `done`. Say it once.
      const result = clip(ev.result);
      if (highlights[highlights.length - 1] !== result) {
        remember(`${ev.ok ? "finished" : "stopped"}: ${result}`);
      }
    } else if (ev.type === "error") remember(`error: ${clip(ev.msg)}`);
  }
  return { highlights, filesTouched: [...files] };
}

// repoFrom / readRepoIdentity moved to session_log.ts, which is where the
// identity is now STORED (it goes into the manifest at close, so the library
// can say which branch a session belonged to). Re-exported here because a
// handoff carries the same record and this is where callers look for it.
export { readRepoIdentity } from "./session_log.js";

export interface BuildHandoffOptions {
  repo?: HandoffRepo | undefined;
  testCmd?: string | undefined;
}

/** Distil one loaded session into a handoff. Pure — the caller supplies the
 *  repo identity so this stays testable without a git checkout. */
export function buildHandoff(session: LoadedSession, opts: BuildHandoffOptions = {}): Handoff {
  const m = session.manifest;
  const { highlights, filesTouched } = summarizeEvents(session.events);
  const testCmd = opts.testCmd ?? m.testCmd;
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    kind: HANDOFF_KIND,
    sessionId: m.sessionId,
    task: m.task,
    model: m.model ?? "",
    brain: m.brain,
    started: m.started,
    ended: m.ended ?? null,
    finalStatus: m.finalStatus ?? "running",
    ...(typeof m.remaining === "number" && m.remaining > 0 ? { remaining: m.remaining } : {}),
    ...(opts.repo ? { repo: opts.repo } : {}),
    highlights,
    filesTouched,
    ...(testCmd ? { testCmd } : {}),
    ...(m.context ? { context: m.context } : {}),
  };
}

/**
 * Validate the context record out of an untrusted handoff. Anything that is not
 * a well-formed entry is DROPPED rather than half-read: a skill row with no
 * digest cannot be compared against anything, so keeping it would put a value
 * in the resume comparison that means nothing.
 */
function contextFrom(value: unknown): SessionContext | undefined {
  const body = asObject(value);
  if (!body) return undefined;
  const list = (key: string, max: number): string[] =>
    Array.isArray(body[key])
      ? (body[key] as unknown[]).filter((v): v is string => typeof v === "string").slice(0, max).map((v) => clip(v))
      : [];
  const rawSkills = Array.isArray(body["skills"]) ? (body["skills"] as unknown[]) : [];
  const skills = rawSkills
    .slice(0, MAX_CONTEXT_SKILLS)
    .map((entry) => asObject(entry))
    .filter((entry): entry is Record<string, unknown> => entry != null)
    .map((entry) => ({
      id: typeof entry["id"] === "string" ? clip(entry["id"]) : "",
      version: typeof entry["version"] === "string" ? clip(entry["version"]) : "",
      digest: typeof entry["digest"] === "string" ? clip(entry["digest"]) : "",
      invocation: typeof entry["invocation"] === "string" ? clip(entry["invocation"]) : "",
      trust: typeof entry["trust"] === "string" ? clip(entry["trust"]) : "",
      lock: typeof entry["lock"] === "string" ? clip(entry["lock"]) : "",
    }))
    .filter((entry) => entry.id !== "" && entry.digest !== "");
  const instructionGraphDigest =
    typeof body["instructionGraphDigest"] === "string" ? clip(body["instructionGraphDigest"]) : "";
  const context: SessionContext = {
    skills,
    instructionSources: list("instructionSources", MAX_CONTEXT_SOURCES),
    instructionGraphDigest,
    conflicts: list("conflicts", MAX_CONTEXT_CONFLICTS),
  };
  // An entirely empty record carries no information and must not be mistaken
  // for "the prior run had no rules and no skills" — that is what an ABSENT
  // record means, and the two lead to different resume decisions.
  if (!context.skills.length && !context.instructionSources.length && !context.instructionGraphDigest) {
    return undefined;
  }
  return context;
}

/** A plain JSON object, or undefined for null/array/primitive. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Validate an untrusted handoff document. Handoffs travel between machines, so
 *  a file that is merely JSON is not enough — every field the brief renders is
 *  checked and sanitized, and anything unrecognized is dropped rather than
 *  half-used. */
export function parseHandoff(value: unknown): Handoff {
  const body = asObject(value);
  if (!body) throw new Error("handoff file is not a JSON object");
  if (body["kind"] !== HANDOFF_KIND) throw new Error("not an Aether Agent handoff file");
  const version = body["schemaVersion"];
  // Number.isInteger already rejects every non-number, so this one check covers
  // both "not a number" and "not a whole version".
  if (!Number.isInteger(version)) throw new Error("handoff file has no usable schemaVersion");
  const schemaVersion = version as number;
  if (schemaVersion < 1) throw new Error("handoff file has no usable schemaVersion");
  if (schemaVersion > HANDOFF_SCHEMA_VERSION) {
    throw new Error(
      `handoff was written by a newer Aether Agent (schema ${schemaVersion}); upgrade with: npm i -g aether-agents`,
    );
  }
  const field = (source: Record<string, unknown> | undefined, key: string): string =>
    typeof source?.[key] === "string" ? clip(source[key] as string) : "";
  const str = (key: string): string => field(body, key);
  const strings = (key: string): string[] =>
    Array.isArray(body[key]) ? (body[key] as unknown[]).filter((v): v is string => typeof v === "string") : [];
  const sessionId = str("sessionId");
  const task = str("task");
  if (!sessionId || !task) throw new Error("handoff file is missing its session id or task");
  const repo = asObject(body["repo"]);
  const identity = repoFrom(field(repo, "remote"), field(repo, "branch"), field(repo, "head"));
  const remaining = body["remaining"];
  const testCmd = str("testCmd");
  const context = contextFrom(body["context"]);
  return {
    schemaVersion,
    kind: HANDOFF_KIND,
    sessionId,
    task,
    model: str("model"),
    brain: body["brain"] === "cloud" ? "cloud" : "local",
    started: str("started"),
    ended: str("ended") || null,
    finalStatus: str("finalStatus") || "unknown",
    ...(typeof remaining === "number" && remaining > 0 ? { remaining } : {}),
    ...(identity ? { repo: identity } : {}),
    // Bound BEFORE sanitizing: a hostile file with 10k highlights should cost 40
    // clips, not 10k.
    highlights: strings("highlights").slice(-MAX_HIGHLIGHTS).map((h) => clip(h)),
    filesTouched: strings("filesTouched").slice(0, MAX_FILES).map((f) => clip(f)),
    ...(testCmd ? { testCmd } : {}),
    ...(context ? { context } : {}),
  };
}

export function writeHandoff(path: string, handoff: Handoff): void {
  // Atomic like every other durable file this CLI owns (config, goals, history,
  // mcp store): an interrupted export must not destroy a good handoff or leave
  // half a JSON document that `--resume` will refuse. Creates missing parents,
  // so `--out reports/handoff.json` works.
  atomicWriteFile(path, JSON.stringify(handoff, null, 2) + "\n");
}

export function readHandoff(path: string): Handoff {
  const read = readJsonFile<unknown>(path);
  if (!read.ok) {
    if (read.reason === "missing") {
      throw new Error(`no handoff file at ${path} — write one with: aether resume export --out ${path}`);
    }
    throw new Error(`cannot read handoff ${path}: ${read.detail}`);
  }
  return parseHandoff(read.value);
}

/** A `--resume` value that names a FILE rather than a local session id.
 *
 *  The two branches must partition the input against the SAME rule the loader
 *  enforces, or a value can fall through both: `requireOpaqueId` (the canonical
 *  session-id shape, and what `loadSession` calls a moment later) is the rule,
 *  so anything it rejects — a Windows or POSIX separator, `..`, `~/`, a dotted
 *  name — is a path. The `.json` shortcut keeps an ordinary bare filename on
 *  the file side even though it is a legal id. */
export function isHandoffPath(value: string): boolean {
  if (value.toLowerCase().endsWith(".json")) return true;
  try {
    requireOpaqueId(value, "session id");
    return false;
  } catch {
    return true;
  }
}

/** What a `--resume` reference resolved to: always a handoff, plus the loaded
 *  session when the reference was a local id (the file form has no transcript —
 *  that is the point of it). Returned together so the caller reads the log once
 *  and the file-vs-id decision is made in exactly one place. */
export interface ResolvedResume {
  handoff: Handoff;
  session: LoadedSession | null;
}

/**
 * Resolve a `--resume` value.
 *
 * A file is never workspace-scoped: importing one is an explicit act by the
 * person holding it, and its whole purpose is to land in a checkout whose
 * absolute path does not match where the work started. A session id still is.
 */
export function resolveResume(
  value: string,
  cwd: string,
  load: typeof loadSession = loadSession,
): ResolvedResume {
  const ref = value.trim();
  if (!ref) throw new Error("--resume needs a session id or a handoff file");
  if (isHandoffPath(ref)) return { handoff: readHandoff(ref), session: null };
  const session = load(ref, logsRoot(), cwd);
  return { handoff: buildHandoff(session), session };
}

/**
 * Render the brief the NEXT brain reads before its own task.
 *
 * Written as plain prose on purpose: it is prepended to the task text, so it
 * has to be legible to every brain on every path — a hosted frontier model, a
 * 4B local model, and the human reading the log a week later — without any of
 * them having to parse a format.
 */
export function continuationBrief(h: Handoff): string {
  const lines: string[] = [];
  lines.push("## Continuing a prior Aether Agent session");
  lines.push("");
  lines.push(`Prior session: ${h.sessionId}`);
  lines.push(`Ran on: ${h.model || "the account default model"} (${h.brain} brain)`);
  lines.push(`Original task: ${h.task}`);
  lines.push(
    `Where it left off: ${h.finalStatus}` +
      (h.remaining ? ` — ${h.remaining} test${h.remaining === 1 ? "" : "s"} still failing` : ""),
  );
  if (h.testCmd) lines.push(`Verification command: ${h.testCmd}`);
  if (h.repo?.remote || h.repo?.branch) {
    lines.push(`Repository: ${h.repo.remote ?? "(local)"}${h.repo.branch ? ` on ${h.repo.branch}` : ""}`);
  }
  if (h.filesTouched.length) {
    lines.push("");
    lines.push("Files the prior session changed:");
    for (const f of h.filesTouched) lines.push(`- ${f}`);
  }
  if (h.highlights.length) {
    lines.push("");
    lines.push("What it did, in order:");
    for (const line of h.highlights) lines.push(`- ${line}`);
  }
  lines.push("");
  lines.push(
    "You are continuing this work in the same repository. Read the files above " +
      "before changing them — the summary is what happened, not what the code " +
      "says now. Do not redo finished work.",
  );
  return lines.join("\n");
}

/** Compose the brief and the next instruction into the task the brain receives. */
export function continuationTask(h: Handoff, nextTask: string): string {
  const next = nextTask.trim() || h.task;
  return `${continuationBrief(h)}\n\n## Your task now\n\n${next}\n`;
}

/** The lines shown to the HUMAN for what is being continued: a local session
 *  replays its whole transcript, a handoff file has only its highlights (it
 *  never carried a transcript — that is the point of it). */
export function resumeReplayLines(resolved: ResolvedResume, ref: string): string[] {
  if (resolved.session) return replayLines(resolved.session.events);
  const h = resolved.handoff;
  return [`⇄ continuing ${h.sessionId} (${h.finalStatus}) from ${ref}`, ...h.highlights.map((l) => "  " + l)];
}

/**
 * Project a handoff onto a library row so the SAME Project Continuity header
 * renders for an imported handoff as for a local session.
 *
 * The one field a handoff cannot supply is the workspace: it is deliberately
 * not keyed to an absolute path — that is what makes it portable — so the row
 * carries the empty string and callers render it with `kind: "handoff"` and no
 * continuity state rather than inventing a checkout for it.
 */
export function handoffEntry(h: Handoff): SessionIndexEntry {
  return {
    sessionId: h.sessionId,
    workspace: "",
    workspaceFingerprint: "",
    task: h.task,
    model: h.model,
    brain: h.brain,
    started: h.started,
    ended: h.ended,
    finalStatus: h.finalStatus,
    ...(h.remaining != null && h.remaining > 0 ? { remaining: h.remaining } : {}),
    ...(h.testCmd ? { testCmd: h.testCmd } : {}),
    ...(h.repo?.remote ? { repoRemote: h.repo.remote } : {}),
    ...(h.repo?.branch ? { branch: h.repo.branch } : {}),
    ...(h.repo?.head ? { headRev: h.repo.head } : {}),
    // The handoff carries the actual paths, so the count is exact — UNTIL it
    // hits the bound. `summarizeEvents` stops adding at MAX_FILES and
    // `parseHandoff` slices to it again, so a run that wrote 200 files arrives
    // carrying 60. Reporting "60" there would be a confident wrong number, and
    // this library's rule is that a number nobody can vouch for is omitted:
    // at the bound the count is left absent and renders as "unknown".
    ...(h.filesTouched.length < MAX_FILES ? { filesTouched: h.filesTouched.length } : {}),
  };
}
