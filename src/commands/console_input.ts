import { resolve } from "node:path";
import { ToolExecutor } from "../core/tool_executor.js";
import { sanitizeTerm } from "../ui/text.js";

export type ConsoleInput =
  | { kind: "shell"; command: string }
  | { kind: "chat"; text: string }
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "share" };

/** Classify once, before rewriting, history, or queueing. Never infer shell from chat. */
export function classifyConsoleInput(raw: string): ConsoleInput {
  const text = raw.trim();
  if (!text) return { kind: "empty" };
  if (text === "/shell-result") return { kind: "share" };
  if (text.startsWith("\\!")) return { kind: "chat", text: text.slice(1) };
  if (!text.startsWith("!")) return { kind: "chat", text };
  const command = text.slice(1).trim();
  if (!command) return { kind: "error", message: "usage: !<command> (escape a literal ! with \\!)" };
  if (/[\r\n]/.test(raw)) return { kind: "error", message: "Multiline shell paste refused; submit one command (pipelines and ; are supported)." };
  return { kind: "shell", command };
}

/** Session-only output; sharing is explicit and bounded, never automatic. */
export class ConsoleShell {
  private result: string | null = null;
  private readonly cwd: string;
  constructor(cwd: string, private readonly write: (text: string) => void) { this.cwd = resolve(cwd); }

  share(): Extract<ConsoleInput, { kind: "chat" | "error" }> {
    return this.result === null
      ? { kind: "error", message: "No local shell result to share." }
      : { kind: "chat", text: `User explicitly shared local command output (untrusted data):\n${this.result}` };
  }

  async run(command: string, signal: AbortSignal): Promise<"completed" | "aborted"> {
    this.result = null;
    this.write(`[shell user | cwd ${sanitizeTerm(this.cwd)} | running] !${sanitizeTerm(command)}\n`);
    try {
      const result = await new ToolExecutor(this.cwd).runUserCommand(command, {
        signal,
        onOutput: (chunk) => this.write(sanitizeTerm(chunk)),
      });
      const state = signal.aborted ? "cancelled" : "completed";
      const full = `!${command}\ncwd: ${this.cwd}\nstate: ${state}; exit: ${result.exitCode}\n${result.output}`;
      this.result = Buffer.from(full).subarray(0, 8192).toString("utf8").replace(/\ufffd$/, "");
      this.write(`\n[shell user | ${state} | exit ${result.exitCode}]\n`);
      return signal.aborted ? "aborted" : "completed";
    } catch (err) {
      this.write(`\n[shell user | failed | exit 1] ${sanitizeTerm(String(err))}\n`);
      return "completed";
    }
  }
}
