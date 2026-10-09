// Session log — local, structured, the user's. Distinct from the context pool
// (machine-facing vector memory): this is the human-readable history of a run.
// Append-only JSONL + a rendered monologue + a manifest, under
// ~/.aether-agent/logs/<session-id>/ (override with AETHER_LOG_DIR). `/clear`
// wipes the pool, never these logs. See spec neo_lite_..._killgate.md §5.
//
//   events.jsonl   one {ts, type, ...} per event/command (the record)
//   monologue.txt  the rendered human view (stage / skill / checkpoint lines)
//   manifest.json  {sessionId, task, model, poolGb, brain, started, ended, finalStatus, ...}

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { SessionContext } from "./session_resume.js";
import type { PromptInput } from "../commands/prompt_file.js";
import { join } from "node:path";
import type { BrainEvent } from "./brain_protocol.js";
import type { ToolResult } from "./tool_executor.js";
import type { CheckReading } from "./verify_gate.js";
import type { VerificationRecord } from "./verification_record.js";
import { registerRestore } from "../ui/restore.js";
import { normalizeWorkspace } from "./workspace_scope.js";
import { logsRoot } from "./logs_root.js";
import { defaultRunner, type RunResult, type Runner } from "./worktree.js";
import { entryFromManifest, upsertSessionIndex } from "./session_index.js";

// The definition moved to logs_root.ts so this module and session_index.ts do
// not import each other; re-exported here because every existing caller — and
// every test — imports `logsRoot` from this file.
export { logsRoot } from "./logs_root.js";

// ── repository identity ─────────────────────────────────────────────────────
// Which checkout, which branch, which commit a run belonged to. It lives beside
// the rest of the session record because the manifest is where it is stored.
// handoff.ts re-exports it for its own callers and already depends on this
// module, so putting it the other way round would make an import cycle.

/** Where the work lived, expressed so it survives the trip to another machine. */
export interface RepoIdentity {
  /** `git remote get-url origin`, when there is one. */
  remote?: string;
  /** Branch the run was on. */
  branch?: string;
  /** HEAD sha, recorded for provenance. */
  head?: string;
}

/** Assemble a repo record, dropping empty fields. `undefined` when nothing is
 *  known — the shape is built in several places, so it is one rule here rather
 *  than several spellings that can drift. */
export function repoFrom(remote?: string, branch?: string, head?: string): RepoIdentity | undefined {
  if (!remote && !branch && !head) return undefined;
  return { ...(remote && { remote }), ...(branch && { branch }), ...(head && { head }) };
}

/** Read the repository identity of `cwd`. Every probe is best-effort — a plain
 *  directory with no git in it yields nothing, never an error. Argument arrays
 *  only: nothing user- or model-controlled is concatenated into a command line
 *  here, and `cwd` is passed as the child's working directory, not as text. */
export function readRepoIdentity(cwd: string, run: Runner): RepoIdentity | undefined {
  const value = (args: string[]): string | undefined => {
    let r: RunResult;
    try {
      r = run("git", args, cwd);
    } catch {
      return undefined;
    }
    const out = r.stdout.trim();
    return r.status === 0 && out ? out : undefined;
  };
  return repoFrom(
    value(["remote", "get-url", "origin"]),
    value(["rev-parse", "--abbrev-ref", "HEAD"]),
    value(["rev-parse", "HEAD"]),
  );
}



// "pat" is anchored to a whole word/segment on purpose. Bare /pat/ also matches
// PATH, path, patch, and pattern — so every `write_file {path}` in every session
// log was stored as "[REDACTED]", which is not redaction, it is data loss: the
// record could no longer say which files a run changed. Credential-shaped keys
// (pat, gh_pat, pat-token) still match.
const SENSITIVE_KEY =
  /token|secret|password|authorization|api[_-]?key|private[_-]?key|credential|(?:^|[_-])pat(?:$|[_-])/i;

export function redactInline(value: string): string {
  return value
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/((?:token|secret|password|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 512);
}

function loggedArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => {
    if (SENSITIVE_KEY.test(key)) return [key, "[REDACTED]"];
    if (key.toLowerCase() === "content") {
      return [key, `[omitted ${Buffer.byteLength(String(value), "utf8")} bytes]`];
    }
    if (key.toLowerCase() === "command") return [key, "[omitted shell command]"];
    if (typeof value === "string") return [key, redactInline(value)];
    if (Array.isArray(value)) return [key, `[omitted ${value.length} items]`];
    if (value && typeof value === "object") return [key, "[omitted object]"];
    return [key, value];
  }));
}

