// Device identity — the enrolled secret record and the per-boot identity.
//
// Two very different things live here, kept together because they are the
// device's "who am I" and both are minted once and read on every daemon start:
//
//   1. The enrollment record (device_id + device token + device_command_key),
//      a SECRET written 0600 following the same hardening as core/auth.ts's
//      FileTokenStore — created O_EXCL at 0600, fsynced, atomically renamed,
//      never written through a planted symlink/junction.
//
//   2. The per-boot identity: a boot_id (UUIDv4) minted fresh each OS boot and
//      a monotonic per-boot sample sequence starting at 1. A new boot is
//      detected by the system boot time changing; the boot-time probe is
//      injectable so tests never depend on the real machine.

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { uptime } from "node:os";
import { atomicWriteFile, readJsonFile, withFileLock } from "../durable_store.js";
import { bootStatePath, deviceRuntimeDir, enrollmentPath, runtimeLockPath } from "./paths.js";

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export interface EnrollmentRecord {
  device_id: string;
  device_token: string;
  device_command_key: string;
  display_name: string;
  base_url: string;
  enrolled_at: number;
}

export interface BootState {
  boot_time_ms: number;
  boot_id: string;
  seq: number;
}

function isLinkLike(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

const RENAME_RETRY_DELAYS_MS = [2, 5, 10, 20, 40, 60, 80, 120] as const;
function renameWithWindowsRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (!retryable || delay === undefined) throw err;
      // Small synchronous spin; the enrollment write is rare and off the hot path.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

/**
 * Write a secret JSON file at 0600 with the same guarantees the token store
 * gives `.token`: the parent dir is created 0700, the temp file is O_EXCL and
 * 0600 from creation, fsynced before the atomic rename, and a planted link at
 * the destination is refused rather than written through.
 */
function writeSecretJson(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (isLinkLike(path)) {
    throw new Error(`refusing to write ${path}: it is a symlink or reparse point, not a regular file`);
  }
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Non-fatal on filesystems without POSIX modes; Windows ACLs are authoritative.
    }
    renameWithWindowsRetry(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // Non-fatal; see above.
  }
}

/** Validate a parsed enrollment record; returns null if any required field is bad. */
export function parseEnrollment(value: unknown): EnrollmentRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const str = (k: string): string | null => (typeof v[k] === "string" && (v[k] as string).length > 0 ? (v[k] as string) : null);
  const device_id = str("device_id");
  const device_token = str("device_token");
  const device_command_key = str("device_command_key");
  const base_url = str("base_url");
  if (!device_id || !device_token || !device_command_key || !base_url) return null;
  const enrolled_at = typeof v["enrolled_at"] === "number" && Number.isFinite(v["enrolled_at"]) ? (v["enrolled_at"] as number) : 0;
  const display_name = typeof v["display_name"] === "string" ? (v["display_name"] as string) : "";
  return { device_id, device_token, device_command_key, base_url, enrolled_at, display_name };
}

export function loadEnrollment(): EnrollmentRecord | null {
  const path = enrollmentPath();
  if (!existsSync(path) || isLinkLike(path)) return null;
  let raw: string;
  try {
    const fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
    try {
      raw = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  try {
    return parseEnrollment(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveEnrollment(record: EnrollmentRecord): void {
  writeSecretJson(enrollmentPath(), record);
}

export function clearEnrollment(): void {
  const path = enrollmentPath();
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // logging out an unenrolled device is not an error
  }
}

/**
 * Read the OS boot time in unix milliseconds. On Windows this asks the CIM
 * provider for `LastBootUpTime`, which is stable across the whole boot; on
 * other platforms (dev machines) it derives one from `os.uptime()`. Returns
 * null only if every source fails, in which case the caller keeps its prior
 * boot identity rather than minting a spurious new boot.
 *
 * Bounded (2s) so a hung PowerShell can never stall daemon startup.
 */
export function readSystemBootTimeMs(): number | null {
  if (process.platform === "win32") {
    try {
      const res = spawnSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", "[int64]([DateTimeOffset](Get-CimInstance Win32_OperatingSystem).LastBootUpTime).ToUnixTimeSeconds()"],
        { encoding: "utf8", windowsHide: true, timeout: 2000 },
      );
      const seconds = Number.parseInt((res.stdout ?? "").trim(), 10);
      if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    } catch {
      // fall through to the uptime derivation
    }
  }
  try {
    const up = uptime();
    if (Number.isFinite(up) && up >= 0) {
      // Floor to the second so repeated reads within one boot agree closely; the
      // tolerance in resolveBootIdentity absorbs the residual sub-second jitter.
      return Math.floor((Date.now() - up * 1000) / 1000) * 1000;
    }
  } catch {
    // nothing else to try
  }
  return null;
}

/**
 * Resolve the per-boot identity, minting a fresh boot_id (and resetting the
 * sequence) when the system boot time has changed. A probed boot time within
 * `toleranceMs` of the persisted one is treated as the SAME boot, so the
 * `os.uptime()` fallback's sub-second jitter does not fabricate a new boot on
 * every daemon restart. The whole read-decide-write runs under the runtime lock
 * so two daemon starts cannot both mint a boot_id.
 */
export function resolveBootIdentity(
  bootTimeMs: number | null,
  now: () => number = Date.now,
  toleranceMs = 5000,
): BootState {
  mkdirSync(deviceRuntimeDir(), { recursive: true, mode: 0o700 });
  return withFileLock(runtimeLockPath(), "device-boot", () => {
    const prior = readBootState();
    if (bootTimeMs === null) {
      // No probe: keep the prior identity if we have one, else mint from clock.
      if (prior) return prior;
      const minted: BootState = { boot_time_ms: now(), boot_id: randomUUID(), seq: 0 };
      writeBootState(minted);
      return minted;
    }
    if (prior && Math.abs(prior.boot_time_ms - bootTimeMs) <= toleranceMs) {
      // Same boot; adopt the probed time as canonical but keep id + seq.
      return prior;
    }
    const minted: BootState = { boot_time_ms: bootTimeMs, boot_id: randomUUID(), seq: 0 };
    writeBootState(minted);
    return minted;
  });
}

function readBootState(): BootState | null {
  const read = readJsonFile<Record<string, unknown>>(bootStatePath());
  if (!read.ok) return null;
  const v = read.value;
  if (
    typeof v["boot_time_ms"] !== "number" ||
    typeof v["boot_id"] !== "string" ||
    typeof v["seq"] !== "number" ||
    !Number.isInteger(v["seq"]) ||
    (v["seq"] as number) < 0
  ) {
    return null;
  }
  return { boot_time_ms: v["boot_time_ms"] as number, boot_id: v["boot_id"] as string, seq: v["seq"] as number };
}

function writeBootState(state: BootState): void {
  atomicWriteFile(bootStatePath(), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Atomically claim the next per-boot sample sequence. Starts at 1 for a fresh
 * boot and never repeats within a boot even across daemon restarts, because the
 * counter is persisted under the runtime lock before it is returned.
 */
export function nextBootSeq(): number {
  return withFileLock(runtimeLockPath(), "device-seq", () => {
    const prior = readBootState();
    if (!prior) throw new Error("cannot advance the sample sequence before the boot identity is resolved");
    const next = prior.seq + 1;
    writeBootState({ ...prior, seq: next });
    return next;
  });
}

/** Read the current boot identity without advancing the sequence. */
export function currentBootState(): BootState | null {
  return readBootState();
}
