import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { BoundedOutput } from "./bounded_output.js";
import { childEnv } from "./child_env.js";
import type { ShellProfile } from "./shell_profiles.js";
import type { RunOptions, ToolResult } from "./tool_executor.js";

export interface ShellCommandEvent {
  sessionId: string;
  commandId: string;
  origin: "user" | "model";
  command: string;
  cwd: string;
  state: "running" | "completed" | "cancelled" | "lost";
  exitCode?: number;
  profile?: ShellProfile;
}

const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

// -EncodedCommand is only the fixed host-owned reader. Each user command is
// passed as base64 UTF-16 data over stdin and evaluated once in this process,
// so Set-Location, environment variables and functions retain native scope.
const POWERSHELL_READER = String.raw`
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
while ($true) {
  $packet = [Console]::In.ReadLine()
  if ($null -eq $packet) { break }
  $split = $packet.IndexOf(':')
  if ($split -le 0) { continue }
  $commandId = $packet.Substring(0, $split)
  try {
    $commandText = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($packet.Substring($split + 1)))
    $global:LASTEXITCODE = 0
    $errorCount = $Error.Count
    Invoke-Expression $commandText | Out-String -Stream | ForEach-Object { [Console]::Out.WriteLine($_) }
    if ($LASTEXITCODE -ne 0) { $status = [int]$LASTEXITCODE }
    elseif ($Error.Count -gt $errorCount) { $status = 1 }
    else { $status = 0 }
  } catch {
    [Console]::Error.WriteLine($_.ToString())
    $status = 1
  }
  $path = (Get-Location).ProviderPath
  $encodedPath = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path))
  $frame = [char]30 + $commandId + [char]31 + $status + [char]31 + $encodedPath + [char]30
  [Console]::Out.Write($frame)
  [Console]::Error.Write($frame)
  [Console]::Out.Flush()
  [Console]::Error.Flush()
}
`;

/** Console-owned non-interactive Bash or opted-in Windows PowerShell.
 * No credentials or profile/rc files inherited.
 * File tools continue resolving at workspaceRoot, regardless of shell cwd.
 * This is session control, not an OS sandbox for arbitrary shell commands.
 */
export class ShellSession {
  readonly workspaceRoot: string;
  readonly profile: ShellProfile;
  readonly shell: string;
  id = randomUUID();
  cwd: string;
  state: "ready" | "lost" | "closed" = "ready";
  private child: ChildProcess | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private active = false;
  private queued = 0;
  private generation = 0;
  revision = 0;
  private failActive: ((reason: string) => void) | null = null;
  private readonly rootIdentity: string;

  constructor(root: string, private readonly onEvent?: (event: ShellCommandEvent) => void,
    profile: ShellProfile = process.platform === "win32" ? "cmd" : "bash", executable?: string) {
    this.workspaceRoot = realpathSync(resolve(root));
    this.profile = profile;
    this.shell = executable ?? (profile === "bash" ? "/bin/bash" : profile === "cmd" ? (process.env["ComSpec"] ?? "cmd.exe") : "powershell.exe");
    this.cwd = this.workspaceRoot;
    const stat = statSync(this.workspaceRoot);
    this.rootIdentity = `${stat.dev}:${stat.ino}`;
  }

  get busy(): boolean { return this.queued > 0; }

  /** Every local tool and user submission uses the same FIFO host slot. */
  async withSlot<T>(work: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    this.queued++;
    const pending = this.tail.then(async () => {
      if (generation !== this.generation || this.state === "closed") {
        throw new Error("shell session changed; submission discarded (not replayed)");
      }
      this.active = true;
      try { return await work(); }
      finally { this.active = false; }
    });
    const tracked = pending.finally(() => { this.queued--; });
    this.tail = tracked.catch(() => {});
    return tracked;
  }

  /** Host/user action only. Invalidates queued commands; no automatic replay. */
  reset(): void {
    this.stop("shell explicitly reset; previous state discarded");
    this.generation++;
    this.id = randomUUID();
    this.revision = 0;
    this.cwd = this.workspaceRoot;
    this.state = "ready";
  }

  close(): void {
    this.stop("console closed");
    this.generation++;
    this.state = "closed";
  }