/** Keep event records useful for audit while preventing prompts, file contents,
 * shell commands, and credential-shaped values from becoming durable logs. */
function loggedEvent(ev: BrainEvent): BrainEvent {
  switch (ev.type) {
    case "tool_call":
      return { ...ev, name: redactInline(ev.name), args: loggedArgs(ev.args) };
    case "memory": {
      const { text, narrative, description, triggers, action, skill, skill_name, ...metadata } = ev;
      return {
        ...metadata,
        ...(text != null && { text: `[omitted ${Buffer.byteLength(text, "utf8")} bytes]` }),
        ...(narrative != null && { narrative: "[omitted memory narrative]" }),
        ...(description != null && { description: "[omitted memory description]" }),
        ...(triggers != null && { triggers: `[omitted ${triggers.length} triggers]` }),
        ...(action != null && { action: "[omitted memory action]" }),
        ...(skill != null && { skill: redactInline(skill) }),
        ...(skill_name != null && { skill_name: redactInline(skill_name) }),
      } as BrainEvent;
    }
    case "stage": return { ...ev, name: redactInline(ev.name), face: redactInline(ev.face) };
    case "skill": return { ...ev, name: redactInline(ev.name), reason: redactInline(ev.reason) };
    case "monologue": return { ...ev, text: redactInline(ev.text) };
    case "checkpoint": return { ...ev, gitSha: redactInline(ev.gitSha) };
    case "done": return { ...ev, result: redactInline(ev.result), reason: redactInline(ev.reason) };
    case "error": return { ...ev, msg: redactInline(ev.msg) };
    case "workflow_start": return { ...ev, workflowId: redactInline(ev.workflowId) };
    case "phase_start": return { ...ev, phaseType: redactInline(ev.phaseType) };
    case "phase_done": return { ...ev, artifactSummary: redactInline(ev.artifactSummary) };
    case "agent_spawn": return { ...ev, agentId: redactInline(ev.agentId), brief: redactInline(ev.brief) };
    case "agent_progress": return { ...ev, agentId: redactInline(ev.agentId), delta: redactInline(ev.delta) };
    case "agent_done": return { ...ev, agentId: redactInline(ev.agentId), summary: redactInline(ev.summary) };
    case "workflow_done": return { ...ev, synthesis: redactInline(ev.synthesis) };
    default: return ev;
  }
}

/** The terminal status of a run. Derived by the host's verify gate (verify_gate.ts)
 * from a real final test run — NEVER from the brain's self-report. "ok" only when the
 * host's tests are green; the breaker reasons (stalled/no-progress/max-turns) are the
 * brain's, surfaced through when the host is red; "unverified" when there is no gate.
 * "cancelled" and "timed-out" record a run that was stopped — before or during its
 * check — so the library never files an interruption as a red test run. */
export type FinalStatus =
  | "ok"
  | "incomplete"
  | "unverified"
  | "stalled"
  | "no-progress"
  | "max-turns"
  | "failed"
  | "error"
  | "cancelled"
  | "timed-out";

export interface SessionMeta {
  task: string;
  /** Source and UTF-8 byte size only; never the prompt body. */
  promptInput?: PromptInput;
  /** Resolved model provenance. Local runs store `ollama/<tag>`; cloud auto
   * routing stores an empty string rather than guessing the server's choice. */
  model: string;
  poolGb: number;
  brain: "local" | "cloud";
  cwd: string;
  /** The command the verify gate runs for this session. Recorded so a handoff
   *  can tell the next machine how this work is checked. */
  testCmd?: string;
  // ── continuity fields ─────────────────────────────────────────────────────
  // All optional, and absent when unknown. A session library that renders an
  // unrecorded branch as "main" or an unmeasured file count as 0 is worse than
  // one that says it does not know, so nothing here is defaulted.
  /** `git remote get-url origin` for the workspace, when there is one. */
  repoRemote?: string;
  /** Branch the run started on. */
  branch?: string;
  /** Revision the work is based on (merge-base with the base branch). */
  baseRev?: string;
  /** HEAD at the moment the session started. */
  headRev?: string;
  /** Worktree path, when it differs from `cwd`. */
  worktree?: string;
  /** Human label for the session, when one was given. */
  label?: string;
  /** Skill ids (with versions) applied to the run, for provenance. */
  skills?: string[];
  /** Digest of the instruction graph in force. */
  instructionsDigest?: string;
  /** The rules and skills this run was conducted under (digests, never content). */
  context?: SessionContext;
}

