// browser_runtime.ts — "is there a browser, and did one actually open?"
//
// opener.ts answers a narrower question: given a target this CLI is willing to
// hand the OS, which executable and argument array launches it. That is a good
// answer and this module does not replace it — every launch still goes through
// openTarget, one argv array, no shell.
//
// What opener.ts cannot answer is whether anything opened. Its `spawned` status
// means "the launcher process started", and on Windows that is almost always
// true regardless: `rundll32.exe url.dll,FileProtocolHandler` exists on every
// installation and exits zero whether or not an https association resolves to a
// browser. So `aether auth login` on a machine with no default browser printed
// nothing wrong, waited for an approval that could never arrive, and failed
// with a message about the network. The operator had no way to learn the real
// cause from the CLI.
//
// THREE THINGS THIS MODULE ADDS, EACH ONE A TEST GROUP
//
//  1. Detection, per platform, from the OS's own registry of browsers:
//     win32 reads the https UserChoice association and the installed-browser
//     list; darwin and linux resolve the launcher on PATH; linux additionally
//     requires a display, checked FIRST so a container with xdg-open and no
//     desktop reports "headless" rather than sending someone to install a
//     browser that would not help.
//
//  2. Typed codes instead of prose. A caller — the login flow, the connector
//     handoff, `doctor`, or a script reading --json — branches on
//     BROWSER_NOT_FOUND vs BROWSER_LAUNCH_DENIED vs BROWSER_HEADLESS. Every
//     failure that used to be a free-text `detail` string now carries one.
//
//  3. A verified open: bind loopback, launch a page holding a nonce, and wait
//     for that page to call back. Spawning is not rendering, and this is the
//     only evidence that a real browser rendered anything. The probe owns its
//     server and closes it on every exit path, including a launcher that
//     throws — a leaked listener is exactly the orphan this lane must not
//     introduce.
//
// WHY reg.exe AND NOT A REGISTRY BINDING
//
// This package has no runtime dependencies and that is deliberate. reg.exe is
// in System32 on every supported Windows, is read-only here, and is invoked as
// an executable plus an argument array with windowsHide — the same discipline
// opener.ts applies. Its output is parsed, never evaluated.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { delimiter, join } from "node:path";

import { openTargetChecked, planOpen, type OpenOutcome } from "./opener.js";

/** Stable envelope name. A consumer pins this before reading `code`. */
export const BROWSER_SCHEMA = "aether.cli.browser/1";

/**
 * Machine-readable outcomes. Stable strings: a script that branches on one of
 * these must keep working, so a value is added rather than renamed.
 */
export type BrowserCode =
  /** A browser is present and the launch, if attempted, succeeded. */
  | "BROWSER_READY"
  /** No browser is registered or installed on this machine. */
  | "BROWSER_NOT_FOUND"
  /** No desktop session to open into (no DISPLAY / WAYLAND_DISPLAY). */
  | "BROWSER_HEADLESS"
  /** The OS launcher itself (rundll32 / open / xdg-open) is absent. */
  | "BROWSER_LAUNCHER_MISSING"
  /** The target is not something this CLI will hand to a browser. */
  | "BROWSER_TARGET_REJECTED"
  /** The OS refused the launch: EACCES / EPERM. */
  | "BROWSER_LAUNCH_DENIED"
  /** The launch failed for any other reason. */
  | "BROWSER_LAUNCH_FAILED"
  /** Something spawned, but no browser proved it rendered the page. */
  | "BROWSER_UNVERIFIED";

/** What detection knows, before any launch is attempted. */
export interface BrowserRuntime {
  schema: typeof BROWSER_SCHEMA;
  code: BrowserCode;
  available: boolean;
  platform: NodeJS.Platform;
  /** The OS launcher this platform would use, by name only. */
  launcher: string | null;
  /** The browser's registered identifier, when the OS exposes one. */
  browser: string | null;
  evidence: string;
}

/** Detection plus what the launch attempt did. Same keys as BrowserRuntime
 *  plus `launched`, so one envelope covers both surfaces. */
export interface BrowserOpenResult extends BrowserRuntime {
  launched: boolean;
}

/** The shape openTarget returns, widened with the errno a caller must classify. */
export interface LaunchOutcome {
  status: OpenOutcome["status"];
  executable?: string | undefined;
  detail: string;
  /** The thrown value, when the launcher failed. Classified, never printed raw. */
  cause?: unknown;
}

