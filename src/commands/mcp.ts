// /mcp — interactive MCP server manager (Claude Code style).
//
// Backend connections (OAuth/PAT providers via the mounted MCP broker) and
// local custom servers (mcp.json → mcp_servers for /agent/mcp-chat) in one
// arrow-key menu. All terminal I/O flows through MenuIO so the screen logic
// is fully testable with scripted keys.

import type { Readable, Writable } from "node:stream";
import type { AppContext } from "../core/context.js";
import type { Key } from "./chat.js";
import { decodeKey } from "./chat.js";
import { McpAuthorizationError, McpClient } from "../core/mcp.js";
import type { McpProvider, McpConnection, StartOAuthResponse } from "../core/mcp.js";
import { LocalMcpStore, sanityCheckUrl } from "../core/mcp_store.js";
import {
  collectMcpDiagnostics,
  redactMcpUrl,
  renderMcpDiagnostics,
  type McpDiagnosticOptions,
} from "../core/mcp_diagnostics.js";
import {
  McpOperationCancelledError,
  McpOperationSupervisor,
  McpOperationTimeoutError,
  probeLocalMcpServer,
  type LocalMcpReachability,
} from "../core/mcp_lifecycle.js";
import { errorMessage } from "../core/errors.js";
import { SelectMenu, renderMenu } from "../ui/menu.js";
import type { MenuItem } from "../ui/menu.js";
import { browserHint, openBrowserTyped, type BrowserOpenResult } from "../core/browser.js";
import { theme } from "../ui/theme.js";
import { sanitizeTerm } from "../ui/text.js";

export interface MenuIO {
  out: Writable;
  nextKey(): Promise<Key>;
  /** Read one line (add/edit prompts, PAT paste; real impl masks when asked). */
  readLine(prompt: string, mask?: boolean): Promise<string>;
  /** Open a URL and say what happened. Typed, because "no browser here" and
   *  "the OS refused the launch" need different words and a different next
   *  step from the operator -- and neither should be a three-minute wait. */
  openUrl(url: string): Promise<BrowserOpenResult>;
  sleep(ms: number): Promise<void>;
  /** Active operations subscribe without consuming ordinary queued keys. */
  subscribeCancel?(cancel: () => void): () => void;
  isClosed?(): boolean;
}

interface Snapshot {
  providers: McpProvider[];
  connections: McpConnection[] | null; // null → broker unavailable
}

export interface McpMenuOptions {
  operationTimeoutMs?: number;
  oauthTimeoutMs?: number;
  localProbe?: (url: string, signal: AbortSignal) => Promise<LocalMcpReachability>;
}

async function boundedMenuOperation<T>(
  supervisor: McpOperationSupervisor,
  io: MenuIO,
  operation: string,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return supervisor.run(operation, work, {
    timeoutMs,
    ...(io.subscribeCancel
      ? { subscribeCancel: (cancel: () => void) => io.subscribeCancel!(cancel) }
      : {}),
  });
}

function rethrowCancellation(error: unknown): void {
  if (error instanceof McpOperationCancelledError) throw error;
}

function safeMcpFailure(error: unknown): string {
  // Allowlist, not blocklist: only messages this CLI composed itself are
  // printable. Anything else could carry text a broker or provider chose, and
  // a terminal is a bad place to render a stranger's string. McpAuthorization
  // Error qualifies -- it is built here from a code and a provider id, and its
  // wording ("already connected and that connection was left untouched") is
  // the whole point of the error, so redacting it to "request failed" would
  // leave the operator unable to tell whether their credential still works.
  if (
    error instanceof McpOperationTimeoutError ||
    error instanceof McpOperationCancelledError ||
    error instanceof McpAuthorizationError
  ) {
    return error.message;
  }
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? `request failed (HTTP ${status})` : "request failed";
}

