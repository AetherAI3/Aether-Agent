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
holds one validated example per schema plus its canonical digest. The matching
ATSv2 fixture and independent Python digest checks are proposed in ATSv2
[#443](https://github.com/AetherAI3/ATSv2/pull/443). Its Python checks do not
yet reproduce all eight TypeScript validators or translate ATSv2's native
`agent_bridge/v1` objects. A matching digest proves canonical bytes agree for
these examples; it does not prove that ATS accepted an order or a grant.

`aether.ats.model-order-proposal/1` is the closed **untrusted model input**.
Its separate fixture is `test/fixtures/ats_model_proposal_golden.json`. It
contains strategy and quote references, symbol, side, whole-share quantity,
order type, price and expiry. It has no account, environment, grant, client,
request ID or operator decision. ATSv2 must inject all of those after client
authentication and revalidate every reference. The `equity-order-intent/1`
below is an ATS-private bound object; it must never be exposed as a model tool
argument. Neither proposal validation nor its digest is execution authority.

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

**Frozen weakness, never executable.** The `/1` ticker check (`symbol()`)
accepts URL-shaped strings such as `HTTPS://X`, and the `/1` masked-label check
accepts other-script digits, confusable letters, direction overrides and
zero-width characters. Both stay exactly as frozen so historical records keep
validating. No `/1` document or chain may authorize an executable order; that
takes the `/2` shapes and `verifyExecutableCommitAuthority()` in "Spec 1 `/2`
closure" below.

### Canonicalization  ·  `rfc8785/1`

A real RFC 8785 (JCS) implementation, in `src/core/ats_contracts/canonical.ts`.

**It is not shared with `device_runtime/canonical_json.ts`, and must not be.**
That encoder is pinned to the Cloud's Python `json.dumps(..., ensure_ascii=True)`
and changing it would invalidate device signatures. Two encoders exist here
deliberately, each pinned to a different counterpart.

An earlier revision of this section described a profile called
`jcs-integer-subset/1` and claimed it was 8785 minus floats. **That was wrong.**
It escaped every non-ASCII character (`ensure_ascii=True`), while JCS requires
non-control Unicode emitted literally and encoded as UTF-8 — a different byte
string, and therefore a different digest, for any document containing a
non-ASCII character. The name implied a narrowing when the difference was the
string encoding.

What the profile actually guarantees:

- Non-control Unicode is emitted **literally**; only `"` `\` `\b` `\f` `\n` `\r`
  `\t` and lowercase `\u00xx` for remaining C0 controls are escaped.
- Object keys sort by **UTF-16 code unit** (§3.2.3).
- Numbers use ECMAScript Number-to-String; `-0` normalizes to `0`.
- **Lone surrogates are refused** — they have no UTF-8 encoding, so runtimes
  substitute or throw differently and the digest stops being reproducible.

**Floats are legal in JCS and this encoder accepts them.** Integer-only money is
an *ATS contract rule*, enforced one layer up by the schema validators
(`integer()`, `minorUnits()`): every monetary field is an integer count of minor
units (`58012` = $580.12) and every quantity is a whole share. Keeping the split
means the encoder stays a faithful 8785 implementation instead of quietly being
something else again.

#### Python mirrors: read this before implementing

`sorted(keys)` **is wrong.** Python compares code points; RFC 8785 requires
UTF-16 code units. They disagree whenever an astral character (U+10000+) meets a
BMP character at or above U+E000, because the astral character's UTF-16 form
begins with high surrogate `0xD800`, which is numerically *below* `U+FFFF`:

```
UTF-16 (correct):  {"\U00010000":1,"￿":2}
sorted()  (wrong): {"￿":2,"\U00010000":1}
```

Sort on `key.encode("utf-16-be", errors="surrogatepass")`, and serialize with
`ensure_ascii=False`. `test/fixtures/ats_contracts_golden_verify.py` is a
complete reference implementation plus a fixture checker; ATSv2 should lift its
functions. It is not wired into `npm test` because CI has no guaranteed Python —
a conditional skip would give false assurance. Verified at freeze time:

```
OK: 18 checks reproduced byte-for-byte by an independent Python implementation.
```

Both mirrors assert the profile string, so changing the encoder is a deliberate,
versioned act rather than a silent digest change.

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
5. **A bare account number cannot be passed where a reference belongs.** Opaque
   refs require a namespace prefix (`acct_…`); a masked label with 5+
   consecutive digits is refused; `redactBindingForExport()` is the only
   exported projection. **Scope limit, stated plainly:** a prefix cannot prove
   an account number is absent from the body — `acct_000123456789` satisfies the
   shape. Non-reversibility must be produced upstream, by the connector core
   *minting* these as random or keyed-digest identifiers. The validator cannot
   see the difference, so that half of the invariant belongs to whoever
   generates them.
6. **Preview, approval and commit must name the same** provider, account binding
   id, binding generation, adapter, endpoint/schema digest and execution
   environment. `verifyApprovalChain()` **computes both digests itself** from
   the intent and review — an earlier revision accepted the intent digest as an
   argument, which proved only that three documents agreed about a number the
   caller supplied. It also refuses a refused or expired review and a spent or
   expired approval. There is deliberately **no re-preview or reroute path**; a
   mismatch is terminal.
   `verifyCommitAuthority()` is the gate immediately before a broker commit: it
   additionally proves the order is aimed at the account the local binding
   names, under a grant that still permits it, in a mode that still allows
   submission. Kill and pause are re-checked **there**, not inherited from
   whatever the review said minutes earlier.
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

## 3. ATS trading contracts (Spec 2, headless runtime)  ·  frozen

Spec 2's half of the freeze, in `src/core/ats_contracts/`. These import the
section 2 base (`primitives.ts`, `canonical.ts`, `mode.ts`) rather than
redefining it, so both specs share one canonicalization profile
(`rfc8785/1`) and one authority ladder.

| Schema | Module | What it asserts |
|---|---|---|
| `aether.ats.runtime-installation/1` | `runtime.ts` | What was installed, and that its provenance was proven |
| `aether.ats.runtime-capabilities/1` | `runtime.ts` | What the runtime honours right now |
| `aether.ats.data-profile/1` | `data.ts` | What data was configured |
| `aether.ats.data-probe/1` | `data.ts` | What a live probe actually saw |
| `aether.ats.strategy-source/1` | `strategy.ts` | An imported strategy file |
| `aether.ats.strategy-compile-artifact/1` | `strategy.ts` | An immutable, content-addressed compile result |
| `aether.ats.strategy-activation/1` | `strategy.ts` | What the runtime was asked to run, and what it honoured |
| `aether.ats.trade-journal/2` | `journal.ts` | A trade entry: immutable facts plus editable human context |
| `aether.ats.human-note-revision/1` | `journal.ts` | One appended revision of a human note |
| `aether.ats.journal-preferences/1` | `journal.ts` | Journal preferences, which grant no authority |

Invariants these shapes make unrepresentable rather than merely forbidden:

1. **A receipt cannot lie about provenance.** `provenance_verified` is pinned
   `true`, so a failed verification produces no installation receipt at all.
2. **Configured is not verified.** `DataProfileV1` has no field that can hold a
   connection verdict, so settings cannot persist `connected: true`.
3. **A verified probe expires.** `ageProbeReceipt` re-evaluates against the
   clock, so a previous success is not perpetual evidence and a stale feed
   blocks a new activation.
4. **A credential reference is not a credential.** `credential_ref` requires an
   `env:` or `vault:` prefix, so a pasted key fails validation at the boundary.
5. **Compile is not activation.** Only a compiled, content-addressed artifact
   whose id matches its contents can be staged; Pine and Python are reference
   material and never compile to Nano.
6. **Paper needs a grant.** An activation effective in `paper` without an
   execution-grant reference is refused; `observe` may not carry one at all.
7. **Notes append.** A note revision must supersede exactly its predecessor, a
   save from a stale base returns a conflict, and editing a reflection advances
   only `reflection_revision` — never `fact_revision`.
8. **Effective mode is ATSv2's.** The only way to obtain a non-offline
   capability snapshot is to parse a runtime-authored reply; there is no
   constructor that derives one from a local preference.

Golden vectors: `test/fixtures/ats_spec2_golden.json`, 15 frozen documents with
their canonical digests, a sibling to section 2's fixture. Changing a digest
there is a deliberate, versioned act.

Runtime state lives in `runtime.json`, `data-profile.json`, `dashboard.json`
and `setup.json` beside the immutable `ats.json` (`aether.ats.local/2`), so an
older Agent build cannot misread runtime authority as setup state.

---

## 4. Agent Browser order ticket  ·  `agent-browser-ats-order/1`  ·  frozen

The typed wire between ATSv2's browser order-ticket port (caller) and the
qualified site adapter in the private extension on the browser host (callee).
Source spec, diagram and gates:
[`specs/2026-09-23-ats-agent-browser-orders.md`](specs/2026-09-23-ats-agent-browser-orders.md).
Modules in `src/core/ats_contracts/`: `browser_order.ts` (vocabulary and call),
`browser_order_result.ts` (result), `browser_order_gate.ts` (decisions) and the
internal `browser_order_values.ts` (shared value shapes, not re-exported).

| Tag | Shape |
|---|---|
| `aether.ats.browser-order-call/1` | `BrowserOrderCallV1`, one of ten operations |
| `aether.ats.browser-order-result/1` | `BrowserOrderResultV1`, status `ok`, `refused` or `ambiguous` |

`verify_session`, `read_market`, `read_account`, `verify_ticket`, `read_order`
and `read_positions` observe; `prepare_ticket` fills a ticket without
submitting it; `commit_once` and `cancel_order` mutate; `end_control` returns
control to the user.

**Who may call it.** Only the deterministic ATSv2 controller. A model never
names an operation, adapter or binding: its one order-shaped output is the
closed `aether.ats.model-order-proposal/1` (section 2). The generic Agent
Browser MCP tools (`browser_click`, `browser_type`, …) are never an order path.

### Invariants the shapes enforce

1. **No caller-supplied selector, coordinate, URL, script or free text.** Every
   call and parameter object is closed, and every string a caller can send is
   a bounded identifier, digest, equity ticker, timestamp or enum member; a test
   walks every string leaf. Tickers are equity-shaped (`SPY`, `BRK.B`,
   `BRK-B`), deliberately narrower than the shared ticker, whose `/` and `:`
   let an all-caps string spell `HTTPS://…`. The adapter's recipe is code
   pinned by `adapter_digest`.
2. **Every call names its principal, session generation, adapter, request and
   deadline.** The deadline follows `issued_at` by at most 120 s, and by at most
   30 s for `commit_once` and `cancel_order`.
3. **ATS simulated paper never reaches a browser.** A binding's environment is
   `provider_sandbox` or `provider_live` and must equal
   `environmentForSiteMode(site_mode)`, so a paper binding is never live
   capital and a live binding is never paper.
4. **Only discovery and release run unbound.** Every other operation needs a
   binding: id, generation, account fingerprint, site mode, environment.
5. **Results carry no page content.** Page text, pixels, HTML, cookies and
   account numbers are unrepresentable. The only site-derived strings are a
   bare canonical https origin and a masked label drawn from a **closed
   character set** — ASCII letters and digits, space, `. - _ ( ) # *`, bullet
   and ellipsis — with at most four consecutive digits. A blacklist could not
   hold: fullwidth or other-script digits slip past a digit-run rule, and
   confusable letters or direction overrides can make the approval card lie.
   Order, cancel, account and position results name the account and mode they
   were read from, and positions count the holdings the contract cannot
   represent rather than silently dropping that exposure.
6. **A login screen carries nothing.** An unverified session has no origin,
   account, mode evidence or permission, and authentication leaves control
   with the user.
7. **Paper needs a site-specific indicator and, where the adapter has one, an
   agreeing second indicator.** `resolveSiteMode()` returns null for an absent
   or contradicting second indicator and `deriveBrowserBindingState()` then
   yields `observe_only`. A verified live session is always `live_locked`.
8. **The rendered ticket is digest-bound.** `rendered_ticket_digest` is
   recomputed on parse, so a changed field under an unchanged digest is
   refused.
9. **A commit is never a fill.** `commit_once` returns `confirmed` with the site
   order id, or `site_rejected`, and cannot express fill facts. Fills come only
   from `read_order` with `order_history` or `order_detail` evidence and must
   agree with the order status.
10. **Unknown is first-class.** Only the two mutations may be `ambiguous`. A
    refused mutation promises that nothing was dispatched, and
    `requiresReconciliation()` is true for every mutation that was not refused.
    `duplicate_commit` is legal only on `commit_once`, and although that
    refusal dispatched nothing, it proves an earlier commit for the request
    exists, so it requires reconciliation too.
11. **A result must answer exactly its call.** `verifyBrowserResult()` refuses
    another call, request or operation; a changed session generation; another
    user, agent or browser session; a changed adapter id, version or digest;
    an observation more than `MAX_CLOCK_SKEW_MS` (5 s) older than the call,
    which is a replayed or cached answer; data that disagrees with the binding
    or parameters; and a read observed after its deadline. A mutation's
    outcome is never discarded for lateness, and when the gate refuses an
    answer to a mutation, ATSv2 treats that mutation as `ambiguous`, because
    it journaled `COMMITTING` before it asked.

### Golden vectors and the Python mirror

`test/fixtures/ats_browser_order_golden.json` holds 28 faithful exchanges
covering every operation, both site modes and all three statuses, with their
`rfc8785/1` digests. It also holds 69 call rejects, 58 result rejects and 34
gate mismatches (189 vectors). Each negative vector is single-cause and names
the exact message of the check that must refuse it, and the TypeScript and
Python validators emit identical messages, so a vector proves it failed for
its **stated** reason in both languages. Coverage floors are named constants
equal to the coverage that exists, and every test collects all failing vectors
before asserting, so a broken guard names every vector it blinds. The file is
pure ASCII: non-ASCII vector values (a direction override, confusables,
fullwidth digits) are stored as JSON `\u` escapes, never as literal characters.

`test/fixtures/ats_browser_order_wire.py` and `ats_browser_order_gate.py` are an
independent Python mirror of the validators and decisions; they borrow only the
section 2 JCS encoder. `ats_browser_order_verify.py` runs every vector through
them, and CI runs it on Linux and Windows. It handles the traps a Python port meets:
`re` lets `$` match before a trailing newline and `\d` match any Unicode digit
(use `fullmatch` and `[0-9]`), and JavaScript measures string length in UTF-16
code units. The fixture carries a vector for each. The timestamp validator
emulates V8's `Date.parse` exactly rather than Python's `datetime`: year 0000
is valid, month 13, day 32, minute 60, a leap second and 24:00 with any
non-zero part are "not a real instant", and 24:00:00 or a day past its month
rolls over and is "not a real calendar date". A differential probe of 37 edge
cases agreed on every message and millisecond. One asymmetry remains:
`json.loads("4.0")` is a float that Python refuses while `JSON.parse` yields the
integer 4, so producers must emit plain integers.

Each guard was verified by breaking it. Removing any of these in either
language, corrupting a digest, eroding a coverage category, or stating the
wrong reason fails both suites and names the vector:

- the binding environment check;
- the adapter pin check;
- the rule that only mutations may be ambiguous;
- the reconciliation rule, including `duplicate_commit`;
- the rule that only `commit_once` may be refused as a duplicate;
- the second-indicator rule;
- the label character set;
- the equity ticker;
- the stale-read check and the replay bound;
- the account checks on order and cancel results;
- the ticket digest check;
- the binding requirement;
- in Python, `fullmatch`, UTF-16 length, the hour-24 rule and year 0000.

### Scope boundary

The module performs no I/O, and nothing registers these operations as a tool.
Agent Browser v0.2.2 implements none of the callee side: it has no lease,
takeover signal, session generation, persistent profile, origin allowlist or
drift detection. ATSv2's execution controller still requires broker-API truth
for a commit. Both are later gates in the source spec. ATSv2 lifts the Python
validators into `ats-mcp` in its companion change.

---

## 5. Spec 1 `/2` closure: equity ticker and closed masked label (frozen)

**What was weak.** The Spec 1 `/1` shapes (section 2) check tickers with
`symbol()`, `^[A-Z0-9][A-Z0-9.^:=_/-]{0,39}$`, which accepts URL-shaped
strings such as `HTTPS://X`. They check masked account labels with a
control-character rule plus an ASCII-only five-digit-run rule, which accepts
fullwidth or Arabic-Indic digits, confusable letters, direction overrides and
zero-width characters. The execution spec
([`specs/2026-09-23-ats-agent-browser-remaining-gates-v2.md`](specs/2026-09-23-ats-agent-browser-remaining-gates-v2.md),
gate G0) requires closing both through a versioned change before those shapes
are reused for an executable order.

**What changed.** `/1` is frozen and keeps accepting exactly what it accepted.
Six `/2` schemas carry the same fields as their `/1` counterparts; the only
semantic change is the ticker or label check:

| `/2` tag | Shape | Only change from `/1` |
|---|---|---|
| `aether.ats.model-order-proposal/2` | `ModelEquityOrderProposalV2` | `symbol` must pass `equityTicker()` |
| `aether.ats.equity-order-intent/2` | `NormalizedEquityOrderIntentV2` | `symbol` must pass `equityTicker()` |
| `aether.ats.operator-approval/2` | `OperatorApprovalReceiptV2` | `symbol` must pass `equityTicker()` |
| `aether.ats.execution-receipt/2` | `ExecutionReceiptV2` | `symbol` must pass `equityTicker()` |
| `aether.ats.delegated-trading-grant/2` | `DelegatedTradingGrantV2` | every `symbol_allowlist` entry must pass `equityTicker()` |
| `aether.ats.account-binding/2` | `BrokerAccountBindingV2` | `masked_label` must pass `closedMaskedLabel()` |

`equityTicker()` (`^[A-Z]{1,6}(?:[.-][A-Z]{1,4})?$`: `SPY`, `BRK.B`, `BRK-B`) and
`closedMaskedLabel()` (ASCII letters and digits, space, `. - _ ( ) # *`, bullet
and ellipsis, at most four consecutive digits) live in `primitives.ts`. They
are the helpers `agent-browser-ats-order/1` introduced (section 4), lifted with
byte-identical regexes and messages: the browser fixture and its Python mirror
pass unchanged, and drifting either message fails named browser vectors. Each
`/1` and `/2` validator pair shares one body parameterized by schema tag and
check, so `/1` keeps its messages and evaluation order. `ATS_SPEC1_V2_SCHEMAS`
lists the six tags beside `ATS_SPEC1_SCHEMAS`.

**The order-review receipt keeps one version.** It carries no ticker and no
masked label, and it cannot move between chains: its `intent_digest` is the
digest of the intent including the intent's `schema_version`, and the approval
binds the review by digest, so a review answers exactly the intent version it
was minted for. The executable gate tells a `/2` chain from a `/1` chain by its
four versioned members; a `/2` review would be a new tag with no semantic
change.

**Gate rule.** `verifyExecutableCommitAuthority()` is the only gate that may
authorize an executable order. It decides in three steps, and each of its two
refusals is fixed text that ATSv2 pins:

1. **Version.** The intent, approval, account binding and grant must all be
   tagged `/2`, or it refuses with `EXECUTABLE_CHAIN_REFUSAL`:

   > Only an order chain whose intent, approval, account binding and grant are all /2 may authorize an executable order; any /1 member makes it a historical record.

2. **Re-validation.** A tag is only a claim: a `/1`-validated document
   retagged `/2` in code still carries whatever it was validated with. So the
   gate re-validates every member (the four with their `/2` validators, the
   review with `validateOrderReview`, the usage with `validateGrantUsage`) and
   requires the clock and the resulting position notional to be whole,
   non-negative numbers. A NaN clock passes every expiry check and a NaN or
   negative position or usage passes every limit. Anything that fails refuses
   with `EXECUTABLE_MEMBER_REFUSAL`:

   > An executable order chain member failed re-validation; only freshly validated /2 documents and well-formed inputs may authorize an order.

3. **Verdict.** `verifyCommitAuthority()`'s logic, unchanged, run on the
   re-validated copies rather than on the caller's objects.

`verifyExecutableApprovalChain()` applies the same three steps to
`verifyApprovalChain()` over the intent, review, approval and clock. Their
inputs are typed as either version so a `/1`, mixed or retagged chain reaches
the gate and is refused there, not only at compile time. The `/1` gates keep
their signatures, stay version-blind and never re-validate. They are marked
`@deprecated` and kept for historical records: **a `/1` chain is never
executable**, however consistent. The Python mirror keeps the shared logic
private (`_approval_chain_verdict`, `_commit_authority_verdict`), so a caller
that lifts it can only reach the executable gates, and it fails closed on any
exception during re-validation. `optionalBindingV2()` is the `/2` form of
`optionalBinding()`.

**Re-issuing a binding or grant as `/2`.** A `/2` binding or grant re-issued
from a `/1` one MUST bump `binding_generation` or `grant_version`. Reviews and
approvals minted under the `/1` document then fail the existing "Account was
re-linked after this order was reviewed." or "Grant changed after review."
refusals instead of carrying into a `/2` chain.

*Follow-up, not in this change:* the approval restates the order terms the
operator saw but does not bind the masked label shown on the approval card. A
later version could bind a label digest, so a label that changes after
approval is refused.

### Golden vectors and the Python mirror

`test/fixtures/ats_contracts_v2_golden.json` is pure ASCII, sha256
`05cc87082c641a4c14714bdcf66e1b227b105fac3920dff2542f3e37784eea21`. Every
message in it is compared exactly in both languages. It holds:

- canonical text and digest for one valid instance of each `/2` document;
- 8 strict variants that must stay accepted by `/2` and by `/1`, because the
  closure narrows and must not overreach;
- 12 single-cause rejects: lowercase `spy` on each ticker-bearing document and
  a label with five ASCII digits, each with its pinned `/1` refusal, plus each
  `/2` validator given its `/1` tag;
- 41 `frozen_weakness` entries that the `/1` validator ACCEPTS and `/2`
  REFUSES: `HTTPS://X`, `A:B`, `X/Y`, `ABCDEFG`, `BRK.BBBBB`, `A^B` and `1ABC`
  on each of the five ticker-bearing documents, and labels with a fullwidth
  digit run, Arabic-Indic digits, a Cyrillic confusable letter, a
  right-to-left override (U+202E), a zero-width space (U+200B) or a byte order
  mark (U+FEFF);
- 65 chain cases over 71 validated chain documents and 8 raw ones, and the two
  refusal texts. There are three kinds of case, each single-cause:
  - 6 **version** cases: the faithful `/2` chain; a `/1` intent, approval,
    binding or grant in an otherwise `/2` chain; and an all-`/1` chain. The
    version-blind gates accept every one, so the version rule is its only
    possible refusal.
  - 9 **member** cases hand the gates raw, never-validated documents and
    inputs that the version-blind gates accept:
    - the retagged chain (a URL-shaped ticker and a direction-override
      label, retagged `/2`), a retagged binding and a retagged grant;
    - an unvalidated intent, review and approval;
    - malformed usage, clock and resulting position.

    Re-validation is their only refusal. Every raw document fails its own
    tag's validator, and each retagged one passes `/1` when tagged back.
  - 50 **branch** cases, one per reachable refusal branch of the shared chain
    and commit logic. Each is a valid `/2` chain with a pinned message that
    both the version-blind and the executable gates must produce, in both
    languages. One pairs a review minted for the `/1` intent with the same
    intent retagged `/2` and must fail "Review does not answer this intent.";
    it pins the review-receipt argument above.

  Three branches cannot be reached through a validated chain, so they have no
  case:
  - "Approval and review disagree about the intent.": a backstop behind the
    first digest check.
  - "Reservation expired.": a validated review's approval deadline never
    outlives its reservation, so the deadline check fires first.
  - "Order environment does not match the grant environment.": the commit
    gate's own environment check fires first.

`test/fixtures/ats_contracts_v2_wire.py` mirrors the validators at `/1` and
`/2` and both executable gates, borrowing the section 4 primitives and the
section 2 JCS encoder. `ats_contracts_v2_verify.py` runs all 211 vectors, and
CI runs it on Linux and Windows. The frozen `/1` label rule is written
`[0-9]{5,}` in Python, because Python's regex digit class, unlike JavaScript's,
matches fullwidth digits.

Each guard was verified by breaking it in both languages:
- Swapping the strict ticker for `symbol()` in any one `/2` validator fails
  that document's eight ticker vectors, the raw-document check of each
  retagged copy of it, and any member case that copy alone breaks. Nothing
  else fails.
- Swapping the closed label for the `/1` label fails the six label
  weaknesses, the `optionalBindingV2()` check, and the retagged binding's
  raw-document check and member case. Nothing else fails.
- Removing either gate's version check changes the mixed-chain cases to the
  member refusal, because re-validation then rejects the `/1` tag. Removing
  it together with the re-validation flips them to accepted.
- Removing either gate's re-validation, or any single member's, flips its
  member cases to accepted.
- Deleting any reachable shared-logic branch changes the outcome of its
  branch case. Deleting one of the three unreachable branches changes
  nothing, which is why they have no case.
- Deleting each target check flips every vector aimed at it to accepted, never
  to another refusal.

**Scope.** A passing fixture proves only that both sides agree on shapes and
refusals. Nothing here registers an order tool, and
`test/ats_no_order_tool.test.ts` proves that none of the CLI's 35 tool, action,
command and flag registries exposes one.

What counts as an order operation:
- any of the order contracts' 17 operations;
- an order, trade, position or ticket being submitted, created, placed,
  cancelled, executed, closed, routed or amended, including forms run
  together, such as `placeorder`;
- a buy, sell, short, trade, flatten, rebalance or liquidation;
- an approval;
- in an ATS-scoped registry, a bare submit, place, commit or cancel.

Three reviewed exemptions, each with a reason, cover the GitHub action rail's
`--approve` flag and the ATS settings mode `approve`. The list is exact: it
cannot grow silently, and no order-contract operation can be exempted. That
inventory covers what this CLI registers, advertises and dispatches. Tools
offered by a user-configured MCP server or by Cloud's MCP broker are outside
it, and the CLI's `ToolExecutor` refuses any name outside `TOOLS`. The G0
release matrix, including the ATSv2 pins, is
[`specs/2026-09-23-ats-browser-execution-release-matrix.md`](specs/2026-09-23-ats-browser-execution-release-matrix.md).

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

---

## 6. Managed ATS tool host v1 (E1 schema bundle)

Step 1 of the E1 landing order in
[`specs/2026-09-22-managed-ats-tool-host-v1.md`](./specs/2026-09-22-managed-ats-tool-host-v1.md)
(section 17): the common encoding and the closed schemas for trust, device
proof, host-open proof, observer-channel receipt, runtime capability,
registry, host lease, invocation, cancellation, result and workspace status.
It adds no transport, no I/O and no Cloud call. No tool is registered, and
nothing here grants execution authority.

### What landed

- `contracts/managed-ats-tool-host/v1/`: `common.schema.json` (`$defs` only,
  `x-aether-schema-id` `aether.managed-tool-common/1`), the trust,
  device-proof, host-open-proof, observer-channel-receipt, runtime-capability,
  registry, host-lease, invocation, cancellation, result,
  workspace-status-input and workspace-status schemas, and `manifest.json`
  (`aether.managed-tool-schema-bundle/1`: one entry per file, sorted by file,
  with its `schema_digest`). All are JSON Schema draft 2020-12 with `$id`
  `https://schemas.aethersystems.net/managed-ats-tool-host/v1/<file>`,
  every object closed with a full `required` list, and ASCII only. Every
  `$ref` is document-local: each schema carries an identical copy of the
  common definitions it uses (the test proves the copies match
  `common.schema.json`), so a schema digest covers everything that validates
  against it. The schemas document structure; the semantic rules below are
  enforced by the validators.
- `src/core/managed_tool_host/`: a closed validator for each object, the
  strict frame lexer, digests and derivations, Ed25519 over raw 32-byte keys,
  and the cross-object checks, exported from `index.ts`. Every refusal is a
  `ToolHostContractError` whose fixed message names the field path, never
  the value. Imports are limited to `node:crypto`,
  `../ats_contracts/canonical.js` (the single RFC 8785 encoder) and sibling
  files.
- `test/fixtures/managed_tool_host_golden.json`,
  `test/managed_tool_host_contract.test.ts` and the independent Python mirror
  `test/fixtures/managed_tool_host_{wire,objects,cross,ed25519,verify}.py`,
  which CI runs on Linux and Windows. `.gitattributes` keeps the fixture and
  the schema bundle at LF.

### Decided encoding rules

The spec leaves these implicit. The lead decided them, and both languages
implement exactly this.

1. Common digest: `sha256:` + hex(sha256(ASCII(schema_id) + LF +
   JCS(object without its own digest or signature fields))). It covers
   `proof_digest` (which omits both `proof_digest` and `cloud_signature`),
   `receipt_digest`, `capability_digest`, `registry_digest`,
   `invocation_digest`, `cancellation_digest`, `result_digest` and
   `status_digest`. The trust document has no digest.
2. Signatures are pure RFC 8032 Ed25519 (no prehash) over ASCII(schema_id) +
   LF + JCS(object without the signature field only). The lease and the
   device proof omit only `cloud_signature`, so the device-proof signature
   binds `proof_digest`. The host-open `device_signature` signs
   ASCII(`aether.managed-tool-host-open/1`) + LF + JCS of challenge,
   device_proof_digest, agent_id, conversation_id, local_session_id,
   session_generation and registry_digest. That prefix differs from the
   proof object's own schema, `aether.managed-tool-host-open-proof/1`.
3. `arguments_digest` uses the prefix `aether.managed-tool-arguments/1`.
4. A schema digest uses the prefix `aether.schema/1` over the whole document.
5. `common.schema.json` carries `x-aether-schema-id`
   `aether.managed-tool-common/1` and holds `$defs` only.
6. Timestamps match `YYYY-MM-DDTHH:MM:SS.mmmZ` exactly and must be real
   Gregorian instants: years 0001 to 9999, hours 00 to 23, no leap second.
   Both languages convert them to epoch milliseconds with explicit
   days-from-civil arithmetic, never `Date.parse` or
   `datetime.fromisoformat`.
7. Integers are 0 to 2^53 - 1 unless a field is narrower: `session_generation`
   and `sequence` are 1 to 2^53 - 1, `revocation_epoch` 0 to 2^53 - 1.
8. Strings default to at most 256 Unicode scalar values (code points, not
   UTF-16 units). Every Cc control (U+0000 to U+001F, U+007F to U+009F) and
   every unpaired surrogate is refused anywhere, keys included. Display
   text follows the stricter `aether.safe-display/1` rule below.
9. Set-like arrays (`supported_read_operations`, `dependencies`,
   `data_classes`, `capabilities`, `evidence_refs`, and trust `keys` by
   `key_id`) are strictly ascending by code point, with no duplicates. Tools
   are strictly ascending by (name, version), with versions compared as
   integers. An out-of-order array is refused, never reordered.
   `diagnostics` keeps its order.
10. Base64url is unpadded: exactly 43 characters for 32 bytes and 86 for 64.
    It must be canonical (the unused low bits of the last character are
    zero), so each byte string has exactly one spelling.
11. Temporal checks take an explicit `now` in epoch milliseconds and allow
    30 000 ms of skew either way. Pure-shape validators take no clock.
12. Cross-object checks are separate exported functions (listed below).
13. The raw frame lexer works on bytes. It refuses a UTF-8 byte order mark,
    invalid UTF-8, frames over 262 144 bytes, nesting deeper than 16,
    duplicate members (compared after unescaping), any number other than
    `0` or `[1-9][0-9]*` up to 2^53 - 1 (so `-0`, `01`, `1.0`, `1e2` and `-1`
    all fail lexically), and any control character or unpaired surrogate in
    a string, raw or escaped. Arguments are further limited to depth 8.
14. Every refusal is a `ToolHostContractError` with a fixed message. The
    TypeScript and Python messages are byte-identical, and the vectors
    compare them exactly.

### Review round 1 decisions

The lead decided these after an independent review of the bundle. Both
languages implement exactly this, and each rule is pinned by vectors.

1. Ed25519 per RFC 8032, cofactorless verification, S < L, canonical point
   encoding, small-order keys refused. A trust key or `device_public_key`
   is refused unless its encoded y, with the sign bit masked, is below
   p = 2^255 - 19 and it is not in libsodium's small-order blocklist (seven
   encodings, compared with the sign bit masked). `ed25519Verify` refuses
   such keys as well, so a device proof that skipped validation still cannot
   admit the review's forgery (R = identity and S = 0 under the all-zero key).
