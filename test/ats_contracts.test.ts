import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ATS_CANONICAL_PROFILE,
  ATS_SPEC1_SCHEMAS,
  canonicalJson,
  digestOf,
  forbidsRetry,
  grantPermits,
  isApprovalUsable,
  isReviewApprovable,
  permitsOrderSubmission,
  redactBindingForExport,
  validateAccountBinding,
  validateConnectorCapability,
  validateExecutionReceipt,
  validateExecutionState,
  validateOperatorApproval,
  validateOrderIntent,
  validateOrderReview,
  validateTradingGrant,
  verifyApprovalChain,
  withinRequestedAuthority,
  type DelegatedTradingGrantV1,
  type GrantUsage,
} from "../src/core/ats_contracts/index.js";

const GOLDEN = "test/fixtures/ats_contracts_golden.json";

interface GoldenVector {
  schema_version: string;
  document: Record<string, unknown>;
  canonical_digest: string;
  canonical_bytes_sha256: string;
}

interface GoldenFixture {
  schema_version: string;
  canonical_profile: string;
  vectors: GoldenVector[];
}

const VALIDATORS: Record<string, (value: unknown) => unknown> = {
  "aether.ats.execution-state/1": validateExecutionState,
  "aether.ats.connector-capability/1": validateConnectorCapability,
  "aether.ats.account-binding/1": validateAccountBinding,
  "aether.ats.delegated-trading-grant/1": validateTradingGrant,
  "aether.ats.equity-order-intent/1": validateOrderIntent,
  "aether.ats.order-review-receipt/1": validateOrderReview,
  "aether.ats.operator-approval/1": validateOperatorApproval,
  "aether.ats.execution-receipt/1": validateExecutionReceipt,
};

async function golden(): Promise<GoldenFixture> {
  return JSON.parse(await readFile(GOLDEN, "utf8")) as GoldenFixture;
}

function vector(fixture: GoldenFixture, schema: string): Record<string, unknown> {
  const found = fixture.vectors.find((entry) => entry.schema_version === schema);
  assert.ok(found, `golden fixture is missing ${schema}`);
  return structuredClone(found.document);
}

// --- Golden vectors: the cross-language drift detector -----------------------

test("every frozen schema has a golden vector that still validates and digests the same", async () => {
  const fixture = await golden();
  assert.equal(fixture.canonical_profile, ATS_CANONICAL_PROFILE);
  assert.deepEqual(
    fixture.vectors.map((entry) => entry.schema_version).sort(),
    [...ATS_SPEC1_SCHEMAS].sort(),
    "golden fixture and ATS_SPEC1_SCHEMAS disagree about which schemas are frozen",
  );

  for (const entry of fixture.vectors) {
    const validate = VALIDATORS[entry.schema_version];
    assert.ok(validate, `no validator wired for ${entry.schema_version}`);
    const parsed = validate(entry.document);
    assert.equal(digestOf(parsed), entry.canonical_digest, `${entry.schema_version} digest drifted`);
  }
});

test("canonical encoding matches Python json.dumps(sort_keys, compact, ensure_ascii)", () => {
  // Python: json.dumps({"b":1,"a":"café"}, sort_keys=True,
  //         separators=(",", ":"), ensure_ascii=True) -> '{"a":"caf\\u00e9","b":1}'
  assert.equal(canonicalJson({ b: 1, a: "café" }), '{"a":"caf\\u00e9","b":1}');
  // Key order must not change the bytes; an unset key must not either.
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
});

test("canonical encoding refuses floats so money cannot drift across languages", () => {
  assert.throws(() => canonicalJson({ price: 580.12 }), /non-integer/);
  assert.throws(() => canonicalJson({ price: Number.NaN }), /non-finite/);
});

// --- Closed documents --------------------------------------------------------

test("an unknown field is refused rather than ignored", async () => {
  const fixture = await golden();
  for (const schema of ATS_SPEC1_SCHEMAS) {
    const document = vector(fixture, schema);
    document["injected_field"] = "x";
    assert.throws(() => VALIDATORS[schema]!(document), /unsupported field/, `${schema} accepted an unknown field`);
  }
});

