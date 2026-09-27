// Telemetry — a pure, fully injectable sampler that composes a DeviceObservation
// and a serializer with a hard field allowlist.
//
// Everything the sampler reads about the machine comes through TelemetryInputs,
// so a test can drive CPU/memory/disk/swap curves without touching the real OS.
// Two smoothing structures are maintained across samples:
//
//   * an EWMA on cpu_util_pct and mem_used_pct (the contract says these two are
//     agent-smoothed), and
//   * a 120s ring buffer, so each frame also carries cpu_util_pct_max_120s and
//     mem_used_pct_max_120s for the Cloud recovery watchdog.
//
// The observation serializer enforces a CLOSED allowlist: a frame that carries
// any field outside the contract's set — an env var, an argv, a token, a
// prompt, an arbitrary process listing — throws rather than publishes. That is
// the tested guarantee that telemetry can never become an exfiltration channel.

import { cpus as osCpus, freemem as osFreemem, totalmem as osTotalmem } from "node:os";
import { spawnSync } from "node:child_process";
import { statfsSync } from "node:fs";
import {
  OBSERVATION_SCHEMA,
  type DeviceObservation,
} from "./contract.js";

export interface CpuTimesSnapshot {
  /** Cumulative idle ticks summed across all logical CPUs. */
  idle: number;
  /** Cumulative total ticks (idle + busy) summed across all logical CPUs. */
  total: number;
}

export interface DiskSnapshot {
  total_gb: number;
  free_gb: number;
}

export interface SwapSnapshot {
  swap_total_mb: number | null;
  swap_used_mb: number | null;
  oom_pressure_pct: number | null;
}

export interface TelemetryInputs {
  cpuTimes: () => CpuTimesSnapshot;
  cpuLogical: () => number;
  memTotalBytes: () => number;
  memAvailBytes: () => number;
  disk: () => DiskSnapshot;
  swap: () => SwapSnapshot;
  now: () => number;
}

export interface ObservationMeta {
  device_id: string;
  boot_id: string;
  seq: number;
  agent_version: string;
  display_name: string;
  capabilities: string[];
  runtime_labels: string[];
  repo: { name: string; revision: string } | null;
  lanes_active: number;
  lanes_reserved: number;
  workload_count: number;
}

/** Smoothed + windowed metrics one sample produces. */
export interface SampledMetrics {
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
  cpu_util_pct_max_120s: number;
  mem_used_pct_max_120s: number;
}

const WINDOW_MS = 120_000;
const DEFAULT_EWMA_ALPHA = 0.35;

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** Stateful sampler. One instance per daemon; `sample()` is called each tick. */
export class TelemetrySampler {
  private prevCpu: CpuTimesSnapshot | null = null;
  private ewmaCpu: number | null = null;
  private ewmaMem: number | null = null;
  private readonly ring: Array<{ t: number; cpu: number; mem: number }> = [];

  constructor(
    private readonly inputs: TelemetryInputs,
    private readonly alpha: number = DEFAULT_EWMA_ALPHA,
  ) {}

