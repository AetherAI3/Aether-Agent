import { createInterface, type Key, type Interface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import type { AppContext } from "../core/context.js";
import {
  ManagedAgentsClient, MANAGED_AGENT_ID, managedAgentError, probeManagedReadiness,
  type ManagedReadiness, type ReadinessGate,
  type ManagedAgent, type ManagedAgentConfig, type AgentMessage, type MessageAdmission,
} from "../core/managed_agents.js";
import { theme } from "../ui/theme.js";
import { sanitizeTerm, sliceVisible, visibleWidth, wrapVisible } from "../ui/text.js";
import { decodeKey, splitKeys } from "../ui/keys.js";
import { isAbortError } from "../core/errors.js";
import { createManagedDraft } from "../core/managed_agent_creation.js";
import { managedChatInput } from "../ui/managed_chat_input.js";

export interface ManagedChatContext {
  chat: "connecting" | "synced" | "paused";
  checkedAt?: number;
  profileCheckedAt?: number;
  mode?: string;
  memory?: string;
  strategies?: string;
  browser?: string;
  data?: string;
}

export interface ManagedChatSurface {
  /** Prompt-preserving output for asynchronous local status and setup. */
  write(text: string): void;
  signal: AbortSignal;
  connection?: () => Pick<ManagedChatContext, "chat" | "checkedAt">;
  setContext?: (state: Partial<Omit<ManagedChatContext, "chat" | "checkedAt">>) => void;
}

export interface ManagedAgentHooks {
  createATS?: (ctx: AppContext, name: string, signal?: AbortSignal) => Promise<number>;
  beforeChat?: (ctx: AppContext, agent: ManagedAgent, surface?: ManagedChatSurface) => Promise<void | (() => Promise<void>)>;
  onChatCommand?: (ctx: AppContext, agent: ManagedAgent, input: string, surface?: ManagedChatSurface) => Promise<boolean>;
  cycleMode?: (ctx: AppContext, agent: ManagedAgent, surface?: ManagedChatSurface) => Promise<void>;
  help?: (agent: ManagedAgent) => string | undefined;
}

export interface ManagedAgentDeps {
  out?: Writable;
  err?: Writable;
  signal?: AbortSignal;
  hooks?: ManagedAgentHooks;
  stateRoot?: string;
  /** Injectable input keeps interactive regressions isolated from process stdin. */
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
}

export const MANAGED_AGENT_VERBS = new Set(["list", "create", "show", "configure", "chat", "activate", "pause", "resume", "retire"]);

const HELP = [
  "aether agent list                       Your agents, synced with the web",
  "aether agent create <name>              Create an agent draft",
  "aether agent create ATS <name>          Set up a trading agent",
  "aether agent show <mag_id>              Inspect configuration and status",
  "aether agent configure <mag_id> <key> <value>",
  "aether agent chat [mag_id]              Open the shared Online DM",
  "aether --agent <mag_id> chat [message]  Chat directly with an agent",
  "aether agent activate|pause|resume <mag_id>",
  "",
  "Settings: name, purpose, prompt, tone, model, project, total-uvt, run-uvt, daily-uvt.",
  "New agents start as drafts with zero budget. Configure UVT limits, then activate.",
].join("\n") + "\n";

function readinessLine(readiness: ManagedReadiness): string {
  return (["registry", "dm", "model_uvt"] as const).map(key => {
    const gate = readiness[key];
    return `${key}: ${gate.state} (${gate.code}) · ${gate.reason} ${gate.state === "enabled" ? "" : gate.remedy}`.trim();
  }).join("\n") + "\n";
}

function writeGateError(gate: ReadinessGate, ctx: AppContext, out: Writable): void {
  out.write(ctx.flags.json
    ? JSON.stringify({ error: { code: gate.code, message: gate.reason, remedy: gate.remedy } }) + "\n"
    : `✗ ${gate.code}: ${sanitizeTerm(gate.reason)} ${sanitizeTerm(gate.remedy)}\n`);
}

function cell(value: string, width: number): string {
  const safe = sliceVisible(sanitizeTerm(value).replace(/[\r\n\t]/g, " "), width);
  return safe + " ".repeat(Math.max(0, width - visibleWidth(safe)));
}

export function renderManagedAgents(agents: ManagedAgent[], columns = process.stdout.columns ?? 80): string {
  const width = Math.max(20, Math.floor(columns));
  const rows: string[] = [theme.bold("Your agents") + theme.dim(" · Aether Online"), ""];
  if (!agents.length) rows.push("No agents yet.", "Create: aether agent create <name>");
  else if (width >= 76) {
    rows.push(theme.dim(`${cell("NAME", 23)} ${cell("STATE", 14)} ${cell("RUNTIME", 12)} ID`));
    rows.push(...agents.map(a => `${cell(a.config.identity.display_name, 23)} ${cell(a.runtime.tile_state, 14)} ${cell(a.runtime.observation, 12)} ${a.agent_id}`));
  } else {
    for (const a of agents) rows.push(theme.cyan(cell(a.config.identity.display_name, width).trimEnd()),
      `  ${sanitizeTerm(a.runtime.tile_state).replace(/[\r\n\t]/g, " ")} · ${sanitizeTerm(a.runtime.observation).replace(/[\r\n\t]/g, " ")}`, `  ${a.agent_id}`, "");
  }
  rows.push("", "Open: aether agent chat", "Refresh: aether agent list");
  return rows.flatMap(row => wrapVisible(row, width)).join("\n") + "\n";
}

function checkedTime(value: number | undefined): string {
  return value !== undefined && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime())
    ? new Date(value).toISOString() : "not checked";
}

