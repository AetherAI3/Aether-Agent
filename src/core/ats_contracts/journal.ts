// Spec 2 section 10 — the TRADING journal.
//
// This is not the diagnostic journal. packages/ats-skills/src/journal.js is a
// bounded setup/runtime/browser event log, and section 10 is explicit that the
// two must not share a schema, retention policy, file or authority role. The
// diagnostic journal answers "what did the agent do"; this answers "what did
// the market do, and what did the human think about it".
//
// The central rule is section 10.1's split between two kinds of content in one
// entry:
//
//   IMMUTABLE AUTHORITY FACTS — broker fills, controller receipts, order state,
//     balances, fill prices, quantities, sides, strategy activation ids. A user
//     may never overwrite these.
//   EDITABLE HUMAN CONTEXT — thesis, notes, lessons, tags, grade. Edited freely,
//     but by APPENDING a revision; history is never rewritten.
//
// So `fact_revision` and `reflection_revision` are separate counters. A human
// editing their notes for the fifth time must not make the fill look like it
// changed five times.

import {
  choice,
  closed,
  fail,
  ident,
  integer,
  multilineText,
  nullable,
  pinned,
  schemaTag,
  timestamp,
  uniqueList,
} from "./primitives.js";

export const TRADE_JOURNAL_SCHEMA = "aether.ats.trade-journal/2" as const;
export const HUMAN_NOTE_SCHEMA = "aether.ats.human-note-revision/1" as const;
export const JOURNAL_PREFERENCES_SCHEMA = "aether.ats.journal-preferences/1" as const;

/**
 * Where an entry's FACTS came from. This is the authority label, and section 11
 * uses it to keep broker-reported and ATS-tracked figures from blending: a
 * `manual` entry is excluded from verified-only views by default.
 */
export const JOURNAL_SOURCES = ["controller", "broker", "simulation", "manual"] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];

/**
 * How complete the evidence behind those facts is. `tracking_only` is the state
 * section 17's mid-trade-observation canary requires: something was noticed, no
 * entry was fabricated from it.
 */
export const JOURNAL_CONFIDENCE = ["complete", "reconstructed", "tracking_only", "manual"] as const;
export type JournalConfidence = (typeof JOURNAL_CONFIDENCE)[number];

/** A free-text tag. Bounded and control-character free; tags reach the dashboard. */
const TAG = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,39}$/;

export function journalTag(value: unknown, name: string): string {
  if (typeof value !== "string" || !TAG.test(value)) fail(`${name} must be a bounded tag.`);
  return value;
}

/**
 * IANA timezone name, or UTC. Section 13 requires timestamps to expose timezone
 * context, and section 10.5 stores the operator's choice — a free string here
 * would let an unparseable zone silently fall back to the host's local time,
 * which is precisely the ambiguity the requirement exists to remove.
 */
const TIMEZONE = /^(?:UTC|[A-Za-z][A-Za-z0-9+_-]{0,31}(?:\/[A-Za-z0-9+_-]{1,32}){1,2})$/;

export function timezoneName(value: unknown, name: string): string {
  if (typeof value !== "string" || !TIMEZONE.test(value)) fail(`${name} must be an IANA timezone name.`);
  return value;
}

export interface JournalReflectionV2 {
  readonly thesis: string;
  readonly notes: string;
  readonly lessons: string;
  readonly tags: readonly string[];
  readonly grade: string | null;
}

const REFLECTION_FIELDS = ["thesis", "notes", "lessons", "tags", "grade"] as const;

function reflection(value: unknown, name: string): JournalReflectionV2 {
  const raw = closed(value, name, REFLECTION_FIELDS);
  return Object.freeze({
    // Reflection prose is untrusted local content (section 14: note and strategy
    // content is untrusted data and escaped everywhere). Empty is allowed —
    // a trade may be recorded before the human has written anything.
    thesis: multilineText(raw.thesis, `${name} thesis`, 4_000, { allowEmpty: true }),
    notes: multilineText(raw.notes, `${name} notes`, 20_000, { allowEmpty: true }),
    lessons: multilineText(raw.lessons, `${name} lessons`, 4_000, { allowEmpty: true }),
    tags: Object.freeze(uniqueList(raw.tags, `${name} tags`, 50, journalTag)),
    grade: raw.grade === null ? null : journalTag(raw.grade, `${name} grade`),
  });
}

