import { spawn, spawnSync } from "node:child_process";
import type { AppContext } from "../core/context.js";
import { saveConfig } from "../core/config.js";
import { normalizeOllamaHost } from "../core/ollama.js";
import { isLocalModelId, localModelId, normalizeOllamaTag, ollamaTagFromId, resolveLocalModel } from "../core/local_ollama.js";
import { OllamaModelsError, parseInstalledOllamaTags, requestOllamaTags } from "../core/ollama_models.js";
import { terminateProcessTree } from "../core/process_tree_kill.js";

export const LOCAL_EXIT = {
  ok: 0,
  usage: 2,
  declined: 20,
  binaryAbsent: 21,
  serverDown: 22,
  emptyModels: 23,
  selectedMissing: 24,
  timeout: 25,
  malformedResponse: 26,
  operationFailed: 27,
  mutationFailed: 28,
  cancelled: 130,
} as const;

export interface LocalProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

export interface LocalRuntimeDeps {
  run(command: string, args: readonly string[], timeoutMs: number): LocalProcessResult;
  pull(
    command: string,
    args: readonly string[],
    timeoutMs: number,
    onProgress: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<LocalProcessResult>;
  requestTags(host: string, timeoutMs: number): Promise<unknown>;
  save(ctx: AppContext): void;
}

interface LocalSnapshot {
  host: string;
  binary: { present: boolean; version: string; timedOut: boolean; errorCode?: string };
  server: "up" | "down" | "timeout" | "malformed";
  models: string[];
  selectedTag: string;
  selectedId: string;
  selectedPresent: boolean;
  configuredBackend: string;
  hostedAuth: "signed-in" | "signed-out";
}

const PROBE_TIMEOUT_MS = 5_000;
const PULL_TIMEOUT_MS = 30 * 60_000;
const RECEIPT_BYTES = 8 * 1024;
const PROGRESS_CHUNK_BYTES = 16 * 1024;

function isTimeoutError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current.name === "AbortError" || current.name === "TimeoutError" || /timed?\s*out|timeout/i.test(current.message)) return true;
    const code = (current as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

function cleanLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
}

function requestedTag(raw: string): string {
  if (!isLocalModelId(raw)) return normalizeOllamaTag(raw);
  const tag = ollamaTagFromId(raw);
  if (!tag) throw new Error("Invalid Ollama model id; use ollama/<tag>");
  return tag;
}

function progressText(value: string): string {
  return value.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, PROGRESS_CHUNK_BYTES);
}

function receiptTail(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= RECEIPT_BYTES ? combined : combined.slice(-RECEIPT_BYTES);
}

