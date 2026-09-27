// Shared scaffolding for the SC-DEVICE-01 device-runtime suites.
//
// Every device-runtime module resolves its state through core/config.ts's
// `configDir()`, which honours AETHER_CONFIG_DIR. Pointing that at a throwaway
// directory for the duration of a test is therefore the whole isolation story:
// the enrollment record, the boot identity, the group registry, the command
// chain and the daemon state file all land inside it and nothing touches a real
// `~/.config/aether`.
//
// The suite runs with `--test-isolation=none`, so every test shares one process
// and one `process.env`. The setter here is therefore strictly save/restore —
// a test that forgets to restore would leak its sandbox into every later file.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, hmacSha256Hex } from "../src/core/device_runtime/canonical_json.js";
import { COMMAND_SCHEMA, PROCESS_GROUP_SCHEMA, type DeviceCommand, type ProcessGroupRegistration } from "../src/core/device_runtime/contract.js";

/** Run `body` with AETHER_CONFIG_DIR pointed at a fresh throwaway directory. */
export function withDeviceSandbox<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "aether-device-"));
  const priorConfig = process.env["AETHER_CONFIG_DIR"];
  const priorRuntime = process.env["AETHER_DEVICE_RUNTIME"];
  process.env["AETHER_CONFIG_DIR"] = dir;
  // The enablement switch is an env var; a stale one from another suite would
  // silently turn the "default-off" assertions into false passes.
  delete process.env["AETHER_DEVICE_RUNTIME"];
  try {
    return body(dir);
  } finally {
    if (priorConfig === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = priorConfig;
    if (priorRuntime === undefined) delete process.env["AETHER_DEVICE_RUNTIME"];
    else process.env["AETHER_DEVICE_RUNTIME"] = priorRuntime;
  }
}

/** Async variant of {@link withDeviceSandbox}. */
export async function withDeviceSandboxAsync<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "aether-device-"));
  const priorConfig = process.env["AETHER_CONFIG_DIR"];
  const priorRuntime = process.env["AETHER_DEVICE_RUNTIME"];
  process.env["AETHER_CONFIG_DIR"] = dir;
  delete process.env["AETHER_DEVICE_RUNTIME"];
  try {
    return await body(dir);
  } finally {
    if (priorConfig === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = priorConfig;
    if (priorRuntime === undefined) delete process.env["AETHER_DEVICE_RUNTIME"];
    else process.env["AETHER_DEVICE_RUNTIME"] = priorRuntime;
  }
}

/** Write a throwaway file and return `{ path, sha256 }` — a stand-in "executable". */
export function fakeExecutable(dir: string, name: string, contents: string): { path: string; sha256: string } {
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return { path, sha256: createHash("sha256").update(contents, "utf8").digest("hex") };
}

export const TEST_COMMAND_KEY = "test-device-command-key-0123456789";
export const TEST_DEVICE_ID = "dev_test_0001";

export interface CommandOverrides {
  command_id?: string;
  device_id?: string;
  outbox_seq?: number;
  prev_digest?: string;
  issued_at?: number;
  expires_at?: number;
  command_class?: DeviceCommand["command_class"];
  process_group_id?: string | null;
  lease_epoch?: number;
  fence_token?: string;
  payload?: Record<string, unknown>;
  policy_digest?: string;
}

/**
 * Mint a correctly-signed DeviceCommand. Tests then corrupt exactly ONE field
 * per red-team case, so a rejection can only be attributed to that field.
 */
export function signedCommand(overrides: CommandOverrides = {}, key = TEST_COMMAND_KEY): DeviceCommand {
  const core = {
    schema: COMMAND_SCHEMA,
    command_id: overrides.command_id ?? randomUUID(),
    device_id: overrides.device_id ?? TEST_DEVICE_ID,
    outbox_seq: overrides.outbox_seq ?? 1,
    prev_digest: overrides.prev_digest ?? `sha256:${"0".repeat(64)}`,
    issued_at: overrides.issued_at ?? 1_000_000,
    expires_at: overrides.expires_at ?? 9_000_000,
    command_class: overrides.command_class ?? ("noop" as const),
    process_group_id: overrides.process_group_id ?? null,
    lease_epoch: overrides.lease_epoch ?? 1,
    fence_token: overrides.fence_token ?? "fence-1",
    payload: overrides.payload ?? {},
    policy_digest: overrides.policy_digest ?? `sha256:${"a".repeat(64)}`,
  };
  const digest = `sha256:${createHash("sha256").update(canonicalJson(core), "utf8").digest("hex")}`;
  return { ...core, digest, signature: hmacSha256Hex(key, digest) };
}

/** A valid ProcessGroupRegistration for `exe`, overridable field by field. */
export function groupRegistration(
  exe: { path: string; sha256: string },
  overrides: Partial<ProcessGroupRegistration> = {},
): ProcessGroupRegistration {
  return {
    schema: PROCESS_GROUP_SCHEMA,
    process_group_id: overrides.process_group_id ?? "grp-1",
    device_id: overrides.device_id ?? TEST_DEVICE_ID,
    owner: "operator",
    project: "aether",
    workspace_id: "ws-1",
    task_id: "task-1",
    exe_path: overrides.exe_path ?? exe.path,
    exe_sha256: overrides.exe_sha256 ?? exe.sha256,
    trusted_publisher: null,
    parent_pid: overrides.parent_pid ?? 4242,
    parent_start_time_ms: overrides.parent_start_time_ms ?? 1_700_000_000_000,
    job_object_name: "aether-dev-grp-1",
    command_classes: ["throttle", "drain_checkpoint", "emergency_terminate"],
    lease_epoch: overrides.lease_epoch ?? 1,
    fence_token: overrides.fence_token ?? "fence-1",
    expires_at: overrides.expires_at ?? 9_000_000,
    policy_digest: `sha256:${"a".repeat(64)}`,
    registered_at: 1_000_000,
    ...(overrides.schema ? { schema: overrides.schema } : {}),
  };
}
