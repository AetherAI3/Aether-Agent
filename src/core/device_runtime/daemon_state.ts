// Daemon state file — the daemon's public heartbeat, written 0600 for the CLI
// (`aether device status`) to read. It carries only non-secret runtime facts;
// the enrollment secret never lands here.

import { mkdirSync } from "node:fs";
import { atomicWriteFile, readJsonFile } from "../durable_store.js";
import { daemonStatePath, deviceRuntimeDir } from "./paths.js";

export const DAEMON_STATE_SCHEMA = "aether.device.daemon-state/1" as const;

export interface DaemonState {
  schema: typeof DAEMON_STATE_SCHEMA;
  pid: number;
  started_at: number;
  updated_at: number;
  device_id: string;
  boot_id: string;
  last_publish_seq: number;
  last_command_id: string | null;
  throttled: boolean;
  queue_depth: number;
  online: boolean;
  agent_version: string;
}

export function writeDaemonState(state: DaemonState): void {
  mkdirSync(deviceRuntimeDir(), { recursive: true, mode: 0o700 });
  atomicWriteFile(daemonStatePath(), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

export function readDaemonState(): DaemonState | null {
  const read = readJsonFile<DaemonState>(daemonStatePath());
  if (!read.ok) return null;
  const v = read.value;
  if (!v || v.schema !== DAEMON_STATE_SCHEMA || typeof v.pid !== "number") return null;
  return v;
}

/** True when a process with this pid is alive (used to tell running from stale). */
export function daemonPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
