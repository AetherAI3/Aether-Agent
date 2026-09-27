// `aether device doctor` — a HealthReport (schema v2) over the device runtime.
//
// It reports the three-axis model core/health.ts defines: whether each surface
// is CONFIGURED, whether it is REACHABLE, and whether it was VERIFIED end to end
// during this run. Cached daemon state is reported with its own timestamp and
// never rendered as fresh verification.

import {
  axis,
  buildReport,
  notApplicable,
  notChecked,
  type HealthCheck,
  type HealthReport,
} from "../health.js";
import type { AetherConfig } from "../../types.js";
import { deviceRuntimeEnabled } from "./enablement.js";
import { loadEnrollment } from "./identity.js";
import { listGroups } from "./registry.js";
import { daemonPidAlive, readDaemonState } from "./daemon_state.js";

export const STALE_PUBLISH_MS = 30_000;

export interface DoctorProbes {
  /** Cloud /device/v1/health reachability. */
  cloud: () => Promise<{ reachable: boolean; status: number | null; latencyMs: number }>;
  /** Whether a Job Object warden could be created (win32 capability probe). */
  jobObject: () => Promise<boolean>;
  /** Whether the boot-persistence scheduled task exists. */
  scheduledTask: () => boolean;
  now: () => number;
}

export async function buildDeviceDoctorReport(cfg: AetherConfig, probes: DoctorProbes): Promise<HealthReport> {
  const now = probes.now();
  const checks: HealthCheck[] = [];

  const enrolled = loadEnrollment();
  checks.push({
    id: "device.enrollment",
    category: "device",
    title: "Device enrollment",
    configured: axis(enrolled ? "yes" : "no", { evidence: enrolled ? `device_id ${enrolled.device_id}` : "no device.json" }),
    reachable: notApplicable("local file"),
    verified: axis(enrolled ? "yes" : "no"),
    severity: enrolled ? "info" : "warning",
    ...(enrolled ? {} : { remediation: "run `aether device enroll`" }),
  });

  const enabled = deviceRuntimeEnabled(cfg);
  checks.push({
    id: "device.enabled",
    category: "device",
    title: "Runtime opt-in",
    configured: axis(enabled ? "yes" : "no", { evidence: enabled ? "enabled" : "default-off" }),
    reachable: notApplicable("configuration"),
    verified: axis(enabled ? "yes" : "no"),
    severity: enabled ? "info" : "info",
    ...(enabled ? {} : { remediation: "enable with config deviceRuntime.enabled or AETHER_DEVICE_RUNTIME=1" }),
  });

  const state = readDaemonState();
  const running = state ? daemonPidAlive(state.pid) : false;
  checks.push({
    id: "device.daemon",
    category: "device",
    title: "Daemon process",
    configured: axis(state ? "yes" : "no", { evidence: state ? `pid ${state.pid}` : "no state file" }),
    reachable: axis(running ? "yes" : "no"),
    verified: running ? axis("yes") : notChecked("daemon not running"),
    severity: running ? "info" : enabled ? "warning" : "info",
    ...(running ? {} : { remediation: "start it with `aether device start`" }),
  });

  const publishAgeMs = state ? now - state.updated_at : null;
  const fresh = publishAgeMs !== null && publishAgeMs <= STALE_PUBLISH_MS;
  checks.push({
    id: "device.publish",
    category: "device",
    title: "Last publish age",
    configured: axis(state ? "yes" : "no"),
    reachable: notApplicable("local heartbeat"),
    verified: publishAgeMs === null
      ? notChecked("never published")
      : axis(fresh ? "yes" : "no", { evidence: `${Math.round(publishAgeMs / 1000)}s ago`, ...(state ? { checkedAt: new Date(state.updated_at).toISOString() } : {}) }),
    severity: fresh ? "info" : running ? "warning" : "info",
  });

  const cloud = await probes.cloud();
  checks.push({
    id: "device.cloud",
    category: "device",
    title: "Cloud reachability",
    configured: axis("yes", { evidence: "/device/v1/health" }),
    reachable: axis(cloud.reachable ? "yes" : "no", { latencyMs: cloud.latencyMs, ...(cloud.status !== null ? { evidence: `HTTP ${cloud.status}` } : {}) }),
    verified: axis(cloud.reachable ? "yes" : "no", { checkedAt: new Date(now).toISOString() }),
    severity: cloud.reachable ? "info" : "warning",
  });

  const jobObjectOk = await probes.jobObject();
  checks.push({
    id: "device.job_object",
    category: "device",
    title: "Job Object containment",
    configured: axis(process.platform === "win32" ? "yes" : "na", { evidence: process.platform }),
    reachable: notApplicable("local capability"),
    verified: process.platform === "win32" ? axis(jobObjectOk ? "yes" : "no") : notApplicable("non-Windows"),
    severity: process.platform === "win32" && !jobObjectOk ? "warning" : "info",
  });

  const taskPresent = probes.scheduledTask();
  checks.push({
    id: "device.scheduled_task",
    category: "device",
    title: "Boot-persistence task",
    configured: axis(taskPresent ? "yes" : "no", { evidence: taskPresent ? "scheduled task present" : "not installed" }),
    reachable: notApplicable("local"),
    verified: axis(taskPresent ? "yes" : "no"),
    severity: "info",
    ...(taskPresent ? {} : { remediation: "optional: `aether device install-service`" }),
  });

  checks.push({
    id: "device.managed_groups",
    category: "device",
    title: "Managed process groups",
    configured: axis("yes", { evidence: `${listGroups({ now: () => now }).length} live` }),
    reachable: notApplicable("local registry"),
    verified: axis("yes"),
    severity: "info",
  });

  return buildReport("live", checks, new Date(now).toISOString());
}
