# CONTRACTS — canonical wire protocols

This file is the **single source of truth** for cross-process wire contracts.
Both bridge mirrors (TS host + Python brain) build against THIS doc.
Changing a shape here is a deliberate, versioned act — not a side effect of a
code edit. If code and this doc disagree, **this doc wins** and the code is the
bug.

---

## 1. AetherCode ↔ Brain bridge event protocol  ·  `PROTOCOL_VERSION = 3`

The event seam between the headless brain (decides) and the TS host (renders +
executes). Full prose + rationale: [`BRIDGE_PROTOCOL.md`](./BRIDGE_PROTOCOL.md).

**Mirrors that MUST stay in lockstep with this version:**
- `aether_agent/protocol.py` (Unlimited-Context) — `PROTOCOL_VERSION`
- `src/core/brain_protocol.ts` (this repo) — `PROTOCOL_VERSION`

**Conformance fixture (the drift detector):** an identical
`bridge_conformance.json` lives in `test/fixtures/` (this repo) and
`tests/fixtures/` (Unlimited-Context). Each side's test suite loads its copy and
asserts its codec round-trips every message + that `protocol_version` matches the
constant. A failing conformance test = drift; fix the code or bump the version.

### Versioning rule

`PROTOCOL_VERSION` is the **MAJOR** (breaking) integer. Bump it (here + both
mirrors + both fixtures) only on a BREAKING change:
- removing/renaming a message `type` or field,
- changing a field's type or wire key, or making an optional field required.

**Additive, forward-compatible changes do NOT bump the integer** — a new message
`type`, or a new OPTIONAL field on an existing message, that old (v1) consumers
safely IGNORE. This is deliberate: downstream consumers gate on the integer, and
a bump falsely signals "breaking" to them. Additive changes are
instead recorded here + mirrored in both codecs + added to the fixture so the
conformance test covers them. (Receivers MUST already ignore unknown `type`s.)

History:
- **v2** — `turn` event + `done.remaining`/`done.reason` + `task.test_cmd` (the
  loop-fix / final-verification-gate patch). All additions are backward-tolerant
  (old consumers ignore the new event + optional fields); the integer was bumped
  to 2 alongside the schema rev so the conformance fixture stays in lockstep
  across both repos.
