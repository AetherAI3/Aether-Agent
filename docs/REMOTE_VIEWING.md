# Remote viewing

[← README](../README.md#web-and-remote-viewing)

**0.4.0 source candidate.** `aether rc` is the observer-only bridge between a
terminal run and a browser. Its host foundation and local status/exposure
controls are on `main`, outside the published 0.3.x line. A complete live Cloud
viewer journey still needs qualification. The old draft
[PR #108](https://github.com/AetherAI3/aether-agent/pull/108) is not release
evidence for current `main`.

## Intended workflow

Start a session, open its short-lived link or QR code on a phone or browser,
and watch the redacted run. The viewer receives observation access only; it
has no tool authority.

| Command | Purpose |
|---|---|
| `aether rc start` | Start the observer session and return its link. |
| `aether rc link` | Return the current short-lived observer link. |
| `aether rc status` | Inspect local session status without replaying the link. |
| `aether rc exposure` | Inspect what is exposed. |
| `aether rc off` | Revoke observation access. |

Use `aether --json rc start`, `link`, or `status` for structured session/device
identity. Only `start` and `link` return the short-lived link. Integrations must
not log it.

## Connection and privacy

- Outbound TLS only; no inbound listener on your machine.
- Events are allowlisted and redacted. They exclude environment variables,
  credentials, cookies, private memory, raw file contents, absolute paths,
  and unredacted shell history.
- Your local session continues if the broker disconnects.

These are release requirements. Local source tests do not establish a qualified
Cloud viewer or publication.

[Host/viewer design](specs/2026-09-06-rc-02-viewer-host.md) ·
[Operator packet](releases/OPERATOR-PACKET-v0.4.0.md) ·
[Command reference](generated/commands.md)
