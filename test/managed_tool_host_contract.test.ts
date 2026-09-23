import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, verify as verifySignature } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { canonicalJson } from "../src/core/ats_contracts/canonical.js";
import * as host from "../src/core/managed_tool_host/index.js";
import { base64url, epochMs, httpsOrigin, id, schemaId, text, timestamp } from "../src/core/managed_tool_host/primitives.js";

// Reproduces test/fixtures/managed_tool_host_golden.json, which the independent
// Python mirror (test/fixtures/managed_tool_host_verify.py) also reproduces.
// Digests and signatures are recomputed here with node:crypto and the repo's
// RFC 8785 encoder, never read back from the module under test, and every
// refusal message is compared exactly. See docs/CONTRACTS.md section 5.

const FIXTURE_PATH = "test/fixtures/managed_tool_host_golden.json";
const BUNDLE_DIR = "contracts/managed-ats-tool-host/v1";
const MODULE_DIR = "src/core/managed_tool_host";
const SCHEMA_BASE = "https://schemas.aethersystems.net/managed-ats-tool-host/v1/";
const LF = String.fromCharCode(10);
/** Printable ASCII plus line endings (a Windows checkout may carry CRLF; digests parse the JSON first). */
const printableAscii = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 10 || byte === 13 || (byte >= 32 && byte <= 126));

// Coverage floors are named constants equal to the coverage that exists when
// the fixture was frozen, never counts derived from the lists they guard.
const REJECT_FLOORS: Readonly<Record<string, number>> = {
  trust: 24, device_proof: 35, host_open_proof: 19, observer_receipt: 21, runtime_capability: 24, registry: 49,
  host_lease: 23, invocation: 37, cancellation: 13, result: 51, workspace_status_input: 5, workspace_status: 51,
};
const CROSS_REJECT_FLOORS: Readonly<Record<string, number>> = {
  lease_binding: 12, invocation: 20, tool_arguments: 4, cancellation: 8, result: 20, tool_payload: 5, e1_canary: 9, capability_receipt: 7,
};
const ACCEPT_FLOOR = 39;
const CROSS_ACCEPT_FLOOR = 23;
const RAW_ACCEPT_FLOOR = 12;
const RAW_REJECT_FLOOR = 55;
const PRIMITIVE_FLOOR = 114;
const CANONICAL_FLOOR = 6;

const COMMON_RULES = ["not_object", "schema_absent", "schema_wrong_version", "schema_other_object", "unknown_field", "missing_field"];
/** The brief's required single-cause coverage, per object. */
const REQUIRED_REJECT_RULES: Readonly<Record<string, readonly string[]>> = {
  trust: [...COMMON_RULES, "keys_count_min", "keys_count_max", "keys_duplicate", "keys_order", "key_algorithm", "key_short", "key_long", "key_noncanonical", "lifetime_order", "lifetime_max", "not_yet_valid", "expired"],
  device_proof: [...COMMON_RULES, "device_namespace", "lifetime_max", "proof_digest_includes_signature", "proof_digest_omits_key_id", "signature_other_key", "signature_excludes_digest", "signature_unknown_key", "epoch_negative", "not_yet_valid", "expired"],
  host_open_proof: [...COMMON_RULES, "challenge_42", "challenge_44", "signature_other_key", "signature_proof_schema", "device_proof_digest_other", "generation_zero"],
  observer_receipt: [...COMMON_RULES, "lifetime_max", "authentication_other", "digest_tampered", "challenge_42", "expired"],
  runtime_capability: [...COMMON_RULES, "ops_extra", "ops_empty", "ops_other_version", "live_true", "lifetime_max", "attestation_self", "mode_live", "grants_true", "digest_tampered", "expired"],
  registry: [...COMMON_RULES, "tools_empty", "tools_33", "tools_unsorted", "tools_duplicate", "tool_name_uppercase", "tool_version_zero", "tool_version_65536", "tool_effect_write", "tool_dependency_outside_set", "tool_dependencies_empty", "tool_dependencies_7", "tool_data_class_outside_set", "tool_max_argument_bytes_below", "tool_max_argument_bytes_above", "tool_max_result_bytes_below", "tool_max_result_bytes_above", "tool_max_duration_ms_below", "tool_max_duration_ms_above", "lifetime_max", "grants_true", "tool_grants_true", "digest_tampered"],
  host_lease: [...COMMON_RULES, "caps_extra", "caps_empty", "max_calls_zero", "max_calls_257", "lifetime_max", "grants_true", "signature_other_key", "signature_unknown_key", "expired"],
  invocation: [...COMMON_RULES, "nonce_42", "nonce_44", "sequence_zero", "deadline_equal", "deadline_before", "args_object_depth_9", "args_over_65536_bytes", "args_digest_other", "digest_tampered", "tool_version_zero", "tool_version_65536"],
  cancellation: [...COMMON_RULES, "reason_other", "digest_tampered"],
  result: [...COMMON_RULES, "state_unknown", "replay_unknown", "retry_unknown", "succeeded_payload_null", "refused_payload", "cancelled_payload", "deadline_exceeded_payload", "interrupted_payload", "error_on_success", "error_missing", "retry_redeliver_fresh", "interrupted_not_unavailable", "interrupted_retry_none", "bounded_bytes_off_by_one", "bounded_bytes_over_max", "evidence_17", "evidence_unsorted", "evidence_duplicate", "grants_true", "digest_tampered"],
  workspace_status_input: ["non_empty"],
  workspace_status: [...COMMON_RULES, "oversize", "execution_authority_operator", "orders_enabled_true", "grants_true", "strategies_execution_enabled", "executable_evidence_available", "memory_state", "writer_lease", "strategies_state", "strategies_compiler", "research_configuration", "last_probe", "browser_state", "runtime_state", "runtime_mode", "configured_gib_zero", "configured_gib_16385", "strategies_count_10001", "diagnostics_17", "diagnostic_code_lowercase", "diagnostic_severity_fatal", "binding_digest_other", "status_digest_tampered"],
};
const REQUIRED_CROSS_RULES: Readonly<Record<string, readonly string[]>> = {
  lease_binding: ["registry_agent_id", "registry_session_generation", "registry_digest", "device_proof_cloud_origin_id", "device_proof_device_id", "outlives_registry", "outlives_device_proof", "outlives_trust"],
  invocation: ["lease_session_generation", "lease_revocation_epoch", "lease_agent_id", "registry_not_leased", "unknown_tool_version", "input_schema_id", "input_schema_digest", "arguments_over_registered_bytes", "deadline_after_lease", "deadline_over_max_duration", "deadline_passed"],
  tool_arguments: ["e1_arguments_not_empty", "unregistered_input_schema", "drifted_input_schema_digest"],
  cancellation: ["cloud_tool_call_id", "invocation_digest", "lease_session_generation", "before_lease_window", "after_lease_window"],
  result: ["invocation_invocation_digest", "invocation_arguments_digest", "output_schema_id", "output_schema_digest", "bounded_bytes_over_registered", "started_before_invocation", "completed_in_future"],
  tool_payload: ["binding_other_agent", "payload_orders_enabled", "drifted_output_schema_digest"],
  e1_canary: ["two_tools", "tool_name", "tool_version", "input_schema_id", "input_schema_digest", "output_schema_id", "output_schema_digest", "dependencies_extra", "dependencies_missing"],
  capability_receipt: ["attestation_ref", "capability_digest", "receipt_runtime_build_digest", "challenge", "loaded_build"],
};

