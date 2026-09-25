// Tool executor — the ONE tool implementation, host-side. Both brains (local
// and cloud) emit tool_call events; the host executes them here and returns a
// tool_result. One path-guard, one output cap, identical for local and cloud.
//
// Output format mirrors the Python reference (`[exit N]\n<output>`) so the
// brain's grounding gate (tests_pass / parse_fail_count) reads the same shape
// regardless of which side originally ran it.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { ToolName } from "./brain_protocol.js";
import { validateToolCall } from "./tool_registry.js";
import { GitCommitGuard, SpawnGitRunner } from "./git_commit_guard.js";
import { webFetch, webSearch } from "./web.js";

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
}

export interface ToolResult {
  output: string;
  exitCode: number;
}

/** Chosen by the local host when it creates an executor, never by a tool call. */
export interface ToolExecutionContext {
  readonly mode: "coding" | "pc";
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
    }
    return this.committer;
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

      let out = "";
      let bytes = 0;
      const CAP = 64 * 1024 * 1024;
      const absorb = (chunk: Buffer): void => {
        bytes += chunk.length;
        // Keep draining past the cap so the pipe never blocks the child, but
        // stop retaining; capHeadTail trims the ends at the boundary anyway.
        if (bytes <= CAP) out += chunk.toString("utf8");
      };
      child.stdout?.on("data", absorb);
      child.stderr?.on("data", absorb);

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
        const body = capHeadTail(out, MAX_OUTPUT);
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
          return this.readFile(String(args["path"] ?? ""));
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
    return this.execute(name, args);
  }

  private readFile(path: string): ToolResult {
    const abs = this.safe(path);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      return { output: `[no such file: ${path}]`, exitCode: 1 };
    }
    return { output: readFileSync(abs, "utf8").slice(0, MAX_OUTPUT), exitCode: 0 };
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
    return this.armCommitGuard().commit(message);
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
