// Bridge protocol — the FROZEN event seam between a headless brain and this TS
// host. Mirror of aether_agent/protocol.py; wire keys are snake_case (the
// Python side's keys) and are mapped to camelCase here. One schema, two
// transports: local NDJSON over stdio (brain_local) · cloud SSE (brain_cloud).
//
// The brain DECIDES and emits events; the host (this process) RENDERS every
// event and EXECUTES every tool_call, replying with a tool_result. One tool
// implementation, one path-guard — so local and cloud UX are identical by
// construction. Canonical spec: docs/BRIDGE_PROTOCOL.md.

// Bump on ANY breaking change to the message shapes below. The Python mirror
// (aether_agent/protocol.py) MUST carry the same number; the conformance fixture
// (test/fixtures/bridge_conformance.json) pins both. Canonical: docs/CONTRACTS.md.
export const PROTOCOL_VERSION = 4;
export const MAX_MONOLOGUE_DEPTH = 32;

// --- agent context packet (host -> brain, additive + OPTIONAL) -------------
// The TYPED channel for skill and instruction context. Additive and optional,
// so per docs/CONTRACTS.md's versioning rule it does NOT bump PROTOCOL_VERSION:
// a brain that predates it ignores the key, and one that understands it reads
// provenance (id, version, digest, invocation, source path) alongside content.
//
// This is DATA the brain reads, never host policy. Tool and permission
// narrowing is enforced host-side in skills/skill_policy.refuseUndeclaredToolCall
// immediately before execution — never by asking a model to respect a list.
export const AGENT_CONTEXT_CONTRACT_VERSION = 1;

export interface AgentContextPacket {
  contract_version: number;
  /** Loaded skills for this turn; null when none loaded or --no-skills. */
  skills: SkillContextPacket | null;
  /** AGENTS.md and friends resolved against the run root; null when none. */
  instructions: InstructionContextPacket | null;
}

// Type-only imports: erased at compile time, so the wire seam keeps no runtime
// dependency on the skills subsystem (and no import cycle with skill_policy,
// which imports TOOLS from here).
import type { SkillContextPacket } from "./skills/context_packet.js";
import type { InstructionContextPacket } from "./instructions/instruction_resolver.js";

// --- workflow swarm frame interfaces ---------------------------------------
export interface WorkflowStartFrame {
  type: "workflow_start";
  workflowId: string;
  phases: Array<{ n: number; type: string; agents: number }>;
  totalAgents: number;
}
export interface PhaseStartFrame {
  type: "phase_start";
  phaseN: number;
  phaseType: string;
  agentCount: number;
}
export interface PhaseDoneFrame {
  type: "phase_done";
  phaseN: number;
  artifactSummary: string;
}
export interface AgentSpawnFrame {
  type: "agent_spawn";
  agentId: string;
  phaseN: number;
  brief: string;
}
export interface AgentProgressFrame {
  type: "agent_progress";
  agentId: string;
  delta: string;
}
export interface AgentDoneFrame {
  type: "agent_done";
  agentId: string;
  phaseN: number;
  summary: string;
  // Tier-2/3 metrics (docs/specs/2026-07-10-workflow-viewer-agent-panel-design.md,
  // Finding E) — additive optional fields per CONTRACTS.md's versioning rule, so
  // a brain that doesn't send them yet never breaks old (or new) consumers.
  // undefined (not 0) when absent — the UI renders "—", never a fabricated number.
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
}
/**
 * Transport routing drift — the requested transport was NOT the one used.
 *
 * HOST-SIDE ONLY: no brain sends this over the wire, so it is not part of the
 * frozen NDJSON/SSE decode surface and does not bump PROTOCOL_VERSION (it is
 * additive per docs/CONTRACTS.md's versioning rule).
 *
 * It exists because a downgrade from the dev-session protocol to the one-way
 * chat stream MOVES WHERE THE WORK HAPPENS: a dev session runs tools on this
 * machine against this checkout; the chat stream runs them server-side against
 * the cloud vault. That is an identity change, not a performance detail, so it
 * is an event the user sees and `--json` carries — never a silent branch.
 *
 * `kind` duplicates `type` on purpose: `--json` consumers pin the stable tag
 * "routing_drift" without having to know the BrainEvent `type` vocabulary.
 */