export interface DetectOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Read one registry key. Returns raw text, or null when it does not exist. */
  queryRegistry?: (key: string, value?: string) => string | null;
  /** Resolve an executable by name. Returns its path, or null. */
  resolveExecutable?: (name: string) => string | null;
}

export interface OpenTypedOptions {
  detect?: DetectOptions;
  open?: (url: string) => LaunchOutcome | Promise<LaunchOutcome>;
}

// ── platform detection ──────────────────────────────────────────────────────

const WIN_URL_ASSOCIATION =
  "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";
const WIN_INSTALLED_BROWSERS = "HKLM\\SOFTWARE\\Clients\\StartMenuInternet";

/** reg.exe query, read-only, argv array, no shell. Null on any failure. */
function queryRegistryReal(key: string, value?: string): string | null {
  const args = value ? ["query", key, "/v", value] : ["query", key];
  try {
    const out = spawnSync("reg.exe", args, {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 5_000,
    });
    if (out.status !== 0 || !out.stdout) return null;
    return out.stdout;
  } catch {
    return null;
  }
}

/** Resolve `name` to a path: System32 on win32, PATH elsewhere. */
function resolveExecutableReal(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  if (platform === "win32") {
    const root = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
    const candidate = join(root, "System32", name);
    return existsSync(candidate) ? candidate : null;
  }
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** `ProgId    REG_SZ    MSEdgeHTM` -> `MSEdgeHTM`. Null when absent. */
function parseProgId(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*ProgId\s+REG_\w+\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** The first installed browser under StartMenuInternet. Null when the key is
 *  empty — which is what a machine with no browser looks like. */
function parseFirstInstalledBrowser(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

function runtime(
  code: BrowserCode,
  platform: NodeJS.Platform,
  evidence: string,
  launcher: string | null = null,
  browser: string | null = null,
): BrowserRuntime {
  return {
    schema: BROWSER_SCHEMA,
    code,
    available: code === "BROWSER_READY",
    platform,
    launcher,
    browser,
    evidence,
  };
}

/**
 * What this machine can open a URL with, without launching anything.
 *
 * Cheap enough to call before every browser handoff: one registry read on
 * win32, one filesystem stat elsewhere.
 */
export function detectBrowserRuntime(options: DetectOptions = {}): BrowserRuntime {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const query = options.queryRegistry ?? queryRegistryReal;
  const resolve =
    options.resolveExecutable ?? ((name: string) => resolveExecutableReal(name, env, platform));

  if (platform === "win32") {
    if (!resolve("rundll32.exe")) {
      return runtime(
        "BROWSER_LAUNCHER_MISSING",
        platform,
        "rundll32.exe was not found in System32; the URL launcher is unavailable",
      );
    }
    const association = query(WIN_URL_ASSOCIATION, "ProgId");
    const progId = association ? parseProgId(association) : null;
    if (progId) {
      return runtime(
        "BROWSER_READY",
        platform,
        `https is associated with ${progId}`,
        "rundll32.exe",
        progId,
      );
    }
    const installed = query(WIN_INSTALLED_BROWSERS);
    const first = installed ? parseFirstInstalledBrowser(installed) : null;
    if (first) {
      return runtime(
        "BROWSER_READY",
        platform,
        `no https association is set, but ${first} is installed`,
        "rundll32.exe",
        first,
      );
    }
    return runtime(
      "BROWSER_NOT_FOUND",
      platform,
      "no default browser association and no browser registered under StartMenuInternet",
    );
  }

  if (platform === "darwin") {
    // LaunchServices always resolves an https handler on a graphical macOS, and
    // there is no headless variant of the OS to distinguish. `open` present is
    // the whole question.
    return resolve("open")
      ? runtime("BROWSER_READY", platform, "the open launcher resolved", "open")
      : runtime("BROWSER_LAUNCHER_MISSING", platform, "the open launcher was not found");
  }

  // Linux and every other POSIX. Display first: a container image can carry
  // xdg-open and still have nothing to render into.
  if (!env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) {
    return runtime(
      "BROWSER_HEADLESS",
      platform,
      "no DISPLAY or WAYLAND_DISPLAY; this session has no desktop to open into",
    );
  }
  return resolve("xdg-open")
    ? runtime("BROWSER_READY", platform, "xdg-open resolved on PATH", "xdg-open")
    : runtime("BROWSER_NOT_FOUND", platform, "xdg-open was not found on PATH");
}

/** Boolean view, for a caller that only needs to decide whether to offer the
 *  browser path or fall straight through to printing the URL. */
export function isBrowserAvailable(options: DetectOptions = {}): boolean {
  return detectBrowserRuntime(options).available;
}

/**
 * What the operator should do about each code.
 *
 * Held as a total record rather than a switch with a default, so adding a
 * BrowserCode without writing its recovery text fails the typecheck. A code
 * with no next step is a code that reads as "something went wrong".
 */
export const BROWSER_HINTS: Readonly<Record<BrowserCode, string>> = Object.freeze({
  BROWSER_READY: "the browser was opened",
  BROWSER_NOT_FOUND: "no browser is installed on this machine; open the URL above from another device",
  BROWSER_HEADLESS: "this session has no desktop; open the URL above from another device",
  BROWSER_LAUNCHER_MISSING: "the OS URL launcher is missing; open the URL above manually",
  BROWSER_TARGET_REJECTED: "the URL was refused before launch; report this, it is a bug rather than a setup problem",
  BROWSER_LAUNCH_DENIED: "the OS refused the launch (sandbox or policy); open the URL above manually",
  BROWSER_LAUNCH_FAILED: "the launcher could not start; open the URL above manually",
  BROWSER_UNVERIFIED: "a launcher started but no browser rendered the page; open the URL above manually",
});

/** The recovery line for `code`. Never returns an empty string. */
export function browserHint(code: BrowserCode): string {
  return BROWSER_HINTS[code];
}

// ── launch-failure classification ───────────────────────────────────────────

/**
 * errno -> code. A caller must be able to tell "install a browser" from "this
 * sandbox refused the spawn" without reading English.
 */
export function classifyLaunchError(cause: unknown): BrowserCode {
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code: unknown }).code)
      : "";
  if (code === "ENOENT") return "BROWSER_LAUNCHER_MISSING";
  if (code === "EACCES" || code === "EPERM") return "BROWSER_LAUNCH_DENIED";
  return "BROWSER_LAUNCH_FAILED";
}