2. Trust expiry at every use: `verifyCloudSignature` takes `now` and refuses
   once `now` is at or past the trust document's `expires_at` + 30 s. A
   cached trust document cannot verify a device proof or a lease after it
   expires.
3. `aether.safe-display/1`: `error.message` and `diagnostics[].summary` are 1
   to 256 printable ASCII characters (U+0020 to U+007E). The rule is
   identical in both languages and immune to Unicode-table drift. It refuses
   right-to-left overrides, line and paragraph separators, zero-width
   characters, byte order marks and invisible tag characters. A result's
   `redaction_profile` names this rule. `account_subject` keeps the general
   string rule (rule 8), because it is hashed locally and never displayed.
4. Revocation fencing: `checkLeaseBinding` requires the lease's
   `revocation_epoch` to equal the device proof's (device-level fencing).
   Lease-level fencing is `lease_id` plus `session_generation`.
5. `checkHostOpenBinding(hostOpen, registry, lease, {challenge})`: the
   challenge equals the one Cloud issued; `agent_id`, `local_session_id`,
   `session_generation` and `registry_digest` equal the registry's; and
   `conversation_id`, `agent_id`, `local_session_id` and
   `session_generation` equal the lease's. `device_proof_digest` is bound to
   the device proof by `validateHostOpenProof`, which takes that proof.
