import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";

/** Kept below the coding transport's request body limit, including its context. */
export const MAX_PROMPT_FILE_BYTES = 256 * 1024;

export interface PromptInput {
  kind: "file" | "stdin";
  bytes: number;
  /** The selected path, not a directory scan or a second read. */
  path?: string;
}

export function promptInputLabel(input: PromptInput): string {
  return input.kind === "stdin" ? "stdin prompt" : "prompt file";
}

export function promptFileConflict(
  positionals: readonly string[],
  flags: { resume?: string; interactive?: boolean; withToken?: boolean; managedAgent?: boolean },
): string | null {
  if (positionals.length) return "--prompt-file cannot be combined with a positional task or managed-agent verb";
  if (flags.resume !== undefined) return "--prompt-file cannot be combined with --resume";
  if (flags.interactive) return "--prompt-file cannot be combined with --interactive";
  if (flags.withToken) return "--prompt-file cannot be combined with --with-token (both may read stdin)";
  if (flags.managedAgent) return "--prompt-file is for coding tasks, not managed-agent chat";
  return null;
}

/** Read exactly one explicit source, rejecting before a model or session starts. */
export async function readPromptFile(
  source: string,
  stdin: Readable = process.stdin,
): Promise<{ task: string; input: PromptInput }> {
  if (!source) throw new Error("--prompt-file needs a file path or - for stdin");
  const input: PromptInput = source === "-"
    ? { kind: "stdin", bytes: 0 }
    : { kind: "file", path: source, bytes: 0 };
  const stream = source === "-" ? stdin : createReadStream(source, { highWaterMark: 64 * 1024 });
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      input.bytes += bytes.length;
      if (input.bytes > MAX_PROMPT_FILE_BYTES) {
        throw new Error(`prompt input exceeds ${MAX_PROMPT_FILE_BYTES} bytes (256 KiB)`);
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("prompt input exceeds ")) throw error;
    throw new Error(`cannot read ${source === "-" ? "stdin" : `prompt file ${source}`}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let task: string;
  try {
    task = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error("prompt input is not valid UTF-8");
  }
  if (!task.trim()) throw new Error("prompt input is empty or whitespace only");
  return { task, input };
}