test("a prototype-polluted payload is refused", async () => {
  const fixture = await golden();
  const document = vector(fixture, "aether.ats.execution-state/1");
  const hostile = Object.assign(Object.create({ evil: true }), document);
  assert.throws(() => validateExecutionState(hostile), /plain object/);
});

// --- Authority invariants ----------------------------------------------------

test("a capability document can never claim execution authority", async () => {
  const fixture = await golden();
  const document = vector(fixture, "aether.ats.connector-capability/1");
  document["grants_execution_authority"] = true;
  assert.throws(() => validateConnectorCapability(document), /execution authority/);
});

test("effective mode may never exceed requested mode", () => {
  assert.equal(withinRequestedAuthority("paper", "observe"), true);
  assert.equal(withinRequestedAuthority("paper", "paper"), true);
  assert.equal(withinRequestedAuthority("paper", "approve"), false);
  assert.equal(withinRequestedAuthority("observe", "auto"), false);
  // Halts are always reachable, whatever was requested.
  assert.equal(withinRequestedAuthority("observe", "emergency_locked"), true);
  assert.equal(withinRequestedAuthority("observe", "orders_paused"), true);

  assert.throws(
    () =>
      validateExecutionState({
        schema_version: "aether.ats.execution-state/1",
        requested_mode: "paper",
        effective_mode: "approve",
        effective_reason: "upgraded by a local preference",
      }),
    /more authority than was requested/,
  );
});

test("a downgrade must explain itself", () => {
  assert.throws(
    () =>
      validateExecutionState({
        schema_version: "aether.ats.execution-state/1",
        requested_mode: "approve",
        effective_mode: "observe",
        effective_reason: null,
      }),
    /must explain/,
  );
});

test("observe and review_only never permit order submission", () => {
  assert.equal(permitsOrderSubmission("observe"), false);
  assert.equal(permitsOrderSubmission("review_only"), false);
  assert.equal(permitsOrderSubmission("offline"), false);
  assert.equal(permitsOrderSubmission("orders_paused"), false);
  assert.equal(permitsOrderSubmission("emergency_locked"), false);
  assert.equal(permitsOrderSubmission("paper"), true);
});

// --- Account custody ---------------------------------------------------------

test("a raw account number cannot be used as an opaque reference", async () => {
  const fixture = await golden();
  const document = vector(fixture, "aether.ats.account-binding/1");
  document["opaque_account_ref"] = "123456789012";
  assert.throws(() => validateAccountBinding(document), /never a provider account number/);
});

test("a masked label cannot smuggle a full account number", async () => {
  const fixture = await golden();
  const document = vector(fixture, "aether.ats.account-binding/1");
  document["masked_label"] = "Agentic 123456789";
  assert.throws(() => validateAccountBinding(document), /full account number/);
});

test("the exported binding carries no credential or provider account reference", async () => {
  const fixture = await golden();
  const binding = validateAccountBinding(vector(fixture, "aether.ats.account-binding/1"));
  const exported = redactBindingForExport(binding);
  assert.deepEqual(Object.keys(exported).sort(), [
    "binding_generation",
    "masked_label",
    "opaque_account_ref",
    "provider_id",
  ]);
  const serialized = JSON.stringify(exported);
  assert.ok(!serialized.includes(binding.credential_ref), "credential reference leaked into the export");
  assert.ok(!serialized.includes(binding.encrypted_account_ref), "encrypted account reference leaked into the export");
});

// --- Grant enforcement -------------------------------------------------------

const NO_USAGE: GrantUsage = { notional_today_minor: 0, orders_today: 0, open_orders: 0 };

async function activeGrant(): Promise<DelegatedTradingGrantV1> {
  const fixture = await golden();
  return validateTradingGrant(vector(fixture, "aether.ats.delegated-trading-grant/1"));
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "SPY",
    side: "buy" as const,
    order_type: "limit" as const,
    worst_case_notional_minor: 100000,
    resulting_position_notional_minor: 100000,
    execution_environment: "ats_paper" as const,
    ...overrides,
  };
}

