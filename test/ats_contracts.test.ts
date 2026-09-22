import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  ATS_CANONICAL_PROFILE,
  ATS_SPEC1_SCHEMAS,
  canonicalJson,
  digestOf,
  forbidsRetry,
  grantPermits,
  isApprovalUsable,
  isReviewApprovable,
  multilineText,
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
  verifyCommitAuthority,
  withinRequestedAuthority,
  type DelegatedTradingGrantV1,
  type GrantUsage,
} from "../src/core/ats_contracts/index.js";

const GOLDEN = "test/fixtures/ats_contracts_golden.json";
const NOW = Date.parse("2026-09-22T14:30:45Z");

interface GoldenFixture {
  schema_version: string;
  canonical_profile: string;
  canonical_vectors: Array<{ name: string; value: unknown; canonical: string; digest: string }>;
  canonical_rejects: Array<{ name: string; value: unknown }>;
  vectors: Array<{ schema_version: string; document: Record<string, unknown>; canonical_digest: string }>;
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

// --- RFC 8785 canonicalization ----------------------------------------------

test("every canonical vector reproduces its recorded bytes and digest", async () => {
  const fixture = await golden();
  assert.equal(fixture.canonical_profile, ATS_CANONICAL_PROFILE);
  assert.equal(ATS_CANONICAL_PROFILE, "rfc8785/1");
  assert.ok(fixture.canonical_vectors.length >= 8);
  for (const entry of fixture.canonical_vectors) {
    assert.equal(canonicalJson(entry.value), entry.canonical, `canonical bytes drifted: ${entry.name}`);
    assert.equal(digestOf(entry.value), entry.digest, `digest drifted: ${entry.name}`);
  }
});

test("non-ASCII is emitted literally, not escaped", () => {
  // The regression guard for the bug this profile replaced: the previous
  // encoder produced {"a":"caf\\u00e9"} (Python ensure_ascii=True), which is
  // NOT JCS and yields a different digest for the same document.
  assert.equal(canonicalJson({ a: "café" }), '{"a":"café"}');
  assert.ok(!canonicalJson({ a: "café" }).includes("\\u00e9"));
  assert.equal(canonicalJson({ a: "\u{1D11E}" }), '{"a":"\u{1D11E}"}');
});

test("object keys sort by UTF-16 code unit, not code point", async () => {
  // The astral key begins with high surrogate 0xD800, which is below 0xFFFF, so
  // UTF-16 order puts it first. Python's sorted() compares code points and puts
  // it last. A Python mirror that gets this wrong fails here and nowhere else.
  const encoded = canonicalJson({ "\u{10000}": 1, "￿": 2 });
  assert.equal(encoded.indexOf("\u{10000}") < encoded.indexOf("￿"), true, "astral key must sort first");

  const fixture = await golden();
  const pinned = fixture.canonical_vectors.find((v) => v.name.includes("UTF-16 code units"));
  assert.ok(pinned, "the key-ordering vector must stay in the fixture");
});

test("lone surrogates are refused because they have no UTF-8 encoding", async () => {
  const fixture = await golden();
  assert.ok(fixture.canonical_rejects.length >= 2);
  for (const entry of fixture.canonical_rejects) {
    assert.throws(() => canonicalJson(entry.value), /surrogate/, `encoder accepted ${entry.name}`);
  }
  assert.throws(() => canonicalJson({ a: "\ud800" }), /unpaired high surrogate/);
  assert.throws(() => canonicalJson({ a: "\udc00" }), /unpaired low surrogate/);
});

test("negative zero normalizes and non-finite numbers are refused", () => {
  assert.equal(canonicalJson({ a: -0 }), '{"a":0}');
  assert.throws(() => canonicalJson({ a: Number.NaN }), /NaN and Infinity/);
  assert.throws(() => canonicalJson({ a: Number.POSITIVE_INFINITY }), /NaN and Infinity/);
});

test("JCS itself accepts floats; the contracts reject them one layer up", async () => {
  // Deliberate separation of concerns: the encoder is a faithful RFC 8785
  // implementation, and integer-only money is a contract rule enforced by the
  // validators. Asserting both halves so neither drifts into the other.
  assert.equal(canonicalJson({ a: 1.5 }), '{"a":1.5}');
  const fixture = await golden();
  const base = vector(fixture, "aether.ats.equity-order-intent/1");
  assert.throws(() => validateOrderIntent({ ...base, limit_price_minor: 580.12 }), /whole number/);
  assert.throws(() => validateOrderIntent({ ...base, quantity: 1.5 }), /whole number/);
});

test("key order and unset fields never change the digest", () => {
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
});

test("the fixture would actually catch a regression to the old escaping encoder", async () => {
  // A fixture of pure-ASCII documents cannot detect \u-escaping: the old
  // ensure_ascii encoder and a correct JCS encoder produce byte-identical
  // output on ASCII, so every recorded digest would still match. The contract
  // documents were all ASCII until this was noticed, which meant the schema
  // layer pinned nothing about the encoding.
  //
  // This test fails if someone "tidies" the non-ASCII out of the fixture.
  const fixture = await golden();
  const hasNonAscii = (value: unknown) => [...JSON.stringify(value)].some((c) => c.codePointAt(0)! > 0x7f);

  assert.ok(
    fixture.canonical_vectors.filter((entry) => hasNonAscii(entry.value)).length >= 3,
    "canonical vectors must keep the non-ASCII, astral and key-ordering cases",
  );
  const contractCovered = fixture.vectors.filter((entry) => hasNonAscii(entry.document));
  assert.ok(
    contractCovered.length >= 1,
    "at least one contract document must carry non-ASCII, or the schema-layer digests pin nothing about the encoder",
  );

  // Prove the coverage is real rather than assumed: re-digest a covered
  // document under the OLD escaping rule and require disagreement.
  const escapeNonAscii = (json: string) =>
    [...json]
      .map((ch) => {
        const c = ch.codePointAt(0)!;
        if (c < 0x80) return ch;
        if (c <= 0xffff) return `\\u${c.toString(16).padStart(4, "0")}`;
        const x = c - 0x10000;
        return `\\u${(0xd800 + (x >> 10)).toString(16)}\\u${(0xdc00 + (x & 0x3ff)).toString(16)}`;
      })
      .join("");
  const oldEncode = (value: unknown): string => {
    if (value === null) return "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return JSON.stringify(value);
    if (typeof value === "string") return escapeNonAscii(JSON.stringify(value));
    if (Array.isArray(value)) return `[${value.map(oldEncode).join(",")}]`;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${escapeNonAscii(JSON.stringify(key))}:${oldEncode(record[key])}`).join(",")}}`;
  };

  const covered = contractCovered[0]!;
  assert.notEqual(
    `sha256:${createHash("sha256").update(oldEncode(covered.document), "utf8").digest("hex")}`,
    covered.canonical_digest,
    "the old encoder produced the same digest — this document does not actually pin the encoding",
  );
});

// --- Golden contract vectors -------------------------------------------------

test("every frozen schema has a golden vector that still validates and digests the same", async () => {
  const fixture = await golden();
  assert.deepEqual(
    fixture.vectors.map((entry) => entry.schema_version).sort(),
    [...ATS_SPEC1_SCHEMAS].sort(),
    "golden fixture and ATS_SPEC1_SCHEMAS disagree about which schemas are frozen",
  );
  for (const entry of fixture.vectors) {
    const validate = VALIDATORS[entry.schema_version];
    assert.ok(validate, `no validator wired for ${entry.schema_version}`);
    assert.equal(digestOf(validate(entry.document)), entry.canonical_digest, `${entry.schema_version} drifted`);
  }
});

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
  const hostile = Object.assign(Object.create({ evil: true }), vector(fixture, "aether.ats.execution-state/1"));
  assert.throws(() => validateExecutionState(hostile), /plain object/);
});

