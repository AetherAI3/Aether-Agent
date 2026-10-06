import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import type { AppContext } from "../core/context.js";
import type { CommandFlags } from "../core/command_dispatch.js";
import { openBrowserChecked } from "../core/browser.js";
import type { OpenOutcome } from "../core/opener.js";
import {
  commandDigest, isLoopbackUrl, parsePreviewState, PREVIEW_SCHEMA, previewPathStillNames, previewPaths,
  readStablePreviewFile, sanitizePreviewText,
  validatePreviewCommand, type PreviewCommand, type PreviewLaunch, type PreviewState,
} from "../core/preview_contract.js";
import { terminateProcessTree } from "../core/process_tree_kill.js";
import { openRcPreviewPublisher, type RcPreviewPublisher } from "../core/rc/preview.js";
import { previewDisplayUrl, type PreviewDisplayPhase } from "../core/rc/producers.js";
import { projectRefFor, rcOutboxPath } from "./rc.js";

export const PREVIEW_EXIT = { ok: 0, usage: 2, declined: 20, unsafe: 21, notRunning: 22, launchFailed: 23, timeout: 24, controlFailed: 25 } as const;

export interface PreviewOptions {
  command?: string;
  args?: string[];
  readyUrl?: string;
  previewCwd?: string;
  timeoutMs?: string;
  noOpen?: boolean;
  out?: Writable;
  err?: Writable;
  /** Test seam for the existing safe opener; production uses openBrowserChecked. */
  open?: (url: string) => OpenOutcome;
  /** Test seam for RC publication: the outbox location, and a hook that
   *  receives the publisher so a test can await uploads the command never does. */
  rc?: { outboxPath?: string; opened?: (publisher: RcPreviewPublisher) => void };
}

interface ProjectPreviewFile {
  version: 1;
  command: string;
  args?: string[];
  cwd?: string;
  readyUrl?: string;
  timeoutMs?: number;
  /** Where viewers may reach this preview. Declared, never discovered: the
   *  supervisor only ever learns a loopback URL, which stays local. */
  publicUrl?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function writePrivate(path: string, value: string): void {
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs are authoritative. */ }
}

function loadDeclared(projectRoot: string): ProjectPreviewFile {
  const path = join(projectRoot, ".aether", "preview.json");
  if (!existsSync(path)) throw new Error("no preview command was supplied and .aether/preview.json is absent");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 32_768) throw new Error("refusing unsafe .aether/preview.json");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(".aether/preview.json must be an object");
  const v = value as Record<string, unknown>;
  if (v["version"] !== 1 || typeof v["command"] !== "string" ||
      (v["args"] !== undefined && (!Array.isArray(v["args"]) || !(v["args"] as unknown[]).every((item) => typeof item === "string"))) ||
      (v["cwd"] !== undefined && typeof v["cwd"] !== "string") ||
      (v["readyUrl"] !== undefined && typeof v["readyUrl"] !== "string") ||
      (v["timeoutMs"] !== undefined && !Number.isInteger(v["timeoutMs"]))) {
    throw new Error("invalid .aether/preview.json contract");
  }
  // `publicUrl` is validated where it is used (publicUrlRefused): it only
  // matters to an RC session, so it must not break a purely local preview.
  return value as ProjectPreviewFile;
}

const PUBLIC_URL_RULE =
  "must be a public https:// origin and path without credentials, query, fragment, IP address, " +
  "private or loopback-resolving host name, or token-shaped segment";

/** The declared publicUrl when it passes the viewer-link projection. */
function safePublicUrl(declared: ProjectPreviewFile): string | undefined {
  const raw: unknown = declared.publicUrl;
  return typeof raw === "string" && previewDisplayUrl(raw, isLoopbackUrl) !== undefined ? raw : undefined;
}

/** True when the declaration carries a publicUrl the projection refuses. */
function publicUrlRefused(projectRoot: string): boolean {
  const declared = loadDeclared(projectRoot);
  return declared.publicUrl !== undefined && safePublicUrl(declared) === undefined;
}