type Doc = Record<string, unknown>;
interface Patch {
  readonly path: readonly (string | number)[];
  readonly value?: unknown;
  readonly delete?: true;
  readonly repeat?: { readonly unit: string; readonly count: number };
  readonly grid?: { readonly rows: number; readonly cols: number; readonly unit: string; readonly length: number; readonly pad?: number };
  readonly nest?: { readonly depth: number; readonly kind: "array" | "object"; readonly leaf: unknown };
}
interface Context { readonly trust?: string; readonly device_proof?: string; readonly binding?: Doc }
interface AcceptVector { readonly id: string; readonly kind: string; readonly document: unknown; readonly now?: number; readonly context?: Context; readonly expect: { readonly canonical_sha256: string } }
interface RejectVector { readonly id: string; readonly kind: string; readonly base: string; readonly rule: string; readonly patches: readonly Patch[]; readonly expect: string; readonly now?: number; readonly context?: Context; readonly exception?: string }
interface Expected { readonly challenge: string; readonly runtime_build_digest: string }
interface CrossAccept { readonly id: string; readonly check: string; readonly inputs: Readonly<Record<string, string>>; readonly now: number; readonly expected?: Expected }
interface CrossReject { readonly id: string; readonly check: string; readonly base: string; readonly patches: Readonly<Record<string, readonly Patch[]>>; readonly expect: string; readonly inputs?: Readonly<Record<string, string>>; readonly now?: number; readonly expected?: Expected; readonly exception?: string }
interface Frame { readonly text?: string; readonly base64?: string; readonly generate?: { readonly string_member?: number; readonly nest?: number; readonly kind?: string } }
interface Fixture {
  readonly schema: string;
  readonly canonical_profile: string;
  readonly clock_skew_ms: number;
  readonly keys: readonly { readonly label: string; readonly note: string; readonly seed_hex: string; readonly public_key: string }[];
  readonly schemas: readonly { readonly file: string; readonly schema_id: string; readonly schema_digest: string }[];
  readonly canonical: readonly { readonly name: string; readonly value: unknown; readonly canonical: string; readonly digest: string }[];
  readonly primitives: readonly { readonly check: string; readonly value: unknown; readonly epoch_ms?: number; readonly ok?: true; readonly expect?: string }[];
  readonly derivations: {
    readonly account_scope: readonly { readonly name: string; readonly cloud_origin_id: string; readonly account_subject: string; readonly digest: string }[];
    readonly account_scope_reject: readonly { readonly name: string; readonly cloud_origin_id: unknown; readonly account_subject: unknown; readonly expect: string }[];
    readonly binding: readonly { readonly name: string; readonly binding: Doc; readonly digest: string }[];
    readonly binding_reject: readonly { readonly name: string; readonly binding: unknown; readonly expect: string }[];
    readonly arguments: readonly { readonly name: string; readonly arguments: unknown; readonly digest: string }[];
    readonly arguments_reject: readonly { readonly name: string; readonly arguments: unknown; readonly expect: string }[];
  };
  readonly raw_accept: readonly { readonly id: string; readonly frame: Frame; readonly canonical?: string; readonly canonical_sha256: string }[];
  readonly raw_reject: readonly { readonly id: string; readonly frame: Frame; readonly expect: string }[];
  readonly accept: readonly AcceptVector[];
  readonly reject: readonly RejectVector[];
  readonly cross: { readonly accept: readonly CrossAccept[]; readonly reject: readonly CrossReject[] };
}

let cached: Fixture | undefined;
async function loadFixture(): Promise<Fixture> {
  cached ??= JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as Fixture;
  return cached;
}
async function loadSchema(file: string): Promise<Doc> {
  return JSON.parse(await readFile(`${BUNDLE_DIR}/${file}`, "utf8")) as Doc;
}

// --- Independent recomputation (node:crypto + the repo JCS, not the module) --

const sha256 = (bytes: Uint8Array | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const preimage = (schema: string, value: unknown): Buffer => Buffer.from(schema + LF + canonicalJson(value), "utf8");
const without = (document: Doc, fields: readonly string[]): Doc => Object.fromEntries(Object.entries(document).filter(([key]) => !fields.includes(key)));
const pick = (document: Doc, fields: readonly string[]): Doc => Object.fromEntries(fields.map((field) => [field, document[field]]));
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

function ed25519Verifies(publicKey: string, message: Buffer, signature: string): boolean {
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKey, "base64url")]), format: "der", type: "spki" });
  return verifySignature(null, message, key, Buffer.from(signature, "base64url"));
}

function publicKeyFromSeed(seedHex: string): string {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return spki.subarray(spki.length - 32).toString("base64url");
}

// --- Patches ------------------------------------------------------------------

function generated(patch: Patch): unknown {
  if (patch.repeat) return patch.repeat.unit.repeat(patch.repeat.count);
  if (patch.grid) {
    const { rows, cols, unit, length, pad } = patch.grid;
    const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => unit.repeat(length)));
    return pad === undefined ? grid : { grid, pad: unit.repeat(pad) };
  }
  if (patch.nest) {
    let value: unknown = patch.nest.leaf;
    for (let i = 0; i < patch.nest.depth; i += 1) value = patch.nest.kind === "array" ? [value] : { k: value };
    return value;
  }
  throw new Error(`patch at ${patch.path.join(".")} carries no value`);
}

