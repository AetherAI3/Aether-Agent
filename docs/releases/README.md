# Release notes

Dated patch-note log for Aether Agent. One file per release day, named
`YYYY-MM-DD.md`, each summarizing the PRs that landed that day — one sentence
per PR.

For the live command reference, see [COMMANDS.md](../../COMMANDS.md).

Each release also carries an operator packet — `OPERATOR-PACKET-v<version>.md` —
recording the commit the tag must point at, the packed tarball's digest and file
manifest, the evidence gathered, and the founder-owned steps that publish it.

## Index

- [2026-09-03](2026-09-03.md) — **v0.3.2** patch candidate: the v0.3.1
  maintenance line merged back into `main`, restoring the browser-launcher
  verification and putting the declared version ahead of the published one.
  Packet: [OPERATOR-PACKET-v0.3.2.md](OPERATOR-PACKET-v0.3.2.md).
- [2026-08-28](2026-08-28.md) — **v0.3.1** patch candidate: actionable
  Node.js-version recovery and browser-login fallback. Packet:
  [OPERATOR-PACKET-v0.3.1.md](OPERATOR-PACKET-v0.3.1.md).
- [v0.3.0 release body](RELEASE-BODY-v0.3.0.md) — publish-ready user-facing
  notes for the GitHub release. It deliberately makes no pre-publication npm
  claim; the dated publication record is added only after registry verification.
- [2026-08-22](2026-08-22.md) — historical **v0.3.0 candidate** record: the `aether review` → `aether ship` rail, `aether sessions`, skills enforced inside real runs, `aether skills`, `aether capabilities`, `aether support-bundle`, a coding run that refuses to become a chat, plus the unpublished 0.2.0 work and twelve fixes. Packet: [OPERATOR-PACKET-v0.3.0.md](OPERATOR-PACKET-v0.3.0.md).
- [2026-08-19](2026-08-19.md) — **v0.2.0** *(never released; superseded by v0.3.0)*: portable handoffs, `--resume` reaches the brain, `--local "<task>"` works out of the box.
- [2026-08-14](2026-08-14.md) — Durable media output history, one safe opener, and `aether doctor` v2 (fast / `--live` / `--fix`).
- [2026-06-09](2026-06-09.md) — Aether Agent rebrand + slash-command console (PRs #4–#16).
