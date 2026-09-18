// src/core/doctor_live.ts — `aether doctor --live`: prove the paths, now.
//
// Fast mode answers "is this configured". This answers "does it work", and it
// only ever claims what it actually exercised. Three rules shape everything
// here:
//
//   1. No spend. Billing state is accounted across the run and every probe
//      asserts it did not move. The Agent-loop proof runs only when the server
//      confirms a non-billable doctor session; otherwise it reports
//      not-checked and says why. A skipped check is never a pass.
//   2. No orphans. Sessions, temp files and the loopback server are torn down
//      in `finally`.
//   3. No guessing. Where the surface to prove something does not exist yet
//      (an MCP tool nobody marked doctor-safe, a server that does not honour
//      the doctor purpose), that is reported as unproven, not assumed good.

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AppContext } from "./context.js";
import type { CatalogItem, CatalogResponse } from "../types.js";
import {
  DEV_SESSIONS_PATH,
  MODELS_PATH,
  devSessionPath,
  devSessionStreamPath,
  devSessionToolResultsPath,
} from "./transport.js";
import { buildDevSessionRequest } from "./envelope.js";
import { decodeSse, type StreamFrame } from "./stream.js";
import { TOOLS } from "./brain_protocol.js";
import { DEV_PROTOCOL_VERSION } from "./brain_cloud.js";
import { appendCustody, readCustodyLog } from "./custody.js";
import { McpClient } from "./mcp.js";
import { LocalMcpStore } from "./mcp_store.js";
import { bounded } from "./mcp_diagnostics.js";
import {
  McpOperationSupervisor,
  McpOperationTimeoutError,
} from "./mcp_lifecycle.js";
import { openTarget, type OpenOptions } from "./opener.js";
import { browserHint, detectBrowserRuntime, verifyBrowserLaunch } from "./browser_runtime.js";
import { defaultRunner, ghAuthStatus, type Runner } from "./worktree.js";
import {
  axis,
  buildReport,
  notApplicable,
  notChecked,
  type Axis,
  type HealthCheck,
  type HealthReport,
  type Severity,
} from "./health.js";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_OPENER_TIMEOUT_MS = 15_000;

export interface LiveOptions {
  now?: () => string;
  /** Per-probe bound. A broken service must never hang the CLI. */
  timeoutMs?: number;
  openerTimeoutMs?: number;
  /** --no-ui: no desktop to open into, so the opener proof reports skipped. */
  headless?: boolean;
  runId?: string;
  cwd?: string;
  mcpClient?: McpClient;
  mcpStore?: LocalMcpStore;
  runner?: Runner;
  openerOptions?: OpenOptions;
  /** Test seam: skip binding a real loopback socket. */
  skipOpenerProbe?: boolean;
}

/** What a probe reports before it is folded into a HealthCheck. */
interface ProbeResult {
  configured?: Axis;
  reachable?: Axis;
  verified?: Axis;
  severity: Severity;
  remediation?: string;
}

interface Probe {
  id: string;
  category: string;
  title: string;
}

function check(probe: Probe, result: ProbeResult): HealthCheck {
  return {
    id: probe.id,
    category: probe.category,
    title: probe.title,
    configured: result.configured ?? axis("yes"),
    reachable: result.reachable ?? notChecked("not exercised by this run"),
    verified: result.verified ?? notChecked("not exercised by this run"),
    severity: result.severity,
    ...(result.remediation ? { remediation: result.remediation } : {}),
  };
}

