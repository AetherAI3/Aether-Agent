// browser_runtime — does a browser exist, and did one actually open?
//
// Four groups, in the order a failure costs the operator:
//
//   1. Detection is honest per platform   — "spawned" is not "a browser opened"
//   2. Launch failures are typed          — a caller branches on a code, not prose
//   3. The verified open leaves no orphan — server closed on every exit path
//   4. The typed open composes the two    — detection gates, launch classifies
//
// Everything here is injected: no registry is read, no PATH is resolved and no
// process is launched by this file.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BROWSER_HINTS,
  BROWSER_SCHEMA,
  browserHint,
  classifyLaunchError,
  detectBrowserRuntime,
  isBrowserAvailable,
  openBrowserTyped,
  verifyBrowserLaunch,
  type BrowserCode,
  type DetectOptions,
} from "../src/core/browser_runtime.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const EDGE_USER_CHOICE =
  "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice\r\n" +
  "    ProgId    REG_SZ    MSEdgeHTM\r\n\r\n";

const START_MENU_INTERNET =
  "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome\r\n" +
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Microsoft Edge\r\n\r\n";

/** A win32 detector whose registry answers are supplied, not read. */
function win32(userChoice: string | null, startMenu: string | null): DetectOptions {
  return {
    platform: "win32",
    env: {},
    queryRegistry: (key) => (key.includes("UrlAssociations") ? userChoice : startMenu),
    resolveExecutable: (name) =>
      name === "rundll32.exe" ? "C:\\Windows\\System32\\rundll32.exe" : null,
  };
}

/** A posix detector whose PATH answers are supplied, not resolved. */
function posix(
  platform: NodeJS.Platform,
  present: readonly string[],
  env: NodeJS.ProcessEnv = { DISPLAY: ":0" },
): DetectOptions {
  return {
    platform,
    env,
    queryRegistry: () => null,
    resolveExecutable: (name) => (present.includes(name) ? `/usr/bin/${name}` : null),
  };
}

// ── 1. Detection is honest per platform ─────────────────────────────────────

test("a registered Windows default browser is reported by name", () => {
  const runtime = detectBrowserRuntime(win32(EDGE_USER_CHOICE, START_MENU_INTERNET));
  assert.equal(runtime.schema, BROWSER_SCHEMA);
  assert.equal(runtime.code, "BROWSER_READY");
  assert.equal(runtime.available, true);
  assert.equal(runtime.browser, "MSEdgeHTM");
  assert.equal(runtime.launcher, "rundll32.exe");
});

test("Windows with no UserChoice still passes when a browser is installed", () => {
  // A fresh image, or a profile where the association was never set: the
  // StartMenuInternet list is the second source of truth, and rundll32 routes
  // to whatever the machine default resolves to.
  const runtime = detectBrowserRuntime(win32(null, START_MENU_INTERNET));
  assert.equal(runtime.code, "BROWSER_READY");
  assert.equal(runtime.browser, "Google Chrome");
});

test("Windows with neither association nor installed browser is NOT_FOUND", () => {
  // This is the case the old opener reported as "spawned": rundll32 exists and
  // exits zero, so nothing downstream could tell that no window ever appeared.
  const runtime = detectBrowserRuntime(win32(null, null));
  assert.equal(runtime.code, "BROWSER_NOT_FOUND");
  assert.equal(runtime.available, false);
  assert.match(runtime.evidence, /no default browser/i);
});

test("Windows without rundll32 reports the missing launcher, not a missing browser", () => {
  const runtime = detectBrowserRuntime({
    ...win32(EDGE_USER_CHOICE, START_MENU_INTERNET),
    resolveExecutable: () => null,
  });
  assert.equal(runtime.code, "BROWSER_LAUNCHER_MISSING");
  assert.equal(runtime.available, false);
});

test("macOS is ready when the open launcher resolves", () => {
  const runtime = detectBrowserRuntime(posix("darwin", ["open"], {}));
  assert.equal(runtime.code, "BROWSER_READY");
  assert.equal(runtime.launcher, "open");
});

test("macOS without /usr/bin/open reports a missing launcher", () => {
  assert.equal(detectBrowserRuntime(posix("darwin", [], {})).code, "BROWSER_LAUNCHER_MISSING");
});

