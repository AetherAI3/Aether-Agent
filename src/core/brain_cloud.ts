// CloudBrain — the cloud transport. Surfaces the Aether API through the SAME
// BrainEvent vocabulary the local brain emits, so the host renders cloud and
// local runs identically.
//
// Primary path (dev-session protocol): POST /agent/dev/sessions creates a
// server-side coding session; GET .../stream delivers seq-numbered frames
// (tool_call included); the host executes locally and sendToolResult() POSTs
// the result back (idempotent server-side). control() maps pause/resume/steer
// onto POST .../control. This is the real bidirectional round-trip: the API is
// the brain, this machine is the authority — code stays local.
//
// Fallback path (legacy one-way chat stream): when the server has no dev
// route (404) or the feature is off (403), CloudBrain degrades to the
// pre-existing /agent/chat/stream behavior, where sendToolResult/control are
// documented no-ops because the server runs its tools server-side.
//
// That downgrade is NEVER silent. It moves execution off this machine, so it
// always emits a `routing_drift` event first (rendered as a ROUTING_DRIFT
// line, carried structurally under --json), and a run that needs local
// authority (`aether agent`, or an explicit --model) refuses to take it at all
// rather than hand the user a transcript that changed nothing on disk.

import type { Brain, BrainControlResult, TaskCommand } from "./brain.js";
import { EventQueue } from "./brain.js";
import type { BrainEvent, RoutingDriftFrame } from "./brain_protocol.js";
import { TOOLS } from "./brain_protocol.js";
import type { ToolResult } from "./tool_executor.js";
import type { ApiClient } from "./transport.js";
import {
  CHAT_STREAM_PATH,
  CHAT_PATH,
  DEV_SESSIONS_PATH,
  devSessionStreamPath,
  devSessionToolResultsPath,
  devSessionControlPath,
  devSessionPath,
  defaultStreamTimeoutMs,
  sanitizeServerText,
} from "./transport.js";
import { buildChatRequest, buildDevSessionRequest } from "./envelope.js";
import { decodeSse, type StreamFrame } from "./stream.js";
import { HttpError, StreamIncompleteError, StreamUnavailableError } from "./errors.js";
import { appendCustody } from "./custody.js";
import { hintFor } from "./error_hints.js";
import { fallbackCapabilities, type ResolvedCapabilities } from "./capabilities.js";

/** Version of the dev-session wire protocol this client speaks. */
export const DEV_PROTOCOL_VERSION = 1;

/** Reconnect budget for a dropped dev-session stream (resets on progress). */
const MAX_RECONNECTS = 3;
const RECONNECT_DELAY_MS = 1_000;

interface DevSessionCreated {
  session_id: string;
  protocol_version: number;
  model?: string;
  tools?: string[];
}

/**
 * The dev-session protocol versions this build can decode, read from the
 * active capability contract (`dev_session_protocol_versions`) and falling back
 * to the single version the client declares on the wire.
 *
 * The contract has always carried this list; nothing read it. Sourcing the
 * accepted set from the resolved contract is what makes the handshake real: a
 * client shipped with a newer contract accepts the versions that contract
 * names, without another release of this file.
 */
export function devProtocolVersions(contract?: Record<string, unknown>): number[] {
  const raw = (contract ?? fallbackCapabilities().contract)["dev_session_protocol_versions"];
  const versions = Array.isArray(raw)
    ? raw
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
        .map((v) => Math.trunc(v))
    : [];
  return versions.length ? [...new Set(versions)] : [DEV_PROTOCOL_VERSION];
}