function isAts(agent: ManagedAgent): boolean {
  return agent.config.profile?.schema_version === "aether.managed-agent.profile/1" && agent.config.profile.kind === "ats";
}

/** Read-only status from Cloud and, for typed ATS agents, checked local setup. */
export function renderManagedContext(agent: ManagedAgent, state: ManagedChatContext, columns: number): string {
  const width = Math.max(20, Math.floor(columns));
  const clean = (value: string): string => sanitizeTerm(value).replace(/[\r\n\t]/g, " ");
  const name = sliceVisible(clean(agent.config.identity.display_name), Math.min(24, width - 16));
  const dm = `DM ${state.chat}`;
  const dmChecked = `checked ${checkedTime(state.checkedAt)}`;
  const lines = [`${name} · ${sliceVisible(clean(agent.runtime.tile_state), 16)}`];
  lines.push(...(visibleWidth(`${dm} · ${dmChecked}`) <= width ? [`${dm} · ${dmChecked}`] : [dm, dmChecked]));
  if (isAts(agent)) {
    const details = checkedTime(state.profileCheckedAt) === "not checked" ? [] : (["mode", "memory", "strategies", "browser", "data"] as const)
      .flatMap(key => state[key] && !/^(unverified|unconfirmed)$/i.test(state[key]) ? [`${key} ${clean(state[key])}`] : []);
    if (details.length) lines.push("ATS local", `checked ${checkedTime(state.profileCheckedAt)}`, ...details);
    else lines.push("ATS local · not checked; local setup does not verify live orders");
  }
  return lines.flatMap(line => wrapVisible(theme.dim(clean(line)), width)).join("\n");
}

