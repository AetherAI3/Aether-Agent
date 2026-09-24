import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserVisionSkill } from "aether-ats-skills";
import { BROWSER_ORDER_OPERATIONS, GRANT_CAPABILITIES, NORMALIZED_OPERATIONS } from "../src/core/ats_contracts/index.js";
import { ACTION_APPROVALS, READ_ACTIONS } from "../src/core/action_rail.js";
import type { BrainEvent } from "../src/core/brain_protocol.js";
import { TOOLS } from "../src/core/brain_protocol.js";
import { CloudBrain } from "../src/core/brain_cloud.js";
import { ollamaToolSchemas } from "../src/core/brain_ollama.js";
import { COMMAND_CLASSES } from "../src/core/device_runtime/contract.js";
import { HEADLESS_CONTROL_PROTOCOL, parseControlFrame } from "../src/core/headless_protocol.js";
import { VIEWER_CAPABILITIES } from "../src/core/rc/viewer_profile.js";
import { PERMISSIONS, TOOL_PERMISSIONS } from "../src/core/skills/permission_vocabulary.js";
import { ToolExecutor } from "../src/core/tool_executor.js";
import { TOOL_DEFINITIONS } from "../src/core/tool_registry.js";
import type { ApiClient } from "../src/core/transport.js";
import { atsManagedConfig } from "../src/commands/ats_agent.js";
import { ALL_CLI_COMMANDS, CLI_PARSE_OPTIONS } from "../src/commands/cli_registry.js";
import { COMMAND_MANIFEST_SOURCE } from "../src/commands/command_manifest_data.js";
import { EXEC_V1_TOOLS } from "../src/commands/exec.js";
import { MANAGED_AGENT_VERBS } from "../src/commands/managed_agents.js";
import { SLASH_COMMANDS } from "../src/commands/slash_registry.js";
import { AGENT_CAPABILITIES_FALLBACK } from "../src/generated/agent_capabilities.js";

// G0 evidence for the ATS Agent Browser execution spec: this CLI registers,
// advertises and dispatches NO order operation. Orders belong to ATSv2 alone.
//
// Every place the CLI can register, advertise or dispatch something a model,
// Cloud, a device or a person can invoke by name is listed in REGISTRIES and
// read from the real value, the real advertisement, or (for private tables)
// the dispatching source. Each registry names a sentinel it must contain, so
// a read that silently comes back empty or from the wrong place fails rather
// than passing. The CLI hosts no MCP server; a tripwire below forces any
// future one into this list.
//
// Scope: this inventories what THIS CLI registers, advertises and dispatches.
// Tools offered by a user-configured MCP server or by Cloud's MCP broker are
// outside it; the CLI only lists them, and its ToolExecutor refuses any name
// outside TOOLS (proved at runtime below for every order operation).

// --- What counts as an order operation ---------------------------------------------

