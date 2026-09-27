// Inspection of a real page in an Aether-owned, disposable Edge profile is
// read-only by default. The optional draft port requires a separate host grant
// before it inserts text. No page text, DOM dump, cookies, storage, screenshots,
// or user profile data enters the result. The CLI supplies fixed HTTPS targets.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { childEnv } from "../child_env.js";

export type BrowserInspectState = "rendered" | "login-required" | "redirected" | "http-error" | "failed";
export type BrowserHttpClass = "2xx" | "3xx" | "4xx" | "5xx" | "other";

export interface BrowserInspection {
  schema: "aether.pc.browser-inspect/1";
  state: BrowserInspectState;
  browserLaunched: boolean;
  navigationAttempted: boolean;
  mainDocumentHttpClass: BrowserHttpClass | null;
  requestedOrigin: string;
  finalOrigin: string | null;
  documentDigest: string | null;
  structure: {
    title: boolean;
    main: boolean;
    heading: boolean;
    navigation: boolean;
    form: boolean;
    passwordField: boolean;
  } | null;
  reason: string;
  profileCleaned: boolean;
  observedAt: string;
}

export interface BrowserInspectOptions {
  /** Tests may inspect a loopback fixture. The CLI never enables this. */
  allowHttpLoopback?: boolean;
  /** Headless is for qualification tests; the CLI opens a visible browser. */
  headless?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** A single observed composer in the controlled page. No page text is exposed. */
export interface BrowserDraftPort {
  readonly identity: string;
  readonly kind: "textarea" | "contenteditable";
  readonly origin: string;
  /** Returns "stale" if the document, tab, element, or empty state changed. */
  observe(): Promise<string>;
  /** Call only inside the approved gateway effect. */
  insert(text: string): Promise<{ dispatched: boolean; verified: boolean }>;
}

interface DevtoolsPort { port: number; browserPath: string }
interface PageTarget { type?: unknown; webSocketDebuggerUrl?: unknown }
interface CdpMessage { id?: number; method?: unknown; params?: unknown; result?: unknown; error?: unknown }
interface DocumentResponse { frameId: string; loaderId: string; httpClass: BrowserHttpClass }

const SCHEMA = "aether.pc.browser-inspect/1" as const;
const POLL_MS = 100;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Edge Stable only for the first qualified Windows driver. */
export function controlledEdgeExecutable(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  if (platform !== "win32") return null;
  const candidates = [
    join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(env["ProgramFiles"] ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    ...(env["LOCALAPPDATA"] ? [join(env["LOCALAPPDATA"], "Microsoft", "Edge", "Application", "msedge.exe")] : []),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 60_000) throw new Error("invalid browser inspection timeout");
  return value;
}

function httpClass(status: number): BrowserHttpClass {
  const hundreds = Math.floor(status / 100);
  return hundreds >= 2 && hundreds <= 5 ? `${hundreds}xx` as BrowserHttpClass : "other";
}

function inspectedUrl(raw: string, allowHttpLoopback: boolean): URL {
  const url = new URL(raw);
  const localFixture = allowHttpLoopback && url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if ((url.protocol !== "https:" && !localFixture) || url.username || url.password || url.hash) {
    throw new Error("browser inspection requires a clean HTTPS target");
  }
  return url;
}

function remaining(deadline: number, maxMs = 3_000): number {
  const ms = Math.min(maxMs, deadline - Date.now());
  if (ms < 1) throw new Error("browser inspection timed out");
  return ms;
}

async function pause(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
}

async function readDevtoolsPort(dir: string, child: ChildProcess, deadline: number, signal?: AbortSignal): Promise<DevtoolsPort> {
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("cancelled");
    if (child.exitCode !== null) throw new Error("controlled browser exited before inspection");
    try {
      const lines = (await readFile(join(dir, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
      const port = Number(lines[0]);
      const browserPath = lines[1] ?? "";
      if (Number.isSafeInteger(port) && port > 0 && port <= 65_535 &&
          /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(browserPath)) return { port, browserPath };
    } catch { /* browser startup has not written the file yet */ }
    await pause();
  }
  throw new Error("controlled browser did not start in time");
}

async function pageWebSocket(port: number, deadline: number, signal?: AbortSignal): Promise<string> {
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("cancelled");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(remaining(deadline, 1_000)) });
      if (!response.ok) throw new Error("DevTools target list unavailable");
      const targets = await response.json() as PageTarget[];
      const raw = targets.find((item) => item.type === "page")?.webSocketDebuggerUrl;
      if (typeof raw === "string") {
        const ws = new URL(raw);
        if (ws.protocol === "ws:" && (ws.hostname === "127.0.0.1" || ws.hostname === "localhost") &&
            Number(ws.port) === port && ws.pathname.startsWith("/devtools/page/")) return raw;
      }
    } catch { /* the browser is still starting; never print its response */ }
    await pause();
  }
  throw new Error("controlled page target unavailable");
}