async function loadSnapshot(
  client: McpClient,
  io: MenuIO,
  supervisor: McpOperationSupervisor,
  timeoutMs: number,
): Promise<Snapshot> {
  try {
    const [providers, connections] = await boundedMenuOperation(
      supervisor,
      io,
      "broker discovery",
      timeoutMs,
      (signal) => Promise.all([
        client.listProviders({ signal, timeoutMs }),
        client.listConnections({ signal, timeoutMs }),
      ]),
    );
    return { providers, connections };
  } catch (error) {
    rethrowCancellation(error);
    return { providers: [], connections: null };
  }
}

const FOOT_MAIN = "↑↓ move · enter manage · a add · q quit";
const FOOT_SUB = "↑↓ move · enter select · q back";

function mainItems(snap: Snapshot, store: LocalMcpStore): MenuItem[] {
  const items: MenuItem[] = [];
  if (snap.connections === null) {
    items.push({ id: "_offline", label: "backend connections unavailable", disabled: true });
  } else {
    for (const p of snap.providers) {
      const connected = snap.connections.some((c) => c.provider_id === p.provider_id);
      items.push({
        id: `b:${p.provider_id}`,
        label: sanitizeTerm(p.display_name),
        glyph: connected ? "✔" : "○",
        hint: connected ? "connected" : p.flow === "pat_paste" ? "needs API key" : "needs OAuth",
      });
    }
  }
  const local = store.list();
  if (local.length > 0) {
    items.push({ id: "_sep", label: "── custom servers ──", disabled: true });
    for (const s of local) {
      items.push({
        id: `l:${s.name}`,
        label: sanitizeTerm(s.name),
        glyph: "●",
        hint: sanitizeTerm(redactMcpUrl(s.url)),
      });
    }
  }
  return items;
}

type MenuPick =
  | { action: "select"; item: MenuItem }
  | { action: "add" }
  | { action: "quit" };

async function pickFromMenu(
  io: MenuIO,
  title: string,
  items: MenuItem[],
  footer: string,
  allowAdd: boolean,
  initialId?: string,
): Promise<MenuPick> {
  const menu = new SelectMenu(items);
  const initial = initialId == null ? -1 : items.findIndex((item) => item.id === initialId && !item.disabled);
  if (initial >= 0) menu.cursor = initial;
  for (;;) {
    io.out.write("\x1b[2J\x1b[H" + renderMenu(title, menu, footer));
    const k = await io.nextKey();
    if (k.kind === "up") menu.up();
    else if (k.kind === "down") menu.down();
    else if (k.kind === "submit") {
      const it = menu.selected();
      if (it) return { action: "select", item: it };
    } else if (k.kind === "char" && k.value.toLowerCase() === "a" && allowAdd) {
      return { action: "add" };
    } else if (
      k.kind === "interrupt" ||
      k.kind === "eof" ||
      k.kind === "ignore" || // bare ESC decodes to ignore
      (k.kind === "char" && k.value.toLowerCase() === "q")
    ) {
      return { action: "quit" };
    }
  }
}

function note(io: MenuIO, msg: string): void {
  if (io.isClosed?.()) return;
  io.out.write(theme.dim(sanitizeTerm(msg).replace(/[\r\n]/g, " ")) + "\n");
}