export interface JournalEntryProjectionV2 {
  readonly schema_version: typeof TRADE_JOURNAL_SCHEMA;
  readonly journal_entry_id: string;
  readonly trade_id: string | null;
  readonly execution_case_id: string | null;
  readonly source: JournalSource;
  readonly fact_revision: number;
  readonly confidence: JournalConfidence;
  readonly reflection: JournalReflectionV2;
  readonly reflection_revision: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

const ENTRY_FIELDS = [
  "schema_version", "journal_entry_id", "trade_id", "execution_case_id", "source", "fact_revision",
  "confidence", "reflection", "reflection_revision", "created_at", "updated_at", "deleted_at",
] as const;

export function validateJournalEntry(value: unknown, name = "Journal entry"): JournalEntryProjectionV2 {
  const raw = closed(value, name, ENTRY_FIELDS);
  const source = choice(raw.source, JOURNAL_SOURCES, `${name} source`);
  const confidence = choice(raw.confidence, JOURNAL_CONFIDENCE, `${name} confidence`);
  const createdAt = timestamp(raw.created_at, `${name} created at`);
  const updatedAt = timestamp(raw.updated_at, `${name} updated at`);
  const deletedAt = nullable(raw.deleted_at, `${name} deleted at`, timestamp);

  // `manual` is both a source and a confidence level and they must agree.
  // A manual entry claiming `complete` confidence would sit inside a
  // verified-only performance view that section 11 says must exclude it.
  if (source === "manual" && confidence !== "manual") {
    fail(`${name} authored manually must carry manual confidence.`);
  }
  if (confidence === "manual" && source !== "manual") {
    fail(`${name} cannot claim manual confidence from an authority source.`);
  }
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    fail(`${name} cannot have been updated before it was created.`);
  }
  if (deletedAt !== null && Date.parse(deletedAt) < Date.parse(createdAt)) {
    fail(`${name} cannot have been deleted before it was created.`);
  }

  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, TRADE_JOURNAL_SCHEMA, name) as typeof TRADE_JOURNAL_SCHEMA,
    journal_entry_id: ident(raw.journal_entry_id, `${name} entry id`),
    // Opaque references only. Section 14 requires opaque account and trade
    // references, so a raw broker order number never reaches this projection.
    trade_id: nullable(raw.trade_id, `${name} trade id`, ident),
    execution_case_id: nullable(raw.execution_case_id, `${name} execution case id`, ident),
    source,
    fact_revision: integer(raw.fact_revision, `${name} fact revision`, 1, 1_000_000),
    confidence,
    reflection: reflection(raw.reflection, `${name} reflection`),
    reflection_revision: integer(raw.reflection_revision, `${name} reflection revision`, 1, 1_000_000),
    created_at: createdAt,
    updated_at: updatedAt,
    deleted_at: deletedAt,
  });
}

/**
 * Whether a human may amend this entry's FACTS. Section 10.1: users may correct
 * a manual entry through a versioned amendment, but may not overwrite a broker
 * fill, order state, execution receipt or canonical strategy record.
 *
 * This is the single predicate both the CLI and the local dashboard consult, so
 * the UI cannot offer an edit the API would refuse, or vice versa.
 */
export function factsAmendable(entry: JournalEntryProjectionV2): boolean {
  return entry.source === "manual";
}

/**
 * Apply a reflection edit. The reflection revision advances; the fact revision
 * is carried through untouched. A human editing their notes must never make a
 * controller receipt look like it changed.
 */
