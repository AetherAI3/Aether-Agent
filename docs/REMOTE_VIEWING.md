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
| `aether rc viewers` | Show the observer count with the exposure view. It reads `unknown`, never zero, when presence cannot be confirmed. |
| `aether rc off` | Revoke observation access. |

Use `aether --json rc start`, `link`, or `status` for structured session/device
identity. Only `start` and `link` return the short-lived link. Integrations must
not log it.

## The browser viewer is observer-only

The link opens the Aether Code viewer at `app.aethersystems.net/rc`, which
hands off to the session page at `/rc/<session>`. Both routes are
observer-only. They declare the `aether.rc_viewer_profile/1` profile:
capability `observe`, grant purpose `observe`, presence roles `host` and
`observer`, the structured event types in `src/core/rc/viewer_profile.ts`
with `transcript` excluded, and no control capability. The viewer has no text
entry, terminal input, or prompt submission.

- `test/rc_viewer_profile.test.ts` pins the Agent's profile against a
  hash-pinned, byte-identical copy of the Cloud manifest
  (`test/fixtures/rc-viewer-profile-v1.json`).
- Aether Code's build scan enforces the same manifest against the shipped
  viewer bundles. Control endpoints, takeover labels, or text-entry elements
  fail the build.

Predator browser takeover and process control are not part of `aether rc`.
They live on a separate operator route with its own profile entry and feature
gates, and `aether rc` never links to it: its links carry only an observe
grant and a viewer device id.

These checks bound what a viewer build can do. They do not qualify a
deployment; the live Cloud viewer journey still needs qualification.

## Connection and privacy

- Outbound TLS only; no inbound listener on your machine.
- Events are allowlisted and redacted. They exclude environment variables,
  credentials, cookies, private memory, raw file contents, absolute paths,
  and unredacted shell history.
- Your local session continues if the broker disconnects.
- Test results come only from the host's own verification (`aether agent`'s
  final gate, `aether review verify`, or a stored reading `aether review`
  shows): the status (`verified`, `failed`, `stale`, `unknown`), a fixed
  reason and, for a failure, the exit code. The test command, its output and
  test counts stay local. A run that was interrupted, timed out or could not
  start, or whose working tree changed or could not be identified, is
  `unknown`, never a pass.

These are release requirements. Local source tests do not establish a qualified
Cloud viewer or publication.

[Host/viewer design](specs/2026-09-06-rc-02-viewer-host.md) ·
[Operator packet](releases/OPERATOR-PACKET-v0.4.0.md) ·
[Command reference](generated/commands.md)
