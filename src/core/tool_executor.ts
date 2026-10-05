// Tool executor — the ONE tool implementation, host-side. Both brains (local
// and cloud) emit tool_call events; the host executes them here and returns a
// tool_result. One path-guard, one output cap, identical for local and cloud.
//
// Output format mirrors the Python reference (`[exit N]\n<output>`) so the
// brain's grounding gate (tests_pass / parse_fail_count) reads the same shape
// regardless of which side originally ran it.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { BoundedOutput } from "./bounded_output.js";
import type { ToolName } from "./brain_protocol.js";
import { validateToolCall } from "./tool_registry.js";
import { toolCallBinding } from "./tool_approval.js";
import { GitCommitGuard, SpawnGitRunner } from "./git_commit_guard.js";
import { webFetch, webSearch } from "./web.js";
import { ShellSession } from "./shell_session.js";
import { WorkspaceOwnership } from "./workspace_ownership.js";

const MAX_OUTPUT = 8000;
// CONTRACTS.md invariant 5: an unset test_cmd means "no ground truth to assert" —
// it must default to "" (unverifiable), never a real command. brain_protocol.ts's
// encodeCommand was fixed to this in cac0399; this sibling default is the executor
// that actually RUNS run_tests, so it must agree or every brain-initiated run_tests
// call with no explicit command silently runs pytest in non-Python repos.
const DEFAULT_TEST_CMD = "";
// Files larger than this are not diffed inline (the transcript would drown).
const SNAPSHOT_MAX_BYTES = 1024 * 1024;
const SEARCH_MAX_HITS = 40;
const FILE_PATCH_MAX_BYTES = 16 * 1024 * 1024;
const DIRECTORY_MAX_ENTRIES = 10_000;
const SEARCH_SKIP_DIRS = new Set([".git", "node_modules", "dist"]);
/**
 * Tools that can change the workspace. The git commit guard's baseline must be
 * taken before the first of these runs, and there is no reason to take it
 * before that: a session that only reads never touches git at all.
 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "patch_file",
  "run_shell",
  "run_tests",
  "git_commit",
]);

/** Per-call execution controls for the shell-backed tools. */
export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
  /** Bind a model approval to the exact session and cwd displayed by the host. */
  expectedShellContext?: string;
  /** The validated tool name and arguments shown at approval time. */
  expectedToolCall?: string;
}

export interface ToolResult {
  output: string;
  exitCode: number;
}

/** Chosen by the local host when it creates an executor, never by a tool call. */
export interface ToolExecutionContext {
  readonly mode: "coding" | "pc";
  readonly shellSession?: ShellSession;
}

/**
 * A pre-write read of a file, for rendering the live diff. `text` is null when
 * the content is unsuitable to diff (binary, oversized, or outside the
 * workspace guard); `reason` says which. Path-guarded by the same allowlist as
 * every other tool — a snapshot can never read outside the workspace.
 */
export interface FileSnapshot {
  existed: boolean;
  text: string | null;
  reason?: "binary" | "too-big" | "unsafe";
}

export class ToolExecutor {
  private readonly root: string;
  private readonly mode: ToolExecutionContext["mode"];
  /**
   * Built on first use by armCommitGuard(), never in the constructor. See the
   * comment there — constructing it runs synchronous git probes, and doing that
   * eagerly froze the CLI before its first turn.
   */
  private committer: GitCommitGuard | null = null;
  private ownership: WorkspaceOwnership | null = null;
  private terminalActive = false;

