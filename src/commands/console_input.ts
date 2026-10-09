import { ShellSession, type ShellCommandEvent } from "../core/shell_session.js";
import { randomUUID } from "node:crypto";
import { ToolExecutor } from "../core/tool_executor.js";
import { TerminalPty } from "../core/terminal_pty.js";
import { ShellAttachmentPreview, captureShellResult, type ShellCapture, type ShellAttachment } from "./shell_attachment.js";
import { sanitizeServerText } from "../core/transport.js";
import { scanForSecrets } from "../core/redaction.js";
import type { RunCapability } from "../core/run_capability.js";
import { discoverShellProfiles, type ShellProfile } from "../core/shell_profiles.js";

type ShareAction = "preview" | "lines" | "drop" | "replace" | "mask" | "redact" | "send" | "cancel";
/** Only Send preparation creates an immutable approved attachment. */
type ShareInput = { kind: "share"; action: ShareAction; first?: number; last?: number; value?: string; approved?: ShellAttachment };

const SHARE_USAGE = "usage: /shell-result [preview|lines|drop <first>[-<last>]|replace <line> <text>|mask <literal>|redact|send|cancel]";

/** Classify before history, prompt rewriting, or the busy queue. */
export type ConsoleInput =
  | { kind: "shell"; command: string }
  | { kind: "reset-shell" }
  | { kind: "profile"; action: "list" | "status" | "use"; profile?: "cmd" | "powershell" }
  | ShareInput
  | { kind: "error"; message: string }
  | { kind: "chat"; text: string; capability?: RunCapability;
      /** Only idle /skill admission can set this; queued edits never resolve a skill. */
      oneTurnSkill?: { reference: string; source: string } }
  | { kind: "empty" };

