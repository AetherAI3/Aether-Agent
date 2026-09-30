// Every flag the review/ship layer reads must ARRIVE.
//
// main.ts rejects undeclared flags. These tests pin the declarations and value
// types for the review/ship flags so valid invocations reach their handlers.
//
// These tests assert the PARSED ARGV — what parseArgs produces from the very
// options object main.ts hands it — not any rendered output. A test that
// checked printed text would pass against a command that received nothing and
// printed an optimistic line about it.
//
// The options object is IMPORTED, not scraped out of main.ts's source. Since
// the command-registration seam there is no options literal in main.ts to
// scrape: `CLI_PARSE_OPTIONS` is assembled in cli_registry.ts from the globals
// plus each dispatch-table command's own `flags`. Importing it means this test
// exercises the same table production parses with, so it cannot pass against a
// table that was never wired up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import {
  CLI_PARSE_OPTIONS,
  DISPATCH_COMMANDS,
  GLOBAL_FLAGS,
  findDispatchedCliCommand,
} from "../src/commands/cli_registry.js";
import { commandFlags } from "../src/core/command_dispatch.js";

/** Flags review/ship own, and the globals they read off the context. */
const REVIEW_SHIP_OWNED = ["files", "hunks", "message", "approve", "title", "body", "base"];
const REVIEW_SHIP_GLOBALS = ["all", "yes", "json", "test-cmd"];

test("review and ship dispatch from the registry table, not from main.ts's switch", () => {
  for (const name of ["review", "ship"]) {
    const command = findDispatchedCliCommand(name);
    assert.ok(command, `${name} is not in DISPATCH_COMMANDS`);
    assert.equal(typeof command.load, "function", `${name} has no loader`);
  }
});

test("every review/ship flag is declared on its command, and reaches the one parse table", () => {
  for (const name of ["review", "ship"]) {
    const command = findDispatchedCliCommand(name)!;
    for (const flag of REVIEW_SHIP_OWNED) {
      assert.ok(command.flags?.[flag], `${name} does not declare --${flag}`);
      assert.ok(CLI_PARSE_OPTIONS[flag], `--${flag} never reached the merged parseArgs table`);
    }
  }
});

test("the globals review/ship read stay globals — a command may not shadow one", () => {
  for (const flag of REVIEW_SHIP_GLOBALS) {
    assert.ok(GLOBAL_FLAGS[flag], `--${flag} is expected to be a global`);
    for (const command of DISPATCH_COMMANDS) {
      assert.equal(
        command.flags?.[flag],
        undefined,
        `${command.name} shadows the global --${flag}; that is a registry load error`,
      );
    }
  }
});

test("each declared review flag survives parseArgs with its value intact", () => {
  const argv = [
    "review",
    "stage",
    "--files",
    "src/a.ts,src/b.ts",
    "--hunks",
    "1,3",
    "--message",
    "fix: a thing",
    "--approve",
    "destructive",
    "--base",
    "main",
    "--test-cmd",
    "npm test",
    "--all",
    "--yes",
  ];
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: CLI_PARSE_OPTIONS,
  });

  assert.equal(values["files"], "src/a.ts,src/b.ts");
  assert.equal(values["hunks"], "1,3");
  assert.equal(values["message"], "fix: a thing");
  assert.equal(values["approve"], "destructive");
  assert.equal(values["base"], "main");
  assert.equal(values["test-cmd"], "npm test");
  assert.equal(values["all"], true);
  assert.equal(values["yes"], true);
  // The subcommand must still be a positional. A flag that eats its value from
  // the positional stream is exactly how `review stage` becomes `review`.
  assert.deepEqual(positionals, ["review", "stage"]);
});

test("each declared ship flag survives parseArgs with its value intact", () => {
  const body = "line one\nline two";
  const { values, positionals } = parseArgs({
    args: ["ship", "--title", "feat: the rail", "--body", body, "--base", "main", "--approve", "publish"],
    allowPositionals: true,
    strict: true,
    options: CLI_PARSE_OPTIONS,
  });
  assert.equal(values["title"], "feat: the rail");
  assert.equal(values["body"], body, "a multi-line body arrives whole");
  assert.equal(values["base"], "main");
  assert.equal(values["approve"], "publish");
  assert.deepEqual(positionals, ["ship"]);
});

test("-m is the short form of --message and carries its value", () => {
  const { values } = parseArgs({
    args: ["review", "commit", "-m", "fix: short form"],
    allowPositionals: true,
    strict: true,
    options: CLI_PARSE_OPTIONS,
  });
  assert.equal(values["message"], "fix: short form");
});

test("the parsed values reach the command through its own flags accessor", () => {
  // The accessor is bound to what the command DECLARED, so this is the same
  // read path production takes — and reading a flag the command does not own
  // throws rather than returning undefined, which is what keeps a silent
  // mis-wiring from looking like a legitimately-absent flag.
  const review = findDispatchedCliCommand("review")!;
  const { values } = parseArgs({
    args: ["review", "stage", "--files", "src/a.ts", "--message", "fix: a thing"],
    allowPositionals: true,
    strict: true,
    options: CLI_PARSE_OPTIONS,
  });
  const flags = commandFlags(review, values as Record<string, unknown>);
  assert.equal(flags.str("files"), "src/a.ts");
  assert.equal(flags.str("message"), "fix: a thing");
  // A global is deliberately NOT readable through the command accessor — it
  // arrives on ctx.flags instead. Reading it here must be a loud failure.
  assert.throws(() => flags.str("test-cmd"), /did not declare flag --test-cmd/);
});

test("an undeclared flag is rejected before review can run", () => {
  // The declarations above are load-bearing. A missing one now fails closed.
  const options = { ...CLI_PARSE_OPTIONS };
  delete (options as Record<string, unknown>)["files"];
  assert.throws(
    () => parseArgs({
      args: ["review", "stage", "--files", "src/a.ts"],
      allowPositionals: true,
      strict: true,
      options,
    }),
    /Unknown option '--files'/,
  );
});

test("dispatch stays case-sensitive — `aether SHIP` is not a command", () => {
  // A case-insensitive lookup is not a kindness here: the typo guard only fires
  // on /^[a-z][a-z-]*$/, so an uppercase word that matched no case-folded
  // command falls through to cmdChat and BILLS A TURN. Half the uppercase
  // spellings would run the command and half would charge for a model call.
  for (const name of ["review", "ship"]) {
    assert.ok(findDispatchedCliCommand(name), `${name} must dispatch as typed`);
    assert.equal(findDispatchedCliCommand(name.toUpperCase()), undefined, `${name} must not answer in another casing`);
  }
});