6. Byte bounds count UTF-8 bytes: the frame limit, `bounded_bytes` and
   `max_argument_bytes` count bytes of the UTF-8 or canonical form, never
   characters or UTF-16 units. Multibyte vectors pin each one.
7. `assertE1CanaryRegistry` requires `data_classes` to be exactly
   `ats_status, local_status`: spec section 2.4 keeps browser observation out
   of E1.
8. Both harnesses pin the fixture's LF-normalized sha256, and the TypeScript
   test requires this document to state it.
9. Result rules. State `cancelled` requires `error.code` TOOL_CANCELLED and
   `deadline_exceeded` requires TOOL_DEADLINE_EXCEEDED. `refused` never uses
   either code, and `unavailable` is not constrained. `succeeded` never uses
   `retry_class` new_call_after_recovery. `checkResult` refuses a succeeded
   result whose `completed_at` is later than the invocation's `deadline_at`
   + 30 s: the deadline wins.
10. Redelivery (no validator change). A transport retry of an undelivered
    result POST resends the byte-identical stored body. Answering a replayed
    invocation whose result is already stored returns that stored result
    re-sealed with `replay_status` stored_redelivery and `retry_class`
    redeliver_stored_result: the same payload, state, error, evidence,
    timestamps and `bounded_bytes`, with a recomputed `result_digest`. Cloud
    keeps the first result it stored.
