import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandDigest, isLoopbackUrl, parsePreviewState, PREVIEW_SCHEMA, previewPathStillNames, previewPaths,
  readStablePreviewFile, sanitizePreviewText,
  validatePreviewCommand, type PreviewCommand, type PreviewLaunch, type PreviewState,
} from "./preview_contract.js";
import { terminateProcessTree } from "./process_tree_kill.js";

import { childEnv } from "./child_env.js";
function writeState(path: string, state: PreviewState): void {
  const tmp = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { chmodSync(tmp, 0o600); } catch { /* Windows ACLs are the authority. */ }
    renameSync(tmp, path);
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* preserve the state write failure */ }
    throw error;
  }
}

function validLaunch(value: unknown): value is PreviewLaunch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const allowed = new Set(["schema", "instanceId", "projectRoot", "commandDigest", "command", "statePath", "logPath"]);
  if (Object.keys(v).some((key) => !allowed.has(key))) return false;
  return v["schema"] === PREVIEW_SCHEMA && typeof v["instanceId"] === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v["instanceId"]) &&
    typeof v["projectRoot"] === "string" && v["projectRoot"].length <= 4096 &&
    typeof v["commandDigest"] === "string" && /^[0-9a-f]{64}$/.test(v["commandDigest"]) &&
    typeof v["statePath"] === "string" && typeof v["logPath"] === "string" &&
    isAbsolute(v["statePath"] as string) && isAbsolute(v["logPath"] as string) &&
    typeof v["command"] === "object" && v["command"] !== null;
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function consumeControlRequest(launch: PreviewLaunch, controlDir: string, req: IncomingMessage): boolean {
  const requestId = req.headers["x-aether-preview-control"];
  if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return false;
  // The header is never used to construct a path. Select an existing, exact
  // control entry from the private directory instead; directory entries cannot
  // contain a path separator and the pattern rejects every non-owned sibling.
  const controlName = readdirSync(controlDir).find((name) =>
    name === `control-${requestId}.json` && /^control-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(name),
  );
  if (!controlName) return false;
  const requestPath = join(controlDir, controlName);
  try {
    const stable = readStablePreviewFile(requestPath, 1_024);
    const value: unknown = JSON.parse(stable.bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    const valid = Object.keys(v).length === 5 && v["schema"] === PREVIEW_SCHEMA && v["requestId"] === requestId &&
      v["instanceId"] === launch.instanceId && v["method"] === req.method && v["path"] === req.url;
    if (!valid) return false;
    if (!previewPathStillNames(requestPath, stable.identity)) return false;
    unlinkSync(requestPath);
    return true;
  } catch { return false; }
}

function openStableLog(path: string): number {
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("unsafe preview log path");
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | noFollow);
  const opened = fstatSync(fd, { bigint: true });
  const after = lstatSync(path, { bigint: true });
  if (!opened.isFile() || after.isSymbolicLink() || before.dev !== opened.dev || before.ino !== opened.ino ||
      opened.dev !== after.dev || opened.ino !== after.ino) {
    closeSync(fd);
    throw new Error("preview log changed while it was being opened");
  }
  return fd;
}

async function probe(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal });
    return true;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

