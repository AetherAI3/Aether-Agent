// HostSessionLeaseV1 (spec section 7): short-lived routing to one foreground
// host; not a trading credential. Cloud-signed over the schema ID, LF, then
// RFC 8785 of the lease without cloud_signature. Its binding to the registry,
// device proof and trust document is checkLeaseBinding (cross.ts).

import {
  bytes64, clock, constant, constantList, deviceId, digest, envelope, fieldOf, fresh, httpsOrigin, id, lifetime,
  positive53, range, timestamp, uint53, type Raw,
} from "./primitives.js";
import { verifyCloudSignature, type TrustDocumentV1 } from "./trust.js";
import { HOST_LEASE_FIELDS, HOST_LEASE_SCHEMA, LEASE_CAPABILITIES, MAX_CALLS, MAX_LEASE_LIFETIME_MS } from "./vocabulary.js";

export interface HostSessionLeaseV1 {
  readonly schema: typeof HOST_LEASE_SCHEMA;
  readonly lease_id: string;
  readonly host_session_id: string;
  readonly cloud_origin_id: string;
  readonly account_scope_digest: string;
  readonly agent_id: string;
  readonly device_id: string;
  readonly local_session_id: string;
  readonly session_generation: number;
  readonly revocation_epoch: number;
  readonly conversation_id: string;
  readonly registry_digest: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly max_calls: number;
  readonly capabilities: readonly string[];
  readonly grants_execution_authority: false;
  readonly signature_key_id: string;
  readonly cloud_signature: string;
}

const L = "Host lease";

export function validateHostLease(value: unknown, trust: TrustDocumentV1, now: number): HostSessionLeaseV1 {
  clock(now);
  const raw = envelope(value, L, HOST_LEASE_SCHEMA, HOST_LEASE_FIELDS);
  const f = fieldOf(raw, `${L} `);
  const lease: HostSessionLeaseV1 = {
    schema: raw["schema"] as typeof HOST_LEASE_SCHEMA,
    lease_id: f("lease_id", id),
    host_session_id: f("host_session_id", id),
    cloud_origin_id: f("cloud_origin_id", httpsOrigin),
    account_scope_digest: f("account_scope_digest", digest),
    agent_id: f("agent_id", id),
    device_id: f("device_id", deviceId),
    local_session_id: f("local_session_id", id),
    session_generation: f("session_generation", positive53),
    revocation_epoch: f("revocation_epoch", uint53),
    conversation_id: f("conversation_id", id),
    registry_digest: f("registry_digest", digest),
    issued_at: f("issued_at", timestamp),
    expires_at: f("expires_at", timestamp),
    max_calls: f("max_calls", range(1, MAX_CALLS)),
    capabilities: f("capabilities", constantList(LEASE_CAPABILITIES)),
    grants_execution_authority: f("grants_execution_authority", constant(false as const)),
    signature_key_id: f("signature_key_id", id),
    cloud_signature: f("cloud_signature", bytes64),
  };
  lifetime(L, lease.issued_at, "issued_at", lease.expires_at, MAX_LEASE_LIFETIME_MS, "5 minutes");
  verifyCloudSignature(L, HOST_LEASE_SCHEMA, lease as unknown as Raw, trust, now);
  fresh(L, lease.issued_at, "issued_at", lease.expires_at, now);
  return Object.freeze(lease);
}