/**
 * The declared public URL, but only for the declared preview.
 *
 * Bound to the command digest so a preview launched from an ad-hoc `--command`
 * (or with overridden flags) never borrows a URL somebody declared for a
 * different process. Any failure reads as "no public URL".
 */
function declaredPublicUrl(projectRoot: string, digest: string): string | undefined {
  try {
    const url = safePublicUrl(loadDeclared(projectRoot));
    if (url === undefined) return undefined;
    return commandDigest(resolvePreviewCommand(projectRoot, {})) === digest ? url : undefined;
  } catch {
    return undefined;
  }
}

type PreviewIdentity = Pick<PreviewState, "instanceId" | "commandDigest">;

interface PreviewRc {
  /** Report a phase this command observed or caused; never throws. */
  observe(preview: PreviewIdentity, phase: PreviewDisplayPhase): void;
  /** Whether an RC session is active for this project (opens the publisher). */
  active(): boolean;
}

/**
 * Report observed phases to an active RC session, if there is one.
 *
 * The publisher opens lazily, keyed exactly as `aether rc` keys its outbox
 * (the resolved, not realpath'd, cwd). It enqueues durably and never waits for
 * the upload, so a slow or absent broker cannot change or delay a result.
 */
function previewRc(ctx: AppContext, options: PreviewOptions, projectRoot: string): PreviewRc {
  let publisher: RcPreviewPublisher | null | undefined;
  const open = (): RcPreviewPublisher | null => {
    if (publisher === undefined) {
      try {
        const rcRoot = resolve(ctx.flags.cwd);
        publisher = openRcPreviewPublisher(ctx.api, rcRoot, options.rc?.outboxPath ?? rcOutboxPath(projectRefFor(rcRoot)));
        if (publisher) options.rc?.opened?.(publisher);
      } catch {
        publisher = null;
      }
    }
    return publisher;
  };
  return {
    observe(preview, phase): void {
      try {
        const opened = open();
        if (!opened) return;
        const publicUrl = phase === "ready" ? declaredPublicUrl(projectRoot, preview.commandDigest) : undefined;
        opened.observe({ phase, instanceId: preview.instanceId, ...(publicUrl ? { publicUrl } : {}) });
      } catch {
        // RC observation never changes a preview result.
      }
    },
    active: () => open() !== null,
  };
}

/**
 * Publish `stopped` once the supervisor's state file is gone (the proof
 * `preview stop` waits for) without holding the command: the poll is bounded
 * and unref'd. Unconfirmed cleanup leaves the viewer at `stopping`, the truth.
 */
function publishStoppedWhenGone(statePath: string, publish: () => void, attempts = 50): void {
  if (!existsSync(statePath)) { publish(); return; }
  if (attempts <= 0) return;
  setTimeout(() => publishStoppedWhenGone(statePath, publish, attempts - 1), 100).unref();
}

export function resolvePreviewCommand(projectRoot: string, options: PreviewOptions): PreviewCommand {
  const explicit = options.command !== undefined;
  const declared = explicit ? undefined : loadDeclared(projectRoot);
  const timeoutRaw = options.timeoutMs === undefined ? declared?.timeoutMs ?? 30_000 : Number(options.timeoutMs);
  return validatePreviewCommand({
    executable: options.command ?? declared!.command,
    args: options.args ?? declared?.args ?? [],
    cwd: options.previewCwd ?? declared?.cwd ?? ".",
    ...(options.readyUrl ?? declared?.readyUrl ? { readyUrl: options.readyUrl ?? declared?.readyUrl } : {}),
    timeoutMs: Number(timeoutRaw),
  }, projectRoot);
}

function readState(path: string): PreviewState | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try { raw = JSON.parse(readStablePreviewFile(path, 32_768).bytes.toString("utf8")); }
  catch { throw new Error("preview state is malformed or unstable; remove it only after checking no preview is active"); }
  const state = parsePreviewState(raw);
  if (!state) throw new Error("preview state failed schema validation; refusing to trust its PID or control endpoint");
  return state;
}