function tokensOf(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** What makes a connector or grant operation order-bearing, for CONTRACT_ORDER_NAMES. */
const ORDER_BEARING: ReadonlySet<string> = new Set(["order", "orders"]);
/** What an order-shaped name acts on. `broker` covers broker_commit; `all` the bulk forms such as cancel_all. */
const ORDER_NOUNS = ["orders", "order", "trades", "trade", "positions", "position", "tickets", "ticket", "broker", "all"] as const;
/** What acts on an order noun, including order-type qualifiers (limit_order) and review steps (review_order). */
const ORDER_VERBS = [
  "submit", "commit", "place", "cancel", "execute", "confirm", "close", "route", "send", "fill", "open", "amend",
  "modify", "replace", "flatten", "create", "new", "post", "make", "enter", "stage", "queue", "exit", "reduce",
  "cover", "authoriz", "review", "preview", "limit", "market", "stop",
] as const;
const ORDER_NOUN_SET: ReadonlySet<string> = new Set(ORDER_NOUNS);
const ORDER_VERB = new RegExp(`^(?:${ORDER_VERBS.join("|")})`);
/** A verb run into its noun with no separator (placeorder, cancelall), in either order. */
const JOINED = new RegExp(`(?:${ORDER_VERBS.join("|")})(?:${ORDER_NOUNS.join("|")})|(?:${ORDER_NOUNS.join("|")})(?:${ORDER_VERBS.join("|")})`);
/** Trading verbs that are an order operation on their own, whatever follows them. Whole tokens only. */
const TRADING_VERBS: ReadonlySet<string> = new Set([
  "buy", "buys", "buying", "sell", "sells", "selling", "short", "shorting", "trade", "trades", "trading", "traded",
  "flatten", "flattening", "liquidate", "liquidating", "liquidation", "rebalance", "rebalancing",
]);
/** In an ATS registry these verbs mean an order even with no noun: `/ats submit` is not ambiguous. */
const ATS_BARE_VERB = /^(?:submit(?:s|ted|ting)?|submission|place[sd]?|placing|commit(?:s|ted|ting)?|cancel(?:s|led|ed|ling|ing|lation)?)$/;
const APPROVAL = /^approv/;

/** Every operation the order contracts name: the ten browser operations and the order-bearing connector and grant operations. */
const CONTRACT_ORDER_NAMES: ReadonlySet<string> = new Set([
  ...BROWSER_ORDER_OPERATIONS,
  ...[...NORMALIZED_OPERATIONS, ...GRANT_CAPABILITIES].filter((op) => tokensOf(op).some((token) => ORDER_BEARING.has(token))),
]);

/** 10 browser operations, 5 order connector operations, 2 order grant capabilities. A constant, never derived. */
const CONTRACT_ORDER_NAME_COUNT = 17;

/** Why `name` is an order operation, or null when it is not one. `ats` marks a registry scoped to ATS. */
function orderLike(name: string, ats = false): string | null {
  if (CONTRACT_ORDER_NAMES.has(name)) return "an order-contract operation";
  const tokens = tokensOf(name);
  if (tokens.some((token) => APPROVAL.test(token))) return "an approval";
  if (tokens.some((token) => TRADING_VERBS.has(token))) return "a buy, sell, short, trade, flatten, rebalance or liquidation";
  if (tokens.some((token) => ORDER_VERB.test(token)) && tokens.some((token) => ORDER_NOUN_SET.has(token))) {
    return "an order, trade, position or ticket being acted on";
  }
  if (JOINED.test(tokens.join(""))) return "an order verb run into its noun";
  if (ats && tokens.some((token) => ATS_BARE_VERB.test(token))) return "a bare submit, place, commit or cancel in an ATS registry";
  return null;
}

// --- Reviewed exemptions -------------------------------------------------------------
//
// Legitimate CLI vocabulary the rules above would flag. Each entry names ONE
// registry and ONE name and says why it is not an order operation. The list is
// exact: every entry must be hit by the scan (no stale exemptions), its length
// is a pinned constant (it cannot grow silently), and no order-contract
// operation can ever be exempted.

interface Exemption { readonly registry: string; readonly name: string; readonly reason: string }

const REVIEWED_EXEMPTIONS: readonly Exemption[] = [
  {
    registry: "command flags: manifest ownedFlags and acceptedGlobalFlags",
    name: "approve",
    reason: "the GitHub action rail's `--approve <phrase>` flag (github.ts, action_rail.ts): the exact plan-approval phrase for creating or updating a PR, re-running CI or dispatching a workflow; it touches no account or order",
  },
  {
    registry: "command flags: cli_registry.ts CLI_PARSE_OPTIONS",
    name: "approve",
    reason: "the same `--approve <phrase>` GitHub action-rail flag, as the shell parser registers it",
  },
  {
    registry: "aether-ats-skills settings modes",
    name: "approve",
    reason: "the operator's requested execution mode `approve` (settings requested_execution_mode, Spec 2 section 7.2): a local preference that ATSv2 may only downgrade; it names no operation and grants no authority",
  },
];

/** Pinned: adding an exemption is a deliberate, reviewed edit to both the list and this constant. */
const EXEMPTION_COUNT = 3;

const exemptionKey = (registry: string, name: string) => `${registry} :: ${name}`;

// --- Reading the registries ------------------------------------------------------

/** A single- or double-quoted string literal on one line. */
const STRINGS = /"([^"\n]*)"|'([^'\n]*)'/g;
/** String arrays a dispatcher tests its verb against: ["plan", "skip"].includes(args[0]). */
const DISPATCH_ARRAYS = /\[([^\]]*)\]\.includes\((?:command|sub|subcmd|subcommand|action|verb|cmd|args\[\d\]|argv\[\d\]|first|mode|op|operation)\b/g;

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/** The first capture group each match filled, so one pattern can offer several quote styles. */
function captured(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)]
    .map((match) => match.slice(1).find((group) => group !== undefined) ?? "")
    .filter((value) => value.length > 0);
}

function stringsIn(text: string): string[] {
  return captured(text, STRINGS);
}

function dispatchArrays(text: string): string[] {
  return captured(text, DISPATCH_ARRAYS).flatMap(stringsIn);
}

function between(text: string, start: string, end: string, where: string): string {
  const from = text.indexOf(start);
  const to = from < 0 ? -1 : text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`${where}: its registry anchor moved; re-point this reader at the new definition`);
  return text.slice(from + start.length, to);
}