/** defineProperty, not assignment, so a `__proto__` key becomes an own property exactly as JSON.parse makes it. */
function applyPatches(document: unknown, patches: readonly Patch[]): unknown {
  let root = structuredClone(document);
  for (const patch of patches) {
    const value = patch.delete ? undefined : "value" in patch ? structuredClone(patch.value) : generated(patch);
    if (patch.path.length === 0) {
      root = value;
      continue;
    }
    let cursor = root as Record<string | number, unknown>;
    for (const key of patch.path.slice(0, -1)) cursor = cursor[key] as Record<string | number, unknown>;
    const leaf = patch.path[patch.path.length - 1]!;
    if (patch.delete) {
      assert.ok(Object.hasOwn(cursor, leaf), `patch deletes absent ${patch.path.join(".")}`);
      delete cursor[leaf];
    } else {
      Object.defineProperty(cursor, leaf, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  return root;
}

function refusal(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    if (!(error instanceof host.ToolHostContractError)) return `not a ToolHostContractError: ${String(error)}`;
    return error.message;
  }
}

// --- Validation by kind ----------------------------------------------------------

interface Resolved { trust?: host.TrustDocumentV1; device_proof?: host.DeviceProofV1; binding?: host.WorkspaceStatusBinding }

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`vector is missing ${what}`);
  return value;
}

function validateKind(kind: string, value: unknown, now: number | undefined, context: Resolved): unknown {
  switch (kind) {
    case "trust": return host.validateTrustDocument(value, need(now, "now"));
    case "device_proof": return host.validateDeviceProof(value, need(context.trust, "trust"), need(now, "now"));
    case "host_open_proof": return host.validateHostOpenProof(value, need(context.device_proof, "device proof"));
    case "observer_receipt": return host.validateObserverReceipt(value, need(now, "now"));
    case "runtime_capability": return host.validateRuntimeCapability(value, need(now, "now"));
    case "registry": return host.validateRegistry(value, need(now, "now"));
    case "host_lease": return host.validateHostLease(value, need(context.trust, "trust"), need(now, "now"));
    case "invocation": return host.validateInvocation(value);
    case "cancellation": return host.validateCancellation(value);
    case "result": return host.validateResult(value);
    case "workspace_status_input": return host.validateWorkspaceStatusInput(value);
    case "workspace_status": return host.validateWorkspaceStatus(value, need(context.binding, "binding"));
    default: throw new Error(`unknown kind ${kind}`);
  }
}

function acceptNamed(fixture: Fixture, name: string): AcceptVector {
  const vector = fixture.accept.find((entry) => entry.id === name);
  assert.ok(vector, `fixture refers to missing accept vector ${name}`);
  return vector;
}

function resolveContext(fixture: Fixture, context: Context | undefined): Resolved {
  const resolved: Resolved = {};
  if (context?.trust) {
    const trust = acceptNamed(fixture, context.trust);
    resolved.trust = host.validateTrustDocument(trust.document, need(trust.now, "now"));
  }
  if (context?.device_proof) {
    const proof = acceptNamed(fixture, context.device_proof);
    resolved.device_proof = host.validateDeviceProof(proof.document, need(resolveContext(fixture, proof.context).trust, "trust"), need(proof.now, "now"));
  }
  if (context?.binding) resolved.binding = context.binding as unknown as host.WorkspaceStatusBinding;
  return resolved;
}

// --- Fixture header, keys, bundle -------------------------------------------------------

test("the golden fixture pins its schema, canonical profile and clock skew", async () => {
  const fixture = await loadFixture();
  assert.equal(fixture.schema, "aether.managed-tool-host-golden/1");
  assert.equal(fixture.canonical_profile, "rfc8785/1");
  assert.equal(fixture.clock_skew_ms, host.CLOCK_SKEW_MS);
  const raw = await readFile(FIXTURE_PATH);
  assert.equal(printableAscii(raw), true, "fixture must be printable ASCII");
});

test("every vector id, name and key label is unique within its section", async () => {
  const fixture = await loadFixture();
  const d = fixture.derivations;
  const sections: Readonly<Record<string, readonly string[]>> = {
    keys: fixture.keys.map((key) => key.label),
    canonical: fixture.canonical.map((row) => row.name),
    account_scope: d.account_scope.map((row) => row.name),
    account_scope_reject: d.account_scope_reject.map((row) => row.name),
    binding: d.binding.map((row) => row.name),
    binding_reject: d.binding_reject.map((row) => row.name),
    arguments: d.arguments.map((row) => row.name),
    arguments_reject: d.arguments_reject.map((row) => row.name),
    raw: [...fixture.raw_accept, ...fixture.raw_reject].map((vector) => vector.id),
    objects: [...fixture.accept, ...fixture.reject].map((vector) => vector.id),
    cross: [...fixture.cross.accept, ...fixture.cross.reject].map((vector) => vector.id),
  };
  const repeated = Object.entries(sections).flatMap(([section, names]) =>
    names.filter((name, index) => names.indexOf(name) !== index).map((name) => `${section}: ${name}`),
  );
  assert.deepEqual(repeated, []);
});

test("every test key derives its public key and is labelled not for production", async () => {
  const fixture = await loadFixture();
  const problems: string[] = [];
  for (const key of fixture.keys) {
    if (!key.note.includes("NOT FOR PRODUCTION")) problems.push(`${key.label}: missing production warning`);
    if (publicKeyFromSeed(key.seed_hex) !== key.public_key) problems.push(`${key.label}: node:crypto derivation drifted`);
    if (Buffer.from(host.ed25519PublicKey(Buffer.from(key.seed_hex, "hex"))).toString("base64url") !== key.public_key) {
      problems.push(`${key.label}: module derivation drifted`);
    }
  }
  assert.deepEqual(problems, []);
});

