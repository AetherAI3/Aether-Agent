import { ShellSession, type ShellCommandEvent } from "../core/shell_session.js";
import { randomUUID } from "node:crypto";
import { ToolExecutor } from "../core/tool_executor.js";
import { sanitizeServerText } from "../core/transport.js";

/** Classify before history, prompt rewriting, or the busy queue. */
export type ConsoleInput =
  | { kind: "shell"; command: string }
  | { kind: "reset-shell" }
  | { kind: "share" }
  | { kind: "error"; message: string }
  | { kind: "chat"; text: string }
  | { kind: "empty" };

export function classifyConsoleInput(raw: string): ConsoleInput {
  const text = raw.trim();
  if (!text) return { kind: "empty" };
  if (text === "/shell-result") return { kind: "share" };
  if (text === "/shell-reset") return { kind: "reset-shell" };
  if (text.startsWith("\\!")) return { kind: "chat", text: text.slice(1) };
  if (text.startsWith("!")) {
    const command = text.slice(1).trim();
    return command ? { kind: "shell", command } : { kind: "error", message: "usage: !<command> (escape a literal ! with \\!)" };
  }
  return { kind: "chat", text };
}

/** Local shell presentation is shared by raw TTY and line-mode routing. */
export class ConsoleShell {
  private result: string | null = null;
  readonly session: ShellSession;
  readonly exec: ToolExecutor;
  constructor(root: string, private readonly write: (text: string) => void, private readonly json = false) {
    this.session = new ShellSession(root, event => this.event(event));
    this.exec = new ToolExecutor(root, undefined, { mode: "coding", ...(process.platform === "win32" ? {} : { shellSession: this.session }) });
  }
  private event(event: ShellCommandEvent): void {
    if (this.json) this.write(JSON.stringify({ type: "shell_command", ...event }) + "\n");
    else this.write(event.state === "running" ? `[shell ${event.origin} | cwd ${sanitizeServerText(event.cwd)} | session ${event.sessionId} | command ${event.commandId} | running] !${sanitizeServerText(event.command)}\n` : `[shell ${event.origin} | ${event.state} | exit ${event.exitCode} | session ${event.sessionId} | command ${event.commandId} | cwd ${sanitizeServerText(event.cwd)}]\n`);
  }
  async run(input: string | Extract<ConsoleInput, { kind: "shell" | "reset-shell" }>, signal?: AbortSignal): Promise<"completed" | "aborted" | "failed"> {
    if (typeof input === "string") input = { kind: "shell", command: input };
    this.result = null;
    if (input.kind === "reset-shell") {
      this.session.reset();
      this.write(this.json ? JSON.stringify({ type: "shell_reset", sessionId: this.session.id, cwd: this.session.cwd }) + "\n" : "shell reset — cwd/environment/functions cleared; commands were not replayed.\n");
      return "completed";
    }
    const fallback = process.platform === "win32" ? {
      sessionId: this.session.id, commandId: randomUUID(), origin: "user" as const,
      command: input.command, cwd: this.session.cwd,
    } : null;
    if (fallback) this.event({ ...fallback, state: "running" });
    let streamed = false;
    const result = await this.exec.runUserCommand(input.command, { ...(signal ? { signal } : {}), onOutput: text => {
      streamed = true;
      this.write(this.json ? JSON.stringify({ type: "shell_output", sessionId: this.session.id, text }) + "\n" : sanitizeServerText(text));
    } });
    if (fallback) this.event({ ...fallback, state: result.exitCode === 130 ? "cancelled" : "completed", exitCode: result.exitCode });
    const full = `!${input.command}\ncwd: ${this.session.cwd}\nexit: ${result.exitCode}\n${result.output}`;
    this.result = Buffer.from(full).subarray(0, 8192).toString("utf8").replace(/\ufffd$/, "");
    // Stream once; retain the bounded capture for explicit sharing. Refusal and
    // state-loss explanations still render even when some output was streamed.
    const visible = streamed ? result.output.split("\n", 1)[0]! : result.output;
    this.write(this.json ? JSON.stringify({ type: "shell_result", sessionId: this.session.id, ...result }) + "\n" : sanitizeServerText(visible) + "\n");
    // A normal nonzero exit returns to chat and may drain later submissions.
    return result.exitCode === 130 ? "aborted" : this.session.state === "lost" ? "failed" : "completed";
  }
  share(): Extract<ConsoleInput, { kind: "chat" | "error" }> {
    return this.result === null
      ? { kind: "error", message: "No local shell result to share." }
      : { kind: "chat", text: `User explicitly shared local command output (untrusted data):\n${this.result}` };
  }
  prompt(): string { return `[${sanitizeServerText(this.session.cwd)}${this.session.state === "lost" ? "; shell lost" : ""}] `; }
  close(): void { this.session.close(); }
}