export function amendReflection(
  entry: JournalEntryProjectionV2,
  next: JournalReflectionV2,
  updatedAt: string,
): JournalEntryProjectionV2 {
  if (entry.deleted_at !== null) fail("A deleted journal entry must be restored before it is edited.");
  return validateJournalEntry({
    ...entry,
    reflection: { ...next, tags: [...next.tags] },
    reflection_revision: entry.reflection_revision + 1,
    updated_at: updatedAt,
  });
}

export interface HumanNoteRevisionV1 {
  readonly schema_version: typeof HUMAN_NOTE_SCHEMA;
  readonly note_id: string;
  readonly revision: number;
  readonly trade_id: string | null;
  readonly author: "human";
  readonly body: string;
  readonly supersedes_revision: number | null;
  readonly client_request_id: string;
  readonly created_at: string;
  readonly deleted_at: string | null;
}

const NOTE_FIELDS = [
  "schema_version", "note_id", "revision", "trade_id", "author",
  "body", "supersedes_revision", "client_request_id", "created_at", "deleted_at",
] as const;

export function validateHumanNoteRevision(value: unknown, name = "Human note revision"): HumanNoteRevisionV1 {
  const raw = closed(value, name, NOTE_FIELDS);
  const revision = integer(raw.revision, `${name} revision`, 1, 1_000_000);
  const supersedes = raw.supersedes_revision === null
    ? null
    : integer(raw.supersedes_revision, `${name} superseded revision`, 1, 1_000_000);

  // Revision 1 starts a note and supersedes nothing; every later revision
  // supersedes exactly its predecessor. Section 10.3: edits append revisions
  // and never rewrite history, so a chain with a gap is a lost edit rather
  // than a compact history.
  if (revision === 1 && supersedes !== null) {
    fail(`${name} cannot supersede anything at revision 1.`);
  }
  if (revision > 1 && supersedes !== revision - 1) {
    fail(`${name} must supersede exactly its preceding revision.`);
  }

  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, HUMAN_NOTE_SCHEMA, name) as typeof HUMAN_NOTE_SCHEMA,
    note_id: ident(raw.note_id, `${name} note id`),
    revision,
    trade_id: nullable(raw.trade_id, `${name} trade id`, ident),
    // Pinned. A note revision is human-authored by definition; there is no
    // agent- or model-authored variant of this document, because section 11
    // forbids chat claims and model summaries from reaching performance truth.
    author: pinned(raw.author, "human", `${name} author`),
    body: multilineText(raw.body, `${name} body`, 20_000, { allowEmpty: true }),
    supersedes_revision: supersedes,
    // The idempotency key for a save. Section 10.4 requires an unknown save
    // outcome to stay `indeterminate` rather than be blindly retried; a retry
    // that does happen reuses this id so it cannot append a duplicate revision.
    client_request_id: ident(raw.client_request_id, `${name} client request id`),
    created_at: timestamp(raw.created_at, `${name} created at`),
    deleted_at: nullable(raw.deleted_at, `${name} deleted at`, timestamp),
  });
}

/**
 * Build the next revision of a note. Nothing is overwritten: the caller keeps
 * the previous revision and appends this one.
 */
export function nextNoteRevision(
  previous: HumanNoteRevisionV1,
  body: string,
  clientRequestId: string,
  createdAt: string,
): HumanNoteRevisionV1 {
  return validateHumanNoteRevision({
    ...previous,
    revision: previous.revision + 1,
    body,
    supersedes_revision: previous.revision,
    client_request_id: clientRequestId,
    created_at: createdAt,
  });
}

/**
 * Outcome of a save attempted against a base revision. Section 10.3 requires
 * conflicts to show both versions and demand human resolution, and section 10.4
 * requires an unknown outcome to retain the draft without blind retry — so
 * `conflict` and `indeterminate` are first-class results, not exceptions.
 */
export type NoteSaveOutcome =
  | { readonly kind: "applied"; readonly revision: HumanNoteRevisionV1 }
  | { readonly kind: "conflict"; readonly mine: string; readonly theirs: HumanNoteRevisionV1 }
  | { readonly kind: "indeterminate"; readonly draft: string };

