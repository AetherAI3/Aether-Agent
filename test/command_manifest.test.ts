import { test } from "node:test";
import assert from "node:assert/strict";
import { commandNames, type CommandSpec } from "../src/core/command_registry.js";
import type { FlagTable } from "../src/core/command_dispatch.js";
import { ALL_CLI_COMMANDS, DISPATCH_COMMANDS, GLOBAL_FLAGS, SHELL_RUNTIME_HANDLERS } from "../src/commands/cli_registry.js";
import { SLASH_COMMANDS, findCommand as findSlashCommand } from "../src/commands/slash_registry.js";
import {
  COMMAND_MANIFEST, COMMAND_MANIFEST_SCHEMA, COMMAND_PARSE_OPTIONS, COMMAND_RUNTIME_LOADERS, completeManifestSlash,
  createCommandManifest, findManifestCommand, manifestCommandNames, projectLegacyCommandSpecs,
  renderManifestHelp, suggestManifestCommand, validateCommandManifest, validateRuntimeHandlerBindings, type CommandManifestEntry,
} from "../src/commands/command_manifest.js";

test("adapter preserves registries and additive old-client projections", () => {
  const oldShell: CommandSpec[] = ALL_CLI_COMMANDS.map((command) => ({
    name: command.name,
    ...(command.aliases?.length ? { aliases: [...command.aliases] } : {}),
    ...(command.args === undefined ? {} : { args: command.args }),
    summary: command.summary,
    section: command.section,
    ...(command.hidden ? { hidden: true } : {}),
  }));
  assert.deepEqual(projectLegacyCommandSpecs("shell"), oldShell);
  assert.deepEqual(projectLegacyCommandSpecs("slash"), SLASH_COMMANDS);
  assert.deepEqual(manifestCommandNames("shell"), commandNames(ALL_CLI_COMMANDS));
  assert.deepEqual(manifestCommandNames("slash"), commandNames(SLASH_COMMANDS));
  const enriched = COMMAND_MANIFEST.map((entry) => ({
    ...entry, detailedHelp: `richer: ${entry.detailedHelp}`, permissionClass: "read-only" as const,
    release: { disposition: "changed" as const, note: "metadata only" },
  }));
  assert.deepEqual(projectLegacyCommandSpecs("shell", enriched), oldShell);
  assert.deepEqual(projectLegacyCommandSpecs("slash", enriched), SLASH_COMMANDS);
});

test("shell lookup is exact-case while slash lookup retains compatibility", () => {
  assert.equal(findManifestCommand("shell", "agent")?.name, "agent");
  assert.equal(findManifestCommand("shell", "code")?.name, "agent");
  assert.equal(findManifestCommand("shell", "AGENT"), undefined);
  assert.equal(findManifestCommand("shell", "CODE"), undefined);
  assert.equal(findManifestCommand("slash", "/QUIT")?.name, findSlashCommand("QUIT")?.name);
  assert.equal(findManifestCommand("slash", " help ")?.name, "help");
});

test("public manifest is JSON-safe and runtime loaders stay separate", () => {
  assert.doesNotThrow(() => structuredClone(COMMAND_MANIFEST));
  const json = JSON.stringify(COMMAND_MANIFEST);
  assert.equal(json.includes('"load"'), false);
  assert.deepEqual(JSON.parse(json), COMMAND_MANIFEST);
  for (const command of DISPATCH_COMMANDS) {
    const entry = findManifestCommand("shell", command.name)!;
    assert.equal(entry.handler.kind, "lazy");
    assert.equal(COMMAND_RUNTIME_LOADERS.get(entry.key), command.load);
    assert.deepEqual(entry.ownedFlags, command.flags ?? {});
  }
  assert.ok(findManifestCommand("shell", "agent")?.acceptedGlobalFlags.includes("local"));
  assert.deepEqual(COMMAND_PARSE_OPTIONS["local"], GLOBAL_FLAGS["local"]);
});

