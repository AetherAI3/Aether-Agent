import { spawnSync } from "node:child_process";
import { childEnv } from "./child_env.js";

export type ShellProfile = "bash" | "cmd" | "powershell";

export interface ShellProfileStatus {
  profile: ShellProfile;
  ready: boolean;
  executable: string | null;
  version: string | null;
  reason: string | null;
}

type ProbeResult = { lines: string[]; reason: string | null };
function probe(executable: string, args: string[]): ProbeResult {
  const result = spawnSync(executable, args, {
    encoding: "utf8", timeout: 4_000, windowsHide: true, env: childEnv(),
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? String(result.stderr || `exit ${result.status}`);
    return { lines: [], reason: reason.trim().slice(0, 200) };
  }
  return { lines: String(result.stdout).trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean), reason: null };
}

/** Probe only on request. Discovery executes no user command or profile script. */
export function discoverShellProfiles(platform = process.platform, runProbe: typeof probe = probe): ShellProfileStatus[] {
  if (platform !== "win32") {
    const result = runProbe("/bin/bash", ["--noprofile", "--norc", "--version"]);
    return [{ profile: "bash", ready: result.reason === null,
      executable: result.reason === null ? "/bin/bash" : null,
      version: result.lines[0] ?? null, reason: result.reason }];
  }
  const cmdPath = process.env["ComSpec"] ?? "C:\\Windows\\System32\\cmd.exe";
  const cmd = runProbe(cmdPath, ["/d", "/c", "ver"]);
  const cmdStatus: ShellProfileStatus = { profile: "cmd", ready: cmd.reason === null,
    executable: cmd.reason === null ? cmdPath : null, version: cmd.lines.at(-1) ?? null,
    reason: cmd.reason };
  let found: ProbeResult | null = null;
  for (const exe of ["pwsh.exe", "powershell.exe"]) {
    const result = runProbe(exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$PSVersionTable.PSVersion.ToString(); (Get-Process -Id $PID).Path"]);
    if (result.reason === null && result.lines.length >= 2) { found = result; break; }
  }
  const psStatus: ShellProfileStatus = found
    ? { profile: "powershell", ready: true, executable: found.lines[1]!, version: found.lines[0]!, reason: null }
    : { profile: "powershell", ready: false, executable: null, version: null,
      reason: "PowerShell is unavailable. Install PowerShell 7 (pwsh) or enable Windows PowerShell, then run /shell-profile list." };
  return [cmdStatus, psStatus];
}