- **v3** — the `web_search`/`web_fetch` tools joined `TOOLS` (see Invariant 2).
  Separately, and never recorded here until now: the workflow swarm frames —
  `workflow_start`, `phase_start`, `phase_done`, `agent_spawn`,
  `agent_progress`, `agent_done`, `workflow_done` (the CODEPRO/HIGH+-effort
  multi-agent workflow view) — also landed in `brain_protocol.ts` during the
  v2->v3 window. Per the versioning rule above they're purely additive and
  didn't need their own bump; this doc's silence on them until now was a
  drift, not a deliberate omission, closed by this change per this doc's own
  rule ("if code and this doc disagree, this doc wins and the code is the
  bug"). Also additive, layered on top of the now-documented v3 baseline:
  `agent_done` gained optional `tokens`/`tool_calls`/`duration_ms` (Tier-2/3
  per-agent metrics for the terminal/desktop workflow panels —
  `docs/specs/2026-07-10-workflow-viewer-agent-panel-design.md`); absent on
  the wire, these decode to `undefined`, never a fabricated `0`.
- **Known gap:** `test/fixtures/bridge_conformance.json` (this repo) does not
  yet include any of the v3 workflow-swarm frames in its `events` array, so
  the conformance/drift-detector tests below don't exercise them. Extending
  the fixture requires an identical update to the Unlimited-Context mirror's
  copy (`tests/fixtures/bridge_conformance.json`, a separate repo) to avoid
  creating the exact cross-repo drift this fixture exists to prevent —
  flagged here, deliberately left for a coordinated cross-repo change rather
  than fixed unilaterally in this PR.

### Messages (wire = NDJSON, one JSON object per line, keys snake_case, ASCII-safe)

**brain → host (events)**

| type | fields | meaning |
|---|---|---|
| `stage` | `name, face` | staged-lifecycle marker |
| `monologue` | `text, depth` | nested reasoning-tree line |
| `skill` | `name, reason` | a procedure packet was pinned |
| `turn` | `n, tool_calls, malformed, invented, no_call, fail_count` | per-assistant-turn diag (§8 emission curve) |
| `tool_call` | `id, name, args` | host must execute + reply with `tool_result` (same `id`) |
| `telemetry` | `tokens, tps, ctx_used, ctx_cap, vram` | live effort/velocity |
| `status` | `phase, pool_used, pool_cap` | drives the pool bar (`pool_cap = pool_gb × 233M`) |
| `checkpoint` | `git_sha` | a verified step was committed |
| `done` | `ok, result, remaining, reason` | run finished; `ok` from a real final test run (see invariant 5) |
| `error` | `msg` | run aborted |
| `workflow_start` | `workflow_id, phases[{n, type, agents}], total_agents` | a CODEPRO/HIGH+ multi-agent workflow began |
| `phase_start` | `phase_n, phase_type, agent_count` | a workflow phase began |
| `phase_done` | `phase_n, artifact_summary` | a workflow phase completed |
| `agent_spawn` | `agent_id, phase_n, brief` | one swarm agent started |
| `agent_progress` | `agent_id, delta` | streamed output from one swarm agent (emitter not confirmed on the shared backend — see `docs/specs/2026-07-10-workflow-viewer-agent-panel-design.md` Finding E) |
| `agent_done` | `agent_id, phase_n, summary, tokens?, tool_calls?, duration_ms?` | one swarm agent finished; the last 3 fields are optional Tier-2/3 metrics, absent on older brains |
| `workflow_done` | `synthesis, total_phases, total_agents` | the multi-agent workflow finished |

**host → brain (commands)**

| type | fields | meaning |
|---|---|---|
| `task` | `text, cwd, pool_gb, effort, model, test_cmd` | starts a run (first message). `test_cmd`="" → unverifiable run |
| `tool_result` | `id, output, exit_code` | reply to a `tool_call` (id MUST echo) |
| `control` | `action (pause\|resume\|steer), note` | interactive control |

### Invariants (enforced by tests)

1. **Tool-call correlation.** The brain emits ONE `tool_call` and blocks until
   the host replies, so replies are strictly ordered. A `tool_result` whose `id`
   does not match the outstanding call is a protocol violation → the brain emits
   `error` and aborts (it does NOT skip — skipping mis-pairs results to calls).
2. **One tool implementation, host-side.** `read_file · write_file · run_shell ·
   run_tests · repo_search · git_commit · web_search · web_fetch` (the full
   canonical `TOOLS` set, `src/core/brain_protocol.ts`; this row previously
   listed only the first 6 — pre-existing drift, closed by this change). A
   single path-guard canonicalizes (realpath: resolves `..`, absolute paths,
   and symlinks) BEFORE the workspace allowlist check for the filesystem/shell
   tools; `web_search`/`web_fetch` have no repo path to canonicalize and are
   guarded separately (SSRF/loopback/redirect checks, `src/core/web.ts`).
   Output is `[exit N]\n…`, capped, with stderr captured.
3. **Encoding is lossless, codec-boundary only.** The wire is ASCII-escaped
   (`ensure_ascii`) so it survives a Windows cp1252 pipe; decode restores exact
   UTF-8. Rendered frames are real UTF-8 — escaping never touches them.
4. **Cloud parity (honest gap).** Today's cloud SSE runs tools server-side and
   emits no `tool_call` frame, so `CloudBrain.sendToolResult` is a no-op. When
   the server adds `tool_call` frames + an upstream channel it implements the
   same round-trip — no host change. This is a known divergence, not silent.
5. **`done.ok` is ground-truth, never self-report.** The brain runs the test
   command one final time before `done` and derives `ok` from its exit code — an
   agent must never emit `ok:true` that contradicts its own last `run_tests`. A
   no-tool-call turn means "verify, then keep going or stall", NOT "success".
   `done.reason` ∈ {"", stalled, no-progress, max-turns, unverified}; the host
   manifest's `finalStatus` mirrors it (`ok` only on a verified green;
   `unverified` when `task.test_cmd`=""). `remaining` = failing tests when not ok.

---

## 2. ATS trading contracts (Spec 1, Gate 1.0)  ·  frozen

The cross-repository shapes for local broker connectors, account onboarding and
the approval bridge. Mirrors: `src/core/ats_contracts/` (this repo, TypeScript)
and the ATSv2 Python connector core. Source spec: *Aether Agent trading
integrations finale — Spec 1*, sections 11.1–11.8.

**Conformance fixture (the drift detector):** `test/fixtures/ats_contracts_golden.json`
holds one validated example per schema plus its canonical digest. The ATSv2
Python suite keeps an identical copy. Each side validates every document and
asserts the recorded digest byte-for-byte; a mismatch is canonicalization drift,
not a test to relax.