  private stop(reason: string): void {
    this.state = "lost";
    const fail = this.failActive;
    const child = this.child;
    this.child = null;
    if (!child?.pid) { fail?.(reason); return; }
    // `exit` precedes stdio `close`. Keep command listeners attached until
    // the final buffered output has been delivered, including after SIGKILL.
    child.once("close", () => fail?.(reason));
    if (child.exitCode !== null || child.signalCode !== null) {
      const drainDeadline = setTimeout(() => fail?.(reason), 200);
      drainDeadline.unref();
      return;
    }
    const pid = child.pid;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => { try { child.kill(); } catch { /* already gone */ } });
      killer.unref();
    } else {
      try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
    }
    // Reap all descendants, including ones which ignored TERM. Do not replay.
    const escalation = setTimeout(() => {
      if (process.platform === "win32") { try { child.kill(); } catch { /* already gone */ } }
      else { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }
      fail?.(reason);
    }, process.platform === "win32" ? 500 : 200);
    if (!fail) escalation.unref();
  }

  private start(): ChildProcess {
    if (this.profile === "powershell") return this.startPowerShell();
    if (process.platform !== "linux" && process.platform !== "darwin") {
      throw new Error("persistent shell requires Linux/macOS Bash; this console does not fall back silently");
    }
    const child = spawn(this.shell, ["--noprofile", "--norc"], {
      cwd: this.workspaceRoot, env: childEnv(), detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdin?.on("error", (error) => {
      if (this.child === child) this.stop(`Bash input failed: ${error.message}`);
    });
    child.on("error", (error) => {
      if (this.child === child) this.stop(`Bash spawn failed: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) this.stop(`Bash exited (${signal ?? code ?? "unknown"}); state lost`);
    });
    // Drain idle output too. Background jobs are awaited at each command end.
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    // cd validates the physical target BEFORE changing this shell's directory.
    // Readonly prevents casual replacement; explicit builtin cd is checked at
    // completion and loses the session on escape. Shell authority is unchanged.
    const root = quote(this.workspaceRoot);
    child.stdin!.write(`cd() { local target; target=$(builtin cd "$@" >/dev/null && builtin pwd -P) || return; case "$target" in ${root}|${root}/*) builtin cd -- "$target" ;; *) builtin printf 'refusing cwd outside workspace\\n' >&2; return 1 ;; esac; }; readonly -f cd\n`);
    return child;
  }

  private startPowerShell(): ChildProcess {
    if (process.platform !== "win32") throw new Error("PowerShell profile requires Windows");
    const encoded = Buffer.from(POWERSHELL_READER, "utf16le").toString("base64");
    const child = spawn(this.shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      cwd: this.workspaceRoot, env: childEnv(), windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdin?.on("error", error => { if (this.child === child) this.stop(`PowerShell input failed: ${error.message}`); });
    child.on("error", error => { if (this.child === child) this.stop(`PowerShell spawn failed: ${error.message}`); });
    child.on("exit", (code, signal) => {
      if (this.child === child) this.stop(`PowerShell exited (${signal ?? code ?? "unknown"}); state lost`);
    });
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    return child;
  }

  private runPowerShellInSlot(command: string, origin: ShellCommandEvent["origin"], options: RunOptions): Promise<ToolResult> {
    if (!this.active) throw new Error("shell command requires the local execution slot");
    if (!command.trim()) return Promise.resolve({ output: "[empty shell command]", exitCode: 1 });
    if (options.signal?.aborted) return Promise.resolve({ output: "[aborted before start]", exitCode: 130 });
    if (this.state !== "ready") return Promise.resolve({ output: "[shell state lost; use /shell-reset to start fresh; command not replayed]", exitCode: 1 });
    try {
      if (realpathSync(this.workspaceRoot) !== this.workspaceRoot) throw new Error("workspace root replaced");
      const stat = statSync(this.workspaceRoot);
      if (`${stat.dev}:${stat.ino}` !== this.rootIdentity) throw new Error("workspace root replaced");
    } catch {
      this.stop("approved workspace is no longer accessible");
      return Promise.resolve({ output: "[approved workspace changed; command refused; open a new console]", exitCode: 1 });
    }
    this.revision++;
    const commandId = randomUUID();
    const event = { sessionId: this.id, commandId, origin, command, profile: this.profile };
    const emit = (state: ShellCommandEvent["state"], exitCode?: number): void => {
      this.onEvent?.({ ...event, cwd: this.cwd, state, ...(exitCode !== undefined ? { exitCode } : {}) });
    };
    let child: ChildProcess;
    try { child = this.child ?? this.start(); }
    catch (error) {
      this.state = "lost";
      emit("lost", 1);
      return Promise.resolve({ output: `[PowerShell unavailable: ${String(error)}; use /shell-profile list]`, exitCode: 1 });
    }
    emit("running");
    return new Promise<ToolResult>(settle => {
      const marker = `\x1e${commandId}\x1f`;
      const output = new BoundedOutput();
      let completed = false;
      let stdoutDone = false, stderrDone = false;
      let code: number | null = null, cwd: string | null = null;
      let verdict = 1;
      const retain = (text: string): void => {
        if (!text) return;
        output.append(text);
        options.onOutput?.(text);
      };
      const readStream = (stream: Readable, end: () => void): (() => void) => {
        const decoder = new StringDecoder("utf8");
        let pending = "";
        let inFrame = false;
        const read = (chunk: Buffer): void => {
          pending += decoder.write(chunk);
          if (!inFrame) {
            const begin = pending.indexOf(marker);
            if (begin < 0) {
              let safe = Math.max(0, pending.length - marker.length + 1);
              if (safe > 0 && /[\uD800-\uDBFF]/.test(pending[safe - 1]!)) safe--;
              retain(pending.slice(0, safe)); pending = pending.slice(safe);
              return;
            }
            retain(pending.slice(0, begin));
            pending = pending.slice(begin + marker.length);
            inFrame = true;
          }
          const frameEnd = pending.indexOf("\x1e");
          if (frameEnd < 0) {
            if (pending.length > 16_384) this.stop("PowerShell control frame overflow");
            return;
          }
          const fields = pending.slice(0, frameEnd).split("\x1f");
          if (fields.length !== 2 || !/^-?\d+$/.test(fields[0] ?? "")) {
            this.stop("PowerShell control frame invalid"); return;
          }
          if (code === null) {
            code = Number(fields[0]);
            cwd = Buffer.from(fields[1]!, "base64").toString("utf8");
          }
          pending = "";
          stream.off("data", read);
          end();
        };
        stream.on("data", read);
        return () => {
          stream.off("data", read);
          const rest = pending + decoder.end();
          if (!inFrame) retain(rest);
        };
      };
      const finish = (result: ToolResult, state: ShellCommandEvent["state"]): void => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        cleanupOut(); cleanupErr();
        result.output += output.render();
        Object.defineProperty(result, "capture", {
          value: { observedBytes: output.observedBytes, omittedBytes: output.omittedBytes },
        });
        this.failActive = null;
        emit(state, result.exitCode);
        settle(result);
      };
      const check = (): void => {
        if (code === null || cwd === null || !stdoutDone || !stderrDone || completed) return;
        let physical: string;
        try { physical = realpathSync(cwd); }
        catch { this.stop("PowerShell cwd is no longer accessible"); return; }
        const root = this.workspaceRoot.toLowerCase(), actual = physical.toLowerCase();
        if (actual !== root && !actual.startsWith(root + sep.toLowerCase())) {
          this.stop("PowerShell cwd outside approved workspace"); return;
        }
        this.cwd = physical;
        finish({ output: `[exit ${code}]\n`, exitCode: code }, "completed");
      };
      const cleanupOut = readStream(child.stdout!, () => { stdoutDone = true; check(); });
      const cleanupErr = readStream(child.stderr!, () => { stderrDone = true; check(); });
      this.failActive = reason => finish({
        output: `[${reason}; shell state lost; use /shell-reset; command not replayed]\n`, exitCode: verdict,
      }, verdict === 130 ? "cancelled" : "lost");
      const abort = (): void => { verdict = 130; this.stop("aborted"); };
      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => { verdict = 124; this.stop("PowerShell command timed out"); }, options.timeoutMs ?? 900_000);
      timer.unref();
      const encoded = Buffer.from(command, "utf16le").toString("base64");
      child.stdin!.write(`${commandId}:${encoded}\n`);
    });
  }

  /** Called only while holding withSlot. Preserves variables/functions/cwd. */
  runInSlot(command: string, origin: ShellCommandEvent["origin"], options: RunOptions = {}): Promise<ToolResult> {
    if (this.profile === "powershell") return this.runPowerShellInSlot(command, origin, options);
    if (!this.active) throw new Error("shell command requires the local execution slot");
    if (!command.trim()) return Promise.resolve({ output: "[empty shell command]", exitCode: 1 });
    if (options.signal?.aborted) return Promise.resolve({ output: "[aborted before start]", exitCode: 130 });
    if (this.state !== "ready") {
      return Promise.resolve({ output: "[shell state lost; use /shell-reset to start fresh; command not replayed]", exitCode: 1 });
    }
    try {
      if (realpathSync(this.workspaceRoot) !== this.workspaceRoot) throw new Error("workspace root replaced");
      const stat = statSync(this.workspaceRoot);
      if (`${stat.dev}:${stat.ino}` !== this.rootIdentity) throw new Error("workspace root replaced");
    } catch {
      this.stop("approved workspace is no longer accessible");
      return Promise.resolve({ output: "[approved workspace changed; command refused; open a new console]", exitCode: 1 });
    }
    this.revision++;
    const commandId = randomUUID();
    const event = { sessionId: this.id, commandId, origin, command, cwd: this.cwd, profile: this.profile };
    const emit = (state: ShellCommandEvent["state"], exitCode?: number): void => {
      this.onEvent?.({ ...event, cwd: this.cwd, state, ...(exitCode !== undefined ? { exitCode } : {}) });
    };
    let child: ChildProcess;
    try { child = this.child ?? this.start(); }
    catch (error) {
      this.state = "lost";
      emit("lost", 1);
      return Promise.resolve({ output: `[shell unavailable: ${String(error)}; use /shell-reset]`, exitCode: 1 });
    }
    emit("running");
    return new Promise<ToolResult>((settle) => {
      const marker = `\x1e${commandId}\x1f`;
      const output = new BoundedOutput();
      let completed = false;
      let control = "";
      let code: number | null = null;
      let cwd: string | null = null;
      let outDone = false;
      let errDone = false;
      const retain = (text: string): void => {
        if (!text) return;
        output.append(text);
        options.onOutput?.(text);
      };
      const streamReader = (stream: Readable, end: () => void): (() => void) => {
        let pending = "";
        const decoder = new StringDecoder("utf8");
        const read = (chunk: Buffer): void => {
          pending += decoder.write(chunk);
          const index = pending.indexOf(marker);
          if (index >= 0) {
            retain(pending.slice(0, index));
            pending = "";
            end();
          } else {
            // A marker may span chunks. Drain everything except its suffix.
            let safe = Math.max(0, pending.length - marker.length + 1);
            // The marker lookbehind must not divide an astral code point.
            if (safe > 0 && /[\uD800-\uDBFF]/.test(pending[safe - 1]!)) safe--;
            retain(pending.slice(0, safe));
            pending = pending.slice(safe);
          }
        };
        stream.on("data", read);
        return () => { stream.off("data", read); retain(pending + decoder.end()); };
      };
      const finish = (result: ToolResult, state: ShellCommandEvent["state"]): void => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        cleanupOut(); cleanupErr();
        result.output += output.render();
        // Internal preview provenance must not change the public ToolResult
        // shape consumed by model tools, JSON output, or existing callers.
        Object.defineProperty(result, "capture", {
          value: { observedBytes: output.observedBytes, omittedBytes: output.omittedBytes },
        });
        fd.off("data", onControl);
        this.failActive = null;
        emit(state, result.exitCode);
        settle(result);
      };
      const check = (): void => {
        if (code === null || cwd === null || !outDone || !errDone || completed) return;
        let physical: string;
        try { physical = realpathSync(cwd); }
        catch { this.stop("shell cwd is no longer accessible"); return; }
        if (physical !== this.workspaceRoot && !physical.startsWith(this.workspaceRoot + sep)) {
          this.stop("shell changed cwd outside approved workspace");
          return;
        }
        this.cwd = physical;
        finish({ output: `[exit ${code}]\n`, exitCode: code }, "completed");
      };
      const cleanupOut = streamReader(child.stdout!, () => { outDone = true; check(); });
      const cleanupErr = streamReader(child.stderr!, () => { errDone = true; check(); });
      const fd = child.stdio[3] as Readable;
      const controlDecoder = new StringDecoder("utf8");
      const onControl = (chunk: Buffer): void => {
        control += controlDecoder.write(chunk);
        if (control.length > 16384) { this.stop("shell control channel overflow"); return; }
        const parts = control.split("\0");
        if (parts.length >= 4 && parts[0] === commandId) {
          code = Number(parts[1]); cwd = parts[2]!; check();
        }
      };
      fd.on("data", onControl);
      let verdict = 1;
      this.failActive = (reason) => finish({
        output: `[${reason}; shell state lost; use /shell-reset; command not replayed]\n`,
        exitCode: verdict,
      }, verdict === 130 ? "cancelled" : "lost");
      const abort = (): void => { verdict = 130; this.stop("aborted"); };
      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => { verdict = 124; this.stop("shell command timed out"); }, options.timeoutMs ?? 900_000);
      timer.unref();
      // eval executes in this process; stdin belongs to the protocol. PTY and
      // interactive programs are deliberately a separate follow-up. wait makes
      // background jobs part of the same command/cancellation ownership.
      child.stdin!.write(`builtin eval -- ${quote(command)} </dev/null\n__aether_status=$?\nbuiltin wait\nbuiltin printf '%s\\0%s\\0%s\\0' ${quote(commandId)} "$__aether_status" "$(builtin pwd -P)" >&3\nbuiltin printf '%s' ${quote(marker)}\nbuiltin printf '%s' ${quote(marker)} >&2\n`);
    });
  }
}
