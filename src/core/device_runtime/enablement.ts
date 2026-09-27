// The single decision that keeps the device runtime default-OFF.
//
// The daemon starts only when the operator has explicitly opted in, by one of
// two independent switches: `deviceRuntime.enabled === true` in config, or the
// AETHER_DEVICE_RUNTIME=1 environment variable. Anything else — an absent key,
// `enabled: false`, an unset or any-other-value env var — is off, and the
// daemon refuses to run. Kept in one function so every entry point (CLI start,
// the daemon's own self-check, the doctor report) reads the same rule.

import type { AetherConfig } from "../../types.js";

export function deviceRuntimeEnabled(cfg: AetherConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["AETHER_DEVICE_RUNTIME"] === "1") return true;
  return cfg.deviceRuntime?.enabled === true;
}
