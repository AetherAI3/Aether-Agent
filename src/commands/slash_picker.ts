// Pure, bounded slash discovery for the raw coding composer. The manifest is
// the sole list of commands; picker acceptance only edits a draft.
import { COMMAND_MANIFEST, commandInvocationStatus, type CommandManifestEntry } from "./command_manifest.js";
import { sliceVisible } from "../ui/text.js";

export interface SlashPickerState {
  readonly priorValue: string;
  readonly priorCursor: number;
  readonly selectedName: string | null;
}

export interface SlashDraft {
  readonly prefix: string;
  readonly suffix: string;
}

/** Only a leading command token qualifies; multiline task text never does. */
export function slashDraft(value: string): SlashDraft | null {
  if (value.includes("\n") || value.includes("\r")) return null;
  const match = /^\/([a-z0-9-]*)([\s\S]*)$/i.exec(value);
  if (!match) return null;
  return { prefix: match[1]!.toLowerCase(), suffix: match[2]! };
}

export function slashPickerMatches(
  value: string, entries: readonly CommandManifestEntry[] = COMMAND_MANIFEST,
): CommandManifestEntry[] {
  const draft = slashDraft(value);
  if (!draft) return [];
  return entries.filter(entry => entry.surface === "slash" && !entry.hidden && entry.sessionScope !== "managed-agent"
    && [entry.name, ...entry.aliases].some(name => name.startsWith(draft.prefix)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function openSlashPicker(
  value: string, priorValue: string, priorCursor: number,
  entries: readonly CommandManifestEntry[] = COMMAND_MANIFEST,
): SlashPickerState | null {
  if (!slashDraft(value)) return null;
  return { priorValue, priorCursor, selectedName: slashPickerMatches(value, entries)[0]?.name ?? null };
}

export function refreshSlashPicker(
  state: SlashPickerState, value: string, entries: readonly CommandManifestEntry[] = COMMAND_MANIFEST,
): SlashPickerState | null {
  if (!slashDraft(value)) return null;
  const matches = slashPickerMatches(value, entries);
  return { ...state, selectedName: matches.some(entry => entry.name === state.selectedName)
    ? state.selectedName : matches[0]?.name ?? null };
}

export function moveSlashPicker(
  state: SlashPickerState, value: string, direction: 1 | -1,
  entries: readonly CommandManifestEntry[] = COMMAND_MANIFEST,
): SlashPickerState {
  const matches = slashPickerMatches(value, entries);
  if (!matches.length) return { ...state, selectedName: null };
  const index = matches.findIndex(entry => entry.name === state.selectedName);
  const next = index < 0 ? (direction === 1 ? 0 : matches.length - 1)
    : (index + direction + matches.length) % matches.length;
  return { ...state, selectedName: matches[next]!.name };
}

/** Translate a cursor in an existing argument suffix by the changed token width. */
export function acceptSlashPicker(
  state: SlashPickerState, value: string, cursor: number,
  entries: readonly CommandManifestEntry[] = COMMAND_MANIFEST,
): { value: string; cursor: number } | null {
  const draft = slashDraft(value);
  if (!draft) return null;
  const entry = slashPickerMatches(value, entries).find(row => row.name === state.selectedName);
  if (!entry) return null;
  const oldTokenLength = 1 + [...draft.prefix].length;
  const newToken = `/${entry.name}`;
  const suffix = draft.suffix || " ";
  const nextCursor = cursor <= oldTokenLength
    ? [...newToken].length + (draft.suffix ? 0 : 1)
    : cursor + [...newToken].length - oldTokenLength;
  return { value: newToken + suffix, cursor: nextCursor };
}

/** At most eight choices and one footer, bounded by terminal height. */
export function renderSlashPicker(
  state: SlashPickerState, value: string, cols: number, rows: number,
  entries: readonly CommandManifestEntry[] = COMMAND_MANIFEST,
): string[] {
  const capacity = Math.min(9, Math.max(0, rows - 2));
  if (!capacity) return [];
  const matches = slashPickerMatches(value, entries);
  const width = Math.max(1, cols - 1); // avoid terminal auto-wrap
  if (!matches.length) return [sliceVisible("  No matching commands · Esc restores draft", width)];
  const choiceRows = Math.min(matches.length, capacity > 1 ? capacity - 1 : 1);
  const selected = Math.max(0, matches.findIndex(entry => entry.name === state.selectedName));
  const start = Math.max(0, Math.min(selected - choiceRows + 1, matches.length - choiceRows));
  const lines = matches.slice(start, start + choiceRows).map(entry => {
    const chosen = entry.name === state.selectedName ? ">" : " ";
    const command = `${chosen} /${entry.name}`;
    const status = commandInvocationStatus(entry, "coding");
    const capability = status === "runtime-dependent" ? "" : ` [${status}]`;
    if (width < 24) return sliceVisible(command, width);
    const summaryFloor = Math.min(entry.summary.length, 24, Math.floor(width / 3));
    const hintBudget = Math.max(0, Math.min(24, width - command.length - capability.length - summaryFloor - 3));
    const hint = entry.args && hintBudget > 1 ? ` ${sliceVisible(entry.args, hintBudget - 1)}` : "";
    const summaryBudget = Math.max(0, width - command.length - hint.length - capability.length - 3);
    return sliceVisible(`${command}${hint} · ${sliceVisible(entry.summary, summaryBudget)}${capability}`, width);
  });
  if (capacity > 1) lines.push(sliceVisible(`  ${selected + 1}/${matches.length} · ↑↓/Tab choose · Enter insert · Esc restore`, width));
  return lines;
}