async function authenticate(
  client: McpClient,
  io: MenuIO,
  providerId: string,
  supervisor: McpOperationSupervisor,
  operationTimeoutMs: number,
  oauthTimeoutMs: number,
): Promise<void> {
  const safeProviderId = sanitizeTerm(providerId);
  let start: StartOAuthResponse;
  try {
    start = await boundedMenuOperation(
      supervisor,
      io,
      `authentication start for ${safeProviderId}`,
      operationTimeoutMs,
      (signal) => client.startOAuth(providerId, { signal, timeoutMs: operationTimeoutMs }),
    );
  } catch (e) {
    rethrowCancellation(e);
    note(io, `auth start failed: ${safeMcpFailure(e)} — selection preserved; retry or run aether mcp doctor`);
    return;
  }
  if (start.flow === "pat_paste") {
    const pat = (await io.readLine(`Paste your ${safeProviderId} API key: `, true)).trim();
    if (!pat) {
      note(io, "cancelled.");
      return;
    }
    try {
      const r = await boundedMenuOperation(
        supervisor,
        io,
        `credential validation for ${safeProviderId}`,
        operationTimeoutMs,
        (signal) => client.patStore(providerId, pat, { signal, timeoutMs: operationTimeoutMs }),
      );
      note(io, r.ok ? `✔ ${safeProviderId} connected` : "✖ credential rejected by the broker");
    } catch (e) {
      rethrowCancellation(e);
      note(io, `✖ credential store failed: ${safeMcpFailure(e)} — retry or re-enter the credential`);
    }
    return;
  }
  if (start.flow === "auth_code_pkce" && start.authorize_url) {
    const urlError = sanityCheckUrl(start.authorize_url);
    if (urlError) { note(io, `auth URL rejected: ${urlError}`); return; }
    // The row as it stands BEFORE the browser opens. Without it, a
    // re-authorization — expired token, widened scope, wrong account — would
    // resolve against the connection that was already there, and the very
    // first poll would print "connected" before the consent screen had even
    // painted. See pollUntilConnected in core/mcp.ts.
    let baseline: McpConnection | null = null;
    try {
      baseline = await boundedMenuOperation(
        supervisor,
        io,
        `connection baseline for ${safeProviderId}`,
        operationTimeoutMs,
        (signal) => client.findConnection(providerId, { signal, timeoutMs: operationTimeoutMs }),
      );
    } catch (e) {
      rethrowCancellation(e);
      // A baseline we could not read is not a reason to refuse the flow, but
      // it IS a reason not to claim a re-authorization succeeded, so the wait
      // below runs unbaselined rather than silently trusting a stale row.
      note(io, `could not read the current ${safeProviderId} connection: ${safeMcpFailure(e)}`);
    }

    io.out.write(
      `Opening browser to authorize ${safeProviderId}…\n` +
        `${theme.dim(sanitizeTerm(redactMcpUrl(start.authorize_url)) + " (authorization parameters hidden)")}\n`,
    );
    const opened = await io.openUrl(start.authorize_url);
    if (!opened.launched) {
      // Waiting three minutes for a browser that was never going to appear is
      // the worst available outcome: it reads as a slow provider.
      note(
        io,
        `✖ browser not opened (${opened.code}): ${browserHint(opened.code)} — ` +
          "authorization was not started",
      );
      return;
    }
    io.out.write("Waiting for authorization…\n");
    try {
      await boundedMenuOperation(
        supervisor,
        io,
        `authorization wait for ${safeProviderId}`,
        oauthTimeoutMs,
        // Deliberately inside the supervisor's bound, not equal to it: the
        // poll owns the message the operator needs ("already connected and
        // left untouched"), and the supervisor is only the backstop for a
        // request that wedges below the HTTP timeout.
        (signal) => client.pollUntilConnected(providerId, io.sleep, {
          signal,
          timeoutMs: Math.max(1, Math.floor(oauthTimeoutMs * 0.9)),
          requestTimeoutMs: operationTimeoutMs,
          since: baseline,
        }),
      );
      note(io, `✔ ${safeProviderId} connected`);
    } catch (e) {
      rethrowCancellation(e);
      // The pending Cloud state row is single-use and expires on its own, so
      // an abandoned flow leaves nothing to clean up here — but the operator
      // still has to be told the code, and whether an older connection lived.
      const code = e instanceof McpAuthorizationError ? ` [${e.code}]` : "";
      note(io, `✖ ${safeMcpFailure(e)}${code} — retry authorization or run aether mcp doctor`);
    }
    return;
  }
  note(io, "unsupported auth flow.");
}

async function confirmChar(io: MenuIO, prompt: string): Promise<boolean> {
  io.out.write(prompt);
  const k = await io.nextKey();
  io.out.write("\n");
  return k.kind === "char" && k.value.toLowerCase() === "y";
}