/**
 * Validate the create response before a single byte of the stream is read.
 * Returns null when the session is usable, or the message to fail the run with.
 *
 * Two distinct holes, both reachable from a 200:
 *
 *  - No `session_id`. Nothing checked it, so `undefined` flowed straight into
 *    the path builders and the client issued requests against
 *    `/agent/dev/sessions/undefined/stream`.
 *  - A `protocol_version` this build does not speak. The client declares its
 *    version on create and the server echoes one back; the answer was never
 *    read. When the server ships a version with any changed frame shape, the
 *    tolerant `??` / `Number()` mapping in stream.ts turns fields this build no
 *    longer finds into zeros and empty strings rather than errors — a silently
 *    mis-decoded session instead of a refused one.
 *
 * This deliberately does NOT route into the legacy 404/403 downgrade: a
 * version mismatch is not "this server has no dev route", and quietly dropping
 * to the one-way chat stream would convert a loud, fixable incompatibility into
 * an unexplained loss of the local tool round-trip.
 */
export function checkDevSession(created: unknown, speaks: readonly number[]): string | null {
  const record = (created ?? {}) as Partial<DevSessionCreated>;
  const spoken = speaks.length ? speaks : [DEV_PROTOCOL_VERSION];
  const id = record.session_id;
  if (typeof id !== "string" || id.trim() === "") {
    return "cloud dev session was created without a session_id — refusing to open a stream against an unnamed session";
  }
  const version = record.protocol_version;
  const list = spoken.map((v) => "v" + String(v)).join(", ");
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return (
      "cloud dev session did not declare a protocol_version; this build speaks " +
      list +
      " and will not attach to an unversioned session — upgrade the agent (npm i -g aether-agents@latest)"
    );
  }
  if (!spoken.includes(Math.trunc(version))) {
    return (
      "cloud dev session speaks protocol v" +
      String(version) +
      " but this build speaks " +
      list +
      " — upgrade the agent (npm i -g aether-agents@latest)"
    );
  }
  return null;
}

/** What a legacy downgrade actually costs the user, in plain words. */
const DRIFT_CONSEQUENCE =
  "tools run on the server, not in this checkout; no files here will change";
/** The one line the operator (or the user) can act on. */
const DRIFT_REMEDIATION =
  "the server has agent dev sessions disabled; ask the operator to set AETHER_AGENT_DEV_ENABLED=1, or run `aether agent --local`";

/**
 * The server's own explanation for the refusal, made safe to print.
 *
 * toHttpError() already folds `detail` into the Error message through
 * sanitizeServerText, but the raw body is still attached and is the better
 * source for a structured field (it carries the detail alone, without the
 * "HTTP 403: " prefix). Either way it goes back through the SAME shared
 * sanitizer — server-controlled text never reaches a terminal or a JSON line
 * carrying C0/C1 escapes.
 */
