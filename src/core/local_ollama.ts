import { DEFAULT_OLLAMA_MODEL } from "./ollama.js";

export const LOCAL_MODEL_PREFIX = "ollama/";
const LEGACY_LOCAL_MODEL_PREFIX = "ollama:";

export function isLocalModelId(value: string | null | undefined): boolean {
  const id = (value ?? "").trim();
  return id.startsWith(LOCAL_MODEL_PREFIX) || id.startsWith(LEGACY_LOCAL_MODEL_PREFIX);
}

/** A local model id is namespaced so it can never be mistaken for a hosted id. */
export function localModelId(tag: string): string {
  const normalized = normalizeOllamaTag(tag);
  return `${LOCAL_MODEL_PREFIX}${normalized}`;
}

/** Return the Ollama tag carried by a namespaced id, or null for hosted ids. */
export function ollamaTagFromId(id: string | null | undefined): string | null {
  const value = (id ?? "").trim();
  const prefix = value.startsWith(LOCAL_MODEL_PREFIX) ? LOCAL_MODEL_PREFIX
    : value.startsWith(LEGACY_LOCAL_MODEL_PREFIX) ? LEGACY_LOCAL_MODEL_PREFIX : null;
  if (!prefix) return null;
  const tag = value.slice(prefix.length);
  try {
    return normalizeOllamaTag(tag);
  } catch {
    return null;
  }
}

/**
 * Resolve the tag for a local run. A bare explicit --model remains supported,
 * because --local makes that intent unambiguous. A saved default is used only
 * when it carries the ollama/ namespace; hosted defaults never become tags.
 */
export function resolveLocalModel(
  explicit: string | undefined,
  savedDefault: string,
  options: { allowBareExplicit?: boolean } = {},
): string {
  if (explicit?.trim()) {
    const local = ollamaTagFromId(explicit);
    if (local) return local;
    if (isLocalModelId(explicit)) throw new Error(`Invalid local model id ${JSON.stringify(explicit.trim())}`);
    if (options.allowBareExplicit) return normalizeOllamaTag(explicit);
    throw new Error(
      `Model ${JSON.stringify(explicit.trim())} is not a local model id. ` +
        `Use ${LOCAL_MODEL_PREFIX}<tag>, or pass --local to opt into the legacy bare-tag form.`,
    );
  }
  return ollamaTagFromId(savedDefault) ?? DEFAULT_OLLAMA_MODEL;
}

/** A cloud request must never carry a local Ollama namespace. */
export function resolveHostedModel(explicit: string | undefined, hostedDefault = ""): string {
  const selected = explicit?.trim() || hostedDefault.trim();
  if (isLocalModelId(selected)) {
    throw new Error(
      `Model ${JSON.stringify(selected)} is local-only and cannot be sent to the hosted backend. ` +
        "Run with --local or choose a hosted model id.",
    );
  }
  return selected;
}

export function resolveLocalModelSelection(
  explicit: string | undefined,
  savedDefault: string,
  options: { allowBareExplicit?: boolean } = {},
): { tag: string; id: string } {
  const tag = resolveLocalModel(explicit, savedDefault, options);
  return { tag, id: localModelId(tag) };
}

/** Validate a tag before it reaches argv, config, a URL, or terminal output. */
export function normalizeOllamaTag(raw: string): string {
  const tag = raw.trim();
  if (!tag) throw new Error("Ollama model tag is empty");
  if (tag.length > 200) throw new Error("Ollama model tag is too long (maximum 200 characters)");
  if (/[\u0000-\u001f\u007f\s]/.test(tag)) throw new Error("Ollama model tag cannot contain whitespace or control characters");
  // Ollama names are path-like and may include a registry port and a :tag.
  // This deliberately excludes option-looking values and URL/query syntax.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:\-]*$/.test(tag) || tag.includes("..") || tag.endsWith("/")) {
    throw new Error(`Invalid Ollama model tag ${JSON.stringify(tag)}`);
  }
  return tag;
}