async function manageBackend(
  client: McpClient,
  io: MenuIO,
  snap: Snapshot,
  providerId: string,
  supervisor: McpOperationSupervisor,
  operationTimeoutMs: number,
  oauthTimeoutMs: number,
): Promise<void> {
  const connected = !!snap.connections?.some((c) => c.provider_id === providerId);
  const items: MenuItem[] = [
    { id: "auth", label: connected ? "Re-authenticate" : "Authenticate", glyph: "🔑" },
    { id: "test", label: "Test connection", glyph: "⟳" },
    ...(connected ? [{ id: "del", label: "Disconnect", glyph: "✖" }] : []),
    { id: "back", label: "Back", glyph: "←" },
  ];
  const safeProviderId = sanitizeTerm(providerId);
  const r = await pickFromMenu(io, `MCP · ${safeProviderId}`, items, FOOT_SUB, false);
  if (r.action !== "select") return;
  switch (r.item.id) {
    case "auth":
      await authenticate(client, io, providerId, supervisor, operationTimeoutMs, oauthTimeoutMs);
      break;
    case "test":
      try {
        const tools = await boundedMenuOperation(
          supervisor,
          io,
          `tool catalog for ${safeProviderId}`,
          operationTimeoutMs,
          (signal) => client.listTools(providerId, { signal, timeoutMs: operationTimeoutMs }),
        );
        note(io, `✔ ${safeProviderId}: ${tools.length} tools available`);
      } catch (e) {
        rethrowCancellation(e);
        note(io, `✖ test failed: ${safeMcpFailure(e)} — selection preserved; try Re-authenticate`);
      }
      break;
    case "del":
      if (await confirmChar(io, `Disconnect ${safeProviderId}? [y/N] `)) {
        try {
          await boundedMenuOperation(
            supervisor,
            io,
            `disconnect for ${safeProviderId}`,
            operationTimeoutMs,
            (signal) => client.disconnect(providerId, { signal, timeoutMs: operationTimeoutMs }),
          );
          note(io, `✔ disconnected ${safeProviderId}`);
        } catch (e) {
          rethrowCancellation(e);
          note(io, `✖ disconnect failed: ${safeMcpFailure(e)} — connection state was not changed locally`);
        }
      }
      break;
  }
}

async function manageLocal(
  store: LocalMcpStore,
  io: MenuIO,
  name: string,
  supervisor: McpOperationSupervisor,
  operationTimeoutMs: number,
  localProbe: (url: string, signal: AbortSignal) => Promise<LocalMcpReachability>,
): Promise<void> {
  const items: MenuItem[] = [
    { id: "test", label: "Test reachability", glyph: "⟳" },
    { id: "edit", label: "Edit URL / token", glyph: "✎" },
    { id: "del", label: "Delete", glyph: "✖" },
    { id: "back", label: "Back", glyph: "←" },
  ];
  const r = await pickFromMenu(io, `MCP · ${sanitizeTerm(name)} (local HTTP/SSE)`, items, FOOT_SUB, false);
  if (r.action !== "select") return;
  const current = store.list().find((s) => s.name === name);
  switch (r.item.id) {
    case "test": {
      const err = current ? sanityCheckUrl(current.url) : "server missing";
      if (err || !current) {
        note(io, `✖ ${err ?? "server missing"}`);
        break;
      }
      try {
        const result = await boundedMenuOperation(
          supervisor,
          io,
          `local reachability test for ${sanitizeTerm(name)}`,
          operationTimeoutMs,
          (signal) => localProbe(current.url, signal),
        );
        note(io, `${result.serviceHealthy ? "✔" : "✖"} ${result.detail}`);
      } catch (error) {
        rethrowCancellation(error);
        note(
          io,
          `✖ ${safeMcpFailure(error)}; no stored credential was sent — selection preserved; ` +
            "retry or run aether mcp doctor",
        );
      }
      break;
    }
    case "edit": {
      const shownUrl = current ? redactMcpUrl(current.url) : "";
      const url = (await io.readLine(`URL [${sanitizeTerm(shownUrl)}]: `)).trim();
      const tok = (await io.readLine("Auth token (blank = keep): ", true)).trim();
      try {
        store.update(name, {
          ...(url ? { url } : {}),
          ...(tok ? { authToken: tok } : {}),
        });
        note(io, "✔ saved");
      } catch (e) {
        note(io, `✖ ${errorMessage(e)}`);
      }
      break;
    }
    case "del":
      if (await confirmChar(io, `Delete ${sanitizeTerm(name)}? [y/N] `)) {
        store.remove(name);
        note(io, `✔ deleted ${name}`);
      }
      break;
  }
}

