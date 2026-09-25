import { spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { statfsSync } from "node:fs";
import { childEnv } from "../child_env.js";
import { detectBrowserRuntime } from "../browser_runtime.js";
import { defaultTelemetryInputs, TelemetrySampler } from "../device_runtime/telemetry.js";

export const PC_SCHEMA = "aether.pc/1" as const;
export type PcTarget = "aether-cloud" | "claude" | "chatgpt" | "ollama";
export type PcState = "available" | "unavailable" | "unverified" | "denied";
export type MetricState = "measured" | "unavailable" | "not-checked";

export interface PcCapability {
  id: string;
  state: PcState;
  detail: string;
}

export interface PcMap {
  schema: typeof PC_SCHEMA;
  platform: NodeJS.Platform;
  observedAt: string;
  capabilities: PcCapability[];
}

export interface PcMetric {
  id: string;
  state: MetricState;
  value: number | null;
  unit: string;
  source: string;
  reason?: string;
  observedAt: string;
}

export interface PcProcess {
  name: string;
  pid: number;
  startedAt: string;
  workingSetMb: number;
}

export interface PcDoctorReport {
  schema: typeof PC_SCHEMA;
  target: PcTarget;
  observedAt: string;
  metrics: PcMetric[];
  processes: { state: MetricState; source: string; items: PcProcess[]; reason?: string };
  recommendations: string[];
}

const TARGET_URL: Record<PcTarget, string> = {
  "aether-cloud": "https://app.aethersystems.net/",
  claude: "https://claude.ai/",
  chatgpt: "https://chatgpt.com/",
  ollama: "http://127.0.0.1:11434/api/version",
};

export const PC_TARGETS = Object.keys(TARGET_URL) as PcTarget[];
export function isPcTarget(value: string): value is PcTarget {
  return Object.prototype.hasOwnProperty.call(TARGET_URL, value);
}
export function pcTargetUrl(target: PcTarget): string { return TARGET_URL[target]; }

/** Static and inspected support are separated from verified end-to-end control. */
export function pcMap(platform: NodeJS.Platform = process.platform, now: () => number = Date.now): PcMap {
  const browser = detectBrowserRuntime({ platform });
  return {
    schema: PC_SCHEMA,
    platform,
    observedAt: new Date(now()).toISOString(),
    capabilities: [
      { id: "pc.inspect", state: "available", detail: "local CPU, memory, disk and interface inspection" },
      { id: "process.inspect", state: platform === "win32" ? "unverified" : "unavailable", detail: platform === "win32" ? "Windows CIM probe; run pc doctor to verify" : "Windows-only first release" },
      { id: "browser.open", state: browser.available ? "unverified" : "unavailable", detail: browser.evidence + "; rendering has not been verified" },
      { id: "browser.verify", state: browser.available ? "unverified" : "unavailable", detail: browser.available ? "run pc verify-browser for an approved loopback page-render proof" : browser.evidence },
      { id: "browser.inspect", state: "unavailable", detail: "no browser automation adapter installed in this release" },
      { id: "browser.act", state: "unavailable", detail: "no origin-scoped action adapter installed in this release" },
      { id: "pc.capture", state: "unavailable", detail: "desktop capture driver and privacy masks are not implemented" },
      { id: "pc.act", state: "unavailable", detail: "desktop action driver and window-scoped grants are not implemented" },
      { id: "process.manage", state: "unavailable", detail: "unsaved-work checks and PID identity guard are not implemented" },
      { id: "system.apply", state: "unavailable", detail: "reviewed reversible optimization recipes are not implemented" },
      { id: "command.execute", state: "denied", detail: "PC command execution requires an OS-enforced sandbox; legacy run_shell is separate" },
      { id: "device.runtime", state: "unavailable", detail: "development-only and default-off; Job Objects contain only device-launched groups, not the PC or legacy shell" },
      { id: "cloud.act", state: "unverified", detail: "hosted PC tool round-trip has not been proved" },
    ],
  };
}

export interface PcDoctorDeps {
  platform?: NodeJS.Platform;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  fetchHead?: (url: string) => Promise<number>;
  processProbe?: () => { state: MetricState; items: PcProcess[]; reason?: string };
}

function measured(id: string, value: number, unit: string, source: string, at: string): PcMetric {
  return { id, state: "measured", value, unit, source, observedAt: at };
}
function missing(id: string, state: MetricState, unit: string, source: string, reason: string, at: string): PcMetric {
  return { id, state, value: null, unit, source, reason, observedAt: at };
}
function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

const PROCESS_SCRIPT = [
  "$names = @('chrome.exe','msedge.exe','firefox.exe','claude.exe','chatgpt.exe','ollama.exe','aether.exe')",
  "@(Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name } | ForEach-Object {",
  "  [PSCustomObject]@{ name=$_.Name; pid=[int]$_.ProcessId; startedAt=$_.CreationDate.ToUniversalTime().ToString('o'); workingSetMb=[math]::Round($_.WorkingSetSize/1MB,1) }",
  "}) | ConvertTo-Json -Compress",
].join("; ");

/** Fixed PowerShell text; user/model input is never interpolated into a shell. */
export function probeWindowsProcesses(): { state: MetricState; items: PcProcess[]; reason?: string } {
  if (process.platform !== "win32") return { state: "unavailable", items: [], reason: "Windows-only process probe" };
  try {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROCESS_SCRIPT], {
      encoding: "utf8", shell: false, windowsHide: true, timeout: 5_000, maxBuffer: 512 * 1024,
      env: childEnv(),
    });
    if (result.status !== 0 || result.error) return { state: "unavailable", items: [], reason: "Windows process probe failed or timed out" };
    const raw = JSON.parse(result.stdout.trim() || "[]") as unknown;
    const rows = Array.isArray(raw) ? raw : [raw];
    const items: PcProcess[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const v = row as Record<string, unknown>;
      if (typeof v["name"] !== "string" || typeof v["pid"] !== "number" || typeof v["startedAt"] !== "string" || typeof v["workingSetMb"] !== "number") continue;
      if (!Number.isSafeInteger(v["pid"]) || v["pid"] < 1 || !Number.isFinite(v["workingSetMb"])) continue;
      items.push({ name: v["name"], pid: v["pid"], startedAt: v["startedAt"], workingSetMb: v["workingSetMb"] });
    }
    return items.length > 100
      ? { state: "measured", items: items.slice(0, 100), reason: "limited to the first 100 matching processes" }
      : { state: "measured", items };
  } catch {
    return { state: "unavailable", items: [], reason: "Windows process probe could not be parsed" };
  }
}