export function configureManagedAgent(config: ManagedAgentConfig, key: string, value: string): ManagedAgentConfig {
  const next = structuredClone(config);
  switch (key) {
    case "name":
      if (!value.trim() || value.length > 80) throw new Error("Choose a name between 1 and 80 characters.");
      next.identity.display_name = value.trim();
      break;
    case "purpose":
      if (value.length > 2000) throw new Error("Purpose must be at most 2,000 characters.");
      next.identity.purpose = value;
      break;
    case "prompt":
      if (value.length > 20_000) throw new Error("Instructions must be at most 20,000 characters.");
      next.behavior = { ...next.behavior, system_prompt: value };
      break;
    case "tone":
      if (!["neutral", "friendly", "technical", "formal"].includes(value)) throw new Error("Tone: neutral, friendly, technical or formal.");
      next.behavior = { ...next.behavior, tone: value };
      break;
    case "model":
      if (value !== "auto" && !/^[a-z0-9_]{2,64}$/.test(value)) throw new Error("Use an account-approved model key, or auto.");
      next.model_policy = { routing: value === "auto" ? "account-approved" : "explicit", models: value === "auto" ? [] : [value], fallback: "approved-only" };
      break;
    case "project":
      if (!/^prj_[0-9a-f]{16}$/.test(value)) throw new Error("Use a project ID from your account (prj_ plus 16 hex characters).");
      next.project_ids = [...new Set([...(next.project_ids ?? []), value])];
      break;
    case "total-uvt":
    case "run-uvt":
    case "daily-uvt": {
      if (!/^\d+$/.test(value) || Number(value) > 1_000_000_000) throw new Error("Enter a whole UVT limit between 0 and 1,000,000,000.");
      const field = key === "total-uvt" ? "total_uvt" : key === "run-uvt" ? "per_run_uvt" : "daily_uvt";
      next.budget = { ...next.budget, [field]: Number(value) };
      if ((next.budget.per_run_uvt ?? 0) > (next.budget.total_uvt ?? 0) || (next.budget.daily_uvt ?? 0) > (next.budget.total_uvt ?? 0)) {
        throw new Error("Set total-uvt first; per-run and daily limits cannot exceed it.");
      }
      break;
    }
    default: throw new Error("Unknown setting. Choose name, purpose, prompt, tone, model, project, total-uvt, run-uvt or daily-uvt.");
  }
  return next;
}

function renderAgent(agent: ManagedAgent): string {
  return [
    theme.bold(sanitizeTerm(agent.config.identity.display_name)) + theme.dim(`  ${agent.agent_id}`),
    `State: ${sanitizeTerm(agent.runtime.tile_state)}  ·  Runtime: ${sanitizeTerm(agent.runtime.observation)}  ·  Revision ${agent.revision}`,
    agent.runtime.reason ? sanitizeTerm(agent.runtime.reason) : "",
    agent.runtime.remedy ? sanitizeTerm(agent.runtime.remedy) : "",
    `UVT limits: total ${agent.config.budget?.total_uvt ?? 0}  ·  per run ${agent.config.budget?.per_run_uvt ?? 0}  ·  daily ${agent.config.budget?.daily_uvt ?? 0}`,
    agent.config.identity.purpose ? sanitizeTerm(agent.config.identity.purpose) : "",
  ].filter(Boolean).join("\n") + "\n";
}