async function addLocal(store: LocalMcpStore, io: MenuIO): Promise<void> {
  const name = (await io.readLine("Server name: ")).trim();
  if (!name) {
    note(io, "cancelled.");
    return;
  }
  const url = (await io.readLine("Server URL (https://…): ")).trim();
  const tok = (await io.readLine("Auth token (optional): ", true)).trim();
  try {
    store.add({ name, url, transport: "http", ...(tok ? { authToken: tok } : {}) });
    note(io, `✔ added ${name} — stored locally, not yet forwarded to agent chats`);
  } catch (e) {
    note(io, `✖ ${errorMessage(e)}`);
  }
}

/** Main loop. Pure orchestration over injected IO — testable end to end. */
export async function runMcpMenu(
  client: McpClient,
  store: LocalMcpStore,
  io: MenuIO,
  options: McpMenuOptions = {},
): Promise<void> {
  const operationTimeoutMs = options.operationTimeoutMs ?? 10_000;
  const oauthTimeoutMs = options.oauthTimeoutMs ?? 180_000;
  const localProbe = options.localProbe ?? probeLocalMcpServer;
  const supervisor = new McpOperationSupervisor();
  let selectedId: string | undefined;
  try {
    for (;;) {
      const snap = await loadSnapshot(client, io, supervisor, operationTimeoutMs);
      const r = await pickFromMenu(
        io,
        "MCP Servers",
        mainItems(snap, store),
        FOOT_MAIN,
        true,
        selectedId,
      );
      if (r.action === "quit") return;
      if (r.action === "add") {
        await addLocal(store, io);
        continue;
      }
      selectedId = r.item.id;
      const kind = r.item.id.slice(0, 1);
      const id = r.item.id.slice(2);
      if (kind === "b") {
        await manageBackend(
          client,
          io,
          snap,
          id,
          supervisor,
          operationTimeoutMs,
          oauthTimeoutMs,
        );
      } else if (kind === "l") {
        await manageLocal(store, io, id, supervisor, operationTimeoutMs, localProbe);
      }
    }
  } catch (error) {
    if (!(error instanceof McpOperationCancelledError)) throw error;
    note(io, error.message);
  } finally {
    supervisor.dispose();
  }
}

// ── Real-terminal IO + entry points ─────────────────────────────────────────

