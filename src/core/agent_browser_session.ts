import { openBrowserTyped } from "./browser.js";
import { theme } from "../ui/theme.js";
import { sanitizeTerm, sliceVisible } from "../ui/text.js";
import type { LocalBrowserOwner } from "./managed_agent_local.js";

export interface AgentBrowserStatus {
  state: string;
  viewerState?: string;
  viewUrl?: string | null;
  ageMs?: number | null;
  visionStepsRemaining?: number | null;
  expiresAt?: string | null;
  observation?: { sequence: number; capturedAt: string; origin: string; title: string; screenshotBytes: number; width: number; height: number } | null;
}
export interface AgentBrowserObserver {
  open(input?: { signal?: AbortSignal }): Promise<{ viewUrl: string | null; state: string }>;
  snapshot(input?: { signal?: AbortSignal }): Promise<unknown>;
  close(): Promise<void>;
  status(): AgentBrowserStatus;
  reconcile?(input?: { signal?: AbortSignal }): Promise<unknown>;
}
export interface AgentBrowserRecovery {
  status(): Promise<{ pending: boolean; state: string }>;
}
export interface AgentBrowserPackage {
  createBrowserObserver(input?: Record<string, unknown>): Promise<AgentBrowserObserver>;
  observeBrowser(observer: AgentBrowserObserver, input: { signal: AbortSignal; intervalMs: number }): AsyncIterable<unknown>;
  BrowserSessionRecovery?: new (options: { directory: string; owner: LocalBrowserOwner; baseUrl: string }) => AgentBrowserRecovery;
}
export type BrowserDisplayState = "configured" | "connecting" | "live" | "stale" | "offline" | "busy" | "expired" | "budget-exhausted" | "stopped" | "cleanup-required";
const LOOPBACK = new Set(["127.0.0.1", "[::1]"]);
class BrowserSetupError extends Error {}

/** Tokens belong in environment variables, never in chat history or browser URLs. */
export function browserConnectionEnv(env: NodeJS.ProcessEnv, address?: string): NodeJS.ProcessEnv {
  let url: URL;
  try { url = new URL(address ?? env["AGENT_BROWSER_URL"] ?? "http://127.0.0.1:8092"); }
  catch { throw new BrowserSetupError("Use a browser runtime URL such as http://127.0.0.1:8092."); }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")
      || (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname)))) {
    throw new BrowserSetupError("Use HTTPS or numeric loopback HTTP, with no credentials, path, query or fragment in the runtime URL.");
  }
  if (!LOOPBACK.has(url.hostname) && !env["AGENT_BROWSER_CONTROLLER_TOKEN"]?.trim()) {
    throw new BrowserSetupError("Remote browser access requires AGENT_BROWSER_CONTROLLER_TOKEN in your environment. Keep the token out of chat.");
  }
  return { ...env, AGENT_BROWSER_URL: url.origin };
}

function displayState(status: AgentBrowserStatus): BrowserDisplayState {
  switch (status.state) {
    case "observing": return "live";
    case "connecting": case "stale": return status.state;
    case "connected": return "connecting"; // A session is not visual evidence.
    case "budget_exhausted": return "budget-exhausted";
    case "cleanup_required": return "cleanup-required";
    case "busy": case "expired": return status.state;
    case "closed": return "stopped";
    default: return "offline";
  }
}

