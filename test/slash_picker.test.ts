import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMAND_MANIFEST, commandInvocationStatus, findManifestCommand, type CommandManifestEntry } from "../src/commands/command_manifest.js";
import {
  acceptSlashPicker, moveSlashPicker, openSlashPicker, refreshSlashPicker, renderSlashPicker, slashDraft, slashPickerMatches,
} from "../src/commands/slash_picker.js";
import { visibleWidth } from "../src/ui/text.js";

const help = findManifestCommand("slash", "help")!;
const rows: CommandManifestEntry[] = [
  { ...help, name: "alpha", aliases: ["a"], args: "<text>", summary: "first action" },
  { ...help, name: "alpine", aliases: ["alp"], summary: "second action" },
  { ...help, name: "hidden", hidden: true },
  { ...help, name: "managed", sessionScope: "managed-agent" },
  { ...help, name: "absent", availability: { state: "unavailable", capabilityRequirements: [] } },
];

test("leading command token only; aliases collapse into canonical visible scoped rows", () => {
  assert.deepEqual(slashPickerMatches("/alp", rows).map(row => row.name), ["alpha", "alpine"]);
  assert.deepEqual(slashPickerMatches("/a", rows).map(row => row.name), ["absent", "alpha", "alpine"]);
  assert.deepEqual(slashPickerMatches("/m", rows), []);
  assert.equal(slashDraft("prose /alpha"), null);
  assert.equal(slashDraft("/alpha\nmore"), null);
  assert.equal(commandInvocationStatus(rows[3]!, "coding"), "unsupported");
  assert.equal(commandInvocationStatus(rows[4]!, "coding"), "unsupported");
  assert.equal(commandInvocationStatus(help, "coding"), "supported");
});

test("zero, one and many matches render within width and height", () => {
  const many = openSlashPicker("/a", "", 0, rows)!;
  const lines = renderSlashPicker(many, "/a", 22, 5, rows);
  assert.equal(lines.length, 3);
  assert.ok(lines.every(line => visibleWidth(line) <= 21));
  assert.match(lines.join("\n"), /\/absent/);
  assert.match(renderSlashPicker(many, "/a", 80, 8, rows).join("\n"), /\[unsupported\]/,
    "known static availability is shown when it fits");
  assert.match(renderSlashPicker(many, "/al", 80, 8, rows).join("\n"), /\[supported\]/);
  const narrow = renderSlashPicker(many, "/a", 9, 3, rows);
  assert.equal(narrow.length, 1);
  assert.ok(visibleWidth(narrow[0]!) <= 8);
  assert.deepEqual(renderSlashPicker(many, "/a", 9, 2, rows), []);
  assert.match(renderSlashPicker(many, "/none", 40, 8, rows)[0]!, /No matching commands/);
  const one = openSlashPicker("/alpi", "", 0, rows)!;
  assert.match(renderSlashPicker(one, "/alpi", 80, 24, rows)[0]!, /alpine.*second action/);
  const longArgs = [{ ...help, args: "<extremely-long-argument-name-and-more>", summary: "short description" }];
  const longState = openSlashPicker("/help", "", 0, longArgs)!;
  assert.match(renderSlashPicker(longState, "/help", 60, 8, longArgs)[0]!, /help.*extremely.*short description/);
});

test("selection cycles, refreshes after edits, and accepts only editable text", () => {
  let state = openSlashPicker("/alp", "before", 3, rows)!;
  assert.equal(state.selectedName, "alpha");
  state = moveSlashPicker(state, "/alp", 1, rows);
  assert.equal(state.selectedName, "alpine");
  state = moveSlashPicker(state, "/alp", 1, rows);
  assert.equal(state.selectedName, "alpha");
  state = refreshSlashPicker(state, "/alpi", rows)!;
  assert.equal(state.selectedName, "alpine");
  assert.deepEqual(acceptSlashPicker(state, "/alpi", 5, rows), { value: "/alpine ", cursor: 8 });
  assert.equal(state.priorValue, "before");
  assert.equal(state.priorCursor, 3);
});

test("acceptance preserves argument suffix and caret position", () => {
  const state = openSlashPicker("/alp --flag value", "/alp --flag value", 11, rows)!;
  assert.deepEqual(acceptSlashPicker(state, "/alp --flag value", 11, rows), {
    value: "/alpha --flag value", cursor: 13,
  });
  assert.deepEqual(acceptSlashPicker(state, "/alp --flag value", 2, rows), {
    value: "/alpha --flag value", cursor: 6,
  });
});

test("real manifest is the sole source and hides out-of-scope entries", () => {
  const matches = slashPickerMatches("/", COMMAND_MANIFEST);
  assert.ok(matches.length > 20);
  assert.ok(matches.every(entry => !entry.hidden && !entry.sessionScope));
  assert.ok(matches.some(entry => entry.name === "help"));
  assert.ok(!matches.some(entry => entry.name === "browser"));
});