/** One-column picker; restores raw mode and existing listeners on every exit. */
async function pickManagedAgent(agents: ManagedAgent[], out: Writable, signal?: AbortSignal): Promise<ManagedAgent | null> {
  if (!agents.length) { out.write(renderManagedAgents(agents)); return null; }
  if (!process.stdin.isTTY) {
    out.write(renderManagedAgents(agents));
    throw new Error("Pass an agent ID when input is not a terminal: aether agent chat <mag_id>.");
  }
  if (signal?.aborted) return null;
  const previousRaw = process.stdin.isRaw;
  const previousPaused = process.stdin.isPaused();
  const listeners = process.stdin.rawListeners("data");
  process.stdin.removeAllListeners("data");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let selected = 0;
  out.write("\x1b[?1049h\x1b[?25l");
  const render = (): void => {
    const height = Math.max(1, (process.stdout.rows ?? 24) - 6);
    const start = Math.max(0, Math.min(selected - Math.floor(height / 2), agents.length - height));
    const columns = Math.max(20, (out as Writable & { columns?: number }).columns ?? 80);
    const stateWidth = Math.min(14, Math.floor(columns / 3));
    const nameWidth = Math.max(4, Math.min(28, columns - stateWidth - 4));
    const lines = agents.slice(start, start + height).map((a, i) => {
      const row = `${i + start === selected ? "›" : " "} ${cell(a.config.identity.display_name, nameWidth)} ${cell(a.runtime.tile_state, stateWidth)}`;
      return i + start === selected ? theme.cyan(row) : row;
    });
    out.write("\x1b[H" + theme.bold("Your agents") + "\n" + theme.dim("Aether Online · shared conversations") + "\n\n" + lines.join("\n") + "\n\n" + theme.dim("↑ ↓ choose  ·  Enter open  ·  Esc cancel") + "\x1b[0J");
  };
  return new Promise((resolve) => {
    const finish = (agent: ManagedAgent | null): void => {
      process.stdin.removeListener("data", onData);
      signal?.removeEventListener("abort", cancel);
      for (const listener of listeners) process.stdin.on("data", listener as (...args: unknown[]) => void);
      process.stdin.setRawMode(previousRaw);
      if (previousPaused) process.stdin.pause();
      out.write("\x1b[?1049l\x1b[?25h");
      resolve(agent);
    };
    const cancel = (): void => finish(null);
    const onData = (chunk: Buffer): void => {
      for (const sequence of splitKeys(chunk.toString("utf8"))) {
        const key = decodeKey(sequence);
        if (key.kind === "up") selected = (selected - 1 + agents.length) % agents.length;
        if (key.kind === "down") selected = (selected + 1) % agents.length;
        if (key.kind === "submit") { finish(agents[selected] ?? null); return; }
        if (["interrupt", "eof", "escape"].includes(key.kind)) { finish(null); return; }
      }
      render();
    };
    process.stdin.on("data", onData);
    signal?.addEventListener("abort", cancel, { once: true });
    render();
  });
}

function admissionLabel(admission: MessageAdmission | undefined): string {
  if (!admission) return "saved · admission unconfirmed";
  switch (admission.state) {
    case "admitted": return "admitted";
    case "replied": return "replied";
    case "blocked_budget": return "saved · blocked by budget";
    case "blocked_policy": return "saved · blocked by policy";
    case "needs_review": return "saved · needs review";
    case "saved": return "saved · admission pending";
  }
}

export function renderManagedMessage(message: AgentMessage, agent: ManagedAgent, columns = 80): string {
  const fromAgent = message.sender_type === "agent" || Boolean(message.sender_agent_id);
  const label = fromAgent ? agent.config.identity.display_name : "You";
  const parsed = message.created_at ? Date.parse(message.created_at) : NaN;
  const time = Number.isFinite(parsed) ? new Date(parsed).toISOString() : "time unknown";
  const admission = !fromAgent ? ` · ${admissionLabel(message.admission)}` : "";
  const width = Math.max(20, Math.floor(columns));
  const cleanLabel = sliceVisible(sanitizeTerm(label).replace(/[\r\n\t]/g, " "), Math.min(32, width - 16));
  const speakerTime = `${cleanLabel} · ${time}`;
  const header = [
    ...(visibleWidth(speakerTime) <= width ? [speakerTime] : [cleanLabel, time]),
    ...(admission ? wrapVisible(admission.slice(3), width) : []),
  ].join("\n");
  const body = sanitizeTerm(message.body).split("\n").flatMap(line => wrapVisible(line, width)).join("\n");
  return `\n${header}\n${body}\n`;
}

export function renderManagedAdmission(admission: MessageAdmission | undefined): string {
  const state = admission?.state;
  const next: Record<string, string> = {
    blocked_budget: "Next: configure this agent's UVT limits, then send a new message.",
    blocked_policy: "Next: review this agent's permissions in Online before trying again.",
    needs_review: "Next: review this message in Online.",
    saved: "Next: use /refresh to check whether Cloud admitted this message.",
    unreported: "Next: check the shared conversation before sending again.",
  };
  return `${admissionLabel(admission)}${next[state ?? "unreported"] ? ` · ${next[state ?? "unreported"]}` : ""}`;
}