### Frozen schema tags

| Tag | Shape | Spec |
|---|---|---|
| `aether.ats.execution-state/1` | requested-vs-effective mode | 1 §11.8, 2 §7.2 |
| `aether.ats.connector-capability/1` | `BrokerConnectorCapabilityV1` | 1 §11.1 |
| `aether.ats.account-binding/1` | `BrokerAccountBindingV1` | 1 §11.2 |
| `aether.ats.delegated-trading-grant/1` | `DelegatedTradingGrantV1` | 1 §11.3 |
| `aether.ats.equity-order-intent/1` | `NormalizedEquityOrderIntentV1` | 1 §11.4 |
| `aether.ats.order-review-receipt/1` | `BrokerOrderReviewReceiptV1` | 1 §11.5 |
| `aether.ats.operator-approval/1` | `OperatorApprovalReceiptV1` | 1 §11.6 |
| `aether.ats.execution-receipt/1` | `ExecutionReceiptV1` | 1 §11.7 |

### Canonicalization  ·  `jcs-integer-subset/1`

The specs say "RFC 8785". What is implemented is a **stricter subset**, and the
difference is deliberate — stated here because this doc wins over the code:

- RFC 8785 serializes numbers with the ECMAScript Number-to-String algorithm and
  therefore admits floats. This profile **refuses any non-integer or non-finite
  number**.
- On the values these contracts carry (integers only) the two agree byte for
  byte, and both agree with Python's
  `json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=True)`.

Every monetary field is an integer count of **minor units** (`58012` = $580.12)
and every quantity is a **whole share**. Floats are how a preview and a commit
come to disagree about a number that looked equal; the encoder throws instead.

Both mirrors assert the profile string, so adopting a full RFC 8785 encoder is a
deliberate, versioned act rather than a silent digest change.

### Invariants the shapes enforce (not merely document)

1. **Implementation support is not permission.** A capability snapshot pins
   `grants_execution_authority: false`; any other value fails to parse.
2. **Effective mode never exceeds requested mode**, on the ladder
   `offline < observe < review_only < paper < approve < auto`. The halt states
   `orders_paused` / `emergency_locked` may follow any request. A differing
   effective mode must carry a reason.
3. **An empty symbol allowlist permits nothing.** There is no wildcard token.
4. **`confirmation` is pinned to `per_order`.** Standing or session approval is
   not expressible, even though the provider may offer it.
5. **Raw account numbers cannot leave the connector core.** Opaque refs require a
   namespace prefix (`acct_…`); a masked label with 5+ consecutive digits is
   refused; `redactBindingForExport()` is the only exported projection.
6. **Preview, approval and commit must name the same** adapter, endpoint/schema
   digest, execution environment and account binding generation.
   `verifyApprovalChain()` returns a verdict and there is deliberately **no
   re-preview or reroute path** — a mismatch is terminal.
7. **Fill facts exist only when broker-confirmed.** A receipt cannot express a
   fill for a refused, cancelled or ambiguous outcome, nor fill more than it
   ordered.
8. **An ambiguous commit is never retried.** `ambiguous` is a first-class outcome
   requiring a reconciliation state and a reason.

### Scope boundary

Gate 1.0 lands **no connector write path**. `src/core/ats_contracts/` performs no
I/O, holds no credential and places no order — a test asserts the modules
reference no `node:fs` / `node:net` / `node:http` / `node:child_process` /
`fetch(` / `process.env`. Broker sessions, the operator gateway and the
submission coordinator arrive in later gates and consume these shapes.

Related Spec 2 contracts (runtime, data profile, strategy lifecycle, journal)
land in a separate lane under the same directory and import this base.

---

## Other contracts

- **Aether Code private host protocol** (`aether.code.host/1`): canonical
  supervision, handshake, credential-boundary, and host-action contract is
  [`AETHER_CODE_HOST_PROTOCOL.md`](./AETHER_CODE_HOST_PROTOCOL.md). It explicitly
  reuses the unchanged `aether.exec/2` execution stream and
  `aether.exec.control/2` control stream.
- **Universal UVT stream** (chat/orchestrator/MCP SSE): owned by the Aether
  platform; surfaced here by `src/core/stream.ts`. The bridge's `CloudBrain` maps
  that vocabulary onto the event protocol above.
- **CLI auth** (device flow + `aek_` PAT): the CLI↔platform auth contract; see
  `src/core/device.ts`.
