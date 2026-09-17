import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { AtsBrowserObserver, validateBrowserUrl } from "./browser.js";
import { createBrowserFetch } from "./browser_transport.js";
export { AtsBrowserObserver, validateBrowserUrl, observeBrowser } from "./browser.js";
export { createBrowserFetch } from "./browser_transport.js";
export { createBrowserVisionSkill } from "./vision_skill.js";
export * from "./settings.js";

const require = createRequire(import.meta.url);
const bridge = fileURLToPath(new URL("../python/bridge.py", import.meta.url));
const MAX_OUTPUT = 4 * 1024 * 1024;

function run(command, args, { input, timeoutMs = 30_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    // A dedicated process group lets an interrupted context launcher clean up
    // its own pip/venv descendants without touching unrelated Python processes.
    const child = spawn(command, args, { env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", bytes = 0, finished = false, failure = null, closed = false, closeCode = null, cleanupDone = false;
    let escalation;
    const finish = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(escalation);
      if (error) reject(error); else resolve(result);
    };
    const settleFailure = () => { if (closed && cleanupDone) finish(failure); };
    const signalGroup = (signal) => {
      try {
        if (process.platform === "win32") child.kill(signal);
        else if (child.pid) process.kill(-child.pid, signal);
      } catch (error) { if (error.code !== "ESRCH") failure = new Error("ATS native cleanup failed; inspect the selected interpreter process.", { cause: error }); }
    };
    const stop = (error) => {
      if (failure || finished) return;
      failure = error; clearTimeout(timer);
      if (process.platform !== "win32") signalGroup("SIGTERM");
      // Windows taskkill must see the live parent to find its descendants.
      // Wait for tree cleanup even if the direct child exits before a descendant.
      escalation = setTimeout(() => {
        if (process.platform === "win32" && child.pid) {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
          killer.on("error", () => { signalGroup("SIGKILL"); cleanupDone = true; settleFailure(); });
          killer.on("close", () => { signalGroup("SIGKILL"); cleanupDone = true; settleFailure(); });
        } else { signalGroup("SIGKILL"); cleanupDone = true; settleFailure(); }
      }, 250);
    };
    const timer = setTimeout(() => stop(new Error("ATS native operation timed out.")), timeoutMs);
    child.on("error", error => { if (!child.pid) finish(error); else stop(error); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT) stop(new Error("ATS native response exceeded its size limit."));
      else stdout += chunk;
    });
    // Native diagnostic output may contain local data: do not echo or retain it.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.on("close", code => {
      closed = true; closeCode = code;
      if (failure) settleFailure(); else finish(null, { code: closeCode, stdout });
    });
    child.stdin.end(input ?? "");
  });
}

function managedPython(env) {
  const home = homedir();
  const cache = process.platform === "win32" ? env.LOCALAPPDATA || join(home, "AppData", "Local") : process.platform === "darwin" ? join(home, "Library", "Caches") : env.XDG_CACHE_HOME || join(home, ".cache");
  const root = env.AETHER_CONTEXT_HOME || join(cache, "aether-context", "npm-venv");
  return join(root, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
}

async function pythonCommand(explicit, env) {
  const configured = explicit || env.AETHER_ATS_PYTHON || env.AETHER_CONTEXT_PYTHON;
  if (configured) return { command: configured, args: [] };
  const managed = managedPython(env);
  try { await access(managed); return { command: managed, args: [] }; } catch {}
  const candidates = process.platform === "win32" ? [{ command: "py", args: ["-3"] }, { command: "python", args: [] }, { command: "python3", args: [] }] : [{ command: "python3", args: [] }, { command: "python", args: [] }];
  for (const candidate of candidates) {
    try {
      const version = await run(candidate.command, [...candidate.args, "-I", "-c", "import sys; print(1 if (3,10) <= sys.version_info[:2] < (3,15) else 0)"], { env, timeoutMs: 5000 });
      if (version.code === 0 && version.stdout.trim() === "1") return candidate;
    } catch {}
  }
  throw new Error("Python 3.10–3.14 is required. Select it with AETHER_ATS_PYTHON.");
}

async function native(operation, options, selectedPython) {
  const env = options.env || process.env;
  const python = selectedPython || await pythonCommand(options.python, env);
  let response;
  try {
    response = await run(python.command, [...python.args, "-I", bridge], { input: JSON.stringify({ ...options, operation, python: undefined, env: undefined, bootstrap: undefined }), env });
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Python 3.10+ is required. Select it with AETHER_ATS_PYTHON.");
    throw error;
  }
  let result;
  try { result = JSON.parse(response.stdout); } catch { throw new Error("ATS native runtime returned an invalid response."); }
  if (response.code !== 0 || result.state === "error") throw new Error(result.message || "ATS native operation failed.");
  return result;
}

/** Verify real persistence and native quota; no model request or order is emitted. */
export async function initializeMemory(options) {
  if (!options || !isAbsolute(options.directory || "")) throw new Error("Choose an absolute memory directory.");
  const result = await native("initialize_memory", options);
  if (result.code !== "CONTEXT_ENGINE_UNAVAILABLE" || options.bootstrap === false || options.python || options.env?.AETHER_ATS_PYTHON || process.env.AETHER_ATS_PYTHON) return result;
  // The pinned npm dependency owns Python provisioning in its private cache venv.
  // Calling its version command provisions that engine without an interactive session.
  const launcher = join(dirname(require.resolve("aether-context/package.json")), "bin", "aether-context.js");
  const env = options.env || process.env;
  const installed = await run(process.execPath, [launcher, "--version"], { env: { ...env, AETHER_CONTEXT_VERSION: "0.3.1" }, timeoutMs: 180_000 });
  if (installed.code !== 0) return { ...result, message: "The pinned aether-context engine could not be installed. Select a working interpreter with AETHER_ATS_PYTHON." };
  return native("initialize_memory", options, { command: managedPython(env), args: [] });
}

/** Read direct strategy files as data and invoke the installed ATS Nano seam. */
export async function scanStrategies(options) {
  if (!options || !isAbsolute(options.directory || "")) throw new Error("Choose an absolute strategy directory.");
  return native("scan_strategies", options);
}

/** The observer deliberately exposes no click, trade or arbitrary browser action API. */
export async function createBrowserObserver({ env = process.env, maxVisionSteps = 100, maxAgeMs = 15_000 } = {}) {
  const baseUrl = validateBrowserUrl(env.AGENT_BROWSER_URL || "http://127.0.0.1:8092");
  const { AgentBrowser } = await import("aether-browser");
  const browser = new AgentBrowser({ env, baseUrl, timeoutMs: 15_000, fetch: createBrowserFetch() });
  return new AtsBrowserObserver({ browser, baseUrl, maxVisionSteps, maxAgeMs });
}
