import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ATS_CANONICAL_PROFILE,
  ATS_SPEC1_SCHEMAS,
  ATS_SPEC1_V2_SCHEMAS,
  EXECUTABLE_CHAIN_REFUSAL,
  canonicalJson,
  digestOf,
  validateAccountBinding,
  validateAccountBindingV2,
  validateExecutionReceipt,
  validateExecutionReceiptV2,
  validateGrantUsage,
  validateModelOrderProposal,
  validateModelOrderProposalV2,
  validateOperatorApproval,
  validateOperatorApprovalV2,
  validateOrderIntent,
  validateOrderIntentV2,
  validateOrderReview,
  validateTradingGrant,
  validateTradingGrantV2,
  verifyApprovalChain,
  verifyCommitAuthority,
  verifyExecutableApprovalChain,
  verifyExecutableCommitAuthority,
  type ChainVerdict,
  type CommitAuthorityRequest,
  type ExecutableCommitAuthorityRequest,
  type NormalizedEquityOrderIntentV1,
  type OperatorApprovalReceiptV1,
} from "../src/core/ats_contracts/index.js";

// The Spec 1 /2 closure fixture, shared with the Python mirror
// (test/fixtures/ats_contracts_v2_verify.py) and, by copy, with ATSv2. Every
// message is compared exactly, so a vector proves it failed for its STATED
// reason in both languages rather than for whatever check fired first.

const FIXTURE_PATH = "test/fixtures/ats_contracts_v2_golden.json";

interface Patch { readonly path: readonly string[]; readonly value: unknown }
interface Vector { readonly schema_version: string; readonly document: Record<string, unknown>; readonly canonical: string; readonly canonical_digest: string }
interface Accept { readonly name: string; readonly schema_version: string; readonly patches: readonly Patch[] }
interface Reject {
  readonly name: string;
  readonly category: "ticker" | "label" | "schema_tag";
  readonly case: string;
  readonly schema_version: string;
  readonly patches: readonly Patch[];
  readonly expect: string;
  readonly v1_schema_version?: string;
  readonly v1_expect?: string;
}
interface Frozen extends Reject { readonly v1_schema_version: string }
interface ChainCase {
  readonly name: string;
  readonly case: string;
  readonly members: { readonly intent: string; readonly review: string; readonly approval: string; readonly binding: string; readonly grant: string };
  readonly approval_chain_expect: string | null;
  readonly commit_expect: string | null;
}
interface Fixture {
  readonly schema_version: string;
  readonly canonical_profile: string;
  readonly vectors: readonly Vector[];
  readonly accepts: readonly Accept[];
  readonly rejects: readonly Reject[];
  readonly frozen_weakness: readonly Frozen[];
  readonly chains: {
    readonly now: string;
    readonly usage: unknown;
    readonly resulting_position_notional_minor: number;
    readonly documents: Readonly<Record<string, { readonly document: Record<string, unknown>; readonly canonical_digest: string }>>;
    readonly cases: readonly ChainCase[];
  };
}

type Validate = (value: unknown) => unknown;

const V2_VALIDATORS: Readonly<Record<string, Validate>> = {
  "aether.ats.model-order-proposal/2": (value) => validateModelOrderProposalV2(value),
  "aether.ats.equity-order-intent/2": (value) => validateOrderIntentV2(value),
  "aether.ats.operator-approval/2": (value) => validateOperatorApprovalV2(value),
  "aether.ats.execution-receipt/2": (value) => validateExecutionReceiptV2(value),
  "aether.ats.delegated-trading-grant/2": (value) => validateTradingGrantV2(value),
  "aether.ats.account-binding/2": (value) => validateAccountBindingV2(value),
};

const V1_VALIDATORS: Readonly<Record<string, Validate>> = {
  "aether.ats.model-order-proposal/1": (value) => validateModelOrderProposal(value),
  "aether.ats.equity-order-intent/1": (value) => validateOrderIntent(value),
  "aether.ats.operator-approval/1": (value) => validateOperatorApproval(value),
  "aether.ats.execution-receipt/1": (value) => validateExecutionReceipt(value),
  "aether.ats.delegated-trading-grant/1": (value) => validateTradingGrant(value),
  "aether.ats.account-binding/1": (value) => validateAccountBinding(value),
  "aether.ats.order-review-receipt/1": (value) => validateOrderReview(value),
};

