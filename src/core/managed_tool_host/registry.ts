// ToolRegistryManifestV1 (spec section 6): the exact tool list one
// foreground host session offers, fenced by its session generation. Tool
// entries are strictly ascending by (name, version), versions compared as
// integers; dependencies and data_classes are code-point-ordered sets.

import { digestFor, omit } from "./digest.js";
import {
  array, clock, closed, compareCodePoints, constant, deviceId, digest, envelope, fieldOf, fresh, id, items, lifetime,
  matchDigest, oneOf, positive53, range, schemaId, strictlyAscending, stringSet, timestamp, toolName, toolVersion,
} from "./primitives.js";
import {
  DATA_CLASSES, MAX_ARGUMENT_BYTES, MAX_DATA_CLASSES, MAX_DEPENDENCIES, MAX_DURATION_MS, MAX_REGISTRY_LIFETIME_MS,
  MAX_RESULT_BYTES, MAX_TOOLS, MIN_ARGUMENT_BYTES, MIN_RESULT_BYTES, REGISTRY_FIELDS, REGISTRY_SCHEMA, TOOL_DEPENDENCIES,
  TOOL_FIELDS, type DataClass, type ToolDependency,
} from "./vocabulary.js";

export interface ToolEntryV1 {
  readonly name: string;
  readonly version: number;
  readonly input_schema_id: string;
  readonly input_schema_digest: string;
  readonly output_schema_id: string;
  readonly output_schema_digest: string;
  readonly effect_class: "read_only";
  readonly dependencies: readonly ToolDependency[];
  readonly max_argument_bytes: number;
  readonly max_result_bytes: number;
  readonly max_duration_ms: number;
  readonly data_classes: readonly DataClass[];
  readonly grants_execution_authority: false;
}

export interface ToolRegistryManifestV1 {
  readonly schema: typeof REGISTRY_SCHEMA;
  readonly registry_id: string;
  readonly account_scope_digest: string;
  readonly agent_id: string;
  readonly device_id: string;
  readonly local_session_id: string;
  readonly session_generation: number;
  readonly created_at: string;
  readonly expires_at: string;
  readonly tools: readonly ToolEntryV1[];
  readonly grants_execution_authority: false;
  readonly registry_digest: string;
}

const L = "Registry";

function toolEntry(value: unknown, path: string): ToolEntryV1 {
  const f = fieldOf(closed(value, path, TOOL_FIELDS), `${path}.`);
  return Object.freeze({
    name: f("name", toolName),
    version: f("version", toolVersion),
    input_schema_id: f("input_schema_id", schemaId),
    input_schema_digest: f("input_schema_digest", digest),
    output_schema_id: f("output_schema_id", schemaId),
    output_schema_digest: f("output_schema_digest", digest),
    effect_class: f("effect_class", constant("read_only" as const)),
    dependencies: f("dependencies", stringSet(1, MAX_DEPENDENCIES, oneOf(TOOL_DEPENDENCIES))),
    max_argument_bytes: f("max_argument_bytes", range(MIN_ARGUMENT_BYTES, MAX_ARGUMENT_BYTES)),
    max_result_bytes: f("max_result_bytes", range(MIN_RESULT_BYTES, MAX_RESULT_BYTES)),
    max_duration_ms: f("max_duration_ms", range(1, MAX_DURATION_MS)),
    data_classes: f("data_classes", stringSet(1, MAX_DATA_CLASSES, oneOf(DATA_CLASSES))),
    grants_execution_authority: f("grants_execution_authority", constant(false as const)),
  });
}

const compareTools = (a: ToolEntryV1, b: ToolEntryV1): number => compareCodePoints(a.name, b.name) || a.version - b.version;

export function validateRegistry(value: unknown, now: number): ToolRegistryManifestV1 {
  clock(now);
  const raw = envelope(value, L, REGISTRY_SCHEMA, REGISTRY_FIELDS);
  const f = fieldOf(raw, `${L} `);
  const registry: ToolRegistryManifestV1 = {
    schema: raw["schema"] as typeof REGISTRY_SCHEMA,
    registry_id: f("registry_id", id),
    account_scope_digest: f("account_scope_digest", digest),
    agent_id: f("agent_id", id),
    device_id: f("device_id", deviceId),
    local_session_id: f("local_session_id", id),
    session_generation: f("session_generation", positive53),
    created_at: f("created_at", timestamp),
    expires_at: f("expires_at", timestamp),
    tools: f("tools", (tools, path) => items(array(tools, path, 1, MAX_TOOLS), path, toolEntry)),
    grants_execution_authority: f("grants_execution_authority", constant(false as const)),
    registry_digest: f("registry_digest", digest),
  };
  strictlyAscending(registry.tools, (tool) => `${tool.name}/${tool.version}`, compareTools,
    `${L} tools must not repeat a name and version.`, `${L} tools must be in ascending name and version order.`);
  lifetime(L, registry.created_at, "created_at", registry.expires_at, MAX_REGISTRY_LIFETIME_MS, "5 minutes");
  matchDigest(L, "registry_digest", registry.registry_digest, digestFor(REGISTRY_SCHEMA, omit(registry, ["registry_digest"])));
  fresh(L, registry.created_at, "created_at", registry.expires_at, now);
  return Object.freeze(registry);
}