export async function runPreviewSupervisor(launchJson: string): Promise<number> {
  let launch: PreviewLaunch;
  let controlDir: string;
  try {
    const parsed: unknown = JSON.parse(launchJson);
    if (!validLaunch(parsed)) throw new Error("invalid launch contract");
    // The parent starts this detached process with cwd set to the declared
    // project. Treat that inherited OS state, rather than stdin JSON, as the
    // filesystem authority. A hand-crafted payload may describe a project but
    // can never redirect supervisor reads, writes, or cleanup outside this cwd.
    const projectRoot = realpathSync(process.cwd());
    const paths = previewPaths(projectRoot);
    const command = validatePreviewCommand(parsed.command as PreviewCommand, projectRoot);
    if (parsed.projectRoot !== projectRoot || parsed.statePath !== paths.statePath || parsed.logPath !== paths.logPath ||
        parsed.commandDigest !== commandDigest(command)) throw new Error("launch contract confinement or digest mismatch");
    launch = { ...parsed, projectRoot, statePath: paths.statePath, logPath: paths.logPath, command };
    controlDir = paths.dir;
  } catch { return 2; }

  let child: ChildProcess | null = null;
  let logFd: number;
  try { logFd = openStableLog(launch.logPath); } catch { return 2; }
  let stopping = false;
  let state!: PreviewState;
  const candidates: string[] = [];
  if (launch.command.readyUrl) candidates.push(launch.command.readyUrl);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // The request is authorized by a one-use file created inside the private
    // project state directory. A browser cannot create it, another OS user
    // cannot access that directory, and no reusable bearer credential exists.
    if (!consumeControlRequest(launch, controlDir, req)) return reply(res, 403, { ok: false });
    if (req.url === "/status" && req.method === "GET") return reply(res, 200, state);
    if (req.url === "/stop" && req.method === "POST") {
      if (!stopping) {
        stopping = true;
        state = { ...state, phase: "stopping" };
        writeState(launch.statePath, state);
        terminateProcessTree(child);
      }
      return reply(res, 202, { ok: true, instanceId: launch.instanceId });
    }
    return reply(res, 404, { ok: false });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") return 2;

  // An explicit readiness URL is part of the launch authority. It must be
  // unoccupied before the child starts so that a later successful probe is an
  // observed transition attributable to this launch, rather than an unrelated
  // listener that happened to survive our startup-stability window.
  if (launch.command.readyUrl && await probe(launch.command.readyUrl)) {
    state = {
      schema: PREVIEW_SCHEMA, instanceId: launch.instanceId, projectRoot: launch.projectRoot,
      commandDigest: launch.commandDigest, phase: "failed", supervisorPid: process.pid, childPid: 0,
      controlPort: address.port, startedAt: new Date().toISOString(),
      error: "declared ready URL was already reachable before the preview child started",
    };
    writeState(launch.statePath, state);
    closeSync(logFd);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return 1;
  }

  try {
    child = spawn(launch.command.executable, launch.command.args, {
      cwd: launch.command.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: childEnv({
        allow: ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS"],
        inject: { HOST: "127.0.0.1", AETHER_PREVIEW_HOST: "127.0.0.1" },
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    state = {
      schema: PREVIEW_SCHEMA, instanceId: launch.instanceId, projectRoot: launch.projectRoot,
      commandDigest: launch.commandDigest, phase: "failed", supervisorPid: process.pid, childPid: 0,
      controlPort: address.port, startedAt: new Date().toISOString(),
      error: sanitizePreviewText(error instanceof Error ? error.message : String(error)).slice(0, 500),
    };
    writeState(launch.statePath, state);
    closeSync(logFd);
    server.close();
    return 1;
  }

  state = {
    schema: PREVIEW_SCHEMA, instanceId: launch.instanceId, projectRoot: launch.projectRoot,
    commandDigest: launch.commandDigest, phase: "starting", supervisorPid: process.pid, childPid: child.pid ?? 0,
    controlPort: address.port, startedAt: new Date().toISOString(),
  };
  writeState(launch.statePath, state);

  let tail = "";
  let logBytes = 0;
  let spawnError = "";
  let logFailed = false;
  const consume = (chunk: Buffer | string): void => {
    const safe = sanitizePreviewText(String(chunk));
    const bytes = Buffer.from(safe);
    try {
      if (logBytes + bytes.length > 1_048_576) {
        ftruncateSync(logFd, 0);
        const marker = Buffer.from("[earlier preview log truncated]\n");
        writeSync(logFd, marker);
        logBytes = marker.length;
      }
      const remaining = Math.max(0, 1_048_576 - logBytes);
      if (remaining > 0) {
        const bounded = bytes.subarray(Math.max(0, bytes.length - remaining));
        writeSync(logFd, bounded);
        logBytes += bounded.length;
      }
    } catch {
      if (!logFailed) {
        logFailed = true;
        spawnError = "preview log became unavailable";
        terminateProcessTree(child);
      }
      return;
    }
    tail = (tail + safe).slice(-16_384);
    for (const match of tail.matchAll(/https?:\/\/[^\s"'<>\]\[()]+/g)) {
      const value = match[0].replace(/[.,;:!?]+$/, "");
      if (isLoopbackUrl(value) && !candidates.includes(value)) candidates.unshift(value);
    }
  };
  child.stdout?.on("data", consume);
  child.stderr?.on("data", consume);

  let closed: number | null = null;
  child.once("error", (error: NodeJS.ErrnoException) => { spawnError = error.code ?? error.message; });
  child.once("close", (code) => { closed = code ?? 1; });
  const cancel = (): void => {
    stopping = true;
    terminateProcessTree(child);
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);

  const deadline = Date.now() + launch.command.timeoutMs;
  let readyUrl: string | undefined;
  while (!stopping && Date.now() < deadline && closed === null) {
    for (const candidate of candidates) {
      if (await probe(candidate)) { readyUrl = candidate; break; }
    }
    if (readyUrl) {
      // A listener already occupying a declared port must not make a child that
      // immediately fails its own bind look ready. Keep the child alive across
      // a full startup-stability window and probe the same URL again.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      if (closed === null && await probe(readyUrl)) break;
      readyUrl = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // A stop that lands before readiness (SIGINT/SIGTERM, or POST /stop) is
  // still a stop. The child's exit is the one this supervisor asked for — on
  // Unix a SIGTERM death closes with no code, which `closed` records as 1 — so
  // it is not "exited before readiness". It ends through the same confirmed
  // cleanup as a stop after readiness, below, rather than leaving a failed
  // state that `preview stop` reads as unconfirmed cleanup and the next
  // `status` or `start` republishes as a failure.
  if (!readyUrl && !stopping) {
    const error = spawnError ? `launch failed: ${spawnError}` : closed !== null
      ? `dev command exited before readiness (exit ${closed})`
      : "timed out waiting for a reachable loopback ready URL";
    state = { ...state, phase: "failed", error };
    writeState(launch.statePath, state);
    terminateProcessTree(child);
    closeSync(logFd);
    server.close();
    return 1;
  }

  if (readyUrl) {
    state = { ...state, phase: "ready", url: readyUrl };
    writeState(launch.statePath, state);
  }

  if (closed === null) await new Promise<void>((resolve) => child!.once("close", () => resolve()));
  if (!stopping) {
    state = { ...state, phase: "failed", error: spawnError || `dev command exited after readiness (exit ${closed ?? 1})` };
    writeState(launch.statePath, state);
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeSync(logFd);
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  if (stopping) {
    try {
      const stable = readStablePreviewFile(launch.statePath, 32_768);
      if (parsePreviewState(JSON.parse(stable.bytes.toString("utf8")))?.instanceId === launch.instanceId &&
          previewPathStillNames(launch.statePath, stable.identity)) unlinkSync(launch.statePath);
    } catch { /* stale or replaced state is safer than deleting an unknown file */ }
  }
  return stopping ? 0 : 1;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] || fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase() : false;
if (invoked) {
  let launchJson = "";
  try { launchJson = readFileSync(0, "utf8"); } catch { /* invalid input fails closed below */ }
  runPreviewSupervisor(launchJson).then((code) => { process.exitCode = code; });
}
