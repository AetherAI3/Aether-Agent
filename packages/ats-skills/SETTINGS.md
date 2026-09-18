# Local ATS profile settings

`src/settings.js` exports `defaultSettings()`, `validateSettings(value)`,
`cyclePermissionMode(mode)`, `loadSettings(absoluteFile)` and
`saveSettings(absoluteFile, value)`. Loading an absent file returns defaults;
malformed, oversized, symlinked or non-private files produce an error. Saving
validates before touching the destination and writes a private temporary file,
syncs it and atomically renames it. New directories use mode 0700 and files use
0600 on POSIX. Windows account ACLs remain the host's responsibility.

Store the file under the terminal's existing **account and agent scoped** local
directory. These settings belong to that device; they are not Cloud config
fields, verified engine configuration or evidence of a running runtime.

```json
{
  "schema_version": "aether.ats.settings/1",
  "permission_mode": "plan",
  "requested_execution_mode": "paper",
  "order_execution_mode": "paper",
  "execute_live": false,
  "data_stream": {
    "provider": "polygon",
    "endpoint": "https://api.polygon.io/",
    "api_key_env": "POLYGON_API_KEY",
    "symbols": ["SPY", "NQ=F"],
    "timeframe": "M5",
    "poll_interval_ms": 5000
  }
}
```

## Permission preferences and native authority

| Setting | Meaning | Authority |
| --- | --- | --- |
| `permission_mode: plan` | Default planning/read-only UI preference | No execution permission |
| `permission_mode: skip` | Requested ATS UI mode | Does not imply native `approve` or skip broker approvals |
| `permission_mode: danger` | Requested ATS UI mode | Does not imply native `auto` or arm live orders |
| `requested_execution_mode` | Separate preference using the existing native `paper`, `approve`, `auto` names | Not applied by this module |
| `order_execution_mode` | Fixed `paper` for this local setup | Live is refused |
| `execute_live` | Fixed `false` for this local setup | Live is refused |

Shift+Tab can call `cyclePermissionMode` to move `plan → skip → danger → plan`.
The result is a UI preference only. A host must confirm its effective mode;
it cannot label this preference as applied permission. No mapping from `skip`
to `approve`, or from `danger` to `auto`, is invented here. The existing coding
Agent mode enum (`ask`, `auto`, `skip`) remains a separate system.

The canonical ATS engine owns `execution_mode` (`paper`, `approve`, `auto`),
`order_execution_mode` and `execute_live`. Its existing live-arm agreement,
approval, startup, entitlement and order checks remain required. This module
does not write engine configuration or process environment and never starts
an execution process.

## Data settings and connection evidence

Native providers are `none`, `polygon` and `yfinance`. `custom` records a
desired adapter endpoint; it is not an implemented provider. Polygon requires
an environment-variable reference, such as `POLYGON_API_KEY`; the file never
stores the variable's secret value. yfinance accepts neither credentials nor
an endpoint. A configured endpoint allows HTTPS/WSS, or HTTP/WS on exact local
loopback hosts, with no URL credentials, query or fragment.

`dataStreamStatus(settings)` returns `unconfigured` or `unverified`, always
with `connected: false`. `probeDataStream(settings, probe, options)` optionally
calls an actual host adapter with the normalized data config and an abort
signal. Only `{ok: true, sample_count: positive integer, observed_at: ISO time}`
within the configured freshness window produces a transient `connected`
result. Empty samples, stale/future timestamps, errors and timeouts fail closed.
Connection results cannot be saved as settings. The returned timestamp must
still be checked for freshness before subsequent use; this is a point-in-time
probe, not a continuously connected stream or proof of broker execution.

The native `build_feed` currently selects provider/key, and its Polygon
constructor supports a base URL; wiring a custom endpoint through the host is
a separate integration. No configuration setting here claims that such wiring,
a custom stream implementation or a live connection already exists.
