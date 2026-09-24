// Digests, named derivations and Ed25519 for the managed tool host contract.
//
// Common digest rule: sha256 over the ASCII schema ID, one LF byte, then the
// RFC 8785 bytes of the object with its own digest or signature field(s)
// omitted. RFC 8785 comes from ../ats_contracts/canonical.js, never a second
// encoder. Signatures are pure RFC 8032 Ed25519 (no prehash) over the same
// preimage with only the signature field omitted.

import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson } from "../ats_contracts/canonical.js";
import { fail } from "./errors.js";
import {
  boundedText, bytes32, closed, decodeBase64url, deviceId, digest, httpsOrigin, id, jsonValue, object, positive53, type Check,
} from "./primitives.js";
import {
  ACCOUNT_SCOPE_SCHEMA, ARGUMENTS_SCHEMA, MAX_ARGUMENT_DEPTH, SCHEMA_DIGEST_SCHEMA, WORKSPACE_BINDING_FIELDS,
  WORKSPACE_BINDING_SCHEMA,
} from "./vocabulary.js";

const LF = String.fromCharCode(10);

/** The bytes a digest or signature covers: ASCII schema ID, LF, then RFC 8785 of `value`. */
export function preimage(schema: string, value: unknown): Buffer {
  return Buffer.from(schema + LF + canonicalJson(value), "utf8");
}

export function digestFor(schema: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(preimage(schema, value)).digest("hex")}`;
}

export function omit(record: object, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !fields.includes(key)));
}

export function canonicalBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

/** Canonical size, or null when the value has no RFC 8785 form (the shape checks then name the fault). */
export function canonicalBytesIfEncodable(value: unknown): number | null {
  try {
    return canonicalBytes(value);
  } catch {
    return null;
  }
}

export interface WorkspaceStatusBinding {
  readonly account_scope_digest: string;
  readonly agent_id: string;
  readonly device_id: string;
  readonly local_session_id: string;
  readonly session_generation: number;
}

/** binding_digest of spec section 11 over an already validated binding. */
export function bindingDigestOf(binding: WorkspaceStatusBinding): string {
  return digestFor(WORKSPACE_BINDING_SCHEMA, Object.fromEntries(WORKSPACE_BINDING_FIELDS.map((field) => [field, binding[field]])));
}

export function workspaceBindingDigest(binding: unknown): string {
  const L = "Workspace binding";
  const raw = closed(binding, L, WORKSPACE_BINDING_FIELDS);
  return bindingDigestOf({
    account_scope_digest: digest(raw["account_scope_digest"], `${L} account_scope_digest`),
    agent_id: id(raw["agent_id"], `${L} agent_id`),
    device_id: deviceId(raw["device_id"], `${L} device_id`),
    local_session_id: id(raw["local_session_id"], `${L} local_session_id`),
    session_generation: positive53(raw["session_generation"], `${L} session_generation`),
  });
}

/** account_scope_digest (spec section 4). The raw subject is used only for this local derivation. */
export function accountScopeDigest(cloudOriginId: unknown, accountSubject: unknown): string {
  const origin = httpsOrigin(cloudOriginId, "Account scope cloud_origin_id");
  const subject = boundedText(accountSubject, "Account scope account_subject");
  return digestFor(ACCOUNT_SCOPE_SCHEMA, { cloud_origin_id: origin, account_subject: subject });
}

export function argumentsDigest(value: unknown): string {
  return digestFor(ARGUMENTS_SCHEMA, jsonValue(value, "Arguments", MAX_ARGUMENT_DEPTH));
}

/** A schema document's digest covers the whole document, $schema, $id and x-aether-schema-id included. */
export function schemaDigest(document: unknown): string {
  return digestFor(SCHEMA_DIGEST_SCHEMA, object(document, "Schema document"));
}

/** libsodium's small-order blocklist: every torsion point by y, plus y = p and y = p + 1. */
const SMALL_ORDER = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
].map((hex) => Buffer.from(hex, "hex"));

/** A 32-byte encoding that is non-canonical (y >= p = 2^255 - 19) or blocklisted, both judged with the sign bit masked. */
function isWeakKey(key: Uint8Array): boolean {
  if (key.length !== 32) return false;
  const y = Buffer.from(key);
  y[31] = (y[31] ?? 0) & 0x7f;
  // y >= p exactly when byte 31 is 0x7f, bytes 1 to 30 are 0xff and byte 0 is at least 0xed.
  if (y[31] === 0x7f && (y[0] ?? 0) >= 0xed && y.subarray(1, 31).every((byte) => byte === 0xff)) return true;
  return SMALL_ORDER.some((entry) => entry.equals(y));
}

/** A trust or device key: 43 base64url characters naming a canonical point that is not small-order. */
export const ed25519Key: Check<string> = (value, path) => {
  const encoded = bytes32(value, path);
  if (isWeakKey(decodeBase64url(encoded))) fail(`${path} is not a valid Ed25519 public key.`);
  return encoded;
};

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Pure RFC 8032 Ed25519 (OpenSSL): cofactorless, S below the group order, and
 * a key that is canonical and not small-order. Any malformed input verifies false.
 */
export function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64 || isWeakKey(publicKey)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, publicKey]), format: "der", type: "spki" });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

function seedKey(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) fail("An Ed25519 seed must be 32 bytes.");
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
}

export function ed25519Sign(seed: Uint8Array, message: Uint8Array): Uint8Array {
  return new Uint8Array(sign(null, message, seedKey(seed)));
}

export function ed25519PublicKey(seed: Uint8Array): Uint8Array {
  const spki = createPublicKey(seedKey(seed)).export({ format: "der", type: "spki" });
  return new Uint8Array(spki.subarray(spki.length - 32));
}
