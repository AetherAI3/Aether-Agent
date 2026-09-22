// Account-owned agents use Cloud's registry and the same DM as Aether Online.
// This client never opens a coding brain, mints credentials or grants tools.
import { randomUUID } from "node:crypto";
import type { ApiClient } from "./transport.js";
import { HttpError } from "./errors.js";

export const MANAGED_AGENTS_PATH = "/agent/managed";
export const MANAGED_AGENT_ID = /^mag_[0-9a-f]{16}$/;

export interface BrowserObserveGrantV1 {
  enabled: boolean;
  max_observations_per_run: number;
  max_text_chars: number;
  max_png_bytes: number;
  max_capture_age_seconds: number;
}

export interface ManagedAgentProfileV1 {
  schema_version: "aether.managed-agent.profile/1";
  kind: "ats";
  browser_observe?: BrowserObserveGrantV1 | null;
}

export interface ManagedAgentConfig {
  profile?: ManagedAgentProfileV1 | null;
  identity: { display_name: string; purpose?: string; avatar_id?: string };
  behavior?: { system_prompt?: string; tone?: string; response_length?: string; output_format?: string };
  model_policy?: { routing: string; models: string[]; fallback?: string };
  project_ids?: string[];
  budget?: { total_uvt?: number; per_run_uvt?: number; daily_uvt?: number; max_concurrency?: number };
  [key: string]: unknown;
}

export interface ManagedAgent {
  agent_id: string;
  revision: number;
  lifecycle_intent: string;
  config: ManagedAgentConfig;
  runtime: { observation: string; tile_state: string; reason?: string | null; remedy?: string | null };
}

