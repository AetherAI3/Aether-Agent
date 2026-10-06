// src/core/session_resume.ts — local-first session resume. Reads the JSONL the
// SessionLog already wrote under ~/.aether-agent/logs/<id>/ and rehydrates the
// transcript. No backend, works offline. (Cross-device sync is Plan B.)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logsRoot, monologueLine } from "./session_log.js";
import { decodeEvent, type BrainEvent } from "./brain_protocol.js";
import { isCurrentWorkspace, resolveOpaqueChild } from "./workspace_scope.js";
import { entriesForWorkspace, syncSessionIndex } from "./session_index.js";

/**
 * Which rules and skills a session actually ran under.
 *
 * Recorded so a resume can tell that they MOVED. A session id names a
 * conversation; it does not name the instructions that conversation was
 * conducted under, and those live in files anyone can edit between two runs.
 * Digests only — never instruction or skill CONTENT, which would put a
 * project's prose into every session directory on disk.
 */
export interface SessionContext {
  skills: Array<{
    id: string;
    version: string;
    /** "sha256:<hex>" of the skill package as loaded. */
    digest: string;
    invocation: string;
    trust: string;
    lock: string;
  }>;
  /** Display paths of the instruction sources that governed the run. */
  instructionSources: string[];
  /** One digest over the whole ordered instruction graph. */
  instructionGraphDigest: string;
  /** "topic=effective" for each conflict the run resolved. */
  conflicts: string[];
}

export interface SessionManifest {
  sessionId: string;
  task: string;
  /** Resolved model id; local sessions use the `ollama/` namespace. */
  model: string;
  brain: "local" | "cloud";
  started: string;
  ended?: string | null;
  finalStatus?: string;
  cwd?: string;
  /** Failing tests the run left behind, when it left any. */
  remaining?: number;
  /** The command this session's verify gate ran, when one was named. */
  testCmd?: string;
  /** Exact tree-bound host check receipt, when the final check was recordable. */
  verificationRecord?: { command: string; ranAt: string; head: string | null; treeDigest: string; exitCode: number };
  hostRefusals?: string[];
  /** The rules and skills the run was conducted under. */
  context?: SessionContext;
}

export interface LoadedSession {
  dir: string;
  manifest: SessionManifest;
  events: Array<Record<string, unknown>>;
}

/** Load one session by id (directory name) from the logs root. */
export function loadSession(id: string, root: string = logsRoot(), cwd?: string): LoadedSession {
  const dir = resolveOpaqueChild(root, id, "session id");
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`no such session: ${id}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SessionManifest;
  if (cwd !== undefined && !isCurrentWorkspace(manifest.cwd, cwd)) {
    throw new Error(`session belongs to another workspace: ${id}`);
  }
  const eventsPath = join(dir, "events.jsonl");
  const events = existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
  return { dir, manifest, events };
}
/**
 * The most recently started session in this workspace, or null if none.
 *
 * Goes through the session index, which is already newest-first and scoped by
 * workspace, so the common case reads ONE small file plus the one session it
 * returns — instead of loading and parsing every session's events to answer
 * "what was I last doing here". The index reconciles itself against the session
 * directories on each read, so this is still correct on a fresh install, after
 * the index is deleted, and for every session recorded before it existed.
 */
export function latestSession(cwd: string, root: string = logsRoot()): LoadedSession | null {
  if (!existsSync(root)) return null;
  for (const entry of entriesForWorkspace(syncSessionIndex(root).entries, cwd)) {
    if (entry.archived) continue;
    try {
      // The manifest is the authority: an index row whose session is gone or
      // whose workspace no longer matches is skipped, not trusted.
      return loadSession(entry.sessionId, root, cwd);
    } catch {
      /* stale or unreadable row — try the next one */
    }
  }
  return null;
}

/** Render stored events back into transcript lines (reuses monologueLine). */
export function replayLines(events: Array<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const raw of events) {
    const ev: BrainEvent | null = decodeEvent(raw);
    if (!ev) continue;
    const line = monologueLine(ev);
    if (line) out.push(line);
  }
  return out;
}