/** The /1 tag of each /2 schema. The review receipt deliberately has no /2 (docs/CONTRACTS.md, "Spec 1 /2 closure"). */
const V1_OF: Readonly<Record<string, string>> = {
  "aether.ats.model-order-proposal/2": "aether.ats.model-order-proposal/1",
  "aether.ats.equity-order-intent/2": "aether.ats.equity-order-intent/1",
  "aether.ats.operator-approval/2": "aether.ats.operator-approval/1",
  "aether.ats.execution-receipt/2": "aether.ats.execution-receipt/1",
  "aether.ats.delegated-trading-grant/2": "aether.ats.delegated-trading-grant/1",
  "aether.ats.account-binding/2": "aether.ats.account-binding/1",
};

// Coverage floors are named constants equal to the coverage that exists, never
// counts derived from the fixture they guard.
const TICKER_SCHEMAS = [
  "aether.ats.model-order-proposal/2",
  "aether.ats.equity-order-intent/2",
  "aether.ats.operator-approval/2",
  "aether.ats.execution-receipt/2",
  "aether.ats.delegated-trading-grant/2",
] as const;
const LABEL_SCHEMAS = ["aether.ats.account-binding/2"] as const;
const FROZEN_TICKER_CASES = ["HTTPS://X", "A:B", "X/Y", "ABCDEFG", "BRK.BBBBB", "A^B", "1ABC"] as const;
const REJECTED_TICKER_CASES = ["spy"] as const;
const FROZEN_LABEL_CASES = [
  "fullwidth_digits", "arabic_indic_digits", "cyrillic_confusable",
  "right_to_left_override", "zero_width_space", "byte_order_mark",
] as const;
const REJECTED_LABEL_CASES = ["five_ascii_digits"] as const;
const CHAIN_CASES = ["all_v2", "intent_v1", "approval_v1", "binding_v1", "grant_v1", "all_v1"] as const;
const MIN_ACCEPTS = 8;

async function loadFixture(): Promise<Fixture> {
  return JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as Fixture;
}

function validatorFor(table: Readonly<Record<string, Validate>>, tag: string): Validate {
  const validate = table[tag];
  assert.ok(validate, `no validator wired for ${tag}`);
  return validate;
}

function baseOf(fixture: Fixture, tag: string): Record<string, unknown> {
  const found = fixture.vectors.find((entry) => entry.schema_version === tag);
  assert.ok(found, `fixture has no canonical vector for ${tag}`);
  return structuredClone(found.document);
}

/** `defineProperty` so a patched key becomes an own property exactly as JSON.parse would make it. */
function applyPatches(document: Record<string, unknown>, patches: readonly Patch[]): Record<string, unknown> {
  assert.ok(patches.length > 0, "a vector must change something");
  const copy = structuredClone(document);
  for (const patch of patches) {
    let cursor: Record<string, unknown> = copy;
    for (const key of patch.path.slice(0, -1)) {
      const next = cursor[key];
      assert.ok(next && typeof next === "object", `patch path ${patch.path.join(".")} is not an object path`);
      cursor = next as Record<string, unknown>;
    }
    const leaf = patch.path[patch.path.length - 1]!;
    Object.defineProperty(cursor, leaf, { value: structuredClone(patch.value), enumerable: true, writable: true, configurable: true });
  }
  return copy;
}

function retag(document: Record<string, unknown>, tag: string): Record<string, unknown> {
  return { ...structuredClone(document), schema_version: tag };
}

