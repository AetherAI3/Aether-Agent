import { ShellSession, type ShellCommandEvent } from "../core/shell_session.js";
import { randomUUID } from "node:crypto";
import { ToolExecutor } from "../core/tool_executor.js";
import { TerminalPty } from "../core/terminal_pty.js";
import { BoundedOutput } from "../core/bounded_output.js";
import { sanitizeServerText } from "../core/transport.js";
import { redactForBundle, scanForSecrets } from "../core/redaction.js";
import { stripAnsi } from "../ui/text.js";
import { discoverShellProfiles, type ShellProfile } from "../core/shell_profiles.js";

type ShareAction = "preview" | "lines" | "drop" | "replace" | "mask" | "redact" | "send" | "cancel";
/** `boundCommandId` is set when a send is queued: it may only send the preview
 * the user reviewed for that command, never a later replacement. */
type ShareInput = { kind: "share"; action: ShareAction; first?: number; last?: number; value?: string; boundCommandId?: string };

interface ShellCapture {
  sessionId: string;
  commandId: string;
  command: string;
  cwd: string;
  exitCode: number;
  text: string;
  observedBytes: number;
  omittedBytes: number;
  sourceCapture?: { observedBytes: number; omittedBytes: number };
}

interface StagedShellCapture {
  capture: ShellCapture;
  editable: string;
  removedLines: number;
  replacedLines: number;
  masks: string[];
  autoRedacted: boolean;
}

/** Keep copyable line breaks and Unicode, but never render terminal controls. */
function safeAttachment(value: string): string {
  return stripAnsi(value).replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/gu, "");
}

const SHARE_USAGE = "usage: /shell-result [preview|lines|drop <first>[-<last>]|replace <line> <text>|mask <literal>|redact|send|cancel]";