const PARITY: readonly (readonly [string, string, readonly string[]])[] = [
  ["trust.schema.json", "", host.TRUST_FIELDS],
  ["trust.schema.json", "/$defs/trust_key", host.TRUST_KEY_FIELDS],
  ["device-proof.schema.json", "", host.DEVICE_PROOF_FIELDS],
  ["host-open-proof.schema.json", "", host.HOST_OPEN_PROOF_FIELDS],
  ["observer-channel-receipt.schema.json", "", host.OBSERVER_RECEIPT_FIELDS],
  ["runtime-capability.schema.json", "", host.RUNTIME_CAPABILITY_FIELDS],
  ["registry.schema.json", "", host.REGISTRY_FIELDS],
  ["registry.schema.json", "/$defs/tool", host.TOOL_FIELDS],
  ["host-lease.schema.json", "", host.HOST_LEASE_FIELDS],
  ["invocation.schema.json", "", host.INVOCATION_FIELDS],
  ["cancellation.schema.json", "", host.CANCELLATION_FIELDS],
  ["result.schema.json", "", host.RESULT_FIELDS],
  ["result.schema.json", "/$defs/error", host.RESULT_ERROR_FIELDS],
  ["workspace-status-input.schema.json", "", []],
  ["workspace-status.schema.json", "", host.WORKSPACE_STATUS_FIELDS],
  ["workspace-status.schema.json", "/$defs/local", host.WORKSPACE_LOCAL_FIELDS],
  ["workspace-status.schema.json", "/$defs/memory", host.WORKSPACE_MEMORY_FIELDS],
  ["workspace-status.schema.json", "/$defs/strategies", host.WORKSPACE_STRATEGIES_FIELDS],
  ["workspace-status.schema.json", "/$defs/data", host.WORKSPACE_DATA_FIELDS],
  ["workspace-status.schema.json", "/$defs/browser", host.WORKSPACE_BROWSER_FIELDS],
  ["workspace-status.schema.json", "/$defs/runtime", host.WORKSPACE_RUNTIME_FIELDS],
  ["workspace-status.schema.json", "/$defs/diagnostic", host.WORKSPACE_DIAGNOSTIC_FIELDS],
];

const SCHEMA_IDS: Readonly<Record<string, string>> = {
  "common.schema.json": host.COMMON_SCHEMA,
  "trust.schema.json": host.TRUST_SCHEMA,
  "device-proof.schema.json": host.DEVICE_PROOF_SCHEMA,
  "host-open-proof.schema.json": host.HOST_OPEN_PROOF_SCHEMA,
  "observer-channel-receipt.schema.json": host.OBSERVER_RECEIPT_SCHEMA,
  "runtime-capability.schema.json": host.RUNTIME_CAPABILITY_SCHEMA,
  "registry.schema.json": host.REGISTRY_SCHEMA,
  "host-lease.schema.json": host.HOST_LEASE_SCHEMA,
  "invocation.schema.json": host.INVOCATION_SCHEMA,
  "cancellation.schema.json": host.CANCELLATION_SCHEMA,
  "result.schema.json": host.RESULT_SCHEMA,
  "workspace-status-input.schema.json": host.WORKSPACE_STATUS_INPUT_SCHEMA,
  "workspace-status.schema.json": host.WORKSPACE_STATUS_SCHEMA,
};

function objectNodes(node: unknown, pointer: string, out: Map<string, Doc>): void {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => objectNodes(entry, `${pointer}/${index}`, out));
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Doc;
  if (record["type"] === "object") out.set(pointer, record);
  for (const [key, value] of Object.entries(record)) objectNodes(value, `${pointer}/${key}`, out);
}

function refsOf(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const entry of node) refsOf(entry, out);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Doc)) {
      if (key === "$ref") out.push(String(value));
      else refsOf(value, out);
    }
  }
  return out;
}

test("the schema bundle is closed, local, ASCII and pinned by its manifest", async () => {
  const fixture = await loadFixture();
  const manifest = await loadSchema("manifest.json");
  assert.equal(manifest["schema"], host.SCHEMA_BUNDLE_SCHEMA);
  const entries = manifest["entries"] as { file: string; schema_id: string; schema_digest: string }[];
  assert.deepEqual(entries.map((entry) => entry.file), Object.keys(SCHEMA_IDS).sort(), "manifest lists every schema, sorted by file");
  assert.deepEqual(fixture.schemas, entries, "fixture schemas section equals the manifest");
  const files = (await readdir(BUNDLE_DIR)).sort();
  assert.deepEqual(files, [...entries.map((entry) => entry.file), "manifest.json"].sort());
  const common = await loadSchema("common.schema.json");
  const commonDefs = common["$defs"] as Doc;
  assert.ok(commonDefs && !("properties" in common) && !("type" in common) && !("required" in common), "common schema is $defs only");
  const problems: string[] = [];
  for (const entry of entries) {
    const raw = await readFile(`${BUNDLE_DIR}/${entry.file}`);
    if (!printableAscii(raw)) problems.push(`${entry.file}: not printable ASCII`);
    const document = JSON.parse(raw.toString("utf8")) as Doc;
    if (document["$schema"] !== "https://json-schema.org/draft/2020-12/schema") problems.push(`${entry.file}: not draft 2020-12`);
    if (document["$id"] !== SCHEMA_BASE + entry.file) problems.push(`${entry.file}: wrong $id`);
    if (document["x-aether-schema-id"] !== entry.schema_id || entry.schema_id !== SCHEMA_IDS[entry.file]) problems.push(`${entry.file}: schema id drift`);
    if (sha256(preimage(host.SCHEMA_DIGEST_SCHEMA, document)) !== entry.schema_digest) problems.push(`${entry.file}: manifest digest drifted`);
    if (host.schemaDigest(document) !== entry.schema_digest) problems.push(`${entry.file}: module schema digest drifted`);
    const defs = (document["$defs"] ?? {}) as Doc;
    for (const ref of refsOf(document)) {
      if (!ref.startsWith("#/$defs/") || !Object.hasOwn(defs, ref.slice(8))) problems.push(`${entry.file}: non-local ref ${ref}`);
    }
    for (const [name, definition] of Object.entries(defs)) {
      if (Object.hasOwn(commonDefs, name) && JSON.stringify(definition) !== JSON.stringify(commonDefs[name])) problems.push(`${entry.file}: $defs.${name} differs from common`);
    }
    const nodes = new Map<string, Doc>();
    objectNodes(document, "", nodes);
    for (const [pointer, node] of nodes) {
      if (node["additionalProperties"] !== false) problems.push(`${entry.file}${pointer}: object is not closed`);
      const properties = Object.keys((node["properties"] ?? {}) as Doc);
      if (JSON.stringify(node["required"]) !== JSON.stringify(properties)) problems.push(`${entry.file}${pointer}: required is not every property`);
    }
    const expectedPointers = PARITY.filter(([file]) => file === entry.file).map(([, pointer]) => pointer).sort();
    if (JSON.stringify([...nodes.keys()].sort()) !== JSON.stringify(expectedPointers)) problems.push(`${entry.file}: object nodes outside the parity table`);
  }
  assert.deepEqual(problems, []);
});

