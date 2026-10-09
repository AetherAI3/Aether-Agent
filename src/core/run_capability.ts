import { TOOL_DEFINITIONS } from "./tool_registry.js";
import type { SkillRefusal } from "./skills/skill_errors.js";
import type { PermissionEnvelope } from "./skills/skill_policy.js";

/** Invocation authority, never inferred from the task text or model arguments. */
export type RunCapability = "coding" | "planning";

export const PLANNING_TOOLS = ["read_file", "list_directory", "repo_search"] as const;
const planningTools = new Set<string>(PLANNING_TOOLS);

export function planningEnvelope(): PermissionEnvelope {
  return new Set(["workspace.read"]);
}

export function refuseRunCapability(tool: string, capability: RunCapability): SkillRefusal | null {
  if (capability !== "planning") return null;
  if (planningTools.has(tool) && TOOL_DEFINITIONS[tool as keyof typeof TOOL_DEFINITIONS]?.sideEffect === "read") return null;
  return {
    code: "run.capability_denied",
    detail: `planning permits only workspace inspection; ${tool} cannot run`,
    context: { capability, tool, effective_allowed_tools: PLANNING_TOOLS },
  };
}