export interface AgentMessage {
  id: string;
  body: string;
  sender_type?: string;
  sender_agent_id?: string | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface MessageAdmission {
  state: string;
  reason?: string | null;
  run_id?: string | null;
}

export interface SentAgentMessage extends AgentMessage {
  admission?: MessageAdmission;
  [key: string]: unknown;
}

function agentPath(id: string): string {
  if (!MANAGED_AGENT_ID.test(id)) throw new Error("Use a managed agent ID from `aether agent list` (mag_ plus 16 hex characters).");
  return `${MANAGED_AGENTS_PATH}/${id}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Cloud returned an invalid managed-agent response.");
  return value as Record<string, unknown>;
}

function browserObserveGrant(value: unknown): value is BrowserObserveGrantV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  const fields = ["enabled", "max_observations_per_run", "max_text_chars", "max_png_bytes", "max_capture_age_seconds"];
  const boundedInteger = (field: string, minimum: number, maximum: number): boolean =>
    Number.isSafeInteger(grant[field]) && Number(grant[field]) >= minimum && Number(grant[field]) <= maximum;
  return Object.keys(grant).length === fields.length && fields.every(field => Object.hasOwn(grant, field))
    && typeof grant["enabled"] === "boolean"
    && boundedInteger("max_observations_per_run", 1, 8)
    && boundedInteger("max_text_chars", 1, 65_536)
    && boundedInteger("max_png_bytes", 1_024, 4_194_304)
    && boundedInteger("max_capture_age_seconds", 1, 60);
}

function readAgent(value: unknown): ManagedAgent {
  const a = record(value);
  const config = record(a["config"]);
  const identity = record(config["identity"]);
  const runtime = record(a["runtime"]);
  if (typeof a["agent_id"] !== "string" || !MANAGED_AGENT_ID.test(a["agent_id"]) ||
      !Number.isSafeInteger(a["revision"]) || Number(a["revision"]) < 1 ||
      typeof a["lifecycle_intent"] !== "string" || typeof identity["display_name"] !== "string" ||
      typeof runtime["observation"] !== "string" || typeof runtime["tile_state"] !== "string") {
    throw new Error("Cloud returned an invalid managed-agent record.");
  }
  if (config["profile"] != null) {
    const profile = record(config["profile"]);
    const supportedFields = ["schema_version", "kind", "browser_observe"];
    if (profile["schema_version"] !== "aether.managed-agent.profile/1" || profile["kind"] !== "ats"
        || Object.keys(profile).some(key => !supportedFields.includes(key))
        || (profile["browser_observe"] != null && !browserObserveGrant(profile["browser_observe"]))) {
      throw new Error("Cloud returned an unsupported managed-agent profile. Update the terminal before opening local tools.");
    }
  }
  return value as ManagedAgent;
}

function envelope(value: unknown): Record<string, unknown> {
  const e = record(value);
  if (!["aether.managed-agents/1", "aether.managed-agents/1.1"].includes(String(e["schema_version"])) || e["availability"] !== "ok") {
    throw new Error("Managed agents are unavailable on this server. Check your account's Agents page and try again.");
  }
  return e;
}

export class ManagedAgentsClient {
  constructor(private readonly api: ApiClient) {}

  /** Never cache this account identity: credentials can rotate or change accounts. */
  async identity(signal?: AbortSignal): Promise<string> {
    const value = record(await this.api.getJson<unknown>(`${MANAGED_AGENTS_PATH}/identity`, signal));
    if (value["schema_version"] !== "aether.terminal-account/1" || typeof value["account_subject"] !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value["account_subject"])) {
      throw new Error("Cloud returned an invalid canonical account identity. Update Cloud terminal compatibility before local setup.");
    }
    return value["account_subject"];
  }

  async list(signal?: AbortSignal): Promise<ManagedAgent[]> {
    const agents: ManagedAgent[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const path = `${MANAGED_AGENTS_PATH}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const e = envelope(await this.api.getJson<unknown>(path, signal));
      if (!Array.isArray(e["agents"])) throw new Error("Cloud returned an invalid agent inventory.");
      agents.push(...e["agents"].map(readAgent));
      const next = e["next_cursor"];
      if (next != null && typeof next !== "string") throw new Error("Cloud returned an invalid inventory cursor.");
      cursor = next || undefined;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error("Agent inventory changed during sync. Refresh the list.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return agents;
  }

  async get(id: string, signal?: AbortSignal): Promise<ManagedAgent> {
    const agent = readAgent(envelope(await this.api.getJson<unknown>(agentPath(id), signal))["agent"]);
    if (agent.agent_id !== id) throw new Error("Cloud returned a different agent than requested.");
    return agent;
  }

  async create(config: ManagedAgentConfig, key: string = randomUUID(), signal?: AbortSignal): Promise<ManagedAgent> {
    const e = await this.api.postIdempotentJson<unknown>(MANAGED_AGENTS_PATH, { config }, key, signal);
    return readAgent(envelope(e)["agent"]);
  }

  async configure(agent: ManagedAgent, config: ManagedAgentConfig, signal?: AbortSignal): Promise<ManagedAgent> {
    const e = await this.api.patchJson<unknown>(agentPath(agent.agent_id), {
      expected_revision: agent.revision, config,
    }, signal);
    return readAgent(envelope(e)["agent"]);
  }

  async control(agent: ManagedAgent, action: "activate" | "pause" | "resume" | "retire", signal?: AbortSignal): Promise<ManagedAgent> {
    const e = await this.api.postJson<unknown>(`${agentPath(agent.agent_id)}/control`, {
      action, expected_revision: agent.revision,
    }, signal);
    return readAgent(envelope(e)["agent"]);
  }

  async thread(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return record(await this.api.postJson<unknown>(`${agentPath(id)}/thread`, {}, signal));
  }

  async messages(id: string, conversationId: string, signal?: AbortSignal): Promise<AgentMessage[]> {
    const e = record(await this.api.getJson<unknown>(`${agentPath(id)}/messages?conversation_id=${encodeURIComponent(conversationId)}&limit=100`, signal));
    if (!Array.isArray(e["messages"])) throw new Error("Cloud returned an invalid conversation.");
    return e["messages"].map((value) => {
      const m = record(value);
      if (typeof m["id"] !== "string" || typeof m["body"] !== "string") throw new Error("Cloud returned an invalid message.");
      return value as AgentMessage;
    });
  }

  async send(id: string, conversationId: string, body: string, clientNonce: string = randomUUID(), signal?: AbortSignal): Promise<SentAgentMessage> {
    if (!body.trim() || body.length > 10_000) throw new Error("Messages must contain between 1 and 10,000 characters.");
    const receipt = record(await this.api.postJson<unknown>(`${agentPath(id)}/messages?conversation_id=${encodeURIComponent(conversationId)}`, {
      body, client_nonce: clientNonce,
    }, signal));
    if (typeof receipt["id"] !== "string" || typeof receipt["body"] !== "string") throw new Error("Cloud did not confirm a saved message.");
    if (receipt["admission"] !== undefined) {
      const admission = record(receipt["admission"]);
      if (typeof admission["state"] !== "string") throw new Error("Cloud returned an invalid message admission.");
    }
    return receipt as SentAgentMessage;
  }
}

/** Stable, actionable errors without printing response bodies that may contain secrets. */
export function managedAgentError(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 401) return "Sign in again with `aether auth login`, then retry.";
    if (error.status === 403) return "Managed agents or agent DMs are not enabled for this account, or this token is not a CLI token. Check the Agents page and `aether auth login`.";
    if (error.status === 404) return "Agent not found or this server has not deployed terminal agents yet. Refresh `aether agent list`.";
    if (error.status === 409) return "This agent changed elsewhere. Refresh it and reapply your edit; no automatic overwrite was attempted.";
    if (error.status === 503) return "The agent service is unavailable. Check the account before retrying a change.";
    return `Cloud refused the request (HTTP ${error.status}). Check the agent settings on the web.`;
  }
  return error instanceof Error ? error.message : "Could not reach the agent service.";
}