/**
 * Resolve a save against the current revision. A save whose `baseRevision` is
 * not the current one is a conflict: the human edited from a stale view, and
 * silently appending would erase whatever landed in between.
 */
export function resolveNoteSave(input: {
  current: HumanNoteRevisionV1;
  baseRevision: number;
  body: string;
  clientRequestId: string;
  createdAt: string;
}): NoteSaveOutcome {
  if (input.baseRevision !== input.current.revision) {
    return { kind: "conflict", mine: input.body, theirs: input.current };
  }
  // An idempotent replay of the save that already landed returns the existing
  // revision rather than appending a duplicate.
  if (input.current.client_request_id === input.clientRequestId) {
    return { kind: "applied", revision: input.current };
  }
  return {
    kind: "applied",
    revision: nextNoteRevision(input.current, input.body, input.clientRequestId, input.createdAt),
  };
}

export const JOURNAL_PROMPT_STYLES = ["off", "minimal", "guided", "coach"] as const;
export type JournalPromptStyle = (typeof JOURNAL_PROMPT_STYLES)[number];

export const QUICK_NOTE_HOTKEYS = ["x", "off"] as const;
export type QuickNoteHotkey = (typeof QUICK_NOTE_HOTKEYS)[number];

export interface JournalPreferencesV1 {
  readonly schema_version: typeof JOURNAL_PREFERENCES_SCHEMA;
  readonly prompt_style: JournalPromptStyle;
  readonly prompt_after_close: boolean;
  readonly prompt_delay_seconds: number;
  readonly default_tags: readonly string[];
  readonly quick_note_hotkey: QuickNoteHotkey;
  readonly timezone: string;
}

const PREFERENCE_FIELDS = [
  "schema_version", "prompt_style", "prompt_after_close",
  "prompt_delay_seconds", "default_tags", "quick_note_hotkey", "timezone",
] as const;

export function validateJournalPreferences(value: unknown, name = "Journal preferences"): JournalPreferencesV1 {
  const raw = closed(value, name, PREFERENCE_FIELDS);
  const style = choice(raw.prompt_style, JOURNAL_PROMPT_STYLES, `${name} prompt style`);
  const afterClose = raw.prompt_after_close;
  if (typeof afterClose !== "boolean") fail(`${name} prompt-after-close must be a boolean.`);
  // A prompt that is off cannot also be scheduled to fire after a close.
  if (style === "off" && afterClose) {
    fail(`${name} cannot prompt after a close while the prompt style is off.`);
  }

  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, JOURNAL_PREFERENCES_SCHEMA, name) as typeof JOURNAL_PREFERENCES_SCHEMA,
    prompt_style: style,
    prompt_after_close: afterClose,
    prompt_delay_seconds: integer(raw.prompt_delay_seconds, `${name} prompt delay`, 0, 3_600),
    default_tags: Object.freeze(uniqueList(raw.default_tags, `${name} default tags`, 20, journalTag)),
    quick_note_hotkey: choice(raw.quick_note_hotkey, QUICK_NOTE_HOTKEYS, `${name} quick note hotkey`),
    timezone: timezoneName(raw.timezone, `${name} timezone`),
  });
}

/** Conservative defaults: minimal prompting, hotkey available, UTC. */
export function defaultJournalPreferences(): JournalPreferencesV1 {
  return validateJournalPreferences({
    schema_version: JOURNAL_PREFERENCES_SCHEMA,
    prompt_style: "minimal",
    prompt_after_close: false,
    prompt_delay_seconds: 0,
    default_tags: [],
    quick_note_hotkey: "x",
    timezone: "UTC",
  });
}

/**
 * Preferences never alter trade facts or model authority (section 10.5). This
 * predicate exists so a caller can assert that in a test rather than trusting a
 * comment: there is no preference field whose name or value can reach an
 * authority decision.
 */
export function preferencesGrantNoAuthority(preferences: JournalPreferencesV1): boolean {
  return Object.keys(preferences).every(key => PREFERENCE_FIELDS.includes(key as (typeof PREFERENCE_FIELDS)[number]));
}