interface ManifestEnd {
  ended: string;
  finalStatus: string;
  remaining?: number;
  verification?: CheckReading;
  verificationRecord?: VerificationRecord;
  hostRefusals?: string[];
}

export class SessionLog {
  readonly dir: string;
  readonly sessionId: string;
  /** Logs root this session lives under — kept so the index update writes to
   *  the same root the session did, not to whatever the environment says now. */
  private readonly root: string;
  private readonly eventsPath: string;
  private readonly monologuePath: string;
  private readonly manifestPath: string;
  private events = 0;
  private toolCalls = 0;
  /** Distinct paths this run wrote. A Set, not a counter: the same file
   *  rewritten four times is one file touched, which is what a person reading
   *  the library means by the number. */
  private readonly written = new Set<string>();
  /** Skills the brain reported applying, in the order first seen. */
  private readonly skillsSeen = new Set<string>();
  /** Repository identity of the workspace when the session ENDED. Probed once,
   *  at close, and never at construction: `aether agent` startup runs no git,
   *  and #89 is the reason. Undefined means the probe found nothing (no
   *  checkout, no git binary), which is not the same as "no branch". */
  private repo: RepoIdentity | undefined;
  private readonly started: string;

  /** `now` is injected (ISO string) so the caller owns the clock — testable,
   * and the runtime never reaches for a forbidden Date() internally. */
  constructor(
    private readonly meta: SessionMeta,
    now: string,
    root: string = logsRoot(),
    /** How the repository identity is read at close. Injected so a test can
     *  drive every branch of it without a checkout, and so a caller that
     *  already knows the answer can supply it instead of spawning git. */
    private readonly probeRepo: (cwd: string) => RepoIdentity | undefined = (cwd) =>
      readRepoIdentity(cwd, defaultRunner()),
  ) {
    this.root = root;
    this.started = now;
    // process.pid makes the session dir collision-proof: two `aether code`
    // invocations with the same brain starting in the same millisecond would
    // otherwise resolve to the same directory, and the eager truncation below
    // would silently wipe the other, already-running session's events.
    this.sessionId = now.replace(/[:.]/g, "-") + "-" + String(meta.brain) + "-" + process.pid;
    this.dir = join(root, this.sessionId);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.eventsPath = join(this.dir, "events.jsonl");
    this.monologuePath = join(this.dir, "monologue.txt");
    writeFileSync(this.eventsPath, "", { encoding: "utf8", mode: 0o600 });
    writeFileSync(this.monologuePath, "", { encoding: "utf8", mode: 0o600 });
    this.manifestPath = join(this.dir, "manifest.json");
    this.writeManifest(null);
    // Batched writes must still land if the process exits abruptly (SIGINT
    // handlers call process.exit) — the exit hook drains the buffer.
    this.unregisterFlush = registerRestore(() => this.flush());
  }

  private readonly unregisterFlush: () => void;

  /** Record one brain event (and mirror human-readable lines to monologue.txt). */
  event(ev: BrainEvent, ts: string): void {
    this.events += 1;
    if (ev.type === "tool_call") {
      this.toolCalls += 1;
      // Counted from the RAW event: `loggedEvent` below is the redacted copy,
      // and the blast radius of a run must not depend on what redaction kept.
      // Case-folded on Windows, where `Foo.ts` and `foo.ts` are one file and
      // counting them twice would inflate the number the library shows.
      const path = ev.name === "write_file" ? ev.args["path"] : undefined;
      if (typeof path === "string" && path && this.written.size < 5_000) {
        this.written.add(process.platform === "win32" ? path.toLowerCase() : path);
      }
    }
    // Which skills a run actually applied is a question the library is asked and
    // could not answer: the events carry it, so the count is free here and the
    // alternative — re-reading the transcript at listing time — is the cost the
    // index exists to avoid. Bounded, because a hostile or looping brain must
    // not be able to grow the manifest without limit.
    if (ev.type === "skill" && ev.name && this.skillsSeen.size < 32) {
      this.skillsSeen.add(redactInline(ev.name));
    }
    const safe = loggedEvent(ev);
    this.buffer(this.eventsPath, JSON.stringify({ ts, ...safe }) + "\n");
    const line = monologueLine(safe);
    if (line) this.buffer(this.monologuePath, line + "\n");
  }