async function defaultFetchHead(url: string): Promise<number> {
  const start = performance.now();
  await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(3_000), headers: { "User-Agent": "aether-pc-doctor/1" } });
  return performance.now() - start;
}

/** Read-only bounded diagnosis. Network probes run only on explicit opt-in. */
export async function pcDoctor(target: PcTarget, root: string, probeNetwork = false, deps: PcDoctorDeps = {}): Promise<PcDoctorReport> {
  const now = deps.now ?? Date.now;
  const at = new Date(now()).toISOString();
  const platform = deps.platform ?? process.platform;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const inputs = defaultTelemetryInputs(root, now);
  const sampler = new TelemetrySampler(inputs, 1);
  sampler.sample();
  await wait(250);
  const sample = sampler.sample();
  const metrics: PcMetric[] = [
    measured("cpu.utilization", sample.cpu_util_pct, "%", "os.cpus delta over 250 ms", at),
    measured("memory.used", sample.mem_used_pct, "%", "os.totalmem/freemem", at),
    measured("memory.available", sample.mem_avail_mb, "MiB", "os.freemem", at),
  ];
  try {
    const disk = statfsSync(root);
    const total = Number(disk.blocks) * Number(disk.bsize);
    const free = Number(disk.bavail) * Number(disk.bsize);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free)) throw new Error("invalid filesystem capacity");
    metrics.push(measured("disk.free", Math.round(free / 1024 ** 3 * 10) / 10, "GiB", "fs.statfs", at));
    metrics.push(measured("disk.free_pct", Math.round(free / total * 100), "%", "fs.statfs", at));
  } catch {
    metrics.push(missing("disk.free", "unavailable", "GiB", "fs.statfs", "workspace filesystem cannot be sampled", at));
    metrics.push(missing("disk.free_pct", "unavailable", "%", "fs.statfs", "workspace filesystem cannot be sampled", at));
  }
  const activeInterfaces = Object.values(networkInterfaces()).flat().filter((item) => item && !item.internal).length;
  metrics.push(measured("network.interfaces", activeInterfaces, "addresses", "os.networkInterfaces; not a reachability test", at));
  metrics.push(sample.swap_used_mb === null
    ? missing("swap.used", "unavailable", "MiB", "Windows CIM", "virtual memory probe unavailable", at)
    : measured("swap.used", sample.swap_used_mb, "MiB", "Windows CIM", at));
  const processResult = deps.processProbe ? deps.processProbe() : platform === "win32" ? probeWindowsProcesses() : { state: "unavailable" as const, items: [], reason: "Windows-only process probe" };
  if (!probeNetwork) {
    metrics.push(missing("target.reachability_p50", "not-checked", "ms", "fixed-target HEAD", "run with --probe-network to contact the selected target", at));
    metrics.push(missing("target.reachability_p95", "not-checked", "ms", "fixed-target HEAD", "run with --probe-network to contact the selected target", at));
  } else {
    try {
      const fetchHead = deps.fetchHead ?? defaultFetchHead;
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) samples.push(await fetchHead(TARGET_URL[target]));
      if (samples.some((n) => !Number.isFinite(n) || n < 0)) throw new Error("invalid latency");
      samples.sort((a, b) => a - b);
      metrics.push(measured("target.reachability_p50", Math.round(percentile(samples, 0.5)), "ms", "three fixed-target HEAD requests; includes remote service time", at));
      metrics.push(measured("target.reachability_p95", Math.round(percentile(samples, 0.95)), "ms", "three fixed-target HEAD requests; includes remote service time", at));
    } catch {
      metrics.push(missing("target.reachability_p50", "unavailable", "ms", "fixed-target HEAD", "target did not respond within probe budget", at));
      metrics.push(missing("target.reachability_p95", "unavailable", "ms", "fixed-target HEAD", "target did not respond within probe budget", at));
    }
  }
  const recommendations: string[] = [];
  if (sample.mem_used_pct >= 85) recommendations.push("Memory pressure is high; inspect named apps before closing anything with unsaved work.");
  if (sample.cpu_util_pct >= 85) recommendations.push("CPU was busy during this sample; repeat during the slowdown and inspect sustained load.");
  const diskPct = metrics.find((m) => m.id === "disk.free_pct");
  if (diskPct?.value !== null && diskPct?.value !== undefined && diskPct.value < 10) recommendations.push("Free disk space is low; review storage categories before deleting files.");
  if (target !== "ollama") recommendations.push("Remote model inference time is controlled by the service; this report measures local resources and reachability only.");
  return { schema: PC_SCHEMA, target, observedAt: at, metrics, processes: { ...processResult, source: "Windows CIM process identity (name, PID, start time, working set)" }, recommendations };
}
