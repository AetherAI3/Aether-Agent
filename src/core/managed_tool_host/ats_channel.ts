// ObserverChannelReceiptV1 and RuntimeCapabilityV1 (spec sections 4.2 and 5).
// Capability describes runtime support and grants no authority; it is
// accepted only through the ATS-authenticated observer channel, which
// checkCapabilityReceipt (cross.ts) binds.

import { digestFor, omit } from "./digest.js";
import {
  bool, bytes32, clock, constant, constantList, digest, envelope, fieldOf, fresh, id, lifetime, matchDigest, oneOf,
  printableAscii, timestamp,
} from "./primitives.js";
import {
  EXECUTION_MODES, MAX_CAPABILITY_LIFETIME_MS, MAX_RECEIPT_LIFETIME_MS, OBSERVER_RECEIPT_FIELDS, OBSERVER_RECEIPT_SCHEMA,
  RUNTIME_CAPABILITY_FIELDS, RUNTIME_CAPABILITY_SCHEMA, WORKSPACE_STATUS_OPERATION, type ExecutionMode,
} from "./vocabulary.js";

export interface ObserverReceiptV1 {
  readonly schema: typeof OBSERVER_RECEIPT_SCHEMA;
  readonly receipt_id: string;
  readonly channel_id: string;
  readonly runtime_id: string;
  readonly runtime_version: string;
  readonly runtime_build_digest: string;
  readonly challenge: string;
  readonly capability_digest: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly authentication: "ats_mcp_private_credential";
  readonly receipt_digest: string;
}

export interface RuntimeCapabilityV1 {
  readonly schema: typeof RUNTIME_CAPABILITY_SCHEMA;
  readonly runtime_id: string;
  readonly runtime_version: string;
  readonly runtime_build_digest: string;
  readonly attestation_kind: "ats_observer_channel_v1";
  readonly attestation_ref: string;
  readonly supported_read_operations: readonly string[];
  readonly effective_execution_mode: ExecutionMode;
  readonly supports_paper_execution: boolean;
  readonly supports_live_execution: false;
  readonly observed_at: string;
  readonly expires_at: string;
  readonly grants_execution_authority: false;
  readonly capability_digest: string;
}

const RL = "Observer receipt";
const CL = "Runtime capability";

export function validateObserverReceipt(value: unknown, now: number): ObserverReceiptV1 {
  clock(now);
  const raw = envelope(value, RL, OBSERVER_RECEIPT_SCHEMA, OBSERVER_RECEIPT_FIELDS);
  const f = fieldOf(raw, `${RL} `);
  const receipt: ObserverReceiptV1 = {
    schema: raw["schema"] as typeof OBSERVER_RECEIPT_SCHEMA,
    receipt_id: f("receipt_id", id),
    channel_id: f("channel_id", id),
    runtime_id: f("runtime_id", id),
    runtime_version: f("runtime_version", printableAscii),
    runtime_build_digest: f("runtime_build_digest", digest),
    challenge: f("challenge", bytes32),
    capability_digest: f("capability_digest", digest),
    issued_at: f("issued_at", timestamp),
    expires_at: f("expires_at", timestamp),
    authentication: f("authentication", constant("ats_mcp_private_credential" as const)),
    receipt_digest: f("receipt_digest", digest),
  };
  lifetime(RL, receipt.issued_at, "issued_at", receipt.expires_at, MAX_RECEIPT_LIFETIME_MS, "60 seconds");
  matchDigest(RL, "receipt_digest", receipt.receipt_digest, digestFor(OBSERVER_RECEIPT_SCHEMA, omit(receipt, ["receipt_digest"])));
  fresh(RL, receipt.issued_at, "issued_at", receipt.expires_at, now);
  return Object.freeze(receipt);
}

export function validateRuntimeCapability(value: unknown, now: number): RuntimeCapabilityV1 {
  clock(now);
  const raw = envelope(value, CL, RUNTIME_CAPABILITY_SCHEMA, RUNTIME_CAPABILITY_FIELDS);
  const f = fieldOf(raw, `${CL} `);
  const capability: RuntimeCapabilityV1 = {
    schema: raw["schema"] as typeof RUNTIME_CAPABILITY_SCHEMA,
    runtime_id: f("runtime_id", id),
    runtime_version: f("runtime_version", printableAscii),
    runtime_build_digest: f("runtime_build_digest", digest),
    attestation_kind: f("attestation_kind", constant("ats_observer_channel_v1" as const)),
    attestation_ref: f("attestation_ref", id),
    supported_read_operations: f("supported_read_operations", constantList([WORKSPACE_STATUS_OPERATION])),
    effective_execution_mode: f("effective_execution_mode", oneOf(EXECUTION_MODES)),
    supports_paper_execution: f("supports_paper_execution", bool),
    supports_live_execution: f("supports_live_execution", constant(false as const)),
    observed_at: f("observed_at", timestamp),
    expires_at: f("expires_at", timestamp),
    grants_execution_authority: f("grants_execution_authority", constant(false as const)),
    capability_digest: f("capability_digest", digest),
  };
  lifetime(CL, capability.observed_at, "observed_at", capability.expires_at, MAX_CAPABILITY_LIFETIME_MS, "60 seconds");
  matchDigest(CL, "capability_digest", capability.capability_digest, digestFor(RUNTIME_CAPABILITY_SCHEMA, omit(capability, ["capability_digest"])));
  fresh(CL, capability.observed_at, "observed_at", capability.expires_at, now);
  return Object.freeze(capability);
}