/** What CloudBrain actually sends Cloud as its tool capabilities when it opens a dev session. */
async function cloudBrainCapabilities(): Promise<string[]> {
  const bodies: unknown[] = [];
  const api = {
    postJson: async (_path: string, body: unknown) => {
      bodies.push(body);
      throw new Error("registry probe stops before any network call");
    },
  } as unknown as ApiClient;
  const events: BrainEvent[] = [];
  for await (const event of new CloudBrain(api).run({ type: "task", text: "registry probe", cwd: tmpdir(), poolGb: 1 })) {
    events.push(event);
  }
  assert.equal(bodies.length, 1, "CloudBrain must open exactly one dev session");
  assert.ok(events.some((event) => event.type === "error"), "the probe must end the run it started");
  const capabilities = (bodies[0] as { capabilities?: unknown }).capabilities;
  assert.ok(Array.isArray(capabilities), "the dev-session request must advertise a capability list");
  return capabilities.map(String);
}

async function builtinSkillNames(): Promise<string[]> {
  const root = "src/skills/builtin";
  const names: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skill = JSON.parse(await source(join(root, entry.name, "skill.json"))) as {
      id: string;
      triggers?: { commands?: string[] };
      tools?: { allowed?: string[]; required?: string[] };
    };
    names.push(skill.id, ...(skill.triggers?.commands ?? []), ...(skill.tools?.allowed ?? []), ...(skill.tools?.required ?? []));
  }
  return names;
}

/**
 * Every subcommand any module in src/commands dispatches on: its case labels,
 * comparisons against the parsed verb and the string arrays a verb is tested
 * against. Reads the whole directory, so a command module added later is
 * swept the day it lands.
 */
async function commandDispatchNames(): Promise<string[]> {
  const root = "src/commands";
  const pattern = /(?:case |(?:sub|subcmd|subcommand|action|verb|command|cmd|args\[\d\]|argv\[\d\]|first|mode|op|operation) === )(?:"([^"\n]*)"|'([^'\n]*)')/g;
  const names: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const text = await source(join(root, entry.name));
    names.push(...captured(text, pattern), ...dispatchArrays(text));
  }
  return names;
}

const STUB_OBSERVER = { snapshot: async () => ({}), status: () => ({}) } as unknown as Parameters<typeof createBrowserVisionSkill>[0];

interface Registry {
  /** Named in every failure. */
  readonly name: string;
  /** A name the registry is known to hold; proves the read found the real list. */
  readonly sentinel: string;
  /** ATS-scoped: a bare submit, place, commit or cancel is an order here. */
  readonly ats?: true;
  readonly read: () => readonly string[] | Promise<readonly string[]>;
}