async function pageCount(port: number, deadline: number): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(remaining(deadline, 1_000)),
  });
  if (!response.ok) throw new Error("controlled browser target list unavailable");
  const targets = await response.json() as PageTarget[];
  if (!Array.isArray(targets)) throw new Error("controlled browser target list invalid");
  return targets.filter((target) => target.type === "page").length;
}

class CdpConnection {
  private sequence = 0;
  private eventHandler: ((method: string, params: unknown) => void) | null = null;
  private readonly pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message: CdpMessage;
      try { message = JSON.parse(event.data) as CdpMessage; } catch { return; }
      if (typeof message.method === "string") {
        this.eventHandler?.(message.method, message.params);
        return;
      }
      if (!Number.isSafeInteger(message.id)) return;
      const waiting = this.pending.get(message.id!);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      this.pending.delete(message.id!);
      if (message.error) waiting.reject(new Error(`browser protocol refused ${waiting.method}`));
      else waiting.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const waiting of this.pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error("controlled browser connection closed"));
      }
      this.pending.clear();
    });
  }

  onEvent(handler: (method: string, params: unknown) => void): void { this.eventHandler = handler; }

  static async connect(url: string, deadline: number): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("controlled browser connection timed out")); }, remaining(deadline));
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("controlled browser connection failed")); }, { once: true });
    });
    return new CdpConnection(socket);
  }

  command(method: string, params: Record<string, unknown>, deadline: number, maxMs = 10_000): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("controlled browser connection closed");
    const id = ++this.sequence;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("browser inspection timed out"));
      }, remaining(deadline, maxMs));
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void { this.socket.close(); }
}

interface FrameIdentity { id: string; loaderId: string; url: string }

async function frameIdentity(cdp: CdpConnection, deadline: number): Promise<FrameIdentity> {
  const response = await cdp.command("Page.getFrameTree", {}, deadline) as { frameTree?: { frame?: FrameIdentity } };
  const frame = response?.frameTree?.frame;
  if (!frame || typeof frame.id !== "string" || typeof frame.loaderId !== "string" || typeof frame.url !== "string") {
    throw new Error("controlled page frame identity unavailable");
  }
  return frame;
}

async function readyState(cdp: CdpConnection, deadline: number): Promise<string> {
  const response = await cdp.command("Runtime.evaluate", {
    expression: "document.readyState", returnByValue: true, silent: true,
  }, deadline) as { result?: { value?: unknown } };
  return typeof response?.result?.value === "string" ? response.result.value : "unknown";
}

async function structure(cdp: CdpConnection, deadline: number): Promise<NonNullable<BrowserInspection["structure"]>> {
  const response = await cdp.command("DOM.getDocument", { depth: 0, pierce: false }, deadline) as { root?: { nodeId?: unknown } };
  const root = response?.root?.nodeId;
  if (typeof root !== "number" || root < 1) throw new Error("controlled page structure unavailable");
  const selectors = {
    title: "title", main: "main", heading: "h1", navigation: "nav", form: "form",
    passwordField: 'input[type="password"]',
  } as const;
  const flags = {} as NonNullable<BrowserInspection["structure"]>;
  for (const [name, selector] of Object.entries(selectors)) {
    const found = await cdp.command("DOM.querySelector", { nodeId: root, selector }, deadline) as { nodeId?: unknown };
    flags[name as keyof typeof flags] = typeof found?.nodeId === "number" && found.nodeId > 0;
  }
  return flags;
}

