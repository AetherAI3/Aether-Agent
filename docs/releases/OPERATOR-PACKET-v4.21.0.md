# Operator packet — Aether Agent v4.21.0

This source-candidate packet records what must be verified before the npm
update. The npm registry and immutable release tag will be the authority for
availability after publication.

| Field | Value |
|---|---|
| Package | `aether-agents` |
| Evidence state | `candidate` |
| Proposed tag | `v4.21.0` |
| Source identity | The final release commit must be on `main`; its exact SHA must match the tag and the npm package checkout. ATS source custody remains pinned in `packages/ats-skills-source.json`. |
| Release scope | Slash command discovery, prompt history search, multiline editing, pinned context, one-turn trusted skills, literal prompt-file input, read-only planning, and denial feedback since v4.20.0. |
| Version decision | The owner selected v4.21.0 for the npm CLI. `package.json`, both lockfile root fields, `src/version.ts`, and the PyPI launcher source versions agree. The PyPI upload is a separate release step. |
| Platform evidence | The exact v4.21.0 source has not yet completed Linux and Windows self-hosted release checks. |
| Archive evidence | No v4.21.0 tarball digest, SBOM, or installed-package smoke result has been qualified yet. Self-hosted npm publishing cannot emit npm trusted-publishing provenance. |
| Hosted checks | Three self-hosted runners were online at preparation. Main CI had functional test failures and GitHub artifact upload failures because storage was at quota; exact-source reruns remain pending. |
| Live service evidence | Remote viewing, Cloud/Online admission, ATS entitlement, native headed browser, and broker connectivity need separate live verification before claiming them operational. |
| Publication evidence | No v4.21.0 tag, GitHub Release, npm/PyPI publish, or registry dist-tag update is established by this packet. |
| Rollback | If the npm release must be withdrawn from `latest`, restore the last verified dist-tag and pause dependent rollout; preserve published version history. |

## One-time self-hosted npm exception

The owner authorized this exception for v4.21.0. The reviewed release source
must pass the package verification, audit, full tests, installed-tarball smoke,
and archive digest checks before publication. Package publication requires an
authenticated npm maintainer. Record the source SHA, tarball SHA-256, npm
registry SHA-1, and any failed or unavailable gates in this packet. Do not
claim a GitHub-hosted provenance attestation from a self-hosted publish.

The normal `release.yml` route retains its protected hosted provenance path;
the manual exception does not change that standing workflow.
PR #336 keeps exact-source, audit, parity, and CodeQL evidence in the job logs
while Actions artifact storage is at quota. Its upload exception is restricted
to that same-repository release branch; ordinary CI runs still require uploads.

## Existing commands carried without a new announcement

These commands retain their documented behavior and existing release
dispositions; the v4.21.0 announcement covers the changed coding workflow.

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
