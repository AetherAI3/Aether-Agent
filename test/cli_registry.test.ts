import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandNames } from "../src/core/command_registry.js";
import { ALL_CLI_COMMANDS, CLI_COMMANDS, CLI_PARSE_OPTIONS, CLI_SECTIONS, DISPATCH_COMMANDS, findCliCommand, findDispatchedCliCommand, renderCliHelp } from "../src/commands/cli_registry.js";

const here = dirname(fileURLToPath(import.meta.url));

test("every CLI name and alias has detail help", () => {
  for (const name of commandNames(ALL_CLI_COMMANDS)) {
    assert.ok(findCliCommand(name), name);
    assert.match(renderCliHelp(name), /^Usage: aether /);
  }
});

test("CLI names are unique and sections are declared", () => {
  assert.equal(new Set(commandNames(ALL_CLI_COMMANDS)).size, commandNames(ALL_CLI_COMMANDS).length);
  for (const command of ALL_CLI_COMMANDS) assert.ok((CLI_SECTIONS as readonly string[]).includes(command.section));
});

test("every registered command is reachable, by exactly one mechanism", () => {
  const source = readFileSync(join(here, "..", "..", "src", "main.ts"), "utf8");
  const cases = [...source.matchAll(/^    case "([a-z0-9-]+)":/gm)].map((match) => match[1]!);
  const registered = new Set(commandNames(ALL_CLI_COMMANDS));
  assert.deepEqual(cases.filter((name) => !registered.has(name)), []);

  // Totality, in the direction that costs money. An unreachable registry name
  // does not error — main.ts falls through to cmdChat, so `aether sessions`
  // with a missed wiring becomes a billed chat turn about the word "sessions".
  // Two mechanisms answer for reachability now: the switch, and the dispatch
  // table. "help" is the one legitimate exception — main.ts serves it before
  // either, so it never appears as `case "help":`.
  const dispatched = new Set(commandNames(DISPATCH_COMMANDS));
  const caseSet = new Set(cases);
  const unreachable = commandNames(ALL_CLI_COMMANDS).filter(
    (name) => name !== "help" && !caseSet.has(name) && !dispatched.has(name),
  );
  assert.deepEqual(unreachable, []);

  // And exactly one mechanism: a name wired both ways is a silent precedence
  // question (the table runs first), so it is a registry error, not a style one.
  const doubleWired = [...dispatched].filter((name) => caseSet.has(name));
  assert.deepEqual(doubleWired, []);

  // Guard against the guard going vacuous: the table has to be carrying real
  // production traffic for any of the above to mean anything.
  assert.ok(DISPATCH_COMMANDS.length > 0, "dispatch table is empty");
  assert.ok(CLI_COMMANDS.length > 0, "switch registry is empty");
});

test("every flag main.ts reads is a flag the parser was told about", () => {
  // Keep every flag main.ts reads in the shared parser table. Unknown options
  // now fail before dispatch; a missing declaration must not turn a valid flag
  // into an unknown one. Written against source because `values` is local to main().
  const source = readFileSync(join(here, "..", "..", "src", "main.ts"), "utf8");
  const read = new Set([...source.matchAll(/values\["([a-z0-9-]+)"\]/g)].map((match) => match[1]!));
  assert.ok(read.size > 10, "flag-read scan found almost nothing — the pattern has drifted");
  const undeclared = [...read].filter((name) => !(name in CLI_PARSE_OPTIONS)).sort();
  assert.deepEqual(undeclared, []);
});

test("the table's casing rule is the switch's casing rule", () => {
  // The one behaviour a migration must not change: `DOCTOR` was never a
  // command and must not become one just because doctor moved into the table.
  for (const command of DISPATCH_COMMANDS) {
    assert.equal(findDispatchedCliCommand(command.name)?.name, command.name);
    assert.equal(findDispatchedCliCommand(command.name.toUpperCase()), undefined, command.name);
  }
});

test("every dispatch entry can actually be loaded and run", async () => {
  for (const command of DISPATCH_COMMANDS) {
    const handler = await command.load();
    assert.equal(typeof handler, "function", command.name);
  }
});

test("grouped help includes every visible canonical command", () => {
  const help = renderCliHelp();
  assert.equal(help.includes("aether login"), false);
  assert.equal(help.includes("aether logout"), false);
  for (const command of ALL_CLI_COMMANDS.filter((entry) => !entry.hidden)) {
    assert.ok(help.includes(`aether ${command.name}`), command.name);
  }
});