function since(startedMs: number): number {
  return Math.max(0, Date.now() - startedMs);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ═════════════════════════════════════════════════════════════════════
// Billing ledger — the no-spend invariant
// ═════════════════════════════════════════════════════════════════════

/**
 * Every uvt/cents figure this run observed on the wire. The doctor path is
 * supposed to move none of it; if any frame reports otherwise, that is an
 * error, not a footnote.
 */
export class SpendLedger {
  private uvt = 0;
  private cents = 0;
  private opened = 0;
  private closed = 0;

  observe(frame: StreamFrame): void {
    if (frame.type === "usage" || frame.type === "done") {
      this.uvt += Number(frame.uvt ?? 0);
      this.cents += Number(frame.cents ?? 0);
    }
  }

  sessionOpened(): void {
    this.opened += 1;
  }

  sessionClosed(): void {
    this.closed += 1;
  }

  get spent(): boolean {
    return this.uvt > 0 || this.cents > 0;
  }

  get orphaned(): number {
    return Math.max(0, this.opened - this.closed);
  }

  summary(): string {
    return `uvt ${this.uvt}, cents ${this.cents}, sessions opened ${this.opened}, closed ${this.closed}`;
  }
}

// ═════════════════════════════════════════════════════════════════════
// Agent session proof
// ═════════════════════════════════════════════════════════════════════

/**
 * The dev-session create response. `purpose` and `billable` are the doctor
 * contract: a server that supports a non-billable health session echoes
 * `purpose: "doctor"` and `billable: false`. Until it does, this client will
 * not run the agent loop — see agentProbes().
 */
interface DevSessionCreated {
  session_id: string;
  purpose?: string;
  billable?: boolean;
}

export interface AgentProofState {
  sessionId: string | null;
  /** Frame sequence numbers in the order they arrived. */
  seqs: number[];
  sawSessionFrame: boolean;
  answeredTools: string[];
  toolResultAcks: string[];
  closed: boolean;
}

/** Strictly increasing, which is what the resume-from-lastSeq contract needs. */
export function seqIsMonotonic(seqs: readonly number[]): boolean {
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i]! <= seqs[i - 1]!) return false;
  }
  return true;
}

const AGENT_PROBES = {
  session: { id: "agent.session", category: "agent", title: "Agent dev session" },
  frames: { id: "agent.frames", category: "agent", title: "Agent frame sequence" },
  control: { id: "agent.session.control", category: "agent", title: "Agent session control" },
  tool: { id: "agent.tool.roundtrip", category: "agent", title: "Agent tool round trip" },
  close: { id: "agent.session.close", category: "agent", title: "Agent session close" },
} as const;

const DOCTOR_SESSION_CONTRACT =
  'the server must accept a non-billable doctor session (request purpose:"doctor", max_uvt:0; ' +
  'response echoing purpose:"doctor", billable:false) before the agent loop can be proven without spending';

const DOCTOR_CONTROL_NA =
  'purpose="doctor" deliberately rejects pause, resume, and steer; coding-session control is not part of the zero-spend probe';

export function agentUnproven(reason: string): HealthCheck[] {
  return Object.values(AGENT_PROBES).map((probe) => {
    if (probe.id === AGENT_PROBES.control.id) return controlCheck();
    return check(probe, {
      configured: axis("yes"),
      reachable: notChecked(reason),
      verified: notChecked(reason),
      severity: "warning",
      remediation: DOCTOR_SESSION_CONTRACT,
    });
  });
}

/**
 * Exercise create -> frames -> Cloud's fixed write/read tool round trip ->
 * close. Doctor sessions intentionally have no coding-control authority.
 */