export interface RoutingDriftFrame {
  type: "routing_drift";
  kind: "routing_drift";
  /** The transport the run asked for. */
  requested: "dev_session";
  /** What it actually got — "refused" when the run failed closed instead. */
  resolved: "chat_stream" | "refused";
  /** HTTP status that caused the drift (403 flagged off · 404 route absent). */
  status: number;
  /** The server's own explanation, sanitized (transport.sanitizeServerText). */
  reason: string;
  /** What it means for this checkout, in plain words. */
  consequence: string;
  /** One line the user can act on. */
  remediation: string;
  /** True when the run refused to continue because local authority was required. */
  fatal: boolean;
}

export interface WorkflowDoneFrame {
  type: "workflow_done";
  synthesis: string;
  totalPhases: number;
  totalAgents: number;
}

// --- brain -> host events --------------------------------------------------
export type BrainEvent =
  | { type: "stage"; name: string; face: string }
  | { type: "monologue"; text: string; depth: number }
  | { type: "skill"; name: string; reason: string } // a procedure packet was pinned
  // per-assistant-turn diagnostics (the §8 emission curve feed)
  | {
      type: "turn";
      n: number;
      toolCalls: number;
      malformed: number;
      invented: number;
      noCall: boolean;
      failCount: number | null;
    }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "telemetry"; tokens: number; tps: number; ctxUsed: number; ctxCap: number; vram: number }
  | { type: "status"; phase: string; poolUsed: number; poolCap: number }
  | { type: "checkpoint"; gitSha: string }
  // ok is derived from a real final test run; remaining = failing tests when not ok;
  // reason ∈ "" | "stalled" | "no-progress" | "max-turns" | "unverified".
  | { type: "done"; ok: boolean; result: string; remaining: number; reason: string }
  | { type: "error"; msg: string }
  // memory bridge — QOPC memory frames forwarded as events
  | {
      type: "memory";
      subtype: string;
      text?: string;
      kind?: string;
      confidence?: number;
      skill?: string;
      narrative?: string;
      factCount?: number;
      beforeTokens?: number;
      afterTokens?: number;
      freedPct?: number;
      dimension?: string;
      from?: number;
      to?: number;
      direction?: string;
      // behavioral skill fields (subtype "behavioral")
      skill_name?: string;
      description?: string;
      triggers?: string[];
      action?: string;
      category?: string;
    }
  | WorkflowStartFrame
  | PhaseStartFrame
  | PhaseDoneFrame
  | AgentSpawnFrame
  | AgentProgressFrame
  | AgentDoneFrame
  | WorkflowDoneFrame
  | RoutingDriftFrame;

// --- host -> brain commands ------------------------------------------------
export type HostCommand =
  | {
      type: "task";
      text: string;
      cwd: string;
      poolGb: number;
      effort?: string;
      model?: string;
      testCmd?: string;
      /** Skill + instruction context for this turn (see AgentContextPacket). */
      context?: AgentContextPacket;
    }
  | { type: "tool_result"; id: string; output: string; exitCode: number }
  | { type: "control"; action: "pause" | "resume" | "steer"; note?: string };

// Canonical tool names — the ONE implementation lives in tool_executor.ts.
export const TOOLS = [
  "read_file",
  "list_directory",
  "patch_file",
  "write_file",
  "run_shell",
  "run_tests",
  "repo_search",
  "git_commit",
  "web_search",
  "web_fetch",
] as const;
export type ToolName = (typeof TOOLS)[number];

