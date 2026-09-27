# Aether device runtime — install and rollback (Windows)

The device runtime (lane SC-DEVICE-01) is a **dev-only, default-off**, persistent
Windows service that publishes machine telemetry to the Aether Cloud and executes
signed device commands against process groups the Aether launcher itself started.

Three properties define it, and every instruction below preserves them:

- **Outbound only.** It opens no listening port, ever. It is an HTTPS client of
  `/device/v1/*` and nothing else.
- **Default off.** Installing it does not start it. It refuses to run unless the
  operator has explicitly opted in.
- **Bounded authority.** It can only act on process groups the Aether launcher
  registered, under a lease and fence. It cannot touch a browser, an IDE, a
  Windows service, or any process it did not itself launch under a Job Object.

Everything it writes lives under the CLI config directory (`%USERPROFILE%\.aether-agent`
by default, or `AETHER_CONFIG_DIR`). Backing it out is deleting a scheduled task
and a directory.

---

## Install

### 1. Authenticate and enroll the device

Enrollment mints the canonical device identity. The hostname is display metadata
only — it never authenticates anything.

```powershell
aether auth login
aether device enroll                              # enrolls against the configured base URL
aether device enroll --base-url https://<cloud>   # or bind explicitly to one Cloud
```

`--base-url` must be `https://…` (or `http://` on loopback for a local dev
backend). Anything else is refused before any request is made, because a device
bearer token would otherwise traverse cleartext.

This writes `device.json` (0600) into the config directory: device id, device
token, and the command-signing key. **Treat that file as a credential.**

### 2. Turn the runtime on (it is off until you do)

Either switch works; both are read through the same gate.

```powershell
aether device enable                 # persistent opt-in (writes deviceRuntime.enabled)
$env:AETHER_DEVICE_RUNTIME = "1"     # per-process opt-in, for one shell
```

With neither set, `aether device start` exits 3 and the daemon refuses to run.

### 3. Start it

```powershell
aether device start          # spawns the detached daemon
aether device status         # state: healthy | eligible | stale | offline | disabled | unenrolled
aether device doctor         # structured health report (enrollment, opt-in, daemon, publish age, Cloud, Job Object)
```

### 4. Optional: survive logon (boot persistence)

```powershell
aether device install-service        # creates the "AetherDeviceRuntime" scheduled task (onlogon)
aether device install-service --yes  # non-interactive
```

The task only *launches* the daemon. The daemon still refuses to run while the
runtime is disabled, so installing the task on a machine with the opt-in off is
inert by design.

---

## Operate

| Command | What it tells you |
| --- | --- |
| `aether device status` | one-word state, enrollment, opt-in, daemon liveness, last seq, queue depth, heartbeat age |
| `aether device health` | a live one-shot sample (CPU, memory, disk, workloads) — publishes nothing |
| `aether device doctor` | full health report; add `--json` for machine-readable |
| `aether device groups` | managed process groups, their leases and expiries |
| `aether device last` | last command processed and last checkpoint written |
| `aether device restart` | stop then start |

No subcommand prints the device token or the command key.

A record is **stale after 30s**: the daemon publishes every 12s ± 2s of jitter,
so two missed publishes is the Cloud's cue that the device stopped reporting.

---

## Rollback

Back out in the order below. Steps 1–2 are enough to stop all activity; steps 3–5
remove the runtime's footprint entirely.

### 1. Stop the daemon

```powershell
aether device stop
aether device status     # expect: daemon "not running"
```

### 2. Turn the runtime off

```powershell
aether device disable
Remove-Item Env:\AETHER_DEVICE_RUNTIME -ErrorAction SilentlyContinue
```

With the opt-in cleared the daemon cannot restart — not from the CLI, not from
the scheduled task.

### 3. Remove boot persistence

```powershell
aether device uninstall-service
schtasks /query /tn AetherDeviceRuntime    # expect: task not found
```

### 4. Remove the enrollment credential and runtime state

```powershell
$dir = if ($env:AETHER_CONFIG_DIR) { $env:AETHER_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".aether-agent" }
Remove-Item (Join-Path $dir "device.json") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $dir "device-runtime") -Recurse -Force -ErrorAction SilentlyContinue
```

`device-runtime\` holds only non-secret runtime state: the per-boot identity and
sample sequence, the managed-group registry, the command chain, the daemon
heartbeat, and drain checkpoints. Deleting it resets the device to "never ran".

Revoke the device on the Cloud side as well if the enrollment was ever live.

### 5. Confirm nothing is left

```powershell
aether device status    # state: unenrolled (or disabled)
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.CommandLine -like "*device_runtime*" }
```

### Managed process groups during rollback

Stopping the daemon does **not** orphan anything it launched. Every managed group
runs in a Job Object created with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and owned
by a per-group warden, so when the daemon exits the OS tears the whole group down
— task and descendants. There is no cleanup step and nothing to hunt for by name.

---

## Troubleshooting

**`aether device start` exits 3** — the runtime is disabled. See Install step 2.

**Exits 4** — the device is not enrolled. See Install step 1.

**`device doctor` says the Job Object check failed** — the warden could not
start. It runs `powershell -NoProfile -NonInteractive`; check that PowerShell is
on `PATH` and not blocked by policy. Containment is unavailable until it works,
so the daemon will not launch managed groups.

**Status shows `stale`** — the process is alive but has not published in over 30s.
Check `device doctor` for Cloud reachability; the publisher backs off
exponentially (1s → 60s, jittered) while offline and keeps a bounded queue of the
40 most recent frames, dropping the oldest rather than growing without limit.

**Status shows `offline`** — publishing is failing but frames are being retained
and retried. This is the expected shape of a network outage, not data loss.