// ── typed open ──────────────────────────────────────────────────────────────

/**
 * The production launcher. openTargetChecked, not openTarget: it waits for the
 * OS launcher to emit `spawn` or `error`, so a launcher that cannot start at
 * all is reported as a failure instead of an optimistic "spawned". It still
 * does not wait for the browser — that is what verifyBrowserLaunch is for.
 */
async function defaultOpen(url: string): Promise<LaunchOutcome> {
  const outcome = await openTargetChecked(url);
  return {
    status: outcome.status,
    executable: outcome.executable,
    detail: outcome.detail,
    cause: outcome.cause,
  };
}

function launchMessage(error: unknown): string {
  return error instanceof Error ? error.message : "the browser launcher could not be started";
}

/**
 * Open `url`, and say in one typed envelope what happened.
 *
 * Order is deliberate: validate the target, then detect the runtime, then
 * launch. A machine with no browser never spawns a launcher, and a rejected
 * URL never reaches one either — so a caller cannot report a refusal as a
 * successful open.
 */
export async function openBrowserTyped(
  url: string,
  options: OpenTypedOptions = {},
): Promise<BrowserOpenResult> {
  const detectOptions = options.detect ?? {};
  const platform = detectOptions.platform ?? process.platform;

  const plan = planOpen(url, {
    platform,
    ...(detectOptions.env ? { env: detectOptions.env } : {}),
  });
  if (plan.status === "rejected") {
    return { ...runtime("BROWSER_TARGET_REJECTED", platform, plan.detail), launched: false };
  }

  const detected = detectBrowserRuntime(detectOptions);
  if (!detected.available) return { ...detected, launched: false };

  let outcome: LaunchOutcome;
  try {
    outcome = await (options.open ?? defaultOpen)(url);
  } catch (error) {
    return {
      ...runtime(
        classifyLaunchError(error),
        platform,
        launchMessage(error),
        detected.launcher,
        detected.browser,
      ),
      launched: false,
    };
  }

  if (outcome.status === "spawned") {
    return {
      ...detected,
      launcher: outcome.executable ?? detected.launcher,
      evidence: outcome.detail || detected.evidence,
      launched: true,
    };
  }

  const code =
    outcome.status === "unavailable" ? "BROWSER_HEADLESS" : classifyLaunchError(outcome.cause);
  return {
    ...runtime(
      code,
      platform,
      outcome.detail,
      outcome.executable ?? detected.launcher,
      detected.browser,
    ),
    launched: false,
  };
}