// --- decode (wire object -> BrainEvent) ------------------------------------
const num = (v: unknown, d = 0): number => {
  const parsed = v == null ? d : Number(v);
  return Number.isFinite(parsed) ? parsed : d;
};
const nonNegativeNum = (v: unknown, d = 0): number => Math.max(0, num(v, d));
const nonNegativeInt = (v: unknown, d = 0): number => Math.trunc(nonNegativeNum(v, d));
const monologueDepth = (v: unknown): number => Math.min(MAX_MONOLOGUE_DEPTH, nonNegativeInt(v));
const str = (v: unknown, d = ""): string => (v == null ? d : String(v));
// Absent optional wire field -> undefined (not 0/false) — a missing Tier-2/3
// metric must never be indistinguishable from a real zero (Finding E). A
// non-numeric garbage value (e.g. tokens:"abc") must also decode as absent,
// not NaN — NaN != null is true in JS, so a naive version would let it slip
// through as "present" and render the literal string "NaN".
const numOrUndef = (v: unknown): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

const workflowPhases = (v: unknown): Array<{ n: number; type: string; agents: number }> => {
  if (!Array.isArray(v)) return [];
  return v.flatMap((phase) => {
    if (!phase || typeof phase !== "object" || Array.isArray(phase)) return [];
    const item = phase as Record<string, unknown>;
    return [{ n: nonNegativeInt(item["n"]), type: str(item["type"]), agents: nonNegativeInt(item["agents"]) }];
  });
};

/** Normalize one parsed wire object into a typed BrainEvent (null = ignore). */
export function decodeEvent(obj: Record<string, unknown>): BrainEvent | null {
  const t = obj["type"];
  if (typeof t !== "string") return null;
  switch (t) {
    case "stage":
      return { type: "stage", name: str(obj["name"]), face: str(obj["face"]) };
    case "monologue":
      return { type: "monologue", text: str(obj["text"]), depth: monologueDepth(obj["depth"]) };
    case "skill":
      return { type: "skill", name: str(obj["name"]), reason: str(obj["reason"]) };
    case "turn":
      return {
        type: "turn",
        n: nonNegativeInt(obj["n"]),
        toolCalls: nonNegativeInt(obj["tool_calls"]),
        malformed: nonNegativeInt(obj["malformed"]),
        invented: nonNegativeInt(obj["invented"]),
        noCall: Boolean(obj["no_call"]),
        failCount: obj["fail_count"] == null ? null : nonNegativeInt(obj["fail_count"]),
      };
    case "tool_call":
      return {
        type: "tool_call",
        id: str(obj["id"]),
        name: str(obj["name"]),
        args: (obj["args"] as Record<string, unknown>) ?? {},
      };
    case "telemetry":
      return {
        type: "telemetry",
        tokens: nonNegativeNum(obj["tokens"]),
        tps: nonNegativeNum(obj["tps"]),
        ctxUsed: nonNegativeNum(obj["ctx_used"]),
        ctxCap: nonNegativeNum(obj["ctx_cap"]),
        vram: nonNegativeNum(obj["vram"]),
      };
    case "status":
      return {
        type: "status",
        phase: str(obj["phase"]),
        poolUsed: nonNegativeNum(obj["pool_used"]),
        poolCap: nonNegativeNum(obj["pool_cap"]),
      };
    case "checkpoint":
      return { type: "checkpoint", gitSha: str(obj["git_sha"]) };
    case "done":
      return {
        type: "done",
        ok: Boolean(obj["ok"]),
        result: str(obj["result"]),
        remaining: nonNegativeInt(obj["remaining"]),
        reason: str(obj["reason"]),
      };
    case "error":
      return { type: "error", msg: str(obj["msg"]) };
    case "workflow_start":
      return {
        type: "workflow_start",
        workflowId: str(obj["workflow_id"]),
        phases: workflowPhases(obj["phases"]),
        totalAgents: nonNegativeInt(obj["total_agents"]),
      };
    case "phase_start":
      return {
        type: "phase_start",
        phaseN: nonNegativeInt(obj["phase_n"]),
        phaseType: str(obj["phase_type"]),
        agentCount: nonNegativeInt(obj["agent_count"]),
      };
    case "phase_done":
      return {
        type: "phase_done",
        phaseN: nonNegativeInt(obj["phase_n"]),
        artifactSummary: str(obj["artifact_summary"]),
      };
    case "agent_spawn":
      return {
        type: "agent_spawn",
        agentId: str(obj["agent_id"]),
        phaseN: nonNegativeInt(obj["phase_n"]),
        brief: str(obj["brief"]),
      };
    case "agent_progress":
      return {
        type: "agent_progress",
        agentId: str(obj["agent_id"]),
        delta: str(obj["delta"]),
      };
    case "agent_done":
      return {
        type: "agent_done",
        agentId: str(obj["agent_id"]),
        phaseN: nonNegativeInt(obj["phase_n"]),
        summary: str(obj["summary"]),
        tokens: numOrUndef(obj["tokens"]),
        toolCalls: numOrUndef(obj["tool_calls"]),
        durationMs: numOrUndef(obj["duration_ms"]),
      };
    case "workflow_done":
      return {
        type: "workflow_done",
        synthesis: str(obj["synthesis"]),
        totalPhases: nonNegativeInt(obj["total_phases"]),
        totalAgents: nonNegativeInt(obj["total_agents"]),
      };
    default:
      return null; // unknown event type — ignore per contract
  }
}

