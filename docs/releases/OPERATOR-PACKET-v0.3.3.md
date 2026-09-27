# Operator packet — Aether Agent v0.3.3 candidate

This packet describes a proposed maintenance patch over the already published
v0.3.2 package. It is a source candidate, not a release authorization.

| | |
|---|---|
| Package | `aether-agents` |
| Proposed tag | `v0.3.3` |
| Release line base | `e234bf6bcd283dd81691158e70e826a47013eea6` (`release/0.3`, synced to published v0.3.2) |
| Candidate branch | `fix/032-home-scan` |
| Release scope | Bounded nested `AGENTS.md` discovery on hosted chat; incomplete discovery visibly warns, while local tool runs refuse. Finite reads of non-2xx HTTP detail bodies preserve the known status. The generated public model catalogue is refreshed from Cloud's verified projection. |
| Catalogue source evidence | HTTP 200 from `https://api.aethersystems.net/cloud/public/model-catalogue` on September 27, 2026; schema `aether-cloud/public-model-projection@1`, generatedAt `2026-09-27T21:15:38.529Z`, 59 safe rows, canonical digest `sha256:f4601f14ac7829b51e95d92abc1631c74097fa193bc566151a2161c5a799ba7f`. The checked-in raw projection passed the generator's digest and freshness validation before regeneration. |
| Archive evidence | No v0.3.3 release archive or published npm package exists. Exact-head hosted package evidence is pending. |
| Package manifest | The local packed REPL smoke installs the candidate tarball; hosted Windows and Ubuntu evidence is required on the final patch head. |
| Provenance evidence | Pending a future trusted-publishing workflow; no v0.3.3 provenance attestation is claimed. |
| PyPI launcher | The launcher source version is synced to 0.3.3; no PyPI publication is claimed. |
| Required qualification | Full exact-head Windows and Ubuntu tests, supply-chain and release-truth checks, installed-tarball home-folder smoke, and a real Windows/account canary before publication. |
| Rollback | If a later publication regresses, restore npm `latest` to v0.3.2; do not unpublish an existing version. |

## Limits

The nested scan uses synchronous filesystem reads. A single unusually slow
directory read can exceed the wall-clock target; the budget bounds work between
reads and reports incomplete discovery when observed. The packed smoke uses a
synthetic home directory and local HTTP server. It does not prove the user's
account or hosted service response, nor diagnose every HTTP 401.

## Commands retained without a new release-note invocation

These existing visible commands are retained by this maintenance patch:

- `aether help`
- `aether chat`
- `aether run`
- `aether agents`
- `aether github`
- `aether vault`
- `aether workflow`
- `aether memory`
- `aether image`
- `aether video`
- `aether output`
- `aether audit`
- `aether receipt`
- `aether mcp`
- `aether config`