  /** Record the host's tool execution result (the other half of a tool_call). */
  toolResult(id: string, result: ToolResult, ts: string): void {
    this.buffer(
      this.eventsPath,
      JSON.stringify({ ts, type: "tool_result", id, exit_code: result.exitCode }) + "\n",
    );
  }

  // ── buffered appends ──────────────────────────────────────────────────────
  // A synchronous appendFileSync per stream event serializes disk I/O into the
  // presentation hot path (one fsync-able write per token burst). Events are
  // coalesced and flushed every FLUSH_EVERY events or FLUSH_MS ms, whichever
  // comes first — and always on close(), so the record stays loss-bounded.
  private static readonly FLUSH_EVERY = 50;
  private static readonly FLUSH_MS = 100;
  private pending = new Map<string, string[]>();
  private pendingCount = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private buffer(path: string, chunk: string): void {
    let arr = this.pending.get(path);
    if (!arr) {
      arr = [];
      this.pending.set(path, arr);
    }
    arr.push(chunk);
    this.pendingCount += 1;
    if (this.pendingCount >= SessionLog.FLUSH_EVERY) {
      this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), SessionLog.FLUSH_MS);
      if (typeof this.flushTimer.unref === "function") this.flushTimer.unref();
    }
  }

  /** Write all buffered lines to disk. Idempotent; safe to call any time. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingCount === 0) return;
    for (const [path, chunks] of this.pending) {
      if (chunks.length) appendFileSync(path, chunks.join(""), "utf8");
    }
    this.pending.clear();
    this.pendingCount = 0;
  }

  /** Finalize the manifest. `finalStatus` is derived from the HOST's own final
   * test run (ground truth), never from the brain's self-report. `remaining` =
   * failing tests when not ok (only written when > 0). `verification` is the
   * check reading the footer and JSON outcome rendered, recorded beside them. */
  close(finalStatus: FinalStatus, ended: string, remaining = 0, verification?: CheckReading, verificationRecord?: VerificationRecord, hostRefusals?: string[]): void {
    this.flush();
    this.unregisterFlush();
    // Read the repository identity HERE and nowhere else. The run is over, so
    // three `git rev-parse`-class calls cost nothing a user waits on, and the
    // startup path — the one #89 had to clear — still spawns nothing. Failure
    // leaves it undefined, which the library renders as "unknown".
    try {
      // Probe where the work actually HAPPENED. When the run was redirected
      // into a worktree, `cwd` is the directory the user launched from and its
      // branch is not the branch the commits landed on — recording the launch
      // directory's branch there would name the wrong branch with full
      // confidence.
      this.repo = this.probeRepo(this.meta.worktree || this.meta.cwd);
    } catch {
      this.repo = undefined;
    }
    this.writeManifest({ ended, finalStatus, remaining, ...(verification ? { verification } : {}), ...(verificationRecord ? { verificationRecord } : {}), ...(hostRefusals?.length ? { hostRefusals } : {}) });
  }

  /** The manifest body — the authoritative record of this session, and the only
   *  thing the session index is ever built from. */
  private manifestBody(end: ManifestEnd | null): Record<string, unknown> {
    const m = this.meta;
    // What the CALLER said wins over what was probed: a caller that knows the
    // branch (because it made one) knows better than a probe of the launch
    // directory. The probe only ever fills a gap.
    const remote = m.repoRemote ?? this.repo?.remote;
    const branch = m.branch ?? this.repo?.branch;
    const head = m.headRev ?? this.repo?.head;
    // Union, deduplicated: skills the caller declared plus skills the run
    // actually reported using.
    const skills = [...new Set([...(m.skills ?? []), ...this.skillsSeen])];
    return {
      sessionId: this.sessionId,
      task: redactInline(m.task),
      ...(m.promptInput ? { promptInput: {
        kind: m.promptInput.kind,
        bytes: m.promptInput.bytes,
        ...(m.promptInput.path ? { path: redactInline(m.promptInput.path) } : {}),
      } } : {}),
      model: m.model,
      poolGb: m.poolGb,
      brain: m.brain,
      cwd: normalizeWorkspace(m.cwd),
      ...(m.testCmd ? { testCmd: redactInline(m.testCmd) } : {}),
      ...(remote ? { repoRemote: redactInline(remote) } : {}),
      ...(branch ? { branch: redactInline(branch) } : {}),
      ...(m.baseRev ? { baseRev: redactInline(m.baseRev) } : {}),
      ...(head ? { headRev: redactInline(head) } : {}),
      ...(m.worktree ? { worktree: redactInline(m.worktree) } : {}),
      ...(m.label ? { label: redactInline(m.label) } : {}),
      ...(skills.length ? { skills: skills.map((s) => redactInline(s)) } : {}),
      ...(m.instructionsDigest ? { instructionsDigest: redactInline(m.instructionsDigest) } : {}),
      // #100. Digests and paths only. Instruction and skill bodies are the
      // project's prose and never belong in a session directory. Kept beside
      // the lane's own `skills`/`instructionsDigest` because the two record
      // different things: what the caller declared, and what the host loop saw.
      ...(m.context ? { context: m.context } : {}),
      started: this.started,
      ended: end?.ended ?? null,
      finalStatus: end?.finalStatus ?? "running",
      events: this.events,
      toolCalls: this.toolCalls,
      filesTouched: this.written.size,
      ...(end?.remaining != null && end.remaining > 0 && { remaining: end.remaining }),
      // The command and any server text are the user's and the model's; the
      // same inline redaction the task and testCmd get applies to the reason.
      ...(end?.verification && {
        verification: {
          state: end.verification.state,
          reason: redactInline(end.verification.reason),
          exitCode: end.verification.exitCode,
          failing: end.verification.failing,
        },
      }),
      ...(end?.verificationRecord && {
        verificationRecord: {
          command: redactInline(end.verificationRecord.command),
          ranAt: end.verificationRecord.ranAt,
          head: end.verificationRecord.head,
          treeDigest: end.verificationRecord.treeDigest,
          exitCode: end.verificationRecord.exitCode,
        },
      }),
      ...(end?.hostRefusals?.length && { hostRefusals: end.hostRefusals.slice(0, 16).map(redactInline) }),
    };
  }

  private writeManifest(end: ManifestEnd | null): void {
    const body = this.manifestBody(end);
    writeFileSync(this.manifestPath, JSON.stringify(body, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    this.indexSelf(body);
  }

  /**
   * Mirror the manifest into the session index.
   *
   * Best-effort by design: the manifest is the record, the index is a cache of
   * it, and a locked or unwritable index must never take a run down or lose the
   * session's own log. A skipped update self-heals on the next read, which
   * rebuilds from the manifests.
   *
   * Called twice per session (open and close), never per event — each call
   * takes the index lock.
   */
  private indexSelf(body: Record<string, unknown>): void {
    try {
      const entry = entryFromManifest(this.sessionId, body);
      if (entry) upsertSessionIndex(entry, this.root);
    } catch {
      /* the manifest is written; the index rebuilds from it on read */
    }
  }
}

/** The human-facing monologue line for an event (null = not shown in the tree). */
export function monologueLine(ev: BrainEvent): string | null {
  switch (ev.type) {
    case "stage":
      return `* ${ev.name}`;
    case "skill":
      return `  ⌁ skill ${ev.name}${ev.reason ? ` (${ev.reason})` : ""}`;
    case "monologue":
      return `${"  ".repeat(ev.depth + 1)}${ev.depth > 0 ? "└─ " : ""}${ev.text}`;
    case "tool_call":
      return `  : ${ev.name}`;
    case "checkpoint":
      return `  [▪]→[▪▪] checkpoint ${ev.gitSha}`;
    case "done":
      return `\n${ev.ok ? "OKAY" : "FAIL"} ${ev.result}`;
    case "error":
      return `✗ ${ev.msg}`;
    default:
      return null; // status/telemetry are live-only, not part of the record tree
  }
}