// --- Primitive hardening -----------------------------------------------------

test("impossible calendar dates are refused, not rolled over", async () => {
  const fixture = await golden();
  const base = vector(fixture, "aether.ats.equity-order-intent/1");
  // Two distinct refusal paths, both correct: a month of 13 makes Date.parse
  // return NaN outright, while 30 February parses cleanly as 2 March and is
  // only caught by comparing the parsed fields back to the input.
  const refused = /real (calendar date|instant)/;
  assert.throws(() => validateOrderIntent({ ...base, created_at: "2026-02-30T00:00:00Z" }), /real calendar date/);
  assert.throws(() => validateOrderIntent({ ...base, created_at: "2026-09-31T00:00:00Z" }), /real calendar date/);
  // 2028 is a leap year, 2026 is not.
  assert.throws(() => validateOrderIntent({ ...base, created_at: "2026-02-29T00:00:00Z" }), /real calendar date/);
  assert.throws(() => validateOrderIntent({ ...base, created_at: "2026-13-01T00:00:00Z" }), refused);
  assert.throws(() => validateOrderIntent({ ...base, created_at: "2026-00-10T00:00:00Z" }), refused);
  assert.throws(() => validateOrderIntent({ ...base, created_at: "2026-09-22T25:00:00Z" }), refused);
  // A real leap day is accepted. Both ends move together, because the validity
  // window is also checked and an expiry in 2026 would fail for that reason
  // instead, which would not prove anything about the calendar check.
  assert.ok(
    validateOrderIntent({
      ...base,
      created_at: "2028-02-29T00:00:00Z",
      expires_at: "2028-02-29T00:03:00Z",
    }),
  );
});

