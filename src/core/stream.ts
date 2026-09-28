// Universal stream decoder.
//
// Frame vocabulary is the canonical AetherCloud UVT streaming wire contract:
//   AETHER-CLOUD docs/superpowers/specs/2026-05-31-uvt-stream-contract.md
//   the Aether streaming contract
//
// One vocabulary across every path: chat (/agent/chat/stream), orchestrator
// (/project/stream/{id}), and MCP agent (/agent/mcp-chat). Unknown `type`s MUST
// be ignored. The CF-flush preamble (`:<4096 spaces>`) and `ping` heartbeat are
// handled here (comment lines skipped; ping surfaced as a typed liveness frame).

import { StreamEventTooLargeError, StreamIncompleteError } from "./errors.js";

/** One event may contain model text, but never an unbounded delimiter-free body. */
export const MAX_SSE_EVENT_BYTES = 1_048_576;

export type StreamFrame = StreamFrameBody & {
  /** Per-session monotonic sequence number (dev-session frames only). A
   *  reconnecting client resumes with ?last_seq=N and MUST skip seq <= N so a
   *  replayed mutating tool_call is never executed twice. */
  seq?: number;
};

export type StreamFrameBody =
  // shared
  | { type: "open" }
  | { type: "ping" }
  | { type: "reasoning"; text: string }
  | { type: "delta"; text: string }
  | { type: "usage"; uvt: number; cents: number }
  | {
      type: "done";
      uvt: number;
      cents: number;
      inputTokens?: number;
      outputTokens?: number;
      ok?: boolean;
      /** False only for a client-synthesized terminal frame after the legacy
       * non-streaming endpoint, which does not report authoritative usage. */
      usageKnown?: boolean;
    }
  | { type: "error"; msg: string; errorCode?: string; refId?: string }
  // Agent dev sessions (/agent/dev/sessions/{id}/stream) — the bidirectional
  // coding protocol: the API brain emits tool_call, the local host executes
  // and POSTs the result back.
  | { type: "session"; sessionId: string; protocolVersion: number; model?: string; tools?: string[] }
  | { type: "notice"; notice: string; oldestSeq?: number }
  | { type: "tool_call"; toolCallId: string; name: string; args: Record<string, unknown>; risk?: string }
  | { type: "tool_result_ack"; toolCallId: string }
  // The server-signed chain-of-custody for this turn (commitment + attestation).
  // The server signs but never stores it — the client decides whether to persist
  // (the CLI logs it locally; a web client may show-then-discard).
  | { type: "custody"; custody: Record<string, unknown> }
  // orchestrator-only (/project/stream)
  | { type: "connected" }
  | { type: "progress"; text?: string }
  | { type: "task_start"; taskId?: string; label?: string }
  | { type: "task_progress"; taskId: string; delta?: string; uvt?: number; cents?: number }
  | { type: "task_done"; taskId?: string }
  | { type: "task_failed"; taskId?: string; msg?: string }
  | { type: "task_blocked"; taskId?: string; msg?: string }
  | { type: "project_done" }
  // memory bridge — QOPC memory frames (subtype-discriminated, forward-compat)
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
  // workflow swarm frames (emitted by WorkflowEngine in AETHER-CLOUD)
  | { type: "workflow_start"; workflow_id: string; phases: Array<{ n: number; type: string; agents: number }>; total_agents: number }
  | { type: "phase_start"; phase_n: number; phase_type: string; agent_count: number }
  | { type: "phase_done"; phase_n: number; artifact_summary: string }
  | { type: "agent_spawn"; agent_id: string; phase_n: number; brief: string }
  | { type: "agent_progress"; agent_id: string; delta: string }
  | {
      type: "agent_done";
      agent_id: string;
      phase_n: number;
      summary: string;
      // Tier-2/3 metrics (docs/specs/2026-07-10-workflow-viewer-agent-panel-design.md,
      // Finding E) — additive/optional, undefined (not 0) when the backend hasn't
      // sent them yet.
      tokens?: number;
      tool_calls?: number;
      duration_ms?: number;
    }
  | { type: "workflow_done"; synthesis: string; total_phases: number; total_agents: number };

/** Normalize a parsed JSON object (snake_case wire → camelCase) into a frame. */
export function normalizeFrame(obj: Record<string, unknown>): StreamFrame | null {
  const frame = normalizeFrameBody(obj) as StreamFrame | null;
  if (frame) {
    const seq = obj["seq"];
    if (typeof seq === "number" && Number.isFinite(seq)) frame.seq = seq;
  }
  return frame;
}