  /** Reserve local authority for an explicit interactive user terminal. */
  async beginUserTerminal(): Promise<() => void> {
    const reserve = async (): Promise<() => void> => {
      if (this.mode !== "coding" || this.terminalActive) throw new Error("local terminal already active or unavailable");
      this.armCommitGuard();
      if (this.reconcileCheckout()) throw new Error("checkout changed; re-submit terminal command");
      const ownership = this.ownership!;
      const before = ownership.before();
      this.terminalActive = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { ownership.after(before, "user"); }
        finally { this.terminalActive = false; this.reconcileCheckout(); }
      };
    };
    return this.shellSession ? this.shellSession.withSlot(reserve) : reserve();
  }
  private readonly shellSession?: ShellSession;
  private checkout: string | undefined;

  constructor(
    cwd: string,
    private readonly testCmd: string = DEFAULT_TEST_CMD,
    context: ToolExecutionContext = { mode: "coding" },
  ) {
    if (context.mode !== "coding" && context.mode !== "pc") {
      throw new Error("invalid tool execution mode");
    }
    // Copy the primitive. A caller changing its context object later cannot
    // upgrade this executor from the PC task's closed tool set.
    this.mode = context.mode;
    // Canonicalize the root once (resolve any symlinks in the workspace path).
    const r = resolve(cwd);
    this.root = existsSync(r) ? realpathSync(r) : r;
    if (context.shellSession && (context.mode !== "coding" || context.shellSession.workspaceRoot !== this.root)) {
      throw new Error("shell session must belong to this coding workspace");
    }
    this.shellSession = context.shellSession;
  }

  /** Directory shown to the user; never substitutes for the file-tool root. */
  get shellCwd(): string { return this.shellSession?.cwd ?? this.root; }
  get shellContext(): string { return `${this.shellSession?.id ?? "one-shot"}\0${this.shellSession?.revision ?? 0}\0${this.shellCwd}`; }
  get configuredTestCommand(): string { return this.testCmd; }

  close(): void { this.shellSession?.close(); }

  /** Compatibility entrypoint; a console-owned executor shares its session. */
  async runUserCommand(command: string, options: RunOptions = {}): Promise<ToolResult> {
    if (this.terminalActive) return { output: "[interactive terminal active; stop it before running local tools]", exitCode: 1 };
    if (this.mode === "pc") return this.pcToolRefusal();
    if (this.shellSession) return this.runUserShell(command, options);
    this.armCommitGuard();
    const before = this.ownership!.before();
    try { return await this.run(command, options); }
    finally { this.ownership!.after(before, "user"); }
  }

  /** Explicit user submissions are not model tools and confer no permission. */
  async runUserShell(command: string, options: RunOptions = {}): Promise<ToolResult> {
    if (this.terminalActive) return { output: "[interactive terminal active; stop it before running local tools]", exitCode: 1 };
    if (this.mode === "pc" || !this.shellSession) return { output: "[no console shell session]", exitCode: 1 };
    if (!command.trim()) return { output: "[empty shell command]", exitCode: 1 };
    try {
      return await this.shellSession.withSlot(async () => {
        if (this.terminalActive) return { output: "[interactive terminal active; stop it before running local tools]", exitCode: 1 };
        this.armCommitGuard();
        if (this.reconcileCheckout()) return { output: "[checkout changed; shell state reset; re-submit command]", exitCode: 1 };
        const before = this.ownership!.before();
        try {
          const result = await this.shellSession!.runInSlot(command, "user", options);
          this.ownership!.after(before, "user");
          if (this.reconcileCheckout()) result.output += "\n[checkout changed; shell cwd/environment/functions reset; queued commands discarded]";
          return result;
        }
        catch (error) { this.ownership!.after(before, "user"); throw error; }
      });
    } catch (error) { return { output: `[shell rejected: ${String(error)}]`, exitCode: 1 }; }
  }

  /**
   * Build the git commit guard if this run has not built one yet.
   *
   * Constructing the guard is what takes its "dirty before the agent started"
   * baseline, and that costs two synchronous `git` calls. Doing it in the
   * ToolExecutor constructor meant every `aether agent` / `aether chat` paid
   * for it at startup, on the main thread, before the first turn rendered —
   * whether or not the run ever committed anything.
   *
   * The baseline still has to be taken before the agent's first mutation, so
   * it cannot be deferred to the first `git_commit`: at that point the baseline
   * would equal the current state and every commit would find nothing new.
   * The correct moment is the first MUTATING tool call — the workspace is
   * provably untouched by this run, the CLI is already interactive, and a
   * session that only reads never pays the cost at all.
   */
  private armCommitGuard(): GitCommitGuard {
    if (!this.committer) {
      this.committer = new GitCommitGuard(new SpawnGitRunner(this.root));
      this.ownership = new WorkspaceOwnership(this.root);
      this.checkout = this.checkoutIdentity();
    }
    return this.committer;
  }

  private checkoutIdentity(): string {
    const runner = new SpawnGitRunner(this.root);
    const dir = runner.run(["rev-parse", "--absolute-git-dir"]);
    const branch = runner.run(["symbolic-ref", "--quiet", "HEAD"]);
    // Detached checkout changes also discard state; ordinary attached commits
    // preserve the session. An unusable repository is still a shell workspace.
    const head = branch.ok ? branch.stdout : runner.run(["rev-parse", "HEAD"]).stdout;
    return dir.ok ? dir.stdout + "\0" + head : "no-git";
  }

  private reconcileCheckout(): boolean {
    if (!this.shellSession || this.checkout === undefined) return false;
    const current = this.checkoutIdentity();
    if (current === this.checkout) return false;
    this.shellSession.reset();
    this.committer = null;
    this.ownership = null;
    this.checkout = undefined;
    return true;
  }

  private pcToolRefusal(): ToolResult {
    return {
      output: "[tool rejected: PC task mode accepts only registered PC operations through the local host gateway]",
      exitCode: 1,
    };
  }

  /**
   * Resolve a workspace-relative path and refuse any escape. The guard
   * canonicalizes BEFORE the allowlist check so it cannot be bypassed by:
   *  - `..` traversal (resolve collapses it),
   *  - an absolute path (resolve replaces the base),
   *  - a symlink pointing outside the worktree (realpath on the nearest
   *    existing ancestor follows the link, so the real target is checked).
   * The non-existent tail of a write target can't contain a symlink (it doesn't
   * exist yet), so checking the real ancestor is sufficient.
   */
  private safe(path: string): string {
    const abs = resolve(this.root, path);
    let ancestor = abs;
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
      ancestor = dirname(ancestor);
    }
    const realAncestor = existsSync(ancestor) ? realpathSync(ancestor) : ancestor;
    const within = realAncestor === this.root || realAncestor.startsWith(this.root + sep);
    if (!within) {
      throw new Error(`refusing path outside workspace: ${path}`);
    }
    return abs;
  }

  /**
   * Run a shell command in the workspace; capture combined output, capped.
   *
   * Asynchronous and tree-aware. The previous implementation used spawnSync
   * with a timeout, which has two defects the caller cannot see:
   *
   *  - a timeout signals the DIRECT child only, which is the shell. Whatever
   *    the user actually started (npm test, pytest, a compiler) is orphaned and
   *    keeps running, holding ports, files and CPU, while the call returns
   *    looking like a clean timeout.
   *  - the whole event loop is blocked for the duration, freezing heartbeats,
   *    the renderer and any AbortController. That is why Ctrl+C could not
   *    interrupt a long test run.
   *
   * Cancellation and timeout resolve distinctly (130 vs 124): one is the
   * operator, one is the clock, and the caller needs to tell them apart.
   */
  private run(command: string, options: RunOptions = {}): Promise<ToolResult> {
    if (this.shellSession) return this.shellSession.runInSlot(command, "model", options);
    const timeoutMs = options.timeoutMs ?? 900_000;
    const signal = options.signal;
    const onWindows = process.platform === "win32";
    const shell = onWindows ? (process.env["ComSpec"] ?? "C:\\Windows\\System32\\cmd.exe") : "/bin/sh";

    return new Promise<ToolResult>((resolve) => {
      if (signal?.aborted) {
        resolve({ output: "[aborted before start]", exitCode: 130 });
        return;
      }

      const child = spawn(command, {
        shell,
        cwd: this.root,
        // POSIX: a new process group, so one kill reaches every descendant.
        // Windows has no equivalent here; taskkill /T walks the tree instead,
        // so detaching there buys nothing and complicates exit reporting.
        detached: !onWindows,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const output = new BoundedOutput(MAX_OUTPUT);
      const absorb = (text: string): void => {
        if (!text) return;
        output.append(text);
        options.onOutput?.(text);
      };
      // stdout and stderr may interleave mid-codepoint. Each owns a decoder,
      // while capture and live output receive every complete decoded chunk.
      for (const pipe of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder("utf8");
        pipe?.on("data", (chunk: Buffer) => absorb(decoder.write(chunk)));
        pipe?.on("end", () => absorb(decoder.end()));
      }

      let settled = false;
      let verdict: "timeout" | "aborted" | null = null;

      const killTree = (): void => {
        const pid = child.pid;
        if (pid === undefined) return;
        if (onWindows) {
          // /T the tree, /F because a hung runner will not exit politely.
          spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { encoding: "utf8" });
          return;
        }
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          /* group already gone */
        }
        // Escalate: a runner that traps SIGTERM must not outlive the timeout.
        setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* already reaped */
          }
        }, 2000).unref();
      };

      const timer = setTimeout(() => {
        verdict = "timeout";
        killTree();
      }, timeoutMs);
      timer.unref();

      const onAbort = (): void => {
        verdict = "aborted";
        killTree();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const finish = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };

      child.on("error", (err: NodeJS.ErrnoException) => {
        const code = err.code === "ENOENT" ? 127 : 1;
        finish({ output: `[spawn error ${err.code ?? "UNKNOWN"}: ${err.message}]`, exitCode: code });
      });

      // 'close' rather than 'exit': it fires once the pipes are drained, so a
      // test summary arriving with the exit is not lost.
      child.on("close", (code, sig) => {
        const body = output.render();
        if (verdict === "timeout") {
          finish({ output: `[timeout after ${Math.round(timeoutMs / 1000)}s]\n${body}`, exitCode: 124 });
          return;
        }
        if (verdict === "aborted") {
          finish({ output: `[aborted]\n${body}`, exitCode: 130 });
          return;
        }
        const exit = code ?? (sig ? 1 : 1);
        finish({ output: `[exit ${exit}]\n${body}`, exitCode: exit });
      });
    });
  }

  /**
   * Dispatch one SYNC tool call (the 6 file/shell tools). Never throws —
   * guard/IO errors become output. The two web tools are async (network +
   * SSRF resolve) and live on executeAsync; called here they return a clear
   * pointer rather than silently no-op'ing.
   */
  execute(name: string, rawArgs: unknown): ToolResult {
    if (this.terminalActive) return { output: "[interactive terminal active; stop it before running local tools]", exitCode: 1 };
    if (this.shellSession?.busy) return { output: "[local execution busy — call executeAsync to queue]", exitCode: 1 };
    if (this.reconcileCheckout()) return { output: "[checkout changed; shell state reset; request fresh approval]", exitCode: 1 };
    const mutation = (name === "write_file" || name === "patch_file" || name === "git_commit") && validateToolCall(name, rawArgs).ok && this.mode === "coding";
    if (mutation) this.armCommitGuard();
    const before = mutation ? this.ownership!.before() : null;
    try { return this.executeSync(name, rawArgs); }
    finally { if (before) this.ownership!.after(before, "model"); }
  }

  private executeSync(name: string, rawArgs: unknown): ToolResult {
    if (this.mode === "pc") return this.pcToolRefusal();
    const validation = validateToolCall(name, rawArgs);
    if (!validation.ok) {
      return { output: `[tool ${name} rejected: ${validation.error}]`, exitCode: 1 };
    }
    const args = validation.args;
    // Take the git baseline before the first tool that could change the
    // workspace — never at construction, and never as late as git_commit.
    if (MUTATING_TOOLS.has(name)) this.armCommitGuard();
    try {
      switch (name as ToolName) {
        case "read_file":
          return this.readFile(args);
        case "list_directory":
          return this.listDirectory(args);
        case "patch_file":
          return this.patchFile(args);
        case "write_file":
          return this.writeFile(String(args["path"] ?? ""), String(args["content"] ?? ""));
        case "run_shell":
        case "run_tests":
          // Shell-backed tools became async so a timeout or Ctrl+C can reap the
          // whole process tree. Routed through executeAsync like the web tools.
          return { output: `[tool ${name} is async — call executeAsync]`, exitCode: 1 };
        case "repo_search":
          return this.repoSearch(String(args["query"] ?? ""));
        case "git_commit":
          return this.gitCommit(String(args["message"] ?? ""));
        case "web_search":
        case "web_fetch":
          return { output: `[tool ${name} is async — call executeAsync]`, exitCode: 1 };
        default:
          return { output: `[unknown tool: ${name}]`, exitCode: 1 };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `[tool ${name} error: ${msg}]`, exitCode: 1 };
    }
  }

  /**
   * Dispatch one tool call, awaiting the async web tools and delegating the 6
   * sync tools to execute(). The host loop calls this so file/shell stay sync
   * (identical behavior) while web_search/web_fetch get their network path.
   * Web tools never throw — they return a bracketed string, exit 0 (advisory
   * output the brain reads as ordinary tool output).
   */
  async executeAsync(name: string, rawArgs: unknown, options: RunOptions = {}): Promise<ToolResult> {
    const dispatch = async (): Promise<ToolResult> => {
      if (this.terminalActive) return { output: "[interactive terminal active; stop it before running local tools]", exitCode: 1 };
      if (options.signal?.aborted) return { output: "[aborted before start]", exitCode: 130 };
      if (this.reconcileCheckout()) return { output: "[checkout changed; shell state reset; request fresh approval]", exitCode: 1 };
      if (options.expectedShellContext !== undefined && options.expectedShellContext !== this.shellContext) {
        return { output: "[tool refused: shell session/cwd changed after approval; request fresh approval]", exitCode: 1 };
      }
      if (options.expectedToolCall !== undefined && options.expectedToolCall !== toolCallBinding(name, rawArgs)) {
        return { output: "[tool refused: arguments changed after approval; request fresh approval]", exitCode: 1 };
      }
      const mutation = MUTATING_TOOLS.has(name) && validateToolCall(name, rawArgs).ok && this.mode === "coding";
      if (mutation) this.armCommitGuard();
      const before = mutation ? this.ownership!.before() : null;
      try {
        const result = await this.dispatchAsync(name, rawArgs, options);
        if (before) this.ownership!.after(before, "model");
        if (this.reconcileCheckout()) result.output += "\n[checkout changed; shell cwd/environment/functions reset; queued commands discarded]";
        return result;
      } catch (error) { if (before) this.ownership!.after(before, "model"); throw error; }
    };
    try { return await (this.shellSession ? this.shellSession.withSlot(dispatch) : dispatch()); }
    catch (error) { return { output: `[tool ${name} error: ${String(error)}]`, exitCode: 1 }; }
  }

  private async dispatchAsync(name: string, rawArgs: unknown, options: RunOptions): Promise<ToolResult> {
    if (this.mode === "pc") return this.pcToolRefusal();
    const validation = validateToolCall(name, rawArgs);
    if (!validation.ok) {
      return { output: `[tool ${name} rejected: ${validation.error}]`, exitCode: 1 };
    }
    const args = validation.args;
    // run_shell / run_tests never reach execute() — arm here too, before the
    // command that may edit the workspace actually starts.
    if (MUTATING_TOOLS.has(name)) this.armCommitGuard();
    if (name === "web_search") {
      const limit = Number(args["limit"]);
      const text = await webSearch(
        String(args["query"] ?? ""),
        Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5,
      );
      return { output: capHeadTail(text, MAX_OUTPUT), exitCode: 0 };
    }
    if (name === "run_shell") {
      return this.run(String(args["command"] ?? ""), options);
    }
    if (name === "run_tests") {
      const cmd = String(args["command"] ?? "") || this.testCmd;
      // No explicit command and no configured testCmd: CONTRACTS.md invariant 5
      // — "" means "no ground truth to assert". Report it plainly instead of
      // spawning an empty/undefined command (which reads as a confusing shell
      // or ENOENT error) or silently substituting an unrelated test runner.
      if (!cmd) return { output: "[no test_cmd configured — unverifiable]", exitCode: 1 };
      return this.run(cmd, options);
    }
    if (name === "web_fetch") {
      const text = await webFetch(String(args["url"] ?? ""), MAX_OUTPUT);
      return { output: capHeadTail(text, MAX_OUTPUT), exitCode: 0 };
    }
    return this.executeSync(name, args);
  }

  private readFile(args: Record<string, string | number>): ToolResult {
    const path = String(args["path"]);
    const abs = this.safe(path);
    if (!existsSync(abs) || lstatSync(abs).isSymbolicLink() || !statSync(abs).isFile()) {
      return { output: `[no such file: ${path}]`, exitCode: 1 };
    }
    const fd = openSync(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(fd);
      if (!before.isFile()) return { output: `[no such file: ${path}]`, exitCode: 1 };
      const size = before.size;
      // Patch targets are capped, but reads remain available for arbitrarily large files.
      // A digest is only useful where patch_file can accept the target.
      let digest: string | null = null;
      if (size <= FILE_PATCH_MAX_BYTES) {
        const hash = createHash("sha256");
        const utf8 = new TextDecoder("utf-8", { fatal: true });
        const block = Buffer.allocUnsafe(64 * 1024);
        for (let at = 0; at < size;) {
          const n = readSync(fd, block, 0, Math.min(block.length, size - at), at);
          if (n === 0) throw new Error("file changed during read");
          if (block.subarray(0, n).some((byte) => byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)) {
            return { output: `[binary file: ${path}]`, exitCode: 1 };
          }
          try { utf8.decode(block.subarray(0, n), { stream: true }); }
          catch { return { output: `[invalid UTF-8 file: ${path}]`, exitCode: 1 }; }
          hash.update(block.subarray(0, n));
          at += n;
        }
        try { utf8.decode(); }
        catch { return { output: `[invalid UTF-8 file: ${path}]`, exitCode: 1 }; }
        digest = hash.digest("hex");
      }
      let result: ToolResult;
      if (args["start_line"] === undefined && args["max_lines"] === undefined) {
        const offset = Number(args["offset"] ?? 0);
        if (offset > size) return { output: `[offset beyond EOF: ${path}]`, exitCode: 1 };
        if (offset < size) {
          const first = Buffer.allocUnsafe(1);
          if (readSync(fd, first, 0, 1, offset) !== 1) throw new Error("file changed during read");
          if ((first[0]! & 0xc0) === 0x80) return { output: `[offset splits a UTF-8 character: ${path}]`, exitCode: 1 };
        }
        const bytes = Buffer.alloc(Math.min(size - offset, Number(args["max_bytes"] ?? 4096)));
        let loaded = 0;
        while (loaded < bytes.length) {
          const n = readSync(fd, bytes, loaded, bytes.length - loaded, offset + loaded);
          if (n === 0) throw new Error("file changed during read");
          loaded += n;
        }
        if (bytes.some((byte) => byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)) {
          return { output: `[binary file: ${path}]`, exitCode: 1 };
        }
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let end = bytes.length;
        while (end > 0) {
          try { decoder.decode(bytes.subarray(0, end)); break; }
          catch { end--; }
        }
        if (end === 0 && offset < size) return { output: `[offset splits a UTF-8 character or invalid UTF-8: ${path}]`, exitCode: 1 };
        const previous = Buffer.allocUnsafe(1);
        const startsMidLine = offset > 0 && readSync(fd, previous, 0, 1, offset - 1) === 1 && previous[0] !== 10;
        let output = "";
        while (end > 0 || offset === size) {
          let content: string;
          try { content = decoder.decode(bytes.subarray(0, end)); }
          catch { end--; continue; }
          const nextOffset = offset + end;
          output = JSON.stringify({ path, sha256: digest, offset, range_end: nextOffset,
            next_offset: nextOffset < size ? nextOffset : null, size,
            complete: offset === 0 && nextOffset === size, truncated: nextOffset < size,
            starts_mid_line: startsMidLine,
            ends_mid_line: nextOffset < size && end > 0 && bytes[end - 1] !== 10,
            validation_scope: digest === null ? "returned_range" : "whole_file", content });
          if (Buffer.byteLength(output) <= MAX_OUTPUT) break;
          end--;
        }
        if (end === 0 && offset < size) return { output: `[read_file cannot fit a UTF-8 character within output budget: ${path}]`, exitCode: 1 };
        result = { output, exitCode: 0 };
      } else {
        const start = Number(args["start_line"] ?? 1);
        const count = Number(args["max_lines"] ?? 200);
        const block = Buffer.allocUnsafe(64 * 1024);
        const selected: Buffer[] = [];
        let selectedBytes = 0;
        let selectedLines = 0;
        let line = 1;
        let current: number[] = [];
        let next: number | null = null;
        let tooLong = false;
        const finishLine = (hasNewline: boolean): boolean => {
          if (line >= start) {
            const extra = current.length + (selectedLines ? 1 : 0);
            if (selectedBytes + extra > 6000) { next = line; tooLong = selectedLines === 0; return true; }
            if (selectedLines) { selected.push(Buffer.from("\n")); selectedBytes++; }
            selected.push(Buffer.from(current)); selectedBytes += current.length;
            selectedLines++;
            if (selectedLines >= count && hasNewline) { next = line + 1; return true; }
          }
          line++;
          current = [];
          return false;
        };
        let stopped = false;
        for (let at = 0; at < size && !stopped;) {
          const n = readSync(fd, block, 0, Math.min(block.length, size - at), at);
          if (n === 0) throw new Error("file changed during read");
          for (let i = 0; i < n; i++) {
            const byte = block[i]!;
            if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127) {
              return { output: `[binary file: ${path}]`, exitCode: 1 };
            }
            if (byte === 10) { if (finishLine(true)) { stopped = true; break; } }
            else if (line >= start) {
              current.push(byte);
              if (selectedBytes + current.length + (selectedLines ? 1 : 0) > 6000) {
                next = line; tooLong = selectedLines === 0; stopped = true; break;
              }
            }
          }
          at += n;
        }
        if (!stopped) finishLine(false);
        if (selectedLines === 0 && !tooLong) return { output: `[start_line beyond EOF: ${path}]`, exitCode: 1 };
        if (tooLong) result = { output: JSON.stringify({ path, sha256: digest, start_line: start, next_start_line: null, size, validation_scope: digest === null ? "returned_range" : "whole_file", content: "", note: "line exceeds 6000 bytes; use offset/max_bytes" }), exitCode: 0 };
        else {
          const content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(selected, selectedBytes));
          result = { output: JSON.stringify({ path, sha256: digest, start_line: start, next_start_line: next, size, validation_scope: digest === null ? "returned_range" : "whole_file", content }), exitCode: 0 };
        }
      }
      const after = fstatSync(fd);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) return { output: `[read conflict: file changed during read: ${path}]`, exitCode: 1 };
      if (Buffer.byteLength(result.output) > MAX_OUTPUT) return { output: `[read_file output exceeds budget; use offset/max_bytes: ${path}]`, exitCode: 1 };
      return result;
    } finally { closeSync(fd); }
  }

  private listDirectory(args: Record<string, string | number>): ToolResult {
    const path = String(args["path"]);
    const abs = this.safe(path);
    if (!existsSync(abs) || lstatSync(abs).isSymbolicLink() || !statSync(abs).isDirectory()) {
      return { output: `[no such directory: ${path}]`, exitCode: 1 };
    }
    const directory = opendirSync(abs);
    const entries: Dirent[] = [];
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        entries.push(entry);
        if (entries.length > DIRECTORY_MAX_ENTRIES) return { output: "[directory exceeds 10000-entry listing limit]", exitCode: 1 };
      }
    } finally { directory.closeSync(); }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const version = createHash("sha256").update(entries.map((e) => {
      const item = lstatSync(resolve(abs, e.name));
      return `${e.name}\0${e.isDirectory() ? "d" : e.isFile() ? "f" : e.isSymbolicLink() ? "l" : "o"}\0${item.size}\0${item.mtimeMs}\n`;
    }).join("")).digest("hex");
    let after = "";
    if (args["cursor"] !== undefined) {
      let cursor: { after?: string; version?: string; path?: string };
      try { cursor = JSON.parse(Buffer.from(String(args["cursor"]), "base64url").toString("utf8")) as typeof cursor; }
      catch { return { output: "[invalid directory cursor]", exitCode: 1 }; }
      if (cursor.version !== version || cursor.path !== relative(this.root, abs) || typeof cursor.after !== "string") return { output: "[directory listing conflict: path or contents changed; restart pagination]", exitCode: 1 };
      after = cursor.after;
    }
    const start = after ? entries.findIndex((entry) => entry.name > after) : 0;
    const offset = start < 0 ? entries.length : start;
    const page: Array<{ path: string; type: string; size?: number }> = [];
    const limit = Number(args["limit"] ?? 50);
    for (let i = offset; i < entries.length && page.length < limit; i++) {
      const entry = entries[i]!;
      const type = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
      const item = { path: "./" + relative(this.root, resolve(abs, entry.name)).split(sep).join("/"), type, ...(type === "file" ? { size: statSync(resolve(abs, entry.name)).size } : {}) };
      if (Buffer.byteLength(JSON.stringify({ entries: [...page, item] })) > 6500) break;
      page.push(item);
    }
    if (page.length === 0 && offset < entries.length) return { output: "[directory entry exceeds output budget]", exitCode: 1 };
    const next = offset + page.length < entries.length
      ? Buffer.from(JSON.stringify({ after: entries[offset + page.length - 1]!.name, version, path: relative(this.root, abs) })).toString("base64url") : null;
    return { output: JSON.stringify({ path, entries: page, next_cursor: next }), exitCode: 0 };
  }

  /** Preview uses the same matching rules as execution. The digest is checked again after approval. */
  previewPatch(args: Record<string, unknown>): ToolResult {
    const valid = validateToolCall("patch_file", args);
    if (!valid.ok) return { output: `[patch rejected: ${valid.error}]`, exitCode: 1 };
    try {
      const proposal = this.patchProposal(valid.args);
      const before = proposal.original.slice(0, proposal.position);
      const line = before.split("\n").length;
      const column = before.length - before.lastIndexOf("\n");
      return { output: `--- ${JSON.stringify(proposal.path)}\n+++ ${JSON.stringify(proposal.path)}\n@@ line ${line}, column ${column} @@\n- ${JSON.stringify(proposal.oldText)}\n+ ${JSON.stringify(proposal.newText)}`, exitCode: 0 };
    } catch (error) { return { output: `[patch rejected: ${error instanceof Error ? error.message : String(error)}]`, exitCode: 1 }; }
  }

  private patchProposal(args: Record<string, string | number>): { path: string; abs: string; bytes: Buffer; original: string; content: string; position: number; oldText: string; newText: string; mode: number; ino: number; mtimeMs: number } {
    const path = String(args["path"]);
    const abs = this.safe(path);
    if (!existsSync(abs) || lstatSync(abs).isSymbolicLink() || !statSync(abs).isFile()) throw new Error("patch target must be a regular file");
    const stat = statSync(abs);
    if (stat.size > FILE_PATCH_MAX_BYTES) throw new Error("patch target too large");
    const bytes = readFileSync(abs);
    if (bytes.includes(0)) throw new Error("binary patch target");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (!/^[a-f0-9]{64}$/.test(String(args["expected_sha256"]))) throw new Error("expected_sha256 must be lowercase SHA-256");
    if (digest !== args["expected_sha256"]) throw new Error(`conflict: file changed since read (current sha256 ${digest})`);
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const oldText = String(args["old_text"]);
    const newText = String(args["new_text"]);
    if (oldText === newText) throw new Error("patch has no change");
    const line = args["start_line"] === undefined ? undefined : Number(args["start_line"]);
    let position: number;
    if (!oldText) {
      if (line === undefined) throw new Error("start_line required for insertion");
      const starts = [0];
      for (let i = 0; i < content.length; i++) if (content[i] === "\n") starts.push(i + 1);
      if (line > starts.length + (content.endsWith("\n") ? 0 : 1)) throw new Error("start_line beyond EOF");
      position = starts[line - 1] ?? content.length;
    } else {
      position = content.indexOf(oldText);
      if (position < 0) throw new Error("hunk does not match");
      if (content.indexOf(oldText, position + 1) >= 0) throw new Error("ambiguous hunk: old_text occurs more than once");
      if (line !== undefined && content.slice(0, position).split("\n").length !== line) throw new Error("hunk does not match start_line");
    }
    return { path, abs, bytes, original: content, content: content.slice(0, position) + newText + content.slice(position + oldText.length), position, oldText, newText, mode: stat.mode, ino: stat.ino, mtimeMs: stat.mtimeMs };
  }

  private patchFile(args: Record<string, string | number>): ToolResult {
    const proposal = this.patchProposal(args);
    const staged = resolve(dirname(proposal.abs), `.aether-patch-${randomUUID()}.tmp`);
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    let fd: number | undefined;
    try {
      fd = openSync(staged, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, proposal.mode);
      writeFileSync(fd, proposal.content, "utf8");
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      chmodSync(staged, proposal.mode);
      // Recheck immediately before replacement; stale input never replaces a user edit.
      const current = lstatSync(proposal.abs);
      if (!current.isFile() || current.isSymbolicLink() || current.mode !== proposal.mode || current.ino !== proposal.ino
        || current.mtimeMs !== proposal.mtimeMs || !readFileSync(proposal.abs).equals(proposal.bytes)) {
        throw new Error("conflict: file changed while patch was staged");
      }
      renameSync(staged, proposal.abs);
      return { output: `[patched ${proposal.path} · sha256 ${createHash("sha256").update(proposal.content).digest("hex")}]`, exitCode: 0 };
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(staged)) unlinkSync(staged);
    }
  }

  private writeFile(path: string, content: string): ToolResult {
    const abs = this.safe(path);
    mkdirSync(dirname(abs), { recursive: true });
    // Re-validate immediately before opening, then refuse a symlink final component.
    const verified = this.safe(path);
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const fd = openSync(verified, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow, 0o600);
    try {
      writeFileSync(fd, content, "utf8");
    } finally {
      closeSync(fd);
    }
    return { output: `[wrote ${path} · ${Buffer.byteLength(content)} bytes]`, exitCode: 0 };
  }

  /**
   * Read a file for diffing BEFORE it is overwritten. Same path-guard as every
   * tool. Returns existed=false for a new file (so the host can render `(new)`),
   * and text=null with a reason for binary / oversized / out-of-workspace
   * content (skip the diff, don't drown the transcript). Never throws — a guard
   * failure reads as "unsafe" so the write still proceeds and surfaces the real
   * error through the normal write path.
   */
  snapshot(path: string): FileSnapshot {
    let abs: string;
    try {
      abs = this.safe(path);
    } catch {
      return { existed: false, text: null, reason: "unsafe" };
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) return { existed: false, text: null };
    if (statSync(abs).size > SNAPSHOT_MAX_BYTES) return { existed: true, text: null, reason: "too-big" };
    const buf = readFileSync(abs);
    if (buf.includes(0)) return { existed: true, text: null, reason: "binary" };
    return { existed: true, text: buf.toString("utf8") };
  }

  private repoSearch(query: string): ToolResult {
    if (!query) return { output: "[exit 0]\n", exitCode: 0 };

    const hits: string[] = [];
    const visit = (dir: string): void => {
      if (hits.length >= SEARCH_MAX_HITS) return;
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (hits.length >= SEARCH_MAX_HITS) return;
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) {
          if (SEARCH_SKIP_DIRS.has(ent.name)) continue;
          const child = resolve(dir, ent.name);
          const real = realpathSync(child);
          if (real === this.root || real.startsWith(this.root + sep)) visit(child);
          continue;
        }
        if (!ent.isFile()) continue;

        const file = resolve(dir, ent.name);
        if (statSync(file).size > SNAPSHOT_MAX_BYTES) continue;
        const buf = readFileSync(file);
        if (buf.includes(0)) continue;
        const rel = "./" + relative(this.root, file).split(sep).join("/");
        const lines = buf.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        for (let i = 0; i < lines.length && hits.length < SEARCH_MAX_HITS; i++) {
          const line = lines[i]!;
          if (line.includes(query)) hits.push(`${rel}:${i + 1}:${line}`);
        }
      }
    };

    visit(this.root);
    return { output: `[exit 0]\n${capHeadTail(hits.join("\n"), MAX_OUTPUT)}`, exitCode: 0 };
  }

  private gitCommit(message: string): ToolResult {
    return this.armCommitGuard().commit(message, this.ownership!.candidates());
  }
}


/** Cap text to `max` chars keeping BOTH ends. Test runners print detail first and
 * the summary (`N failed`, final assertion) LAST — a head-only slice loses the
 * count the brain parses. Keep ~1/3 head + ~2/3 tail with an elision marker. */
export function capHeadTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  const tail = max - head;
  return text.slice(0, head) + `\n…[${text.length - max} chars elided]…\n` + text.slice(text.length - tail);
}