11. Hosts map every lexer or validator refusal to TOOL_CONTRACT_INVALID and
    never branch on refusal message text. For a frame with two defects the
    two languages can name different defects (see below).
12. The module scan refuses any I/O import, including a bare side-effect
    import such as `import "fs";`, and any use of `process.`.

### Lane decisions awaiting review

Where the spec and the lists above were silent, this lane made the following
choices. Each is pinned by vectors, so changing one requires a new fixture.

- `cloud_origin_id` is a normalized lowercase https origin, the same value
  the account-scope derivation uses: a dotted host, no IP literal, and no
  path, query, fragment, credentials or explicit :443.
- Every `device_id` (device proof, registry, lease, invocation, binding) must
  use the `scdev_` namespace.
- `channel_id` follows the ID grammar. The protocol name
  `aether.ats.observer-channel/1` is exported as a constant but no field
  carries it. `runtime_version` is 1 to 64 characters from U+0020 to
  U+007E, and a diagnostic `code` matches `[A-Z][A-Z0-9_]{0,63}`.
- Freshness: an object is refused when its start is more than 30 s after
  `now`, or when `now` is at or past `expires_at` + 30 s. The cancellation
  window runs from `lease.issued_at` - 30 s (inclusive) to `lease.expires_at`
  + 30 s (exclusive).