function normalizeFrameBody(obj: Record<string, unknown>): StreamFrameBody | null {
  const type = obj["type"];
  if (typeof type !== "string") return null;
  switch (type) {
    case "open":
      return { type: "open" };
    case "ping":
      return { type: "ping" };
    case "reasoning":
      return { type: "reasoning", text: String(obj["text"] ?? "") };
    case "delta":
      return { type: "delta", text: String(obj["text"] ?? "") };
    case "usage":
      return { type: "usage", uvt: Number(obj["uvt"] ?? 0), cents: Number(obj["cents"] ?? 0) };
    case "done":
      return {
        type: "done",
        uvt: Number(obj["uvt"] ?? 0),
        cents: Number(obj["cents"] ?? 0),
        inputTokens: numOrUndef(obj["input_tokens"] ?? obj["inputTokens"]),
        outputTokens: numOrUndef(obj["output_tokens"] ?? obj["outputTokens"]),
        // Only set when the wire carried it (dev-session done frames) — legacy
        // frames must round-trip byte-identical for the conformance tests.
        ...(obj["ok"] === undefined ? {} : { ok: Boolean(obj["ok"]) }),
        ...(obj["usage_known"] === undefined && obj["usageKnown"] === undefined
          ? {}
          : { usageKnown: Boolean(obj["usage_known"] ?? obj["usageKnown"]) }),
      };
    case "error":
      return {
        type: "error",
        msg: streamErrorMessage(obj),
        errorCode: strOrUndef(obj["error_code"] ?? obj["errorCode"] ?? obj["code"]),
        refId: strOrUndef(obj["ref_id"] ?? obj["refId"]),
      };
    case "session":
      return {
        type: "session",
        sessionId: String(obj["session_id"] ?? obj["sessionId"] ?? ""),
        protocolVersion: Number(obj["protocol_version"] ?? obj["protocolVersion"] ?? 0),
        model: strOrUndef(obj["model"]),
        tools: parseStrArray(obj["tools"]),
      };
    case "notice":
      return {
        type: "notice",
        notice: String(obj["notice"] ?? ""),
        oldestSeq: numOrUndef(obj["oldest_seq"] ?? obj["oldestSeq"]),
      };
    case "tool_call":
      return {
        type: "tool_call",
        toolCallId: String(obj["tool_call_id"] ?? obj["toolCallId"] ?? ""),
        name: String(obj["name"] ?? ""),
        args: (obj["args"] as Record<string, unknown>) ?? {},
        risk: strOrUndef(obj["risk"]),
      };
    case "tool_result_ack":
      return {
        type: "tool_result_ack",
        toolCallId: String(obj["tool_call_id"] ?? obj["toolCallId"] ?? ""),
      };
    case "custody":
      return {
        type: "custody",
        custody: (obj["custody"] as Record<string, unknown>) ?? {},
      };
    case "connected":
      return { type: "connected" };
    case "progress":
      return { type: "progress", text: strOrUndef(obj["text"]) };
    case "task_start":
      return {
        type: "task_start",
        taskId: strOrUndef(obj["task_id"] ?? obj["taskId"]),
        label: strOrUndef(obj["label"]),
      };
    case "task_progress":
      return {
        type: "task_progress",
        taskId: String(obj["task_id"] ?? obj["taskId"] ?? ""),
        delta: strOrUndef(obj["delta"]),
        uvt: numOrUndef(obj["uvt"]),
        cents: numOrUndef(obj["cents"]),
      };
    case "task_done":
      return { type: "task_done", taskId: strOrUndef(obj["task_id"] ?? obj["taskId"]) };
    case "task_failed":
      return {
        type: "task_failed",
        taskId: strOrUndef(obj["task_id"] ?? obj["taskId"]),
        msg: strOrUndef(obj["msg"]),
      };
    case "task_blocked":
      return {
        type: "task_blocked",
        taskId: strOrUndef(obj["task_id"] ?? obj["taskId"]),
        msg: strOrUndef(obj["msg"]),
      };
    case "project_done":
      return { type: "project_done" };
    case "memory": {
      const subtype = String(obj["subtype"] ?? "");
      return {
        type: "memory",
        subtype,
        text: strOrUndef(obj["text"]),
        kind: strOrUndef(obj["kind"]),
        confidence: numOrUndef(obj["confidence"]),
        skill: strOrUndef(obj["skill"]),
        narrative: strOrUndef(obj["narrative"]),
        factCount: numOrUndef(obj["fact_count"] ?? obj["factCount"]),
        beforeTokens: numOrUndef(obj["before_tokens"] ?? obj["beforeTokens"]),
        afterTokens: numOrUndef(obj["after_tokens"] ?? obj["afterTokens"]),
        freedPct: numOrUndef(obj["freed_pct"] ?? obj["freedPct"]),
        dimension: strOrUndef(obj["dimension"]),
        from: numOrUndef(obj["from"]),
        to: numOrUndef(obj["to"]),
        direction: strOrUndef(obj["direction"]),
        skill_name: strOrUndef(obj["skill_name"]),
        description: strOrUndef(obj["description"]),
        triggers: parseStrArray(obj["triggers"]),
        action: strOrUndef(obj["action"]),
        category: strOrUndef(obj["category"]),
      };
    }
    case "workflow_start":
      return {
        type: "workflow_start",
        workflow_id: String(obj["workflow_id"] ?? ""),
        phases: (Array.isArray(obj["phases"]) ? obj["phases"] : []) as Array<{ n: number; type: string; agents: number }>,
        total_agents: Number(obj["total_agents"] ?? 0),
      };
    case "phase_start":
      return {
        type: "phase_start",
        phase_n: Number(obj["phase_n"] ?? 0),
        phase_type: String(obj["phase_type"] ?? ""),
        agent_count: Number(obj["agent_count"] ?? 0),
      };
    case "phase_done":
      return {
        type: "phase_done",
        phase_n: Number(obj["phase_n"] ?? 0),
        artifact_summary: String(obj["artifact_summary"] ?? ""),
      };
    case "agent_spawn":
      return {
        type: "agent_spawn",
        agent_id: String(obj["agent_id"] ?? ""),
        phase_n: Number(obj["phase_n"] ?? 0),
        brief: String(obj["brief"] ?? ""),
      };
    case "agent_progress":
      return {
        type: "agent_progress",
        agent_id: String(obj["agent_id"] ?? ""),
        delta: String(obj["delta"] ?? ""),
      };
    case "agent_done":
      return {
        type: "agent_done",
        agent_id: String(obj["agent_id"] ?? ""),
        phase_n: Number(obj["phase_n"] ?? 0),
        summary: String(obj["summary"] ?? ""),
        tokens: numOrUndef(obj["tokens"]),
        tool_calls: numOrUndef(obj["tool_calls"]),
        duration_ms: numOrUndef(obj["duration_ms"]),
      };
    case "workflow_done":
      return {
        type: "workflow_done",
        synthesis: String(obj["synthesis"] ?? ""),
        total_phases: Number(obj["total_phases"] ?? 0),
        total_agents: Number(obj["total_agents"] ?? 0),
      };
    default:
      return null; // unknown type — ignore per contract
  }
}