test("Linux with a display and xdg-open is ready", () => {
  assert.equal(detectBrowserRuntime(posix("linux", ["xdg-open"])).code, "BROWSER_READY");
});

test("Linux with no display is headless, checked before the launcher", () => {
  // Order matters: a container image can carry xdg-open and still have no
  // desktop. Reporting NOT_FOUND there sends the operator to install a browser
  // that would not help.
  const runtime = detectBrowserRuntime(posix("linux", ["xdg-open"], {}));
  assert.equal(runtime.code, "BROWSER_HEADLESS");
  assert.equal(runtime.available, false);
});

test("Wayland counts as a display", () => {
  const runtime = detectBrowserRuntime(
    posix("linux", ["xdg-open"], { WAYLAND_DISPLAY: "wayland-0" }),
  );
  assert.equal(runtime.code, "BROWSER_READY");
});

test("Linux with a display but no xdg-open is NOT_FOUND", () => {
  assert.equal(detectBrowserRuntime(posix("linux", [])).code, "BROWSER_NOT_FOUND");
});

test("isBrowserAvailable is a boolean view of the same detection", () => {
  assert.equal(isBrowserAvailable(posix("linux", ["xdg-open"])), true);
  assert.equal(isBrowserAvailable(posix("linux", [])), false);
});

test("a detection result is JSON-serializable and leaks no local launcher path", () => {
  const runtime = detectBrowserRuntime(win32(EDGE_USER_CHOICE, START_MENU_INTERNET));
  const round: unknown = JSON.parse(JSON.stringify(runtime));
  assert.deepEqual(round, runtime);
  assert.doesNotMatch(JSON.stringify(round), /C:\\\\Windows/);
});

test("every code carries a non-empty recovery hint", () => {
  // The typecheck already forces the record to be total. This asserts the
  // values are usable text rather than placeholders, and that every code a
  // caller can observe reaches a next step.
  const codes: BrowserCode[] = [
    "BROWSER_READY",
    "BROWSER_NOT_FOUND",
    "BROWSER_HEADLESS",
    "BROWSER_LAUNCHER_MISSING",
    "BROWSER_TARGET_REJECTED",
    "BROWSER_LAUNCH_DENIED",
    "BROWSER_LAUNCH_FAILED",
    "BROWSER_UNVERIFIED",
  ];
  assert.deepEqual(Object.keys(BROWSER_HINTS).sort(), [...codes].sort());
  for (const code of codes) {
    assert.ok(browserHint(code).length > 10, `${code} has no usable hint`);
  }
});

// ── 2. Launch failures are typed ────────────────────────────────────────────

test("ENOENT is a missing launcher, not a missing browser", () => {
  assert.equal(classifyLaunchError({ code: "ENOENT" }), "BROWSER_LAUNCHER_MISSING");
});

test("EACCES and EPERM are launch permission failures", () => {
  assert.equal(classifyLaunchError({ code: "EACCES" }), "BROWSER_LAUNCH_DENIED");
  assert.equal(classifyLaunchError({ code: "EPERM" }), "BROWSER_LAUNCH_DENIED");
});

test("an unrecognised errno falls back to a generic launch failure", () => {
  assert.equal(classifyLaunchError({ code: "EMFILE" }), "BROWSER_LAUNCH_FAILED");
  assert.equal(classifyLaunchError(new Error("boom")), "BROWSER_LAUNCH_FAILED");
  assert.equal(classifyLaunchError(null), "BROWSER_LAUNCH_FAILED");
});

// ── 3. The verified open leaves no orphan ───────────────────────────────────

test("a page that calls back with the nonce verifies the launch", async () => {
  const result = await verifyBrowserLaunch({
    timeoutMs: 10_000,
    detect: { code: "BROWSER_READY" },
    // Stand in for the browser: fetch the callback the probe page would fetch.
    open: (url) => {
      const nonce = new URL(url).searchParams.get("nonce") ?? "";
      void fetch(new URL(`/cb?nonce=${nonce}`, url)).catch(() => {});
      return { status: "spawned", detail: "test launcher" };
    },
  });
  assert.equal(result.code, "BROWSER_READY");
  assert.equal(result.verified, true);
});

test("a launcher that spawns but renders nothing is UNVERIFIED, not READY", async () => {
  const result = await verifyBrowserLaunch({
    timeoutMs: 150,
    detect: { code: "BROWSER_READY" },
    open: () => ({ status: "spawned", detail: "spawned into the void" }),
  });
  assert.equal(result.code, "BROWSER_UNVERIFIED");
  assert.equal(result.verified, false);
});

