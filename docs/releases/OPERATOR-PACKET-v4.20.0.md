# Operator packet — Aether Agent v4.20.0

This is a source candidate record. It binds the intended release to a version
and scope; it does not establish registry publication or live service behavior.

| Field | Value |
|---|---|
| Package | `aether-agents` |
| Evidence state | `candidate` |
| Proposed tag | `v4.20.0` |
| Source identity | The final release commit must be on `main`; its exact SHA must match the tag and the npm and PyPI workflow checkouts. ATS source custody remains pinned in `packages/ats-skills-source.json`. |
| Release scope | Coding-console steering, queue controls, shell-result review, persistent PowerShell, goal execution, model selection, Remote Control status and receipts, and managed-agent readiness since v0.4.0. |
| Version decision | The owner selected v4.20.0. This is a major-version jump from v0.4.0; release notes enumerate the delivered changes without claiming compatibility that has not been verified. |
| npm and PyPI agreement | `package.json`, both lockfile root fields, `src/version.ts`, `packages/pypi-cli/pyproject.toml`, and the Python launcher version must all equal 4.20.0. |
| PyPI launcher | `aether-agent` launches the npm `aether-agents` package; it has no Python runtime dependencies. The launcher defaults to npm `latest` unless pinned. |
| Platform evidence | Exact-final-head Linux and Windows CI, both clean installs, package verification, release truth, and CodeQL are required. A queued or failed job is not a pass. |
| Archive evidence | The final tag archive, package digest, SBOM, provenance, and installed tarball smoke remain pending until protected workflows complete. |
| Hosted checks | At candidate preparation, the latest `main` checks were failing or queued: release truth found a stale README slash-command example and the prior published version's candidate packet; CI and CodeQL could not upload required evidence because GitHub artifact storage quota was full; the Windows self-hosted runner was offline. Rerun on the exact final commit after these conditions clear. |
| Live service evidence | Remote viewing, Cloud/Online admission, ATS entitlement, native headed browser, and broker connectivity need separate live verification before claiming them operational. |
| Publication evidence | No `v4.20.0` tag, GitHub Release, npm/PyPI publish, trusted-publishing provenance, or registry dist-tag update is established by this packet. |
| Rollback | Before publication, revise the candidate. After publication, restore the last verified npm dist-tag and pause dependent rollout if needed; preserve published version history. |

## Qualification sequence

1. Review the final diff and freeze the exact `main` commit.
2. Confirm the three self-hosted runners are online. Run Linux and Windows CI,
   both clean installs, CodeQL, release truth, PyPI launcher checks, and the
   production package verifier on that commit.
3. Resolve GitHub artifact storage quota so all required evidence uploads pass.
4. Verify `npm run verify:production -- --tag v4.20.0`, the exact packed CLI,
   and the PyPI wheel in clean environments.
5. Tag the verified commit and publish its GitHub Release. The protected npm
   and PyPI workflows must each complete and record registry versions, package
   hashes, and provenance before this packet can be called published.

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
