// EnrolledDeviceProofV1 and HostOpenProofV1 (spec section 4.1).
//
// proof_digest omits proof_digest and cloud_signature; the Cloud signature
// omits only cloud_signature and therefore binds proof_digest. The host-open
// device_signature covers aether.managed-tool-host-open/1, LF, then RFC 8785
// of the seven signed fields: a different prefix from the proof's own schema.

import { fail } from "./errors.js";
import { digestFor, ed25519Key, ed25519Verify, omit, preimage } from "./digest.js";
import {
  bytes32, bytes64, clock, decodeBase64url, deviceId, digest, envelope, fieldOf, fresh, httpsOrigin, id, lifetime,
  matchDigest, positive53, timestamp, uint53, type Raw,
} from "./primitives.js";
import { verifyCloudSignature, type TrustDocumentV1 } from "./trust.js";
import {
  DEVICE_PROOF_FIELDS, DEVICE_PROOF_SCHEMA, HOST_OPEN_PROOF_FIELDS, HOST_OPEN_PROOF_SCHEMA, HOST_OPEN_SIGNED_FIELDS,
  HOST_OPEN_SIGNING_SCHEMA, MAX_DEVICE_PROOF_LIFETIME_MS,
} from "./vocabulary.js";

export interface DeviceProofV1 {
  readonly schema: typeof DEVICE_PROOF_SCHEMA;
  readonly cloud_origin_id: string;
  readonly account_scope_digest: string;
  readonly device_id: string;
  readonly device_public_key: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly revocation_epoch: number;
  readonly signature_key_id: string;
  readonly proof_digest: string;
  readonly cloud_signature: string;
}

export interface HostOpenProofV1 {
  readonly schema: typeof HOST_OPEN_PROOF_SCHEMA;
  readonly challenge: string;
  readonly device_proof_digest: string;
  readonly agent_id: string;
  readonly conversation_id: string;
  readonly local_session_id: string;
  readonly session_generation: number;
  readonly registry_digest: string;
  readonly device_signature: string;
}

const DL = "Device proof";
const HL = "Host-open proof";

export function validateDeviceProof(value: unknown, trust: TrustDocumentV1, now: number): DeviceProofV1 {
  clock(now);
  const raw = envelope(value, DL, DEVICE_PROOF_SCHEMA, DEVICE_PROOF_FIELDS);
  const f = fieldOf(raw, `${DL} `);
  const proof: DeviceProofV1 = {
    schema: raw["schema"] as typeof DEVICE_PROOF_SCHEMA,
    cloud_origin_id: f("cloud_origin_id", httpsOrigin),
    account_scope_digest: f("account_scope_digest", digest),
    device_id: f("device_id", deviceId),
    device_public_key: f("device_public_key", ed25519Key),
    issued_at: f("issued_at", timestamp),
    expires_at: f("expires_at", timestamp),
    revocation_epoch: f("revocation_epoch", uint53),
    signature_key_id: f("signature_key_id", id),
    proof_digest: f("proof_digest", digest),
    cloud_signature: f("cloud_signature", bytes64),
  };
  lifetime(DL, proof.issued_at, "issued_at", proof.expires_at, MAX_DEVICE_PROOF_LIFETIME_MS, "30 days");
  matchDigest(DL, "proof_digest", proof.proof_digest, digestFor(DEVICE_PROOF_SCHEMA, omit(proof, ["proof_digest", "cloud_signature"])));
  verifyCloudSignature(DL, DEVICE_PROOF_SCHEMA, proof as unknown as Raw, trust, now);
  fresh(DL, proof.issued_at, "issued_at", proof.expires_at, now);
  return Object.freeze(proof);
}

/** The exact bytes device_signature signs. */
export function hostOpenPreimage(proof: Raw): Buffer {
  return preimage(HOST_OPEN_SIGNING_SCHEMA, Object.fromEntries(HOST_OPEN_SIGNED_FIELDS.map((field) => [field, proof[field]])));
}

/** Proof of possession of the enrolled key named by `deviceProof` (already validated). */
export function validateHostOpenProof(value: unknown, deviceProof: DeviceProofV1): HostOpenProofV1 {
  const raw = envelope(value, HL, HOST_OPEN_PROOF_SCHEMA, HOST_OPEN_PROOF_FIELDS);
  const f = fieldOf(raw, `${HL} `);
  const proof: HostOpenProofV1 = {
    schema: raw["schema"] as typeof HOST_OPEN_PROOF_SCHEMA,
    challenge: f("challenge", bytes32),
    device_proof_digest: f("device_proof_digest", digest),
    agent_id: f("agent_id", id),
    conversation_id: f("conversation_id", id),
    local_session_id: f("local_session_id", id),
    session_generation: f("session_generation", positive53),
    registry_digest: f("registry_digest", digest),
    device_signature: f("device_signature", bytes64),
  };
  if (proof.device_proof_digest !== deviceProof.proof_digest) fail(`${HL} device_proof_digest does not match the device proof.`);
  const verified = ed25519Verify(
    decodeBase64url(deviceProof.device_public_key), hostOpenPreimage(proof as unknown as Raw), decodeBase64url(proof.device_signature),
  );
  if (!verified) fail(`${HL} device_signature does not verify.`);
  return Object.freeze(proof);
}
