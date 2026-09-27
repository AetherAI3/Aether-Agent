import { commandNames, findRegisteredCommand, renderRegistryHelp, suggestRegisteredCommand, validateCommandRegistry, type CommandSpec } from "../core/command_registry.js";
import {
  findDispatchedCommand,
  mergeFlagTables,
  validateDispatchTable,
  type DispatchedCommand,
  type FlagTable,
} from "../core/command_dispatch.js";
import { COMMAND_MANIFEST_SOURCE } from "./command_manifest_data.js";

const shellManifest = COMMAND_MANIFEST_SOURCE.filter((entry) => entry.surface === "shell");
function commandSpec(entry: (typeof shellManifest)[number]): CommandSpec {
  return {
    name: entry.name,
    ...(entry.aliases.length ? { aliases: [...entry.aliases] } : {}),
    ...(entry.args === undefined ? {} : { args: entry.args }),
    summary: entry.summary,
    section: entry.section,
    ...(entry.hidden ? { hidden: true } : {}),
  };
}
export const CLI_SECTIONS = [...new Set(shellManifest.map((entry) => entry.section))];
/**
 * Global flags — owned by main.ts's argv parse, readable by every command.
 * Declared here so the dispatch table can be validated against them at load
 * time: a command that shadows a global is a startup error, not a surprise.
 */