test("an empty symbol allowlist permits nothing", async () => {
  const grant = await activeGrant();
  const empty = validateTradingGrant({ ...grant, symbol_allowlist: [] });
  const decision = grantPermits(empty, order(), NO_USAGE, Date.parse("2026-09-22T15:00:00Z"));
  assert.equal(decision.allowed, false);
  assert.match((decision as { reason: string }).reason, /no permitted symbols/);
});

test("the per-symbol position notional limit is enforced", async () => {
  const grant = await activeGrant();
  const now = Date.parse("2026-09-22T15:00:00Z");
  // Within the per-order cap but over the per-symbol position cap.
  const decision = grantPermits(
    grant,
    order({ worst_case_notional_minor: 200000, resulting_position_notional_minor: 600000 }),
    NO_USAGE,
    now,
  );
  assert.equal(decision.allowed, false);
  assert.match((decision as { reason: string }).reason, /per-symbol position notional/);
});

test("a grant cannot authorize an order in a different environment", async () => {
  const grant = await activeGrant();
  const decision = grantPermits(
    grant,
    order({ execution_environment: "provider_live" }),
    NO_USAGE,
    Date.parse("2026-09-22T15:00:00Z"),
  );
  assert.equal(decision.allowed, false);
  assert.match((decision as { reason: string }).reason, /environment/);
});

test("revoked, expired and abuse-flagged grants refuse", async () => {
  const grant = await activeGrant();
  const now = Date.parse("2026-09-22T15:00:00Z");
  for (const state of ["revoked", "suspended", "expired"] as const) {
    const decision = grantPermits(validateTradingGrant({ ...grant, state }), order(), NO_USAGE, now);
    assert.equal(decision.allowed, false, `${state} grant allowed an order`);
  }
  assert.equal(grantPermits(grant, order(), NO_USAGE, Date.parse("2026-09-23T00:00:00Z")).allowed, false);
  assert.equal(
    grantPermits(validateTradingGrant({ ...grant, abuse_flagged: true }), order(), NO_USAGE, now).allowed,
    false,
  );
});

test("daily notional and order counts include the order being checked", async () => {
  const grant = await activeGrant();
  const now = Date.parse("2026-09-22T15:00:00Z");
  const nearLimit: GrantUsage = { notional_today_minor: 950000, orders_today: 0, open_orders: 0 };
  assert.equal(grantPermits(grant, order({ worst_case_notional_minor: 100000 }), nearLimit, now).allowed, false);
  const atOrderCap: GrantUsage = { notional_today_minor: 0, orders_today: 10, open_orders: 0 };
  assert.equal(grantPermits(grant, order(), atOrderCap, now).allowed, false);
  const atOpenCap: GrantUsage = { notional_today_minor: 0, orders_today: 0, open_orders: 2 };
  assert.equal(grantPermits(grant, order(), atOpenCap, now).allowed, false);
});

test("a grant cannot express standing approval", async () => {
  const fixture = await golden();
  const document = vector(fixture, "aether.ats.delegated-trading-grant/1");
  document["confirmation"] = "session";
  assert.throws(() => validateTradingGrant(document), /confirmation/);
});

// --- Order shape -------------------------------------------------------------

test("a limit order needs a price and a market order must not carry one", async () => {
  const fixture = await golden();
  const base = vector(fixture, "aether.ats.equity-order-intent/1");
  assert.throws(() => validateOrderIntent({ ...base, limit_price_minor: null }), /requires a limit price/);
  assert.throws(() => validateOrderIntent({ ...base, order_type: "market" }), /must not carry a limit price/);
  // A market order with no price is fine.
  assert.ok(validateOrderIntent({ ...base, order_type: "market", limit_price_minor: null }));
});

test("fractional quantities are not expressible", async () => {
  const fixture = await golden();
  const base = vector(fixture, "aether.ats.equity-order-intent/1");
  assert.throws(() => validateOrderIntent({ ...base, quantity: 1.5 }), /whole number/);
  assert.throws(() => validateOrderIntent({ ...base, quantity: 0 }), /out of range/);
});