const shellFixture: CommandSpec[] = [
  { name: "alpha", aliases: ["a"], args: "<x>", summary: "first", section: "One" },
  { name: "beta", summary: "second", section: "One" },
];
const unclassifiedFixture = (): readonly CommandManifestEntry[] => createCommandManifest({ shell: shellFixture, slash: [] });
const fixture = (): readonly CommandManifestEntry[] => unclassifiedFixture().map((entry) => ({
  ...entry, release: { disposition: "existing" as const, note: null },
}));

test("validator detects aliases and surface/name collisions but permits cross-surface names", () => {
  const base = fixture();
  const duplicate: CommandManifestEntry = { ...base[0]!, aliases: ["a", "a"], compatibilityAliases: ["a", "a"] };
  const errors = validateCommandManifest([duplicate]);
  assert.ok(errors.includes("shell:alpha: duplicate alias 'a'"));
  assert.ok(errors.includes("shell:alpha: token 'a' collides with shell:alpha"));
  const collision: CommandManifestEntry = { ...base[1]!, aliases: ["a"], compatibilityAliases: ["a"] };
  assert.ok(validateCommandManifest([base[0]!, collision]).includes("shell:beta: token 'a' collides with shell:alpha"));
  assert.ok(validateCommandManifest([base[0]!, { ...base[0]! }]).includes("shell:alpha: duplicate surface/name key"));
  const crossSurface = createCommandManifest({ shell: [shellFixture[0]!], slash: [shellFixture[0]!] })
    .map((entry) => ({ ...entry, release: { disposition: "existing" as const, note: null } }));
  assert.deepEqual(validateCommandManifest(crossSurface), []);
});

test("validator rejects nonexistent handler and docs ownership", () => {
  const base = fixture()[0]!;
  const handler = { ...base, handler: { ...base.handler, module: "src/commands/does_not_exist.ts" } };
  assert.deepEqual(validateCommandManifest([handler]), [
    "shell:alpha: unknown handler owner 'host:src/commands/does_not_exist.ts#main'",
  ]);
  const docs = { ...base, docs: { ...base.docs, module: "src/commands/does_not_exist.ts" } };
  assert.deepEqual(validateCommandManifest([docs]), [
    "shell:alpha: unknown docs owner 'src/commands/does_not_exist.ts#COMMAND_MANIFEST_SOURCE'",
  ]);
});

test("the versioned manifest is authoritative and runtime registries contain handlers only", () => {
  assert.equal(COMMAND_MANIFEST_SCHEMA, "aether.command-manifest/1");
  assert.ok(SHELL_RUNTIME_HANDLERS.every((handler) => Object.keys(handler).sort().join(",") === "load,name"));
  assert.deepEqual(validateRuntimeHandlerBindings(COMMAND_MANIFEST, COMMAND_RUNTIME_LOADERS.keys()), []);
  assert.match(validateRuntimeHandlerBindings(COMMAND_MANIFEST, ["shell:orphan"]).join("\n"), /orphan runtime handler/);
  assert.match(validateRuntimeHandlerBindings(COMMAND_MANIFEST, [] as const).join("\n"), /manifest handler is missing at runtime/);
});

test("validator detects owned flag collisions, reserved shadows, and malformed specs", () => {
  const [alpha, beta] = fixture();
  const first = { ...alpha!, ownedFlags: { mode: { type: "boolean" as const, short: "m" } } };
  const longConflict = { ...beta!, ownedFlags: { mode: { type: "string" as const, short: "m" } } };
  assert.ok(validateCommandManifest([first, longConflict]).includes("shell:beta: --mode conflicts with shell:alpha"));
  const shortConflict = { ...beta!, ownedFlags: { format: { type: "string" as const, short: "m" } } };
  assert.ok(validateCommandManifest([first, shortConflict]).includes("shell:beta: -m on --format conflicts with shell:alpha's --mode"));
  const reserved: FlagTable = { mode: { type: "boolean" } };
  assert.ok(validateCommandManifest([first], { reservedShellFlags: reserved }).includes("shell:alpha: --mode shadows a reserved flag"));
  const malformed = { ...alpha!, ownedFlags: { count: { type: "boolean", multiple: true } } } as CommandManifestEntry;
  assert.ok(validateCommandManifest([malformed]).includes("shell:alpha: --count cannot be boolean and repeatable"));
});