async function draftPort(
  cdp: CdpConnection, port: DevtoolsPort, frame: FrameIdentity, origin: string,
  deadline: number, hasUnexpectedPage: () => boolean, isCancelled: () => boolean,
): Promise<BrowserDraftPort | null> {
  const response = await cdp.command("DOM.getDocument", { depth: 0, pierce: false }, deadline) as { root?: { nodeId?: unknown } };
  const root = response?.root?.nodeId;
  if (typeof root !== "number" || root < 1) return null;
  const matches = await cdp.command("DOM.querySelectorAll", {
    nodeId: root, selector: 'textarea, [contenteditable="true"]',
  }, deadline) as { nodeIds?: unknown };
  if (!Array.isArray(matches?.nodeIds) || matches.nodeIds.length !== 1 ||
      typeof matches.nodeIds[0] !== "number") return null;
  const nodeId = matches.nodeIds[0] as number;
  const described = await cdp.command("DOM.describeNode", { nodeId, depth: 0 }, deadline) as {
    node?: { backendNodeId?: unknown; nodeName?: unknown; attributes?: unknown };
  };
  const backendId = described?.node?.backendNodeId;
  const name = described?.node?.nodeName;
  const attributes = described?.node?.attributes;
  if (typeof backendId !== "number" || !Number.isSafeInteger(backendId) || backendId < 1 ||
      typeof name !== "string" || !Array.isArray(attributes)) return null;
  const kind = name.toUpperCase() === "TEXTAREA" ? "textarea" :
    attributes.some((value, index) => index % 2 === 0 && value === "contenteditable" &&
      attributes[index + 1] === "true") ? "contenteditable" : null;
  if (!kind) return null;
  const identity = createHash("sha256")
    .update(`${frame.id}:${frame.loaderId}:${frame.url}:${backendId}:${kind}`)
    .digest("hex").slice(0, 24);
  const world = await cdp.command("Page.createIsolatedWorld", {
    frameId: frame.id, worldName: "aether-pc-draft",
  }, deadline) as { executionContextId?: unknown };
  const contextId = world?.executionContextId;
  if (typeof contextId !== "number" || !Number.isSafeInteger(contextId) || contextId < 1) return null;

  const elementMatches = async (expectedText?: string): Promise<boolean> => {
    const current = await frameIdentity(cdp, deadline);
    if (isCancelled() || current.id !== frame.id || current.loaderId !== frame.loaderId || current.url !== frame.url ||
        new URL(current.url).origin !== origin || hasUnexpectedPage() ||
        await pageCount(port.port, deadline) !== 1) return false;
    const fresh = await cdp.command("DOM.getDocument", { depth: 0, pierce: false }, deadline) as { root?: { nodeId?: unknown } };
    const freshRoot = fresh?.root?.nodeId;
    if (typeof freshRoot !== "number" || freshRoot < 1) return false;
    const found = await cdp.command("DOM.querySelectorAll", {
      nodeId: freshRoot, selector: 'textarea, [contenteditable="true"]',
    }, deadline) as { nodeIds?: unknown };
    if (!Array.isArray(found?.nodeIds) || found.nodeIds.length !== 1 || typeof found.nodeIds[0] !== "number") return false;
    const freshId = found.nodeIds[0] as number;
    const detail = await cdp.command("DOM.describeNode", { nodeId: freshId, depth: 0 }, deadline) as {
      node?: { backendNodeId?: unknown };
    };
    if (detail?.node?.backendNodeId !== backendId) return false;
    try {
      const box = await cdp.command("DOM.getBoxModel", { nodeId: freshId }, deadline) as {
        model?: { width?: unknown; height?: unknown };
      };
      if (typeof box?.model?.width !== "number" || box.model.width <= 0 ||
          typeof box.model.height !== "number" || box.model.height <= 0) return false;
    }
    catch { return false; }
    const resolved = await cdp.command("DOM.resolveNode", {
      nodeId: freshId, executionContextId: contextId,
    }, deadline) as { object?: { objectId?: unknown } };
    const objectId = resolved?.object?.objectId;
    if (typeof objectId !== "string") return false;
    // The fixed probe runs in an isolated world and returns a boolean only.
    // Existing composer content never reaches the host or the audit journal.
    const expression = kind === "textarea"
      ? "function(expected) { return this.isConnected && !this.disabled && !this.readOnly && this.value === expected; }"
      : "function(expected) { return this.isConnected && this.isContentEditable && this.textContent === expected; }";
    const probe = await cdp.command("Runtime.callFunctionOn", {
      objectId, functionDeclaration: expression, arguments: [{ value: expectedText ?? "" }],
      returnByValue: true, silent: true,
    }, deadline) as { result?: { value?: unknown } };
    if (probe?.result?.value !== true) return false;
    const confirmed = await frameIdentity(cdp, deadline);
    return confirmed.id === frame.id && confirmed.loaderId === frame.loaderId &&
      confirmed.url === frame.url && !hasUnexpectedPage();
  };

  if (!await elementMatches()) return null;
  return {
    identity, kind, origin,
    observe: async () => await elementMatches() ? identity : "stale",
    insert: async (text) => {
      if (text.length < 1 || text.length > 2000 || /[\r\n\0]/.test(text)) {
        return { dispatched: false, verified: false };
      }
      if (!await elementMatches()) return { dispatched: false, verified: false };
      await cdp.command("DOM.focus", { backendNodeId: backendId }, deadline);
      if (!await elementMatches()) return { dispatched: true, verified: false };
      await cdp.command("Input.insertText", { text }, deadline);
      return { dispatched: true, verified: await elementMatches(text) };
    },
  };
}

