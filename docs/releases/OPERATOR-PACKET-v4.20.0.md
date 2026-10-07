# Operator packet — Aether Agent v4.20.0

This packet preserves prerelease qualification and records the manual npm
publication. Registry entries and the release tag, rather than this document,
are the authority for current availability. It does not establish live service
behavior.

| Field | Value |
|---|---|
| Package | `aether-agents` |
| Evidence state | `frozen-prerelease` |
| Proposed tag | `v4.20.0` |
| Source identity | Annotated `v4.20.0` tag and the npm package were built from main commit `020c0cba876ae0dc02f6686de6a2d98e95f398fb`. The later PyPI recovery workflow checks out that tag. ATS source custody remains pinned in `packages/ats-skills-source.json`. |
| Release scope | Coding-console steering, queue controls, shell-result review, persistent PowerShell, goal execution, model selection, Remote Control status and receipts, and managed-agent readiness since v0.4.0. |
| Version decision | The owner selected v4.20.0. This is a major-version jump from v0.4.0; release notes enumerate the delivered changes without claiming compatibility that has not been verified. |
| npm and PyPI agreement | `package.json`, both lockfile root fields, `src/version.ts`, `packages/pypi-cli/pyproject.toml`, and the Python launcher version must all equal 4.20.0. |
| PyPI launcher | `aether-agent` launches the npm `aether-agents` package; it has no Python runtime dependencies. The launcher defaults to npm `latest` unless pinned. |
| Platform evidence | The self-hosted npm preparation rerun passed 3,393 tests, package verification, SBOM creation, installed-tarball smoke, and chat recovery on the release source tree. The local launcher suite passed 29 tests and strict Twine checks. Release truth passed 12/12. The full hosted CI and CodeQL gates remain red due account billing and artifact capacity, so they are not represented as passes. |
| Archive evidence | The manually published npm tarball has SHA-256 `a8417f1e103b8e432ee138d010577372b61b8f98b3f59b5633dcc3ccdadf0d14` and registry SHA-1 `43c6875a51e06e9b6f41385c93b981c092156cdf`. The protected npm provenance attestation was unavailable on the self-hosted route. The GitHub Release draft holds the npm archive and two PyPI distributions. |
| Hosted checks | GitHub Actions artifact storage was full, the account billing lock prevented hosted jobs, and private ATSv2 checkout access remained unavailable. The owner explicitly approved a manual release exception. The Windows self-hosted runner was recovered, but recovery does not turn missing hosted checks green. |
| Live service evidence | Remote viewing, Cloud/Online admission, ATS entitlement, native headed browser, and broker connectivity need separate live verification before claiming them operational. |
| Publication evidence | npm `aether-agents@4.20.0` is live and its registry SHA-1 matches the manual archive. The GitHub Release is still a draft. The protected PyPI `aether-agent==4.20.0` upload is pending approval after restoring the repository's original lowercase name to match its existing trusted publisher. |
| Rollback | If the npm release must be withdrawn from `latest`, restore the last verified dist-tag and pause dependent rollout; preserve published version history. |

## Remaining publication work

1. Approve and complete the `pypi-production` run for v4.20.0, then verify
   the wheel and source distribution on PyPI against the built hashes.
2. Publish the prepared GitHub Release only after both package registries
   report v4.20.0. Keep the manual exception and absent npm provenance visible
   in its release evidence.
3. Restore GitHub Actions artifact capacity, hosted billing, and ATSv2 checkout
   access, then rerun the full release gates as follow-up evidence. Their
   earlier red state remains recorded.

ATS runtime manifests can state a narrow Agent compatibility range. The CLI
passes its product version to that verifier. A v4.20.0 runtime install will
refuse a manifest whose maximum version is below 4.20.0; do not widen a signed
range or imply native runtime installation works without independent proof.

## Existing commands carried without a new announcement

These commands retain their documented behavior and existing release
dispositions. The new work is announced through the changed console, account
agent, and remote viewing paths.

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