/** Scoped managed-chat hotkey. Repeated key events cannot queue mode changes
 * while a prior change is pending; ordinary Tab and coding sessions are untouched. */
export function bindManagedAgentKeys(
  input: {
    on(event: "keypress", listener: (text: string, key?: Key) => void): unknown;
    removeListener(event: "keypress", listener: (text: string, key?: Key) => void): unknown;
  },
  cycle: () => Promise<void>,
  redraw: () => void,
  reportError: (error: unknown) => void,
): () => void {
  let active = true;
  let pending = false;
  const keypress = (_text: string, key?: Key): void => {
    if (!active || pending || !key?.shift || key.name !== "tab" || key.ctrl || key.meta) return;
    pending = true;
    void Promise.resolve().then(async () => { if (active) await cycle(); }).catch((error: unknown) => {
      if (active) reportError(error);
    }).finally(() => {
      pending = false;
      if (active) redraw();
    });
  };
  input.on("keypress", keypress);
  return () => { active = false; input.removeListener("keypress", keypress); };
}

/** Write above a readline draft, including wrapped input and a moved cursor.
 * readline owns the draft and cursor; prompt(true) redraws without resetting either. */
export function writeManagedChatEvent(out: Writable, reader: Pick<Interface, "getCursorPos" | "prompt">, text: string): void {
  const { rows } = reader.getCursorPos();
  out.write(`\r${rows > 0 ? `\x1b[${rows}A` : ""}\x1b[0J`);
  out.write(text.endsWith("\n") ? text : text + "\n");
  reader.prompt(true);
}

export async function cmdManagedAgentChat(ctx: AppContext, id: string | undefined, prompt = "", deps: ManagedAgentDeps = {}): Promise<number> {
  const out = deps.out ?? process.stdout;
  const inputStream = deps.input ?? process.stdin;
  const terminal = Boolean(inputStream.isTTY && !ctx.flags.json);
  const client = new ManagedAgentsClient(ctx.api);
  const controller = new AbortController();
  const onProcessInterrupt = (): void => controller.abort();
  process.on("SIGINT", onProcessInterrupt);
  const signal = deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closeSession: void | (() => Promise<void>) = undefined;
  let reader: Interface | undefined;
  let promptReady = false;
  let surfaceClosed = false;
  let contextState: ManagedChatContext = { chat: "connecting" };
  const surface: ManagedChatSurface = {
    signal,
    connection: () => ({ chat: contextState.chat, checkedAt: contextState.checkedAt }),
    setContext(state) { contextState = { ...contextState, ...state }; },
    write(text) {
      if (surfaceClosed) return;
      if (ctx.flags.json) out.write(JSON.stringify({ type: "agent_status", text: sanitizeTerm(text) }) + "\n");
      else if (reader && terminal && promptReady) writeManagedChatEvent(out, reader, text);
      else out.write(text);
    },
  };
  try {
    if (!(await ctx.tokens.get())) throw new Error("Sign in with `aether auth login` to sync your agents.");
    if (ctx.flags.local) throw new Error("Managed agents require your Aether account. Omit --local to sync with Cloud.");
    const readiness = await probeManagedReadiness(ctx.api, signal);
    if (readiness.registry.state !== "enabled") { writeGateError(readiness.registry, ctx, deps.err ?? process.stderr); return 1; }
    if (readiness.dm.state !== "enabled") { writeGateError(readiness.dm, ctx, deps.err ?? process.stderr); return 1; }
    if (ctx.flags.json) out.write(JSON.stringify({ type: "readiness", readiness }) + "\n");
    else if (readiness.model_uvt.state !== "enabled") out.write(`Model admission: ${readiness.model_uvt.code}. ${readiness.model_uvt.remedy}\n`);
    let agent = id ? await client.get(id, signal) : await pickManagedAgent(await client.list(signal), out, signal);
    if (!agent) return 0;
    closeSession = await deps.hooks?.beforeChat?.(ctx, agent, surface);
    const thread = await client.thread(agent.agent_id, signal);
    if (typeof thread["id"] !== "string") throw new Error("Cloud did not return a conversation ID.");
    const conversationId = thread["id"];
    const admissionReceipts = new Map<string, MessageAdmission>();
    const send = async (body: string): Promise<boolean> => {
      const nonce = randomUUID();
      let receipt;
      try { receipt = await client.send(agent!.agent_id, conversationId, body, nonce, signal); }
      catch (error) {
        // No automatic replay with a new nonce: the server may already have saved it.
        throw new Error(`${managedAgentError(error)} Delivery is unconfirmed; check the shared conversation before sending again.`);
      }
      const state = receipt.admission?.state ?? "unreported";
      if (receipt.admission) {
        admissionReceipts.set(receipt.id, receipt.admission);
        while (admissionReceipts.size > 1000) admissionReceipts.delete(admissionReceipts.keys().next().value!);
      }
      const accepted = state === "admitted" || state === "replied";
      const code = accepted ? "ADMITTED" : "SEND_NOT_ADMITTED";
      if (ctx.flags.json) out.write(JSON.stringify({ type: "message_admission", code, state }) + "\n");
      else surface.write(theme.dim(renderManagedAdmission(receipt.admission)) + "\n");
      return accepted;
    };
    if (prompt.trim()) return await send(prompt) ? 0 : 1;
    if (!ctx.flags.json) {
      out.write("Shared Online DM · /help · /refresh · /exit\n");
    }
    const seen = new Map<string, string>();
    let polling = false;
    let syncFailed = false;
    let showedEmpty = false;
    let closed = false;
    const ownedInput = terminal ? managedChatInput(inputStream) : undefined;
    const rl = createInterface({ input: ownedInput?.input ?? inputStream, output: out, terminal });
    reader = rl;
    const lines = rl[Symbol.asyncIterator]();
    let inputClosed = false;
    rl.once("close", () => { inputClosed = true; reader = undefined; });
    rl.setPrompt(ctx.flags.json ? "" : theme.cyan("you › "));
    const onResize = (): void => { if (terminal && !inputClosed && !closed) rl.prompt(true); };
    out.on("resize", onResize);
    const refresh = async (redraw = false): Promise<void> => {
      if (polling || closed) return;
      polling = true;
      try {
        const [messages, latest] = await Promise.all([client.messages(agent!.agent_id, conversationId, signal), client.get(agent!.agent_id, signal)]);
        if (closed) return;
        agent = latest;
        contextState = { ...contextState, chat: "synced", checkedAt: Date.now() };
        if (redraw && !ctx.flags.json) surface.write(renderManagedContext(agent!, contextState, (out as Writable & { columns?: number }).columns ?? 80) + "\n");
        if (messages.length === 0 && !ctx.flags.json && !showedEmpty) {
          surface.write("No messages yet. Write to this agent, or use /help for commands.\n");
          showedEmpty = true;
        }
        for (const rawMessage of messages) {
          const message = rawMessage.admission ? rawMessage : { ...rawMessage, admission: admissionReceipts.get(rawMessage.id) };
          const fingerprint = JSON.stringify([message.body, message.admission?.state, message.admission?.run_id]);
          if (seen.get(message.id) === fingerprint) continue;
          const rendered = ctx.flags.json ? JSON.stringify({ type: "message", message }) + "\n" : renderManagedMessage(message, agent!, (out as Writable & { columns?: number }).columns ?? 80);
          if (terminal && reader && promptReady) writeManagedChatEvent(out, rl, rendered);
          else out.write(rendered);
          seen.set(message.id, fingerprint);
          while (seen.size > 1000) seen.delete(seen.keys().next().value!);
        }
        if (syncFailed && !ctx.flags.json) surface.write(theme.dim("Conversation sync restored.\n"));
        syncFailed = false;
      } catch (error) {
        contextState = { ...contextState, chat: "paused" };
        if (!closed && !syncFailed) {
          if (ctx.flags.json) out.write(JSON.stringify({ type: "sync_error", message: managedAgentError(error) }) + "\n");
          else surface.write(theme.yellow("DM sync paused. " + sanitizeTerm(managedAgentError(error)) + " Next: /refresh to retry.") + "\n");
        }
        syncFailed = true;
      } finally {
        polling = false;
      }
    };
    let operations = Promise.resolve();
    const enqueue = (work: () => Promise<void>): Promise<void> => {
      const task = operations.then(async () => { if (!closed && !signal.aborted) await work(); });
      operations = task.catch(() => {});
      return task;
    };
    const removeKeys = terminal && deps.hooks?.cycleMode ? bindManagedAgentKeys(
      ownedInput!.keys,
      () => enqueue(async () => { await deps.hooks!.cycleMode!(ctx, agent!, surface); }),
      () => { if (!closed && !inputClosed) rl.prompt(true); },
      (error) => { surface.write(theme.yellow(sanitizeTerm(managedAgentError(error))) + "\n"); },
    ) : () => {};
    const stop = (): void => { closed = true; controller.abort(); rl.close(); };
    rl.on("SIGINT", stop);
    signal.addEventListener("abort", stop, { once: true });
    try {
      await refresh(true);
      if (terminal) timer = setInterval(() => { void refresh(); }, 3000);
      if (terminal && !inputClosed) { rl.prompt(); promptReady = true; }
      for await (const line of { [Symbol.asyncIterator]: () => lines }) {
        const input = line.trim();
        if (input === "/exit" || input === "/quit") break;
        try {
          await enqueue(async () => {
            if (input === "/refresh") await refresh(true);
            else if (input === "/help") {
              surface.write("Shared Online DM · /refresh checks messages and status · /exit closes chat\n");
              const help = deps.hooks?.help?.(agent!);
              if (help) surface.write(sanitizeTerm(help) + "\n");
              if (isAts(agent!)) surface.write("ATS local preferences do not authorize live orders. RC observation is separate from this DM.\n");
            }
            else if (input.startsWith("/")) {
              if (!(await deps.hooks?.onChatCommand?.(ctx, agent!, input, surface))) {
                surface.write("Unknown command. Use /help for this agent's commands.\n");
              }
            } else if (input) { await send(input); await refresh(); }
          });
        } catch (error) {
          const message = sanitizeTerm(managedAgentError(error));
          if (ctx.flags.json) out.write(JSON.stringify({ type: "command_error", message }) + "\n");
          else surface.write(theme.yellow(message) + "\n");
        }
        if (terminal && !inputClosed) { rl.prompt(); promptReady = true; }
      }
    } finally {
      closed = true;
      reader = undefined;
      promptReady = false;
      removeKeys();
      await operations;
      signal.removeEventListener("abort", stop);
      rl.removeListener("SIGINT", stop);
      out.removeListener("resize", onResize);
      rl.close();
      ownedInput?.dispose();
    }
    return 0;
  } catch (error) {
    if (signal.aborted) return 130;
    const message = sanitizeTerm(managedAgentError(error));
    (deps.err ?? process.stderr).write(ctx.flags.json ? JSON.stringify({ error: message }) + "\n" : `✗ ${message}\n`);
    return 1;
  } finally {
    process.removeListener("SIGINT", onProcessInterrupt);
    surfaceClosed = true;
    if (timer) clearInterval(timer);
    if (closeSession) {
      try { await closeSession(); }
      catch { (deps.err ?? process.stderr).write("Could not close the attached agent session. Check its status before reopening.\n"); }
    }
    controller.abort();
  }
}

export async function cmdManagedAgents(ctx: AppContext, argv: string[], deps: ManagedAgentDeps = {}): Promise<number> {
  const controller = new AbortController();
  const onProcessInterrupt = (): void => controller.abort();
  process.on("SIGINT", onProcessInterrupt);
  deps = { ...deps, signal: deps.signal ? AbortSignal.any([deps.signal, controller.signal]) : controller.signal };
  const out = deps.out ?? process.stdout;
  const client = new ManagedAgentsClient(ctx.api);
  try {
    if (!(await ctx.tokens.get())) throw new Error("Sign in with `aether auth login` to sync your agents.");
    if (ctx.flags.local) throw new Error("Managed agents require your Aether account. Omit --local to sync with Cloud.");
    const [verb = "list", id, ...rest] = argv;
    if (verb === "chat") return await cmdManagedAgentChat(ctx, id, rest.join(" "), deps);
    const readiness = verb === "list" || verb === "show" ? await probeManagedReadiness(ctx.api, deps.signal) : undefined;
    if (readiness?.registry.state !== undefined && readiness.registry.state !== "enabled") {
      writeGateError(readiness.registry, ctx, deps.err ?? process.stderr); return 1;
    }
    if (verb === "list") {
      const agents = await client.list(deps.signal);
      out.write(ctx.flags.json ? JSON.stringify({ readiness, agents }) + "\n" : readinessLine(readiness!) + renderManagedAgents(agents, (out as Writable & { columns?: number }).columns ?? 80));
      return 0;
    }
    let agent: ManagedAgent;
    if (verb === "create") {
      if (id?.toLowerCase() === "ats") {
        if (!deps.hooks?.createATS) throw new Error("ATS setup is unavailable in this build.");
        return await deps.hooks.createATS(ctx, rest.join(" "), deps.signal);
      }
      const name = [id, ...rest].filter(Boolean).join(" ").trim();
      if (!name || name.length > 80) throw new Error("Create an agent with `aether agent create <name>` (1–80 characters).");
      const draft = await createManagedDraft(ctx, { identity: { display_name: name } }, { root: deps.stateRoot, signal: deps.signal });
      agent = draft.agent;
      await draft.complete();
    } else if (verb === "show" || verb === "configure" || ["activate", "pause", "resume", "retire"].includes(verb)) {
      if (!id || !MANAGED_AGENT_ID.test(id)) throw new Error("Choose an ID from `aether agent list`.");
      agent = await client.get(id, deps.signal);
      if (verb === "configure") {
        if (!rest[0] || rest.length < 2) throw new Error(HELP);
        const config = configureManagedAgent(agent.config, rest[0], rest.slice(1).join(" "));
        agent = await client.configure(agent, config, deps.signal);
      } else if (verb !== "show") {
        agent = await client.control(agent, verb as "activate" | "pause" | "resume" | "retire", deps.signal);
      }
    } else { out.write(HELP); return 2; }
    out.write(ctx.flags.json ? JSON.stringify({ ...(readiness ? { readiness } : {}), agent }) + "\n" : (readiness ? readinessLine(readiness) : "") + renderAgent(agent));
    if (verb === "create" && !ctx.flags.json) out.write(theme.dim(`Saved to your account. Configure UVT limits, then activate: aether agent activate ${agent.agent_id}`) + "\n");
    return 0;
  } catch (error) {
    if (deps.signal?.aborted || isAbortError(error)) {
      if (!ctx.flags.json) (deps.err ?? process.stderr).write("Setup canceled.\n");
      return 130;
    }
    const message = sanitizeTerm(managedAgentError(error));
    (deps.err ?? process.stderr).write(ctx.flags.json ? JSON.stringify({ error: message }) + "\n" : `✗ ${message}\n`);
    return 1;
  } finally { process.removeListener("SIGINT", onProcessInterrupt); }
}