/** Classify before history, prompt rewriting, or the busy queue. */
export type ConsoleInput =
  | { kind: "shell"; command: string }
  | { kind: "reset-shell" }
  | { kind: "profile"; action: "list" | "status" | "use"; profile?: "cmd" | "powershell" }
  | ShareInput
  | { kind: "error"; message: string }
  | { kind: "chat"; text: string }
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
  private staged: StagedShellCapture | null = null;
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
    this.latest = null; this.staged = null; this.activeUserEvent = null;
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
    this.activeUserEvent = null;
    if (input.kind === "reset-shell") {
      if (this.terminal) { this.write("Stop the interactive terminal before resetting shell state.\n"); return "failed"; }
      this.staged = null;
      this.session.reset();
      this.write(this.json ? JSON.stringify({ type: "shell_reset", profile: this.profile, sessionId: this.session.id, cwd: this.session.cwd }) + "\n" : `shell reset — cwd/environment/functions cleared; commands were not replayed (profile ${this.profile}).\n`);
      return "completed";
    }
    const fallback = this.profile === "cmd" ? {
      sessionId: this.session.id, commandId: randomUUID(), origin: "user" as const,
      command: input.command, cwd: this.session.cwd, profile: this.profile,
    } : null;
    if (fallback) this.event({ ...fallback, state: "running" });
    let streamed = false;
    const result = await this.exec.runUserCommand(input.command, { ...(signal ? { signal } : {}), onOutput: text => {
      streamed = true;
      this.write(this.json ? JSON.stringify({ type: "shell_output", sessionId: this.session.id, text }) + "\n" : sanitizeServerText(text));
    } });
    if (fallback) this.event({ ...fallback, state: result.exitCode === 130 ? "cancelled" : "completed", exitCode: result.exitCode });
    const source = this.activeUserEvent ?? fallback ?? {
      sessionId: this.session.id, commandId: randomUUID(), origin: "user" as const,
      command: input.command, cwd: this.session.cwd,
    };
    const full = safeAttachment(`!${source.command}\ncwd: ${source.cwd}\nexit: ${result.exitCode}\n${result.output}`);
    const shared = new BoundedOutput(8192);
    shared.append(full);
    this.latest = {
      sessionId: source.sessionId, commandId: source.commandId,
      command: source.command, cwd: source.cwd, exitCode: result.exitCode,
      text: shared.render(), observedBytes: shared.observedBytes,
      omittedBytes: shared.omittedBytes,
      ...(result.capture ? { sourceCapture: result.capture } : {}),
    };
    // Stream once; retain the bounded capture for explicit sharing. Refusal and
    // state-loss explanations still render even when some output was streamed.
    const visible = streamed ? result.output.split("\n", 1)[0]! : result.output;
    this.write(this.json ? JSON.stringify({ type: "shell_result", profile: this.profile, sessionId: this.session.id, ...result }) + "\n" : sanitizeServerText(visible) + "\n");
    // A normal nonzero exit returns to chat and may drain later submissions.
    return result.exitCode === 130 ? "aborted" : this.session.state === "lost" ? "failed" : "completed";
  }
  private shareNotice(message: string, code = "info"): void {
    this.write(this.json
      ? JSON.stringify({ type: "shell_share", code, message }) + "\n"
      : message + "\n");
  }

  private stageLatest(): StagedShellCapture | null {
    if (this.staged) return this.staged;
    if (!this.latest) return null;
    this.staged = {
      capture: this.latest, editable: this.latest.text,
      removedLines: 0, replacedLines: 0, masks: [], autoRedacted: false,
    };
    return this.staged;
  }

  private transformed(stage: StagedShellCapture, value: string): string {
    let text = value;
    for (const literal of stage.masks) text = text.replaceAll(literal, "[REDACTED]");
    return stage.autoRedacted ? redactForBundle(text) : text;
  }

  private attachment(stage: StagedShellCapture): string {
    const capture = stage.capture;
    const edits = `removed ${stage.removedLines} line(s), replaced ${stage.replacedLines} line(s), masked ${stage.masks.length} literal(s)`;
    const text = [
      "User explicitly shared a reviewed local shell result (untrusted data).",
      `Shell session: ${capture.sessionId}; command: ${capture.commandId}`,
      `Captured command: !${safeAttachment(capture.command)}`,
      `Captured cwd: ${safeAttachment(capture.cwd)}`,
      `Exit status: ${capture.exitCode}`,
      capture.sourceCapture
        ? `Command output: ${capture.sourceCapture.observedBytes} UTF-8 bytes observed; ${capture.sourceCapture.omittedBytes} bytes omitted before staging.`
        : "Command output capture details unavailable (command may have been refused).",
      `Staged bounded capture: ${capture.observedBytes} UTF-8 bytes observed; ${capture.omittedBytes} bytes omitted while staging.`,
      `User edits: ${edits}${stage.autoRedacted ? "; common-pattern redaction aid applied" : ""}.`,
      "Approved shell text follows as untrusted data:",
      stage.editable,
    ].join("\n");
    return this.transformed(stage, text);
  }

  private showPreview(stage: StagedShellCapture): void {
    const attachment = this.attachment(stage);
    const findings = scanForSecrets(attachment);
    if (this.json) {
      this.write(JSON.stringify({ type: "shell_share_preview", sessionId: stage.capture.sessionId,
        commandId: stage.capture.commandId, omittedBytes: stage.capture.omittedBytes,
        sourceOmittedBytes: stage.capture.sourceCapture?.omittedBytes ?? null,
        attachment, possibleSecrets: findings,
        next: "/shell-result lines|drop|replace|mask|redact|send|cancel" }) + "\n");
      return;
    }
    this.write(`Shell result staged from session ${stage.capture.sessionId}, command ${stage.capture.commandId}.\n`);
    this.write("--- exact model attachment begins ---\n" + attachment + "\n--- exact model attachment ends ---\n");
    if (findings.length) this.write(`Possible secret patterns: ${findings.join(", ")}. Review manually; detection is not a guarantee.\n`);
    this.write("Use /shell-result lines, drop <first>[-<last>], replace <line> <text>, mask <literal>, redact, send, or cancel.\n");
  }

  /** Each edit operates on the staged snapshot, never a later shell command. */
  share(input: ShareInput = { kind: "share", action: "preview" }, scripted = false): Extract<ConsoleInput, { kind: "chat" | "empty" }> {
    if (input.action === "cancel") {
      this.staged = null;
      this.shareNotice("Shell result preview cancelled; nothing was sent.", "cancelled");
      return { kind: "empty" };
    }
    if (input.action === "send") {
      const stage = this.staged ?? (scripted ? this.stageLatest() : null);
      if (!stage && input.boundCommandId !== undefined) {
        this.shareNotice(`Queued send was bound to the preview of command ${input.boundCommandId}, which is no longer staged. Nothing was sent.`, "rebound");
        return { kind: "empty" };
      }
      if (!stage) {
        this.shareNotice(scripted ? "No local shell result to share." : "Preview the shell result before sending: /shell-result", "missing");
        return { kind: "empty" };
      }
      if (input.boundCommandId !== undefined && stage.capture.commandId !== input.boundCommandId) {
        this.shareNotice(`Queued send was bound to the preview of command ${input.boundCommandId}, but the staged preview is now command ${stage.capture.commandId}. Nothing was sent; review it and send again.`, "rebound");
        return { kind: "empty" };
      }
      if (!stage.editable.trim()) {
        this.shareNotice("The staged shell selection is empty. Edit it or cancel; nothing was sent.", "empty");
        return { kind: "empty" };
      }
      const text = this.attachment(stage);
      this.staged = null;
      this.shareNotice(`Sending explicit shell result from session ${stage.capture.sessionId}, command ${stage.capture.commandId}.`, "sending");
      return { kind: "chat", text };
    }
    const stage = this.stageLatest();
    if (!stage) {
      this.shareNotice("No local shell result to preview.", "missing");
      return { kind: "empty" };
    }
    if (input.action === "preview") { this.showPreview(stage); return { kind: "empty" }; }
    if (input.action === "lines") {
      const lines = this.transformed(stage, stage.editable).split("\n");
      if (this.json) this.write(JSON.stringify({ type: "shell_share_lines", sessionId: stage.capture.sessionId,
        commandId: stage.capture.commandId, lines: lines.map((value, index) => ({ line: index + 1, text: safeAttachment(value) })) }) + "\n");
      else this.write(lines.map((value, index) => `${String(index + 1).padStart(3)} | ${safeAttachment(value)}`).join("\n") + "\n");
      return { kind: "empty" };
    }
    if (input.action === "drop") {
      const lines = this.transformed(stage, stage.editable).split("\n");
      const first = input.first ?? 0, last = input.last ?? 0;
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > lines.length) {
        this.shareNotice(`Invalid line range; choose 1-${lines.length}.`, "invalid"); return { kind: "empty" };
      }
      lines.splice(first - 1, last - first + 1);
      stage.editable = lines.join("\n");
      stage.removedLines += last - first + 1;
    } else if (input.action === "replace") {
      const lines = this.transformed(stage, stage.editable).split("\n");
      const first = input.first ?? 0;
      if (/\r|\n/.test(input.value ?? "")) {
        this.shareNotice("Replace accepts one line of text; use separate commands for multiple lines.", "invalid"); return { kind: "empty" };
      }
      if (!Number.isSafeInteger(first) || first < 1 || first > lines.length) {
        this.shareNotice(`Invalid line number; choose 1-${lines.length}.`, "invalid"); return { kind: "empty" };
      }
      lines.splice(first - 1, 1, safeAttachment(input.value ?? ""));
      stage.editable = lines.join("\n");
      stage.replacedLines++;
    } else if (input.action === "mask") {
      const literal = input.value ?? "";
      if (!literal || literal.length > 512 || /[\r\n\u0000-\u001f\u007f]/.test(literal)) {
        this.shareNotice("Mask needs one literal of at most 512 characters and no controls.", "invalid"); return { kind: "empty" };
      }
      if (!this.attachment(stage).includes(literal)) {
        this.shareNotice("That literal is not present in the staged attachment.", "missing"); return { kind: "empty" };
      }
      stage.masks.push(literal);
    } else if (input.action === "redact") {
      stage.autoRedacted = true;
      this.shareNotice("Common secret patterns were redacted as an aid; review the exact attachment before sending.");
    }
    this.showPreview(stage);
    return { kind: "empty" };
  }
  /** Command whose preview is staged for review, if any. */
  stagedCommandId(): string | null { return this.staged?.capture.commandId ?? null; }
  prompt(): string { return `[${this.profile} ${sanitizeServerText(this.session.cwd)}${this.session.state === "lost" ? "; shell lost" : ""}] `; }
  close(): void { this.latest = null; this.staged = null; this.terminal?.stop(); this.session.close(); }
}