export function refusalReason(err: unknown): string {
  const body = err instanceof HttpError ? err.body : undefined;
  if (body && typeof body === "object") {
    for (const k of ["detail", "message", "reason", "error"]) {
      const v = (body as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) return sanitizeServerText(v);
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return sanitizeServerText(msg);
}

/**
 * Build the drift event for a refused dev-session create.
 *
 * Exported so the decision — what the user is told, and whether the run may
 * continue — is assertable without a socket.
 */
export function routingDrift(status: number, reason: string, failClosed: boolean): RoutingDriftFrame {
  return {
    type: "routing_drift",
    kind: "routing_drift",
    requested: "dev_session",
    // Honest about which of the two things happened. A fail-closed run never
    // reached the chat stream, so reporting "chat_stream" would be the same
    // class of lie this whole event exists to stop.
    resolved: failClosed ? "refused" : "chat_stream",
    status,
    reason,
    consequence: DRIFT_CONSEQUENCE,
    remediation: DRIFT_REMEDIATION,
    fatal: failClosed,
  };
}

export interface CloudBrainOptions {
  /**
   * Refuse the legacy downgrade instead of taking it.
   *
   * Set by any caller whose run needs LOCAL authority — `aether agent` is a
   * coding session over THIS checkout, and the one-way chat stream runs its
   * tools server-side against the cloud vault. Degrading such a run produces a
   * plausible-looking transcript that changed nothing on disk, which is worse
   * than a refusal. Left false by default so existing callers (and library
   * embedders) keep the old fail-soft behavior.
   */
  requireLocalAuthority?: boolean;
  /** Advertise only tools the local host is prepared to authorize. */
  localToolCapabilities?: readonly string[];
  /** Per-session hosted spend ceiling. Required by the headless cloud driver. */
  maxUvt?: number;
}

export class CloudBrain implements Brain {
  private aborted = false;
  private net: AbortController | null = null;
  private sessionId: string | null = null;
  private controlState: BrainControlResult["state"] = "closed";
  private lastSeq = 0;
  /** Serializes upstream result POSTs so they arrive in execution order. */
  private upstream: Promise<void> = Promise.resolve();
  /** Dev-session protocol versions this build will attach to. */
  private readonly speaks: number[];

  /**
   * `capabilities` is optional so existing call sites are unchanged; without it
   * the packaged contract snapshot supplies the accepted version set. A caller
   * that has already resolved the server contract should pass it, so a server
   * that legitimately advertises a newer dev protocol is honored rather than
   * refused on stale packaged data.
   */
  constructor(
    private readonly api: ApiClient,
    capabilities?: ResolvedCapabilities,
    private readonly opts: CloudBrainOptions = {},
  ) {
    this.speaks = devProtocolVersions(capabilities?.contract);
  }

  run(task: TaskCommand): AsyncIterable<BrainEvent> {
    const queue = new EventQueue();
    void this.pump(task, queue);
    return queue.drain();
  }

  private async pump(task: TaskCommand, queue: EventQueue): Promise<void> {
    try {
      let created: DevSessionCreated | null = null;
      try {
        created = await this.api.postJson<DevSessionCreated>(
          DEV_SESSIONS_PATH,
          buildDevSessionRequest({
            task: task.text,
            model: task.model,
            effort: task.effort,
            capabilities: this.opts.localToolCapabilities ?? TOOLS,
            maxUvt: this.opts.maxUvt,
            protocolVersion: DEV_PROTOCOL_VERSION,
          }),
        );
      } catch (err) {
        if (isLegacyServer(err)) {
          // The transport is about to change under the user. Say so BEFORE a
          // byte of model output — an explanation printed after the answer is
          // an explanation nobody reads, and one printed in colour alone is no
          // explanation at all (see host_render's ROUTING_DRIFT line).
          const status = (err as HttpError).status;
          // Fail closed when the run needs local authority: the caller asked
          // for it (`aether agent`), or the user pinned a model by hand, which
          // is an explicit contract about WHAT runs — and the legacy envelope's
          // model_pick_source:"manual" is a request, not a guarantee.
          const failClosed = Boolean(this.opts.requireLocalAuthority) || Boolean(task.model);
          queue.push(routingDrift(status, refusalReason(err), failClosed));
          if (failClosed) {
            // Deliberately NOT a chat-stream request: nothing about this run
            // may reach a transport that executes tools somewhere else.
            queue.push({
              type: "done",
              ok: false,
              result: "refused: " + DRIFT_REMEDIATION,
              remaining: 0,
              reason: "routing-drift",
            });
            return;
          }
          await this.legacyPump(task, queue);
          return;
        }
        throw err;
      }
      // Deliberately outside the catch above: a malformed or version-mismatched
      // create is NOT a legacy server, and must not degrade to the one-way chat
      // stream. Fail the run loudly instead.
      const refusal = checkDevSession(created, this.speaks);
      if (refusal) throw new Error(refusal);
      this.sessionId = created.session_id;
      if (task.model && created.model !== task.model) {
        try { await this.api.deleteJson(devSessionPath(created.session_id)); } catch { /* refusal remains authoritative */ }
        this.sessionId = null;
        throw new Error("cloud dev session did not preserve the explicitly requested model");
      }
      this.controlState = "running";
      queue.push({ type: "stage", name: "execute", face: "⟨◉⟩" }); // uplink face
      await this.devPump(queue);
    } catch (err) {
      const message = withHint(err);
      queue.push({ type: "error", msg: message });
      // A failed session create has no downstream terminal frame to relay.
      // The host must still see an explicit failed terminal, especially after
      // a pre-stream 401, rather than inferring success from a closed iterator.
      queue.push({ type: "done", ok: false, result: message, remaining: 0, reason: "transport-error" });
    } finally {
      this.controlState = "closed";
      queue.end();
    }
  }

  /** Consume the dev-session stream, reconnecting from lastSeq on a drop. */
  private async devPump(queue: EventQueue): Promise<void> {
    const id = this.sessionId as string;
    let failed: string | null = null;
    let sawDone = false;
    let doneOk = true;
    let reconnects = 0;

    while (!this.aborted && !sawDone && !failed) {
      this.net = new AbortController();
      let progressed = false;
      try {
        const stream = await this.api.stream(devSessionStreamPath(id, this.lastSeq), undefined, {
          method: "GET",
          signal: this.net.signal,
        });
        for await (const frame of decodeSse(stream)) {
          if (this.aborted) break;
          if (frame.type === "notice" && frame.notice === "replay_truncated") {
            failed = "cloud dev session replay was truncated; refusing to execute across a sequence gap";
            break;
          }
          // Duplicate delivery is safe by contract: a replayed frame keeps its
          // seq, so anything at or below the high-water mark is skipped. Every
          // non-liveness frame must otherwise be the next positive safe integer;
          // malformed or missing sequence data must never reach the host tool
          // executor.
          if (frame.type !== "open" && frame.type !== "ping") {
            if (!Number.isSafeInteger(frame.seq) || (frame.seq as number) <= 0) {
              failed = "cloud dev session returned a frame with an invalid sequence";
              break;
            }
            const seq = frame.seq as number;
            if (seq <= this.lastSeq) continue;
            if (seq !== this.lastSeq + 1) {
              failed = `cloud dev session sequence gap: expected ${this.lastSeq + 1}, received ${seq}`;
              break;
            }
            this.lastSeq = seq;
            progressed = true;
            reconnects = 0;
          }
          if (frame.type === "custody") appendCustody(frame.custody);
          if (frame.type === "error") failed = frame.msg;
          if (frame.type === "done") {
            sawDone = true;
            doneOk = frame.ok !== false;
          }
          const ev = mapDevFrame(frame);
          if (ev) queue.push(ev);
          if (sawDone || failed) break;
        }
      } catch (err) {
        if (this.aborted) break;
        if (reconnects >= MAX_RECONNECTS) {
          failed = withHint(err);
          break;
        }
        reconnects += 1;
        await sleep(RECONNECT_DELAY_MS * reconnects);
        continue;
      }
      if (this.aborted || sawDone || failed) break;
      // Stream ended cleanly without a terminal frame — reconnect from seq
      // unless the budget is spent (a quiet server keeps its socket open, so
      // a clean early end is either a proxy hiccup or a dead session).
      if (reconnects >= MAX_RECONNECTS && !progressed) {
        failed = withHint(new StreamIncompleteError());
        break;
      }
      reconnects += 1;
      await sleep(RECONNECT_DELAY_MS * reconnects);
    }

    if (failed) {
      queue.push({ type: "done", ok: false, result: failed, remaining: 0, reason: "" });
    } else if (this.aborted) {
      queue.push({ type: "done", ok: false, result: "aborted", remaining: 0, reason: "" });
    } else {
      queue.push({ type: "done", ok: doneOk, result: "", remaining: 0, reason: "" });
    }
  }

  /** The pre-dev-protocol one-way chat stream (older/flagged-off servers). */
  private async legacyPump(task: TaskCommand, queue: EventQueue): Promise<void> {
    const req = buildChatRequest({
      prompt: task.text,
      model: task.model || undefined,
      manualModel: Boolean(task.model),
    });
    queue.push({ type: "stage", name: "execute", face: "⟨◉⟩" });
    try {
      this.net = new AbortController();
      const stream = await this.api.stream(CHAT_STREAM_PATH, req, { signal: this.net.signal });
      // The terminal done must be ground truth, never fabricated success
      // (CONTRACTS.md invariant 5): a streamed error, a user abort, or a
      // clean-looking premature close all end the run ok:false. Custody
      // receipts persist here too — the client-held log is the only copy.
      let failed: string | null = null;
      let sawDone = false;
      for await (const frame of decodeSse(stream)) {
        if (this.aborted) break;
        if (frame.type === "custody") appendCustody(frame.custody);
        if (frame.type === "error") failed = frame.msg;
        if (frame.type === "done") sawDone = true;
        const ev = mapLegacyFrame(frame);
        if (ev) queue.push(ev);
      }
      if (failed) {
        queue.push({ type: "done", ok: false, result: failed, remaining: 0, reason: "" });
      } else if (this.aborted) {
        queue.push({ type: "done", ok: false, result: "aborted", remaining: 0, reason: "" });
      } else if (!sawDone) {
        queue.push({ type: "done", ok: false, result: withHint(new StreamIncompleteError()), remaining: 0, reason: "" });
      } else {
        queue.push({ type: "done", ok: true, result: "", remaining: 0, reason: "" });
      }
    } catch (err) {
      if (err instanceof StreamUnavailableError) {
        // Fail-soft: non-streaming fallback (contract `{"stream": false}`). A
        // full LLM turn can legitimately run long, so this opts into
        // stream()'s own generous bound rather than request()'s 30s default.
        try {
          const r = await this.api.postJson<{ response?: string }>(CHAT_PATH, req, undefined, defaultStreamTimeoutMs());
          queue.push({ type: "monologue", text: r.response ?? "", depth: 0 });
          queue.push({ type: "done", ok: true, result: r.response ?? "", remaining: 0, reason: "" });
        } catch (e2) {
          queue.push({ type: "error", msg: withHint(e2) });
        }
      } else {
        queue.push({ type: "error", msg: withHint(err) });
      }
    }
  }

  /** POST a locally executed tool result upstream. Serialized so results land
   *  in execution order; retried once (the server accepts duplicates as
   *  idempotent no-ops, so a lost ack can never double-apply). */
  sendToolResult(id: string, result: ToolResult): void {
    const sessionId = this.sessionId;
    if (!sessionId) return; // legacy path: server ran the tool itself
    const body = {
      tool_call_id: id,
      status: result.exitCode === 0 ? "ok" : "error",
      exit_code: result.exitCode,
      output: result.output,
      truncated: false,
    };
    this.upstream = this.upstream.then(async () => {
      const path = devSessionToolResultsPath(sessionId);
      try {
        await this.api.postJson(path, body);
      } catch {
        if (this.aborted) return;
        await sleep(RECONNECT_DELAY_MS);
        try {
          await this.api.postJson(path, body);
        } catch {
          // Deliberately swallowed: the server's tool-result timeout will
          // terminate the session with a clear error frame; throwing here
          // would only crash the host loop mid-render.
        }
      }
    });
  }

  async control(action: "pause" | "resume" | "steer", note?: string): Promise<BrainControlResult> {
    const sessionId = this.sessionId;
    if (!sessionId || this.controlState === "closed") {
      return { accepted: false, state: "closed", error: "cloud dev session is not running" };
    }
    try {
      const response = await this.api.postJson<{ ok?: unknown; state?: unknown }>(
        devSessionControlPath(sessionId),
        { action, note: note ?? null },
      );
      const state = response.state;
      const validState = state === "running" || state === "paused";
      const expectedState = action === "pause" ? "paused" : action === "resume" ? "running" : this.controlState;
      if (response.ok !== true || !validState || state !== expectedState) {
        return {
          accepted: false,
          state: this.controlState,
          error: "cloud dev session returned an invalid control acknowledgement",
        };
      }
      this.controlState = state;
      return { accepted: true, state };
    } catch (error) {
      return {
        accepted: false,
        state: this.controlState,
        error: sanitizeServerText(withHint(error)),
      };
    }
  }

  close(): void {
    this.aborted = true;
    this.controlState = "closed";
    this.net?.abort();
    const sessionId = this.sessionId;
    if (sessionId) {
      void this.api.deleteJson(devSessionPath(sessionId)).catch(() => {});
    }
  }
}

/** Error message plus its recovery hint (if any). */
function withHint(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const hint = hintFor(err);
  return hint ? `${msg} (${hint})` : msg;
}

/** An older/flagged-off server: no dev-session route. 404 = route absent,
 *  403 = AETHER_AGENT_DEV_ENABLED off — both degrade to the legacy stream. */
function isLegacyServer(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 404 || err.status === 403);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Map a dev-session frame onto the bridge event vocabulary (null = ignore). */
function mapDevFrame(f: StreamFrame): BrainEvent | null {
  switch (f.type) {
    case "session":
      return { type: "status", phase: `session ${f.model ?? ""}`.trim(), poolUsed: 0, poolCap: 0 };
    case "tool_call":
      return { type: "tool_call", id: f.toolCallId, name: f.name, args: f.args };
    case "reasoning":
      return { type: "monologue", text: f.text, depth: 1 };
    case "delta":
      return { type: "monologue", text: f.text, depth: 0 };
    case "error":
      return { type: "error", msg: f.msg };
    case "done":
      return null; // devPump emits its own terminal done
    default:
      return null; // open/ping/usage/tool_result_ack/custody — not agent view
  }
}

/** Map a legacy universal SSE frame onto the bridge vocabulary (null = ignore). */
function mapLegacyFrame(f: StreamFrame): BrainEvent | null {
  switch (f.type) {
    case "reasoning":
      return { type: "monologue", text: f.text, depth: 1 };
    case "delta":
      return { type: "monologue", text: f.text, depth: 0 };
    case "task_start":
      return { type: "stage", name: f.label ?? "task", face: "(ง'̀-'́)ง" };
    case "task_done":
      return { type: "checkpoint", gitSha: f.taskId ?? "" };
    case "task_failed":
      return { type: "error", msg: f.msg ?? "task failed" };
    case "error":
      return { type: "error", msg: f.msg };
    case "done":
      return null; // the pump emits its own terminal done after the loop
    case "memory": {
      const { type: _, ...rest } = f;
      return { type: "memory", ...rest };
    }
    case "workflow_start":
      return {
        type: "workflow_start",
        workflowId: f.workflow_id,
        phases: f.phases,
        totalAgents: f.total_agents,
      };
    case "phase_start":
      return {
        type: "phase_start",
        phaseN: f.phase_n,
        phaseType: f.phase_type,
        agentCount: f.agent_count,
      };
    case "phase_done":
      return {
        type: "phase_done",
        phaseN: f.phase_n,
        artifactSummary: f.artifact_summary,
      };
    case "agent_spawn":
      return {
        type: "agent_spawn",
        agentId: f.agent_id,
        phaseN: f.phase_n,
        brief: f.brief,
      };
    case "agent_progress":
      return {
        type: "agent_progress",
        agentId: f.agent_id,
        delta: f.delta,
      };
    case "agent_done":
      return {
        type: "agent_done",
        agentId: f.agent_id,
        phaseN: f.phase_n,
        summary: f.summary,
        tokens: f.tokens,
        toolCalls: f.tool_calls,
        durationMs: f.duration_ms,
      };
    case "workflow_done":
      return {
        type: "workflow_done",
        synthesis: f.synthesis,
        totalPhases: f.total_phases,
        totalAgents: f.total_agents,
      };
    default:
      return null; // open/ping/usage/custody/etc. — not part of the agent view
  }
}
