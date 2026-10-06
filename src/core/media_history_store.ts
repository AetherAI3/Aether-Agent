// src/core/media_history_store.ts — the only writer of the media index.
//
// Everything that mutates history runs inside one locked transaction so two
// Agent turns can never allocate the same sequence or drop each other's entry.
// The transaction is deliberately synchronous end to end: an await between
// "backup refreshed" and "primary renamed" would open a window where a crash
// leaves neither file authoritative.

import { randomUUID } from "node:crypto";
import { atomicWriteFile, readJsonFile, withFileLock } from "./durable_store.js";
import {
  loadHistory,
  MEDIA_HISTORY_SCHEMA_VERSION,
  MEDIA_RETENTION,
  validateDoc,
  type HistoryLoad,
  type HistoryPaths,
  type HistoryState,
  type HistoryWarning,
  type MediaEntry,
  type MediaEntryKind,
  type MediaHistoryDoc,
} from "./media_history.js";

export interface AppendInput {
  kind: MediaEntryKind;
  displayName: string;
  filePath: string;
  url: string;
  model: string;
  prompt: string;
  sizeBytes: number;
  metadata?: Record<string, unknown>;
}

export interface AppendResult {
  entry: MediaEntry;
  /** Recovery state observed while reading the generation we appended to. */
  state: HistoryState;
  warning?: HistoryWarning;
}

export interface StoreOptions {
  now?: string;
  newId?: () => string;
  lockTimeoutMs?: number;
}

export interface AppendOptions extends StoreOptions {
  /**
   * Told about the entry once it is durably committed and the lock is released
   * — never for an append that failed. This store knows nothing about who is
   * listening (the RC viewer host, today); an observer is a notification, not a
   * participant in the transaction.
   */
  onCommitted?: (entry: MediaEntry) => void;
}

/**
 * The entry is already on disk and verified by readback when this runs. An
 * observer that throws must not turn that into a reported failure: the caller
 * would tell the user the artifact was not recorded, and a retry would record
 * it twice. Observers own their own error reporting (RC records delivery state
 * in its outbox), so the throw stops here.
 */
function notifyCommitted(observer: AppendOptions["onCommitted"], entry: MediaEntry): void {
  if (!observer) return;
  try {
    observer(entry);
  } catch {
    // Deliberately contained — see above.
  }
}

/**
 * A read that returned a document this build must not overwrite. Callers get a
 * thrown error rather than a silent no-op so the failure reaches the user.
 */
function assertWritable(load: HistoryLoad): void {
  if (load.state === "degraded" && load.warning?.code === "schema-too-new") {
    throw new Error(load.warning.message);
  }
}

function commit(paths: HistoryPaths, doc: MediaHistoryDoc): void {
  const validated = validateDoc(doc);
  if (!validated) throw new Error("refusing to write an invalid media history document");
  atomicWriteFile(paths.primary, JSON.stringify(validated, null, 2) + "\n", {
    backupPath: paths.backup,
  });
  // Readback: prove the bytes that landed parse and carry our generation
  // before telling the caller the artifact was recorded.
  const readback = readJsonFile<unknown>(paths.primary);
  const committed = readback.ok ? validateDoc(readback.value) : null;
  if (!committed || committed.generation !== validated.generation) {
    throw new Error("media history did not commit; the index on disk is not the generation written");
  }
}

/**
 * Record one generated artifact. Allocation and commit both happen under the
 * lock, so the sequence a caller receives is the sequence that persisted.
 */
export function appendEntry(
  paths: HistoryPaths,
  input: AppendInput,
  options: AppendOptions = {},
): AppendResult {
  const now = options.now ?? new Date().toISOString();
  const newId = options.newId ?? randomUUID;
  const result = withFileLock(
    paths.lock,
    "media-history",
    (): AppendResult => {
      const load = loadHistory(paths, now);
      assertWritable(load);

      const sequence = BigInt(load.doc.nextSequence);
      const entry: MediaEntry = {
        artifactId: newId(),
        sequence: sequence.toString(),
        createdAt: now,
        kind: input.kind,
        displayName: input.displayName,
        filePath: input.filePath,
        url: input.url,
        model: input.model,
        prompt: input.prompt,
        sizeBytes: input.sizeBytes,
        source: "agent-media",
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };

      // Trim only after allocating: retention bounds what is retained, never
      // what the next reference will be.
      const appended = [...load.doc.entries, entry];
      const retained =
        appended.length > MEDIA_RETENTION
          ? appended.slice(appended.length - MEDIA_RETENTION)
          : appended;

      commit(paths, {
        schemaVersion: MEDIA_HISTORY_SCHEMA_VERSION,
        generation: load.doc.generation + 1,
        nextSequence: (sequence + 1n).toString(),
        updatedAt: now,
        entries: retained,
      });

      return load.warning
        ? { entry, state: load.state, warning: load.warning }
        : { entry, state: load.state };
    },
    { timeoutMs: options.lockTimeoutMs },
  );
  // Outside the lock: an observer doing its own I/O must never extend the
  // window in which a second Agent turn waits to record its artifact.
  notifyCommitted(options.onCommitted, result.entry);
  return result;
}

