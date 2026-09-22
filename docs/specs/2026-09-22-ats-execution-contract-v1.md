# ATS Execution Contract v1

Status: contract freeze
Date: 2026-09-22
Owners: Aether-Agent, ATSv2, AETHER-CLOUD
Execution scope: paper trading only

## 1. Purpose and exclusion

This is the normative cross-repository v1 contract for turning ATS strategy
output into bounded paper-order activity. MUST, MUST NOT, SHOULD and MAY are
normative.

Supervised live-capital execution is excluded. No v1 object may select a live
broker, carry a live credential, arm execute_live, or submit a live order. Live
execution requires a new schema, separate review, fresh consent and independent
qualification.

## 2. Current non-authority

The following MUST remain true until all paper gates pass:

- ATS policy consent records grants_trading_authority: false.
- ATS settings fix order_execution_mode to paper and execute_live to false.
- plan, skip and danger are UI preferences, not trading permissions.
- Compiled and installed Nano strategies report execution_enabled: false.
- BrowserObserveGrantV1 is observation-only; page content is untrusted data.
- Managed-agent chat is not connected to local ATS execution.
- The ATS journal is diagnostic evidence, not an order ledger.
- Aether-Agent currently has no qualified paper adapter, fill engine, order
  ledger, reconciliation worker or trading kill switch.

Policy acceptance, compilation, browser connection, configured data, memory
readiness, UVT, lifecycle activation and mode selection MUST NOT be represented
as execution authority.

## 3. Ownership and trust boundaries

### 3.1 Aether-Agent

Aether-Agent owns operator interaction, account-agent scope verification,
capability consumption, local orchestration, the durable paper ledger,
reconciliation admission, kill-switch UI and user receipts.

It MUST NOT invent ATSv2 capability, map coding permission modes to trading
permission, or report an order state without ledger and adapter evidence.

### 3.2 ATSv2

ATSv2 owns Nano compilation semantics, required host signals, activation
validation, risk evaluation, the deterministic paper adapter and adapter
conformance. It is the source of native runtime capability truth.

ATSv2 MUST expose no live adapter through v1.

### 3.3 AETHER-CLOUD

Cloud owns canonical account and managed-agent identity, lifecycle, budgets and
an additive read-only readiness projection. In v1 Cloud MUST NOT store broker
credentials, grant trading authority, submit orders, or treat a DM as a grant.

Cloud status is advisory. Local runtime, risk, ledger, kill-switch and
reconciliation gates remain authoritative.

### 3.4 Scope

Every execution object MUST bind cloud_origin, account_subject, agent_id,
runtime_id, runtime_build_digest, execution_mode equal to paper, schema_version
and canonical SHA-256 digest.

Cross-account, cross-agent, cross-runtime or cross-mode reuse MUST fail. Raw
secrets MUST NOT appear in contracts, receipts, ledgers, prompts or Cloud
payloads.

## 4. Common encoding

All v1 objects are closed; unknown fields fail unless extensions is explicitly
declared.

- Digests are sha256 colon 64 lowercase hexadecimal digits.
- Times are UTC RFC 3339 with milliseconds.
- Money, prices and quantities are canonical decimal strings: no exponent,
  leading plus sign, NaN or Infinity; at most 18 fractional digits.
- Financial arithmetic MUST NOT use JavaScript floating point.
- IDs are immutable printable ASCII, 8 to 128 characters.
- Canonical JSON uses the existing repository canonical-JSON implementation.
- Reused ID plus same digest returns the prior result.
- Reused ID plus different digest is ATS_IDEMPOTENCY_CONFLICT.

## 5. Runtime capability and receipt

Capability discovery MUST be read-only and MUST NOT initialize a feed, activate
a strategy, create an order, consume a grant or start an executor.

### RuntimeCapabilityV1

Schema: aether.ats.runtime-capability/1.

Required fields:

- runtime_id, runtime_version, runtime_build_digest;
- compiler.nano_ir_versions and compiler.effects;
- contracts.order_intent, risk_decision, execution_plan and ledger_event;
- execution_modes, exactly paper in v1;
- paper_adapter.adapter_id and adapter_version;
- observed_at and expires_at;
- authority.trading, authority.broker and authority.live, all false.

Capability is usable only before expires_at and when runtime_build_digest
matches the loaded runtime.

### RuntimeReceiptV1

