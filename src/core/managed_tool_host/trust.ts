// ManagedToolTrustV1 (spec section 4.1): the Cloud verification keys served
// at /.well-known/aether-managed-tool-host-v1.json, usable only until
// expires_at. The document itself carries no digest.

import { fail } from "./errors.js";
import { ed25519Verify, omit, preimage } from "./digest.js";
import {
  array, bytes32, clock, closed, compareCodePoints, constant, decodeBase64url, envelope, fieldOf, fresh, id, items,
  lifetime, strictlyAscending, timestamp, type Raw,
} from "./primitives.js";
import { MAX_TRUST_KEYS, MAX_TRUST_LIFETIME_MS, TRUST_FIELDS, TRUST_KEY_FIELDS, TRUST_SCHEMA } from "./vocabulary.js";

export interface TrustKeyV1 {
  readonly key_id: string;
  readonly algorithm: "Ed25519";
  readonly public_key: string;
}

export interface TrustDocumentV1 {
  readonly schema: typeof TRUST_SCHEMA;
  readonly generated_at: string;
  readonly expires_at: string;
  readonly keys: readonly TrustKeyV1[];
}

const L = "Trust document";

function trustKey(value: unknown, path: string): TrustKeyV1 {
  const f = fieldOf(closed(value, path, TRUST_KEY_FIELDS), `${path}.`);
  return Object.freeze({
    key_id: f("key_id", id),
    algorithm: f("algorithm", constant("Ed25519" as const)),
    public_key: f("public_key", bytes32),
  });
}

export function validateTrustDocument(value: unknown, now: number): TrustDocumentV1 {
  clock(now);
  const raw = envelope(value, L, TRUST_SCHEMA, TRUST_FIELDS);
  const f = fieldOf(raw, `${L} `);
  const trust: TrustDocumentV1 = {
    schema: raw["schema"] as typeof TRUST_SCHEMA,
    generated_at: f("generated_at", timestamp),
    expires_at: f("expires_at", timestamp),
    keys: f("keys", (keys, path) => items(array(keys, path, 1, MAX_TRUST_KEYS), path, trustKey)),
  };
  strictlyAscending(trust.keys, (key) => key.key_id, (a, b) => compareCodePoints(a.key_id, b.key_id),
    `${L} keys must not repeat a key_id.`, `${L} keys must be in ascending key_id order.`);
  lifetime(L, trust.generated_at, "generated_at", trust.expires_at, MAX_TRUST_LIFETIME_MS, "24 hours");
  fresh(L, trust.generated_at, "generated_at", trust.expires_at, now);
  return Object.freeze(trust);
}

/**
 * Verify a Cloud-signed object: signature_key_id must name a trusted key, and
 * cloud_signature must verify over the schema ID, LF, then RFC 8785 of the
 * object without cloud_signature.
 */
export function verifyCloudSignature(label: string, schema: string, signed: Raw, trust: TrustDocumentV1): void {
  const key = trust.keys.find((entry) => entry.key_id === signed["signature_key_id"]);
  if (!key) fail(`${label} signature_key_id names no trusted key.`);
  const message = preimage(schema, omit(signed, ["cloud_signature"]));
  if (!ed25519Verify(decodeBase64url(key.public_key), message, decodeBase64url(String(signed["cloud_signature"])))) {
    fail(`${label} cloud_signature does not verify.`);
  }
}
