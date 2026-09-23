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
import { ALL_CLI_COMMANDS } from "../src/commands/cli_registry.js";
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
/** What an order-shaped name acts on, and the verbs that act on it. */
const ORDER_NOUNS: ReadonlySet<string> = new Set(["order", "orders", "trade", "trades", "position", "positions"]);
const ORDER_VERB = /^(submit|commit|place|cancel|execute|confirm|close|route|send|fill|open|amend|modify|replace|flatten)/;
/** Trading verbs that are an order operation on their own, whatever follows them. Whole tokens only. */
const TRADING_VERBS: ReadonlySet<string> = new Set([
  "buy", "buys", "buying", "sell", "sells", "selling", "short", "shorting",
  "flatten", "flattening", "liquidate", "liquidating", "liquidation",
]);
const APPROVAL = /^approv/;

/** Every operation the order contracts name: the ten browser operations and the order-bearing connector and grant operations. */
const CONTRACT_ORDER_NAMES: ReadonlySet<string> = new Set([
  ...BROWSER_ORDER_OPERATIONS,
  ...[...NORMALIZED_OPERATIONS, ...GRANT_CAPABILITIES].filter((op) => tokensOf(op).some((token) => ORDER_BEARING.has(token))),
]);

/** 10 browser operations, 5 order connector operations, 2 order grant capabilities. A constant, never derived. */
const CONTRACT_ORDER_NAME_COUNT = 17;

/** Why `name` is an order operation, or null when it is not one. */
function orderLike(name: string): string | null {
  if (CONTRACT_ORDER_NAMES.has(name)) return "an order-contract operation";
  const tokens = tokensOf(name);
  if (tokens.some((token) => APPROVAL.test(token))) return "an approval";
  if (tokens.some((token) => TRADING_VERBS.has(token))) return "a buy, sell, short, flatten or liquidation";
  if (tokens.some((token) => ORDER_VERB.test(token)) && tokens.some((token) => ORDER_NOUNS.has(token))) {
    return "an order, trade or position being submitted, committed, placed, cancelled, executed, closed, routed or amended";
  }
  return null;
}

// --- Reading the registries ------------------------------------------------------

const QUOTED = /"([^"]*)"/g;

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function captured(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? "").filter((value) => value.length > 0);
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
 * Every subcommand any module in src/commands dispatches on: its case labels and
 * comparisons against the parsed verb. Reads the whole directory, so a command
 * module added later is swept the day it lands.
 */
async function commandDispatchNames(): Promise<string[]> {
  const root = "src/commands";
  const pattern = /(?:case |(?:sub|subcmd|subcommand|action|verb|command|cmd|args\[0\]|argv\[0\]|first|mode|op|operation) === )(?:"([^"]*)"|'([^']*)')/g;
  const names: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    for (const match of (await source(join(root, entry.name))).matchAll(pattern)) {
      const name = match[1] ?? match[2] ?? "";
      if (name) names.push(name);
    }
  }
  return names;
}

const STUB_OBSERVER = { snapshot: async () => ({}), status: () => ({}) } as unknown as Parameters<typeof createBrowserVisionSkill>[0];

interface Registry {
  /** Named in every failure. */
  readonly name: string;
  /** A name the registry is known to hold; proves the read found the real list. */
  readonly sentinel: string;
  readonly read: () => readonly string[] | Promise<readonly string[]>;
}

