import { sanitizeTerm } from "../ui/text.js";
import { ModelOutputLimitError } from "./errors.js";

export const DEFAULT_MODEL_OUTPUT_LIMIT_BYTES = 512 * 1024;

/** A finite per-segment cap on model text, independent of progress telemetry. */
export function modelOutputLimitBytes(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const parsed = Number(env["AETHER_MODEL_OUTPUT_LIMIT_BYTES"]);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.floor(parsed))
    : DEFAULT_MODEL_OUTPUT_LIMIT_BYTES;
}

export class ModelOutputBudget {
  private used = 0;

  constructor(private readonly limitBytes = modelOutputLimitBytes()) {}

  add(text: string): void {
    this.used += Buffer.byteLength(sanitizeTerm(text), "utf8");
    if (this.used > this.limitBytes) throw new ModelOutputLimitError(this.limitBytes);
  }

  reset(): void {
    this.used = 0;
  }
}
