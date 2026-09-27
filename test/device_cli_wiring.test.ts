// Registering a command in this CLI takes coordinated artifacts, and the
// failure mode when they drift is expensive rather than loud: an entry that is
// described but not dispatched falls through to `cmdChat`, so `aether device
// status` becomes a BILLED chat turn about the words "device status".
//
// The repo's generic guard suites already prove the table is internally
// consistent. What they cannot prove is that THIS lane's entry is present and
// wired to the device handler, which is what this file asserts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMAND_MANIFEST_SOURCE } from "../src/commands/command_manifest_data.js";
import {
  ALL_CLI_COMMANDS,
  CLI_PARSE_OPTIONS,
  DISPATCH_COMMANDS,
  SHELL_RUNTIME_HANDLERS,
  findDispatchedCliCommand,
} from "../src/commands/cli_registry.js";
import { DEVICE_EXIT } from "../src/commands/device.js";

test("the manifest carries the shell:device entry with its lane metadata", () => {
  const entry = COMMAND_MANIFEST_SOURCE.find((e) => e.key === "shell:device");
  assert.ok(entry, "shell:device must exist in the versioned manifest");
  assert.equal(entry.surface, "shell");
  assert.equal(entry.name, "device");
  assert.equal(entry.section, "Account");
  assert.equal(entry.permissionClass, "account");
  assert.equal(entry.telemetryName, "shell.device");
  // Dev-only and default-off, so it stays out of the public command list.
  assert.equal(entry.hidden, true);
  assert.equal(entry.docs.visible, false);
  assert.equal(entry.handler.kind, "lazy");
});

test("`device` dispatches to the device handler rather than falling through to chat", () => {
  const found = findDispatchedCliCommand("device");
  assert.ok(found, "`aether device` must resolve to a dispatched command");
  assert.equal(found.name, "device");
  assert.equal(typeof found.load, "function");

  // The lazy handler must be registered, or the manifest entry would describe a
  // command nothing runs.
  const handler = SHELL_RUNTIME_HANDLERS.find((h) => h.name === "device");
  assert.ok(handler, "SHELL_RUNTIME_HANDLERS must carry a `device` loader");
  assert.ok(DISPATCH_COMMANDS.some((c) => c.name === "device"));
});

test("the lazy loader actually resolves to a callable handler", async () => {
  const found = findDispatchedCliCommand("device");
  assert.ok(found);
  const handler = await found.load();
  assert.equal(typeof handler, "function");
  // Three parameters: (ctx, argv, flags) — the dispatch contract.
  assert.equal(handler.length, 3);
});

test("the device entry declares every owned flag, so none is swallowed", () => {
  const entry = COMMAND_MANIFEST_SOURCE.find((e) => e.key === "shell:device");
  assert.ok(entry);
  // Subcommands are positionals, and the only non-global the group reads is
  // --base-url (enroll has to be told which Cloud to enroll against). An
  // UNDECLARED owned flag is silently swallowed by the strict:false parser, so
  // the declaration has to be exact — not merely non-empty.
  assert.deepEqual(Object.keys(entry.ownedFlags ?? {}).sort(), ["base-url"]);
  assert.equal((entry.ownedFlags ?? {})["base-url"]?.type, "string");
  // Being declared is what puts it in the merged parse table; without that the
  // strict:false parser would drop `--base-url https://...` on the floor and
  // enroll would silently target the wrong Cloud.
  assert.ok(Object.hasOwn(CLI_PARSE_OPTIONS, "base-url"));
  // It is owned, not borrowed: claiming it as a global too would change how
  // that global parses for every other command.
  assert.ok(!(entry.acceptedGlobalFlags ?? []).includes("base-url"));
  // The globals it does read must exist in the merged parse table.
  assert.ok(Object.hasOwn(CLI_PARSE_OPTIONS, "json"));
  assert.ok(Object.hasOwn(CLI_PARSE_OPTIONS, "yes"));
});

test("the device command name does not collide with an existing command or alias", () => {
  const claims = ALL_CLI_COMMANDS.filter((c) => c.name === "device" || c.aliases?.includes("device"));
  assert.equal(claims.length, 1, `"device" is claimed ${claims.length} times`);
  assert.equal(claims[0]!.name, "device");
});

test("exit codes are distinct so a caller can tell the refusals apart", () => {
  // `install-service` writes a scheduled task and `start` launches a persistent
  // process, so a script driving these needs to distinguish "you have not opted
  // in" from "you are not enrolled" from "it failed".
  const codes = Object.values(DEVICE_EXIT);
  assert.equal(new Set(codes).size, codes.length, "device exit codes must be unique");
  assert.equal(DEVICE_EXIT.ok, 0);
  assert.notEqual(DEVICE_EXIT.disabled, DEVICE_EXIT.notEnrolled);
  assert.notEqual(DEVICE_EXIT.declined, DEVICE_EXIT.failed);
});