async function agentProbes(
  ctx: AppContext,
  ledger: SpendLedger,
  options: LiveOptions,
  sandbox: string,
): Promise<HealthCheck[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const nonce = options.runId ?? randomUUID();

  let created: DevSessionCreated;
  const startedCreate = Date.now();
  try {
    const request = {
      ...buildDevSessionRequest({
        task: `aether doctor health probe ${nonce}`,
        capabilities: TOOLS,
        protocolVersion: DEV_PROTOCOL_VERSION,
      }),
      // The doctor contract. A server that does not understand it will either
      // ignore these fields (caught by the billable check below) or reject.
      purpose: "doctor",
      max_uvt: 0,
    };
    created = await bounded(
      ctx.api.postJson<DevSessionCreated>(DEV_SESSIONS_PATH, request),
      timeoutMs,
    );
  } catch (err) {
    return agentUnproven(`dev session could not be created: ${message(err)}`);
  }

  if (!created?.session_id) {
    return agentUnproven("dev session response carried no session_id");
  }
  ledger.sessionOpened();

  // Fail closed. If the server has not confirmed this is non-billable, close
  // immediately rather than run a probe that might cost the user money.
  if (created.purpose !== "doctor" || created.billable !== false) {
    await closeSession(ctx, created.session_id, ledger, timeoutMs);
    return agentUnproven(
      "the server created a session but did not confirm it as a non-billable doctor session; " +
        "closed it immediately rather than risk a billed probe",
    );
  }

  const state: AgentProofState = {
    sessionId: created.session_id,
    seqs: [],
    sawSessionFrame: false,
    answeredTools: [],
    toolResultAcks: [],
    closed: false,
  };

  const checks: HealthCheck[] = [
    check(AGENT_PROBES.session, {
      reachable: axis("yes", {
        checkedAt: new Date().toISOString(),
        latencyMs: since(startedCreate),
      }),
      verified: axis("yes", {
        checkedAt: new Date().toISOString(),
        evidence: `non-billable doctor session ${created.session_id.slice(0, 8)}`,
      }),
      severity: "info",
    }),
  ];

  try {
    await drive(ctx, state, ledger, { ...options, timeoutMs }, sandbox);
    checks.push(framesCheck(state), controlCheck(), toolCheck(state));
  } catch (err) {
    const reason = `agent loop aborted: ${message(err)}`;
    checks.push(
      check(AGENT_PROBES.frames, { verified: axis("no", { evidence: reason }), severity: "error" }),
      controlCheck(),
      check(AGENT_PROBES.tool, { verified: notChecked(reason), severity: "warning" }),
    );
  } finally {
    state.closed = await closeSession(ctx, created.session_id, ledger, timeoutMs);
  }

  checks.push(
    check(AGENT_PROBES.close, {
      verified: axis(state.closed ? "yes" : "no", {
        checkedAt: new Date().toISOString(),
        evidence: state.closed
          ? "session closed, no lease left behind"
          : "session did not close cleanly",
      }),
      severity: state.closed ? "info" : "error",
    }),
  );
  return checks;
}

export function framesCheck(state: AgentProofState): HealthCheck {
  const ok = state.seqs.length > 0 && seqIsMonotonic(state.seqs);
  return check(AGENT_PROBES.frames, {
    reachable: axis(state.seqs.length ? "yes" : "no"),
    verified: axis(ok ? "yes" : "no", {
      checkedAt: new Date().toISOString(),
      evidence:
        `${state.seqs.length} frame(s), seq ${state.seqs[0] ?? "-"}..${state.seqs.at(-1) ?? "-"}` +
        (state.sawSessionFrame ? ", session frame received" : ", no session frame"),
    }),
    severity: ok ? "info" : "error",
  });
}

export function controlCheck(): HealthCheck {
  return check(AGENT_PROBES.control, {
    configured: notApplicable(DOCTOR_CONTROL_NA),
    reachable: notApplicable(DOCTOR_CONTROL_NA),
    verified: notApplicable(DOCTOR_CONTROL_NA),
    severity: "info",
  });
}

export function toolCheck(state: AgentProofState): HealthCheck {
  const exactTools =
    state.answeredTools.length === 2 &&
    state.answeredTools[0] === "write_file" &&
    state.answeredTools[1] === "read_file";
  const exactAcks = state.toolResultAcks.length === 2;
  const ok = exactTools && exactAcks;
  return check(AGENT_PROBES.tool, {
    verified: axis(ok ? "yes" : "no", {
      checkedAt: new Date().toISOString(),
      evidence: ok
        ? "Cloud doctor write_file/read_file arguments executed in the private sandbox; both results acknowledged"
        : `expected write_file/read_file with two acknowledgements; answered ${state.answeredTools.join(", ") || "none"}, acknowledgements ${state.toolResultAcks.length}`,
    }),
    severity: ok ? "info" : "error",
  });
}

/**
 * Read the frame stream and answer Cloud's fixed doctor tool calls inside a
 * doctor-owned temp directory. Coding controls are invalid for this purpose.
 */
async function drive(
  ctx: AppContext,
  state: AgentProofState,
  ledger: SpendLedger,
  options: LiveOptions,
  sandbox: string,
): Promise<void> {
  const id = state.sessionId!;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const net = new AbortController();
  const deadline = setTimeout(() => net.abort(), timeoutMs);

  try {
    const stream = await ctx.api.stream(devSessionStreamPath(id, 0), undefined, {
      method: "GET",
      signal: net.signal,
    });

    for await (const frame of decodeSse(stream)) {
      ledger.observe(frame);
      if (typeof frame.seq === "number") state.seqs.push(frame.seq);
      if (frame.type === "session") state.sawSessionFrame = true;

      if (frame.type === "tool_call") {
        if (await answerToolCall(ctx, id, frame, sandbox, timeoutMs)) {
          state.answeredTools.push(frame.name);
        }
      }
      if (frame.type === "tool_result_ack") state.toolResultAcks.push(frame.toolCallId);

      if (frame.type === "done" || frame.type === "error") break;
    }
  } finally {
    clearTimeout(deadline);
    net.abort();
  }
}

