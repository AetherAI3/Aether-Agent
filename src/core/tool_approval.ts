import { validateToolCall, type ValidatedToolArgs } from "./tool_registry.js";
import { decideGate } from "./autonomy.js";
import type { PermissionMode } from "../types.js";

/** A validated, copied call is the only call that may follow this review. */
export function prepareToolApproval(
  name: string,
  rawArgs: unknown,
  configuredTestCommand = "",
): { ok: true; args: ValidatedToolArgs; binding: string } | { ok: false; error: string } {
  const validation = validateToolCall(name, rawArgs);
  if (!validation.ok) return validation;
  const args = { ...validation.args };
  // run_tests can execute the host's configured command when the model omits
  // one. Materialize that command before review so the visible and executed
  // strings agree.
  if (name === "run_tests" && !args["command"] && configuredTestCommand) {
    args["command"] = configuredTestCommand;
  }
  const binding = toolCallBinding(name, args);
  if (binding === null) return { ok: false, error: "configured test command is invalid" };
  return { ok: true, args, binding };
}

/** Canonical form after tool-registry validation, independent of object key order. */
export function toolCallBinding(name: string, rawArgs: unknown): string | null {
  const validation = validateToolCall(name, rawArgs);
  return validation.ok ? JSON.stringify([name, validation.args]) : null;
}

/** Render every byte of a command without letting terminal controls take effect. */
export function terminalSafeReview(value: string, preserveNewlines = true): string {
  return value.replace(/[\\\x00-\x1f\x7f-\x9f\u2028\u2029\p{Cf}]/gu, (character) => {
    if (character === "\\") return "\\\\";
    if (character === "\n") return preserveNewlines ? "\n" : "\\n";
    if (character === "\t") return "\\t";
    if (character === "\r") return "\\r";
    const code = character.codePointAt(0)!;
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

export function formatToolApprovalReview(
  name: string,
  args: ValidatedToolArgs,
  shellCwd: string,
  fileRoot: string,
  patchPreview?: string,
): string {
  const field = name === "run_shell" || name === "run_tests"
    ? "command"
    : name === "git_commit" ? "message" : "path";
  const detail = args[field];
  const lines = typeof detail === "string" && detail.length > 0
    ? terminalSafeReview(detail).split("\n").map((line, index) => `  ${index + 1} | ${line}`).join("\n")
    : "  (no command configured)";
  const diff = name === "patch_file" && patchPreview
    ? `\nAffected diff (escaped for terminal safety):\n${terminalSafeReview(patchPreview)}\n`
    : "";
  return `\nModel-requested tool approval\nTool: ${name}\nShell cwd: ${terminalSafeReview(shellCwd, false)}\nFile root: ${terminalSafeReview(fileRoot, false)}\n${field} (numbered rows preserve line breaks; controls and backslashes are escaped):\n${lines}${diff}\nRun this exact tool call? [y/N] `;
}

export interface ToolApprovalRequest {
  name: string;
  args: ValidatedToolArgs;
  permissionMode: PermissionMode;
  autoApply: boolean;
  yes: boolean;
  isTty: boolean;
  shellCwd: string;
  fileRoot: string;
  patchPreview?: string;
  confirm: (review: string) => Promise<boolean>;
  onDeny: () => void;
}

export async function requestToolApproval(request: ToolApprovalRequest): Promise<boolean> {
  const outcome = decideGate(request.name, request.permissionMode, request.autoApply, {
    yes: request.yes,
    isTty: request.isTty,
  });
  if (outcome === "allow") return true;
  if (outcome === "deny") {
    request.onDeny();
    return false;
  }
  return request.confirm(formatToolApprovalReview(
    request.name, request.args, request.shellCwd, request.fileRoot, request.patchPreview,
  ));
}