test("a non-UTC timestamp is refused", async () => {
  const fixture = await golden();
  const base = vector(fixture, "aether.ats.equity-order-intent/1");
  assert.throws(() => validateOrderIntent({ ...base, created_at: "2026-09-22T10:30:00-04:00" }), /UTC/);
});

test("an approval deadline cannot outlive its reservation", async () => {
  const fixture = await golden();
  const base = vector(fixture, "aether.ats.order-review-receipt/1");
  assert.throws(
    () => validateOrderReview({ ...base, approval_deadline: "2026-09-22T14:34:00Z" }),
    /cannot outlive its reservation/,
  );
});

test("a stale or refused review is not approvable", async () => {
  const fixture = await golden();
  const review = validateOrderReview(vector(fixture, "aether.ats.order-review-receipt/1"));
  assert.equal(isReviewApprovable(review, Date.parse("2026-09-22T14:31:00Z")).approvable, true);
  assert.equal(isReviewApprovable(review, Date.parse("2026-09-22T14:32:01Z")).approvable, false);

  const refused = validateOrderReview({
    ...vector(fixture, "aether.ats.order-review-receipt/1"),
    risk_verdict: "refuse",
    risk_reason: "daily loss limit reached",
  });
  assert.equal(isReviewApprovable(refused, Date.parse("2026-09-22T14:31:00Z")).approvable, false);
});

// --- The approval chain ------------------------------------------------------

async function chainParts() {
  const fixture = await golden();
  const intent = validateOrderIntent(vector(fixture, "aether.ats.equity-order-intent/1"));
  const review = validateOrderReview(vector(fixture, "aether.ats.order-review-receipt/1"));
  const approval = validateOperatorApproval(vector(fixture, "aether.ats.operator-approval/1"));
  return { fixture, intent, review, approval, intentDigest: digestOf(intent) };
}

test("the golden chain is consistent", async () => {
  const { intent, review, approval, intentDigest } = await chainParts();
  assert.equal(verifyApprovalChain(intent, review, approval, intentDigest).consistent, true);
});

test("changing any approved order term breaks the chain", async () => {
  const { fixture, intent, review, intentDigest } = await chainParts();
  const base = vector(fixture, "aether.ats.operator-approval/1");
  const mutations: Array<[string, unknown]> = [
    ["quantity", 5],
    ["side", "sell"],
    ["symbol", "QQQ"],
    ["limit_price_minor", 58013],
    ["worst_case_notional_minor", 232049],
    ["activation_id", "activation_other"],
    ["artifact_id", "artifact_other"],
    ["reservation_ref", "resv_other01"],
    ["broker_preview_id", "preview_other1"],
    ["grant_version", 2],
  ];
  for (const [field, value] of mutations) {
    const approval = validateOperatorApproval({ ...base, [field]: value });
    const verdict = verifyApprovalChain(intent, review, approval, intentDigest);
    assert.equal(verdict.consistent, false, `mutating ${field} did not break the chain`);
  }
});

test("an approval minted in another environment cannot authorize this commit", async () => {
  const { fixture, intent, review, intentDigest } = await chainParts();
  const base = vector(fixture, "aether.ats.operator-approval/1");
  const connector = structuredClone(base["connector"]) as Record<string, unknown>;
  connector["execution_environment"] = "provider_live";
  const approval = validateOperatorApproval({ ...base, connector });
  const verdict = verifyApprovalChain(intent, review, approval, intentDigest);
  assert.equal(verdict.consistent, false);
  assert.match((verdict as { reason: string }).reason, /connector binding/);
});

test("a re-linked account invalidates an approval minted for the old binding", async () => {
  const { fixture, intent, review, intentDigest } = await chainParts();
  const base = vector(fixture, "aether.ats.operator-approval/1");
  const connector = structuredClone(base["connector"]) as Record<string, unknown>;
  connector["binding_generation"] = 2;
  const approval = validateOperatorApproval({ ...base, connector });
  assert.equal(verifyApprovalChain(intent, review, approval, intentDigest).consistent, false);
});