  sample(): SampledMetrics {
    const now = this.inputs.now();

    // CPU utilisation from the delta of cumulative tick counters. The first
    // sample has no prior, so it reports 0 rather than a meaningless absolute.
    const cpu = this.inputs.cpuTimes();
    const hadPrior = this.prevCpu !== null;
    let cpuInstant = 0;
    if (this.prevCpu) {
      const idleDelta = cpu.idle - this.prevCpu.idle;
      const totalDelta = cpu.total - this.prevCpu.total;
      cpuInstant = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;
    }
    this.prevCpu = cpu;

    const totalBytes = this.inputs.memTotalBytes();
    const availBytes = this.inputs.memAvailBytes();
    const memInstant = totalBytes > 0 ? ((totalBytes - availBytes) / totalBytes) * 100 : 0;

    // The first sample's 0 is a "not measured yet" placeholder, NOT an
    // observation of an idle machine, so it must not seed the EWMA. Seeding on
    // it would make a device that boots under load report 0 → 48 → 71 → 83 and
    // take four publish cycles (~48s) to cross the 80% throttle threshold, on
    // exactly the machine that needed shedding soonest. The EWMA therefore
    // seeds on the first REAL delta; before that, cpu_util_pct stays 0.
    if (hadPrior) {
      this.ewmaCpu = this.ewmaCpu === null ? cpuInstant : this.alpha * cpuInstant + (1 - this.alpha) * this.ewmaCpu;
    }
    this.ewmaMem = this.ewmaMem === null ? memInstant : this.alpha * memInstant + (1 - this.alpha) * this.ewmaMem;

    // A null EWMA means "no delta measured yet" and publishes as 0.
    const cpuPct = this.ewmaCpu === null ? 0 : clampPct(this.ewmaCpu);
    const memPct = this.ewmaMem === null ? 0 : clampPct(this.ewmaMem);

    // Windowed maxima evaluate against the SMOOTHED series so a single spurious
    // spike does not hold recovery open, matching how the Cloud reasons about it.
    this.ring.push({ t: now, cpu: cpuPct, mem: memPct });
    while (this.ring.length && now - this.ring[0]!.t > WINDOW_MS) this.ring.shift();
    let cpuMax = cpuPct;
    let memMax = memPct;
    for (const s of this.ring) {
      if (s.cpu > cpuMax) cpuMax = s.cpu;
      if (s.mem > memMax) memMax = s.mem;
    }

    const disk = this.inputs.disk();
    const swap = this.inputs.swap();

    return {
      sampled_at: now,
      cpu_logical: Math.max(0, Math.round(this.inputs.cpuLogical())),
      cpu_util_pct: cpuPct,
      mem_total_mb: Math.max(0, Math.round(totalBytes / (1024 * 1024))),
      mem_avail_mb: Math.max(0, Math.round(availBytes / (1024 * 1024))),
      mem_used_pct: memPct,
      swap_total_mb: swap.swap_total_mb === null ? null : Math.max(0, Math.round(swap.swap_total_mb)),
      swap_used_mb: swap.swap_used_mb === null ? null : Math.max(0, Math.round(swap.swap_used_mb)),
      oom_pressure_pct: swap.oom_pressure_pct === null ? null : clampPct(swap.oom_pressure_pct),
      disk_workspace_total_gb: Math.max(0, Math.round(disk.total_gb)),
      disk_workspace_free_gb: Math.max(0, Math.round(disk.free_gb)),
      cpu_util_pct_max_120s: cpuMax,
      mem_used_pct_max_120s: memMax,
    };
  }
}

/** Compose a full DeviceObservation from identity metadata and a sample. */
export function composeObservation(meta: ObservationMeta, m: SampledMetrics): DeviceObservation {
  return {
    schema: OBSERVATION_SCHEMA,
    device_id: meta.device_id,
    boot_id: meta.boot_id,
    seq: meta.seq,
    sampled_at: m.sampled_at,
    cpu_logical: m.cpu_logical,
    cpu_util_pct: m.cpu_util_pct,
    mem_total_mb: m.mem_total_mb,
    mem_avail_mb: m.mem_avail_mb,
    mem_used_pct: m.mem_used_pct,
    swap_total_mb: m.swap_total_mb,
    swap_used_mb: m.swap_used_mb,
    oom_pressure_pct: m.oom_pressure_pct,
    disk_workspace_total_gb: m.disk_workspace_total_gb,
    disk_workspace_free_gb: m.disk_workspace_free_gb,
    lanes_active: Math.max(0, Math.round(meta.lanes_active)),
    lanes_reserved: Math.max(0, Math.round(meta.lanes_reserved)),
    workload_count: Math.max(0, Math.round(meta.workload_count)),
    capabilities: [...meta.capabilities],
    runtime_labels: [...meta.runtime_labels],
    repo: meta.repo ? { name: meta.repo.name, revision: meta.repo.revision } : null,
    agent_version: meta.agent_version,
    display_name: meta.display_name,
    cpu_util_pct_max_120s: m.cpu_util_pct_max_120s,
    mem_used_pct_max_120s: m.mem_used_pct_max_120s,
  };
}