- Open JSON values (invocation arguments, and a result payload at most 15
  levels deep inside its frame) allow only unsigned safe integers and use
  the common string (256) and array (32) bounds. Invocation arguments are
  also capped at 65 536 canonical bytes before the registered
  `max_argument_bytes` applies.
- Only the frozen E1 schemas have argument and payload validators
  (`checkToolArguments`, `checkToolPayload`). Any other registered schema
  fails closed. `assertE1CanaryRegistry` pins both E1 schema digests as well
  as their IDs.
- Beyond clarification 12 and the review's host-open binding, implementing
  spec sections 4.2, 7, 8 and 10: `checkCapabilityReceipt`, the argument and
  payload dispatchers, and the lease scope equalities in `checkLeaseBinding`
  (account, agent, device, local session, generation, registry digest,
  origin), which sit alongside the expiry bounds.
- The 64 KiB workspace-status bound runs first, as a resource bound on the
  serialized value. A status that is otherwise valid cannot exceed about
  20 KB, so the vector for this bound always breaks a shape rule too.
- The spec does not rank two defects in one frame. The TypeScript lexer
  reports the first defect in document order, grammar and duplicate members
  included. The Python mirror reports its pre-scan defects (depth, number
  spelling, controls and surrogates) before grammar errors and duplicate
  members, because `json.loads` runs after the pre-scan. Every raw reject
  vector has exactly one defect, so the vectors hold both languages to the
  same message, but a frame with two defects can be refused with different
  messages (hence decision 11).