/** Async argv-only runner used by pulls; output is streamed and receipts keep only a bounded tail. */
export function runStreamingProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  onProgress: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<LocalProcessResult> {
  return new Promise<LocalProcessResult>((resolve) => {
    const child = spawn(command, [...args], {
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let errorCode: string | undefined;
    let timedOut = false;
    let cancelled = false;
    const stop = (): void => {
      if (!timedOut) cancelled = true;
      terminateProcessTree(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);
    timer.unref();
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = receiptTail(stdout, chunk);
      const safe = progressText(chunk);
      if (safe) onProgress(safe);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = receiptTail(stderr, chunk);
      const safe = progressText(chunk);
      if (safe) onProgress(safe);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      errorCode = error.code;
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({
        status,
        stdout,
        stderr,
        ...(errorCode ? { errorCode } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        ...(cancelled ? { cancelled: true } : {}),
      });
    });
  });
}

const productionDeps: LocalRuntimeDeps = {
  run(command, args, timeoutMs) {
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    const code = result.error && "code" in result.error ? String(result.error.code) : undefined;
    return {
      status: result.status,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      ...(code ? { errorCode: code } : {}),
      ...(code === "ETIMEDOUT" ? { timedOut: true } : {}),
    };
  },
  pull: runStreamingProcess,
  requestTags: requestOllamaTags,
  save(ctx) {
    saveConfig(ctx.cfg);
  },
};

async function snapshot(ctx: AppContext, deps: LocalRuntimeDeps): Promise<LocalSnapshot | { code: number; message: string }> {
  let host: string;
  try {
    host = normalizeOllamaHost(process.env["OLLAMA_HOST"]);
  } catch (error) {
    return { code: LOCAL_EXIT.malformedResponse, message: error instanceof Error ? error.message : String(error) };
  }

  const binaryResult = deps.run("ollama", ["--version"], PROBE_TIMEOUT_MS);
  const binary = {
    present: binaryResult.status === 0,
    version: binaryResult.status === 0 ? cleanLine(binaryResult.stdout || binaryResult.stderr) || "present" : "not found",
    timedOut: binaryResult.timedOut === true,
    ...(binaryResult.errorCode ? { errorCode: binaryResult.errorCode } : {}),
  };
  const selectedTag = resolveLocalModel(undefined, ctx.cfg.localModel ?? "");
  const common = {
    host,
    binary,
    selectedTag,
    selectedId: localModelId(selectedTag),
    configuredBackend: cleanLine(process.env["AETHER_BACKEND"] || ctx.cfg.backend || "auto") || "auto",
    hostedAuth: Boolean(await ctx.tokens.get()) ? "signed-in" as const : "signed-out" as const,
  };

  let raw: unknown;
  try {
    raw = await deps.requestTags(host, PROBE_TIMEOUT_MS);
  } catch (error) {
    const timedOut = isTimeoutError(error);
    return {
      ...common,
      server: error instanceof OllamaModelsError && error.reason === "malformed" ? "malformed" : timedOut ? "timeout" : "down",
      models: [],
      selectedPresent: false,
    };
  }
  let models: string[];
  try { models = parseInstalledOllamaTags(raw); }
  catch { return { ...common, server: "malformed", models: [], selectedPresent: false }; }
  return { ...common, server: "up", models, selectedPresent: models.includes(selectedTag) };
}

function snapshotExit(state: LocalSnapshot): number {
  if (state.binary.timedOut) return LOCAL_EXIT.timeout;
  if (!state.binary.present) return state.binary.errorCode === "ENOENT" ? LOCAL_EXIT.binaryAbsent : LOCAL_EXIT.operationFailed;
  if (state.server === "timeout") return LOCAL_EXIT.timeout;
  if (state.server === "down") return LOCAL_EXIT.serverDown;
  if (state.server === "malformed") return LOCAL_EXIT.malformedResponse;
  if (state.models.length === 0) return LOCAL_EXIT.emptyModels;
  if (!state.selectedPresent) return LOCAL_EXIT.selectedMissing;
  return LOCAL_EXIT.ok;
}

function runtimeFailure(state: LocalSnapshot, requireBinary: boolean): number | null {
  if (state.binary.timedOut) {
    process.stderr.write("The Ollama binary check timed out; inspect the local installation and retry.\n");
    return LOCAL_EXIT.timeout;
  }
  if (requireBinary && !state.binary.present) {
    if (state.binary.errorCode === "ENOENT") {
      process.stderr.write("Ollama binary not found on PATH. Install Ollama and retry.\n");
      return LOCAL_EXIT.binaryAbsent;
    }
    process.stderr.write(`Ollama binary could not run${state.binary.errorCode ? ` (${state.binary.errorCode})` : ""}; repair the installation and retry.\n`);
    return LOCAL_EXIT.operationFailed;
  }
  if (state.server === "timeout") {
    process.stderr.write("Ollama did not answer in 5s; check OLLAMA_HOST and the server.\n");
    return LOCAL_EXIT.timeout;
  }
  if (state.server === "down") {
    process.stderr.write("Ollama server is down. Start it separately, then retry.\n");
    return LOCAL_EXIT.serverDown;
  }
  if (state.server === "malformed") {
    process.stderr.write("Ollama returned malformed model metadata; upgrade or restart Ollama.\n");
    return LOCAL_EXIT.malformedResponse;
  }
  return null;
}

async function approveMutation(ctx: AppContext, prompt: string): Promise<boolean> {
  if (ctx.flags.yes) return true;
  if (!process.stdin.isTTY) {
    process.stderr.write("This mutation requires --yes in a non-interactive session.\n");
    return false;
  }
  return ctx.confirm(prompt);
}

function writeSnapshot(ctx: AppContext, state: LocalSnapshot): void {
  const code = snapshotExit(state);
  if (ctx.flags.json) {
    process.stdout.write(JSON.stringify({ schema: "aether/local-doctor@1", ok: code === 0, exitCode: code, ...state }, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    `Local Ollama\n` +
      `  host             ${state.host}\n` +
      `  binary           ${state.binary.present ? state.binary.version : state.binary.errorCode === "ENOENT" ? "not found on PATH" : "could not execute"}\n` +
      `  server           ${state.server}\n` +
      `  installed models ${state.models.length}\n` +
      `  selected model   ${state.selectedId}${state.selectedPresent ? "" : " (not installed)"}\n` +
      `  backend setting  ${state.configuredBackend} (unchanged)\n` +
      `  hosted auth      ${state.hostedAuth}\n`,
  );
  if (state.binary.timedOut) process.stderr.write("The Ollama binary check timed out; inspect the local installation and retry.\n");
  else if (!state.binary.present && state.binary.errorCode === "ENOENT") process.stderr.write("Install Ollama, then run: aether local doctor\n");
  else if (!state.binary.present) process.stderr.write(`Ollama binary could not run${state.binary.errorCode ? ` (${state.binary.errorCode})` : ""}; repair the installation.\n`);
  else if (state.server === "down") process.stderr.write("Start Ollama separately, then run: aether local doctor\n");
  else if (state.server === "timeout") process.stderr.write("Ollama did not answer in 5s; check OLLAMA_HOST and the server.\n");
  else if (state.server === "malformed") process.stderr.write("Ollama returned malformed model metadata; upgrade or restart Ollama.\n");
  else if (state.models.length === 0) process.stderr.write("No local models are installed. Run: aether local pull <model> --yes\n");
  else if (!state.selectedPresent) process.stderr.write(`Selected model is missing. Run: aether local pull ${state.selectedTag} --yes\n`);
}

async function diagnose(ctx: AppContext, deps: LocalRuntimeDeps): Promise<{ code: number; state?: LocalSnapshot }> {
  const result = await snapshot(ctx, deps);
  if ("message" in result) {
    process.stderr.write(result.message + "\n");
    return { code: result.code };
  }
  writeSnapshot(ctx, result);
  return { code: snapshotExit(result), state: result };
}

export async function cmdSetup(ctx: AppContext, _argv: string[], _flags: unknown, deps: LocalRuntimeDeps = productionDeps): Promise<number> {
  if (_argv.length !== 0) {
    process.stderr.write("usage: aether setup --local\n");
    return LOCAL_EXIT.usage;
  }
  if (!ctx.flags.local) {
    process.stderr.write("usage: aether setup --local\nThis bounded setup path diagnoses local Ollama only; it does not switch backends.\n");
    return LOCAL_EXIT.usage;
  }
  const result = await diagnose(ctx, deps);
  if (result.code === 0) process.stdout.write("Ready. Start explicitly with: aether agent --local <task>\n");
  return result.code;
}

export async function cmdLocal(ctx: AppContext, argv: string[], _flags: unknown, deps: LocalRuntimeDeps = productionDeps): Promise<number> {
  const sub = argv[0] ?? "doctor";
  if (sub === "doctor") {
    if (argv.length !== 1) {
      process.stderr.write("usage: aether local doctor\n");
      return LOCAL_EXIT.usage;
    }
    return (await diagnose(ctx, deps)).code;
  }

  if (sub === "models") {
    if (argv.length !== 1) {
      process.stderr.write("usage: aether local models\n");
      return LOCAL_EXIT.usage;
    }
    const result = await snapshot(ctx, deps);
    if ("message" in result) {
      process.stderr.write(result.message + "\n");
      return result.code;
    }
    const failure = runtimeFailure(result, false);
    if (failure !== null) return failure;
    if (result.models.length === 0) {
      process.stderr.write("No local models are installed. Run: aether local pull <model> --yes\n");
      return LOCAL_EXIT.emptyModels;
    }
    if (ctx.flags.json) process.stdout.write(JSON.stringify(result.models.map(localModelId), null, 2) + "\n");
    else for (const tag of result.models) process.stdout.write(`${tag === result.selectedTag ? "*" : " "} ${localModelId(tag)}\n`);
    return LOCAL_EXIT.ok;
  }

  if (sub === "use") {
    const raw = argv[1];
    if (!raw || argv.length !== 2) {
      process.stderr.write("usage: aether local use <model>\n");
      return LOCAL_EXIT.usage;
    }
    let tag: string;
    try {
      tag = requestedTag(raw);
    } catch (error) {
      process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
      return LOCAL_EXIT.usage;
    }
    const result = await snapshot(ctx, deps);
    if ("message" in result) {
      process.stderr.write(result.message + "\n");
      return result.code;
    }
    const failure = runtimeFailure(result, false);
    if (failure !== null) return failure;
    if (result.models.length === 0) {
      process.stderr.write(`No local models are installed. Run: aether local pull ${tag} --yes\n`);
      return LOCAL_EXIT.emptyModels;
    }
    if (!result.models.includes(tag)) {
      process.stderr.write(`Model ${localModelId(tag)} is not installed. Run: aether local pull ${tag} --yes\n`);
      return LOCAL_EXIT.selectedMissing;
    }
    const id = localModelId(tag);
    const hostedDefault = cleanLine(ctx.cfg.defaultModel) || "automatic";
    const backend = cleanLine(ctx.cfg.backend) || "auto";
    process.stderr.write(`Plan\n  write localModel = ${id}\n  hosted defaultModel remains ${hostedDefault}\n  backend setting remains ${backend}\n`);
    if (!(await approveMutation(ctx, "Apply this local model selection? [y/N] "))) {
      process.stderr.write("No changes made.\n");
      return LOCAL_EXIT.declined;
    }
    const previous = ctx.cfg.localModel;
    ctx.cfg.localModel = id;
    try {
      deps.save(ctx);
    } catch (error) {
      ctx.cfg.localModel = previous;
      process.stderr.write(`Could not save the local model selection: ${cleanLine(error instanceof Error ? error.message : String(error))}\n`);
      return LOCAL_EXIT.mutationFailed;
    }
    process.stdout.write(`local model → ${id}\nBackend was not changed. Use --local when you want Ollama.\n`);
    return LOCAL_EXIT.ok;
  }

  if (sub === "pull") {
    const raw = argv[1];
    if (!raw || argv.length !== 2) {
      process.stderr.write("usage: aether local pull <model> [--yes]\n");
      return LOCAL_EXIT.usage;
    }
    let tag: string;
    try {
      tag = requestedTag(raw);
    } catch (error) {
      process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
      return LOCAL_EXIT.usage;
    }
    process.stderr.write(`Plan\n  run: ollama pull ${tag}\n  may download model data; config and backend remain unchanged\n`);
    if (!(await approveMutation(ctx, "Run this pull? [y/N] "))) {
      process.stderr.write("No changes made.\n");
      return LOCAL_EXIT.declined;
    }
    const binary = deps.run("ollama", ["--version"], PROBE_TIMEOUT_MS);
    if (binary.timedOut || binary.errorCode === "ETIMEDOUT") {
      process.stderr.write("The Ollama binary check timed out; inspect the installation and retry.\n");
      return LOCAL_EXIT.timeout;
    }
    if (binary.status !== 0) {
      if (binary.errorCode === "ENOENT") {
        process.stderr.write("Ollama binary not found on PATH. Install Ollama and retry.\n");
        return LOCAL_EXIT.binaryAbsent;
      }
      process.stderr.write(`Ollama binary could not run${binary.errorCode ? ` (${binary.errorCode})` : ""}; repair the installation and retry.\n`);
      return LOCAL_EXIT.operationFailed;
    }
    const controller = new AbortController();
    const cancelPull = (): void => controller.abort();
    process.once("SIGINT", cancelPull);
    process.once("SIGTERM", cancelPull);
    let pulled: LocalProcessResult;
    try {
      pulled = await deps.pull("ollama", ["pull", tag], PULL_TIMEOUT_MS, (chunk) => {
        process.stderr.write(chunk);
      }, controller.signal);
    } finally {
      process.removeListener("SIGINT", cancelPull);
      process.removeListener("SIGTERM", cancelPull);
    }
    if (pulled.cancelled) {
      process.stderr.write("Ollama pull cancelled; the pull process tree was stopped.\n");
      return LOCAL_EXIT.cancelled;
    }
    if (pulled.timedOut || pulled.errorCode === "ETIMEDOUT") {
      process.stderr.write("Ollama pull timed out after 30 minutes; retry when the connection is stable.\n");
      return LOCAL_EXIT.timeout;
    }
    if (pulled.status !== 0) {
      process.stderr.write(`Ollama pull failed${cleanLine(pulled.stderr) ? `: ${cleanLine(pulled.stderr)}` : "."}\n`);
      return LOCAL_EXIT.operationFailed;
    }
    process.stdout.write(`pulled ${localModelId(tag)}\nSelection and backend were not changed.\n`);
    return LOCAL_EXIT.ok;
  }

  process.stderr.write("usage: aether local <doctor|models|use <model>|pull <model>>\n");
  return LOCAL_EXIT.usage;
}