export function classifyConsoleInput(raw: string): ConsoleInput {
  const text = raw.trim();
  if (!text) return { kind: "empty" };
  if (text === "/shell-result" || text === "/shell-result preview") return { kind: "share", action: "preview" };
  if (text.startsWith("/shell-result ")) {
    const action = text.slice("/shell-result ".length);
    if (action === "lines" || action === "redact" || action === "send" || action === "cancel") return { kind: "share", action };
    const drop = /^drop\s+(\d+)(?:-(\d+))?$/.exec(action);
    if (drop) return { kind: "share", action: "drop", first: Number(drop[1]), last: Number(drop[2] ?? drop[1]) };
    const replace = /^replace\s+(\d+)\s+([\s\S]+)$/.exec(action);
    if (replace) return { kind: "share", action: "replace", first: Number(replace[1]), value: replace[2] };
    const mask = /^mask\s+([\s\S]+)$/.exec(action);
    if (mask) return { kind: "share", action: "mask", value: mask[1] };
    return { kind: "error", message: SHARE_USAGE };
  }
  if (text === "/shell-reset") return { kind: "reset-shell" };
  if (text === "/shell-profile" || text === "/shell-profile list") return { kind: "profile", action: "list" };
  if (text === "/shell-profile status") return { kind: "profile", action: "status" };
  const profile = /^\/shell-profile use (cmd|powershell)$/.exec(text);
  if (profile) return { kind: "profile", action: "use", profile: profile[1] as "cmd" | "powershell" };
  if (text.startsWith("/shell-profile ")) return { kind: "error", message: "usage: /shell-profile [list|status|use cmd|use powershell]" };
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
  private profile: ShellProfile;
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
  private latest: ShellCapture | null = null;
  private readonly attachmentPreview = new ShellAttachmentPreview();
  private scriptSendAvailable = false;
  private activeUserEvent: ShellCommandEvent | null = null;
  session: ShellSession;
  exec: ToolExecutor;
  constructor(private readonly root: string, private readonly write: (text: string) => void, private readonly json = false) {
    this.profile = process.platform === "win32" ? "cmd" : "bash";
    this.session = new ShellSession(root, event => this.event(event), this.profile);
    this.exec = this.newExecutor();
  }
  private newExecutor(): ToolExecutor {
    return new ToolExecutor(this.root, undefined, { mode: "coding",
      ...(this.profile === "cmd" ? { shellContextId: () => this.session.id } : { shellSession: this.session }) });
  }
  /** Profile selection only runs at a console command boundary. */
  profileCommand(input: Extract<ConsoleInput, { kind: "profile" }>): boolean {
    if (input.action === "status") {
      const status = { type: "shell_profile", profile: this.profile, sessionId: this.session.id,
        cwd: this.session.cwd, state: this.session.state, executable: this.session.shell };
      this.write(this.json ? JSON.stringify(status) + "\n"
        : `Shell ${status.profile} | ${status.state} | session ${status.sessionId} | cwd ${sanitizeServerText(status.cwd)} | ${sanitizeServerText(status.executable)}\n`);
      return false;
    }
    const profiles = discoverShellProfiles();
    if (input.action === "list") {
      if (this.json) this.write(JSON.stringify({ type: "shell_profiles", active: this.profile, profiles }) + "\n");
      else for (const item of profiles) this.write(`${item.profile === this.profile ? "*" : " "} ${item.profile}: ${item.ready ? `ready | ${item.version} | ${item.executable}` : `unavailable | ${item.reason}`}\n`);
      return false;
    }
    const wanted = profiles.find(item => item.profile === input.profile);
    if (!wanted) {
      this.write("This shell profile is unavailable on this platform. Run /shell-profile list.\n"); return false;
    }
    if (!wanted.ready || !wanted.executable) {
      this.write(`${wanted.reason ?? "Shell executable unavailable."}\n`); return false;
    }
    if (this.profile === wanted.profile) {
      this.write(`Shell ${this.profile} is already active; state preserved.\n`); return false;
    }
    if (this.terminal || this.session.busy) {
      this.write("Stop the active terminal or wait for the shell command before changing profiles.\n"); return false;
    }
    const old = this.profile;
    this.exec.close();
    this.session.close();
    this.profile = wanted.profile;
    this.session = new ShellSession(this.root, event => this.event(event), wanted.profile, wanted.executable);
    this.exec = this.newExecutor();
    this.latest = null; this.attachmentPreview.cancel(); this.scriptSendAvailable = false; this.activeUserEvent = null;
    const changed = { type: "shell_profile_changed", from: old, profile: this.profile,
      sessionId: this.session.id, cwd: this.session.cwd, executable: wanted.executable, version: wanted.version };
    this.write(this.json ? JSON.stringify(changed) + "\n"
      : `Shell switched to ${this.profile} (${sanitizeServerText(wanted.version ?? "version unknown")}); session ${this.session.id}; cwd ${sanitizeServerText(this.session.cwd)}. Previous shell state and staged result discarded; commands were not replayed.\n`);
    return true;
  }
  private event(event: ShellCommandEvent): void {
    if (event.origin === "user" && event.state === "running") this.activeUserEvent = event;
    if (this.json) this.write(JSON.stringify({ type: "shell_command", ...event }) + "\n");
    else this.write(event.state === "running" ? `[shell ${event.origin} | profile ${event.profile ?? this.profile} | cwd ${sanitizeServerText(event.cwd)} | session ${event.sessionId} | command ${event.commandId} | running] !${sanitizeServerText(event.command)}\n` : `[shell ${event.origin} | profile ${event.profile ?? this.profile} | ${event.state} | exit ${event.exitCode} | session ${event.sessionId} | command ${event.commandId} | cwd ${sanitizeServerText(event.cwd)}]\n`);
  }
  async run(input: string | Extract<ConsoleInput, { kind: "shell" | "reset-shell" }>, signal?: AbortSignal): Promise<"completed" | "aborted" | "failed"> {
    if (typeof input === "string") input = { kind: "shell", command: input };
    this.latest = null;
    this.scriptSendAvailable = false;
    this.activeUserEvent = null;
    if (input.kind === "reset-shell") {
      if (this.terminal) { this.write("Stop the interactive terminal before resetting shell state.\n"); return "failed"; }
      this.attachmentPreview.cancel();
      this.session.reset();
      this.write(this.json ? JSON.stringify({ type: "shell_reset", profile: this.profile, sessionId: this.session.id, cwd: this.session.cwd }) + "\n" : `shell reset — cwd/environment/functions cleared; commands were not replayed (profile ${this.profile}).\n`);
      return "completed";
    }
    const fallback = this.profile === "cmd" ? {
      sessionId: this.session.id, commandId: randomUUID(), origin: "user" as const,
      command: input.command, cwd: this.session.cwd, profile: this.profile,
    } : null;
    if (fallback) this.event({ ...fallback, state: "running" });
    const captureSession = this.session.id;
    const captureCwd = this.exec.shellCwd;
    let streamed = false;
    const result = await this.exec.runUserCommand(input.command, { ...(signal ? { signal } : {}), onOutput: text => {
      streamed = true;
      this.write(this.json ? JSON.stringify({ type: "shell_output", sessionId: this.session.id, text }) + "\n" : sanitizeServerText(text));
    } });
    if (fallback) this.event({ ...fallback, state: result.exitCode === 130 ? "cancelled" : "completed", exitCode: result.exitCode });
    const source = this.activeUserEvent ?? fallback ?? {
      sessionId: captureSession, commandId: randomUUID(), origin: "user" as const,
      command: input.command, cwd: captureCwd,
    };
    const metadata = `session: ${source.sessionId}\ncommand id: ${source.commandId}\ncaptured cwd: ${source.cwd}\nexit: ${result.exitCode}\ncommand: !${source.command}`;
    this.latest = captureShellResult(source.sessionId, source.commandId, metadata, result.output, result.capture?.omittedBytes ?? 0);
    this.scriptSendAvailable = true;
    // Stream once; retain the bounded capture for explicit sharing. Refusal and
    // state-loss explanations still render even when some output was streamed.
    const visible = streamed ? result.output.split("\n", 1)[0]! : result.output;
    this.write(this.json ? JSON.stringify({ type: "shell_result", profile: this.profile, sessionId: this.session.id, ...result }) + "\n" : sanitizeServerText(visible) + "\n");
    // A normal nonzero exit returns to chat and may drain later submissions.
    return result.exitCode === 130 ? "aborted" : (this.session.state === "lost" || this.session.id !== captureSession) ? "failed" : "completed";
  }
  private shareNotice(message: string, code = "info"): void {
    this.write(this.json
      ? JSON.stringify({ type: "shell_share", code, message }) + "\n"
      : message + "\n");
  }

  /** Synchronous local preparation precedes queueing or any model await. */
  prepareShare(input: ShareInput = { kind: "share", action: "preview" }, scripted = false): ShareInput | Extract<ConsoleInput, { kind: "empty" }> {
    if (input.approved) return input;
    if (input.action === "cancel") {
      this.attachmentPreview.cancel();
      this.scriptSendAvailable = false;
      this.shareNotice("Shell result preview cancelled; nothing from that preview was sent. Use /queue remove to withdraw an already-approved queued send.", "cancelled");
      return { kind: "empty" };
    }
    if (input.action === "send") {
      if (scripted && !this.attachmentPreview.hasPending && this.scriptSendAvailable) this.attachmentPreview.preview(this.latest);
      this.scriptSendAvailable = false;
      const approved = this.attachmentPreview.send();
      if (typeof approved === "string") { this.shareNotice(approved, "missing"); return { kind: "empty" }; }
      return Object.freeze({ kind: "share", action: "send", approved });
    }
    let preview = this.attachmentPreview.preview(this.latest);
    if (!preview) { this.shareNotice("No local shell result to preview.", "missing"); return { kind: "empty" }; }
    if (input.action === "lines") {
      const lines = preview.body.split("\n").map((text, index) => ({ line: index + 1, text }));
      this.write(this.json ? JSON.stringify({ type: "shell_share_lines", sessionId: preview.capture.sessionId, commandId: preview.capture.commandId, lines }) + "\n" : lines.map(line => `${String(line.line).padStart(3)} | ${line.text}`).join("\n") + "\n");
      return { kind: "empty" };
    }
    if (input.action !== "preview") {
      const edited = this.attachmentPreview.editLines(input.action, input.first, input.last, input.value);
      if (typeof edited === "string") { this.shareNotice(edited, "invalid"); return { kind: "empty" }; }
      preview = edited;
    }
    if (input.action === "redact") this.shareNotice("Common-pattern redaction aid applied; review all text, no guarantee.", "redacted");
    const attachment = preview.text;
    if (this.json) this.write(JSON.stringify({ type: "shell_share_preview", sessionId: preview.capture.sessionId, commandId: preview.capture.commandId,
      omittedBytes: preview.capture.formattingOmittedBytes, sourceOmittedBytes: preview.capture.outputOmittedBytes,
      bytes: Buffer.byteLength(attachment), attachment, possibleSecrets: scanForSecrets(attachment), next: "/shell-result lines|drop|replace|mask|redact|send|cancel" }) + "\n");
    else this.write(`Shell result staged from session ${preview.capture.sessionId}, command ${preview.capture.commandId}.\n--- exact model attachment begins ---\n${attachment}\n--- exact model attachment ends ---\nReview all text and metadata. Redaction is an aid, not a guarantee.\nUse /shell-result lines, drop <first>[-<last>], replace <line> <text>, mask <literal>, redact, send, or cancel.\n`);
    return { kind: "empty" };
  }

  /** Queue admission is synchronous; rejection keeps the exact edited draft. */
  restoreShare(input: Extract<ConsoleInput, { kind: "share" }>): boolean {
    return input.approved ? this.attachmentPreview.restore(input.approved) : false;
  }
  /** Execute only the approved snapshot; editing a later preview cannot alter it. */
  share(input: ShareInput = { kind: "share", action: "preview" }, scripted = false): Extract<ConsoleInput, { kind: "chat" | "empty" }> {
    const prepared = this.prepareShare(input, scripted);
    if (prepared.kind === "empty" || !prepared.approved) return { kind: "empty" };
    this.shareNotice(`Sending explicit shell result from session ${prepared.approved.capture.sessionId}, command ${prepared.approved.capture.commandId}.`, "sending");
    return { kind: "chat", text: prepared.approved.text };
  }
  prompt(): string { return `[${this.profile} ${sanitizeServerText(this.session.cwd)}${this.session.state === "lost" ? "; shell lost" : ""}] `; }
  close(): void { this.latest = null; this.attachmentPreview.cancel(); this.scriptSendAvailable = false; this.terminal?.stop(); this.session.close(); }
}