- Not checked here, because they need state across calls: consumption of
  `max_calls`, and monotonic invocation `sequence`.

### Cross-object checks

- `checkLeaseBinding`: scope, revocation epoch and expiry against the
  registry, device proof and trust document.
- `checkHostOpenBinding`: the issued challenge, the registry's session and
  the lease's conversation.
- `checkInvocation`: scope against the lease, the lease's registry binding,
  tool selection by (name, version), input schema identity, the registered
  argument byte bound, the deadline against both the lease expiry and
  `max_duration_ms`, and the deadline not yet passed at claim time.
- `checkToolArguments` and `checkToolPayload`: dispatch to the frozen E1
  input and output validators.
- `checkCancellation`: the targeted call and its digest, lease fencing, and
  the lease window.
- `checkResult`: identity with the invocation, output schema identity when
  succeeded, the registered `max_result_bytes`, start and completion times,
  and the invocation deadline for a succeeded result.
- `assertE1CanaryRegistry` (tool, version, schemas, dependencies and data
  classes) and `checkCapabilityReceipt`.

### Golden vectors and the Python mirror

`test/fixtures/managed_tool_host_golden.json` is 506 945 bytes. The sha256 of
the committed LF blob is
`eea8337d0c4caf0fe167ef5c7a144468118d34ee79a24b811d67212243688f60`. The file
is pure ASCII: non-ASCII values are stored as JSON backslash-u escapes. It
holds:

- 4 test keys, with seeds labelled NOT FOR PRODUCTION;
- the 13 schema digests;
- 6 canonical vectors and 151 primitive boundaries, among them every
  blocklisted Ed25519 encoding and the safe-display rule;
- 16 derivation rows;
- 13 accepted and 56 refused raw frames, multibyte ones included (large
  frames are small generator specs);
- 45 accept and 378 reject object vectors: trust 30, device proof 39,
  host-open proof 20, observer receipt 21, runtime capability 24, registry
  49, host lease 24, invocation 37, cancellation 13, result 59,
  workspace-status input 5, workspace status 57;
- 26 accept and 99 reject cross-object vectors.

Object and cross-object reject vectors are resealed (digests and signatures
recomputed) so that only the target defect remains. Vectors whose defect is
the digest or signature itself are not resealed, and neither are
unknown-field vectors, since a digest covers only the declared fields. The
single-cause proof covers all 656 refusals in the fixture: 378 object, 99
cross-object, 56 raw frame, 114 primitive and 9 derivation vectors. Each
vector was run against a build whose `fail()` ignores exactly that vector's
message, which deletes its target check. For the invalid UTF-8 vectors,
deleting the check means decoding leniently. 608 vectors then flip to
accepted. The other 48 carry an `exception` tag naming why they cannot flip:

