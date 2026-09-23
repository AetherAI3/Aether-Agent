// Cross-object checks (brief clarification 12), deliberately separate from
// the single-object validators: each takes already validated objects and
// throws ToolHostContractError on the first mismatch. Tools are looked up by
// the invocation's (name, version), the call the host actually accepted.

import { fail } from "./errors.js";
import { canonicalBytes } from "./digest.js";
import type { DeviceProofV1 } from "./device.js";
import type { ObserverReceiptV1, RuntimeCapabilityV1 } from "./ats_channel.js";
import type { ToolCancellationV1, ToolInvocationV1 } from "./invocation.js";
import type { HostSessionLeaseV1 } from "./lease.js";
import { clock, epochMs } from "./primitives.js";
import type { ToolEntryV1, ToolRegistryManifestV1 } from "./registry.js";
import type { ToolResultV1 } from "./result.js";
import type { TrustDocumentV1 } from "./trust.js";
import { validateWorkspaceStatus, validateWorkspaceStatusInput } from "./workspace_status.js";
import {
  CLOCK_SKEW_MS, E1_TOOL_DEPENDENCIES, E1_TOOL_NAME, E1_TOOL_VERSION, WORKSPACE_STATUS_INPUT_SCHEMA,
  WORKSPACE_STATUS_INPUT_SCHEMA_DIGEST, WORKSPACE_STATUS_SCHEMA, WORKSPACE_STATUS_SCHEMA_DIGEST,
} from "./vocabulary.js";

function same(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) fail(message);
}

function toolFor(invocation: ToolInvocationV1, registry: ToolRegistryManifestV1, message: string): ToolEntryV1 {
  const tool = registry.tools.find((entry) => entry.name === invocation.tool_name && entry.version === invocation.tool_version);
  if (!tool) fail(message);
  return tool;
}

const UNLISTED_INVOCATION = "Invocation names a tool the registry does not list.";
const UNLISTED_RESULT = "Result names a tool the registry does not list.";

/** A lease routes to exactly its registry's scope and device, and never outlives registry, device proof or keys. */
export function checkLeaseBinding(lease: HostSessionLeaseV1, registry: ToolRegistryManifestV1, deviceProof: DeviceProofV1, trust: TrustDocumentV1): void {
  for (const field of ["account_scope_digest", "agent_id", "device_id", "local_session_id", "session_generation"] as const) {
    same(lease[field], registry[field], `Host lease ${field} does not match the registry.`);
  }
  same(lease.registry_digest, registry.registry_digest, "Host lease registry_digest does not match the registry.");
  for (const field of ["cloud_origin_id", "account_scope_digest", "device_id"] as const) {
    same(lease[field], deviceProof[field], `Host lease ${field} does not match the device proof.`);
  }
  const expires = epochMs(lease.expires_at);
  if (expires > epochMs(registry.expires_at)) fail("Host lease outlives the registry.");
  if (expires > epochMs(deviceProof.expires_at)) fail("Host lease outlives the device proof.");
  if (expires > epochMs(trust.expires_at)) fail("Host lease outlives the trust document.");
}

const INVOCATION_SCOPE = [
  "lease_id", "host_session_id", "session_generation", "revocation_epoch", "cloud_origin_id", "account_scope_digest",
  "agent_id", "device_id", "local_session_id", "conversation_id",
] as const;

/** Scope, tool selection, argument schema identity and size, and deadline, before the host claims the call. */
export function checkInvocation(invocation: ToolInvocationV1, lease: HostSessionLeaseV1, registry: ToolRegistryManifestV1, now: number): void {
  clock(now);
  for (const field of INVOCATION_SCOPE) same(invocation[field], lease[field], `Invocation ${field} does not match the host lease.`);
  same(lease.registry_digest, registry.registry_digest, "Host lease registry_digest does not match the registry.");
  const tool = toolFor(invocation, registry, UNLISTED_INVOCATION);
  same(invocation.input_schema_id, tool.input_schema_id, "Invocation input_schema_id does not match the registered tool.");
  same(invocation.input_schema_digest, tool.input_schema_digest, "Invocation input_schema_digest does not match the registered tool.");
  if (canonicalBytes(invocation.arguments) > tool.max_argument_bytes) fail("Invocation arguments exceed the registered max_argument_bytes.");
  const deadline = epochMs(invocation.deadline_at);
  if (deadline > epochMs(lease.expires_at)) fail("Invocation deadline_at is later than the host lease expiry.");
  if (deadline - epochMs(invocation.issued_at) > tool.max_duration_ms) fail("Invocation deadline_at exceeds the registered max_duration_ms.");
  if (now >= deadline + CLOCK_SKEW_MS) fail("Invocation deadline has passed.");
}

/** Arguments against the exact registered input schema; only the frozen E1 schema has a validator. */
export function checkToolArguments(invocation: ToolInvocationV1, registry: ToolRegistryManifestV1): void {
  const tool = toolFor(invocation, registry, UNLISTED_INVOCATION);
  if (tool.input_schema_id !== WORKSPACE_STATUS_INPUT_SCHEMA || tool.input_schema_digest !== WORKSPACE_STATUS_INPUT_SCHEMA_DIGEST) {
    fail("No argument validator is registered for the tool input schema.");
  }
  validateWorkspaceStatusInput(invocation.arguments);
}

