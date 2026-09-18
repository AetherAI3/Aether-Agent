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
| Source identity | Canonical ATS adapter commit `2c38586b7fb011163281fb964b2b9585398717e8`; per-file SHA-256 custody is recorded in `packages/ats-skills-source.json`. The Agent PR records its final candidate commit. |
| Runtime dependency policy | Exactly `aether-ats-skills` 0.2.0 from the checked-in `packages/ats-skills` workspace, published as a versioned dependency and bundled into the CLI. Its exact registry dependencies are `aether-browser` 0.2.2 and `aether-context` 0.3.1. No additional runtime, optional or peer dependencies; no installation hooks. |
| Source custody | ATS owns the canonical source. The Agent copy must match its recorded upstream source and digest; it is not a separate implementation. |
| Required Cloud companion | Cloud #1691 at `13a6ef5857d14d036d7275d123c521a889d804f2`: `/agent/managed`, verified `/identity`, typed ATS profile and additive inventory contract `/1.1`, restacked after Cloud #1687 without replacing its admission/runtime ownership. This client also reads legacy `/1` inventories; local setup requires the verified subject endpoint. |
| Local prerequisites | The ATS Python engine and a reachable Agent Browser runtime are separate prerequisites. The npm context dependency is a launcher, not proof that Python memory is installed or verified. |
| Platform evidence | Linux packed offline installation, CLI selftest and process-held writer lease passed in this workspace. The exact Agent head must pass its Linux/Windows matrix, which now runs the shipped writer-lease test with Python. Native headed Browser/noVNC remains Linux/POSIX-only; a Windows client is not a native Windows browser-host qualification. |
| Archive evidence | Local packed-install checks are recorded below. Release archive, checksum and publishing provenance remain pending. |
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
different machine. Never tunnel, proxy or publish the native noVNC/raw VNC
viewer. LIVE requires a matching, fresh, validated PNG receipt. Browser open,
refresh, stop and retry are explicit; cancellation propagates from chat through
setup and streamed observation. Background updates preserve the terminal draft.
The read-only visual skill returns untrusted page data and image provenance;
Cloud model dispatch and browser actions are not connected by this candidate.
Strategy scanning does not execute Python or PineScript inputs, and unsupported
translation stays visible. Fresh setup installs six reviewed native Nano starter
sources from the exact 55-source Nano 1.0.12 corpus; sources grant neither
execution nor permission. ATS permission modes are local preferences; they do
not authorize live broker orders. The bounded local journal records setup and
lifecycle facts without prompts, page content, source code or credentials.

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

### LOOP-16 v2 follow-up

- Four isolated builders completed before sequential collection; independent
  review reproduced and drove fixes for corrupt-vector readiness, delayed
  browser creation, cleanup persistence, and account-switch races.
- Integrated ATS package: **113 passed, zero skipped** at `2c38586b`, using
  actual Context 0.3.1 and native ATS/Nano in hosted `ats-skills / node-native`
  (run 35288720664). The local Agent suite passed 2,398 of 2,402 tests with
  four platform skips, and its production pack/install verifier passed; hosted
  exact-head Windows/Linux evidence belongs to the final Agent PR head.
- Cloud: **204 independently rerun tests passed**, including canonical full
  OpenAPI regeneration. Account integration: **68 focused tests passed**;
  browser controller: **16 tests passed**. Final Agent full-suite and package
  results belong to the current PR handoff, not these earlier subsets.
- LF-pinned adapter bytes pass the vendor digest gate in a fresh
  `core.autocrlf=true` checkout. This is newline conversion evidence, not an
  actual Windows native-runtime or viewer qualification.
- Memory setup validates native persisted structure and original-byte
  preservation. Its setup lock remains explicitly setup-only; Agent chat now
  separately holds a process-lifetime `ats_runtime_writer` kernel lease, with
  exclusivity tests and parent-death release semantics on POSIX and Windows.
- Typed profiles replace prompt-marker detection. Legacy ownerless bindings,
  create intents and idle-only browser closures are retained and refused for
  silent migration. Unknown browser creation requires owner reconciliation;
  cleanup does not guess from health, expiry or PID death.
- One admitted Cloud-to-local ATS tool run, multimodal model delivery, data
  probes, strategy activation and runtime-confirmed permission changes remain
  separate implementation/qualification gates. Local setup does not enable them.

### Earlier candidate history

- Native ATS package: 61 tests passed with zero skips using published Context 0.3.1, the existing pinned Nano compiler, and the actual ATS compile seam. Browser/transport/visual subset: 34 passed. Full-pool memory preservation and process-tree cleanup regressions passed.
- Agent terminal/controller/managed suites: 45 tests passed; manifest/slash/generated-doc suites: 48 passed; release/package/coherence/public-document suites: 65 passed. Build and all six generated documentation checks passed.
- Final packed-install verification passed: 569 files, 3,468,703 unpacked bytes, all three exact bundled runtimes, offline installation with lifecycle scripts disabled, installed SDK/visual-skill import, CLI and headless selftest.
- The earlier candidate dependency audit reported zero vulnerabilities; this follow-up adds no dependency versions or graph edges.
- The broad Agent test run encountered an existing `review_counts` EPIPE failure. It was reproduced in a detached, untouched `ccbe1595` baseline (10 passes, two EPIPE failures in the isolated review/ship suite). A completely green full suite is not claimed.
- Cross-repository schema check: the ATS profile validates against Cloud's native `AgentConfigV1`. Cloud terminal adapter: 21 focused tests and independent owner/authentication-boundary review passed.
- Companions: [Cloud #1691](https://github.com/AetherAI3/AETHER-CLOUD/pull/1691) and [ATS #441](https://github.com/AetherAI3/ATSv2/pull/441). No live broker, deployed Cloud compatibility, Windows, registry publication or autonomous executor qualification.

- Browser follow-up review: four independent lanes and four bounded review rounds addressed B1–B4; no LOOP-17 convergence claim. Scope and runtime constraints: [review artifact](../loops/ATS_BROWSER_SETUP/2026-09-17/AUDIT-ARTIFACT.md). Actual headed Chrome/noVNC and Cloud vision dispatch remain unqualified.