test("a callback carrying the wrong nonce does not verify the launch", async () => {
  const result = await verifyBrowserLaunch({
    timeoutMs: 400,
    detect: { code: "BROWSER_READY" },
    open: (url) => {
      void fetch(new URL("/cb?nonce=not-the-nonce", url)).catch(() => {});
      return { status: "spawned", detail: "wrong nonce" };
    },
  });
  assert.equal(result.verified, false);
});

test("the probe closes its loopback server on every exit path", async () => {
  const launchers = [
    () => ({ status: "spawned" as const, detail: "no render" }),
    () => ({ status: "spawn-error" as const, detail: "denied" }),
    () => {
      throw new Error("launcher exploded");
    },
  ];
  const { createServer } = await import("node:http");
  for (const open of launchers) {
    const result = await verifyBrowserLaunch({
      timeoutMs: 100,
      detect: { code: "BROWSER_READY" },
      open,
    });
    assert.equal(typeof result.port, "number");
    // Rebinding the same port proves the listener was released. A leaked
    // server is the orphan this test exists to catch.
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(result.port!, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
});

test("detection failure short-circuits before any server is bound", async () => {
  let opened = false;
  const result = await verifyBrowserLaunch({
    timeoutMs: 100,
    detect: { code: "BROWSER_NOT_FOUND" },
    open: () => {
      opened = true;
      return { status: "spawned", detail: "should not happen" };
    },
  });
  assert.equal(result.code, "BROWSER_NOT_FOUND");
  assert.equal(result.verified, false);
  assert.equal(result.port, null);
  assert.equal(opened, false);
});

// ── 4. The typed open composes detection and classification ─────────────────

test("a rejected target never reaches the launcher", async () => {
  let opened = false;
  const result = await openBrowserTyped("ftp://example.com/x", {
    detect: win32(EDGE_USER_CHOICE, START_MENU_INTERNET),
    open: () => {
      opened = true;
      return { status: "spawned", detail: "" };
    },
  });
  assert.equal(result.code, "BROWSER_TARGET_REJECTED");
  assert.equal(opened, false);
});

test("credentials embedded in a URL are refused before launch", async () => {
  const result = await openBrowserTyped("https://user:pw@example.com/", {
    detect: win32(EDGE_USER_CHOICE, START_MENU_INTERNET),
    open: () => ({ status: "spawned", detail: "" }),
  });
  assert.equal(result.code, "BROWSER_TARGET_REJECTED");
});

test("a missing browser is reported without launching anything", async () => {
  let opened = false;
  const result = await openBrowserTyped("https://example.com/", {
    detect: win32(null, null),
    open: () => {
      opened = true;
      return { status: "spawned", detail: "" };
    },
  });
  assert.equal(result.code, "BROWSER_NOT_FOUND");
  assert.equal(opened, false);
  assert.equal(result.launched, false);
});

test("a successful launch reports READY and the executable used", async () => {
  const result = await openBrowserTyped("https://example.com/", {
    detect: win32(EDGE_USER_CHOICE, START_MENU_INTERNET),
    open: () => ({ status: "spawned", executable: "rundll32.exe", detail: "ok" }),
  });
  assert.equal(result.code, "BROWSER_READY");
  assert.equal(result.launched, true);
  assert.equal(result.launcher, "rundll32.exe");
});

test("a spawn error is surfaced with its typed cause", async () => {
  const result = await openBrowserTyped("https://example.com/", {
    detect: posix("linux", ["xdg-open"]),
    open: () => ({
      status: "spawn-error",
      detail: "permission denied",
      cause: { code: "EACCES" },
    }),
  });
  assert.equal(result.code, "BROWSER_LAUNCH_DENIED");
  assert.equal(result.launched, false);
});

test("every typed result serializes to a stable machine envelope", async () => {
  const result = await openBrowserTyped("https://example.com/", {
    detect: posix("linux", []),
    open: () => ({ status: "spawned", detail: "" }),
  });
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(result)) as object).sort(), [
    "available",
    "browser",
    "code",
    "evidence",
    "launched",
    "launcher",
    "platform",
    "schema",
  ]);
});