test("a non-UTC timestamp is refused", async () => {
  const fixture = await golden();
  const base = vector(fixture, "aether.ats.equity-order-intent/1");
  assert.throws(() => validateOrderIntent({ ...base, created_at: "2026-09-22T10:30:00-04:00" }), /UTC/);
});

test("single-line text refuses every control character including tab and newline", async () => {
  const fixture = await golden();
  const base = vector(fixture, "aether.ats.order-review-receipt/1");
  for (const bad of ["daily\nlimit", "daily\tlimit", "daily\rlimit", "daily\u0000limit", "daily\u007flimit"]) {
    assert.throws(
      () => validateOrderReview({ ...base, risk_verdict: "refuse", risk_reason: bad }),
      /control characters/,
      `accepted ${JSON.stringify(bad)}`,
    );
  }
});

test("multiline text permits newline and tab, refuses carriage return", () => {
  assert.equal(multilineText("first\nsecond\tindented", "Note", 100), "first\nsecond\tindented");
  // Rejected rather than normalized: these strings get digested, so folding
  // CRLF would let identical-looking text hash two different ways.
  assert.throws(() => multilineText("first\r\nsecond", "Note", 100), /carriage returns are refused/);
  assert.throws(() => multilineText("a\u0000b", "Note", 100), /control characters/);
  assert.throws(() => multilineText("ab", "Note", 100), /control characters/);
  assert.throws(() => multilineText("x".repeat(11), "Note", 10), /character limit/);
  assert.throws(() => multilineText("", "Note", 10), /must not be empty/);
  assert.equal(multilineText("", "Note", 10, { allowEmpty: true }), "");
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
  assert.equal(withinRequestedAuthority("paper", "approve"), false);
  assert.equal(withinRequestedAuthority("observe", "auto"), false);
  assert.equal(withinRequestedAuthority("observe", "emergency_locked"), true);
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
  for (const mode of ["observe", "review_only", "offline", "orders_paused", "emergency_locked"] as const) {
    assert.equal(permitsOrderSubmission(mode), false, `${mode} permitted submission`);
  }
  assert.equal(permitsOrderSubmission("paper"), true);
});

// --- Account custody ---------------------------------------------------------