test("closed-field parity: every schema object lists exactly the validator's fields", async () => {
  const problems: string[] = [];
  for (const [file, pointer, fields] of PARITY) {
    let node: unknown = await loadSchema(file);
    for (const part of pointer.split("/").slice(1)) node = (node as Doc)[part];
    const record = node as Doc;
    if (JSON.stringify(Object.keys(record["properties"] as Doc)) !== JSON.stringify(fields)) problems.push(`${file}${pointer}: properties differ from the validator`);
    if (JSON.stringify(record["required"]) !== JSON.stringify(fields)) problems.push(`${file}${pointer}: required differs from the validator`);
  }
  assert.deepEqual(problems, []);
});

test("closed enums in the schemas equal the exported vocabulary", async () => {
  const cases: readonly (readonly [string, readonly string[], readonly string[]])[] = [
    ["common.schema.json", ["$defs", "execution_mode", "enum"], host.EXECUTION_MODES],
    ["registry.schema.json", ["$defs", "tool", "properties", "dependencies", "items", "enum"], host.TOOL_DEPENDENCIES],
    ["registry.schema.json", ["$defs", "tool", "properties", "data_classes", "items", "enum"], host.DATA_CLASSES],
    ["cancellation.schema.json", ["properties", "reason", "enum"], host.CANCELLATION_REASONS],
    ["result.schema.json", ["properties", "state", "enum"], host.RESULT_STATES],
    ["result.schema.json", ["properties", "replay_status", "enum"], host.REPLAY_STATUSES],
    ["result.schema.json", ["properties", "retry_class", "enum"], host.RETRY_CLASSES],
    ["result.schema.json", ["$defs", "error", "properties", "code", "enum"], host.FAILURE_CODES],
    ["workspace-status.schema.json", ["$defs", "memory", "properties", "state", "enum"], host.MEMORY_STATES],
    ["workspace-status.schema.json", ["$defs", "memory", "properties", "writer_lease", "enum"], host.WRITER_LEASE_STATES],
    ["workspace-status.schema.json", ["$defs", "strategies", "properties", "state", "enum"], host.STRATEGY_STATES],
    ["workspace-status.schema.json", ["$defs", "strategies", "properties", "compiler", "enum"], host.COMPILER_STATES],
    ["workspace-status.schema.json", ["$defs", "data", "properties", "research_configuration", "enum"], host.RESEARCH_CONFIGURATIONS],
    ["workspace-status.schema.json", ["$defs", "data", "properties", "last_probe", "enum"], host.PROBE_STATES],
    ["workspace-status.schema.json", ["$defs", "browser", "properties", "state", "enum"], host.BROWSER_STATES],
    ["workspace-status.schema.json", ["$defs", "runtime", "properties", "state", "enum"], host.RUNTIME_STATES],
    ["workspace-status.schema.json", ["$defs", "diagnostic", "properties", "severity", "enum"], host.DIAGNOSTIC_SEVERITIES],
  ];
  const problems: string[] = [];
  for (const [file, path, expected] of cases) {
    let node: unknown = await loadSchema(file);
    for (const part of path) node = (node as Doc)[part];
    if (JSON.stringify(node) !== JSON.stringify(expected)) problems.push(`${file} ${path.join(".")}`);
  }
  assert.deepEqual(problems, []);
  assert.deepEqual(host.FAILURE_CODES, [
    "TOOL_CONTRACT_INVALID", "TOOL_SCOPE_MISMATCH", "TOOL_LEASE_EXPIRED", "TOOL_LEASE_REVOKED", "TOOL_REGISTRY_MISMATCH",
    "TOOL_SEQUENCE_INVALID", "TOOL_IDEMPOTENCY_CONFLICT", "TOOL_UNKNOWN", "TOOL_ARGUMENT_INVALID", "TOOL_DEADLINE_EXCEEDED",
    "TOOL_CANCELLED", "TOOL_DEPENDENCY_UNAVAILABLE", "TOOL_RESULT_TOO_LARGE", "TOOL_DELIVERY_UNAVAILABLE",
  ], "failure codes are the spec section 14 list, in order");
});

/** Every place the spec names grants_execution_authority, and nowhere else. */
const GRANTS_NODES = [
  "host-lease.schema.json", "registry.schema.json", "registry.schema.json/$defs/tool", "result.schema.json",
  "runtime-capability.schema.json", "workspace-status.schema.json",
];

test("grants_execution_authority is required and pinned false wherever the spec names it", async () => {
  const found: string[] = [];
  const problems: string[] = [];
  for (const file of Object.keys(SCHEMA_IDS)) {
    const nodes = new Map<string, Doc>();
    objectNodes(await loadSchema(file), "", nodes);
    for (const [pointer, node] of nodes) {
      const properties = (node["properties"] ?? {}) as Doc;
      if (!Object.hasOwn(properties, "grants_execution_authority")) continue;
      found.push(file + pointer);
      if (JSON.stringify(properties["grants_execution_authority"]) !== JSON.stringify({ type: "boolean", const: false })) problems.push(`${file}${pointer}: not const false`);
      if (!(node["required"] as string[]).includes("grants_execution_authority")) problems.push(`${file}${pointer}: not required`);
    }
  }
  assert.deepEqual(found.sort(), [...GRANTS_NODES].sort());
  assert.deepEqual(problems, []);
  const status = (await loadSchema("workspace-status.schema.json"))["properties"] as Doc;
  assert.deepEqual(status["execution_authority"], { type: "string", const: "none" });
  assert.deepEqual(status["orders_enabled"], { type: "boolean", const: false });
  const capability = (await loadSchema("runtime-capability.schema.json"))["properties"] as Doc;
  assert.deepEqual(capability["supports_live_execution"], { type: "boolean", const: false });
});

