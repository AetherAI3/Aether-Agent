// The E1 canary tool ats_workspace_status (spec section 11): exactly an empty
// input object, and a closed, bounded, read-only status with no path, source,
// prompt, credential or execution authority. binding_digest ties the status to
// the host binding the caller supplies (the bound invocation's scope).

import { fail } from "./errors.js";
import { bindingDigestOf, canonicalBytesIfEncodable, digestFor, omit, type WorkspaceStatusBinding } from "./digest.js";
import {
  array, closed, constant, diagnosticCode, digest, envelope, fieldOf, isPlainObject, items, matchDigest, nullable, oneOf,
  range, safeDisplay, timestamp, type Check,
} from "./primitives.js";
import {
  BROWSER_STATES, COMPILER_STATES, DIAGNOSTIC_SEVERITIES, EXECUTION_MODES, MAX_CONFIGURED_GIB, MAX_DIAGNOSTICS,
  MAX_STRATEGY_COUNT, MAX_WORKSPACE_STATUS_BYTES, MEMORY_STATES, PROBE_STATES, RESEARCH_CONFIGURATIONS, RUNTIME_STATES,
  STRATEGY_STATES, WORKSPACE_BROWSER_FIELDS, WORKSPACE_DATA_FIELDS, WORKSPACE_DIAGNOSTIC_FIELDS, WORKSPACE_LOCAL_FIELDS,
  WORKSPACE_MEMORY_FIELDS, WORKSPACE_RUNTIME_FIELDS, WORKSPACE_STATUS_FIELDS, WORKSPACE_STATUS_SCHEMA,
  WORKSPACE_STRATEGIES_FIELDS, WRITER_LEASE_STATES, type ExecutionMode,
} from "./vocabulary.js";

export interface WorkspaceStatusV1 {
  readonly schema: typeof WORKSPACE_STATUS_SCHEMA;
  readonly observed_at: string;
  readonly binding_digest: string;
  readonly local: {
    readonly memory: {
      readonly state: (typeof MEMORY_STATES)[number];
      readonly configured_gib: number | null;
      readonly writer_lease: (typeof WRITER_LEASE_STATES)[number];
    };
    readonly strategies: {
      readonly state: (typeof STRATEGY_STATES)[number];
      readonly count: number;
      readonly compiler: (typeof COMPILER_STATES)[number];
      readonly execution_enabled: false;
    };
  };
  readonly data: {
    readonly research_configuration: (typeof RESEARCH_CONFIGURATIONS)[number];
    readonly last_probe: (typeof PROBE_STATES)[number];
    readonly executable_evidence: "unavailable";
  };
  readonly browser: { readonly state: (typeof BROWSER_STATES)[number] };
  readonly runtime: { readonly state: (typeof RUNTIME_STATES)[number]; readonly effective_execution_mode: ExecutionMode };
  readonly execution_authority: "none";
  readonly orders_enabled: false;
  readonly grants_execution_authority: false;
  readonly diagnostics: readonly { readonly code: string; readonly severity: (typeof DIAGNOSTIC_SEVERITIES)[number]; readonly summary: string }[];
  readonly status_digest: string;
}

const L = "Workspace status";

/** The model cannot select a path, runtime, browser session, provider or account: the input is exactly {}. */
export function validateWorkspaceStatusInput(value: unknown): Readonly<Record<string, never>> {
  if (!isPlainObject(value) || Object.keys(value).length !== 0) fail("Workspace status input must be an empty object.");
  return Object.freeze({});
}

/** A closed nested object whose fields are all checked by `checks`, in order. */
function section<T>(fields: readonly string[], checks: Readonly<Record<string, Check<unknown>>>): Check<T> {
  return (value, path) => {
    const f = fieldOf(closed(value, path, fields), `${path}.`);
    return Object.freeze(Object.fromEntries(fields.map((field) => [field, f(field, checks[field] as Check<unknown>)]))) as T;
  };
}

const memory = section<WorkspaceStatusV1["local"]["memory"]>(WORKSPACE_MEMORY_FIELDS, {
  state: oneOf(MEMORY_STATES),
  configured_gib: nullable(range(1, MAX_CONFIGURED_GIB)),
  writer_lease: oneOf(WRITER_LEASE_STATES),
});
const strategies = section<WorkspaceStatusV1["local"]["strategies"]>(WORKSPACE_STRATEGIES_FIELDS, {
  state: oneOf(STRATEGY_STATES),
  count: range(0, MAX_STRATEGY_COUNT),
  compiler: oneOf(COMPILER_STATES),
  execution_enabled: constant(false as const),
});
const local = section<WorkspaceStatusV1["local"]>(WORKSPACE_LOCAL_FIELDS, { memory, strategies });
const data = section<WorkspaceStatusV1["data"]>(WORKSPACE_DATA_FIELDS, {
  research_configuration: oneOf(RESEARCH_CONFIGURATIONS),
  last_probe: oneOf(PROBE_STATES),
  executable_evidence: constant("unavailable" as const),
});
const browser = section<WorkspaceStatusV1["browser"]>(WORKSPACE_BROWSER_FIELDS, { state: oneOf(BROWSER_STATES) });
const runtime = section<WorkspaceStatusV1["runtime"]>(WORKSPACE_RUNTIME_FIELDS, {
  state: oneOf(RUNTIME_STATES),
  effective_execution_mode: oneOf(EXECUTION_MODES),
});
const diagnostic = section<WorkspaceStatusV1["diagnostics"][number]>(WORKSPACE_DIAGNOSTIC_FIELDS, {
  code: diagnosticCode,
  severity: oneOf(DIAGNOSTIC_SEVERITIES),
  summary: safeDisplay,
});

export function validateWorkspaceStatus(value: unknown, binding: WorkspaceStatusBinding): WorkspaceStatusV1 {
  // The 64 KiB bound runs first, as a resource bound on the serialized value.
  const size = canonicalBytesIfEncodable(value);
  if (size !== null && size > MAX_WORKSPACE_STATUS_BYTES) fail(`${L} exceeds 65536 serialized bytes.`);
  const raw = envelope(value, L, WORKSPACE_STATUS_SCHEMA, WORKSPACE_STATUS_FIELDS);
  const f = fieldOf(raw, `${L} `);
  const status: WorkspaceStatusV1 = {
    schema: raw["schema"] as typeof WORKSPACE_STATUS_SCHEMA,
    observed_at: f("observed_at", timestamp),
    binding_digest: f("binding_digest", digest),
    local: f("local", local),
    data: f("data", data),
    browser: f("browser", browser),
    runtime: f("runtime", runtime),
    execution_authority: f("execution_authority", constant("none" as const)),
    orders_enabled: f("orders_enabled", constant(false as const)),
    grants_execution_authority: f("grants_execution_authority", constant(false as const)),
    diagnostics: f("diagnostics", (list, path) => items(array(list, path, 0, MAX_DIAGNOSTICS), path, diagnostic)),
    status_digest: f("status_digest", digest),
  };
  if (status.binding_digest !== bindingDigestOf(binding)) fail(`${L} binding_digest does not match the host binding.`);
  matchDigest(L, "status_digest", status.status_digest, digestFor(WORKSPACE_STATUS_SCHEMA, omit(status, ["status_digest"])));
  return Object.freeze(status);
}