/** A cancellation names exactly one call and is fenced by the lease generation and window. */
export function checkCancellation(cancellation: ToolCancellationV1, invocation: ToolInvocationV1, lease: HostSessionLeaseV1): void {
  same(cancellation.cloud_tool_call_id, invocation.cloud_tool_call_id, "Cancellation cloud_tool_call_id does not match the invocation.");
  same(cancellation.invocation_digest, invocation.invocation_digest, "Cancellation invocation_digest does not match the invocation.");
  for (const field of ["lease_id", "host_session_id", "session_generation", "revocation_epoch"] as const) {
    same(cancellation[field], lease[field], `Cancellation ${field} does not match the host lease.`);
  }
  const issued = epochMs(cancellation.issued_at);
  if (issued < epochMs(lease.issued_at) - CLOCK_SKEW_MS || issued >= epochMs(lease.expires_at) + CLOCK_SKEW_MS) {
    fail("Cancellation issued_at is outside the host lease window.");
  }
}

const RESULT_IDENTITY = [
  "request_id", "cloud_tool_call_id", "lease_id", "host_session_id", "local_session_id", "session_generation",
  "revocation_epoch", "run_id", "tool_name", "tool_version", "input_schema_id", "input_schema_digest",
  "invocation_digest", "arguments_digest",
] as const;

/** A result answers exactly its invocation, under the registered output identity and size bound. */
export function checkResult(result: ToolResultV1, invocation: ToolInvocationV1, registry: ToolRegistryManifestV1, now: number): void {
  clock(now);
  for (const field of RESULT_IDENTITY) same(result[field], invocation[field], `Result ${field} does not match the invocation.`);
  const tool = toolFor(invocation, registry, UNLISTED_RESULT);
  if (result.state === "succeeded") {
    same(result.output_schema_id, tool.output_schema_id, "Result output_schema_id does not match the registered tool.");
    same(result.output_schema_digest, tool.output_schema_digest, "Result output_schema_digest does not match the registered tool.");
  }
  if (result.bounded_bytes > tool.max_result_bytes) fail("Result bounded_bytes exceeds the registered max_result_bytes.");
  if (epochMs(result.started_at) < epochMs(invocation.issued_at) - CLOCK_SKEW_MS) fail("Result started_at is earlier than the invocation issued_at.");
  if (epochMs(result.completed_at) > now + CLOCK_SKEW_MS) fail("Result completed_at is in the future.");
}

/** A succeeded payload against the exact registered output schema, bound to the invocation's scope. */
export function checkToolPayload(result: ToolResultV1, invocation: ToolInvocationV1, registry: ToolRegistryManifestV1): void {
  if (result.state !== "succeeded") return;
  const tool = toolFor(invocation, registry, UNLISTED_RESULT);
  if (tool.output_schema_id !== WORKSPACE_STATUS_SCHEMA || tool.output_schema_digest !== WORKSPACE_STATUS_SCHEMA_DIGEST) {
    fail("No payload validator is registered for the tool output schema.");
  }
  validateWorkspaceStatus(result.payload, {
    account_scope_digest: invocation.account_scope_digest,
    agent_id: invocation.agent_id,
    device_id: invocation.device_id,
    local_session_id: invocation.local_session_id,
    session_generation: invocation.session_generation,
  });
}

/** The E1 canary manifest: exactly ats_workspace_status version 1 with the frozen section 11 schemas. */
export function assertE1CanaryRegistry(registry: ToolRegistryManifestV1): void {
  if (registry.tools.length !== 1) fail("E1 canary registry must list exactly one tool.");
  const tool = registry.tools[0] as ToolEntryV1;
  if (tool.name !== E1_TOOL_NAME) fail("E1 canary tool must be ats_workspace_status.");
  if (tool.version !== E1_TOOL_VERSION) fail("E1 canary tool version must be 1.");
  if (tool.input_schema_id !== WORKSPACE_STATUS_INPUT_SCHEMA) fail("E1 canary tool input_schema_id must be aether.ats.workspace-status-input/1.");
  if (tool.input_schema_digest !== WORKSPACE_STATUS_INPUT_SCHEMA_DIGEST) fail("E1 canary tool input_schema_digest must match the frozen schema.");
  if (tool.output_schema_id !== WORKSPACE_STATUS_SCHEMA) fail("E1 canary tool output_schema_id must be aether.ats.workspace-status/1.");
  if (tool.output_schema_digest !== WORKSPACE_STATUS_SCHEMA_DIGEST) fail("E1 canary tool output_schema_digest must match the frozen schema.");
  const dependencies = tool.dependencies;
  if (dependencies.length !== E1_TOOL_DEPENDENCIES.length || !E1_TOOL_DEPENDENCIES.every((entry, i) => dependencies[i] === entry)) {
    fail("E1 canary tool dependencies must be ats_profile, foreground_session, verified_account.");
  }
}

export interface CapabilityExpectation {
  /** The 43-character challenge the Agent sent over the observer channel. */
  readonly challenge: string;
  /** The runtime_build_digest of the ATS build the Agent loaded. */
  readonly runtime_build_digest: string;
}

/** Capability is accepted only as attested by this receipt, for this challenge and the loaded build. */
export function checkCapabilityReceipt(capability: RuntimeCapabilityV1, receipt: ObserverReceiptV1, expected: CapabilityExpectation): void {
  same(capability.attestation_ref, receipt.receipt_id, "Runtime capability attestation_ref does not match the observer receipt.");
  same(capability.capability_digest, receipt.capability_digest, "Runtime capability capability_digest does not match the observer receipt.");
  for (const field of ["runtime_id", "runtime_version", "runtime_build_digest"] as const) {
    same(capability[field], receipt[field], `Runtime capability ${field} does not match the observer receipt.`);
  }
  same(receipt.challenge, expected.challenge, "Observer receipt challenge does not match the challenge sent.");
  same(capability.runtime_build_digest, expected.runtime_build_digest, "Runtime capability runtime_build_digest does not match the loaded build.");
}
