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
  return `\nModel-requested tool approval\nTool: ${name}\nShell cwd: ${terminalSafeReview(shellCwd, false)}\nFile root: ${terminalSafeReview(fileRoot, false)}\n${field} (numbered rows preserve line breaks; controls and backslashes are escaped):\n${lines}${diff}\nDeclining offers an optional one-call instruction.\nRun this exact tool call? [y/N] `;
}

export const MAX_DENIAL_FEEDBACK_BYTES = 512;

/** Feedback is inert tool-result text, never a command or an approval. */
export function boundedDenialFeedback(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\r\n\t]+/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\p{Cf}]/gu, "").trim();
  let bounded = "";
  for (const character of cleaned) {
    if (Buffer.byteLength(bounded + character, "utf8") > MAX_DENIAL_FEEDBACK_BYTES) break;
    bounded += character;
  }
  return bounded || null;
}

export interface ToolApprovalVerdict {
  readonly callId: string;
  readonly approved: boolean;
  /** Present only for a declined, interactive call. */
  readonly feedback?: string;
}

/** Existing embedders may still return a boolean; bind it to this exact call. */
export function bindToolApprovalVerdict(callId: string, decision: ToolApprovalVerdict | boolean): ToolApprovalVerdict {
  if (typeof decision === "boolean") return { callId, approved: decision };
  if (decision.callId !== callId) return { callId, approved: false };
  if (decision.approved) return { callId, approved: true };
  const feedback = boundedDenialFeedback(decision.feedback);
  return { callId, approved: false, ...(feedback ? { feedback } : {}) };
}

export function deniedToolResult(name: string, verdict: ToolApprovalVerdict): { output: string; exitCode: number } {
  const base = `[denied: ${name} not approved by user]`;
  return { output: verdict.feedback ? `${base}\nOperator instruction for this denied call: ${verdict.feedback}` : base, exitCode: 1 };
}

export interface ToolApprovalRequest {
  callId: string;
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
  feedback?: () => Promise<string | null>;
  onDeny: () => void;
}

export async function requestToolApproval(request: ToolApprovalRequest): Promise<ToolApprovalVerdict> {
  const outcome = decideGate(request.name, request.permissionMode, request.autoApply, {
    yes: request.yes,
    isTty: request.isTty,
  });
  if (outcome === "allow") return { callId: request.callId, approved: true };
  if (outcome === "deny") {
    request.onDeny();
    return { callId: request.callId, approved: false };
  }
  const approved = await request.confirm(formatToolApprovalReview(
    request.name, request.args, request.shellCwd, request.fileRoot, request.patchPreview,
  ));
  if (approved) return { callId: request.callId, approved: true };
  const feedback = boundedDenialFeedback(await request.feedback?.());
  return { callId: request.callId, approved: false, ...(feedback ? { feedback } : {}) };
}