export function renderBrowserStatus(state: BrowserDisplayState, status?: AgentBrowserStatus): string {
  const label = state.toUpperCase();
  const badge = state === "live" ? theme.green(`● ${label}`)
    : ["stale", "budget-exhausted", "cleanup-required"].includes(state) ? theme.yellow(`● ${label}`) : theme.cyan(`○ ${label}`);
  const details: string[] = [];
  if (status?.ageMs != null) details.push(`${Math.floor(Math.max(0, status.ageMs) / 1000)}s since verified frame`);
  if (status?.visionStepsRemaining != null) details.push(`${status.visionStepsRemaining} captures left`);
  if (status?.observation) {
    const source = sliceVisible(sanitizeTerm(status.observation.origin).replace(/[\n\t\u202a-\u202e\u2066-\u2069]/g, ""), 65);
    details.push(`${source} · frame ${status.observation.sequence}`);
  }
  const viewer = status?.viewerState === "remote_loopback" ? "Viewer available only on the browser runtime's host."
    : state === "live" ? "Live browser view · observation only" : "Browser view · observation only";
  return [theme.bold("Browser") + `  ${badge}`, details.join(" · "), theme.dim(viewer)].filter(Boolean).join("\n") + "\n";
}

/** Owns one viewer/observer lifecycle. Explicit retry is the only session renewal. */
export class AgentBrowserSession {
  #observer: AgentBrowserObserver | undefined;
  #abort: AbortController | undefined;
  #watching: Promise<void> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #state: BrowserDisplayState = "configured";
  #env: NodeJS.ProcessEnv;
  #closed = false;
  #lastAnnounced = "";
  #generation = 0;
  #busy = false;
  #viewUrl: string | null = null;
  #priorReceipt = false;
  constructor(private readonly deps: {
    load: () => Promise<AgentBrowserPackage>;
    env: NodeJS.ProcessEnv;
    output: (text: string) => void;
    openViewer?: (url: string) => Promise<{ launched: boolean }>;
    signal?: AbortSignal;
    recovery?: { directory: string; owner: LocalBrowserOwner };
    onStatus?: (state: BrowserDisplayState) => void;
  }) {
    this.#env = { ...deps.env };
    try { browserConnectionEnv(this.#env); } catch { this.#state = "offline"; }
  }
  status(): { state: BrowserDisplayState; observation?: AgentBrowserStatus } {
    const observation = this.#observer?.status();
    return { state: this.#priorReceipt ? "cleanup-required" : observation ? displayState(observation) : this.#state, ...(observation ? { observation } : {}) };
  }
  #write(text: string): void { if (!this.#closed) this.deps.output(text); }
  #show(force = false): void {
    if (this.#closed) return;
    const status = this.status();
    this.deps.onStatus?.(status.state);
    const key = `${status.state}:${status.observation?.viewerState ?? ""}`;
    if (!force && key === this.#lastAnnounced) return;
    this.#lastAnnounced = key;
    this.#write(renderBrowserStatus(status.state, status.observation));
  }
  async #prepareObserver(pack: AgentBrowserPackage): Promise<AgentBrowserObserver> {
    let recovery: AgentBrowserRecovery | undefined;
    if (this.deps.recovery) {
      if (typeof pack.BrowserSessionRecovery !== "function") throw new BrowserSetupError("Update the ATS package to use recoverable browser sessions.");
      recovery = new pack.BrowserSessionRecovery({ ...this.deps.recovery, baseUrl: this.#env["AGENT_BROWSER_URL"]! });
      try { this.#priorReceipt = (await recovery.status()).pending; }
      catch (error) {
        this.#priorReceipt = true;
        if ((error as { code?: string })?.code === "BROWSER_RECOVERY_UNKNOWN_CREATE") throw new BrowserSetupError("A previous browser creation has no confirmed cleanup. Idle health cannot release it. Inspect the interrupted request on the recorded runtime; its receipt is retained and replacement remains blocked.");
        throw new BrowserSetupError("Browser recovery storage needs attention. Keep its receipts and use the recorded account, device and runtime to reconcile cleanup before opening another session.");
      }
    }
    return pack.createBrowserObserver({ env: this.#env, ...(recovery ? { recovery } : {}) });
  }
  async #release(reconcilePrior = false): Promise<void> {
    this.#generation++;
    this.#abort?.abort();
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    if (reconcilePrior && !this.#observer && this.deps.recovery) {
      this.#env = browserConnectionEnv(this.#env);
      this.#observer = await this.#prepareObserver(await this.deps.load());
    }
    const observer = this.#observer;
    try {
      if (reconcilePrior && this.#priorReceipt) {
        if (!observer?.reconcile) throw new BrowserSetupError("The browser package cannot reconcile its pending cleanup receipt.");
        await observer.reconcile({ ...(this.deps.signal ? { signal: this.deps.signal } : {}) });
        this.#priorReceipt = false;
      }
      await observer?.close();
      this.#observer = undefined;
      this.#viewUrl = null;
      this.#state = this.#priorReceipt ? "cleanup-required" : "stopped";
    } catch (error) {
      this.#state = "cleanup-required";
      if ((error as { code?: string })?.code === "BROWSER_RECOVERY_UNKNOWN_CREATE") {
        throw new BrowserSetupError("The interrupted browser creation has no confirmed session ID. Inspect that request on the recorded runtime; automatic replacement is blocked until exact cleanup can be established. Its receipt is retained.");
      }
      throw new BrowserSetupError("Browser cleanup needs attention. Use /browser stop to retry releasing this session.");
    } finally { await this.#watching; this.#watching = undefined; }
  }
  async #viewer(): Promise<void> {
    if (this.#closed) return;
    const generation = this.#generation;
    if (!this.#viewUrl) {
      this.#write(this.#observer?.status().viewerState === "remote_loopback"
        ? "The visual viewer stays on the browser runtime's host. Open it there; remote observation can continue here.\n"
        : "The browser viewer is unavailable. Use /browser status.\n");
      return;
    }
    // The package validates the native viewer. Reject credential-bearing URLs
    // again at this launch boundary, and never render its query or fragment.
    const url = new URL(this.#viewUrl);
    if (url.username || url.password || !LOOPBACK.has(url.hostname) || url.protocol !== "http:") {
      this.#write("The runtime did not return a host-local browser viewer.\n"); return;
    }
    try {
      const result = await (this.deps.openViewer ?? openBrowserTyped)(url.toString());
      if (this.#closed || generation !== this.#generation) return;
      this.#write(result.launched ? "Browser viewer launch requested. Visual freshness is shown separately above.\n"
        : `Open the browser viewer on this host: ${url.origin}${url.pathname}\n`);
    } catch { if (!this.#closed && generation === this.#generation) this.#write("Browser viewer could not launch. Observation status is available with /browser status.\n"); }
  }
  async open(): Promise<void> {
    if (this.#closed || this.deps.signal?.aborted) return;
    if (this.#observer) { this.#show(true); if (!this.#priorReceipt) await this.#viewer(); return; }
    this.#env = browserConnectionEnv(this.#env);
    this.#state = "connecting"; this.#show();
    const generation = ++this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    const signal = this.deps.signal ? AbortSignal.any([abort.signal, this.deps.signal]) : abort.signal;
    try {
      const pack = await this.deps.load();
      if (this.#closed || signal.aborted || generation !== this.#generation) return;
      const observer = await this.#prepareObserver(pack);
      this.#observer = observer;
      if (this.#closed || signal.aborted || generation !== this.#generation) { await this.#release(); return; }
      if (this.#priorReceipt) {
        this.#show(true);
        this.#write("A previous browser session needs cleanup. Use /browser stop to release it, or /browser retry to reconcile it before opening a new session.\n");
        return;
      }
      const opened = await observer.open({ signal });
      if (this.#closed || signal.aborted || generation !== this.#generation) { await this.#release(); return; }
      this.#viewUrl = opened.viewUrl;
      this.#show();
      this.#watching = (async () => {
        try {
          for await (const _ of pack.observeBrowser(observer, { signal, intervalMs: 5000 })) {
            if (signal.aborted || this.#closed || generation !== this.#generation) return;
            this.#show();
          }
        } catch {
          if (!signal.aborted && !this.#closed && generation === this.#generation) {
            this.#show();
            this.#write("Browser observation paused. Use /browser retry to close this session and start a new bounded session.\n");
          }
        } finally { if (generation === this.#generation && this.#heartbeat) { clearInterval(this.#heartbeat); this.#heartbeat = undefined; } }
      })();
      this.#heartbeat = setInterval(() => this.#show(), 1000);
      this.#heartbeat.unref();
      await this.#viewer();
    } catch (error) {
      if (this.#priorReceipt) {
        this.#state = "cleanup-required";
        this.#show(true);
        this.#write(`${error instanceof BrowserSetupError ? error.message : "Previous browser cleanup remains unresolved; retain its receipt before retrying."}\n`);
        return;
      }
      const failure = this.#observer?.status().state;
      if (failure === "cleanup_required") {
        this.#state = "cleanup-required";
        this.#show(true);
        this.#write("Browser cleanup is pending. Use /browser stop or /browser retry; its durable receipt is retained.\n");
        return;
      }
      if (failure === "busy") {
        this.#state = "busy"; this.#show(true);
        this.#write("The browser runtime is in use. Finish its current session before retrying this agent.\n");
        return;
      }
      this.#state = "offline";
      try { await this.#release(); this.#state = "offline"; }
      catch { this.#write("Browser cleanup needs attention. Use /browser stop before reconnecting.\n"); }
      this.#show(true);
      if (!this.#closed) this.#write("Browser unavailable. Check the runtime with `npx aether-browser@0.2.2 doctor`, then use /browser retry. Text chat remains available.\n");
    }
  }
  async command(input: string): Promise<boolean> {
    const match = /^\/(?:browser|ats\s+browser)(?:\s+(.*))?$/.exec(input.trim());
    if (!match) return false;
    if (this.#closed) return true;
    if (this.#busy) { this.#write("A browser operation is already in progress.\n"); return true; }
    const [command = "status", ...args] = (match[1] ?? "status").split(/\s+/);
    this.#busy = true;
    try {
      if (command === "status" && args.length === 0) this.#show(true);
      else if (command === "setup" && args.length <= 1) {
        const next = browserConnectionEnv(this.#env, args[0]);
        if (this.#observer || this.deps.recovery) await this.#release(true);
        this.#env = next; this.#state = "configured"; this.#show(true);
        this.#write("Connection configured for this chat. Run `npx aether-browser@0.2.2 doctor` to check the runtime; /browser open connects the live view.\nPersist its address with AGENT_BROWSER_URL. Remote credentials use AGENT_BROWSER_CONTROLLER_TOKEN; keep secrets out of chat.\n");
      } else if (command === "open" && args.length === 0) await this.open();
      else if (command === "retry" && args.length === 0) {
        await this.#release(true);
        this.#write("Starting a new browser session with a fresh bounded vision budget.\n");
        await this.open();
      } else if (command === "stop" && args.length === 0) { await this.#release(true); this.#show(true); }
      else if (command === "refresh" && args.length === 0) {
        if (!this.#observer) { this.#write("Browser is not open. Use /browser open.\n"); return true; }
        try { await this.#observer.snapshot({ ...(this.#abort ? { signal: this.#abort.signal } : {}) }); }
        catch { this.#write("No fresh browser frame is available. Check /browser status before retrying.\n"); }
        this.#show(true);
      } else this.#write("Use /browser status|setup [URL]|open|refresh|stop|retry. Retry starts a new bounded session.\n");
    } catch (error) {
      // Only local validation messages are rendered; remote/package exceptions
      // are handled above and must never turn credentials into transcript text.
      if (!this.#closed) this.#write(`${error instanceof BrowserSetupError ? error.message : "Browser command failed. Use /browser status or /browser stop."}\n`);
    } finally { this.#busy = false; }
    return true;
  }
  async close(): Promise<void> { this.#closed = true; await this.#release(); }
}