export const GLOBAL_FLAGS: FlagTable = {
  model: { type: "string" },
  agent: { type: "string" },
  cwd: { type: "string" },
  token: { type: "string" },
  username: { type: "string" },
  password: { type: "string" },
  "license-key": { type: "string" },
  "with-token": { type: "boolean", default: false },
  "no-browser": { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  audit: { type: "boolean", default: false },
  yes: { type: "boolean", short: "y", default: false },
  apply: { type: "boolean", default: false },
  // `--undo` and `--no-select` were undeclared until #98's assertion surfaced
  // them, and the bug was real: `aether sessions archive <id> --undo` archived
  // instead of un-archiving and reported success, and `--no-select` — the
  // documented escape hatch out of the TTY picker — never reached the command,
  // leaving a scripted caller on a TTY with no way out of it. They are declared
  // as `sessions`' OWN flags in the dispatch table below rather than here:
  // nothing else answers to either spelling, so making them global would hand
  // every command a flag that means nothing to it.
  // `aether skills` / `aether capabilities` flags:
  scope: { type: "string" },
  all: { type: "boolean", default: false },
  ci: { type: "boolean", default: false },
  available: { type: "boolean", default: false },
  junit: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
  // `aether agent` flags:
  local: { type: "boolean", default: false },
  pool: { type: "string" },
  effort: { type: "string" },
  "test-cmd": { type: "string" },
  quiet: { type: "boolean", default: false },
  interactive: { type: "boolean", default: false },
  "no-log": { type: "boolean", default: false },
  worktree: { type: "boolean", default: false },
  repo: { type: "string" },
  // Accepted only so existing experimental callers receive code.ts's explicit
  // refusal. It is intentionally absent from normal help and generated docs.
  swarm: { type: "string" },
  resume: { type: "string" },
  out: { type: "string" },
  // Skills in a run — `aether agent`, `aether chat`, and the REPL all open the
  // same run session (core/skills/run_session.ts), so these are global rather
  // than owned by one command.
  skill: { type: "string" },
  "no-skills": { type: "boolean", default: false },
};

/**
 * Runtime registry: executable loaders only. Names bind these functions to
 * the versioned public manifest; help, flags, permissions and release metadata
 * never originate here.
 *
 * `doctor` lives here rather than in the switch because the seam has to be
 * load-bearing in production to be trustworthy: an empty table would make the
 * reachability tests vacuously true.
 */
export const SHELL_RUNTIME_HANDLERS: Array<Pick<DispatchedCommand, "name" | "load">> = [
  {
    name: "exec",
    load: async () => {
      const { cmdExec } = await import("./exec.js");
      return (ctx, argv, flags) => cmdExec(ctx, argv, flags);
    },
  },
  {
    name: "setup",
    load: async () => {
      const { cmdSetup } = await import("./local.js");
      return (ctx, argv, flags) => cmdSetup(ctx, argv, flags);
    },
  },
  {
    name: "local",
    load: async () => {
      const { cmdLocal } = await import("./local.js");
      return (ctx, argv, flags) => cmdLocal(ctx, argv, flags);
    },
  },
  {
    name: "preview",
    load: async () => {
      const { cmdPreview, previewOptionsFromFlags } = await import("./preview.js");
      return (ctx, argv, flags) => cmdPreview(ctx, argv, previewOptionsFromFlags(flags));
    },
  },
  {
    // Lane SC-DEVICE-01. Hidden (dev-only, default-off) but a real dispatch-table
    // entry so `aether device …` runs the command group instead of billing a
    // chat turn. It owns no flags — subcommands are positionals and it reads only
    // the global --json / --yes off ctx.flags.
    name: "device",
    load: async () => {
      const { cmdDevice } = await import("./device.js");
      return (ctx, argv, flags) => cmdDevice(ctx, argv, flags);
    },
  },
  {
    name: "doctor",
    // doctor parses its own argv (parseDoctorArgs). It never saw these flags:
    // main.ts's parse is strict:false, so an undeclared `--live` was captured
    // into `values` and stripped from the positionals doctor was handed — the
    // live end-to-end proof silently ran as the fast configured-only report,
    // and `--only <id>` arrived as a bare positional and failed as unknown.
    // Declaring them here is what makes them reach the command at all.
    load: async () => {
      const { cmdDoctor } = await import("./doctor.js");
      // Parsed values are handed over as data. Nothing is re-rendered into an
      // argv string for doctor to re-parse, so a `--only` value that looks
      // like an option ("--fix") stays a value: there is no second parse for
      // it to be promoted by, and no shell anywhere on the path.
      return (ctx, argv, flags) =>
        cmdDoctor(ctx, argv, {
          flags: {
            deep: flags.bool("deep"),
            live: flags.bool("live"),
            fix: flags.bool("fix"),
            dryRun: flags.bool("dry-run"),
            noUi: flags.bool("no-ui"),
            // --yes is global, so doctor's own parse never saw it either:
            // `--fix --yes` printed "re-run with --yes" to a user who had
            // just passed it.
            yes: ctx.flags.yes,
            only: flags.list("only"),
          },
        });
    },
  },
  {
    // Lane AA-CONT-04. The session library was wired through main.ts's switch
    // before this seam existed; it belongs here, where the name, the help text,
    // the flags and the handler are one entry. `--all`, `--undo` and
    // `--no-select` were exactly the "captured into values and stripped from
    // the positionals" case this table was built to end: the command's own
    // parser never saw them, so `aether sessions --all` silently listed one
    // project.
    name: "sessions",
    // `--all` and `--out` are GLOBAL: other commands already own those
    // spellings, so the table cannot hand either to this one, and a command
    // that shadowed a global would silently change what it means everywhere.
    // They arrive on ctx.flags instead; only what is genuinely this command's
    // is declared here.
    load: async () => {
      const { cmdSessions } = await import("./sessions.js");
      // Parsed values are handed over as DATA — never re-rendered into an argv
      // for the command to parse a second time. `argv` here carries only the
      // positionals the host already separated out, so nothing the user typed
      // can be promoted into a flag by a second pass.
      return (ctx, argv, flags) =>
        cmdSessions(
          ctx,
          argv,
          {},
          {
            all: Boolean(ctx.flags.all),
            undo: flags.bool("undo"),
            noSelect: flags.bool("no-select"),
            ...(ctx.flags.out ? { out: ctx.flags.out } : {}),
          },
        );
    },
  },
  // `aether review` / `aether ship`.
  //
  // These flags MUST be declared. main.ts parses with `strict: false`, which
  // swallows any undeclared flag into `values` and strips it from the
  // positionals a command receives — so an undeclared `--files a,b` does not
  // reach the command as an argument and does not reach it as a flag either.
  // It simply vanishes, and the command reports success having done nothing.
  // Every flag the review/ship layer reads is declared below for that reason,
  // and test/review_flags.test.ts proves each one arrives.
  //
  // `--test-cmd`, `--all`, `--yes` and `--json` are globals, so they are NOT
  // redeclared here (a command that shadows a global is a registry load error)
  // and are read off ctx.flags instead, the way doctor reads `--yes`.
  {
    name: "review",
    load: async () => {
      const { cmdReview } = await import("./review.js");
      // Parsed values are handed over as data — named properties, never
      // re-rendered into an argv string for a second parse to promote a value
      // like `--title=--fix` into a flag nobody typed.
      return (ctx, argv, flags) =>
        cmdReview(ctx, argv, {
          files: flags.str("files"),
          hunks: flags.str("hunks"),
          message: flags.str("message"),
          base: flags.str("base"),
          testCmd: ctx.flags.testCmd,
          approve: flags.str("approve"),
          all: Boolean(ctx.flags.all),
          yes: ctx.flags.yes,
          json: ctx.flags.json,
        });
    },
  },
  {
    name: "ship",
    load: async () => {
      const { cmdShip } = await import("./ship.js");
      return (ctx, argv, flags) =>
        cmdShip(ctx, argv, {
          title: flags.str("title"),
          body: flags.str("body"),
          base: flags.str("base"),
          approve: flags.str("approve"),
          yes: ctx.flags.yes,
          json: ctx.flags.json,
        });
    },
  },
];

const handlers = new Map(SHELL_RUNTIME_HANDLERS.map((handler) => [handler.name, handler.load]));
const lazyManifest = shellManifest.filter((entry) => entry.handler.kind === "lazy");
const orphanHandlers = SHELL_RUNTIME_HANDLERS.filter((handler) =>
  !lazyManifest.some((entry) => entry.name === handler.name));
if (orphanHandlers.length) throw new Error(`Runtime handlers missing from command manifest: ${orphanHandlers.map((item) => item.name).join(", ")}`);

/** Compatibility projection consumed by the parser/dispatcher. Public fields come only from the manifest. */
export const DISPATCH_COMMANDS: DispatchedCommand[] = lazyManifest.map((entry) => {
  const load = handlers.get(entry.name);
  if (!load) throw new Error(`Command manifest has no runtime handler for shell:${entry.name}`);
  return {
    ...commandSpec(entry),
    flags: Object.fromEntries(Object.entries(entry.ownedFlags).map(([name, spec]) => [name, { ...spec }])),
    load,
  };
});
export const CLI_COMMANDS: CommandSpec[] = shellManifest.filter((entry) => entry.handler.kind === "host").map(commandSpec);

/** Everything the CLI answers to, projected in manifest order. */
export const ALL_CLI_COMMANDS: readonly CommandSpec[] = shellManifest.map(commandSpec);

const registryErrors = [
  ...validateCommandRegistry(ALL_CLI_COMMANDS, CLI_SECTIONS),
  ...validateDispatchTable(DISPATCH_COMMANDS, GLOBAL_FLAGS, CLI_SECTIONS),
];
if (registryErrors.length) throw new Error(`Invalid CLI registry: ${registryErrors.join("; ")}`);

/** The single `parseArgs` options object: globals plus every command's flags. */
export const CLI_PARSE_OPTIONS = mergeFlagTables(GLOBAL_FLAGS, DISPATCH_COMMANDS);

export const findDispatchedCliCommand = (name: string): DispatchedCommand | undefined =>
  findDispatchedCommand(DISPATCH_COMMANDS, name);

export const findCliCommand = (name: string): CommandSpec | undefined => findRegisteredCommand(ALL_CLI_COMMANDS, name);
export const suggestCliCommand = (name: string): string | null => suggestRegisteredCommand(name, commandNames(ALL_CLI_COMMANDS));

export function renderCliHelp(target?: string): string {
  return renderRegistryHelp({
    title: "Aether Agent - local-first coding agent",
    intro: "Authenticated turns use the Aether cloud brain; signed-out turns use local Ollama.",
    usage: ["aether", 'aether "<prompt>"', "aether help [command]", "aether <command> --help"],
    prefix: "aether ",
    commands: ALL_CLI_COMMANDS,
    sections: CLI_SECTIONS,
    target,
    footer: [
      "Global flags: --model <id> --agent <id> --cwd <dir> --json --audit -y/--yes -h/--help -v/--version",
      "First run: aether auth login -> aether auth status -> aether models",
      'Hosted task: aether agent "explain this repository"',
      "Local setup: aether setup --local",
      "Unknown command text remains a bare prompt.",
    ],
  });
}
