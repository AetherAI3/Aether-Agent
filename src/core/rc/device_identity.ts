// Observer-only RC identity. The installation UUID is a label seed, not a
// bearer credential; Cloud combines it with the authenticated account owner.
// SC-DEVICE enrollment and its command authority remain separate.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { configDir } from "../config.js";
import { atomicWriteFile, readJsonFile, withFileLock } from "../durable_store.js";
import type { ApiClient } from "../transport.js";

const SCHEMA = "aether.remote_device_identity.v1";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RC_DEVICE_ID = /^rcd_[0-9a-f]{32}$/;

export function rcInstallationPath(): string {
  return join(configDir(), "rc", "device-identity.json");
}

/** Fail closed on an unreadable identity; never silently switch device IDs. */
export function loadOrCreateRcInstallationId(path = rcInstallationPath()): string {
  return withFileLock(`${path}.lock`, "rc-device-identity", () => {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error("RC device identity file is a link");
    }
    const prior = readJsonFile<unknown>(path);
    if (prior.ok) {
      const value = prior.value as { schema_version?: unknown; installation_id?: unknown };
      if (value?.schema_version !== SCHEMA || typeof value.installation_id !== "string" || !UUID_V4.test(value.installation_id)) {
        throw new Error("RC device identity file is invalid");
      }
      return value.installation_id;
    }
    if (prior.reason !== "missing") throw new Error("RC device identity file is unreadable or corrupt");
    const installationId = randomUUID();
    atomicWriteFile(path, JSON.stringify({ schema_version: SCHEMA, installation_id: installationId }) + "\n", { mode: 0o600 });
    return installationId;
  });
}

export async function resolveRcDeviceIdentity(
  api: ApiClient,
  path = rcInstallationPath(),
): Promise<{ device_id: string; display_name: string }> {
  const installation_id = loadOrCreateRcInstallationId(path);
  const raw = await api.postJson<unknown>("/remote/device-identity", { installation_id }, undefined, 10_000);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Cloud returned an invalid RC identity");
  const value = raw as Record<string, unknown>;
  if (value["schema_version"] !== SCHEMA || typeof value["device_id"] !== "string" || !RC_DEVICE_ID.test(value["device_id"])) {
    throw new Error("Cloud returned an invalid RC identity");
  }
  return { device_id: value["device_id"], display_name: hostname() };
}