Schema: aether.ats.runtime-receipt/1.

Required fields: receipt_id, request_nonce, capability_digest, result, checks,
observed_at, expires_at, grants_execution_authority and receipt_digest.

result is ready, degraded or unavailable. Each check has id, status and bounded
detail. grants_execution_authority MUST be false. Degraded, unavailable,
expired, malformed or unknown capability blocks execution admission.

## 6. Data freshness

MarketObservationV1 requires:

- provider_id, feed_session_id and canonical_instrument_id;
- bid, ask and last canonical decimals where available;
- provider_sequence, observed_at and received_at;
- observation_digest.

The risk policy defines max_data_age_ms. Future timestamps, sequence rollback,
missing required prices, invalid crossed markets, unavailable provider or age
above the bound produce ATS_DATA_STALE.

A point-in-time probe is not a persistent connection claim. RiskDecisionV1 and
ExecutionPlanV1 bind the exact observation_digest.

## 7. Strategy activation

Compilation is not activation.

StrategyActivationV1 schema is aether.ats.strategy-activation/1. Required fields
are activation_id, account_scope_digest, agent_id, runtime_build_digest,
source_digest, ir_digest, required_host_signals, allowed_instruments,
risk_policy_digest, execution_mode, activated_at, expires_at and
activation_digest.

execution_mode MUST be paper. Activation rejects unsupported IR or effects,
absent or stale signals, empty allowlist, stale capability, unknown risk policy
and every non-paper mode.

## 8. OrderIntentV1

Nano BUY and SELL nodes are proposals. The host normalizes a proposal into
aether.ats.order-intent/1 with:

- intent_id, account_scope_digest, agent_id;
- runtime_id and runtime_build_digest;
- strategy_activation_id and strategy_ir_digest;
- observation_digest and canonical_instrument_id;
- side, order_type and quantity;
- limit_price and stop_price, nullable;
- time_in_force and reduce_only;
- execution_mode, created_at, expires_at and intent_digest.

side is buy or sell. order_type is market, limit or stop only when advertised
by the adapter. quantity MUST be positive. Price fields MUST match order type.
Activation and risk policy MUST admit instrument, type and side.
execution_mode MUST be paper. An intent grants no authority.

## 9. RiskDecisionV1

ATSv2 evaluates immutable intent, market, account, positions, balances, open
orders and policy snapshots.

Required hard checks:

- instrument, side, order type and session allowlists;
- maximum order quantity and notional;
- maximum instrument and cluster concentration;
- maximum gross and net exposure and leverage;
- daily loss, drawdown and consecutive-loss circuit;
- maximum open orders, order rate and concurrency;
- maximum spread, slippage and price deviation;
- data and account-snapshot freshness;
- short, derivative and reduce-only constraints.

RiskDecisionV1 schema is aether.ats.risk-decision/1. Required fields are
decision_id, intent_id, intent_digest, risk_policy_digest, observation_digest,
account_snapshot_digest, checks, decision, evaluated_at, expires_at and
decision_digest.

Each check requires id, status, observed, limit and bounded reason. status is
pass, reject or unknown. decision is pass only when every required check passes.
Missing, stale, malformed, overflowed, unmapped or non-finite input is unknown
and blocks planning. PAUSE or an engaged kill switch dominates directional
intent.

## 10. ExecutionPlanV1

Aether-Agent creates a plan only from matching, unexpired capability,
activation, intent and passing risk decision.

ExecutionPlanV1 schema is aether.ats.execution-plan/1. Required fields are
plan_id, intent_id, intent_digest, risk_decision_id, risk_decision_digest,
account_snapshot_digest, adapter_id, adapter_instance_id, execution_mode,
effect_preview, blockers, created_at, expires_at and plan_digest.

Plans are one-shot. Changed intent, observation, account snapshot, risk policy,
runtime, adapter instance, kill-switch generation or reconciliation cursor
invalidates the plan.

v1 MAY require an exact operator confirmation, but confirmation only consumes
the matching paper plan. It cannot change execution mode.

## 11. Authorization non-sources

None of these authorize execution:

- policy consent;
- plan, skip or danger UI mode;
- ask, auto or skip coding mode;
- --yes or non-interactive invocation;
- user chat, an agent DM or another agent;
- browser, MCP, plugin or web content;
- strategy source, metadata, compilation or activation;
- data probe, memory readiness, UVT or lifecycle activation;
- Cloud status, environment variables or prior receipts.