// The CLOSED set of fields a DeviceObservation may carry on the wire. Anything
// else — an argv, an env var, a token, a prompt, a process list — must never
// reach the network, so the serializer rejects a frame with any extra key.
const OBSERVATION_ALLOWLIST: ReadonlySet<string> = new Set<keyof DeviceObservation>([
  "schema",
  "device_id",
  "boot_id",
  "seq",
  "sampled_at",
  "cpu_logical",
  "cpu_util_pct",
  "mem_total_mb",
  "mem_avail_mb",
  "mem_used_pct",
  "swap_total_mb",
  "swap_used_mb",
  "oom_pressure_pct",
  "disk_workspace_total_gb",
  "disk_workspace_free_gb",
  "lanes_active",
  "lanes_reserved",
  "workload_count",
  "capabilities",
  "runtime_labels",
  "repo",
  "agent_version",
  "display_name",
  "cpu_util_pct_max_120s",
  "mem_used_pct_max_120s",
] as const);

const OBSERVATION_STRING_ARRAYS = new Set(["capabilities", "runtime_labels"]);
const OBSERVATION_NULLABLE_NUMBERS = new Set(["swap_total_mb", "swap_used_mb", "oom_pressure_pct"]);
const OBSERVATION_REQUIRED_NUMBERS = new Set([
  "seq",
  "sampled_at",
  "cpu_logical",
  "cpu_util_pct",
  "mem_total_mb",
  "mem_avail_mb",
  "mem_used_pct",
  "disk_workspace_total_gb",
  "disk_workspace_free_gb",
  "lanes_active",
  "lanes_reserved",
  "workload_count",
  "cpu_util_pct_max_120s",
  "mem_used_pct_max_120s",
]);

/**
 * Validate a candidate observation against the closed allowlist and return a
 * clean object carrying ONLY allowlisted fields. Throws on any unknown key or
 * type violation. This is the choke point that makes telemetry non-exfiltrating:
 * a frame with `env`, `argv`, `token`, `prompt`, or any other field cannot pass.
 */
export function serializeObservation(candidate: unknown): DeviceObservation {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("observation must be a plain object");
  }
  const obj = candidate as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!OBSERVATION_ALLOWLIST.has(key)) {
      throw new Error(`observation contains a field outside the allowlist: ${key}`);
    }
  }
  if (obj["schema"] !== OBSERVATION_SCHEMA) throw new Error("observation has the wrong schema");
  for (const key of OBSERVATION_REQUIRED_NUMBERS) {
    if (typeof obj[key] !== "number" || !Number.isInteger(obj[key])) {
      throw new Error(`observation field ${key} must be an integer`);
    }
  }
  for (const key of OBSERVATION_NULLABLE_NUMBERS) {
    const v = obj[key];
    if (v !== null && (typeof v !== "number" || !Number.isInteger(v))) {
      throw new Error(`observation field ${key} must be an integer or null`);
    }
  }
  for (const key of ["device_id", "boot_id", "agent_version", "display_name"]) {
    if (typeof obj[key] !== "string") throw new Error(`observation field ${key} must be a string`);
  }
  for (const key of OBSERVATION_STRING_ARRAYS) {
    const v = obj[key];
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) {
      throw new Error(`observation field ${key} must be a string array`);
    }
  }
  const repo = obj["repo"];
  if (repo !== null) {
    if (!repo || typeof repo !== "object" || Array.isArray(repo)) throw new Error("observation repo must be an object or null");
    const r = repo as Record<string, unknown>;
    const keys = Object.keys(r).sort();
    if (keys.length !== 2 || keys[0] !== "name" || keys[1] !== "revision" || typeof r["name"] !== "string" || typeof r["revision"] !== "string") {
      throw new Error("observation repo must be {name, revision}");
    }
  }
  // Rebuild from the allowlist so no unexpected prototype pollution or extra
  // enumerable rides along, even if the checks above were somehow bypassed.
  const clean: Record<string, unknown> = {};
  for (const key of OBSERVATION_ALLOWLIST) clean[key] = obj[key];
  return clean as unknown as DeviceObservation;
}

