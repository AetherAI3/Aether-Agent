// ToolResultV1 (spec section 10): the terminal record of one call. A
// succeeded result carries payload and output schema identity and no error;
// every other state carries an error and none of the three. cancelled and
// deadline_exceeded carry their own error code, which refused never uses. The
// registered output schema, max_result_bytes, deadline and invocation identity
// are checkResult and checkToolPayload (cross.ts).

import { fail } from "./errors.js";
import { canonicalBytes, digestFor, omit } from "./digest.js";
import {
  closed, constant, digest, envelope, epochMs, fieldOf, id, jsonValue, matchDigest, nullable, oneOf, positive53, range,
  safeDisplay, schemaId, stringSet, timestamp, toolName, toolVersion, uint53, type Json,
} from "./primitives.js";
import {
  FAILURE_CODES, MAX_EVIDENCE_REFS, MAX_PAYLOAD_DEPTH, MAX_RESULT_BYTES, REDACTION_PROFILE, REPLAY_STATUSES,
  RESULT_ERROR_FIELDS, RESULT_FIELDS, RESULT_SCHEMA, RESULT_STATES, RETRY_CLASSES, type FailureCode, type ResultState,
} from "./vocabulary.js";

export interface ResultErrorV1 {
  readonly code: FailureCode;
  readonly message: string;
}

export interface ToolResultV1 {
  readonly schema: typeof RESULT_SCHEMA;
  readonly result_id: string;
  readonly request_id: string;
  readonly cloud_tool_call_id: string;
  readonly lease_id: string;
  readonly host_session_id: string;
  readonly local_session_id: string;
  readonly session_generation: number;
  readonly revocation_epoch: number;
  readonly run_id: string;
  readonly tool_name: string;
  readonly tool_version: number;
  readonly input_schema_id: string;
  readonly input_schema_digest: string;
  readonly invocation_digest: string;
  readonly arguments_digest: string;
  readonly state: ResultState;
  readonly payload: Json | null;
  readonly output_schema_id: string | null;
  readonly output_schema_digest: string | null;
  readonly error: ResultErrorV1 | null;
  readonly evidence_refs: readonly string[];
  readonly replay_status: (typeof REPLAY_STATUSES)[number];
  readonly retry_class: (typeof RETRY_CLASSES)[number];
  readonly started_at: string;
  readonly completed_at: string;
  readonly bounded_bytes: number;
  readonly redaction_profile: typeof REDACTION_PROFILE;
  readonly grants_execution_authority: false;
  readonly result_digest: string;
}

const L = "Result";

function resultError(value: unknown, path: string): ResultErrorV1 {
  const f = fieldOf(closed(value, path, RESULT_ERROR_FIELDS), `${path}.`);
  return Object.freeze({ code: f("code", oneOf(FAILURE_CODES)), message: f("message", safeDisplay) });
}

function outputAgreesWithState(result: ToolResultV1): void {
  const succeeded = result.state === "succeeded";
  for (const field of ["payload", "output_schema_id", "output_schema_digest"] as const) {
    if (succeeded && result[field] === null) fail(`${L} ${field} must be non-null when state is succeeded.`);
    if (!succeeded && result[field] !== null) fail(`${L} ${field} must be null unless state is succeeded.`);
  }
  if (succeeded && result.error !== null) fail(`${L} error must be null when state is succeeded.`);
  if (!succeeded && result.error === null) fail(`${L} error must be non-null unless state is succeeded.`);
}

function codeAgreesWithState(result: ToolResultV1): void {
  const code = result.error?.code;
  if (result.state === "cancelled" && code !== "TOOL_CANCELLED") fail(`${L} state cancelled requires error.code TOOL_CANCELLED.`);
  if (result.state === "deadline_exceeded" && code !== "TOOL_DEADLINE_EXCEEDED") {
    fail(`${L} state deadline_exceeded requires error.code TOOL_DEADLINE_EXCEEDED.`);
  }
  if (result.state === "refused" && (code === "TOOL_CANCELLED" || code === "TOOL_DEADLINE_EXCEEDED")) {
    fail(`${L} state refused must not use error.code TOOL_CANCELLED or TOOL_DEADLINE_EXCEEDED.`);
  }
}

function replayAgreesWithRetry(result: ToolResultV1): void {
  if (result.retry_class === "redeliver_stored_result" && result.replay_status !== "stored_redelivery") {
    fail(`${L} retry_class redeliver_stored_result requires replay_status stored_redelivery.`);
  }
  if (result.replay_status === "interrupted_before_result") {
    if (result.state !== "unavailable") fail(`${L} replay_status interrupted_before_result requires state unavailable.`);
    if (result.retry_class !== "new_call_after_recovery") {
      fail(`${L} replay_status interrupted_before_result requires retry_class new_call_after_recovery.`);
    }
  }
  if (result.state === "succeeded" && result.retry_class === "new_call_after_recovery") {
    fail(`${L} state succeeded must not use retry_class new_call_after_recovery.`);
  }
}

export function validateResult(value: unknown): ToolResultV1 {
  const raw = envelope(value, L, RESULT_SCHEMA, RESULT_FIELDS);
  const f = fieldOf(raw, `${L} `);
  const result: ToolResultV1 = {
    schema: raw["schema"] as typeof RESULT_SCHEMA,
    result_id: f("result_id", id),
    request_id: f("request_id", id),
    cloud_tool_call_id: f("cloud_tool_call_id", id),
    lease_id: f("lease_id", id),
    host_session_id: f("host_session_id", id),
    local_session_id: f("local_session_id", id),
    session_generation: f("session_generation", positive53),
    revocation_epoch: f("revocation_epoch", uint53),
    run_id: f("run_id", id),
    tool_name: f("tool_name", toolName),
    tool_version: f("tool_version", toolVersion),
    input_schema_id: f("input_schema_id", schemaId),
    input_schema_digest: f("input_schema_digest", digest),
    invocation_digest: f("invocation_digest", digest),
    arguments_digest: f("arguments_digest", digest),
    state: f("state", oneOf(RESULT_STATES)),
    payload: f("payload", nullable((payload, path) => jsonValue(payload, path, MAX_PAYLOAD_DEPTH))),
    output_schema_id: f("output_schema_id", nullable(schemaId)),
    output_schema_digest: f("output_schema_digest", nullable(digest)),
    error: f("error", nullable(resultError)),
    evidence_refs: f("evidence_refs", stringSet(0, MAX_EVIDENCE_REFS, id)),
    replay_status: f("replay_status", oneOf(REPLAY_STATUSES)),
    retry_class: f("retry_class", oneOf(RETRY_CLASSES)),
    started_at: f("started_at", timestamp),
    completed_at: f("completed_at", timestamp),
    bounded_bytes: f("bounded_bytes", range(0, MAX_RESULT_BYTES)),
    redaction_profile: f("redaction_profile", constant(REDACTION_PROFILE)),
    grants_execution_authority: f("grants_execution_authority", constant(false as const)),
    result_digest: f("result_digest", digest),
  };
  outputAgreesWithState(result);
  codeAgreesWithState(result);
  replayAgreesWithRetry(result);
  if (epochMs(result.completed_at) < epochMs(result.started_at)) fail(`${L} completed_at must not be earlier than started_at.`);
  if (result.bounded_bytes !== (result.payload === null ? 0 : canonicalBytes(result.payload))) {
    fail(`${L} bounded_bytes does not match the payload size.`);
  }
  matchDigest(L, "result_digest", result.result_digest, digestFor(RESULT_SCHEMA, omit(result, ["result_digest"])));
  return Object.freeze(result);
}