function messageOf(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function reasonOf(verdict: ChainVerdict): string | null {
  return verdict.consistent ? null : verdict.reason;
}

// --- Shape of the fixture ------------------------------------------------------

test("the /2 fixture pins its format, its profile and exactly the /2 schema list", async () => {
  const fixture = await loadFixture();
  assert.equal(fixture.schema_version, "aether.ats.spec1-v2-golden/1");
  assert.equal(fixture.canonical_profile, ATS_CANONICAL_PROFILE);
  assert.deepEqual([...ATS_SPEC1_V2_SCHEMAS].sort(), Object.keys(V2_VALIDATORS).sort());
  assert.deepEqual(
    fixture.vectors.map((entry) => entry.schema_version).sort(),
    [...ATS_SPEC1_V2_SCHEMAS].sort(),
    "fixture vectors and ATS_SPEC1_V2_SCHEMAS disagree about which /2 schemas exist",
  );
  // The /1 freeze is untouched: same eight tags, and the review receipt has no /2.
  assert.equal(ATS_SPEC1_SCHEMAS.length, 8);
  assert.ok(ATS_SPEC1_SCHEMAS.includes("aether.ats.order-review-receipt/1"));
  assert.ok(!(ATS_SPEC1_V2_SCHEMAS as readonly string[]).includes("aether.ats.order-review-receipt/2"));
});

test("the /2 fixture file is pure ASCII", async () => {
  const bytes = await readFile(FIXTURE_PATH);
  const high = bytes.findIndex((byte) => byte > 126);
  assert.equal(high, -1, `byte above 126 at offset ${high}`);
});

test("every coverage category is present", async () => {
  const fixture = await loadFixture();
  const missing: string[] = [];
  const has = (list: readonly Reject[], tag: string, category: string, value: string) =>
    list.some((entry) => entry.schema_version === tag && entry.category === category && entry.case === value);
  for (const tag of TICKER_SCHEMAS) {
    for (const value of FROZEN_TICKER_CASES) if (!has(fixture.frozen_weakness, tag, "ticker", value)) missing.push(`${tag} frozen ticker ${value}`);
    for (const value of REJECTED_TICKER_CASES) if (!has(fixture.rejects, tag, "ticker", value)) missing.push(`${tag} ticker reject ${value}`);
  }
  for (const tag of LABEL_SCHEMAS) {
    for (const value of FROZEN_LABEL_CASES) if (!has(fixture.frozen_weakness, tag, "label", value)) missing.push(`${tag} frozen label ${value}`);
    for (const value of REJECTED_LABEL_CASES) if (!has(fixture.rejects, tag, "label", value)) missing.push(`${tag} label reject ${value}`);
  }
  for (const tag of ATS_SPEC1_V2_SCHEMAS) if (!has(fixture.rejects, tag, "schema_tag", "v1_tag")) missing.push(`${tag} /1 tag reject`);
  for (const value of CHAIN_CASES) if (!fixture.chains.cases.some((entry) => entry.case === value)) missing.push(`chain case ${value}`);
  if (fixture.accepts.length < MIN_ACCEPTS) missing.push(`accepts fell to ${fixture.accepts.length}`);
  assert.deepEqual(missing, []);
});

// --- Accepted documents ---------------------------------------------------------

test("every /2 vector validates and reproduces its canonical bytes and digest", async () => {
  const fixture = await loadFixture();
  const problems: string[] = [];
  for (const entry of fixture.vectors) {
    const message = messageOf(() => validatorFor(V2_VALIDATORS, entry.schema_version)(entry.document));
    if (message !== null) {
      problems.push(`${entry.schema_version}: refused its canonical vector: ${message}`);
      continue;
    }
    const parsed = validatorFor(V2_VALIDATORS, entry.schema_version)(entry.document);
    if (canonicalJson(parsed) !== entry.canonical) problems.push(`${entry.schema_version}: canonical bytes drifted`);
    if (digestOf(parsed) !== entry.canonical_digest) problems.push(`${entry.schema_version}: digest drifted`);
  }
  assert.deepEqual(problems, []);
});

test("/2 only narrows /1: each /2 vector retagged /1 is accepted by /1 unchanged, and each version refuses the other's tag", async () => {
  const fixture = await loadFixture();
  const problems: string[] = [];
  for (const entry of fixture.vectors) {
    const v1Tag = V1_OF[entry.schema_version]!;
    const asV1 = retag(entry.document, v1Tag);
    const message = messageOf(() => validatorFor(V1_VALIDATORS, v1Tag)(asV1));
    if (message !== null) problems.push(`${v1Tag}: refused a /2-valid document: ${message}`);
    else if (canonicalJson(validatorFor(V1_VALIDATORS, v1Tag)(asV1)) !== canonicalJson(asV1)) problems.push(`${v1Tag}: changed a value`);
    const reverse = messageOf(() => validatorFor(V1_VALIDATORS, v1Tag)(entry.document));
    if (reverse === null || !reverse.endsWith(`must declare schema ${v1Tag}.`)) problems.push(`${v1Tag}: accepted a /2 tag: ${reverse}`);
  }
  assert.deepEqual(problems, []);
});

test("every strict variant stays accepted by /2 and by /1", async () => {
  const fixture = await loadFixture();
  const problems: string[] = [];
  for (const entry of fixture.accepts) {
    const document = applyPatches(baseOf(fixture, entry.schema_version), entry.patches);
    const strict = messageOf(() => validatorFor(V2_VALIDATORS, entry.schema_version)(document));
    if (strict !== null) problems.push(`${entry.name}: /2 refused: ${strict}`);
    const v1Tag = V1_OF[entry.schema_version]!;
    const frozen = messageOf(() => validatorFor(V1_VALIDATORS, v1Tag)(retag(document, v1Tag)));
    if (frozen !== null) problems.push(`${entry.name}: /1 refused: ${frozen}`);
  }
  assert.deepEqual(problems, []);
});

// --- Refusals ---------------------------------------------------------------------

test("every /2 reject fails for its stated reason, and /1 refuses it too where it has the same check", async () => {
  const fixture = await loadFixture();
  const problems: string[] = [];
  for (const entry of fixture.rejects) {
    const base = baseOf(fixture, entry.schema_version);
    const validate = validatorFor(V2_VALIDATORS, entry.schema_version);
    if (messageOf(() => validate(base)) !== null) problems.push(`${entry.name}: control document refused`);
    const message = messageOf(() => validate(applyPatches(base, entry.patches)));
    if (message !== entry.expect) problems.push(`${entry.name}: expected ${JSON.stringify(entry.expect)}, got ${JSON.stringify(message)}`);
    if (entry.category === "schema_tag") continue;
    if (entry.v1_schema_version === undefined || entry.v1_expect === undefined) {
      problems.push(`${entry.name}: a ticker or label reject must state the /1 outcome`);
      continue;
    }
    const v1Tag = entry.v1_schema_version;
    const v1Message = messageOf(() => validatorFor(V1_VALIDATORS, v1Tag)(applyPatches(retag(base, v1Tag), entry.patches)));
    if (v1Message !== entry.v1_expect) problems.push(`${entry.name}: /1 expected ${JSON.stringify(entry.v1_expect)}, got ${JSON.stringify(v1Message)}`);
  }
  assert.deepEqual(problems, []);
});

test("every frozen /1 weakness is accepted by /1 and refused by /2 for its stated reason", async () => {
  const fixture = await loadFixture();
  const problems: string[] = [];
  for (const entry of fixture.frozen_weakness) {
    const base = baseOf(fixture, entry.schema_version);
    const message = messageOf(() => validatorFor(V2_VALIDATORS, entry.schema_version)(applyPatches(base, entry.patches)));
    if (message !== entry.expect) problems.push(`${entry.name}: /2 expected ${JSON.stringify(entry.expect)}, got ${JSON.stringify(message)}`);
    const v1Document = applyPatches(retag(base, entry.v1_schema_version), entry.patches);
    const v1Message = messageOf(() => validatorFor(V1_VALIDATORS, entry.v1_schema_version)(v1Document));
    if (v1Message !== null) problems.push(`${entry.name}: /1 no longer accepts it (${v1Message}); the /1 freeze changed`);
  }
  assert.deepEqual(problems, []);
});

// --- The executable chain gate ---------------------------------------------------

interface Members {
  readonly intent: ExecutableCommitAuthorityRequest["intent"];
  readonly review: ExecutableCommitAuthorityRequest["review"];
  readonly approval: ExecutableCommitAuthorityRequest["approval"];
  readonly binding: ExecutableCommitAuthorityRequest["binding"];
  readonly grant: ExecutableCommitAuthorityRequest["grant"];
}

function atOwnVersion(document: Record<string, unknown>): unknown {
  const tag = String(document["schema_version"]);
  return validatorFor({ ...V1_VALIDATORS, ...V2_VALIDATORS }, tag)(document);
}

function membersOf(fixture: Fixture, chain: ChainCase): Members {
  const load = (key: string) => {
    const entry = fixture.chains.documents[key];
    assert.ok(entry, `${chain.name}: missing chain document ${key}`);
    return atOwnVersion(entry.document);
  };
  return {
    intent: load(chain.members.intent) as Members["intent"],
    review: load(chain.members.review) as Members["review"],
    approval: load(chain.members.approval) as Members["approval"],
    binding: load(chain.members.binding) as Members["binding"],
    grant: load(chain.members.grant) as Members["grant"],
  };
}

function requestOf(fixture: Fixture, members: Members): ExecutableCommitAuthorityRequest {
  return {
    now: Date.parse(fixture.chains.now),
    usage: validateGrantUsage(fixture.chains.usage),
    resultingPositionNotionalMinor: fixture.chains.resulting_position_notional_minor,
    ...members,
  };
}

/** The version-blind /1 gates. They never read a schema tag, so they are the control for every chain case. */
function versionBlind(request: ExecutableCommitAuthorityRequest): { chain: string | null; commit: string | null } {
  const intent = request.intent as NormalizedEquityOrderIntentV1;
  const approval = request.approval as OperatorApprovalReceiptV1;
  return {
    chain: reasonOf(verifyApprovalChain(intent, request.review, approval, request.now)),
    commit: reasonOf(verifyCommitAuthority(request as unknown as CommitAuthorityRequest)),
  };
}

test("the fixed refusal is the one the fixture pins", async () => {
  const fixture = await loadFixture();
  for (const chain of fixture.chains.cases) {
    for (const expected of [chain.approval_chain_expect, chain.commit_expect]) {
      if (expected !== null) assert.equal(expected, EXECUTABLE_CHAIN_REFUSAL, chain.name);
    }
  }
});

test("chain documents validate at their own version and reproduce their digests", async () => {
  const fixture = await loadFixture();
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(fixture.chains.documents)) {
    const message = messageOf(() => atOwnVersion(entry.document));
    if (message !== null) problems.push(`${key}: refused: ${message}`);
    else if (digestOf(atOwnVersion(entry.document)) !== entry.canonical_digest) problems.push(`${key}: digest drifted`);
  }
  assert.deepEqual(problems, []);
});

