// Installed models at one Ollama endpoint. Discovery never invokes Aether or
// Ollama's pull API, and keeps the inference destination out of model IDs.
import { normalizeOllamaHost } from "./ollama.js";
import { normalizeOllamaTag } from "./local_ollama.js";

export type OllamaModelsFailure = "unreachable" | "timeout" | "malformed";

export class OllamaModelsError extends Error {
  constructor(readonly reason: OllamaModelsFailure, message: string) {
    super(message);
    this.name = "OllamaModelsError";
  }
}

export function parseInstalledOllamaTags(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OllamaModelsError("malformed", "Ollama /api/tags must return an object");
  }
  const models = (value as Record<string, unknown>)["models"];
  if (!Array.isArray(models)) {
    throw new OllamaModelsError("malformed", "Ollama /api/tags has no models array");
  }
  const tags: string[] = [];
  for (const item of models) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new OllamaModelsError("malformed", "Ollama /api/tags contains an invalid model");
    }
    const name = (item as Record<string, unknown>)["name"];
    if (typeof name !== "string") {
      throw new OllamaModelsError("malformed", "Ollama /api/tags contains a model without a name");
    }
    try { tags.push(normalizeOllamaTag(name)); }
    catch { throw new OllamaModelsError("malformed", "Ollama /api/tags contains an invalid model name"); }
  }
  return [...new Set(tags)].sort();
}

/** The caller supplies an already normalized endpoint; abort covers headers and body. */
export async function requestOllamaTags(endpoint: string, timeoutMs = 5_000, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(`${endpoint}/api/tags`, { signal: controller.signal });
    if (!response.ok) throw new OllamaModelsError("unreachable", `Ollama /api/tags returned HTTP ${response.status}`);
    try { return await response.json() as unknown; }
    catch (error) {
      if (controller.signal.aborted) throw error;
      throw new OllamaModelsError("malformed", "Ollama /api/tags returned invalid JSON");
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (timedOut) throw new OllamaModelsError("timeout", "Ollama /api/tags timed out");
    if (error instanceof OllamaModelsError) throw error;
    throw new OllamaModelsError("unreachable", "Cannot reach Ollama /api/tags");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function listInstalledOllamaModels(rawHost = process.env["OLLAMA_HOST"], signal?: AbortSignal): Promise<{ endpoint: string; tags: string[] }> {
  const endpoint = normalizeOllamaHost(rawHost);
  return { endpoint, tags: parseInstalledOllamaTags(await requestOllamaTags(endpoint, 5_000, signal)) };
}