test("a bare account number cannot be used where a reference belongs", async () => {
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
  assert.ok(!serialized.includes(binding.credential_ref), "credential reference leaked");
  assert.ok(!serialized.includes(binding.encrypted_account_ref), "encrypted account reference leaked");
});

// --- Grant enforcement -------------------------------------------------------

const NO_USAGE: GrantUsage = { notional_today_minor: 0, orders_today: 0, open_orders: 0 };

async function activeGrant(): Promise<DelegatedTradingGrantV1> {
  return validateTradingGrant(vector(await golden(), "aether.ats.delegated-trading-grant/1"));
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
  const decision = grantPermits(empty, order(), NO_USAGE, NOW);
  assert.equal(decision.allowed, false);
  assert.match((decision as { reason: string }).reason, /no permitted symbols/);
});

test("the per-symbol position notional limit is enforced", async () => {
  const grant = await activeGrant();
  const decision = grantPermits(
    grant,
    order({ worst_case_notional_minor: 200000, resulting_position_notional_minor: 600000 }),
    NO_USAGE,
    NOW,
  );
  assert.equal(decision.allowed, false);
  assert.match((decision as { reason: string }).reason, /per-symbol position notional/);
});

test("a grant cannot authorize an order in a different environment", async () => {
  const grant = await activeGrant();
  const decision = grantPermits(grant, order({ execution_environment: "provider_live" }), NO_USAGE, NOW);
  assert.equal(decision.allowed, false);
  assert.match((decision as { reason: string }).reason, /environment/);
});

test("revoked, expired and abuse-flagged grants refuse", async () => {
  const grant = await activeGrant();
  for (const state of ["revoked", "suspended", "expired"] as const) {
    assert.equal(grantPermits(validateTradingGrant({ ...grant, state }), order(), NO_USAGE, NOW).allowed, false);
  }
  assert.equal(grantPermits(grant, order(), NO_USAGE, Date.parse("2026-09-23T00:00:00Z")).allowed, false);
  assert.equal(
    grantPermits(validateTradingGrant({ ...grant, abuse_flagged: true }), order(), NO_USAGE, NOW).allowed,
    false,
  );
});

test("a malformed abuse flag is refused, never read as not-abusive", async () => {
  const fixture = await golden();
  const base = vector(fixture, "aether.ats.delegated-trading-grant/1");
  // `raw.abuse_flagged === true` used to turn every one of these into false.
  for (const bad of ["true", 1, null, "yes"]) {
    assert.throws(
      () => validateTradingGrant({ ...base, abuse_flagged: bad }),
      /must be a boolean/,
      `accepted ${JSON.stringify(bad)} as an abuse flag`,
    );
  }
  const missing = { ...base };
  delete missing["abuse_flagged"];
  assert.throws(() => validateTradingGrant(missing), /must be a boolean/);
});

test("daily notional and order counts include the order being checked", async () => {
  const grant = await activeGrant();
  assert.equal(
    grantPermits(grant, order({ worst_case_notional_minor: 100000 }), { ...NO_USAGE, notional_today_minor: 950000 }, NOW)
      .allowed,
    false,
  );
  assert.equal(grantPermits(grant, order(), { ...NO_USAGE, orders_today: 10 }, NOW).allowed, false);
  assert.equal(grantPermits(grant, order(), { ...NO_USAGE, open_orders: 2 }, NOW).allowed, false);
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
  assert.ok(validateOrderIntent({ ...base, order_type: "market", limit_price_minor: null }));
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
  assert.equal(isReviewApprovable(review, NOW).approvable, true);
  assert.equal(isReviewApprovable(review, Date.parse("2026-09-22T14:32:01Z")).approvable, false);
  const refused = validateOrderReview({
    ...vector(fixture, "aether.ats.order-review-receipt/1"),
    risk_verdict: "refuse",
    risk_reason: "daily loss limit reached",
  });
  assert.equal(isReviewApprovable(refused, NOW).approvable, false);
});

// --- The approval chain ------------------------------------------------------