/**
 * Persist a document read back in a degraded state, so the recovered
 * generation becomes the primary again and the warning stops repeating.
 */
export function repersist(paths: HistoryPaths, options: StoreOptions = {}): HistoryLoad {
  const now = options.now ?? new Date().toISOString();
  return withFileLock(
    paths.lock,
    "media-history",
    () => {
      const load = loadHistory(paths, now);
      assertWritable(load);
      commit(paths, {
        ...load.doc,
        schemaVersion: MEDIA_HISTORY_SCHEMA_VERSION,
        generation: load.doc.generation + 1,
        updatedAt: now,
      });
      return load;
    },
    { timeoutMs: options.lockTimeoutMs },
  );
}

/** Empty the index without touching the artifacts it points at. */
export function clearHistory(paths: HistoryPaths, options: StoreOptions = {}): number {
  const now = options.now ?? new Date().toISOString();
  return withFileLock(
    paths.lock,
    "media-history",
    () => {
      const load = loadHistory(paths, now);
      assertWritable(load);
      const cleared = load.doc.entries.length;
      commit(paths, {
        schemaVersion: MEDIA_HISTORY_SCHEMA_VERSION,
        generation: load.doc.generation + 1,
        // Clearing the list is not a licence to reissue references that
        // already named a file on disk.
        nextSequence: load.doc.nextSequence,
        updatedAt: now,
        entries: [],
      });
      return cleared;
    },
    { timeoutMs: options.lockTimeoutMs },
  );
}

// ═════════════════════════════════════════════════════════════════════
// Reference resolution
// ═════════════════════════════════════════════════════════════════════

export type ResolveResult =
  | { status: "found"; entry: MediaEntry }
  | { status: "not-found" }
  | { status: "ambiguous"; candidates: readonly MediaEntry[] };

const MIN_ID_PREFIX = 4;

/**
 * Resolve a user-supplied reference to exactly one artifact, or say why it
 * cannot. Order is most-specific first: sequence, full artifact ID, unique ID
 * prefix, then unique display name. A filename is never canonical — duplicate
 * names are expected — so it only resolves when it happens to be unambiguous.
 */
export function resolveRef(entries: readonly MediaEntry[], ref: string): ResolveResult {
  const needle = ref.trim();
  if (!needle) return { status: "not-found" };

  if (/^[1-9][0-9]*$/.test(needle)) {
    const bySequence = entries.filter((e) => e.sequence === needle);
    if (bySequence.length === 1) return { status: "found", entry: bySequence[0]! };
    if (bySequence.length > 1) return { status: "ambiguous", candidates: bySequence };
    return { status: "not-found" };
  }

  const lower = needle.toLowerCase();
  const exactId = entries.filter((e) => e.artifactId.toLowerCase() === lower);
  if (exactId.length === 1) return { status: "found", entry: exactId[0]! };

  if (/^[0-9a-f-]+$/.test(lower) && lower.length >= MIN_ID_PREFIX) {
    const byPrefix = entries.filter((e) => e.artifactId.toLowerCase().startsWith(lower));
    if (byPrefix.length === 1) return { status: "found", entry: byPrefix[0]! };
    if (byPrefix.length > 1) return { status: "ambiguous", candidates: byPrefix };
  }

  const byName = entries.filter((e) => e.displayName === needle || e.filePath === needle);
  if (byName.length === 1) return { status: "found", entry: byName[0]! };
  if (byName.length > 1) return { status: "ambiguous", candidates: byName };

  return { status: "not-found" };
}

/** Newest first, capped. Mirrors the v1 `listOutput` contract. */
export function listEntries(entries: readonly MediaEntry[], limit = 10): MediaEntry[] {
  const size = Math.max(0, Math.trunc(limit));
  return entries.slice(Math.max(0, entries.length - size)).reverse();
}

/** Short, stable display form of an artifact ID for list output. */
export function shortId(artifactId: string): string {
  return artifactId.replace(/-/g, "").slice(0, 8);
}