/**
 * Execute Cloud's purpose-bound doctor tools with their exact arguments. The
 * server supplies a relative path; it is resolved beneath the fresh private
 * sandbox and rejected if it could escape that boundary.
 */
async function answerToolCall(
  ctx: AppContext,
  id: string,
  frame: Extract<StreamFrame, { type: "tool_call" }>,
  sandbox: string,
  timeoutMs: number,
): Promise<boolean> {
  let status = "ok";
  let exitCode = 0;
  let output = "";
  try {
    const path = doctorSandboxPath(sandbox, frame.args["path"]);
    if (frame.name === "write_file") {
      const content = frame.args["content"];
      if (typeof content !== "string") throw new Error("write_file content must be a string");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
      output = readFileSync(path, "utf8");
    } else if (frame.name === "read_file") {
      output = readFileSync(path, "utf8");
    } else {
      throw new Error(`unsupported doctor tool ${frame.name}`);
    }
  } catch (err) {
    status = "error";
    exitCode = 1;
    output = message(err);
  }
  try {
    await bounded(
      ctx.api.postJson(devSessionToolResultsPath(id), {
        tool_call_id: frame.toolCallId,
        status,
        exit_code: exitCode,
        output,
      }),
      timeoutMs,
    );
    return status === "ok";
  } catch {
    // A refused result surfaces as the missing tool_result_ack, not here.
    return false;
  }
}

function doctorSandboxPath(sandbox: string, requested: unknown): string {
  if (typeof requested !== "string" || !requested) {
    throw new Error("doctor tool path must be a non-empty string");
  }
  const root = resolve(sandbox);
  const target = resolve(root, requested);
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("doctor tool path escaped the private sandbox");
  }
  return target;
}

