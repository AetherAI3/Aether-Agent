// ToolInvocationV1 and ToolCancellationV1 (spec sections 8 and 9). Both are
// authenticated by the bound Cloud host transport, not by an object
// signature. Scope, registry, argument-size and deadline rules that need the
// lease or registry are checkInvocation and checkCancellation (cross.ts).

import { fail } from "./errors.js";
import { canonicalBytes, digestFor, omit } from "./digest.js";
import {
  bytes32, deviceId, digest, envelope, epochMs, fieldOf, httpsOrigin, id, jsonValue, matchDigest, oneOf, positive53,
  schemaId, timestamp, toolName, toolVersion, uint53, type Json,
} from "./primitives.js";
import {
  ARGUMENTS_SCHEMA, CANCELLATION_FIELDS, CANCELLATION_REASONS, CANCELLATION_SCHEMA, INVOCATION_FIELDS, INVOCATION_SCHEMA,
  MAX_ARGUMENT_BYTES, MAX_ARGUMENT_DEPTH,
} from "./vocabulary.js";

export interface ToolInvocationV1 {
  readonly schema: typeof INVOCATION_SCHEMA;
  readonly request_id: string;
  readonly cloud_tool_call_id: string;
  readonly lease_id: string;
  readonly host_session_id: string;
  readonly session_generation: number;
  readonly revocation_epoch: number;
  readonly cloud_origin_id: string;
  readonly account_scope_digest: string;
  readonly agent_id: string;
  readonly device_id: string;
  readonly local_session_id: string;
  readonly conversation_id: string;
  readonly run_id: string;
  readonly sequence: number;
  readonly tool_name: string;
  readonly tool_version: number;
  readonly input_schema_id: string;
  readonly input_schema_digest: string;
  readonly arguments: Json;
  readonly arguments_digest: string;
  readonly issued_at: string;
  readonly deadline_at: string;
  readonly nonce: string;
  readonly invocation_digest: string;
}

export interface ToolCancellationV1 {
  readonly schema: typeof CANCELLATION_SCHEMA;
  readonly cancellation_id: string;
  readonly cloud_tool_call_id: string;
  readonly invocation_digest: string;
  readonly lease_id: string;
  readonly host_session_id: string;
  readonly session_generation: number;
  readonly revocation_epoch: number;
  readonly reason: (typeof CANCELLATION_REASONS)[number];
  readonly issued_at: string;
  readonly cancellation_digest: string;
}

const IL = "Invocation";
const CL = "Cancellation";

export function validateInvocation(value: unknown): ToolInvocationV1 {
  const raw = envelope(value, IL, INVOCATION_SCHEMA, INVOCATION_FIELDS);
  const f = fieldOf(raw, `${IL} `);
  const invocation: ToolInvocationV1 = {
    schema: raw["schema"] as typeof INVOCATION_SCHEMA,
    request_id: f("request_id", id),
    cloud_tool_call_id: f("cloud_tool_call_id", id),
    lease_id: f("lease_id", id),
    host_session_id: f("host_session_id", id),
    session_generation: f("session_generation", positive53),
    revocation_epoch: f("revocation_epoch", uint53),
    cloud_origin_id: f("cloud_origin_id", httpsOrigin),
    account_scope_digest: f("account_scope_digest", digest),
    agent_id: f("agent_id", id),
    device_id: f("device_id", deviceId),
    local_session_id: f("local_session_id", id),
    conversation_id: f("conversation_id", id),
    run_id: f("run_id", id),
    sequence: f("sequence", positive53),
    tool_name: f("tool_name", toolName),
    tool_version: f("tool_version", toolVersion),
    input_schema_id: f("input_schema_id", schemaId),
    input_schema_digest: f("input_schema_digest", digest),
    arguments: f("arguments", (args, path) => jsonValue(args, path, MAX_ARGUMENT_DEPTH)),
    arguments_digest: f("arguments_digest", digest),
    issued_at: f("issued_at", timestamp),
    deadline_at: f("deadline_at", timestamp),
    nonce: f("nonce", bytes32),
    invocation_digest: f("invocation_digest", digest),
  };
  if (canonicalBytes(invocation.arguments) > MAX_ARGUMENT_BYTES) fail(`${IL} arguments exceed 65536 canonical bytes.`);
  if (epochMs(invocation.deadline_at) <= epochMs(invocation.issued_at)) fail(`${IL} deadline_at must be later than issued_at.`);
  if (invocation.arguments_digest !== digestFor(ARGUMENTS_SCHEMA, invocation.arguments)) fail(`${IL} arguments_digest does not match arguments.`);
  matchDigest(IL, "invocation_digest", invocation.invocation_digest, digestFor(INVOCATION_SCHEMA, omit(invocation, ["invocation_digest"])));
  return Object.freeze(invocation);
}

export function validateCancellation(value: unknown): ToolCancellationV1 {
  const raw = envelope(value, CL, CANCELLATION_SCHEMA, CANCELLATION_FIELDS);
  const f = fieldOf(raw, `${CL} `);
  const cancellation: ToolCancellationV1 = {
    schema: raw["schema"] as typeof CANCELLATION_SCHEMA,
    cancellation_id: f("cancellation_id", id),
    cloud_tool_call_id: f("cloud_tool_call_id", id),
    invocation_digest: f("invocation_digest", digest),
    lease_id: f("lease_id", id),
    host_session_id: f("host_session_id", id),
    session_generation: f("session_generation", positive53),
    revocation_epoch: f("revocation_epoch", uint53),
    reason: f("reason", oneOf(CANCELLATION_REASONS)),
    issued_at: f("issued_at", timestamp),
    cancellation_digest: f("cancellation_digest", digest),
  };
  matchDigest(CL, "cancellation_digest", cancellation.cancellation_digest, digestFor(CANCELLATION_SCHEMA, omit(cancellation, ["cancellation_digest"])));
  return Object.freeze(cancellation);
}