- type guards (18);
- JSON grammar violations (16), which have no guard to delete. They are not
  run this way, because ignoring the generic grammar message would also
  remove the lexer's loop exits;
- a key or tool lookup with no accept path (7);
- unpaired surrogates that RFC 8785 cannot encode (3);
- wrong-length signatures, which then fail verification (2);
- seven dependencies from a six-member set (1);
- the 64 KiB bound above (1).

The forged host-open vector hands `validateHostOpenProof` a device proof
that skipped validation (validation now refuses its key), so it proves the
key screening inside `ed25519Verify` itself. `device_proof.expired` is
checked against a later trust document with the same keys, because the main
trust document has expired by then.

Two lexer details keep the raw frame vectors single-cause. Both decoders
would strip a leading byte order mark, so the explicit guard, which runs
first, is the only rule that refuses one. Every escape is decoded to its
UTF-16 unit before the control and surrogate rules run on that unit, so a
letter escape and a four-hex-digit escape of the same control character are
refused by the same rule.

`test/managed_tool_host_contract.test.ts` (19 tests) recomputes every digest
and signature with node:crypto and the repo encoder, and compares every
refusal message exactly. It also checks:

- that the fixture's LF-normalized sha256 equals the pinned value, which
  this document states;
- that vector ids, names and key labels are unique within each section,
  since both harnesses look vectors up by id;
- closed-field and enum parity between each schema document and the
  validator's field lists;
- that `grants_execution_authority` is required and `const: false` exactly
  where the spec names it, `execution_authority` is `none` and
  `orders_enabled` is false;
- the manifest and the pinned E1 digests;
- named coverage floors equal to the frozen counts;
- a scan of the module for I/O (bare side-effect imports and any `process.`
  use included), disallowed imports and non-ASCII bytes.

The Python mirror shares no code with TypeScript. Its lexer is `json.loads`
with duplicate and number hooks plus a pre-scan in document order. The
pre-scan is the only rule for control characters inside strings, since
`json.loads` runs with `strict=False`. The mirror's
RFC 8785 encoder sorts keys by UTF-16 code unit. Its Ed25519 is pure RFC 8032
and also refuses an S at or above the group order. `managed_tool_host_verify.py`
reproduces all 807 checks and exits non-zero on any mismatch. It prints each
failure as ASCII and records a crash inside a section as a failure, so a
failing run on any console still names the vectors that caught it.

A mutation matrix, run with a throwaway script outside the repository,
deleted or inverted one guard at a time in a copy of the built module and of
the Python mirror: 63 guards in TypeScript and 66 in Python, including 20 per
language for the review round. All 129 guard mutations failed their suite,
naming the vector aimed at that guard, and in 120 of them that vector was then
accepted. The other nine are:

- the 64 KiB bound in both languages (the tagged vector above);
- the mirror's RFC 8785 key sort, which a canonical vector catches;
- two derivation changes in both languages, the host-open signing prefix and
  the integer version order. The accept vector built on each derivation is
  refused as well;
- counting characters instead of UTF-8 bytes in both languages. The
  multibyte result accept vector catches it first, because its
  `bounded_bytes` stops matching the payload.

Seven further mutations fail as well. Four fixture edits fail in both
harnesses: a vector dropped below its floor, a changed stated reason, a
repeated vector id, and an edited note that breaks the sha256 pin. Three
checks fail in TypeScript: a bare `import "fs";` and a `process.` use in the
module scan, and a changed fixture sha256 in this document.