// ── Default OS-backed inputs ────────────────────────────────────────────────

function defaultCpuTimes(): CpuTimesSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of osCpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function defaultDisk(workspaceRoot: string): DiskSnapshot {
  try {
    const st = statfsSync(workspaceRoot);
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail) * Number(st.bsize);
    return { total_gb: total / 1024 ** 3, free_gb: free / 1024 ** 3 };
  } catch {
    return { total_gb: 0, free_gb: 0 };
  }
}

interface SwapProbeCache {
  at: number;
  value: SwapSnapshot;
}
const SWAP_CACHE_MS = 10_000;
const EMPTY_SWAP: SwapSnapshot = { swap_total_mb: null, swap_used_mb: null, oom_pressure_pct: null };

/**
 * One bounded PowerShell probe for swap / virtual-memory pressure, cached for
 * 10s and tolerant of failure (returns all-null fields). Non-Windows platforms
 * skip it entirely — there is no equivalent single-call probe here, and null
 * fields are the contract's documented "unknown".
 */
export function makeSwapProbe(now: () => number = Date.now): () => SwapSnapshot {
  let cache: SwapProbeCache | null = null;
  return () => {
    const t = now();
    if (cache && t - cache.at < SWAP_CACHE_MS) return cache.value;
    let value: SwapSnapshot = EMPTY_SWAP;
    if (process.platform === "win32") {
      value = probeWindowsSwap();
    }
    cache = { at: t, value };
    return value;
  };
}

function probeWindowsSwap(): SwapSnapshot {
  try {
    const script =
      "$os = Get-CimInstance Win32_OperatingSystem; " +
      "$pf = Get-CimInstance Win32_PageFileUsage | Measure-Object -Property CurrentUsage,AllocatedBaseSize -Sum; " +
      "$totalVirt = [int64]$os.TotalVirtualMemorySize; $freeVirt = [int64]$os.FreeVirtualMemory; " +
      "[PSCustomObject]@{ totalVirtKb = $totalVirt; freeVirtKb = $freeVirt } | ConvertTo-Json -Compress";
    const res = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2500,
    });
    const parsed = JSON.parse((res.stdout ?? "").trim()) as { totalVirtKb?: number; freeVirtKb?: number };
    const totalKb = typeof parsed.totalVirtKb === "number" ? parsed.totalVirtKb : null;
    const freeKb = typeof parsed.freeVirtKb === "number" ? parsed.freeVirtKb : null;
    if (totalKb === null || freeKb === null || totalKb <= 0) return EMPTY_SWAP;
    const totalMb = totalKb / 1024;
    const usedMb = (totalKb - freeKb) / 1024;
    const pressure = ((totalKb - freeKb) / totalKb) * 100;
    return { swap_total_mb: totalMb, swap_used_mb: usedMb, oom_pressure_pct: pressure };
  } catch {
    return EMPTY_SWAP;
  }
}

/** OS-backed inputs rooted at a workspace directory (for disk). */
export function defaultTelemetryInputs(workspaceRoot: string, now: () => number = Date.now): TelemetryInputs {
  const swapProbe = makeSwapProbe(now);
  return {
    cpuTimes: defaultCpuTimes,
    cpuLogical: () => osCpus().length,
    memTotalBytes: () => osTotalmem(),
    memAvailBytes: () => osFreemem(),
    disk: () => defaultDisk(workspaceRoot),
    swap: swapProbe,
    now,
  };
}
