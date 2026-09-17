# Operator packet — Aether Agent v0.4.0

This is a source-candidate record. It does not authorize a tag, package publish,
production deployment or live trading. Attach evidence for the final commit
before evaluating release readiness.

| Field | Value |
|---|---|
| Package | `aether-agents` |
| Evidence state | `candidate` |
| Proposed tag | `v0.4.0` |
| Release scope | Shared Cloud managed-agent inventory, creation, customization and Online DM chat; guided ATS device setup, native strategy preparation and bounded browser observation. |
| Version decision | A minor release for the new account-agent workflow and bundled ATS runtime dependency. |
| Source identity | Canonical ATS adapter commit `8f8ac98e023c8cb3665d258c634e65bb0d041602`; per-file SHA-256 custody is recorded in `packages/ats-skills-source.json`. The Agent PR records its final candidate commit. |
| Runtime dependency policy | Exactly `aether-ats-skills` 0.1.0 from `file:packages/ats-skills`, bundled into the CLI. Its exact registry dependencies are `aether-browser` 0.2.2 and `aether-context` 0.3.1. No additional runtime, optional or peer dependencies; no installation hooks. |
| Source custody | ATS owns the canonical source. The Agent copy must match its recorded upstream source and digest; it is not a separate implementation. |
| Required Cloud companion | `/agent/managed` terminal adapter with canonical account authentication, owner-scoped agents, revision checks, exact conversation binding and existing admission gates. |
| Local prerequisites | The ATS Python engine and a reachable Agent Browser runtime are separate prerequisites. The npm context dependency is a launcher, not proof that Python memory is installed or verified. |
| Platform evidence | Linux packed offline installation and CLI selftest passed in this workspace. Windows packed-install/terminal/browser qualification remains required. |
| Archive evidence | Final source pack check passed: 563 files, 3,409,680 unpacked bytes, all three exact bundled runtimes, offline installation with lifecycle scripts disabled, CLI/headless selftest. |
| Hosted checks | Required exact-commit CI, CodeQL, supply-chain audit, generated-documentation, production-package and release-truth checks pending. |
| Live service evidence | Deployment of the Cloud adapter, actual web/terminal DM sync, model/UVT execution and broker connectivity are not established by local tests. |
| Publication evidence | No npm/PyPI publish, tag, trusted-publishing provenance or registry dist-tag update is established by this packet. |
| PyPI launcher | Version synchronized with `node packages/sync-version.mjs`; still launches npm `latest` unless explicitly pinned. No Python runtime dependency added. |
| License scope | The Agent and bundled ATS adapter are Apache-2.0. The paid ATS engine is a separate prerequisite and is not bundled into the CLI. |
| Rollback | Before publication, revise or withdraw the candidate. After publication, restore the previously verified npm dist-tag and feature rollout if needed; preserve published version history. |

## Qualification sequence

1. Freeze canonical ATS package source and its Agent copy; verify the recorded
   source digest, manifest pins and lockfile graph.
2. Run package tests, Agent typecheck and tests, generated-doc checks and the
   bounded dependency/source-policy gates on the exact candidate commit.
3. Run `npm run verify:production -- --tag v0.4.0`. It inspects the actual pack,
   verifies installed runtime manifests, installs the tarball offline with
   lifecycle scripts disabled, and runs the existing packaged CLI selftest.
4. Complete Windows and Linux clean-install canaries and live Cloud/Online
   compatibility verification. Record unavailable boundaries as unavailable.
5. Run the existing release-truth and supply-chain gates. Only the existing
   protected release workflows can establish publication and provenance.

## Product boundary

Creating an agent saves a draft. It does not imply activation, UVT reservation,
an ATS entitlement or a running executor. A saved/blocked DM receipt retains
its actual admission state. Local context persistence does not satisfy APR's
separate memory activation gate.

Browser observation has a finite budget and freshness checks. Remote API
observation does not expose a server's unauthenticated loopback viewer to a
different machine. Strategy scanning does not execute Python or PineScript
inputs, and unsupported translation stays visible. ATS permission modes are
local preferences; they do not authorize live broker orders.

This candidate is not evidence for autonomous trading. No provider session,
real credential, paid account, live broker or market order is used by the local
verification recorded in this change.

## Existing commands carried without a new release-note announcement

These commands keep their prior behavior and their named release exemptions.
The new managed-agent workflow is announced through the existing `agent`
command, not through a second agent registry.

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

## Local validation record

- Native ATS package: 39 tests passed with zero skips using published Context 0.3.1, the existing pinned Nano compiler, and the actual ATS compile seam. Full-pool memory preservation and process-tree cleanup regressions passed.
- Agent final focused feature suites: 43 tests passed; build and all six generated documentation checks passed. Release/package-policy, release-coherence, audit-helper and PyPI launcher suites also passed.
- Real npm audit reported zero vulnerabilities.
- The broad Agent test run encountered an existing `review_counts` EPIPE failure. It was reproduced in a detached, untouched `ccbe1595` baseline (10 passes, two EPIPE failures in the isolated review/ship suite). A completely green full suite is not claimed.
- Cross-repository schema check: the ATS profile validates against Cloud's native `AgentConfigV1`. Cloud terminal adapter: 21 focused tests and independent owner/authentication-boundary review passed.
- Companions: [Cloud #1691](https://github.com/AetherAI3/AETHER-CLOUD/pull/1691) and [ATS #441](https://github.com/AetherAI3/ATSv2/pull/441). No live broker, deployed Cloud compatibility, Windows, registry publication or autonomous executor qualification.