test("the executable gates accept only the all-/2 chain, and every other case fails solely on its version", async () => {
  const fixture = await loadFixture();
  const problems: string[] = [];
  for (const chain of fixture.chains.cases) {
    const request = requestOf(fixture, membersOf(fixture, chain));
    // Single-cause control: the version-blind gates accept every case, so the
    // version rule is the only thing left that can refuse it.
    const blind = versionBlind(request);
    if (blind.chain !== null || blind.commit !== null) {
      problems.push(`${chain.name}: not single-cause; the version-blind gates refuse it: ${blind.chain ?? blind.commit}`);
    }
    const chainReason = reasonOf(verifyExecutableApprovalChain(request.intent, request.review, request.approval, request.now));
    if (chainReason !== chain.approval_chain_expect) {
      problems.push(`${chain.name}: approval chain expected ${JSON.stringify(chain.approval_chain_expect)}, got ${JSON.stringify(chainReason)}`);
    }
    const commitReason = reasonOf(verifyExecutableCommitAuthority(request));
    if (commitReason !== chain.commit_expect) {
      problems.push(`${chain.name}: commit expected ${JSON.stringify(chain.commit_expect)}, got ${JSON.stringify(commitReason)}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("beyond the version rule the executable gate has exactly the /1 gate's semantics", async () => {
  const fixture = await loadFixture();
  const faithful = fixture.chains.cases.find((entry) => entry.case === "all_v2");
  assert.ok(faithful);
  const request = requestOf(fixture, membersOf(fixture, faithful));
  const spent = validateOperatorApprovalV2({
    ...fixture.chains.documents[faithful.members.approval]!.document,
    consumed_at: "2026-09-22T14:30:40Z",
  });
  const variants: ReadonlyArray<[string, ExecutableCommitAuthorityRequest]> = [
    ["position cap exceeded", { ...request, resultingPositionNotionalMinor: 900_000 }],
    ["approval already spent", { ...request, approval: spent }],
    ["intent expired", { ...request, now: Date.parse("2026-09-22T14:33:01Z") }],
    ["daily orders exhausted", { ...request, usage: validateGrantUsage({ notional_today_minor: 0, orders_today: 10, open_orders: 0 }) }],
  ];
  for (const [label, variant] of variants) {
    const executable = reasonOf(verifyExecutableCommitAuthority(variant));
    assert.notEqual(executable, null, `${label}: the executable gate accepted it`);
    assert.equal(executable, versionBlind(variant).commit, `${label}: the gates disagree`);
  }
});