test("the E1 schema digest constants equal the frozen bundle", async () => {
  const entries = (await loadSchema("manifest.json"))["entries"] as { file: string; schema_digest: string }[];
  const digestOf = (file: string): string | undefined => entries.find((entry) => entry.file === file)?.schema_digest;
  assert.equal(host.WORKSPACE_STATUS_INPUT_SCHEMA_DIGEST, digestOf("workspace-status-input.schema.json"));
  assert.equal(host.WORKSPACE_STATUS_SCHEMA_DIGEST, digestOf("workspace-status.schema.json"));
});

// --- Encoding vectors --------------------------------------------------------------------

test("canonical vectors reproduce RFC 8785 bytes and digests", async () => {
  const fixture = await loadFixture();
  assert.ok(fixture.canonical.length >= CANONICAL_FLOOR);
  const problems: string[] = [];
  for (const vector of fixture.canonical) {
    const encoded = canonicalJson(vector.value);
    if (encoded !== vector.canonical) problems.push(`${vector.name}: canonical bytes drifted`);
    if (sha256(Buffer.from(encoded, "utf8")) !== vector.digest) problems.push(`${vector.name}: digest drifted`);
  }
  assert.deepEqual(problems, []);
});

test("primitive boundaries: timestamps, text, IDs, origins, base64url and schema IDs", async () => {
  const fixture = await loadFixture();
  assert.ok(fixture.primitives.length >= PRIMITIVE_FLOOR);
  const checks: Readonly<Record<string, (value: unknown) => unknown>> = {
    timestamp: (value) => epochMs(timestamp(value, "Value")),
    text: (value) => text(value, "Value", 1, 256),
    id: (value) => id(value, "Value"),
    origin: (value) => httpsOrigin(value, "Value"),
    base64url_32: (value) => base64url(value, "Value", 32),
    base64url_64: (value) => base64url(value, "Value", 64),
    schema_id: (value) => schemaId(value, "Value"),
  };
  const problems: string[] = [];
  fixture.primitives.forEach((entry, index) => {
    const check = checks[entry.check];
    const label = `${entry.check}[${index}]`;
    if (!check) {
      problems.push(`${label}: unknown check`);
      return;
    }
    if (entry.expect !== undefined) {
      const message = refusal(() => check(entry.value));
      if (message !== entry.expect) problems.push(`${label}: expected ${entry.expect}, got ${String(message)}`);
      return;
    }
    try {
      const result = check(entry.value);
      if (entry.epoch_ms !== undefined && result !== entry.epoch_ms) problems.push(`${label}: epoch ${String(result)}`);
    } catch (error) {
      problems.push(`${label}: refused a valid value: ${(error as Error).message}`);
    }
  });
  assert.deepEqual(problems, []);
});

test("derivations: account scope, workspace binding and arguments digests", async () => {
  const { derivations } = await loadFixture();
  const problems: string[] = [];
  for (const row of derivations.account_scope) {
    const expected = sha256(preimage(host.ACCOUNT_SCOPE_SCHEMA, { cloud_origin_id: row.cloud_origin_id, account_subject: row.account_subject }));
    if (expected !== row.digest) problems.push(`account_scope ${row.name}: independent digest drifted`);
    if (host.accountScopeDigest(row.cloud_origin_id, row.account_subject) !== row.digest) problems.push(`account_scope ${row.name}: module digest drifted`);
  }
  for (const row of derivations.account_scope_reject) {
    const message = refusal(() => host.accountScopeDigest(row.cloud_origin_id, row.account_subject));
    if (message !== row.expect) problems.push(`account_scope ${row.name}: got ${String(message)}`);
  }
  for (const row of derivations.binding) {
    if (sha256(preimage(host.WORKSPACE_BINDING_SCHEMA, row.binding)) !== row.digest) problems.push(`binding ${row.name}: independent digest drifted`);
    if (host.workspaceBindingDigest(row.binding) !== row.digest) problems.push(`binding ${row.name}: module digest drifted`);
  }
  for (const row of derivations.binding_reject) {
    const message = refusal(() => host.workspaceBindingDigest(row.binding));
    if (message !== row.expect) problems.push(`binding ${row.name}: got ${String(message)}`);
  }
  for (const row of derivations.arguments) {
    if (sha256(preimage(host.ARGUMENTS_SCHEMA, row.arguments)) !== row.digest) problems.push(`arguments ${row.name}: independent digest drifted`);
    if (host.argumentsDigest(row.arguments) !== row.digest) problems.push(`arguments ${row.name}: module digest drifted`);
  }
  for (const row of derivations.arguments_reject) {
    const message = refusal(() => host.argumentsDigest(row.arguments));
    if (message !== row.expect) problems.push(`arguments ${row.name}: got ${String(message)}`);
  }
  assert.deepEqual(problems, []);
});

function frameBytes(frame: Frame): Uint8Array {
  if (frame.text !== undefined) return Buffer.from(frame.text, "latin1");
  if (frame.base64 !== undefined) return Buffer.from(frame.base64, "base64");
  const spec = frame.generate;
  if (spec?.string_member !== undefined) return Buffer.from(`{"k":"${"x".repeat(spec.string_member - 8)}"}`, "utf8");
  if (spec?.nest !== undefined) {
    return Buffer.from(spec.kind === "array" ? "[".repeat(spec.nest) + "]".repeat(spec.nest) : `{"a":`.repeat(spec.nest) + "0" + "}".repeat(spec.nest), "utf8");
  }
  throw new Error("frame has no bytes");
}

test("raw frames: the strict lexer accepts canonical-safe JSON and refuses each lexical hazard", async () => {
  const fixture = await loadFixture();
  assert.ok(fixture.raw_accept.length >= RAW_ACCEPT_FLOOR && fixture.raw_reject.length >= RAW_REJECT_FLOOR);
  const problems: string[] = [];
  for (const vector of fixture.raw_accept) {
    try {
      const encoded = canonicalJson(host.parseFrame(frameBytes(vector.frame)));
      if (vector.canonical !== undefined && encoded !== vector.canonical) problems.push(`${vector.id}: canonical text drifted`);
      if (sha256(Buffer.from(encoded, "utf8")) !== vector.canonical_sha256) problems.push(`${vector.id}: canonical digest drifted`);
    } catch (error) {
      problems.push(`${vector.id}: refused a valid frame: ${(error as Error).message}`);
    }
  }
  for (const vector of fixture.raw_reject) {
    const message = refusal(() => host.parseFrame(frameBytes(vector.frame)));
    if (message !== vector.expect) problems.push(`${vector.id}: expected ${vector.expect}, got ${String(message)}`);
  }
  assert.deepEqual(problems, []);
});