function newResult(origin: string): BrowserInspection {
  return {
    schema: SCHEMA, state: "failed", browserLaunched: false, navigationAttempted: false,
    mainDocumentHttpClass: null,
    requestedOrigin: origin, finalOrigin: null,
    documentDigest: null, structure: null, reason: "inspection did not complete",
    profileCleaned: false, observedAt: new Date().toISOString(),
  };
}

async function closeBrowser(child: ChildProcess | null, profileDir: string, port: DevtoolsPort | null): Promise<boolean> {
  if (port) {
    try {
      const cdp = await CdpConnection.connect(`ws://127.0.0.1:${port.port}${port.browserPath}`, Date.now() + 1_500);
      await cdp.command("Browser.close", {}, Date.now() + 1_500).catch(() => {});
      cdp.close();
    } catch { /* fall through to owned process handle */ }
  }
  if (child?.exitCode === null) child.kill();
  const absolute = resolve(profileDir);
  const tempRoot = resolve(tmpdir()) + sep;
  if (!absolute.startsWith(tempRoot) || !absolute.split(sep).at(-1)?.startsWith("aether-pc-browser-")) return false;
  try {
    if ((await lstat(absolute)).isSymbolicLink()) return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  // Edge helpers can briefly retain files after Browser.close on Windows.
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await rm(absolute, { recursive: true, force: true }); return true; }
    catch { await pause(); }
  }
  return false;
}

