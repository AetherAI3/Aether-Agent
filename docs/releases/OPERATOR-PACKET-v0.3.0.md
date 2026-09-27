# Operator packet — Aether Agent v0.3.0

Everything a founder needs to publish this release, and everything that was
proven before asking. Read-only registry and production probes are recorded
below. No tag, GitHub release, npm publication, or production configuration was
created or changed by those probes.

| | |
|---|---|
| Package | `aether-agents` |
| Proposed tag | `v0.3.0` |
| Original PR branch base | `85a75645e8b94e8542bcf6ee0f384037a2915a5e` (`origin/main`, after #106; historical) |
| Publication code base | `127145725b63c2800bc904ca8908b790238d7fce` (`origin/main`, after #109; #109 changed only the CodeQL workflow) |
| PR #107 final head | `4c4f20bedfb7fb4e93dbe637ea69aa46d112b310` |
| Agent 3.0 merge commit | `bf237bb64f1b74429f7a5835d22961fc17fac901` (tree-identical to the PR #107 final head) |
| Earlier pre-merge candidate | `3cf44bb3f2fc2ae22cc40678209383de8a9f66ad` (historical PR #107 evidence) |
| Tag target | the immutable `v0.3.0` commit after this evidence refresh; its `rc-final.json` and release-workflow evidence are authoritative |
| Historical candidate | `fb96ee44b03f37a386954a32412728fa7e98a046` (PR-local evidence commit; historical only, not reachable from current `main`) |
| Historical archive | `aether-agents-0.3.0.tgz` — 739,977 bytes packed / 3,022,168 unpacked / 575 entries |
| Historical archive sha256 | `70a48aca8baa8b63f551980256eafa42531cd22fc5ca1146829d31f8b4bd2e4d` |
| Current exact-head dry run | 673 entries / 4 workflows |
| GitHub-hosted Ubuntu value | 3,688,966 unpacked bytes — exact-head CI run `33160594500` passed |
| GitHub-hosted Windows value | 3,690,927 unpacked bytes — exact-head CI run `33160594500` passed |
| Current local Windows default-checkout measurement | 3,690,927 unpacked bytes / 836,234 predicted packed bytes |
| Current local Linux/LF checkout measurement | 3,688,966 unpacked bytes / 835,957 predicted packed bytes |
| Qualified pre-merge archive | `aether-agents-0.3.0.tgz` — 835,957 bytes packed / 3,688,966 unpacked / 618 entries at `3cf44bb...`; commit-bound candidate passed install, version, help, skills, capabilities, and handoff proof |
| Qualified pre-merge archive sha256 | `6176172deb15eea57519408d93f23b3fac8ab5e2b2e541adddc34b4e5fb4c33d` — historical only; publication-base evidence is recorded below |
| Qualified final-candidate archive | `aether-agents-0.3.0.tgz` — 835,957 bytes packed / 3,688,966 unpacked / 618 entries at `1271457...`; commit-bound candidate passed release tests, install, version, help, skills, capabilities, and handoff proof |
| Qualified final-candidate archive sha256 | `6176172deb15eea57519408d93f23b3fac8ab5e2b2e541adddc34b4e5fb4c33d` |
| Cloud catalogue compatibility | PR #1327 final head `70e0645c96b16dedfefb90dd403daecb3c3d3b25`; landed as squash merge `fbb7b98a96682820b85a4bface002dcbf5bf9c37`, tree `9906df6f73b6cd8d8e57e1e552475976394d617f`; safe-field projection digest `sha256:80ba3ba1144d301e2cca407ceced74cb2b371f1da6e3982b87305ff12a3d4712`. The package carries all 51 safe rows. On 2026-08-27 production `/cloud/healthz` reported deployed Cloud `c694c8805139`, and the live catalogue returned 51 rows, 48 available to the authenticated tier. |

## 1. Semantic version decision

**0.2.0 → 0.3.0 (minor).**

`main` contains a backwards-compatible feature addition that the v0.2.0 notes
never described: PR #72 added the skills runtime and three new CLI commands —
`aether skills`, `aether capabilities`, `aether support-bundle` — plus six
built-in skills shipped inside the package. Semver makes that a minor bump.

Reusing `0.2.0` was rejected. `0.2.0` is already the name of a specific, dated,
written-up artifact: the RELEASE_NOTES.md entry of 2026-08-19, the README's
availability paragraph, `install.sh`'s pin example, and a packed
`aether-agents-0.2.0.tgz` that lived in the repository root from #83 until #90
deleted it. That tarball predates the skills runtime entirely. Publishing a
different tarball under the same version would make two materially different
artifacts answer to one name — the identity defect this release exists to close.

`0.2.0` is retired unused. It will never be published.

## 2. What the release covers

The historical feature range `477f0fc..a845479` contains 28 commits from
2026-08-19 through 2026-08-22 plus everything the unpublished v0.2.0 notes
described. PR #96 then landed the release-owned notes, coherence gate and
candidate tooling as `84d8767`; PR #106 reconciled the package manifest as
`85a75645`. PR #107 landed the final product spine: generated command/model truth,
bounded local Ollama setup, versioned headless execution, managed preview, and
release-candidate hardening. PR #109 then updated the paired CodeQL actions
without changing packaged content. The actual release range is `v0.1.0`
through the eventual immutable `v0.3.0` tag, not the historical 28-commit slice
alone.

- 4 feature waves: #72 (skills runtime and its three commands), #98
  (command-registration seam), #93/#94/#95/#97/#101/#102 (the review → commit →
  pull request rail, and the two commands that expose it), and #99
  (`aether sessions`) — plus #100, which is what finally puts skills and
  `AGENTS.md` inside a real run and enforces their tool policy.
- 13 user-visible fix commits: #73, #74, #75, #77, #78, #83, #84, #88, #89,
  #91, #103, #104, #105.
- 3 test-only commits: #82, #85, #87.
- 1 documentation/hygiene commit: #90.
- Product-spine additions after that historical range: `aether setup` and
  `aether local` carry explicit `changed` command dispositions, and their
  `ollama.local` requirement is `announced` in the current release notes.

Two of these carry **behaviour changes** — three changes in total, all named in
the "Behaviour changes" section of the release notes. #105 adds exit code 3 for
a run that refuses to degrade into a chat. #104 refuses a symlinked config
directory when writing the token, and reports a planted token link as "no
token" rather than throwing. An operator upgrading a scripted install should
read that section before this one.

Historical per-PR detail: [`2026-08-22.md`](2026-08-22.md). The publish-ready
user-facing body is [`RELEASE-BODY-v0.3.0.md`](RELEASE-BODY-v0.3.0.md).

**This range moved twice after the candidate was first cut, and that is the
normal case.** #98 was squash-merged to `main` while PR #96 was open; then the
review/ship rail, `aether sessions`, the skills wiring, the opener and token-store
fixes and finally #105 landed the same way. The notes and this packet were
regenerated against each new base rather than tagged against the old one. #96
then landed on `main`, and #106 corrected the stale 527-entry manifest that had
survived beside its 575-entry header. PR #107 added the later release-truth,
command-manifest, and bounded local/Ollama work and landed as `bf237bb...`; its
final head `4c4f20b...` has the same tree. PR #109 then landed as `1271457...`
and changed only `.github/workflows/codeql.yml`, so the 618-entry package
payload did not move. These commits are not silently folded into the old
28-commit count: review the actual `v0.1.0..v0.3.0` range after the immutable
tag exists.
`test/release_coherence.test.ts` fails the build if a
user-visible command reaches the registry without either a release note or a
named exemption (§4), so the next lane to land cannot repeat this silently.

## 3. State of the world when this packet was written

Registry and GitHub release state re-read live on 2026-08-28:

```
$ npm view aether-agents versions --json
[
  "0.1.0"
]

$ npm view aether-agents dist-tags --json
{
  "latest": "0.1.0"
}

$ gh release list -R AetherAI3/aether-agent
(no output — zero releases)

$ git tag -l
frozen-seam-v1        -> 48e8be477b22d86136126f40328b2856a1a07d7f
v0.1.0                -> f11bfe6b6c09fd36956958873d9bf4ad941b0fb7
```

There is no `v0.2.0` tag. There is no GitHub release of any version. `0.1.0` is
the only version that has ever existed on npm.

## 4. Evidence

Reproduce with:

```bash
npm run release:candidate -- --out rc.json
```

That runs `.github/workflows/release.yml`'s sequence against a detached
`git worktree` of `HEAD`, before any tag exists: `npm ci --ignore-scripts` →
`npm audit --audit-level=high` → typecheck → build → tests → `verify:production
--tag v0.3.0` → `npm pack` → global install of **that tarball** into a clean
prefix → CLI proofs run from the installed package.

There are three evidence classes below. The **publication-base candidate** is
bound to `127145725b63c2800bc904ca8908b790238d7fce`; it produced the current
archive and installed-CLI proof. The earlier `3cf44bb...` archive is retained as
pre-merge provenance, and the `fb96ee44...` archive is older historical
provenance. This packet does not pretend to embed its own future squash-merge
commit: the immutable tag plus `rc-final.json` and release-workflow evidence
bind the exact final commit after this documentation-only refresh lands.

### Final publication-base evidence

The clean candidate generated at `2026-08-28T10:13:43.917Z` for `1271457...`
reported `commitBound: true`, `ok: true`, 618 entries, 4 workflows, and
`aether-agents-0.3.0.tgz` at 835,957 packed bytes / 3,688,966 unpacked bytes.
Its SHA-256 is
`6176172deb15eea57519408d93f23b3fac8ab5e2b2e541adddc34b4e5fb4c33d`.
The candidate passed dependency install, high-severity audit, typecheck, build,
the release-owned tests, production verification, pack, clean global install,
installed version/help/skills/capabilities checks, and the installed handoff
demo.

Exact-head CI run `33160594500` confirmed the full suite and both hosted package
measurements at `127145725b63c2800bc904ca8908b790238d7fce`: Ubuntu ran 1,618
tests with 1,618 pass, 0 fail, and 0 skips; Windows ran 1,618 tests with 1,615
pass, 0 fail, and 3 documented platform skips. The same SHA passed CodeQL run
`33160594506` and release-truth run `33160594427`. Hosted and local clean
checkouts measured 3,688,966 unpacked bytes for Linux/LF and 3,690,927 for
Windows/default. The local Windows default checkout measured 3,690,927
unpacked / 836,234 predicted packed bytes; the clean LF checkout on the same
Node 24.18.0/npm 11.16.0 toolchain measured 3,688,966 unpacked / 835,957
predicted packed bytes. Membership is identical; byte totals are
checkout/toolchain observations and are not claimed to be cross-machine
reproducible.

The complete top-level npm dry-run reports for the two clean checkout shapes
were:

```json
{"host":"Linux/LF","id":"aether-agents@0.3.0","name":"aether-agents","version":"0.3.0","size":835957,"unpackedSize":3688966,"shasum":"66021f08d961ddd7b9236ce56afc356a48a45997","integrity":"sha512-wkguCmwwWX0ZhY1ZISnYTqhAppwMNawBhXRZxPFErjW8kS4ltMcwd5L5KpNE+vpeOlLnQyuD+/v6+H1AKE3TnA==","filename":"aether-agents-0.3.0.tgz","entryCount":618,"bundled":[]}
{"host":"Windows/default","id":"aether-agents@0.3.0","name":"aether-agents","version":"0.3.0","size":836234,"unpackedSize":3690927,"shasum":"ee9a89bc55c749f238707dc51a9c2b07c1a72631","integrity":"sha512-tUPTKa0MZhSgUFSR368iXAMsdmQHHuKEeYWg3F88BVbXIPbj19snaDBdXpmFAQf3n1RwIhz+vAIP8TL+tmwIEw==","filename":"aether-agents-0.3.0.tgz","entryCount":618,"bundled":[]}
```

The npm-reported `shasum` and `integrity` values above are host-bound dry-run
metadata. The candidate SHA-256 above is the digest of the archive produced on
this machine; reproducibility is asserted by package membership and exact-head
gates, not by assuming gzip bytes are identical across hosts.

The current command surface also includes `aether preview
start|open|logs|status|stop` and `/preview`. It manages only an explicit argv or
an argv declared in the confined `.aether/preview.json` contract. Start shows
the command, working directory, filesystem, environment, and loopback-network
implications before requiring consent. An owner-private, one-use challenge
authenticates control; the local supervisor owns readiness, logs, status, stop,
and full process-tree cleanup. Stale PIDs are not
signalled, and headless runs print the ready URL without claiming a browser was
opened. This local capability does not relax `src/core/web.ts` SSRF policy.

### Historical candidate archive

The prior candidate report records commit
`fb96ee44b03f37a386954a32412728fa7e98a046`, `commitBound: true`, `ok: true`,
and process exit 0. That PR-local evidence commit is not present in the
reachable history of current `main`; the block is retained only as provenance
for the historical 575-entry archive it actually measured.

```
PASS     commit-identity — fb96ee44b03f37a386954a32412728fa7e98a046
PASS     stage-commit — detached worktree of that commit
PASS     npm-ci-ignore-scripts — found 0 vulnerabilities
PASS     npm-audit-high — found 0 vulnerabilities
PASS     typecheck — tsc --noEmit exit 0
PASS     build — copied 18 built-in skill assets → dist/src/skills/builtin
PASS     release-tests — 4 release test files, exit 0
NOT-RUN  npm-test — NOT RUN here — the full suite is release.yml's gate.
                    This report says nothing about it.
PASS     verify-production — {"ok":true,"package":"aether-agents","version":"0.3.0",
                             "packedFiles":575,"packedBytes":3022168,"workflows":3}
PASS     pack — aether-agents-0.3.0.tgz
                sha256:70a48aca8baa8b63f551980256eafa42531cd22fc5ca1146829d31f8b4bd2e4d
PASS     install-tarball — <prefix>/node_modules/aether-agents
PASS     installed --version — 0.3.0
PASS     installed --help — 49 lines, lists skills, capabilities, resume, agent, doctor
PASS     installed skills list — aether/frontend-from-screenshot@1.0.0 builtin enabled …
PASS     installed capabilities — instructions        unavailable (agent_skills_disabled)
PASS     installed demo:handoff — independent test run in machine-b/slugify: green

RELEASE CANDIDATE OK
```

The last five lines all ran the CLI that `npm install --global` placed on disk
from that historical tarball, in a clean prefix — not `dist/` in a source
checkout. They must not be presented as exact-head CLI evidence.

**The digest changed when the base moved, and that is the point.** This packet
has now recorded three historical digests for the same version number:
`25f33524…` at `a63e1c6e` over 524 entries, `8c5c119d…` at `426b124` over 527,
and `70a48aca…` for the PR-local `fb96ee44…` candidate over 575. Each lane that
landed genuinely changed the packed content — #98 added the dispatch table,
#93–#102 added the review/ship rail, #99 the session library, #105 the routing
guard — so the digest moved with it. A digest that had survived those changes
would have meant the pack was not reading the tree.

The historical `70a48aca…` digest belongs only to the 575-entry archive in the
candidate block. The publication-base run produced the current 618-entry
archive and its `6176172d…` digest. This packet remains outside the tarball: the
`files` allowlist is `dist/src`, the four generated public documents, README,
COMMANDS, LICENSE, and NOTICE; `docs/releases/` and the coherence tests remain
excluded.

None of these figures is a cross-machine reproducibility claim (see §5). The
publication-base digest is the local comparison value; the immutable-tag
workflow must regenerate and attest its own archive before npm publication.

On this evidence-refresh branch, `npm run typecheck`, `npm run docs:check`, and
`release:truth` pass; release truth reports 12/12 with no failed, unavailable,
or not-applicable lane. The focused release-coherence/release-truth set reports
35 pass / 0 fail. Exact publication-base CI supplies the full-suite evidence:
1,618/1,618 pass on Ubuntu and 1,615 pass / 0 fail / 3 documented skips on
Windows.

### Historical mutation check on the load-bearing gate

`test/release_coherence.test.ts` asserts that every feature the release notes
promise has its code inside the file list `npm pack` would ship. To show that
gate is real, `"!dist/src/commands/skills.js"` was added to the `files`
allowlist, which silently drops `aether skills` from the tarball:

```
production manifest + pack validators -> no errors, 574 files    MISSED IT
release_coherence -> 2 FAIL: packet measurement changed, and
                              dist/src/commands/skills.js is missing
                              (agent skills runtime — `aether skills`)
```

Restored: 575 packed files, 12/12 pass. The pre-existing production gate does not
catch a dropped feature, because it does not know what the notes promised.

### Current dry-run packaged file manifest

The exact-head candidate dry runs reported 673 entries on clean Linux/LF and
Windows/default checkouts. Exact-head CI confirmed their 3,688,966 and
3,690,927 unpacked-byte results on the corresponding hosted platforms;
local default and LF checkouts measured 3,690,927 and 3,688,966 respectively
because byte totals can move with checkout line
endings and toolchain metadata. Five files are at the package root, one owned
asset is under `assets/`, four generated public documents are under `docs/`,
and everything else is under `dist/src/`. The publication-base candidate produced the archive recorded at
the top of this packet from exactly this membership.

| Path | Entries |
|---|---:|
| `COMMANDS.md`, `LICENSE`, `NOTICE.md`, `README.md`, `package.json` | 5 |
| `assets/**` | 1 |
| `docs/generated/**`, `docs/model-catalogue/**` | 4 |
| `dist/src/core/**` | 378 |
| `dist/src/ui/**` | 117 |
| `dist/src/commands/**` | 135 |
| `dist/src/skills/**` (six built-in skills) | 18 |
| `dist/src/generated/**` | 3 |
| `dist/src/{index,main,types,version}.*` | 12 |

By extension: 215 `.js`, 215 `.d.ts`, 215 `.js.map`, 14 `.json`, 11 `.md`, 1
`.html`, 1 `.png`, 1 extensionless. Source maps ship, as they did in 0.1.0; that is
existing policy, unchanged by this release.

No compiled tests, no `.env`, no `.tgz`, no `dist/scripts`. `verify-production`
rejects each of those by name and the pack report above confirms their absence.

### Commands that ship without a release note

Gate B above runs notes → package: a claim with no code behind it fails. The
inverse — a user-visible command that ships with **no claim anywhere in the
notes** — is the direction that actually keeps happening, and it happened to this
very release while its PR was open (#98). `release_coherence` now enforces both
directions: every visible command in the CLI registry must be announced by some
release note, or named here with a reason.

These 15 commands ship in 0.3.0 without a release note. All predate the release
log or were announced by capability rather than by command token in an earlier
entry. **None of them is new in this release:**

`aether help`, `aether chat`, `aether run`, `aether agents`, `aether github`,
`aether vault`, `aether workflow`, `aether memory`, `aether image`,
`aether video`, `aether output`, `aether audit`, `aether receipt`, `aether mcp`,
`aether config`.

Two changes since the candidate was first cut, both made by the gate rather
than by hand:

- **`aether auth` left the list.** The v0.3.0 notes now carry an Authentication
  section naming `aether auth login` and `aether auth logout`, so it is
  announced, and the list refuses to keep an exemption for a command that is.
- **`aether output` joined it.** It was never announced by command token; it was
  covered by the 2026-08-14 entry as "durable media output history". It only
  became visible here because the announcement matcher was tightened (below).

The six commands this release DOES add — `aether review`, `aether ship`,
`aether sessions`, the already-announced `aether doctor`, and the product-spine
`aether setup` / `aether local` surfaces — are all announced
in the v0.3.0 entry, so none of them appears above.

`login` and `logout` are exempt by rule: the registry marks them `hidden`, so
they are not surfaced in `aether --help` and there is no surface to announce.

The list is enforced in both directions — a stale entry fails, and an entry that
*is* announced fails — so it cannot rot into a permanent bypass that quietly
absorbs the next unannounced command. **If a lane lands a new command before the
tag is cut, the build fails until it is either announced or added here.**

#### The announcement matcher was vacuous, and is not any more

Worth reading before trusting the list above. The matcher counted a command as
announced if the notes contained its name in bare backticks *anywhere*. When
#102 landed `aether review` and `aether ship`, the gate passed both of them
immediately — not because they were announced, but because the notes mention the
built-in **skills** named `review-pr` and `ship`. The gate built to catch an
unannounced command would have let the two headline commands of this release
through in silence.

It now requires the form a user actually types, `aether <name>`. A test asserts
the matcher rejects `review-pr` as an announcement of `review` and `` `ship` ``
as an announcement of `ship`, so this cannot regress into coverage that is not
there. Tightening it is what surfaced `aether output`.

#### Mutation check on the inverse gate

A command was added to the CLI registry and mentioned nowhere:

```
{ name: "teleport", args: "<dest>", summary: "beam the working tree somewhere",
  section: "System" }

release_coherence -> FAIL: no user-visible command ships without either a
                     release note or a named exemption
                     + [ 'teleport — beam the working tree somewhere' ]
                     - []
```

The production manifest and pack validators reported no errors at 575 files and
3,022,363 unpacked bytes. `release_coherence` failed the unannounced `teleport`
command. Removed: 12/12 pass, and the restored package returned byte-for-byte
to 3,022,168 unpacked bytes.

## 5. What is NOT proven

Named as unproven rather than omitted:

- **npm availability of 0.3.0.** Nothing here contacted the registry to publish.
  Until §6 step 7 completes, describe an unversioned install as following the
  registry's live `latest` dist-tag; do not hard-code which version that tag
  selects.
- **The full `npm test` suite inside the local candidate report.** The harness
  intentionally reports `npm-test` as `not-run` unless `--full-tests`
  is supplied. Full-suite proof is instead exact-head CI run `33160594500` at
  `1271457...`: 1,618/1,618 pass with zero skips on Ubuntu, and 1,615 pass / 0
  fail / 3 documented skips on Windows. This distinction prevents the local
  candidate report from claiming a step it did not run.
- **The hosted UID-boundary/Predator admission path.** Its zero-step hosted
  admission failure was accepted when Cloud #1339 and Agent #107 landed as
  post-release infrastructure hardening. It is not represented as passing and
  is not a v0.3.0 publication blocker.
- **Logout semantics on the deployed API.** The authenticated exact-head smoke
  reached `https://api.aethersystems.net/cloud` and received a cloud turn, and
  `/cloud/healthz` reported `c694c8805139`. The release can therefore claim
  authenticated reachability, not that `/auth/logout` was independently
  exercised during this release.
- **That `aether agent` works against production today.** #105 exists because
  it does not: `AETHER_AGENT_DEV_ENABLED` is unset on `api.aethersystems.net`,
  and the 2026-08-27 doctor canary returned HTTP 403. No session was created,
  UVT and cents stayed at zero, and no orphan remained. A coding run is refused
  and — as of this release — the run now **exits 3**
  instead of silently becoming a chat. That is the correct behaviour and it is
  still a broken end-to-end path. It is a server configuration gap, not
  something this tag fixes.
- **A production-hosted headless driver.** `aether exec` ships the local
  `aether.exec/1` and `/2` foundations with checkpoints, acknowledged controls,
  confined definitions, receipts, and authoritative verification. The Cloud
  driver remains unavailable while production DevSessions are disabled;
  unsupported hosted control stays closed.
- **A live catalogue guarantee.** The package carries a sanitized 51-row dated
  projection with explicit availability semantics. Production also returned 51
  safe rows during qualification, but the packaged snapshot is not a promise
  that provider availability cannot change after publication.
- **The Aether Online or Aether Code handoff.** Cloud PR #1329 landed a
  default-off owner-bound redemption contract, but this package exposes no
  supported public handoff command and no activated production intake was
  qualified. No client-only substitute is treated as the Online bridge.
- **The eventual tag commit's workflow archive and digest.** The current
  618-entry archive is bound to publication code base `1271457...`. This
  evidence refresh touches only excluded release documentation and tests, but
  the release workflow must still regenerate and attest the archive from the
  immutable tag.
- **Reproducibility of an archive digest across machines.** Once the exact-head
  archive exists, its digest is a machine reading to compare with CI, not a
  promise that another machine must produce byte-identical gzip bytes.
- **`npm audit` against future advisories.** The audit result is a reading taken
  at pack time, not a standing property.

## 6. Publication procedure

Cloud #1339 and Agent #107 are merged. Their former draft, review, manifest,
Predator, and merge gates are complete or explicitly dispositioned; they are
not publication gates to reopen.

1. **Freeze final `main`.** Fetch it, require a clean worktree, verify all three
   version sources are `0.3.0`, and run the commit-bound candidate. Require
   `"ok": true`, `"commitBound": true`, the installed CLI checks, and successful
   exact-head Linux, Windows, supply-chain, CodeQL, and release-truth checks.

2. **Verify publication authentication before creating public state.** The
   `npm-production` environment must exist, require owner review, allow the
   `v*` tag policy, and permit the workflow's OIDC/attestation permissions. The
   npm package must trust GitHub owner `AetherAI3`, repository `aether-agent`,
   workflow filename `release.yml`, and environment `npm-production`, with
   direct `npm publish` allowed and staged publishing disabled.

   Live check on 2026-08-28: the GitHub environment and tag policy match, and
   the operator configured that exact npm trusted-publisher connection. The
   connection is intentionally tokenless: `npm whoami` does not exercise OIDC,
   and npm validates the saved identity only during the publish operation. The
   exact GitHub-hosted release run is therefore the definitive authentication
   proof; it must fail closed without creating a second package version if the
   npm-side connection does not match.

3. **Create and push immutable tag `v0.3.0`** at the qualified final `main` SHA.
   Never move or retarget it.

4. **Publish GitHub Release `v0.3.0`** using
   [`RELEASE-BODY-v0.3.0.md`](RELEASE-BODY-v0.3.0.md). Publication triggers the
   existing `Release npm package` workflow.

5. **Approve and follow the release workflow.** It checks out the tag, proves
   main ancestry, runs the full suite and production policy, creates the
   CycloneDX SBOM and tarball, clean-installs the tarball, attests provenance,
   uploads evidence, and publishes with `--access public --provenance`.

6. **Verify the registry independently.** Require `aether-agents@0.3.0`, the
   `latest` dist-tag at `0.3.0`, expected provenance metadata, and a clean global
   install whose version, help, skills, capabilities, and model-free canaries
   pass. Record the workflow run and published tarball digest.

7. **Land post-publication truth.** Only after registry verification, remove the
   README's transitional source-build workaround, add the dated published
   release record, and publish the canonical AetherCloud patch-note batch with
   Agent 3.0 classified as `PUBLISHED`.

## 7. Credentials

No Aether credential, npm token or GitHub token was used, read, or written by
the release-candidate run. `release.yml` never references `NPM_TOKEN` or
`NODE_AUTH_TOKEN`; its GitHub-hosted publish job requests a short-lived npm OIDC
identity only inside the protected `npm-production` environment. The checkout
step sets `persist-credentials: false` so no token is left in git configuration.