// --- Object vectors -------------------------------------------------------------------------

const SELF_DIGESTS: Readonly<Record<string, readonly (readonly [string, readonly string[], string])[]>> = {
  device_proof: [["proof_digest", ["proof_digest", "cloud_signature"], host.DEVICE_PROOF_SCHEMA]],
  observer_receipt: [["receipt_digest", ["receipt_digest"], host.OBSERVER_RECEIPT_SCHEMA]],
  runtime_capability: [["capability_digest", ["capability_digest"], host.RUNTIME_CAPABILITY_SCHEMA]],
  registry: [["registry_digest", ["registry_digest"], host.REGISTRY_SCHEMA]],
  invocation: [["invocation_digest", ["invocation_digest"], host.INVOCATION_SCHEMA]],
  cancellation: [["cancellation_digest", ["cancellation_digest"], host.CANCELLATION_SCHEMA]],
  result: [["result_digest", ["result_digest"], host.RESULT_SCHEMA]],
  workspace_status: [["status_digest", ["status_digest"], host.WORKSPACE_STATUS_SCHEMA]],
};

function independentProblems(fixture: Fixture, vector: AcceptVector): string[] {
  const problems: string[] = [];
  const document = vector.document as Doc;
  for (const [field, omit, schema] of SELF_DIGESTS[vector.kind] ?? []) {
    if (sha256(preimage(schema, without(document, omit))) !== document[field]) problems.push(`${vector.id}: ${field} is not the common digest`);
  }
  if (vector.kind === "device_proof" || vector.kind === "host_lease") {
    const schema = vector.kind === "device_proof" ? host.DEVICE_PROOF_SCHEMA : host.HOST_LEASE_SCHEMA;
    const trust = acceptNamed(fixture, need(vector.context?.trust, "trust")).document as { keys: { key_id: string; public_key: string }[] };
    const key = trust.keys.find((entry) => entry.key_id === document["signature_key_id"])?.public_key;
    if (!key || !ed25519Verifies(key, preimage(schema, without(document, ["cloud_signature"])), String(document["cloud_signature"]))) {
      problems.push(`${vector.id}: cloud_signature does not verify independently`);
    }
  }
  if (vector.kind === "host_open_proof") {
    const proof = acceptNamed(fixture, need(vector.context?.device_proof, "device proof")).document as Doc;
    const body = pick(document, ["challenge", "device_proof_digest", "agent_id", "conversation_id", "local_session_id", "session_generation", "registry_digest"]);
    if (!ed25519Verifies(String(proof["device_public_key"]), preimage(host.HOST_OPEN_SIGNING_SCHEMA, body), String(document["device_signature"]))) {
      problems.push(`${vector.id}: device_signature does not verify independently`);
    }
  }
  if (vector.kind === "invocation" && sha256(preimage(host.ARGUMENTS_SCHEMA, document["arguments"])) !== document["arguments_digest"]) {
    problems.push(`${vector.id}: arguments_digest drifted`);
  }
  if (vector.kind === "result") {
    const size = document["payload"] === null ? 0 : Buffer.byteLength(canonicalJson(document["payload"]), "utf8");
    if (size !== document["bounded_bytes"]) problems.push(`${vector.id}: bounded_bytes drifted`);
  }
  if (vector.kind === "workspace_status" && sha256(preimage(host.WORKSPACE_BINDING_SCHEMA, vector.context?.binding)) !== document["binding_digest"]) {
    problems.push(`${vector.id}: binding_digest drifted`);
  }
  return problems;
}

test("every accept vector validates, stays byte-identical and reproduces its digests and signatures", async () => {
  const fixture = await loadFixture();
  assert.ok(fixture.accept.length >= ACCEPT_FLOOR);
  const problems: string[] = [];
  for (const vector of fixture.accept) {
    problems.push(...independentProblems(fixture, vector));
    if (sha256(Buffer.from(canonicalJson(vector.document), "utf8")) !== vector.expect.canonical_sha256) problems.push(`${vector.id}: canonical digest drifted`);
    let output: unknown;
    try {
      output = validateKind(vector.kind, vector.document, vector.now, resolveContext(fixture, vector.context));
    } catch (error) {
      problems.push(`${vector.id}: refused a faithful document: ${(error as Error).message}`);
      continue;
    }
    if (canonicalJson(output) !== canonicalJson(vector.document)) problems.push(`${vector.id}: validator output differs from its input`);
    if (!Object.isFrozen(output)) problems.push(`${vector.id}: validator output is not frozen`);
  }
  assert.deepEqual(problems, []);
});

test("every reject vector fails for its stated reason, and its base document is accepted", async () => {
  const fixture = await loadFixture();
  const problems: string[] = [];
  for (const [kind, floor] of Object.entries(REJECT_FLOORS)) {
    const vectors = fixture.reject.filter((entry) => entry.kind === kind);
    if (vectors.length < floor) problems.push(`${kind}: ${vectors.length} reject vectors, floor ${floor}`);
    for (const rule of REQUIRED_REJECT_RULES[kind] ?? []) {
      if (!vectors.some((entry) => entry.rule === rule)) problems.push(`${kind}: no reject vector covers ${rule}`);
    }
  }
  for (const vector of fixture.reject) {
    const base = acceptNamed(fixture, vector.base);
    if (refusal(() => validateKind(base.kind, base.document, base.now, resolveContext(fixture, base.context))) !== null) {
      problems.push(`${vector.id}: control document refused`);
    }
    const context = resolveContext(fixture, vector.context ?? base.context);
    const message = refusal(() => validateKind(vector.kind, applyPatches(base.document, vector.patches), vector.now ?? base.now, context));
    if (message !== vector.expect) problems.push(`${vector.id}: expected ${vector.expect}, got ${String(message)}`);
  }
  assert.deepEqual(problems, []);
});

// --- Cross-object vectors -------------------------------------------------------------------

type Inputs = Record<string, unknown>;