test("an approval is single use and time bound", async () => {
  const { fixture, approval } = await chainParts();
  assert.equal(isApprovalUsable(approval, Date.parse("2026-09-22T14:31:00Z")).usable, true);
  assert.equal(isApprovalUsable(approval, Date.parse("2026-09-22T14:32:01Z")).usable, false);

  const consumed = validateOperatorApproval({
    ...vector(fixture, "aether.ats.operator-approval/1"),
    consumed_at: "2026-09-22T14:30:45Z",
  });
  const verdict = isApprovalUsable(consumed, Date.parse("2026-09-22T14:31:00Z"));
  assert.equal(verdict.usable, false);
  assert.match((verdict as { reason: string }).reason, /already used/);
});

// --- Execution receipts ------------------------------------------------------

test("fill facts are only expressible when the broker confirmed them", async () => {
  const fixture = await golden();
  const base = vector(fixture, "aether.ats.execution-receipt/1");

  assert.throws(() => validateExecutionReceipt({ ...base, fill: null }), /without broker-confirmed fill facts/);
  assert.throws(
    () =>
      validateExecutionReceipt({
        ...base,
        outcome: "refused",
        reason: "risk refused",
        submitted_at: null,
        settled_at: null,
      }),
    /fill facts for an outcome that did not fill/,
  );
});

test("a receipt cannot report filling more than it ordered", async () => {
  const fixture = await golden();
  const base = vector(fixture, "aether.ats.execution-receipt/1");
  const fill = { filled_quantity: 5, average_fill_price_minor: 58005, confirmed_at: "2026-09-22T14:30:33Z" };
  assert.throws(() => validateExecutionReceipt({ ...base, fill }), /filled more than it ordered/);
});

test("an ambiguous commit must carry a reconciliation state and a reason", async () => {
  const fixture = await golden();
  const base = vector(fixture, "aether.ats.execution-receipt/1");
  const ambiguous = {
    ...base,
    outcome: "ambiguous",
    fill: null,
    settled_at: null,
    reconciliation_state: "not_required",
    reason: "connection lost after commit",
  };
  assert.throws(() => validateExecutionReceipt(ambiguous), /needing no reconciliation/);
  assert.throws(
    () => validateExecutionReceipt({ ...ambiguous, reconciliation_state: "pending", reason: null }),
    /must explain/,
  );
  assert.ok(validateExecutionReceipt({ ...ambiguous, reconciliation_state: "pending" }));
});

test("anything that may have reached the venue forbids a retry", async () => {
  const fixture = await golden();
  const base = vector(fixture, "aether.ats.execution-receipt/1");
  const ambiguous = validateExecutionReceipt({
    ...base,
    outcome: "ambiguous",
    fill: null,
    settled_at: null,
    submitted_at: null,
    reconciliation_state: "pending",
    reason: "connection lost after commit",
  });
  assert.equal(forbidsRetry(ambiguous), true);

  const refusedBeforeSubmit = validateExecutionReceipt({
    ...base,
    outcome: "refused",
    fill: null,
    opaque_order_ref: null,
    submitted_at: null,
    settled_at: null,
    reconciliation_state: "not_required",
    reason: "kill switch engaged before commit",
  });
  assert.equal(forbidsRetry(refusedBeforeSubmit), false);
});

// --- The module holds no authority ------------------------------------------

test("the contract modules perform no I/O and hold no credentials", async () => {
  const sources = await Promise.all(
    ["primitives", "canonical", "mode", "connector", "grant", "order", "approval", "index"].map((name) =>
      readFile(`src/core/ats_contracts/${name}.ts`, "utf8"),
    ),
  );
  for (const source of sources) {
    // Strip comments before scanning: the prose deliberately discusses sockets,
    // credentials and files, and matching on that would be a false positive.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    for (const forbidden of ["node:fs", "node:net", "node:http", "node:child_process", "fetch(", "process.env"]) {
      assert.ok(!code.includes(forbidden), `a contract module reached for ${forbidden}`);
    }
  }
});