const REGISTRIES: readonly Registry[] = [
  // Tools a model or brain can call.
  { name: "brain_protocol.ts TOOLS", sentinel: "read_file", read: () => TOOLS },
  { name: "tool_registry.ts TOOL_DEFINITIONS", sentinel: "read_file", read: () => Object.keys(TOOL_DEFINITIONS) },
  {
    name: "tool_executor.ts ToolExecutor dispatch table",
    sentinel: "git_commit",
    read: async () => captured(await source("src/core/tool_executor.ts"), /(?:case |name === )(?:"([^"\n]+)"|'([^'\n]+)')/g),
  },
  { name: "brain_ollama.ts ollamaToolSchemas()", sentinel: "run_shell", read: () => ollamaToolSchemas().map((schema) => schema.function.name) },
  { name: "brain_cloud.ts CloudBrain dev-session capabilities", sentinel: "run_tests", read: cloudBrainCapabilities },
  {
    name: "doctor_live.ts health-probe capabilities and answered tools",
    sentinel: "write_file",
    read: async () => {
      const text = await source("src/core/doctor_live.ts");
      const advertised = captured(text, /capabilities: ([A-Za-z_]+),/g);
      if (advertised.length !== 1 || advertised[0] !== "TOOLS") {
        throw new Error("doctor_live.ts no longer advertises exactly TOOLS; read what it advertises here");
      }
      return [...TOOLS, ...captured(text, /frame\.name === (?:"([^"\n]+)"|'([^'\n]+)')/g)];
    },
  },
  { name: "exec.ts EXEC_V1_TOOLS", sentinel: "repo_search", read: () => EXEC_V1_TOOLS },
  {
    name: "headless_session.ts TOOL_NAMES",
    sentinel: "write_file",
    read: async () => stringsIn(between(await source("src/core/headless_session.ts"), "const TOOL_NAMES = new Set([", "]);", "headless_session.ts")),
  },
  {
    name: "generated/agent_capabilities.ts AGENT_CAPABILITIES_FALLBACK tools and permissions",
    sentinel: "web_fetch",
    read: () => [...AGENT_CAPABILITIES_FALLBACK.tools.map((tool) => tool.name), ...AGENT_CAPABILITIES_FALLBACK.permissions],
  },
  {
    name: "skills/permission_vocabulary.ts TOOL_PERMISSIONS and PERMISSIONS",
    sentinel: "git_commit",
    read: () => [...Object.keys(TOOL_PERMISSIONS), ...PERMISSIONS],
  },
  { name: "src/skills/builtin skill manifests", sentinel: "ship", read: builtinSkillNames },
  {
    name: "aether-ats-skills createBrowserVisionSkill()",
    sentinel: "aether_browser_observe",
    read: () => [createBrowserVisionSkill(STUB_OBSERVER).name],
  },
  // Actions Cloud, a worker or a device can invoke by name.
  {
    name: "aether_code_host_protocol.ts ACTIONS",
    sentinel: "file_write",
    read: async () => stringsIn(between(await source("src/core/aether_code_host_protocol.ts"), "const ACTIONS = new Set([", "]);", "aether_code_host_protocol.ts")),
  },
  {
    name: "headless_protocol.ts control actions",
    sentinel: "steer",
    read: async () => {
      const list = /\[([^\]]*)\]\.includes\(String\(obj\[(?:"action"|'action')\]\)\)/.exec(await source("src/core/headless_protocol.ts"));
      if (!list?.[1]) throw new Error("headless_protocol.ts: the control-action check moved; re-point this reader");
      return stringsIn(list[1]);
    },
  },
  { name: "device_runtime/contract.ts COMMAND_CLASSES", sentinel: "drain_checkpoint", read: () => COMMAND_CLASSES },
  {
    name: "device_runtime/daemon.ts advertised capabilities",
    sentinel: "aether.device.command/1",
    read: async () => stringsIn(between(await source("src/core/device_runtime/daemon.ts"), "private capabilities(): string[] {", "\n  }", "daemon.ts")),
  },
  {
    name: "action_rail.ts ACTION_APPROVALS and READ_ACTIONS",
    sentinel: "aether.github.pr.create",
    read: () => [...Object.keys(ACTION_APPROVALS), ...READ_ACTIONS],
  },
  {
    name: "ats_agent.ts atsManagedConfig() autonomy",
    sentinel: "report.prepare",
    ats: true,
    read: () => {
      const autonomy = atsManagedConfig("Registry probe")["autonomy"] as {
        mode: string;
        allowed_actions: string[];
        approval_required_actions: string[];
      };
      return [autonomy.mode, ...autonomy.allowed_actions, ...autonomy.approval_required_actions];
    },
  },
  { name: "rc/viewer_profile.ts VIEWER_CAPABILITIES", sentinel: "observe", read: () => VIEWER_CAPABILITIES },
  {
    name: "aether-ats-skills python/bridge.py operations",
    sentinel: "initialize_memory",
    ats: true,
    read: async () => {
      const table = /handler = \{([^}]*)\}\.get\(operation\)/.exec(await source("packages/ats-skills/python/bridge.py"));
      if (!table?.[1]) throw new Error("bridge.py: the operation table moved; re-point this reader");
      return captured(table[1], /(?:"([a-z_]+)"|'([a-z_]+)'):/g);
    },
  },
  {
    name: "aether-ats-skills settings modes",
    sentinel: "plan",
    ats: true,
    read: async () => {
      const text = await source("packages/ats-skills/src/settings.js");
      return [
        ...stringsIn(between(text, "PERMISSION_MODES = Object.freeze([", "]", "settings.js PERMISSION_MODES")),
        ...stringsIn(between(text, "APPROVAL_MODES = [", "]", "settings.js APPROVAL_MODES")),
      ];
    },
  },
  // Commands a person types, and the flags they pass.
  {
    name: "command_manifest_data.ts COMMAND_MANIFEST_SOURCE",
    sentinel: "chat",
    read: () => COMMAND_MANIFEST_SOURCE.flatMap((entry) => [
      entry.name, ...entry.aliases, ...entry.compatibilityAliases, ...entry.deprecatedAliases.map((alias) => alias.name),
    ]),
  },
  {
    name: "command flags: manifest ownedFlags and acceptedGlobalFlags",
    sentinel: "json",
    read: () => COMMAND_MANIFEST_SOURCE.flatMap((entry) => [...Object.keys(entry.ownedFlags), ...entry.acceptedGlobalFlags]),
  },
  { name: "command flags: cli_registry.ts CLI_PARSE_OPTIONS", sentinel: "json", read: () => Object.keys(CLI_PARSE_OPTIONS) },
  { name: "cli_registry.ts ALL_CLI_COMMANDS", sentinel: "agent", read: () => ALL_CLI_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]) },
  { name: "slash_registry.ts SLASH_COMMANDS", sentinel: "ats", read: () => SLASH_COMMANDS.map((command) => command.name) },
  { name: "managed_agents.ts MANAGED_AGENT_VERBS", sentinel: "activate", read: () => [...MANAGED_AGENT_VERBS] },
  { name: "main.ts shell dispatch", sentinel: "chat", read: async () => captured(await source("src/main.ts"), /case (?:"([^"\n]*)"|'([^'\n]*)'):/g) },
  { name: "slash.ts handleSlash dispatch", sentinel: "ats", read: async () => captured(await source("src/commands/slash.ts"), /case (?:"([^"\n]*)"|'([^'\n]*)'):/g) },
  {
    name: "ats_agent.ts /ats chat subcommands",
    sentinel: "strategies",
    ats: true,
    read: async () => {
      const text = await source("src/commands/ats_agent.ts");
      return [...captured(text, /(?:command|action|args\[\d\]) === (?:"([^"\n]+)"|'([^'\n]+)')/g), ...dispatchArrays(text)];
    },
  },
  {
    name: "agent_browser_session.ts /browser commands",
    sentinel: "refresh",
    read: async () => {
      const text = await source("src/core/agent_browser_session.ts");
      return [...captured(text, /command === (?:"([^"\n]+)"|'([^'\n]+)')/g), ...dispatchArrays(text)];
    },
  },
  { name: "goals.ts /goal subcommands", sentinel: "complete", read: async () => captured(await source("src/commands/goals.ts"), /case (?:"([^"\n]*)"|'([^'\n]*)'):/g) },
  { name: "github.ts subcommands and actions", sentinel: "checks", read: async () => captured(await source("src/commands/github.ts"), /case (?:"([^"\n]*)"|'([^'\n]*)'):/g) },
  { name: "src/commands/*.ts subcommand dispatchers", sentinel: "enroll", read: commandDispatchNames },
  {
    name: "aether-ats-skills bin/aether-ats-skills.js commands",
    sentinel: "scan",
    ats: true,
    read: async () => {
      const text = await source("packages/ats-skills/bin/aether-ats-skills.js");
      return [...captured(text, /(?:command|args\[\d\]) === (?:"([^"\n]+)"|'([^'\n]+)')/g), ...dispatchArrays(text)];
    },
  },
];

/** The number of registries checked. A constant: removing one from the list fails, and adding one is a deliberate edit. */
const REGISTRY_FLOOR = 35;

// --- The checks --------------------------------------------------------------------

test("the order-name check flags every contract operation and order-shaped name, and nothing benign", () => {
  assert.equal(CONTRACT_ORDER_NAMES.size, CONTRACT_ORDER_NAME_COUNT);
  for (const operation of BROWSER_ORDER_OPERATIONS) assert.ok(CONTRACT_ORDER_NAMES.has(operation), operation);
  const mustFlag = [
    ...CONTRACT_ORDER_NAMES, "place_order", "submitOrder", "cancel-order", "ats.orders.commit", "placeTrade",
    "execute_order", "confirm_trade", "close_position", "route_order", "amendOrder", "replace-order", "open_position",
    "buy", "sell_shares", "short", "flatten", "liquidate_all",
    "approve", "approve_order", "operator_approval",
    "create_order", "createOrder", "orders.create", "new_order", "post_order", "limit_order", "market_order",
    "submit_ticket", "cancel_all", "trade", "trading", "broker_commit", "exit_position", "authorize_order",
    "stop_order", "stage_order", "queue_order", "preview_order", "ats_broker_review_order", "reduce_position",
    "ticket_submit", "OrderPlace", "PLACE_ORDER", "placeorder", "submitorder", "cancelall", "orders/submit", "rebalance",
  ];
  const mustPass = [
    "git_commit", "git.commit", "commit", "cancel", "submit", "place", "resume", "orders", "positions", "open", "close",
    "execute", "send", "shortcut", "read_file", "aether.github.pr.create", "all", "queue", "stage-diff", "limit",
    "preview", "review", "new", "exit", "marketplace", "recorder", "reorder", "border",
  ];
  assert.deepEqual(mustFlag.filter((name) => orderLike(name) === null), [], "an order operation went unflagged");
  assert.deepEqual(mustPass.filter((name) => orderLike(name) !== null), [], "a benign name was flagged");
  // In an ATS registry a bare order verb is an order; everywhere else it is ordinary vocabulary.
  const atsBare = ["submit", "place", "commit", "cancel", "submitted", "cancelled", "placing", "commits"];
  assert.deepEqual(atsBare.filter((name) => orderLike(name, true) === null), [], "a bare order verb passed an ATS registry");
  assert.deepEqual(["plan", "status", "placeholder", "journal", "scan"].filter((name) => orderLike(name, true) !== null), [], "benign ATS vocabulary was flagged");
});

test("every tool, action and command registry is checked: the floor matches the list", () => {
  assert.equal(new Set(REGISTRIES.map((registry) => registry.name)).size, REGISTRIES.length, "registry names must be distinct");
  assert.equal(REGISTRIES.length, REGISTRY_FLOOR, `expected ${REGISTRY_FLOOR} registries, found ${REGISTRIES.length}`);
});

test("the exemption list is exact, reasoned and never covers an order-contract operation", () => {
  assert.equal(REVIEWED_EXEMPTIONS.length, EXEMPTION_COUNT, `expected ${EXEMPTION_COUNT} reviewed exemptions, found ${REVIEWED_EXEMPTIONS.length}`);
  const keys = REVIEWED_EXEMPTIONS.map((entry) => exemptionKey(entry.registry, entry.name));
  assert.equal(new Set(keys).size, keys.length, "an exemption is listed twice");
  const registryNames = new Set(REGISTRIES.map((registry) => registry.name));
  for (const entry of REVIEWED_EXEMPTIONS) {
    assert.ok(registryNames.has(entry.registry), `exemption names an unknown registry: ${entry.registry}`);
    assert.ok(!CONTRACT_ORDER_NAMES.has(entry.name), `an order-contract operation can never be exempted: ${entry.name}`);
    assert.ok(entry.reason.length >= 40, `exemption ${exemptionKey(entry.registry, entry.name)} needs a real reason`);
  }
});

test("no registry registers, advertises or dispatches an order operation", async () => {
  const problems: string[] = [];
  const exempt = new Map(REVIEWED_EXEMPTIONS.map((entry) => [exemptionKey(entry.registry, entry.name), entry]));
  const used = new Set<string>();
  for (const registry of REGISTRIES) {
    let names: readonly string[];
    try {
      names = await registry.read();
    } catch (error) {
      problems.push(`${registry.name}: could not be read: ${(error as Error).message}`);
      continue;
    }
    if (!names.includes(registry.sentinel)) {
      problems.push(`${registry.name}: read did not find its sentinel "${registry.sentinel}", so an empty or misdirected read would pass unseen`);
    }
    for (const name of names) {
      const reason = orderLike(name, registry.ats === true);
      if (!reason) continue;
      const key = exemptionKey(registry.name, name);
      if (exempt.has(key)) used.add(key);
      else problems.push(`${registry.name} exposes "${name}": ${reason}`);
    }
  }
  for (const key of exempt.keys()) if (!used.has(key)) problems.push(`stale exemption, nothing it covers is registered: ${key}`);
  assert.deepEqual(problems, []);
});

test("the tool executor and the headless control parser refuse every order operation at runtime", async () => {
  const executor = new ToolExecutor(tmpdir());
  const problems: string[] = [];
  for (const name of CONTRACT_ORDER_NAMES) {
    const sync = executor.execute(name, {});
    if (sync.exitCode === 0 || !sync.output.includes("rejected")) problems.push(`ToolExecutor.execute dispatched ${name}`);
    const later = await executor.executeAsync(name, {});
    if (later.exitCode === 0 || !later.output.includes("rejected")) problems.push(`ToolExecutor.executeAsync dispatched ${name}`);
    const frame = JSON.stringify({ protocol: HEADLESS_CONTROL_PROTOCOL, sequence: 1, correlation_id: "probe", action: name });
    if (parseControlFrame(frame).ok) problems.push(`headless control accepted ${name}`);
  }
  assert.deepEqual(problems, []);
});

// --- Imports of the order validators -------------------------------------------------

const IMPORT_SCAN_ROOTS = ["src", "scripts", "packages/ats-skills/src", "packages/ats-skills/bin"] as const;
/** Files the walk must reach, one per root at least, so a broken walk cannot pass by scanning nothing. */
const IMPORT_SCAN_SENTINELS = [
  "src/main.ts",
  "src/commands/ats_agent.ts",
  "src/core/brain_cloud.ts",
  "scripts/verify-production.ts",
  "packages/ats-skills/src/index.js",
  "packages/ats-skills/bin/aether-ats-skills.js",
] as const;
const CONTRACTS_DIRECTORY = "src/core/ats_contracts/";
/** The proposal, the order-chain modules, every browser-order module and the barrel that re-exports them. */
const ORDER_MODULE =
  /ats_contracts\/(?:proposal|order|approval|grant|connector|browser_order[a-z_]*|index)(?:\.[cm]?[jt]s)?["']|ats_contracts\/?["']/;
const ORDER_SYMBOLS = [
  "validateModelOrderProposal", "MODEL_ORDER_PROPOSAL_SCHEMA", "validateBrowserOrderCall", "validateBrowserOrderResult",
  "verifyBrowserResult", "BROWSER_ORDER_OPERATIONS", "AGENT_BROWSER_ATS_ORDER_PROTOCOL",
  "verifyExecutableCommitAuthority", "verifyCommitAuthority", "verifyExecutableApprovalChain", "verifyApprovalChain",
] as const;

/** Keywords after which a `/` starts a regex literal rather than dividing. */
const REGEX_AFTER_WORD: ReadonlySet<string> = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);
/** Characters after which a `/` starts a regex literal rather than dividing. */
const REGEX_AFTER_CHAR = "(,=:[!&|?{};+-*%<>~^";

/**
 * Remove comments while keeping every string, template and regex literal
 * intact, so a `//` in a URL or a `/*` in a glob can never swallow the code
 * after it. Anything left open at the end throws: a stripper that has lost
 * its place must fail the scan, not quietly hide an import.
 */
function withoutComments(source: string): string {
  const n = source.length;
  let out = "";
  let i = 0;
  let last = "";
  let word = "";
  let depth = 0;
  const templateDepths: number[] = [];
  const open = (what: string): never => {
    throw new Error(`comment stripper: unterminated ${what} at offset ${i}`);
  };
  const copyQuoted = (quote: string): void => {
    const start = i;
    for (i += 1; i < n && source[i] !== quote; i += 1) {
      if (source[i] === "\\") i += 1;
      else if (source[i] === "\n") open("string");
    }
    if (i >= n) open("string");
    i += 1;
    out += source.slice(start, i);
  };
  /** Template text from i to its closing backtick, or to a `${`, whose expression then runs as code. */
  const copyTemplate = (): void => {
    const start = i;
    while (i < n) {
      if (source[i] === "\\") i += 2;
      else if (source[i] === "`") {
        i += 1;
        out += source.slice(start, i);
        return;
      } else if (source[i] === "$" && source[i + 1] === "{") {
        i += 2;
        out += source.slice(start, i);
        templateDepths.push(depth);
        depth += 1;
        return;
      } else i += 1;
    }
    open("template literal");
  };
  const copyRegex = (): void => {
    const start = i;
    let inClass = false;
    for (i += 1; i < n; i += 1) {
      const c = source[i]!;
      if (c === "\\") i += 1;
      else if (c === "\n") open("regex literal");
      else if (inClass) inClass = c !== "]";
      else if (c === "[") inClass = true;
      else if (c === "/") break;
    }
    if (i >= n) open("regex literal");
    for (i += 1; i < n && /[a-z]/i.test(source[i]!); i += 1);
    out += source.slice(start, i);
  };
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1] ?? "";
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) open("block comment");
      out += " ";
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      copyQuoted(c);
      last = c;
      word = "";
      continue;
    }
    if (c === "`") {
      i += 1;
      out += "`";
      copyTemplate();
      last = "`";
      word = "";
      continue;
    }
    if (c === "/" && (last === "" || REGEX_AFTER_CHAR.includes(last) || REGEX_AFTER_WORD.has(word))) {
      copyRegex();
      last = "/";
      word = "";
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (templateDepths.length > 0 && templateDepths[templateDepths.length - 1] === depth) {
        templateDepths.pop();
        out += "}";
        i += 1;
        copyTemplate();
        last = "`";
        word = "";
        continue;
      }
    }
    out += c;
    i += 1;
    if (/\s/.test(c)) continue;
    word = /[A-Za-z0-9_$]/.test(c) ? (/[A-Za-z0-9_$]/.test(last) ? word + c : c) : "";
    last = c;
  }
  if (templateDepths.length > 0) open("template expression");
  return out;
}

/** What in `text` reaches the proposal, order-chain or browser-order validators, or null. */
function orderImport(text: string): string | null {
  const code = withoutComments(text);
  if (ORDER_MODULE.test(code)) return "imports the proposal, an order-chain, a browser-order or the barrel module";
  const symbol = ORDER_SYMBOLS.find((name) => code.includes(name));
  return symbol ? `names ${symbol}` : null;
}

async function walk(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (/\.(?:[cm]?[jt]s)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

test("the comment stripper keeps every string, template and regex literal and fails closed", () => {
  const kept: ReadonlyArray<[string, string]> = [
    [`const glob = "src/**/*.ts"; call(); const end = "*/";`, "call();"],
    [`const url = "https://example.test/a"; call(); // trailing note`, "call();"],
    [`const re = /[/*]/; call(); const re2 = /\\/\\//;`, "call();"],
    [`const t = \`a \${"b//c"} /* text */ d\`; call();`, "call();"],
    [`const t = \`\${ { a: "}" }.a } x\`; call();`, "call();"],
    [`const q = 'it\\'s /* not */ a comment'; call();`, "call();"],
    [`if (a) return /re/.test(b) ? call() : 0;`, "call()"],
    [`const half = total / 2; call(); const x = a / b / c;`, "call();"],
  ];
  for (const [text, expected] of kept) {
    assert.ok(withoutComments(text).includes(expected), `the stripper swallowed code in: ${text}`);
  }
  const stripped: ReadonlyArray<[string, string]> = [
    [`/* verifyCommitAuthority */ const x = 1;`, "verifyCommitAuthority"],
    [`const x = 1; // BROWSER_ORDER_OPERATIONS`, "BROWSER_ORDER_OPERATIONS"],
    [`/**\n * validateModelOrderProposal\n */\nconst x = 1;`, "validateModelOrderProposal"],
  ];
  for (const [text, gone] of stripped) {
    assert.ok(!withoutComments(text).includes(gone), `the stripper kept a comment in: ${text}`);
  }
  for (const broken of [`const s = "open`, "const t = `open", "/* open", "const r = /open\n;", "const t = `${ open`"]) {
    assert.throws(() => withoutComments(broken), /unterminated/, `the stripper accepted: ${JSON.stringify(broken)}`);
  }
});

test("the order-import check catches every way of reaching the validators, and nothing else", () => {
  const caught = [
    `import { validateModelOrderProposal } from "../core/ats_contracts/index.js";`,
    `export * from "../ats_contracts/browser_order.js";`,
    `const m = await import("../core/ats_contracts/proposal.js");`,
    `import { equityTicker } from "../core/ats_contracts/browser_order_values.js";`,
    `import * as contracts from "../core/ats_contracts";`,
    `const ops = BROWSER_ORDER_OPERATIONS;`,
    `import { verifyCommitAuthority } from "../core/ats_contracts/approval.js";`,
    `import { validateTradingGrant } from '../ats_contracts/grant.js';`,
    `import { validateAccountBinding } from "../ats_contracts/connector.js";`,
    `const o = await import('../ats_contracts/order.js');`,
    `const gate = verifyExecutableCommitAuthority;`,
    `run(verifyExecutableApprovalChain, verifyApprovalChain);`,
    `const glob = "src/**/*.ts"; import { x } from "../ats_contracts/proposal.js"; const end = "*/";`,
    `const re = /[/*]/; const gate = verifyCommitAuthority;`,
  ];
  const clean = [
    `import { choice } from "../ats_contracts/primitives.js";`,
    `import { formatRuntimeSnapshot } from '../ats_contracts/runtime.js';`,
    `import { REQUESTED_EXECUTION_MODES } from "../ats_contracts/mode.js";`,
    `// validateModelOrderProposal is described here only in prose.`,
    `/* verifyCommitAuthority lives in approval.ts */ const x = 1;`,
    `const x = 1; // see verifyExecutableCommitAuthority`,
  ];
  assert.deepEqual(caught.filter((text) => orderImport(text) === null), [], "an order-validator import went unseen");
  assert.deepEqual(clean.filter((text) => orderImport(text) !== null), [], "prose or an unrelated module was flagged");
});

test("nothing outside src/core/ats_contracts imports the proposal, order-chain or browser-order validators", async () => {
  const files = (await Promise.all(IMPORT_SCAN_ROOTS.map(walk))).flat();
  assert.deepEqual(IMPORT_SCAN_SENTINELS.filter((path) => !files.includes(path)), [], "the scan did not reach every root");
  const problems: string[] = [];
  for (const path of files) {
    if (path.startsWith(CONTRACTS_DIRECTORY)) continue;
    let reason: string | null;
    try {
      reason = orderImport(await source(path));
    } catch (error) {
      problems.push(`${path} could not be scanned safely: ${(error as Error).message}`);
      continue;
    }
    if (reason) problems.push(`${path} ${reason}`);
  }
  assert.deepEqual(problems, []);
});

test("the CLI hosts no MCP server whose tools this inventory would miss", async () => {
  // A server must answer these JSON-RPC methods and would normally sit on the
  // MCP SDK. Neither exists today: the CLI is only a client of Cloud's MCP
  // broker. If either appears, add that server's tool list to REGISTRIES.
  const manifest = JSON.parse(await source("package.json")) as Record<string, Record<string, string> | undefined>;
  const dependencies = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
    .flatMap((field) => Object.keys(manifest[field] ?? {}));
  assert.deepEqual(dependencies.filter((name) => name.startsWith("@modelcontextprotocol/")), []);
  const files = (await Promise.all(IMPORT_SCAN_ROOTS.map(walk))).flat();
  const serving: string[] = [];
  for (const path of files) {
    if (/["'`]tools\/(?:list|call)["'`]/.test(withoutComments(await source(path)))) serving.push(path);
  }
  assert.deepEqual(serving, [], "an MCP tool method appears; register that server's tools in REGISTRIES");
});