function validateInputs(fixture: Fixture, refsByName: Readonly<Record<string, string>>, patches: Readonly<Record<string, readonly Patch[]>>, now: number): Inputs {
  const raw: Record<string, unknown> = {};
  for (const [name, ref] of Object.entries(refsByName)) raw[name] = applyPatches(acceptNamed(fixture, ref).document, patches[name] ?? []);
  const out: Inputs = {};
  if (raw["trust"] !== undefined) out["trust"] = host.validateTrustDocument(raw["trust"], now);
  const trust = out["trust"] as host.TrustDocumentV1 | undefined;
  for (const [name, value] of Object.entries(raw)) {
    switch (name) {
      case "trust": break;
      case "device_proof": out[name] = host.validateDeviceProof(value, need(trust, "trust input"), now); break;
      case "lease": out[name] = host.validateHostLease(value, need(trust, "trust input"), now); break;
      case "registry": out[name] = host.validateRegistry(value, now); break;
      case "invocation": out[name] = host.validateInvocation(value); break;
      case "cancellation": out[name] = host.validateCancellation(value); break;
      case "result": out[name] = host.validateResult(value); break;
      case "capability": out[name] = host.validateRuntimeCapability(value, now); break;
      case "receipt": out[name] = host.validateObserverReceipt(value, now); break;
      default: throw new Error(`unknown cross input ${name}`);
    }
  }
  return out;
}

function runCheck(check: string, inputs: Inputs, now: number, expected: Expected | undefined): void {
  const v = <T>(name: string): T => need(inputs[name] as T | undefined, `${name} input`);
  switch (check) {
    case "lease_binding": return host.checkLeaseBinding(v("lease"), v("registry"), v("device_proof"), v("trust"));
    case "invocation": return host.checkInvocation(v("invocation"), v("lease"), v("registry"), now);
    case "tool_arguments": return host.checkToolArguments(v("invocation"), v("registry"));
    case "cancellation": return host.checkCancellation(v("cancellation"), v("invocation"), v("lease"));
    case "result": return host.checkResult(v("result"), v("invocation"), v("registry"), now);
    case "tool_payload": return host.checkToolPayload(v("result"), v("invocation"), v("registry"));
    case "e1_canary": return host.assertE1CanaryRegistry(v("registry"));
    case "capability_receipt": return host.checkCapabilityReceipt(v("capability"), v("receipt"), need(expected, "expected"));
    default: throw new Error(`unknown cross check ${check}`);
  }
}

test("every cross-object accept vector passes its check", async () => {
  const fixture = await loadFixture();
  assert.ok(fixture.cross.accept.length >= CROSS_ACCEPT_FLOOR);
  const problems: string[] = [];
  for (const vector of fixture.cross.accept) {
    try {
      runCheck(vector.check, validateInputs(fixture, vector.inputs, {}, vector.now), vector.now, vector.expected);
    } catch (error) {
      problems.push(`${vector.id}: ${(error as Error).message}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("every cross-object reject is well-formed but refused by its check for the stated reason", async () => {
  const fixture = await loadFixture();
  const problems: string[] = [];
  for (const [check, floor] of Object.entries(CROSS_REJECT_FLOORS)) {
    const vectors = fixture.cross.reject.filter((entry) => entry.check === check);
    if (vectors.length < floor) problems.push(`${check}: ${vectors.length} cross rejects, floor ${floor}`);
    for (const rule of REQUIRED_CROSS_RULES[check] ?? []) {
      if (!vectors.some((entry) => entry.id === `${check}.${rule}`)) problems.push(`${check}: no cross reject covers ${rule}`);
    }
  }
  for (const vector of fixture.cross.reject) {
    const base = fixture.cross.accept.find((entry) => entry.id === vector.base);
    if (!base) {
      problems.push(`${vector.id}: missing base ${vector.base}`);
      continue;
    }
    const now = vector.now ?? base.now;
    let inputs: Inputs;
    try {
      // Every input must still validate on its own: the refusal has to come from the cross check.
      inputs = validateInputs(fixture, { ...base.inputs, ...(vector.inputs ?? {}) }, vector.patches, now);
    } catch (error) {
      problems.push(`${vector.id}: refused by shape, not by the cross check: ${(error as Error).message}`);
      continue;
    }
    const message = refusal(() => runCheck(vector.check, inputs, now, vector.expected ?? base.expected));
    if (message !== vector.expect) problems.push(`${vector.id}: expected ${vector.expect}, got ${String(message)}`);
  }
  assert.deepEqual(problems, []);
});

// --- Module hygiene -----------------------------------------------------------------------------

test("validators that need no clock take none, and temporal ones take an explicit now", () => {
  assert.deepEqual([
    host.validateTrustDocument.length, host.validateDeviceProof.length, host.validateHostOpenProof.length,
    host.validateObserverReceipt.length, host.validateRuntimeCapability.length, host.validateRegistry.length,
    host.validateHostLease.length, host.validateInvocation.length, host.validateCancellation.length,
    host.validateResult.length, host.validateWorkspaceStatusInput.length, host.validateWorkspaceStatus.length,
  ], [2, 3, 2, 2, 2, 2, 3, 1, 1, 1, 1, 2]);
});

test("the managed tool host module performs no I/O, imports only what the brief allows and is ASCII", async () => {
  const modules = (await readdir(MODULE_DIR)).filter((name) => name.endsWith(".ts"));
  assert.ok(modules.includes("strict_json.ts") && modules.includes("cross.ts"), "module files missing from the scan");
  const allowed = new Set(["node:crypto", "../ats_contracts/canonical.js"]);
  const forbidden = ["node:fs", "node:net", "node:http", "node:https", "node:tls", "node:dgram", "node:child_process", "node:worker_threads", "process.env", "fetch(", "require(", "import("];
  const problems: string[] = [];
  for (const name of modules) {
    const bytes = await readFile(`${MODULE_DIR}/${name}`);
    if (!printableAscii(bytes)) problems.push(`${name}: not printable ASCII`);
    const source = bytes.toString("utf8");
    for (const token of forbidden) if (source.includes(token)) problems.push(`${name}: reaches for ${token}`);
    for (const match of source.matchAll(/from "([^"]+)"/g)) {
      const specifier = match[1]!;
      if (!allowed.has(specifier) && !(specifier.startsWith("./") && specifier.endsWith(".js"))) problems.push(`${name}: imports ${specifier}`);
    }
  }
  assert.deepEqual(problems, []);
});