async function chainParts() {
  const fixture = await golden();
  return {
    fixture,
    intent: validateOrderIntent(vector(fixture, "aether.ats.equity-order-intent/1")),
    review: validateOrderReview(vector(fixture, "aether.ats.order-review-receipt/1")),
    approval: validateOperatorApproval(vector(fixture, "aether.ats.operator-approval/1")),
    binding: validateAccountBinding(vector(fixture, "aether.ats.account-binding/1")),
    grant: validateTradingGrant(vector(fixture, "aether.ats.delegated-trading-grant/1")),
  };
}

test("the golden chain is consistent and the commit gate allows it", async () => {
  const { intent, review, approval, binding, grant } = await chainParts();
  assert.equal(verifyApprovalChain(intent, review, approval, NOW).consistent, true);
  assert.equal(
    verifyCommitAuthority({
      now: NOW,
      grant,
      usage: NO_USAGE,
      binding,
      intent,
      review,
      approval,
      resultingPositionNotionalMinor: 232048,
    }).consistent,
    true,
  );
});

test("a forged intent cannot be smuggled past the chain with a matching digest", async () => {
  // The old signature took `intentDigest` from the caller, so an attacker who
  // controlled the intent AND the digest satisfied every comparison. The
  // verifier now derives both digests itself; there is no digest parameter.
  const { fixture, review, approval } = await chainParts();
  const forged = validateOrderIntent({ ...vector(fixture, "aether.ats.equity-order-intent/1"), quantity: 400 });
  const verdict = verifyApprovalChain(forged, review, approval, NOW);
  assert.equal(verdict.consistent, false);
  assert.match((verdict as { reason: string }).reason, /Review does not answer this intent/);
});

test("an approval bound to a different review is refused even when ids line up", async () => {
  const { fixture, intent, approval } = await chainParts();
  // Same review_id, different content — only the recomputed digest catches it.
  const tampered = validateOrderReview({
    ...vector(fixture, "aether.ats.order-review-receipt/1"),
    evidence_age_ms: 6000,
  });
  const verdict = verifyApprovalChain(intent, tampered, approval, NOW);
  assert.equal(verdict.consistent, false);
  assert.match((verdict as { reason: string }).reason, /does not bind this exact review/);
});

/**
 * Every field of the approval, classified. `true` means mutating it MUST break
 * the chain; `false` means the field is recorded but not cross-bound, so a
 * change is expected not to break it. A field missing from this map fails the
 * test — adding one to the contract forces a deliberate decision here rather
 * than silently landing unchecked.
 */
const APPROVAL_MUTATIONS: Record<string, { value: unknown; breaks: boolean; also?: Record<string, unknown> }> = {
  approval_id: { value: "appr_other00001", breaks: false },
  request_id: { value: "req_other00001", breaks: true },
  intent_digest: { value: `sha256:${"f0".repeat(32)}`, breaks: true },
  review_id: { value: "review_other01", breaks: true },
  review_digest: { value: `sha256:${"f1".repeat(32)}`, breaks: true },
  provider_id: { value: "tradier", breaks: true },
  opaque_account_ref: { value: "acct_0000000000ff", breaks: false },
  grant_id: { value: "grant_other0001", breaks: true },
  grant_version: { value: 2, breaks: true },
  policy_version: { value: "ats-aup-2099-01", breaks: false },
  symbol: { value: "QQQ", breaks: true },
  side: { value: "sell", breaks: true },
  quantity: { value: 5, breaks: true },
  order_type: { value: "market", breaks: true, also: { limit_price_minor: null } },
  limit_price_minor: { value: 58013, breaks: true },
  worst_case_notional_minor: { value: 232049, breaks: true },
  reservation_ref: { value: "resv_other0001", breaks: true },
  broker_preview_id: { value: "preview_other1", breaks: true },
  activation_id: { value: "activation_other", breaks: true },
  artifact_id: { value: "artifact_other", breaks: true },
  evidence_digest: { value: `sha256:${"f2".repeat(32)}`, breaks: true },
  operator_id: { value: "operator_other", breaks: false },
  local_device_id: { value: "local_ffffffff", breaks: false },
  operator_session_id: { value: "opsess_ffffffff", breaks: false },
  approved_at: { value: "2026-09-22T14:30:29Z", breaks: false },
  expires_at: { value: "2026-09-22T14:33:30Z", breaks: true },
  consumed_at: { value: "2026-09-22T14:30:40Z", breaks: true },
  // Cannot be mutated to another valid value; the schema tag is pinned.
  schema_version: { value: null, breaks: true },
  connector: { value: null, breaks: true },
};

