// Managed group registry — the durable record of which process groups this
// device is holding under a Job Object, and under whose lease and fence.
//
// The registry is the enforcement point for the contract's single hardest rule:
// NEVER allowlist by basename. A registration is accepted only if its exe_path
// is an absolute path to a file that exists AND whose sha256 recomputed from
// disk matches the recorded exe_sha256. A process named `node.exe` in a
// writable directory therefore cannot inherit another group's authority — the
// hash is bound to the exact bytes on disk at registration time.
//
// Stale registrations (past their expiry) are pruned on read so a crashed
// daemon cannot leave an entry that authorises a kill forever.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { atomicWriteFile, readJsonFile, withFileLock } from "../durable_store.js";
import { PROCESS_GROUP_SCHEMA, type ProcessGroupRegistration } from "./contract.js";
import { deviceRuntimeDir, groupRegistryPath, runtimeLockPath } from "./paths.js";

export interface RegistryDeps {
  hashFileSha256?: (path: string) => string;
  fileExists?: (path: string) => boolean;
  now?: () => number;
}

const REGISTRY_VERSION = 1;

interface RegistryFile {
  version: number;
  groups: ProcessGroupRegistration[];
}

function defaultHashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function resolveDeps(deps: RegistryDeps): Required<RegistryDeps> {
  return {
    hashFileSha256: deps.hashFileSha256 ?? defaultHashFile,
    fileExists: deps.fileExists ?? existsSync,
    now: deps.now ?? Date.now,
  };
}

/**
 * Return the reason a registration must be rejected, or null if it is
 * acceptable. Exposed so tests can assert each rejection independently. The
 * sha256 check re-reads the file from disk — a caller-supplied hash is never
 * trusted, so a basename spoof with a fabricated hash is caught here.
 */
export function registrationRejectReason(
  reg: ProcessGroupRegistration,
  deps: RegistryDeps = {},
): string | null {
  const d = resolveDeps(deps);
  if (reg.schema !== PROCESS_GROUP_SCHEMA) return "wrong schema";
  if (!reg.process_group_id) return "missing process_group_id";
  if (!reg.exe_path || !isAbsolute(reg.exe_path)) return "exe_path is not an absolute path";
  if (!d.fileExists(reg.exe_path)) return "exe_path does not exist";
  if (!/^[0-9a-f]{64}$/.test(reg.exe_sha256)) return "exe_sha256 is not a sha256 hex digest";
  let actual: string;
  try {
    actual = d.hashFileSha256(reg.exe_path);
  } catch {
    return "exe_path could not be hashed";
  }
  if (actual !== reg.exe_sha256) return "exe_sha256 does not match the file on disk";
  if (!Number.isInteger(reg.parent_pid) || reg.parent_pid <= 0) return "parent_pid is invalid";
  if (!Number.isInteger(reg.parent_start_time_ms) || reg.parent_start_time_ms < 0) return "parent_start_time_ms is invalid";
  if (!Number.isInteger(reg.lease_epoch) || reg.lease_epoch < 0) return "lease_epoch is invalid";
  if (!reg.fence_token) return "missing fence_token";
  if (!Number.isInteger(reg.expires_at)) return "expires_at is invalid";
  return null;
}

function readRegistry(): RegistryFile {
  const read = readJsonFile<RegistryFile>(groupRegistryPath());
  if (!read.ok) return { version: REGISTRY_VERSION, groups: [] };
  const value = read.value;
  if (!value || !Array.isArray(value.groups)) return { version: REGISTRY_VERSION, groups: [] };
  return { version: REGISTRY_VERSION, groups: value.groups };
}

function writeRegistry(file: RegistryFile): void {
  mkdirSync(deviceRuntimeDir(), { recursive: true, mode: 0o700 });
  atomicWriteFile(groupRegistryPath(), JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
}

/** Register (or refresh) a managed group. Throws if it fails validation. */
export function registerGroup(reg: ProcessGroupRegistration, deps: RegistryDeps = {}): void {
  const reason = registrationRejectReason(reg, deps);
  if (reason) throw new Error(`refusing managed group registration: ${reason}`);
  mkdirSync(deviceRuntimeDir(), { recursive: true, mode: 0o700 });
  withFileLock(runtimeLockPath(), "device-registry-write", () => {
    const file = readRegistry();
    const groups = file.groups.filter((g) => g.process_group_id !== reg.process_group_id);
    groups.push(reg);
    writeRegistry({ version: REGISTRY_VERSION, groups });
  });
}

/** Fetch one registration, or undefined if absent or expired. */
export function getGroup(group_id: string, deps: RegistryDeps = {}): ProcessGroupRegistration | undefined {
  const now = resolveDeps(deps).now();
  return readRegistry().groups.find((g) => g.process_group_id === group_id && g.expires_at > now);
}

/** All currently-live (non-expired) registrations. */
export function listGroups(deps: RegistryDeps = {}): ProcessGroupRegistration[] {
  const now = resolveDeps(deps).now();
  return readRegistry().groups.filter((g) => g.expires_at > now);
}

/** Remove one registration. Returns true if it was present. */
export function removeGroup(group_id: string): boolean {
  return withFileLock(runtimeLockPath(), "device-registry-remove", () => {
    const file = readRegistry();
    const groups = file.groups.filter((g) => g.process_group_id !== group_id);
    const removed = groups.length !== file.groups.length;
    if (removed) writeRegistry({ version: REGISTRY_VERSION, groups });
    return removed;
  });
}

/** Drop every registration past its expiry. Returns the number removed. */
export function pruneExpired(deps: RegistryDeps = {}): number {
  const now = resolveDeps(deps).now();
  return withFileLock(runtimeLockPath(), "device-registry-prune", () => {
    const file = readRegistry();
    const groups = file.groups.filter((g) => g.expires_at > now);
    const removed = file.groups.length - groups.length;
    if (removed > 0) writeRegistry({ version: REGISTRY_VERSION, groups });
    return removed;
  });
}