async function closeSession(
  ctx: AppContext,
  id: string,
  ledger: SpendLedger,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await bounded(ctx.api.deleteJson(devSessionPath(id)), timeoutMs);
    ledger.sessionClosed();
    return true;
  } catch {
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════
// Catalog
// ═════════════════════════════════════════════════════════════════════

async function catalogProbe(ctx: AppContext, timeoutMs: number): Promise<HealthCheck> {
  const probe = {
    id: "agent.catalog",
    category: "agent",
    title: "Capability manifest and model catalog",
  };
  const started = Date.now();
  try {
    const payload = await bounded(
      ctx.api.getJson<CatalogResponse | CatalogItem[]>(MODELS_PATH),
      timeoutMs,
    );
    // Production returns CatalogResponse. Retain the old bare-array shape as a
    // bounded compatibility read so doctor can diagnose older deployments
    // without turning a healthy current response into an empty catalogue.
    const list = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray(payload.models)
        ? payload.models
        : null;
    const wellFormed = list !== null && list.every(
      (item) => typeof item?.id === "string" && typeof item?.kind === "string",
    );
    const ok = list !== null && wellFormed && list.length > 0;
    const evidence = list === null
      ? "invalid /models response shape; expected {models:[...]}"
      : `${list.length} catalog item(s), ${list.filter((i) => i?.available).length} available to this tier`;
    return check(probe, {
      reachable: axis("yes", { checkedAt: new Date().toISOString(), latencyMs: since(started) }),
      verified: axis(ok ? "yes" : "no", {
        checkedAt: new Date().toISOString(),
        evidence,
      }),
      severity: ok ? "info" : "error",
    });
  } catch (err) {
    return check(probe, {
      reachable: axis("no", { checkedAt: new Date().toISOString(), evidence: message(err) }),
      verified: axis("no"),
      severity: "error",
    });
  }
}

// ═════════════════════════════════════════════════════════════════════
// Opener loopback proof
// ═════════════════════════════════════════════════════════════════════

const OPENER_PROBE = { id: "opener.local", category: "opener", title: "Browser and file opener" };

/**
 * Prove the production opener actually launched something, by opening a
 * loopback page and waiting for that page to call back with our nonce. A
 * headless session has no desktop, so it reports skipped rather than passing.
 */
export async function openerProbe(options: LiveOptions = {}): Promise<HealthCheck> {
  const skipReason = options.headless
    ? "headless session (--no-ui): no desktop to open into"
    : options.skipOpenerProbe
      ? "opener probe disabled for this run"
      : null;
  if (skipReason) {
    return check(OPENER_PROBE, {
      reachable: notChecked(skipReason),
      verified: notChecked(skipReason),
      severity: "info",
    });
  }

  const timeoutMs = options.openerTimeoutMs ?? DEFAULT_OPENER_TIMEOUT_MS;
  const started = Date.now();
  const launcher = options.openerOptions ?? {};

  try {
    // `configured` is what the OS says it has; `verified` is what actually
    // rendered. They are separate axes because they fail separately: a machine
    // can have a registered browser that a sandbox then refuses to launch, and
    // a machine with no registered browser can still be handed a working
    // launcher by an injected test seam.
    const detected = detectBrowserRuntime({
      ...(launcher.platform ? { platform: launcher.platform } : {}),
      ...(launcher.env ? { env: launcher.env } : {}),
    });

    // The loopback proof itself lives in browser_runtime.ts — one server, one
    // nonce comparison, one teardown, shared with every other caller that needs
    // to know whether a browser really opened. `detect` is forced READY here on
    // purpose: doctor's job is to probe rather than to trust detection, and the
    // openerOptions seam substitutes the launcher in tests.
    const proof = await verifyBrowserLaunch({
      timeoutMs,
      detect: { code: "BROWSER_READY" },
      open: (url) => {
        const outcome = openTarget(url, launcher);
        return {
          status: outcome.status,
          executable: outcome.executable,
          detail: outcome.detail,
          cause: outcome.cause,
        };
      },
    });

    if (proof.code !== "BROWSER_READY" && proof.code !== "BROWSER_UNVERIFIED") {
      const unavailable = proof.code === "BROWSER_HEADLESS";
      return check(OPENER_PROBE, {
        configured: axis(unavailable ? "unknown" : "no", { evidence: proof.evidence }),
        reachable: axis("no", { evidence: proof.evidence }),
        verified: axis("no", { evidence: `${proof.code}: ${browserHint(proof.code)}` }),
        severity: unavailable ? "warning" : "error",
      });
    }

    return check(OPENER_PROBE, {
      configured: axis(detected.available ? "yes" : "no", {
        evidence: detected.available
          ? `${detected.browser ?? detected.launcher} via ${detected.launcher} (argument array, no shell)`
          : `${detected.code}: ${detected.evidence}`,
      }),
      reachable: axis(proof.verified ? "yes" : "no"),
      verified: axis(proof.verified ? "yes" : "no", {
        checkedAt: new Date().toISOString(),
        latencyMs: since(started),
        evidence: proof.evidence,
      }),
      severity: proof.verified ? "info" : "warning",
    });
  } catch (err) {
    return check(OPENER_PROBE, {
      verified: axis("no", { evidence: message(err) }),
      severity: "error",
    });
  }
}

// ═════════════════════════════════════════════════════════════════════
// GitHub identity and branch freshness
// ═════════════════════════════════════════════════════════════════════

export function githubProbe(runner: Runner): HealthCheck {
  const probe = { id: "github.connection", category: "github", title: "GitHub identity" };
  const started = Date.now();
  const status = ghAuthStatus(runner);
  return check(probe, {
    configured: axis(status.authed ? "yes" : "no"),
    reachable: axis(status.authed ? "yes" : "no", {
      checkedAt: new Date().toISOString(),
      latencyMs: since(started),
    }),
    verified: axis(status.authed ? "yes" : "no", {
      checkedAt: new Date().toISOString(),
      // The login is the user's own identity, not a credential.
      evidence: status.authed
        ? `local gh session${status.user ? ` as ${status.user}` : ""}${status.host ? ` on ${status.host}` : ""}`
        : "gh is not installed or not logged in",
    }),
    severity: status.authed ? "info" : "warning",
    ...(status.authed ? {} : { remediation: "run: gh auth login" }),
  });
}

export type BranchState =
  | "current"
  | "ahead"
  | "behind"
  | "diverged"
  | "unpublished"
  | "detached"
  | "unknown";

export interface BranchFreshness {
  state: BranchState;
  branch: string;
  local: string;
  remote: string;
  detail: string;
}

/**
 * Compare local HEAD to the remote branch tip WITHOUT fetching. `ls-remote`
 * reads the remote ref; everything else is answered from the local object
 * store. When the remote commit is not present locally we say so rather than
 * fetching to find out — a health command must not mutate the repository.
 */
export function branchFreshness(runner: Runner, cwd: string): BranchFreshness {
  const head = runner("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (head.status !== 0) {
    return { branch: "", local: "", remote: "", state: "unknown", detail: "not a git checkout" };
  }
  const branch = head.stdout.trim();
  if (!branch || branch === "HEAD") {
    return {
      branch: "",
      local: "",
      remote: "",
      state: "detached",
      detail: "HEAD is detached; no branch to compare",
    };
  }
  const local = runner("git", ["-C", cwd, "rev-parse", "HEAD"], cwd).stdout.trim();

  const remote = runner("git", ["-C", cwd, "ls-remote", "--heads", "origin", branch], cwd);
  if (remote.status !== 0) {
    return { branch, local, remote: "", state: "unknown", detail: "origin could not be reached" };
  }
  const remoteSha = remote.stdout.trim().split(/\s+/)[0] ?? "";
  if (!remoteSha) {
    return {
      branch,
      local,
      remote: "",
      state: "unpublished",
      detail: "no matching branch on origin",
    };
  }
  if (remoteSha === local) {
    return { branch, local, remote: remoteSha, state: "current", detail: "local and origin agree" };
  }

  const known = runner("git", ["-C", cwd, "cat-file", "-e", `${remoteSha}^{commit}`], cwd);
  if (known.status !== 0) {
    return {
      branch,
      local,
      remote: remoteSha,
      state: "unknown",
      detail: "origin has a commit this checkout has never seen; fetch to compare",
    };
  }
  const remoteIsAncestor =
    runner("git", ["-C", cwd, "merge-base", "--is-ancestor", remoteSha, local], cwd).status === 0;
  const localIsAncestor =
    runner("git", ["-C", cwd, "merge-base", "--is-ancestor", local, remoteSha], cwd).status === 0;

  if (remoteIsAncestor) {
    return { branch, local, remote: remoteSha, state: "ahead", detail: "local is ahead of origin" };
  }
  if (localIsAncestor) {
    return { branch, local, remote: remoteSha, state: "behind", detail: "origin is ahead of local" };
  }
  return {
    branch,
    local,
    remote: remoteSha,
    state: "diverged",
    detail: "local and origin have diverged",
  };
}

export function branchProbe(runner: Runner, cwd: string): HealthCheck {
  const probe = { id: "workspace.git", category: "workspace", title: "Git checkout" };
  const started = Date.now();
  const freshness = branchFreshness(runner, cwd);
  const healthy = freshness.state === "current" || freshness.state === "ahead";
  const unknown = freshness.state === "unknown" || freshness.state === "detached";
  return check(probe, {
    configured: axis(freshness.branch ? "yes" : "unknown", {
      evidence: freshness.branch || "no branch",
    }),
    reachable: axis(freshness.remote ? "yes" : unknown ? "unknown" : "no", {
      checkedAt: new Date().toISOString(),
      latencyMs: since(started),
    }),
    verified: axis(healthy ? "yes" : unknown ? "unknown" : "no", {
      checkedAt: new Date().toISOString(),
      // Read-only throughout: ls-remote plus local object queries. No fetch,
      // no pull, no ref was written.
      evidence: `${freshness.state}: ${freshness.detail} (compared without fetching)`,
    }),
    severity: healthy || unknown ? "info" : "warning",
  });
}

// ═════════════════════════════════════════════════════════════════════
// MCP broker
// ═════════════════════════════════════════════════════════════════════

export interface DoctorSafeTool {
  name: string;
  description?: string;
  readOnly?: boolean;
  doctorSafe?: boolean;
}

/**
 * A tool is only safe for doctor to call when it says so itself. The broker's
 * ToolDescriptor carries no readOnly/doctorSafe annotation today, so this looks
 * for one and reports honestly when none exists rather than guessing at a name.
 */
export function pickDoctorSafeTool(tools: readonly DoctorSafeTool[]): string | null {
  const safe = tools.find((tool) => tool.readOnly === true && tool.doctorSafe === true);
  return safe ? safe.name : null;
}

async function mcpProbe(
  client: McpClient,
  store: LocalMcpStore,
  timeoutMs: number,
): Promise<HealthCheck> {
  const probe = { id: "mcp.broker", category: "mcp", title: "MCP broker" };
  const registered = store.inspect().servers.length;
  const started = Date.now();
  const supervisor = new McpOperationSupervisor();
  try {
    // Two calls, because a provider being *known* is not the same as it being
    // *connected*: listProviders is the catalogue, listConnections is the
    // subset this account has actually linked.
    const [providers, connections] = await supervisor.run(
      "doctor broker discovery",
      (signal) => Promise.all([
        client.listProviders({ signal, timeoutMs }),
        client.listConnections({ signal, timeoutMs }),
      ]),
      { timeoutMs },
    );
    const linked = new Set(connections.map((c) => c.provider_id));
    const connected = providers.filter((p) => linked.has(p.provider_id));
    const reachable = axis("yes", {
      checkedAt: new Date().toISOString(),
      latencyMs: since(started),
    });

    if (!connected.length) {
      return check(probe, {
        configured: axis(registered ? "yes" : "unknown", {
          evidence: `${registered} server(s) registered`,
        }),
        reachable,
        verified: notChecked(
          "broker answered but no provider is connected, so no tool could be called",
        ),
        severity: "info",
      });
    }

    const tools = (await supervisor.run(
      "doctor broker tool catalog",
      (signal) => client.listTools(connected[0]!.provider_id, { signal, timeoutMs }),
      { timeoutMs },
    )) as DoctorSafeTool[];
    const safe = pickDoctorSafeTool(tools);
    if (!safe) {
      return check(probe, {
        configured: axis("yes", { evidence: `${registered} server(s) registered` }),
        reachable,
        verified: notChecked(
          `broker reachable and ${tools.length} tool(s) listed, but none is declared ` +
            "readOnly + doctorSafe; guessing which tool is harmless is not a proof",
        ),
        severity: "info",
      });
    }
    return check(probe, {
      configured: axis("yes"),
      reachable,
      verified: notChecked(
        `tool ${safe} is declared readOnly + doctorSafe, but this client exposes no ` +
          "doctor-safe invocation route; listing a tool is not execution proof",
      ),
      severity: "info",
    });
  } catch (err) {
    return check(probe, {
      configured: axis(registered ? "yes" : "unknown"),
      reachable: axis("no", {
        checkedAt: new Date().toISOString(),
        evidence: err instanceof McpOperationTimeoutError
          ? err.message
          : "broker probe failed; run `aether mcp doctor` for redacted diagnostics",
      }),
      verified: axis("no"),
      severity: "warning",
    });
  } finally {
    supervisor.dispose();
  }
}

// ═════════════════════════════════════════════════════════════════════
// Protocol-C receipt round trip
// ═════════════════════════════════════════════════════════════════════

/**
 * Persist, read back, verify, and prove replay de-duplication — through the
 * production appendCustody/readCustodyLog path, but pointed at a doctor-owned
 * sandbox so the user's real receipt log is never written to.
 */
export function custodyProbe(sandbox: string, runId: string): HealthCheck {
  const probe = {
    id: "custody.receipts",
    category: "custody",
    title: "Protocol-C receipt persistence",
  };
  const logPath = join(sandbox, "custody.jsonl");
  const orderId = `doctor-${runId}`;
  const commitmentHash = runId.replace(/-/g, "").slice(0, 16);
  const record = {
    protocol: "protocol-c",
    order_id: orderId,
    commitment: { hash: commitmentHash },
  };
  try {
    appendCustody(record, logPath);
    const found = readCustodyLog(10, logPath).find((entry) => entry.order_id === orderId);
    const commitmentOk =
      found != null &&
      (found["commitment"] as { hash?: string } | undefined)?.hash === commitmentHash;

    // Idempotence is part of the contract: the same order_id must not append
    // a second row.
    appendCustody(record, logPath);
    const deduped = readCustodyLog(10, logPath).filter((e) => e.order_id === orderId).length === 1;

    const ok = commitmentOk && deduped;
    return check(probe, {
      configured: axis("yes"),
      reachable: notApplicable("local log"),
      verified: axis(ok ? "yes" : "no", {
        checkedAt: new Date().toISOString(),
        evidence: ok
          ? "receipt persisted, read back, commitment matched, and a replay was de-duplicated"
          : `persisted=${found != null}, commitment matched=${commitmentOk}, de-duplicated=${deduped}`,
      }),
      severity: ok ? "info" : "error",
    });
  } catch (err) {
    return check(probe, { verified: axis("no", { evidence: message(err) }), severity: "error" });
  }
}

// ═════════════════════════════════════════════════════════════════════
// Report
// ═════════════════════════════════════════════════════════════════════

export function spendCheck(ledger: SpendLedger): HealthCheck {
  const clean = !ledger.spent && ledger.orphaned === 0;
  return check({ id: "spend.none", category: "billing", title: "No spend, no orphans" }, {
    configured: axis("yes"),
    reachable: notApplicable("accounting over this run"),
    verified: axis(clean ? "yes" : "no", {
      checkedAt: new Date().toISOString(),
      evidence: ledger.spent
        ? `this run was billed — ${ledger.summary()}`
        : ledger.orphaned > 0
          ? `${ledger.orphaned} session(s) left open — ${ledger.summary()}`
          : ledger.summary(),
    }),
    severity: clean ? "info" : "error",
  });
}

function automationChecks(): HealthCheck[] {
  const na = (id: string, title: string, why: string): HealthCheck =>
    check({ id, category: "automation", title }, {
      configured: notApplicable(why),
      reachable: notApplicable(why),
      verified: notApplicable(why),
      severity: "info",
    });
  return [
    na("actions.dispatch", "GitHub Actions dispatch", "this build has no workflow-dispatch surface"),
    na("predator.readiness", "Predator readiness", "this build has no Predator client"),
  ];
}

/**
 * Run the live proof. Independent read-only probes run concurrently; the agent
 * session sequence stays serial so a missing acknowledgement cannot be confused
 * with a racing one.
 */
export async function liveReport(ctx: AppContext, options: LiveOptions = {}): Promise<HealthReport> {
  const now = options.now ?? ((): string => new Date().toISOString());
  const runId = options.runId ?? randomUUID();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const runner = options.runner ?? defaultRunner();
  const cwd = options.cwd ?? ctx.flags.cwd;
  const client = options.mcpClient ?? new McpClient(ctx.api);
  const store = options.mcpStore ?? new LocalMcpStore();
  const ledger = new SpendLedger();

  const sandbox = mkdtempSync(join(tmpdir(), `aether-doctor-${runId.slice(0, 8)}-`));
  try {
    const authed = Boolean(await ctx.tokens.get());
    const authCheck = check({ id: "auth.credential", category: "auth", title: "Authentication" }, {
      configured: axis(authed ? "yes" : "no"),
      reachable: notApplicable("the stored credential is local"),
      // Deliberately not refreshed: a health command must not rotate a token.
      verified: axis(authed ? "yes" : "no", {
        checkedAt: now(),
        evidence: authed ? "credential present; not refreshed" : "signed out",
      }),
      severity: authed ? "info" : "warning",
      ...(authed ? {} : { remediation: "run: aether auth login" }),
    });

    const independent = await Promise.all([
      catalogProbe(ctx, timeoutMs),
      openerProbe(options),
      Promise.resolve(githubProbe(runner)),
      Promise.resolve(branchProbe(runner, cwd)),
      mcpProbe(client, store, timeoutMs),
      Promise.resolve(custodyProbe(sandbox, runId)),
    ]);

    const agent = authed
      ? await agentProbes(ctx, ledger, { ...options, runId, timeoutMs }, sandbox)
      : agentUnproven("signed out; the agent loop cannot be exercised");

    return buildReport(
      "live",
      [authCheck, ...agent, ...independent, ...automationChecks(), spendCheck(ledger)],
      now(),
    );
  } finally {
    // Every temp file this run created lives under `sandbox`, so one removal
    // is the whole cleanup.
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // A leftover doctor sandbox is swept by `doctor --fix`.
    }
  }
}