export type ControlResult =
  | { kind: "ok"; state: PreviewState }
  | { kind: "unreachable" };

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves a process exists even though this account cannot signal it.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function removeOwnedState(path: string, instanceId: string): boolean {
  try {
    const stable = readStablePreviewFile(path, 32_768);
    const state = parsePreviewState(JSON.parse(stable.bytes.toString("utf8")));
    if (state?.instanceId !== instanceId || !previewPathStillNames(path, stable.identity)) return false;
    unlinkSync(path);
    return true;
  } catch { return false; }
}

function removeOwnedControlRequest(path: string, requestId: string): void {
  try {
    if (!existsSync(path)) return;
    const stable = readStablePreviewFile(path, 1_024);
    const value: unknown = JSON.parse(stable.bytes.toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value) &&
        (value as Record<string, unknown>)["requestId"] === requestId &&
        previewPathStillNames(path, stable.identity)) unlinkSync(path);
  } catch { /* another process consumed it or the file is not ours */ }
}

export async function previewControlRequest(
  state: PreviewState,
  statePath: string,
  method: "GET" | "POST",
  path: "/status" | "/stop",
): Promise<ControlResult> {
  const requestId = randomUUID();
  const requestPath = join(dirname(statePath), `control-${requestId}.json`);
  let ownsRequest = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    writePrivate(requestPath, JSON.stringify({ schema: PREVIEW_SCHEMA, requestId, instanceId: state.instanceId, method, path }));
    ownsRequest = true;
    const response = await fetch(`http://127.0.0.1:${state.controlPort}${path}`, {
      method, headers: { "x-aether-preview-control": requestId }, signal: controller.signal,
    });
    if (!response.ok) return { kind: "unreachable" };
    const body: unknown = await response.json();
    if (path === "/stop") return { kind: "ok", state };
    const checked = parsePreviewState(body);
    return checked?.instanceId === state.instanceId && checked.projectRoot === state.projectRoot &&
      checked.commandDigest === state.commandDigest ? { kind: "ok", state: checked } : { kind: "unreachable" };
  } catch { return { kind: "unreachable" }; }
  finally {
    clearTimeout(timer);
    if (ownsRequest) removeOwnedControlRequest(requestPath, requestId);
  }
}

async function currentState(
  projectRoot: string,
  statePath: string,
): Promise<{ state: PreviewState | null; ownership: "absent" | "verified" | "unreachable" | "stale" }> {
  const state = readState(statePath);
  if (!state) return { state: null, ownership: "absent" };
  if (realpathSync(resolve(state.projectRoot)) !== projectRoot) throw new Error("preview state belongs to a different project");
  const live = await previewControlRequest(state, statePath, "GET", "/status");
  if (live.kind === "ok") return { state: live.state, ownership: "verified" };
  // A challenge miss alone proves nothing: the supervisor may be slow or its
  // control listener may be momentarily unavailable. A supervisor-authored
  // terminal failure plus two dead recorded processes is different. It grants
  // authority to remove only the state file, never to signal a PID. Ready,
  // starting and stopping records remain unverified even when their PIDs look
  // dead because an abrupt crash may have left untracked descendants behind.
  if (state.phase === "failed" && !processAlive(state.supervisorPid) && !processAlive(state.childPid)) {
    return { state, ownership: "stale" };
  }
  return { state, ownership: "unreachable" };
}

function showOpen(state: PreviewState, noOpen: boolean, out: Writable, err: Writable, opener = openBrowserChecked): number {
  if (!state.url) { err.write("Preview is not ready yet.\n"); return PREVIEW_EXIT.notRunning; }
  out.write(`${state.url}\n`);
  if (noOpen) { out.write("Browser not opened (--no-browser/headless mode).\n"); return PREVIEW_EXIT.ok; }
  const result = opener(state.url);
  if (result.status === "spawned") out.write("Browser launch requested through the system opener.\n");
  else err.write(`Browser was not opened (${sanitizePreviewText(result.detail)}). Use the URL printed above.\n`);
  return result.status === "spawned" || result.status === "unavailable" ? PREVIEW_EXIT.ok : PREVIEW_EXIT.controlFailed;
}