/** Parse one raw SSE event block ("data: {...}" possibly multi-line). */
export function parseEvent(raw: string): StreamFrame | null {
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.startsWith(":")) continue; // SSE comment / CF preamble / legacy keepalive
    if (trimmed.startsWith("data:")) {
      dataLines.push(trimmed.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n").trim();
  if (!payload || payload[0] === ":" || payload === "[DONE]") return null;
  try {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    return normalizeFrame(obj);
  } catch {
    return null; // partial / malformed — drop without throwing
  }
}

/** Decode a byte stream of SSE into a sequence of typed frames. */
export async function* decodeSse(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<StreamFrame> {
  const td = new TextDecoder();
  let buf = "";
  let pendingBytes = 0;
  for await (const chunk of stream) {
    pendingBytes += chunk.byteLength;
    // SSE permits CRLF line endings; "\r\n\r\n" contains no "\n\n", so a
    // CRLF server/proxy would buffer the whole response and deliver zero
    // frames. Normalize as we append (a split CRLF at a chunk boundary is
    // caught on the next pass since the lone \r stays in buf).
    buf = (buf + td.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
    let idx: number;
    let consumedEvent = false;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      consumedEvent = true;
      if (Buffer.byteLength(raw, "utf8") > MAX_SSE_EVENT_BYTES) {
        throw new StreamEventTooLargeError(MAX_SSE_EVENT_BYTES);
      }
      const frame = parseEvent(raw);
      if (frame) yield frame;
    }
    // Recompute only after consuming complete events. During delimiter-free
    // dribbles the monotonic byte counter avoids an O(n²) re-encoding attack.
    if (consumedEvent) pendingBytes = Buffer.byteLength(buf, "utf8");
    if (pendingBytes > MAX_SSE_EVENT_BYTES) {
      throw new StreamEventTooLargeError(MAX_SSE_EVENT_BYTES);
    }
  }
  // SSE dispatches an event only after a blank-line delimiter. A connection
  // that closes after `data: {"type":"done"}` has not delivered a terminal
  // frame: accepting that tail would turn a truncated response into success.
  // A trailing comment/whitespace is harmless, but any unfinished data line
  // leaves the turn uncertain (and lets dev-session consumers reconnect).
  buf = (buf + td.decode()).replace(/\r\n/g, "\n");
  if (buf.split("\n").some((line) => line.startsWith("data:"))) {
    throw new StreamIncompleteError();
  }
}

function numOrUndef(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function strOrUndef(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}

const LEGACY_PUBLIC_STREAM_ERRORS = new Set([
  "The media studio agent hit an error.",
  "generation registry did not reach a terminal state",
]);

function streamErrorMessage(obj: Record<string, unknown>): string {
  // Only msg/message are a public message contract. Legacy media frames use
  // fixed public `error` strings, but other `error` values may be provider
  // exception text. Never map the internal `reason` field into a frame.
  for (const key of ["msg", "message"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const legacyError = obj["error"];
  if (typeof legacyError === "string" && LEGACY_PUBLIC_STREAM_ERRORS.has(legacyError)) {
    return legacyError;
  }
  return "";
}
function parseStrArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => String(x));
}
