// Canonical closed permission vocabulary for Agent Skills and the capability
// contract. One list, used by skill validation, the runtime policy gate, the
// capability manifest, and doctor. Adding a name here is a contract change.

import type { ToolName } from "../brain_protocol.js";

export const PERMISSIONS = [
  "workspace.read",
  "workspace.write",
  "workspace.outside",
  "shell.test",
  "shell.execute",
  "git.read",
  "git.stage",
  "git.commit",
  "git.push",
  "network.github.read",
  "network.general",
  "network.loopback",
  "secrets.read",
  "billing.spend",
  "artifact.publish",
] as const;

export type PermissionName = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermissionName(value: string): value is PermissionName {
  return PERMISSION_SET.has(value);
}

/**
 * The one permission each canonical tool requires. A tool absent from a
 * skill's allowed list is refused before this map is even consulted; this map
 * decides which operator permission must ALSO be live for the call to run.
 * Every ToolName must appear — validateToolPermissionCoverage() enforces it.
 */
export const TOOL_PERMISSIONS: Readonly<Record<ToolName, PermissionName>> = {
  read_file: "workspace.read",
  list_directory: "workspace.read",
  patch_file: "workspace.write",
  repo_search: "workspace.read",
  write_file: "workspace.write",
  run_shell: "shell.execute",
  run_tests: "shell.test",
  git_commit: "git.commit",
  web_search: "network.general",
  web_fetch: "network.general",
};

/**
 * Permissions a skill may never obtain through declaration alone. These need
 * an explicit operator grant outside any skill; a manifest listing one under
 * `requires` or `may_request` is schema-invalid, not merely denied at runtime.
 */
export const SKILL_UNDECLARABLE_PERMISSIONS: readonly PermissionName[] = [
  "workspace.outside",
  "secrets.read",
  "billing.spend",
];

export function validateToolPermissionCoverage(tools: readonly string[]): string[] {
  const mapped = Object.keys(TOOL_PERMISSIONS).sort();
  const canonical = [...tools].sort();
  return mapped.length === canonical.length && mapped.every((name, index) => name === canonical[index])
    ? []
    : ["tool permission map does not exactly cover the frozen protocol tool set"];
}