async function approve(ctx: AppContext): Promise<boolean> {
  if (ctx.flags.yes) return true;
  if (!process.stdin.isTTY) return false;
  return ctx.confirm("Start this managed local preview? [y/N] ");
}

export async function cmdPreview(ctx: AppContext, argv: string[], options: PreviewOptions = {}): Promise<number> {
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;
  const sub = argv[0] ?? "status";
  if (!new Set(["start", "open", "logs", "status", "stop"]).has(sub) || argv.length !== 1) {
    err.write("usage: aether preview <start|open|logs|status|stop> [preview flags]\n");
    return PREVIEW_EXIT.usage;
  }
  let projectRoot: string;
  let paths: ReturnType<typeof previewPaths>;
  try {
    projectRoot = realpathSync(resolve(ctx.flags.cwd));
    paths = previewPaths(projectRoot);
  } catch (error) {
    err.write(`${sanitizePreviewText(error instanceof Error ? error.message : String(error))}\n`);
    return PREVIEW_EXIT.unsafe;
  }
  // Every call below reports a phase this command actually observed or caused.
  // An unreachable or unverified preview is never reported: that state is
  // unknown, and a viewer is told nothing rather than something guessed.
  const rc = previewRc(ctx, options, projectRoot);
  const observe = rc.observe;

  if (sub === "start") {
    let command: PreviewCommand;
    try { command = resolvePreviewCommand(projectRoot, options); }
    catch (error) { err.write(`${sanitizePreviewText(error instanceof Error ? error.message : String(error))}\n`); return PREVIEW_EXIT.unsafe; }
    // A refused publicUrl fails closed only where it would matter: with an RC
    // session active, rather than silently never showing the declared link.
    // Without one it is ignored, so RC never blocks local work. The value is
    // never echoed: a refused URL may be a signed or credential-bearing link.
    let refusedPublicUrl: boolean;
    try { refusedPublicUrl = options.command === undefined && publicUrlRefused(projectRoot); }
    catch (error) { err.write(`${sanitizePreviewText(error instanceof Error ? error.message : String(error))}\n`); return PREVIEW_EXIT.unsafe; }
    if (refusedPublicUrl) {
      if (rc.active()) {
        err.write(`.aether/preview.json publicUrl ${PUBLIC_URL_RULE}.\n`);
        return PREVIEW_EXIT.unsafe;
      }
      err.write(`Ignoring .aether/preview.json publicUrl: it ${PUBLIC_URL_RULE} (no RC session is active).\n`);
    }
    const digest = commandDigest(command);
    let existing: Awaited<ReturnType<typeof currentState>>;
    try { existing = await currentState(projectRoot, paths.statePath); }
    catch (error) {
      err.write(`${sanitizePreviewText(error instanceof Error ? error.message : String(error))}\n`);
      return PREVIEW_EXIT.unsafe;
    }
    if (existing.state && existing.ownership === "unreachable") {
      err.write(
        `Preview ownership could not be verified for ${existing.state.instanceId}. ` +
        "State was preserved and no duplicate was started; retry status or stop.\n",
      );
      return PREVIEW_EXIT.controlFailed;
    }
    if (existing.state && existing.ownership === "stale") {
      // A supervisor-authored failure nobody was watching (e.g. the dev server
      // exited after ready): tell the viewer before the evidence is removed,
      // or it keeps showing the old preview as ready.
      observe(existing.state, "failed");
      if (!removeOwnedState(paths.statePath, existing.state.instanceId)) {
        err.write("Failed to remove the identity-bound failed preview state; no replacement was started.\n");
        return PREVIEW_EXIT.unsafe;
      }
      err.write("Removed a terminal failed preview state after both recorded processes were confirmed absent.\n");
    }
    if (existing.state && existing.ownership === "verified") {
      if (existing.state.commandDigest !== digest) {
        err.write("A different declared preview is already running; stop it before changing commands.\n");
        return PREVIEW_EXIT.controlFailed;
      }
      observe(existing.state, existing.state.phase);
      out.write(`Attached to declared preview ${existing.state.instanceId}.\n`);
      return existing.state.phase === "ready" ? showOpen(existing.state, options.noOpen ?? false, out, err, options.open) : PREVIEW_EXIT.ok;
    }
    err.write(
      `Preview plan\n  argv: ${JSON.stringify(redactPreviewArgv([command.executable, ...command.args]))}\n  cwd: ${sanitizePreviewText(command.cwd)}\n` +
      "  filesystem: child runs as your user inside the declared cwd\n" +
      "  process: argv-only launch; Aether owns and stops the full process tree\n" +
      "  network: HOST=127.0.0.1; readiness accepts loopback http(s) URLs only; child may make outbound connections\n" +
      "  environment: inherited from this process\n",
    );
    if (!(await approve(ctx))) {
      err.write("Preview was not started. Pass --yes in a non-interactive session.\n");
      return PREVIEW_EXIT.declined;
    }
    const instanceId = randomUUID();
    const launch: PreviewLaunch = {
      schema: PREVIEW_SCHEMA, instanceId, projectRoot, commandDigest: digest, command,
      statePath: paths.statePath, logPath: paths.logPath,
    };
    const seen: { phase: PreviewDisplayPhase | null } = { phase: null };
    const note = (phase: PreviewDisplayPhase): void => {
      if (phase === seen.phase) return; // transitions, not poll ticks
      seen.phase = phase;
      observe(launch, phase);
    };
    try {
      if (existsSync(paths.logPath)) unlinkSync(paths.logPath);
      writePrivate(paths.logPath, "");
      const supervisorPath = fileURLToPath(new URL("../core/preview_supervisor.js", import.meta.url));
      const supervisor = spawn(process.execPath, [supervisorPath], {
        cwd: projectRoot, detached: true, windowsHide: true, shell: false, stdio: ["pipe", "ignore", "ignore"],
      });
      supervisor.stdin?.end(JSON.stringify(launch));
      supervisor.unref();
      let cancelled = false;
      const cancel = (): void => { cancelled = true; terminateProcessTree(supervisor); };
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      const deadline = Date.now() + command.timeoutMs + 3_000;
      try {
        while (!cancelled && Date.now() < deadline) {
          await sleep(100);
          // A cancel is final once it has signalled the tree. Whatever is read
          // after it is the supervisor reacting to that signal, and must not
          // turn the user's cancel into a launch failure (or a ready preview).
          if (cancelled) break;
          const state = readState(paths.statePath);
          if (!state || state.instanceId !== instanceId) continue;
          // "ready" is reported only once the control channel confirms it.
          if (state.phase !== "ready") note(state.phase);
          const live = await previewControlRequest(state, paths.statePath, "GET", "/status");
          if (cancelled) break;
          if (live.kind === "ok" && live.state.phase === "ready") {
            note("ready");
            return showOpen(live.state, options.noOpen ?? false, out, err, options.open);
          }
          if (state.phase === "failed") { err.write(`${state.error ?? "preview launch failed"}\n`); return PREVIEW_EXIT.launchFailed; }
        }
      } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
      }
      // terminateProcessTree signals the tree (SIGTERM, or a forced kill on
      // Windows); it does not prove cleanup. `stopped` waits for that proof.
      const settle = (): void => {
        if (rc.active()) publishStoppedWhenGone(paths.statePath, () => note("stopped"));
      };
      if (cancelled) {
        note("stopping");
        settle();
        err.write("Preview start cancelled; the supervisor process tree was stopped.\n");
        return 130;
      }
      terminateProcessTree(supervisor);
      // A concurrent `preview stop` already said "stopping"; otherwise this
      // launch simply never became ready, which is a failure whatever cleanup does.
      if (seen.phase === "stopping") settle();
      else note("failed");
      err.write("Timed out waiting for the preview supervisor; its process tree was stopped.\n");
      return PREVIEW_EXIT.timeout;
    } catch (error) {
      note("failed");
      err.write(`Preview launch failed: ${sanitizePreviewText(error instanceof Error ? error.message : String(error))}\n`);
      return PREVIEW_EXIT.launchFailed;
    }
  }

  let live: PreviewState | null;
  let ownership: "absent" | "verified" | "unreachable" | "stale";
  try {
    ({ state: live, ownership } = await currentState(projectRoot, paths.statePath));
  } catch (error) {
    err.write(`${sanitizePreviewText(error instanceof Error ? error.message : String(error))}\n`);
    return PREVIEW_EXIT.unsafe;
  }
  if (!live) { err.write("No managed preview is recorded for this project.\n"); return PREVIEW_EXIT.notRunning; }
  if (ownership === "stale") {
    // A supervisor-authored failure with both processes gone: the one terminal
    // transition nobody was watching when it happened (e.g. exit after ready).
    if (sub === "status" || sub === "stop") observe(live, "failed");
    err.write(`Preview state is terminal and stale (${live.instanceId}); no process was signalled.\n`);
    return PREVIEW_EXIT.notRunning;
  }
  if (ownership === "unreachable") {
    err.write(
      `Preview ownership is unverified (${live.instanceId}); state was preserved and no process was signalled. ` +
      "Retry status or stop.\n",
    );
    return PREVIEW_EXIT.controlFailed;
  }
  if (sub === "status") {
    observe(live, live.phase);
    out.write(`${live.phase}  pid=${live.childPid}${live.url ? `  ${live.url}` : ""}\n`);
    return live.phase === "ready" ? PREVIEW_EXIT.ok : PREVIEW_EXIT.notRunning;
  }
  if (sub === "open") return showOpen(live, options.noOpen ?? false, out, err, options.open);
  if (sub === "logs") {
    try {
      const bytes = readStablePreviewFile(paths.logPath, 1_100_000).bytes;
      out.write(sanitizePreviewText(bytes.subarray(Math.max(0, bytes.length - 64 * 1024)).toString("utf8")));
    } catch { err.write("No safe, stable preview log is available.\n"); return PREVIEW_EXIT.notRunning; }
    return PREVIEW_EXIT.ok;
  }
  err.write(`Stopping declared preview ${live.instanceId} (pid ${live.childPid}) and its process tree.\n`);
  const stopped = await previewControlRequest(live, paths.statePath, "POST", "/stop");
  if (stopped.kind !== "ok") { err.write("Supervisor instance challenge failed; no PID was signalled.\n"); return PREVIEW_EXIT.controlFailed; }
  observe(live, "stopping");
  for (let i = 0; i < 50 && existsSync(paths.statePath); i += 1) await sleep(100);
  // Unconfirmed cleanup leaves the viewer at "stopping", which is the truth.
  if (existsSync(paths.statePath)) { err.write("Preview stop was requested, but cleanup was not confirmed.\n"); return PREVIEW_EXIT.controlFailed; }
  observe(live, "stopped");
  out.write("Preview stopped.\n");
  return PREVIEW_EXIT.ok;
}

function redactPreviewArgv(argv: readonly string[]): string[] {
  let redactNext = false;
  return argv.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return "[REDACTED]";
    }
    const match = /^(--?(?:token|secret|password|passwd|authorization|api[-_]?key|private[-_]?key|credential|pat))(?:=(.*))?$/i.exec(arg);
    if (!match) return sanitizePreviewText(arg);
    if (match[2] !== undefined) return `${match[1]}=[REDACTED]`;
    redactNext = true;
    return match[1]!;
  });
}

export function previewOptionsFromFlags(flags: CommandFlags): PreviewOptions {
  // `--arg` is repeatable and reads as [] when absent. An empty list must not
  // override the declaration's args: it would launch the bare executable, and
  // the launch digest would never match the declared preview again.
  const args = flags.list("arg");
  return {
    command: flags.str("command"), ...(args.length > 0 ? { args } : {}), readyUrl: flags.str("ready-url"),
    previewCwd: flags.str("preview-cwd"), timeoutMs: flags.str("preview-timeout-ms"), noOpen: flags.bool("no-open"),
  };
}
