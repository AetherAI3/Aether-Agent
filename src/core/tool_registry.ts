import { TOOLS, type ToolName } from "./brain_protocol.js";

export type ToolSideEffect = "read" | "write" | "shell" | "git" | "network";

export interface StringArgument {
  type: "string";
  required?: boolean;
  allowEmpty?: boolean;
  maxBytes: number;
}

export interface IntegerArgument {
  type: "integer";
  required?: boolean;
  min: number;
  max: number;
}

export type ToolArgument = StringArgument | IntegerArgument;

export interface ToolDefinition {
  sideEffect: ToolSideEffect;
  args: Readonly<Record<string, ToolArgument>>;
}

const stringArg = (
  maxBytes: number,
  required = true,
  allowEmpty = false,
): StringArgument => ({ type: "string", maxBytes, required, allowEmpty });

export const TOOL_DEFINITIONS: Readonly<Record<ToolName, ToolDefinition>> = {
  read_file: {
    sideEffect: "read",
    args: { path: stringArg(4096), start_line: { type: "integer", required: false, min: 1, max: 1_000_000 }, max_lines: { type: "integer", required: false, min: 1, max: 200 }, offset: { type: "integer", required: false, min: 0, max: Number.MAX_SAFE_INTEGER }, max_bytes: { type: "integer", required: false, min: 4, max: 4096 }, expected_revision: stringArg(128, false) },
  },
  list_directory: {
    sideEffect: "read",
    args: { path: stringArg(4096), cursor: stringArg(4096, false), limit: { type: "integer", required: false, min: 1, max: 100 } },
  },
  patch_file: {
    sideEffect: "write",
    args: { path: stringArg(4096), expected_sha256: stringArg(64), old_text: stringArg(1024 * 1024, true, true), new_text: stringArg(1024 * 1024, true, true), start_line: { type: "integer", required: false, min: 1, max: 1_000_000 } },
  },
  write_file: {
    sideEffect: "write",
    args: { path: stringArg(4096), content: stringArg(1024 * 1024, true, true) },
  },
  run_shell: {
    sideEffect: "shell",
    args: { command: stringArg(32 * 1024) },
  },
  run_tests: {
    sideEffect: "shell",
    args: { command: stringArg(32 * 1024, false, true) },
  },
  repo_search: {
    sideEffect: "read",
    args: { query: stringArg(4096) },
  },
  git_commit: {
    sideEffect: "git",
    args: { message: stringArg(4096) },
  },
  web_search: {
    sideEffect: "network",
    args: {
      query: stringArg(4096),
      limit: { type: "integer", required: false, min: 1, max: 10 },
    },
  },
  web_fetch: {
    sideEffect: "network",
    args: { url: stringArg(8192) },
  },
};

export type ValidatedToolArgs = Record<string, string | number>;

export type ToolValidation =
  | { ok: true; name: ToolName; args: ValidatedToolArgs }
  | { ok: false; error: string };

export function toolDefinition(name: string): ToolDefinition | undefined {
  return Object.prototype.hasOwnProperty.call(TOOL_DEFINITIONS, name)
    ? TOOL_DEFINITIONS[name as ToolName]
    : undefined;
}

export function validateToolCall(name: string, rawArgs: unknown): ToolValidation {
  const definition = toolDefinition(name);
  if (!definition) return { ok: false, error: "unknown tool" };
  if (rawArgs == null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return { ok: false, error: "arguments must be an object" };
  }
  const args = rawArgs as Record<string, unknown>;
  const allowed = new Set(Object.keys(definition.args));
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length) return { ok: false, error: "unknown argument: " + unknown.sort()[0] };

  const validated: ValidatedToolArgs = {};
  for (const [key, rule] of Object.entries(definition.args)) {
    const value = args[key];
    if (value == null) {
      if (rule.required) return { ok: false, error: "missing argument: " + key };
      continue;
    }
    if (rule.type === "string") {
      if (typeof value !== "string") return { ok: false, error: key + " must be a string" };
      if (!rule.allowEmpty && value.length === 0) return { ok: false, error: key + " must not be empty" };
      if (Buffer.byteLength(value, "utf8") > rule.maxBytes) {
        return { ok: false, error: key + " exceeds " + rule.maxBytes + " bytes" };
      }
      validated[key] = value;
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return { ok: false, error: key + " must be an integer" };
    }
    if (value < rule.min || value > rule.max) {
      return { ok: false, error: key + " must be from " + rule.min + " to " + rule.max };
    }
    validated[key] = value;
  }
  if (name === "read_file" && (validated["start_line"] !== undefined || validated["max_lines"] !== undefined)
    && (validated["offset"] !== undefined || validated["max_bytes"] !== undefined)) {
    return { ok: false, error: "line and byte ranges cannot be combined" };
  }
  return { ok: true, name: name as ToolName, args: validated };
}

export function validateToolDefinitionCoverage(): string[] {
  const names = Object.keys(TOOL_DEFINITIONS).sort();
  const canonical = [...TOOLS].sort();
  return names.length === canonical.length && names.every((name, index) => name === canonical[index])
    ? []
    : ["tool definitions do not exactly cover the frozen protocol tool set"];
}