// ── verified open (loopback nonce proof) ────────────────────────────────────

export interface VerifyOptions {
  timeoutMs?: number;
  /** Pre-computed detection, or the options to detect with. */
  detect?: { code: BrowserCode } | DetectOptions;
  /** Injected launcher, so a test never opens a real window. */
  open?: (url: string) => LaunchOutcome | Promise<LaunchOutcome>;
}

export interface VerifyResult {
  schema: typeof BROWSER_SCHEMA;
  code: BrowserCode;
  verified: boolean;
  /** The loopback port used, or null when nothing was bound. */
  port: number | null;
  latencyMs: number;
  evidence: string;
}

function preDetected(detect: VerifyOptions["detect"]): { code: BrowserCode } | null {
  if (detect && typeof detect === "object" && "code" in detect) {
    return detect as { code: BrowserCode };
  }
  return null;
}

/**
 * Prove a browser rendered something, rather than that a process started.
 *
 * Binds 127.0.0.1 on an ephemeral port, opens a page carrying a one-time
 * nonce, and waits for that page to fetch the nonce back. Nothing leaves the
 * loopback interface and the nonce is never reused.
 *
 * The server is closed in `finally` on every path — timeout, launcher refusal,
 * or a launcher that throws — and closeAllConnections() is required, not
 * cosmetic: close() alone stops new connections while a browser holding the
 * page on keep-alive keeps the handle, and the CLI, alive.
 */
export async function verifyBrowserLaunch(options: VerifyOptions = {}): Promise<VerifyResult> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const started = Date.now();

  const pre = preDetected(options.detect);
  const detectedCode = pre
    ? pre.code
    : detectBrowserRuntime((options.detect as DetectOptions | undefined) ?? {}).code;
  if (detectedCode !== "BROWSER_READY") {
    return {
      schema: BROWSER_SCHEMA,
      code: detectedCode,
      verified: false,
      port: null,
      latencyMs: Date.now() - started,
      evidence: "detection failed before a loopback probe was bound",
    };
  }

  const nonce = randomUUID();
  let server: Server | null = null;
  let port: number | null = null;

  try {
    let markCalled: () => void = () => {};
    const called = new Promise<boolean>((resolve) => {
      markCalled = (): void => resolve(true);
    });

    server = createServer((req, res) => {
      // Exact nonce match only: a stray request, or a page from another probe,
      // must not be able to answer for this one.
      if (req.url === `/cb?nonce=${nonce}`) {
        res.writeHead(204).end();
        markCalled();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Aether</title>` +
          `<p>Aether verified your browser. You can close this tab.</p>` +
          `<script>fetch(${JSON.stringify(`/cb?nonce=${nonce}`)});</script>`,
      );
    });

    const listening = server;
    await new Promise<void>((resolve, reject) => {
      listening.once("error", reject);
      listening.listen(0, "127.0.0.1", () => resolve());
    });
    port = (listening.address() as AddressInfo).port;

    const url = `http://127.0.0.1:${port}/?nonce=${nonce}`;
    const outcome = await (options.open ?? defaultOpen)(url);
    if (outcome.status !== "spawned") {
      const code =
        outcome.status === "unavailable" ? "BROWSER_HEADLESS" : classifyLaunchError(outcome.cause);
      return {
        schema: BROWSER_SCHEMA,
        code,
        verified: false,
        port,
        latencyMs: Date.now() - started,
        evidence: outcome.detail,
      };
    }

    const answered = await Promise.race([
      called,
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), timeoutMs).unref();
      }),
    ]);

    return {
      schema: BROWSER_SCHEMA,
      code: answered ? "BROWSER_READY" : "BROWSER_UNVERIFIED",
      verified: answered,
      port,
      latencyMs: Date.now() - started,
      evidence: answered
        ? "the opened page called back on loopback with the run nonce"
        : `no loopback callback within ${timeoutMs}ms; the process spawned but nothing rendered`,
    };
  } catch (error) {
    return {
      schema: BROWSER_SCHEMA,
      code: classifyLaunchError(error),
      verified: false,
      port,
      latencyMs: Date.now() - started,
      evidence: launchMessage(error),
    };
  } finally {
    try {
      server?.closeAllConnections();
      server?.close();
    } catch {
      // The socket is released when the process exits regardless.
    }
  }
}