const REGISTRIES: readonly Registry[] = [
  // Tools a model or brain can call.
  { name: "brain_protocol.ts TOOLS", sentinel: "read_file", read: () => TOOLS },
  { name: "tool_registry.ts TOOL_DEFINITIONS", sentinel: "read_file", read: () => Object.keys(TOOL_DEFINITIONS) },
  {
    name: "tool_executor.ts ToolExecutor dispatch table",
    sentinel: "git_commit",
    read: async () => captured(await source("src/core/tool_executor.ts"), /(?:case |name === )"([^"]+)"/g),
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
      return [...TOOLS, ...captured(text, /frame\.name === "([^"]+)"/g)];
    },
  },
  { name: "exec.ts EXEC_V1_TOOLS", sentinel: "repo_search", read: () => EXEC_V1_TOOLS },
  {
    name: "headless_session.ts TOOL_NAMES",
    sentinel: "write_file",
    read: async () => captured(between(await source("src/core/headless_session.ts"), "const TOOL_NAMES = new Set([", "]);", "headless_session.ts"), QUOTED),
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
    read: async () => captured(between(await source("src/core/aether_code_host_protocol.ts"), "const ACTIONS = new Set([", "]);", "aether_code_host_protocol.ts"), QUOTED),
  },
  {
    name: "headless_protocol.ts control actions",
    sentinel: "steer",
    read: async () => {
      const list = /\[([^\]]*)\]\.includes\(String\(obj\["action"\]\)\)/.exec(await source("src/core/headless_protocol.ts"));
      if (!list?.[1]) throw new Error("headless_protocol.ts: the control-action check moved; re-point this reader");
      return captured(list[1], QUOTED);
    },
  },
  { name: "device_runtime/contract.ts COMMAND_CLASSES", sentinel: "drain_checkpoint", read: () => COMMAND_CLASSES },
  {
    name: "device_runtime/daemon.ts advertised capabilities",
    sentinel: "aether.device.command/1",
    read: async () => captured(between(await source("src/core/device_runtime/daemon.ts"), "private capabilities(): string[] {", "\n  }", "daemon.ts"), QUOTED),
  },
  {
    name: "action_rail.ts ACTION_APPROVALS and READ_ACTIONS",
    sentinel: "aether.github.pr.create",
    read: () => [...Object.keys(ACTION_APPROVALS), ...READ_ACTIONS],
  },
  {
    name: "ats_agent.ts atsManagedConfig() autonomy",
    sentinel: "report.prepare",
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
    read: async () => {
      const table = /handler = \{([^}]*)\}\.get\(operation\)/.exec(await source("packages/ats-skills/python/bridge.py"));
      if (!table?.[1]) throw new Error("bridge.py: the operation table moved; re-point this reader");
      return captured(table[1], /"([a-z_]+)":/g);
    },
  },
  // Commands a person types.
  {
    name: "command_manifest_data.ts COMMAND_MANIFEST_SOURCE",
    sentinel: "chat",
    read: () => COMMAND_MANIFEST_SOURCE.flatMap((entry) => [
      entry.name, ...entry.aliases, ...entry.compatibilityAliases, ...entry.deprecatedAliases.map((alias) => alias.name),
    ]),
  },
  { name: "cli_registry.ts ALL_CLI_COMMANDS", sentinel: "agent", read: () => ALL_CLI_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]) },
  { name: "slash_registry.ts SLASH_COMMANDS", sentinel: "ats", read: () => SLASH_COMMANDS.map((command) => command.name) },
  { name: "managed_agents.ts MANAGED_AGENT_VERBS", sentinel: "activate", read: () => [...MANAGED_AGENT_VERBS] },
  { name: "main.ts shell dispatch", sentinel: "chat", read: async () => captured(await source("src/main.ts"), /case "([^"]*)":/g) },
  { name: "slash.ts handleSlash dispatch", sentinel: "ats", read: async () => captured(await source("src/commands/slash.ts"), /case "([^"]*)":/g) },
  {
    name: "ats_agent.ts /ats chat subcommands",
    sentinel: "strategies",
    read: async () => captured(await source("src/commands/ats_agent.ts"), /(?:command|action|args\[0\]) === "([^"]+)"/g),
  },
  {
    name: "agent_browser_session.ts /browser commands",
    sentinel: "refresh",
    read: async () => captured(await source("src/core/agent_browser_session.ts"), /command === "([^"]+)"/g),
  },
  { name: "goals.ts /goal subcommands", sentinel: "complete", read: async () => captured(await source("src/commands/goals.ts"), /case "([^"]*)":/g) },
  { name: "github.ts subcommands and actions", sentinel: "checks", read: async () => captured(await source("src/commands/github.ts"), /case "([^"]*)":/g) },
  { name: "src/commands/*.ts subcommand dispatchers", sentinel: "enroll", read: commandDispatchNames },
  {
    name: "aether-ats-skills bin/aether-ats-skills.js commands",
    sentinel: "scan",
    read: async () => captured(await source("packages/ats-skills/bin/aether-ats-skills.js"), /(?:command|args\[0\]) === "([^"]+)"/g),
  },
];

/** The number of registries checked. A constant: removing one from the list fails, and adding one is a deliberate edit. */
const REGISTRY_FLOOR = 32;

// --- The checks --------------------------------------------------------------------

