import { ShellSession, type ShellCommandEvent } from "../core/shell_session.js";
import { randomUUID } from "node:crypto";
import { ToolExecutor } from "../core/tool_executor.js";
import { TerminalPty } from "../core/terminal_pty.js";
import { BoundedOutput } from "../core/bounded_output.js";
import { ShellAttachmentPreview, captureShellResult, type ShellAttachment, type ShellCapture } from "./shell_attachment.js";
import { scanForSecrets } from "../core/redaction.js";
import { sanitizeServerText } from "../core/transport.js";

/** Classify before history, prompt rewriting, or the busy queue. */
export type ConsoleInput =
  | { kind: "shell"; command: string }
  | { kind: "reset-shell" }
  | { kind: "share"; action: "preview" | "send" | "cancel" | "edit" | "lines" | "drop" | "replace" | "mask" | "redact"; text?: string; first?: number; last?: number; value?: string }
  | ShellAttachment
  | { kind: "error"; message: string }
  | { kind: "chat"; text: string }
  | { kind: "empty" };

export function classifyConsoleInput(raw: string): ConsoleInput {
  const text = raw.trim();
  if (!text) return { kind: "empty" };
  if (/^\/shell-result(?:\s|$)/.test(text)) {
    if (text === "/shell-result") return { kind: "share", action: "preview" };
    const action = text.slice("/shell-result".length).trim();
    if (action === "preview" || action === "lines" || action === "redact" || action === "send" || action === "cancel") return { kind: "share", action };
    const edit = /^edit(?:[ \t]+([\s\S]*))?$/.exec(action);
    if (edit) return { kind: "share", action: "edit", text: edit[1] ?? "" };
    const drop = /^drop\s+(\d+)(?:-(\d+))?$/.exec(action);
    if (drop) return { kind: "share", action: "drop", first: Number(drop[1]), last: Number(drop[2] ?? drop[1]) };
    const replace = /^replace\s+(\d+)(?:[ \t]+([\s\S]*))?$/.exec(action);
    if (replace) return { kind: "share", action: "replace", first: Number(replace[1]), value: replace[2] ?? "" };
    const mask = /^mask[ \t]+([\s\S]+)$/.exec(action);
    if (mask) return { kind: "share", action: "mask", value: mask[1] };
    return { kind: "error", message: "usage: /shell-result [preview|lines|drop <first>[-<last>]|replace <line> <text>|mask <literal>|redact|edit <text>|send|cancel]" };
  }
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
  private terminal: TerminalPty | null = null;
  static isTerminalCommand(text: string): boolean { return /^\/terminal(?:\s|$)|^\/terminal-(?:attach|stop|status)$/.test(text.trim()); }
  async terminalCommand(text: string): Promise<void> {
    const command = text.trim();
    if (command === "/terminal-status") {
      this.write(this.terminal ? `terminal ${this.terminal.id} | ${this.terminal.state}\n` : "No running terminal.\n"); return;
    }
    if (command === "/terminal-stop") {
      const terminal = this.terminal;
      if (!terminal) { this.write("No running terminal.\n"); return; }
      terminal.stop(); await terminal.finished; this.write(`terminal ${terminal.id} stopped\n`); return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY || this.json) {
      this.write("Interactive terminal requires Linux, Python 3 and TTY input/output; use !command for pipes/CI.\n"); return;
    }
    if (command === "/terminal-attach") {
      if (!this.terminal) { this.write("No running terminal.\n"); return; }
      await this.terminal.attach(process.stdin, process.stdout); return;
    }
    const shellCommand = command.slice("/terminal".length).trim();
    if (!shellCommand) { this.write("usage: /terminal <command>; Ctrl+] detaches; /terminal-attach, /terminal-stop, /terminal-status\n"); return; }
    if (this.terminal) { this.write("A terminal is already running; attach or stop it first.\n"); return; }
    if (process.platform !== "linux") { this.write("Interactive PTY requires Linux; use !command on this platform.\n"); return; }
    const release = await this.exec.beginUserTerminal();
    let terminal: TerminalPty;
    try { terminal = new TerminalPty(this.exec.shellCwd, shellCommand, process.stdout.rows, process.stdout.columns); }
    catch (error) { release(); throw error; }
    this.terminal = terminal;
    void terminal.finished.then(code => {
      try { release(); } catch (error) { this.write(`terminal ownership reconciliation failed: ${sanitizeServerText(String(error))}\n`); }
      if (this.terminal === terminal) this.terminal = null;
      this.write(`\nterminal ${terminal.id} exited ${code}${terminal.diagnostic() ? ": " + sanitizeServerText(terminal.diagnostic()) : ""}\n`);
    });
    await terminal.attach(process.stdin, process.stdout);
  }
  private result: ShellCapture | null = null;
  private scriptSendAvailable = false;
  private captureEvent: ShellCommandEvent | null = null;
  private readonly attachmentPreview = new ShellAttachmentPreview();
  readonly session: ShellSession;
  readonly exec: ToolExecutor;
  constructor(root: string, private readonly write: (text: string) => void, private readonly json = false) {
    this.session = new ShellSession(root, event => this.event(event));
    this.exec = new ToolExecutor(root, undefined, { mode: "coding", ...(process.platform === "win32" ? {} : { shellSession: this.session }) });
  }
  private event(event: ShellCommandEvent): void {
    if (event.origin === "user" && event.state === "running") this.captureEvent = { ...event };
    if (this.json) this.write(JSON.stringify({ type: "shell_command", ...event }) + "\n");
    else this.write(event.state === "running" ? `[shell ${event.origin} | cwd ${sanitizeServerText(event.cwd)} | session ${event.sessionId} | command ${event.commandId} | running] !${sanitizeServerText(event.command)}\n` : `[shell ${event.origin} | ${event.state} | exit ${event.exitCode} | session ${event.sessionId} | command ${event.commandId} | cwd ${sanitizeServerText(event.cwd)}]\n`);
  }
  async run(input: string | Extract<ConsoleInput, { kind: "shell" | "reset-shell" }>, signal?: AbortSignal): Promise<"completed" | "aborted" | "failed"> {
    if (typeof input === "string") input = { kind: "shell", command: input };
    this.result = null;
    this.scriptSendAvailable = false;
    this.captureEvent = null;
    if (input.kind === "reset-shell") {
      if (this.terminal) { this.write("Stop the interactive terminal before resetting shell state.\n"); return "failed"; }
      this.attachmentPreview.cancel();
      this.session.reset();
      this.write(this.json ? JSON.stringify({ type: "shell_reset", sessionId: this.session.id, cwd: this.session.cwd }) + "\n" : "shell reset — cwd/environment/functions cleared; commands were not replayed.\n");
      return "completed";
    }
    const fallback = process.platform === "win32" ? {
      sessionId: this.session.id, commandId: randomUUID(), origin: "user" as const,
      command: input.command, cwd: this.session.cwd,
    } : null;
    if (fallback) this.event({ ...fallback, state: "running" });
    const captureCwd = this.exec.shellCwd;
    const captureSession = this.session.id;
    const captured = new BoundedOutput(7000);
    let streamed = false;
    const result = await this.exec.runUserCommand(input.command, { ...(signal ? { signal } : {}), onOutput: text => {
      streamed = true;
      captured.append(text);
      this.write(this.json ? JSON.stringify({ type: "shell_output", sessionId: this.session.id, text }) + "\n" : sanitizeServerText(text));
    } });
    if (fallback) this.event({ ...fallback, state: result.exitCode === 130 ? "cancelled" : "completed", exitCode: result.exitCode });
    if (!streamed) captured.append(result.output);
    const snapshot = captured.snapshot();
    const event = this.captureEvent as ShellCommandEvent | null;
    const commandId = event?.commandId ?? randomUUID();
    // Capture provenance before later commands can change cwd/session/output.
    const metadata = `session: ${event?.sessionId ?? captureSession}\ncommand id: ${commandId}\ncaptured cwd: ${event?.cwd ?? captureCwd}\nexit: ${result.exitCode}\ncommand: !${input.command}`;
    this.result = captureShellResult(event?.sessionId ?? captureSession, commandId, metadata, snapshot.text, snapshot.omittedBytes);
    this.scriptSendAvailable = true;
    // Stream once; retain the bounded capture for explicit sharing. Refusal and
    // state-loss explanations still render even when some output was streamed.
    const visible = streamed ? result.output.split("\n", 1)[0]! : result.output;
    this.write(this.json ? JSON.stringify({ type: "shell_result", sessionId: this.session.id, ...result }) + "\n" : sanitizeServerText(visible) + "\n");
    // A normal nonzero exit returns to chat and may drain later submissions.
    return result.exitCode === 130 ? "aborted" : this.session.state === "lost" ? "failed" : "completed";
  }
  private shareNotice(message: string, code: string): void {
    this.write(this.json ? JSON.stringify({ type: "shell_share", code, message }) + "\n" : message + "\n");
  }
  /** Local preview/edit/cancel never enters model routing or ordinary history. */
  share(input: Extract<ConsoleInput, { kind: "share" }> = { kind: "share", action: "preview" }, scripted = false): ShellAttachment | Extract<ConsoleInput, { kind: "empty" | "error" }> {
    if (input.action === "send") {
      // Explicit script send may stage one fresh capture; never resurrect a
      // sent/cancelled/empty selection or silently substitute for an open draft.
      if (scripted && !this.attachmentPreview.hasPending && this.scriptSendAvailable) this.attachmentPreview.preview(this.result);
      this.scriptSendAvailable = false;
      const sent = this.attachmentPreview.send();
      return typeof sent === "string" ? { kind: "error", message: sent } : sent;
    }
    if (input.action === "cancel") {
      this.attachmentPreview.cancel();
      this.scriptSendAvailable = false;
      this.shareNotice("Shell preview cancelled; nothing sent.", "cancelled");
      return { kind: "empty" };
    }
    let preview = this.attachmentPreview.preview(this.result);
    if (!preview) return { kind: "error", message: "No local shell result to preview." };
    if (input.action === "lines") {
      const lines = preview.body.split("\n").map((text, index) => ({ line: index + 1, text }));
      this.write(this.json ? JSON.stringify({ type: "shell_share_lines", sessionId: preview.capture.sessionId, commandId: preview.capture.commandId, lines }) + "\n" : lines.map(line => `${line.line} | ${line.text}`).join("\n") + "\n");
      return { kind: "empty" };
    }
    let edited: ShellAttachment | string = preview;
    if (input.action === "edit") edited = this.attachmentPreview.edit(input.text ?? "");
    else if (input.action !== "preview") edited = this.attachmentPreview.editLines(input.action, input.first, input.last, input.value);
    if (typeof edited === "string") return { kind: "error", message: edited };
    preview = edited;
    if (input.action === "redact") this.shareNotice("Common-pattern redaction aid applied; review all text, no guarantee.", "redacted");
    if (!preview || typeof preview === "string") return { kind: "error", message: preview ?? "No local shell result to preview." };
    if (this.json) this.write(JSON.stringify({ type: "shell_share_preview", sessionId: preview.capture.sessionId, commandId: preview.capture.commandId, omittedBytes: preview.capture.formattingOmittedBytes, sourceOmittedBytes: preview.capture.outputOmittedBytes, possibleSecrets: scanForSecrets(preview.text), bytes: Buffer.byteLength(preview.text), text: preview.text, attachment: preview.text }) + "\n");
    else this.write(`Shell attachment preview (${Buffer.byteLength(preview.text)} UTF-8 bytes):\n${preview.text}\nEnd of attachment. Redaction is an aid, not a guarantee; review all text and metadata.\n/shell-result lines | drop <first>[-<last>] | replace <line> <text> | mask <literal> | redact | edit <text> | send | cancel\n`);
    return { kind: "empty" };
  }
  prompt(): string { return `[${sanitizeServerText(this.session.cwd)}${this.session.state === "lost" ? "; shell lost" : ""}] `; }
  close(): void { this.attachmentPreview.cancel(); this.result = null; this.scriptSendAvailable = false; this.terminal?.stop(); this.session.close(); }
}