test("every authority-bearing approval field is classified and behaves as classified", async () => {
  const { fixture, intent, review } = await chainParts();
  const base = vector(fixture, "aether.ats.operator-approval/1");
  const fields = Object.keys(base);

  for (const field of fields) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(APPROVAL_MUTATIONS, field),
      `approval field "${field}" is unclassified — decide whether mutating it must break the chain`,
    );
  }
  for (const field of Object.keys(APPROVAL_MUTATIONS)) {
    assert.ok(fields.includes(field), `APPROVAL_MUTATIONS names "${field}", which is not an approval field`);
  }

  for (const [field, spec] of Object.entries(APPROVAL_MUTATIONS)) {
    if (field === "schema_version") {
      assert.throws(() => validateOperatorApproval({ ...base, schema_version: "aether.ats.operator-approval/2" }));
      continue;
    }
    if (field === "connector") {
      for (const [key, value] of Object.entries({
        provider_id: "tradier",
        account_binding_id: "bind_other000001",
        adapter_id: "tradier_mcp",
        endpoint_schema_digest: `sha256:${"f3".repeat(32)}`,
        execution_environment: "provider_live",
        binding_generation: 2,
      })) {
        const connector = { ...(structuredClone(base["connector"]) as Record<string, unknown>), [key]: value };
        const approval = validateOperatorApproval({ ...base, connector });
        const verdict = verifyApprovalChain(intent, review, approval, NOW);
        assert.equal(verdict.consistent, false, `connector.${key} did not break the chain`);
      }
      continue;
    }
    const approval = validateOperatorApproval({ ...base, [field]: spec.value, ...(spec.also ?? {}) });
    const verdict = verifyApprovalChain(intent, review, approval, NOW);
    assert.equal(verdict.consistent, !spec.breaks, `mutating ${field}: expected breaks=${spec.breaks}`);
  }
});

test("two different accounts both at generation 1 cannot be confused", async () => {
  // binding_generation alone could not tell these apart; account_binding_id can.
  const { fixture, intent, review, approval, grant } = await chainParts();
  const other = validateAccountBinding({
    ...vector(fixture, "aether.ats.account-binding/1"),
    account_binding_id: "bind_rh_second01",
    opaque_account_ref: "acct_1111222233ab",
    encrypted_account_ref: "enc_rh_acct_0002",
    masked_label: "Agentic ****77",
  });
  assert.equal(other.binding_generation, 1);

  const verdict = verifyCommitAuthority({
    now: NOW,
    grant,
    usage: NO_USAGE,
    binding: other,
    intent,
    review,
    approval,
    resultingPositionNotionalMinor: 232048,
  });
  assert.equal(verdict.consistent, false);
  assert.match((verdict as { reason: string }).reason, /different account binding/);
});

test("a refused review, expired review or spent approval fails the chain itself", async () => {
  const { fixture, intent, approval } = await chainParts();
  const refused = validateOrderReview({
    ...vector(fixture, "aether.ats.order-review-receipt/1"),
    risk_verdict: "refuse",
    risk_reason: "daily loss limit reached",
  });
  assert.equal(verifyApprovalChain(intent, refused, approval, NOW).consistent, false);

  const { review } = await chainParts();
  assert.equal(verifyApprovalChain(intent, review, approval, Date.parse("2026-09-22T14:33:01Z")).consistent, false);

  const spent = validateOperatorApproval({
    ...vector(fixture, "aether.ats.operator-approval/1"),
    consumed_at: "2026-09-22T14:30:40Z",
  });
  const verdict = verifyApprovalChain(intent, review, spent, NOW);
  assert.equal(verdict.consistent, false);
  assert.match((verdict as { reason: string }).reason, /already used/);
});