test("the order-name check flags every contract operation and order-shaped name, and nothing benign", () => {
  assert.equal(CONTRACT_ORDER_NAMES.size, CONTRACT_ORDER_NAME_COUNT);
  for (const operation of BROWSER_ORDER_OPERATIONS) assert.ok(CONTRACT_ORDER_NAMES.has(operation), operation);
  const mustFlag = [
    ...CONTRACT_ORDER_NAMES, "place_order", "submitOrder", "cancel-order", "ats.orders.commit", "placeTrade",
    "execute_order", "confirm_trade", "close_position", "route_order", "amendOrder", "replace-order", "open_position",
    "buy", "sell_shares", "short", "flatten", "liquidate_all",
    "approve", "approve_order", "operator_approval",
  ];
  const mustPass = [
    "git_commit", "git.commit", "commit", "cancel", "resume", "orders", "positions", "open", "close", "execute", "send",
    "shortcut", "read_file", "aether.github.pr.create",
  ];
  assert.deepEqual(mustFlag.filter((name) => orderLike(name) === null), [], "an order operation went unflagged");
  assert.deepEqual(mustPass.filter((name) => orderLike(name) !== null), [], "a benign name was flagged");
});

test("every tool, action and command registry is checked: the floor matches the list", () => {
  assert.equal(new Set(REGISTRIES.map((registry) => registry.name)).size, REGISTRIES.length, "registry names must be distinct");
  assert.equal(REGISTRIES.length, REGISTRY_FLOOR, `expected ${REGISTRY_FLOOR} registries, found ${REGISTRIES.length}`);
});

test("no registry registers, advertises or dispatches an order operation", async () => {
  const problems: string[] = [];
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
      const reason = orderLike(name);
      if (reason) problems.push(`${registry.name} exposes "${name}": ${reason}`);
    }
  }
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
const ORDER_MODULE = /ats_contracts\/(?:proposal|browser_order[a-z_]*|index)(?:\.[cm]?[jt]s)?["']|ats_contracts\/?["']/;
const ORDER_SYMBOLS = [
  "validateModelOrderProposal", "MODEL_ORDER_PROPOSAL_SCHEMA", "validateBrowserOrderCall", "validateBrowserOrderResult",
  "verifyBrowserResult", "BROWSER_ORDER_OPERATIONS", "AGENT_BROWSER_ATS_ORDER_PROTOCOL",
] as const;

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** What in `text` reaches the proposal or browser-order validators, or null. */
function orderImport(text: string): string | null {
  const code = withoutComments(text);
  if (ORDER_MODULE.test(code)) return "imports the proposal, browser-order or barrel module";
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

test("the order-import check catches every way of reaching the validators, and nothing else", () => {
  const caught = [
    `import { validateModelOrderProposal } from "../core/ats_contracts/index.js";`,
    `export * from "../ats_contracts/browser_order.js";`,
    `const m = await import("../core/ats_contracts/proposal.js");`,
    `import { equityTicker } from "../core/ats_contracts/browser_order_values.js";`,
    `import * as contracts from "../core/ats_contracts";`,
    `const ops = BROWSER_ORDER_OPERATIONS;`,
  ];
  const clean = [
    `import { choice } from "../ats_contracts/primitives.js";`,
    `import { formatRuntimeSnapshot } from "../ats_contracts/runtime.js";`,
    `// validateModelOrderProposal is described here only in prose.`,
  ];
  assert.deepEqual(caught.filter((text) => orderImport(text) === null), []);
  assert.deepEqual(clean.filter((text) => orderImport(text) !== null), []);
});

test("nothing outside src/core/ats_contracts imports the proposal or browser-order validators", async () => {
  const files = (await Promise.all(IMPORT_SCAN_ROOTS.map(walk))).flat();
  assert.deepEqual(IMPORT_SCAN_SENTINELS.filter((path) => !files.includes(path)), [], "the scan did not reach every root");
  const problems: string[] = [];
  for (const path of files) {
    if (path.startsWith(CONTRACTS_DIRECTORY)) continue;
    const reason = orderImport(await source(path));
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
    const code = withoutComments(await source(path));
    if (code.includes(`"tools/list"`) || code.includes(`"tools/call"`)) serving.push(path);
  }
  assert.deepEqual(serving, [], "an MCP tool method appears; register that server's tools in REGISTRIES");
});