/** Inspect a selected page without taking browser actions or reading content. */
export async function inspectControlledPage(
  rawUrl: string, options: BrowserInspectOptions = {},
  onDraftReady?: (port: BrowserDraftPort) => Promise<void>,
): Promise<BrowserInspection> {
  const requested = inspectedUrl(rawUrl, options.allowHttpLoopback ?? false);
  const result = newResult(requested.origin);
  if (options.signal?.aborted) return { ...result, reason: "controlled browser inspection cancelled", profileCleaned: true };
  const executable = controlledEdgeExecutable();
  if (!executable) return { ...result, reason: "controlled Edge driver unavailable", profileCleaned: true };
  let deadline = Date.now() + boundedTimeout(options.timeoutMs);
  const profileDir = await mkdtemp(join(tmpdir(), "aether-pc-browser-"));
  const args = [
    `--user-data-dir=${profileDir}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-extensions",
    "--disable-background-networking", ...(options.headless ? ["--headless=new"] : []), "about:blank",
  ];
  let child: ChildProcess | null = null;
  let port: DevtoolsPort | null = null;
  let cdp: CdpConnection | null = null;
  let browserControl: CdpConnection | null = null;
  const documentResponses: DocumentResponse[] = [];
  let unexpectedPage = false;
  let monitorArmed = false;
  let phase = "launch";
  const onAbort = () => {
    cdp?.close();
    browserControl?.close();
    if (child?.exitCode === null) child.kill();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (options.signal?.aborted) throw new Error("cancelled");
    child = spawn(executable, args, { shell: false, windowsHide: options.headless ?? false, stdio: "ignore", env: childEnv() });
    result.browserLaunched = child.pid !== undefined;
    // A policy or filesystem race can make spawn fail after the executable check.
    // Observe the error so it never becomes an unhandled process exception.
    child.on("error", () => {});
    port = await readDevtoolsPort(profileDir, child, deadline, options.signal);
    phase = "download denial";
    browserControl = await CdpConnection.connect(`ws://127.0.0.1:${port.port}${port.browserPath}`, deadline);
    // A site can initiate a download while being visited. Refuse it before
    // navigation so read-only inspection cannot write to the user's Downloads.
    await browserControl.command("Browser.setDownloadBehavior", { behavior: "deny" }, deadline);
    phase = "page target monitor";
    browserControl.onEvent((method, params) => {
      if (!monitorArmed || method !== "Target.targetCreated") return;
      const info = (params as { targetInfo?: { type?: unknown } } | null)?.targetInfo;
      if (info?.type === "page") unexpectedPage = true;
    });
    await browserControl.command("Target.setDiscoverTargets", { discover: true }, deadline);
    const initial = await browserControl.command("Target.getTargets", {}, deadline) as { targetInfos?: Array<{ type?: unknown }> };
    if (initial?.targetInfos?.filter((target) => target.type === "page").length !== 1) {
      throw new Error("controlled browser did not start with exactly one page");
    }
    phase = "target discovery";
    const ws = await pageWebSocket(port.port, deadline, options.signal);
    phase = "protocol connection";
    cdp = await CdpConnection.connect(ws, deadline);
    phase = "Page.enable";
    await cdp.command("Page.enable", {}, deadline);
    cdp.onEvent((method, params) => {
      if (method !== "Network.responseReceived") return;
      const event = params as { type?: unknown; frameId?: unknown; loaderId?: unknown; response?: { status?: unknown } } | null;
      if (event?.type !== "Document" || typeof event.frameId !== "string" ||
          typeof event.loaderId !== "string" || typeof event.response?.status !== "number" ||
          !Number.isFinite(event.response.status)) return;
      documentResponses.push({
        frameId: event.frameId, loaderId: event.loaderId,
        httpClass: httpClass(event.response.status),
      });
      if (documentResponses.length > 16) documentResponses.shift();
    });
    await cdp.command("Network.enable", {}, deadline);
    phase = "Page.navigate";
    monitorArmed = true;
    result.navigationAttempted = true;
    const navigation = await cdp.command("Page.navigate", { url: requested.href }, deadline, 35_000) as { errorText?: unknown };
    if (typeof navigation?.errorText === "string") throw new Error("controlled browser navigation failed");
    phase = "document readiness";
    let frame: FrameIdentity | null = null;
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw new Error("cancelled");
      try {
        frame = await frameIdentity(cdp, deadline);
        if (frame.url !== "about:blank" && await readyState(cdp, deadline) === "complete") break;
      } catch { /* navigation may replace the execution context */ }
      await pause();
    }
    if (!frame || frame.url === "about:blank") throw new Error("controlled page did not finish loading");
    const final = new URL(frame.url);
    if (final.origin !== requested.origin) {
      result.state = "redirected";
      result.reason = "page navigated outside the approved origin; no structure was inspected";
      return result;
    }
    phase = "main document status";
    const mainResponse = [...documentResponses].reverse().find((response) =>
      response.frameId === frame.id && response.loaderId === frame.loaderId);
    if (!mainResponse) throw new Error("main document HTTP status unavailable");
    result.mainDocumentHttpClass = mainResponse.httpClass;
    if (mainResponse.httpClass !== "2xx") {
      result.state = "http-error";
      result.finalOrigin = final.origin;
      result.reason = `main document returned HTTP ${mainResponse.httpClass}`;
      return result;
    }
    phase = "structure inspection";
    const flags = await structure(cdp, deadline);
    phase = "document recheck";
    const after = await frameIdentity(cdp, deadline);
    if (after.id !== frame.id || after.loaderId !== frame.loaderId || after.url !== frame.url) {
      throw new Error("controlled page changed during inspection");
    }
    const finalPageCount = await pageCount(port.port, deadline);
    await pause(); // Let queued target-created events reach the browser socket.
    if (unexpectedPage || finalPageCount !== 1) {
      throw new Error("controlled browser opened an unexpected page");
    }
    result.state = flags.passwordField || /(?:^|\/)(?:login|sign-?in|auth)(?:\/|$)/i.test(final.pathname)
      ? "login-required" : "rendered";
    result.finalOrigin = final.origin;
    result.documentDigest = createHash("sha256").update(`${after.id}:${after.loaderId}`).digest("hex").slice(0, 16);
    result.structure = flags;
    result.reason = result.state === "login-required" ? "login form or route observed; authentication not verified"
      : "page rendered; authentication not verified";
    if (onDraftReady && result.state === "rendered") {
      phase = "draft composer observation";
      // The first deadline covers browser startup/navigation. Give the
      // separate human approval its own bounded window after observation.
      deadline = Date.now() + 60_000;
      const composer = await draftPort(cdp, port, after, final.origin, deadline,
        () => unexpectedPage, () => options.signal?.aborted ?? false);
      if (composer) await onDraftReady(composer);
    }
    if (options.signal?.aborted) throw new Error("cancelled");
    return result;
  } catch (error) {
    result.state = "failed";
    result.structure = null;
    result.documentDigest = null;
    result.reason = options.signal?.aborted ? "controlled browser inspection cancelled" : error instanceof Error && /timed out/i.test(error.message)
      ? `controlled browser inspection timed out during ${phase}` : `controlled browser inspection failed during ${phase}`;
    return result;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    cdp?.close();
    browserControl?.close();
    result.profileCleaned = await closeBrowser(child, profileDir, port);
    if (!result.profileCleaned) {
      result.state = "failed";
      result.reason = "controlled browser profile cleanup failed";
      result.structure = null;
      result.documentDigest = null;
    }
  }
}