test("the commit gate re-checks kill and pause after review", async () => {
  const { fixture, intent, approval, binding, grant } = await chainParts();
  for (const [mode, pattern] of [
    ["emergency_locked", /halted/],
    ["orders_paused", /halted/],
    ["observe", /does not permit submission/],
  ] as const) {
    const review = validateOrderReview({
      ...vector(fixture, "aether.ats.order-review-receipt/1"),
      execution_state: {
        schema_version: "aether.ats.execution-state/1",
        requested_mode: "paper",
        effective_mode: mode,
        effective_reason: "operator halt",
      },
    });
    // The approval binds the review digest, so re-mint it for this review.
    const minted = validateOperatorApproval({
      ...vector(fixture, "aether.ats.operator-approval/1"),
      review_digest: digestOf(review),
    });
    const verdict = verifyCommitAuthority({
      now: NOW,
      grant,
      usage: NO_USAGE,
      binding,
      intent,
      review,
      approval: minted,
      resultingPositionNotionalMinor: 232048,
    });
    assert.equal(verdict.consistent, false, `${mode} reached commit`);
    assert.match((verdict as { reason: string }).reason, pattern);
  }
  void approval;
});

test("the commit gate refuses a grant for another account, provider or environment", async () => {
  const { intent, review, approval, binding, grant } = await chainParts();
  const commit = (g: DelegatedTradingGrantV1) =>
    verifyCommitAuthority({
      now: NOW,
      grant: g,
      usage: NO_USAGE,
      binding,
      intent,
      review,
      approval,
      resultingPositionNotionalMinor: 232048,
    });

  assert.match(
    (commit(validateTradingGrant({ ...grant, opaque_account_ref: "acct_1111222233ab" })) as { reason: string }).reason,
    /different account/,
  );
  assert.match(
    (commit(validateTradingGrant({ ...grant, provider_id: "tradier" })) as { reason: string }).reason,
    /different provider/,
  );
  assert.equal(commit(validateTradingGrant({ ...grant, grant_version: 2 })).consistent, false);
});

test("the commit gate enforces the grant limits at commit time", async () => {
  const { intent, review, approval, binding, grant } = await chainParts();
  const verdict = verifyCommitAuthority({
    now: NOW,
    grant,
    usage: NO_USAGE,
    binding,
    intent,
    review,
    approval,
    resultingPositionNotionalMinor: 900000,
  });
  assert.equal(verdict.consistent, false);
  assert.match((verdict as { reason: string }).reason, /per-symbol position notional/);
});

test("an approval is single use and time bound", async () => {
  const { fixture, approval } = await chainParts();
  assert.equal(isApprovalUsable(approval, NOW).usable, true);
  assert.equal(isApprovalUsable(approval, Date.parse("2026-09-22T14:32:01Z")).usable, false);
  const consumed = validateOperatorApproval({
    ...vector(fixture, "aether.ats.operator-approval/1"),
    consumed_at: "2026-09-22T14:30:45Z",
  });
  assert.match((isApprovalUsable(consumed, NOW) as { reason: string }).reason, /already used/);
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
  const ambiguous = {
    ...vector(fixture, "aether.ats.execution-receipt/1"),
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
    // Strip comments first: the prose deliberately discusses sockets,
    // credentials and files, and matching on that would be a false positive.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    for (const forbidden of ["node:fs", "node:net", "node:http", "node:child_process", "fetch(", "process.env"]) {
      assert.ok(!code.includes(forbidden), `a contract module reached for ${forbidden}`);
    }
  }
});
