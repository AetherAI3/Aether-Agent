// Tool executor — the ONE tool implementation, host-side. Both brains (local
// and cloud) emit tool_call events; the host executes them here and returns a
// tool_result. One path-guard, one output cap, identical for local and cloud.
//
// Output format mirrors the Python reference (`[exit N]\n<output>`) so the
// brain's grounding gate (tests_pass / parse_fail_count) reads the same shape
// regardless of which side originally ran it.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { closeSync, constants as fsConstants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, statfsSync, statSync, writeFileSync } from "node:fs";
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
const READ_DEFAULT_BYTES = 4096;
// Linux local filesystems with nanosecond change metadata. Network and unknown
// filesystems are deliberately excluded from guarded continuation.
const REVISION_FS_TYPES = new Set([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n, 0x794c7630n]);

function fileRevision(stat: BigIntStats): string {
  const fields = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs];
  return "r1_" + createHash("sha256").update(fields.map(String).join(":"), "utf8").digest("base64url");
}
// CONTRACTS.md invariant 5: an unset test_cmd means "no ground truth to assert" —
// it must default to "" (unverifiable), never a real command. brain_protocol.ts's
// encodeCommand was fixed to this in cac0399; this sibling default is the executor
// that actually RUNS run_tests, so it must agree or every brain-initiated run_tests
// call with no explicit command silently runs pytest in non-Python repos.
const DEFAULT_TEST_CMD = "";
// Files larger than this are not diffed inline (the transcript would drown).
const SNAPSHOT_MAX_BYTES = 1024 * 1024;
const SEARCH_MAX_HITS = 40;
const SEARCH_SKIP_DIRS = new Set([".git", "node_modules", "dist"]);
/**
 * Tools that can change the workspace. The git commit guard's baseline must be
 * taken before the first of these runs, and there is no reason to take it
 * before that: a session that only reads never touches git at all.
 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
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
    const mutation = (name === "write_file" || name === "git_commit") && validateToolCall(name, rawArgs).ok && this.mode === "coding";
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
          return this.readFile(String(args["path"] ?? ""), Number(args["offset"] ?? 0), Number(args["max_bytes"] ?? READ_DEFAULT_BYTES), args["expected_revision"] as string | undefined);
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

  private readFile(path: string, offset: number, maxBytes: number, expectedRevision?: string): ToolResult {
    const abs = this.safe(path);
    const pathLabel = JSON.stringify(path);
    // Reserve room for metadata and the end marker. A long (or heavily
    // escaped) path must never make the returned tool output unbounded.
    const outputBudget = MAX_OUTPUT - pathLabel.length - 512;
    if (outputBudget < 4) return { output: "[read_file path too long to report within output limit]", exitCode: 1 };
    if (!existsSync(abs)) {
      return { output: `[no such file: ${path}]`, exitCode: 1 };
    }
    // The existing safe() guard checks the resolved path, including symlinks.
    // Read at most the requested bytes; even a sparse multi-gigabyte file stays cheap.
    const fd = openSync(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const initial = fstatSync(fd, { bigint: true });
      if (!initial.isFile()) return { output: `[not a regular file: ${path}]`, exitCode: 1 };
      // The Linux proc link names the actual opened object, including through
      // parent symlinks. On other hosts, check the path again and require it to
      // still name this handle; guarded continuation is unavailable there.
      if (process.platform === "linux") {
        const openedPath = readlinkSync(`/proc/self/fd/${fd}`).replace(/ \(deleted\)$/, "");
        if (openedPath !== this.root && !openedPath.startsWith(this.root + sep)) {
          return { output: `[read_file opened outside workspace: ${path}]`, exitCode: 1 };
        }
      } else {
        this.safe(path);
        const named = statSync(abs, { bigint: true });
        if (named.dev !== initial.dev || named.ino !== initial.ino) {
          return { output: `[read_file path changed while opening: ${path}; retry]`, exitCode: 1 };
        }
      }
      const revision = fileRevision(initial);
      if (expectedRevision !== undefined) {
        let supported = false;
        if (process.platform === "linux" && initial.dev !== 0n && initial.ino !== 0n) {
          try {
            supported = REVISION_FS_TYPES.has(statfsSync(`/proc/self/fd/${fd}`, { bigint: true }).type);
          } catch { /* procfs or filesystem metadata unavailable */ }
        }
        if (!supported) return { output: `[read_file revision_unsupported: guarded continuation is unavailable on this filesystem; ${path}]`, exitCode: 1 };
        if (expectedRevision !== revision) return { output: `[read_file stale_revision: ${path}; restart from offset 0]`, exitCode: 1 };
      }
      const totalBytes = Number(initial.size);
      if (!Number.isSafeInteger(totalBytes)) return { output: `[read_file file size exceeds supported range: ${path}]`, exitCode: 1 };
      if (offset > totalBytes) return { output: `[read_file offset ${offset} exceeds file size ${totalBytes}: ${path}]`, exitCode: 1 };

      if (offset < totalBytes) {
        const first = Buffer.allocUnsafe(1);
        if (readSync(fd, first, 0, 1, offset) !== 1) {
          return { output: `[read_file changed while reading: ${path}; retry]`, exitCode: 1 };
        }
        if ((first[0]! & 0xc0) === 0x80) {
          return { output: `[read_file offset ${offset} is inside a UTF-8 character: ${path}]`, exitCode: 1 };
        }
      }

      const bytes = Buffer.allocUnsafe(Math.min(maxBytes, outputBudget, totalBytes - offset));
      let count = 0;
      while (count < bytes.length) {
        const n = readSync(fd, bytes, count, bytes.length - count, offset + count);
        if (n === 0) break;
        count += n;
      }
      const current = fstatSync(fd, { bigint: true });
      if (fileRevision(current) !== revision || count !== bytes.length) {
        return { output: `[read_file changed while reading: ${path}; retry]`, exitCode: 1 };
      }
      if (bytes.subarray(0, count).some((byte) => byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)) {
        return { output: `[read_file unsupported binary content (control byte) at ${path}; range ${offset}..${offset + count} of ${totalBytes} bytes]`, exitCode: 1 };
      }

      // Streaming decode accepts an incomplete trailing character while still
      // rejecting malformed bytes. The encoded length is the exact byte cursor
      // for the valid prefix, including an optional UTF-8 BOM.
      let content: string;
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        content = decoder.decode(bytes, { stream: true });
        if (offset + count === totalBytes) content += decoder.decode();
      }
      catch {
        return { output: `[read_file unsupported or invalid UTF-8 content at ${path}; range ${offset}..${offset + count} of ${totalBytes} bytes]`, exitCode: 1 };
      }
      const end = Buffer.byteLength(content, "utf8");
      const nextOffset = offset + end;
      if (nextOffset === offset && offset < totalBytes) {
        return { output: `[read_file could not return a complete UTF-8 character at ${path}; increase max_bytes]`, exitCode: 1 };
      }
      const before = Buffer.allocUnsafe(1);
      const startsMidLine = offset > 0 && readSync(fd, before, 0, 1, offset - 1) === 1 && before[0] !== 10;
      const endsMidLine = nextOffset < totalBytes && end > 0 && bytes[end - 1] !== 10;
      if (fileRevision(fstatSync(fd, { bigint: true })) !== revision) {
        return { output: `[read_file changed while reading: ${path}; retry]`, exitCode: 1 };
      }
      const complete = offset === 0 && nextOffset === totalBytes;
      return {
        output: `[read_file path=${pathLabel} range=${offset}..${nextOffset} total_bytes=${totalBytes} complete=${complete} truncated=${nextOffset < totalBytes} next_offset=${nextOffset < totalBytes ? nextOffset : "none"} starts_mid_line=${startsMidLine} ends_mid_line=${endsMidLine} utf8_checked=returned_range revision=${revision}]\n${content}\n[/read_file]`,
        exitCode: 0,
      };
    } finally {
      closeSync(fd);
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