test("validator detects product, alias, docs, and release metadata drift", () => {
  const base = fixture()[0]!;
  assert.deepEqual(validateCommandManifest([{ ...base, detailedHelp: "" }]), ["shell:alpha: missing detailed help"]);
  assert.deepEqual(validateCommandManifest([{ ...base, telemetryName: "alpha" }]), ["shell:alpha: telemetry name must be 'shell.alpha'"]);
  assert.deepEqual(validateCommandManifest([{ ...base, compatibilityAliases: [] }]), ["shell:alpha: alias 'a' has no compatibility disposition"]);
  assert.deepEqual(
    validateCommandManifest([{ ...base, availability: { ...base.availability, capabilityRequirements: ["Bad Cap"] } }]),
    ["shell:alpha: invalid capability requirement 'Bad Cap'"],
  );
  assert.deepEqual(validateCommandManifest([{ ...base, docs: { ...base.docs, target: "beta" } }]), [
    "shell:alpha: docs target 'beta' does not match command name",
  ]);
  assert.deepEqual(validateCommandManifest([{ ...base, docs: { ...base.docs, disposition: "omitted" } }]), [
    "shell:alpha: visible command is undocumented",
  ]);
  assert.deepEqual(validateCommandManifest([{ ...base, release: { disposition: "existing", note: "" } }]), ["shell:alpha: empty release note"]);
});

test("a synthetic registry command cannot inherit an existing release disposition", () => {
  const [entry] = unclassifiedFixture();
  assert.equal(entry?.release, null);
  assert.deepEqual(validateCommandManifest(unclassifiedFixture()), ["shell:alpha: missing release disposition contract", "shell:beta: missing release disposition contract"]);
});

test("production manifest validates with the real global flag namespace", () => {
  assert.ok(COMMAND_MANIFEST.length > 0);
  assert.deepEqual(validateCommandManifest(COMMAND_MANIFEST, { reservedShellFlags: GLOBAL_FLAGS }), []);
});

test("the executable parser, help, completion, and suggestions project from the manifest", () => {
  assert.match(renderManifestHelp("shell"), /aether agent/);
  assert.match(renderManifestHelp("slash", "model"), /Usage: \/model/);
  assert.equal(completeManifestSlash("/mod").matches.includes("model"), true);
  assert.equal(suggestManifestCommand("shell", "aut", 1), "auth");
  assert.equal(COMMAND_PARSE_OPTIONS["only"]?.multiple, true);
});

test("an invalid additive surface returns errors instead of throwing", () => {
  const invalid = { ...fixture()[0]!, surface: "future" as "shell", key: "shell:alpha" as const };
  assert.doesNotThrow(() => validateCommandManifest([invalid]));
  assert.ok(validateCommandManifest([invalid]).some((error) => error.includes("invalid surface")));
});

test("browser and ATS commands declare managed-agent scope and a visible release disposition", () => {
  for (const name of ["browser", "ats"]) {
    const entry = findManifestCommand("slash", name);
    assert.ok(entry, `/${name} must be registered`);
    assert.equal(entry.sessionScope, "managed-agent");
    assert.ok(entry.availability.capabilityRequirements.includes("aether.hosted"));
    assert.equal(entry.docs.visible, true);
    assert.equal(entry.release?.disposition, "new");
    assert.match(entry.detailedHelp, /aether agent chat/);
  }
});


test("managed-agent command scope cannot be declared on shell commands or without its capability", () => {
  const browser = findManifestCommand("slash", "browser")!;
  assert.match(validateCommandManifest([{ ...browser, availability: { state: "runtime-dependent", capabilityRequirements: [] } }]).join("\n"), /scope requires/);
  const shell = findManifestCommand("shell", "agent")!;
  assert.match(validateCommandManifest([{ ...shell, sessionScope: "managed-agent" }]).join("\n"), /scope requires/);
});