Non-TTY execution requiring confirmation fails closed.

## 12. BrokerAdapterV1

BrokerAdapterV1 is typed but admits only a local deterministic paper
implementation in v1.

Required methods:

- capabilities and accountSnapshot;
- submit(plan, idempotency_key);
- cancel(order_id, idempotency_key);
- getOrder and listOpenOrders;
- listFills(after_cursor);
- listPositions and listBalances.

The adapter MUST report mode paper and live_supported false. It accepts no
broker credential and makes no order-routing network request.

submit returns accepted, rejected or uncertain. Timeout, disconnect, malformed
response or death after dispatch is uncertain, never proof that nothing
happened. Uncertain submit MUST NOT retry before reconciliation by client order
ID.

Paper fills are deterministic from observation, fill-policy and adapter-version
digests. Fees, slippage, partial fills, session closure and rejects are explicit.
Identical replay produces byte-identical ledger events.

## 13. Durable ledger

OrderLedgerEventV1 schema is aether.ats.ledger-event/1. Required fields are
ledger_id, event_id, ledger_seq, previous_event_digest, event_type, order_id,
intent_id, plan_id, payload, recorded_at and event_digest.

Writes MUST be account-agent scoped, locked, append-only, atomically durable and
validated before cursor advance. The ATS diagnostic journal MUST NOT serve as
this ledger.

Duplicate provider ID plus same digest is a no-op. Same ID plus different bytes
is a conflict. Corrupt, truncated or discontinuous state engages the kill
switch and requires reconciliation.

### State machine

Allowed transitions:

- proposed to risk_rejected or risk_passed;
- risk_passed to planned;
- planned to submit_pending;
- submit_pending to acknowledged, rejected or submit_uncertain;
- acknowledged to partially_filled, filled, cancel_pending or expired;
- partially_filled to partially_filled, filled or cancel_pending;
- cancel_pending to cancelled, filled or cancel_uncertain;
- submit_uncertain or cancel_uncertain to reconciliation_required;
- reconciliation_required to acknowledged, partially_filled, filled, cancelled,
  rejected or expired.

risk_rejected, filled, cancelled, rejected and expired are terminal. Illegal or
backward transitions return ATS_LEDGER_TRANSITION_INVALID.

## 14. Reconciliation

Reconciliation runs before first submit after process start, runtime or adapter
change, reconnect, timeout, uncertain outcome, ledger recovery, provider
sequence gap or kill-switch release.

ReconciliationReportV1 schema is aether.ats.reconciliation-report/1. Required
fields are report_id, account and adapter bindings, start_cursor, end_cursor,
orders_digest, fills_digest, positions_digest, balances_digest, mismatches,
status, observed_at and report_digest.

status is clean, mismatch or unknown. Only clean admits a new plan. mismatch or
unknown engages the kill switch and returns ATS_RECONCILIATION_REQUIRED.
Adapter order and fill evidence controls over natural-language and local
assumptions. Reconciliation may attach an existing order by client order ID; it
MUST NOT create a replacement order.

## 15. Kill switch

KillSwitchV1 schema is aether.ats.kill-switch/1. Required fields are state,
generation, account_scope_digest, agent_id, engaged_at, engaged_by, reason,
last_clean_reconciliation_digest and record_digest.

It is a durable generation-counted latch. submit and replace MUST check the
current generation immediately before dispatch.

Engagement order:

1. Persist engaged state.
2. Block new submit and replace.
3. Request cancel for each open paper order.
4. Record every cancel outcome.
5. Reconcile.

Adapter or network failure leaves the latch engaged. Release requires explicit
operator action, fresh capability and a clean reconciliation created after
engagement. Release invalidates old plans.

Flattening is outside v1 and MUST NOT be hidden inside kill behavior. Process
termination is containment only and MUST NOT clear the latch.

## 16. Failure semantics

Stable codes:

- ATS_CONTRACT_INVALID and ATS_SCOPE_MISMATCH;
- ATS_CAPABILITY_STALE and ATS_DATA_STALE;
- ATS_STRATEGY_INACTIVE;
- ATS_RISK_REJECTED and ATS_RISK_UNKNOWN;
- ATS_EXECUTION_MODE_UNSUPPORTED and ATS_AUTHORITY_ABSENT;
- ATS_IDEMPOTENCY_CONFLICT;
- ATS_SUBMIT_UNCERTAIN and ATS_CANCEL_UNCERTAIN;
- ATS_RECONCILIATION_REQUIRED;
- ATS_KILL_SWITCH_ENGAGED;
- ATS_ADAPTER_UNAVAILABLE;
- ATS_LEDGER_CORRUPT and ATS_LEDGER_TRANSITION_INVALID.

Unknown codes fail operationally. No error becomes success. Retryable transport
metadata never permits automatic replay of uncertain submit or cancel. Evidence
is preserved before recovery. Logs and errors are bounded and secret-redacted.

## 17. Sequential cross-repository landing

Schemas cannot drift locally; changes return to this contract.

1. Aether-Agent contract freeze: this document only.
2. ATSv2 contract core: closed validators, canonical fixtures, capability and
   receipt producer, activation, intent normalization and pure risk decisions.
3. ATSv2 paper runtime: deterministic BrokerAdapterV1, idempotency,
   reconciliation inputs and kill hooks; publish immutable build evidence.
4. AETHER-CLOUD read-only projection: account-scoped readiness and additive
   profile validation; reject authority, credentials, live mode and order
   commands; write no order.
5. Aether-Agent consumer: pin ATSv2 build; validate capability; implement ledger,
   plan admission, reconciliation, kill switch and paper-only CLI/status.
6. Cross-repository qualification: shared vectors, crash/restart drills,
   deterministic replay and end-to-end paper campaign at exact commits.
7. Release documentation only after step 6 is green.

A later step MUST NOT merge ahead of a failed dependency. Lanes inside a step
may fan out only after schemas and golden fixtures are frozen. execute_live
remains false throughout v1.

## 18. Required tests and gates

### ATSv2

Required files:

- tests/execution/test_contract_v1.py
- tests/execution/test_capability_v1.py
- tests/execution/test_strategy_activation_v1.py
- tests/execution/test_risk_v1.py
- tests/execution/test_paper_adapter_v1.py
- tests/execution/test_idempotency_v1.py
- tests/execution/test_reconciliation_v1.py
- tests/execution/test_kill_switch_v1.py

Coverage MUST include closed schemas, decimals, times, IDs, canonical digests,
cross-language vectors, capability expiry, unsupported effects, stale signals,
below/at/above every risk limit, PAUSE dominance, deterministic full and partial
fills, fees, rejects, cancel races, same-ID replay, ID conflicts, concurrency,
crash points, restart, mismatch and latch release.

ATSv2 gate: clean checkout green; capability names exact build; adapter advertises
paper only; no live dependency or credential is reachable.

### Aether-Agent

Required files:

- test/ats_execution_contract.test.ts
- test/ats_execution_authority.test.ts
- test/ats_execution_ledger.test.ts
- test/ats_execution_reconciliation.test.ts
- test/ats_execution_kill_switch.test.ts
- test/ats_execution_crash_matrix.test.ts
- test/ats_execution_cli.test.ts

Tests MUST prove all authorization non-sources fail; non-TTY fails closed; plan
bindings invalidate; ledger link, corruption and concurrency cases preserve
evidence; restart never double-submits; kill state survives restart. Existing
ATS, policy, browser and runtime-package tests remain green.

Agent gate: packed artifact against pinned ATSv2, clean startup reconciliation,
zero duplicate submissions and zero unresolved uncertain outcomes.

### AETHER-CLOUD

Required files:

- tests/api/test_ats_runtime_capability_v1.py
- tests/api/test_ats_profile_non_authority_v1.py
- tests/api/test_ats_dm_non_authority_v1.py
- tests/api/test_ats_execution_fields_rejected_v1.py

Tests MUST verify account ownership, bounded read-only projection, unknown-field
rejection, no credential fields, no order mutation route and no authority from
DMs or agents.

Cloud gate: additive compatibility and security review pass; no execution
mutation endpoint exists.

### Cross-repository

Shared fixtures MUST parse and digest identically in Python and TypeScript.
Fault injection covers crash before dispatch, after dispatch before ack, after
ack before ledger commit, duplicate and out-of-order events, timeout, reconnect
and corrupt state.

v1 completes only when all repository gates and the paper campaign are green at
recorded commits. Missing evidence keeps execution unavailable. No v1 test may
place or simulate authority for a live-capital order.
