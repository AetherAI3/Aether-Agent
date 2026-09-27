// SC-DEVICE-01 wire contract — the frozen schemas, endpoint paths and shared
// types the agent daemon and the Cloud exchange. Every shape here mirrors
// SC-DEVICE-01-CONTRACT.md exactly; do not change a field name or type without
// changing the contract on both sides.

export const OBSERVATION_SCHEMA = "aether.device.observation/1" as const;
export const COMMAND_SCHEMA = "aether.device.command/1" as const;
export const COMMAND_RESULT_SCHEMA = "aether.device.command_result/1" as const;
export const PROCESS_GROUP_SCHEMA = "aether.device.process_group/1" as const;
export const WORKSPACE_HANDOFF_SCHEMA = "aether.workspace-handoff/1" as const;

// All device traffic is outbound-only from the machine; the Cloud exposes these
// under /device/v1/*. There is never an inbound Windows listener.
export const DEVICE_ENROLL_PATH = "/device/v1/enroll";
export const DEVICE_OBSERVE_PATH = "/device/v1/observe";
export const DEVICE_COMMANDS_POLL_PATH = "/device/v1/commands/poll";
export const DEVICE_GROUPS_PATH = "/device/v1/groups";
export const DEVICE_HANDOFF_PATH = "/device/v1/handoff";
export const DEVICE_HEALTH_PATH = "/device/v1/health";
export function deviceCommandResultPath(commandId: string): string {
  return `/device/v1/commands/${encodeURIComponent(commandId)}/result`;
}

export const COMMAND_CLASSES = [
  "throttle",
  "drain_checkpoint",
  "emergency_terminate",
  "resume",
  "observe",
  "revoke_group",
  "noop",
] as const;
export type CommandClass = (typeof COMMAND_CLASSES)[number];

export const COMMAND_RESULT_STATUSES = [
  "accepted",
  "completed",
  "failed",
  "rejected",
  "duplicate",
] as const;
export type CommandResultStatus = (typeof COMMAND_RESULT_STATUSES)[number];

/** DeviceObservation — the sampled telemetry frame (contract §DeviceObservation). */
export interface DeviceObservation {
  schema: typeof OBSERVATION_SCHEMA;
  device_id: string;
  boot_id: string;
  seq: number;
  sampled_at: number;
  cpu_logical: number;
  cpu_util_pct: number;
  mem_total_mb: number;
  mem_avail_mb: number;
  mem_used_pct: number;
  swap_total_mb: number | null;
  swap_used_mb: number | null;
  oom_pressure_pct: number | null;
  disk_workspace_total_gb: number;
  disk_workspace_free_gb: number;
  lanes_active: number;
  lanes_reserved: number;
  workload_count: number;
  capabilities: string[];
  runtime_labels: string[];
  repo: { name: string; revision: string } | null;
  agent_version: string;
  display_name: string;
  /** 120s-window maxima the Cloud recovery watchdog evaluates against. */
  cpu_util_pct_max_120s: number;
  mem_used_pct_max_120s: number;
}

/** DeviceCommand — a signed, chained instruction delivered over long-poll. */
export interface DeviceCommand {
  schema: typeof COMMAND_SCHEMA;
  command_id: string;
  device_id: string;
  outbox_seq: number;
  prev_digest: string;
  issued_at: number;
  expires_at: number;
  command_class: CommandClass;
  process_group_id: string | null;
  lease_epoch: number;
  fence_token: string;
  payload: Record<string, unknown>;
  policy_digest: string;
  digest: string;
  signature: string;
}

/** The signable body of a DeviceCommand — everything except digest + signature. */
export type DeviceCommandCore = Omit<DeviceCommand, "digest" | "signature">;

/** CommandResult — the bounded, redacted acknowledgement posted back per command. */
export interface CommandResult {
  schema: typeof COMMAND_RESULT_SCHEMA;
  command_id: string;
  device_id: string;
  boot_id: string;
  result_seq: number;
  status: CommandResultStatus;
  detail: string;
  receipt: Record<string, unknown>;
  completed_at: number;
}

/** Managed process group registration (contract §Managed process group registration). */
export interface ProcessGroupRegistration {
  schema: typeof PROCESS_GROUP_SCHEMA;
  process_group_id: string;
  device_id: string;
  owner: string;
  project: string;
  workspace_id: string;
  task_id: string;
  exe_path: string;
  exe_sha256: string;
  trusted_publisher: string | null;
  parent_pid: number;
  parent_start_time_ms: number;
  job_object_name: string;
  command_classes: string[];
  lease_epoch: number;
  fence_token: string;
  expires_at: number;
  policy_digest: string;
  registered_at: number;
}

/** WorkspaceHandoff — the portable continuation record (contract §WorkspaceHandoff). */
export interface WorkspaceHandoffV1 {
  schema: typeof WORKSPACE_HANDOFF_SCHEMA;
  handoff_id: string;
  task_id: string;
  lane_id: string;
  dag_node_id: string;
  fence_token: string;
  lease_epoch: number;
  repo: { name: string; revision: string };
  patch_refs: Array<{ ref: string; sha256: string; bytes: number }>;
  change_digest: string;
  test_cmd: string;
  test_verified: boolean;
  remaining_summary: string;
  policy_digest: string;
  skill_digest: string | null;
  protocol_c_refs: string[];
  created_at: number;
  source_device_id: string;
}
