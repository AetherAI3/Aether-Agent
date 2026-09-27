// Where the device runtime keeps its private state. Everything lives under the
// same 0700 config directory the token store uses, so a single owner-only
// directory covers the enrollment secret, the per-boot identity, the managed
// group registry and the daemon state file. Tests point AETHER_CONFIG_DIR at a
// throwaway directory, so nothing here reads an absolute path of its own.

import { join } from "node:path";
import { configDir } from "../config.js";

/** The enrollment record (device_id, device token, command key) — 0600, beside
 *  the CLI's `.token`, following the same FileTokenStore hardening. */
export function enrollmentPath(): string {
  return join(configDir(), "device.json");
}

/** Private state directory for the daemon's non-secret runtime files. */
export function deviceRuntimeDir(): string {
  return join(configDir(), "device-runtime");
}

export function bootStatePath(): string {
  return join(deviceRuntimeDir(), "boot.json");
}

export function daemonStatePath(): string {
  return join(deviceRuntimeDir(), "state.json");
}

export function groupRegistryPath(): string {
  return join(deviceRuntimeDir(), "groups.json");
}

export function commandChainPath(): string {
  return join(deviceRuntimeDir(), "chain.json");
}

/** Lock guarding read-modify-write of the command chain state. Distinct from the
 *  runtime lock so command execution can call the group registry (which takes
 *  the runtime lock) without self-deadlocking. */
export function commandChainLockPath(): string {
  return join(deviceRuntimeDir(), "chain.lock");
}

export function checkpointDir(): string {
  return join(deviceRuntimeDir(), "checkpoints");
}

/** Lock file guarding cross-process mutation of the runtime state files. */
export function runtimeLockPath(): string {
  return join(deviceRuntimeDir(), "runtime.lock");
}