export function createMcpMenuIO(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): MenuIO & { close(): void } {
  const pending: Array<(k: Key) => void> = [];
  const queue: Key[] = [];
  const cancellationListeners = new Set<() => void>();
  let closed = false;
  const onData = (chunk: Buffer): void => {
    if (closed) return;
    const k = decodeKey(chunk.toString("utf8"));
    if (k.kind === "interrupt" && cancellationListeners.size > 0) {
      for (const cancel of [...cancellationListeners]) {
        try { cancel(); } catch { /* one defective subscriber must not strand the others */ }
      }
      return;
    }
    const w = pending.shift();
    if (w) w(k);
    else queue.push(k);
  };
  input.on("data", onData);
  const io: MenuIO & { close(): void } = {
    out: output,
    nextKey(): Promise<Key> {
      if (closed) return Promise.resolve({ kind: "eof" });
      const q = queue.shift();
      if (q) return Promise.resolve(q);
      return new Promise((res) => pending.push(res));
    },
    async readLine(prompt: string, mask?: boolean): Promise<string> {
      output.write(sanitizeTerm(prompt));
      let acc = "";
      for (;;) {
        const k = await io.nextKey();
        if (k.kind === "submit") {
          if (!closed) output.write("\n");
          return acc;
        }
        if (k.kind === "interrupt" || k.kind === "eof") {
          if (!closed) output.write("\n");
          return "";
        }
        if (k.kind === "backspace") {
          if (acc) {
            acc = acc.slice(0, -1);
            output.write("\b \b");
          }
        } else if (k.kind === "char") {
          acc += k.value;
          output.write(mask ? "*" : sanitizeTerm(k.value));
        }
      }
    },
    openUrl: (u: string) => openBrowserTyped(u),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    subscribeCancel(cancel: () => void): () => void {
      if (closed) {
        cancel();
        return () => {};
      }
      cancellationListeners.add(cancel);
      return () => cancellationListeners.delete(cancel);
    },
    isClosed: () => closed,
    close(): void {
      if (closed) return;
      closed = true;
      input.removeListener("data", onData);
      queue.length = 0;
      for (const cancel of [...cancellationListeners]) {
        try { cancel(); } catch { /* cleanup continues for every subscriber */ }
      }
      cancellationListeners.clear();
      for (const resolve of pending.splice(0)) resolve({ kind: "eof" });
    },
  };
  return io;
}

/** REPL entry: stdin is already in raw mode (chat.ts owns it). */
export async function mcpFromRepl(ctx: AppContext): Promise<void> {
  const io = createMcpMenuIO();
  try {
    await runMcpMenu(new McpClient(ctx.api), new LocalMcpStore(), io);
  } finally {
    io.close();
    process.stdout.write("\x1b[2J\x1b[H");
  }
}

/** Top-level aether mcp. No subcommand retains the interactive manager. */
export interface McpCommandOptions {
  out?: Writable;
  client?: McpClient;
  store?: LocalMcpStore;
  diagnosticOptions?: McpDiagnosticOptions;
  menuOptions?: McpMenuOptions;
}

export async function cmdMcp(
  ctx: AppContext,
  argv: string[] = [],
  options: McpCommandOptions = {},
): Promise<number> {
  const sub = (argv[0] ?? "").toLowerCase();
  const out = options.out ?? process.stdout;
  const client = options.client ?? new McpClient(ctx.api);
  const store = options.store ?? new LocalMcpStore();

  if (sub === "list" || sub === "doctor") {
    const report = await collectMcpDiagnostics(client, store, {
      includeToolCounts: true,
      includeLocalReachability: sub === "doctor",
      ...options.diagnosticOptions,
    });
    out.write(ctx.flags.json ? JSON.stringify(report) + "\n" : renderMcpDiagnostics(report));
    return sub === "doctor" && report.checks.some((check) => check.status === "fail") ? 1 : 0;
  }
  if (sub === "repair") {
    const state = store.inspect();
    if (state.status === "ok" || state.status === "missing") {
      out.write("MCP registry does not need repair.\n");
      return 0;
    }
    const confirmed =
      ctx.flags.yes || (await ctx.confirm("Back up and reset the corrupt MCP registry? [y/N] "));
    if (!confirmed) {
      out.write("MCP registry kept unchanged.\n");
      return 0;
    }
    try {
      const result = store.repair();
      out.write(result.repaired ? "MCP registry backed up and reset.\n" : "MCP registry unchanged.\n");
      return 0;
    } catch {
      out.write("MCP repair failed; original registry remains in place.\n");
      return 1;
    }
  }
  if (sub) {
    out.write("usage: aether mcp [list|doctor|repair]\n");
    return 2;
  }
  if (!process.stdin.isTTY) {
    out.write("aether mcp requires an interactive terminal\n");
    return 1;
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const io = createMcpMenuIO(process.stdin, out);
  try {
    await runMcpMenu(client, store, io, options.menuOptions);
    return 0;
  } finally {
    io.close();
    try {
      process.stdin.setRawMode(false);
    } catch {
      // terminal gone
    }
    process.stdin.pause();
    out.write("\n");
  }
}