/** Parse one NDJSON line into a BrainEvent (null for blank / malformed). */
export function parseEventLine(line: string): BrainEvent | null {
  const s = line.trim();
  if (!s) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
  return decodeEvent(obj);
}

// --- encode (HostCommand -> NDJSON line) -----------------------------------
/** One command -> one NDJSON line (newline included), wire keys snake_case. */
export function encodeCommand(cmd: HostCommand): string {
  let wire: Record<string, unknown>;
  switch (cmd.type) {
    case "task":
      wire = {
        type: "task",
        text: cmd.text,
        cwd: cmd.cwd,
        pool_gb: cmd.poolGb,
        effort: cmd.effort ?? "",
        model: cmd.model ?? "",
        // CONTRACTS.md: test_cmd="" means unverifiable — must match the
        // host's own default (code.ts only runs its final gate when
        // --test-cmd is explicit). Defaulting to "pytest -q" here made the
        // brain self-verify Python repos while the host still reported
        // "unverified", and made it grind pytest pointlessly in JS/Go/Rust
        // repos when the user simply forgot the flag.
        test_cmd: cmd.testCmd ?? "",
        // Omitted entirely when absent rather than sent as null: a brain that
        // predates the field must see no key at all, and "no context" must
        // never decode as "an empty context was deliberately supplied".
        ...(cmd.context ? { context: cmd.context } : {}),
      };
      break;
    case "tool_result":
      wire = { type: "tool_result", id: cmd.id, output: cmd.output, exit_code: cmd.exitCode };
      break;
    case "control":
      wire = { type: "control", action: cmd.action, note: cmd.note ?? "" };
      break;
  }
  // CONTRACTS.md invariant 3: the wire is ASCII-escaped (ensure_ascii) so it
  // survives a Windows cp1252 pipe. Raw UTF-8 here corrupts (…→â€¦) or
  // crashes (UnicodeDecodeError on bytes undefined in cp1252) the Python
  // brain — capped tool_results inject '…' on every truncation.
  return asciiEscape(JSON.stringify(wire)) + "\n";
}

/** \uXXXX-escape every non-ASCII char (JSON-semantically identical). */
export function asciiEscape(json: string): string {
  return json.replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

// --- NDJSON line buffer (partial-line safe stdout framing) -----------------
/** Accumulates byte chunks and yields complete lines. Robust to a JSON object
 * split across chunk boundaries — the LSP/DAP framing pattern. */
export class LineBuffer {
  private buf = "";
  /** Feed a decoded string chunk; return the complete lines it produced. */
  push(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      lines.push(this.buf.slice(0, idx));
      this.buf = this.buf.slice(idx + 1);
    }
    return lines;
  }
  /** Any trailing partial line (no newline yet). */
  rest(): string {
    return this.buf;
  }
}
