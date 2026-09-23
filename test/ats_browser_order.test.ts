import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  AGENT_BROWSER_ATS_ORDER_PROTOCOL,
  ATS_CANONICAL_PROFILE,
  BROWSER_ORDER_CALL_SCHEMA,
  BROWSER_ORDER_OPERATIONS,
  adapterPinsEqual,
  deriveBrowserBindingState,
  digestOf,
  requiresReconciliation,
  validateBrowserOrderCall,
  validateBrowserOrderResult,
  verifyBrowserResult,
  type BrowserAdapterPin,
} from "../src/core/ats_contracts/index.js";

// The golden fixture is shared with the Python mirror
// (test/fixtures/ats_browser_order_verify.py) and, by copy, with ATSv2. Every
// vector below is data both languages must agree on; the TypeScript and Python
// validators use identical refusal messages so a reject is proven to fail for
// its STATED reason, not merely to fail.

interface Patch { readonly path: readonly string[]; readonly value?: unknown; readonly delete?: true }
interface Exchange {
  readonly name: string;
  readonly call: Record<string, unknown>;
  readonly call_digest: string;
  readonly result: Record<string, unknown>;
  readonly result_digest: string;
  readonly expect: { readonly binding_state: string | null; readonly requires_reconciliation: boolean };
}
interface Reject { readonly name: string; readonly category: string; readonly exchange: string; readonly patches: readonly Patch[]; readonly expect: string }
interface Mismatch extends Reject { readonly target: "call" | "result" }
interface Fixture {
  readonly schema_version: string;
  readonly protocol: string;
  readonly canonical_profile: string;
  readonly adapter_registry: readonly BrowserAdapterPin[];
  readonly exchanges: readonly Exchange[];
  readonly call_rejects: readonly Reject[];
  readonly result_rejects: readonly Reject[];
  readonly mismatches: readonly Mismatch[];
}

const FIXTURE_PATH = "test/fixtures/ats_browser_order_golden.json";

// Coverage floors are named constants equal to the coverage that exists, not
// counts derived from the fixture: a floor derived from the list it guards
// lowers itself as the list shrinks.
const REQUIRED_CALL_REJECT_CATEGORIES = [
  "unknown_operation", "selector", "coordinate", "url", "script", "free_text",
  "authority_injection", "identity", "binding", "environment", "deadline",
  "money", "quantity", "shape",
] as const;
const REQUIRED_RESULT_REJECT_CATEGORIES = [
  "status", "page_content", "account_number", "origin", "session", "ticket_digest",
  "fill_claim", "order_state", "quote", "positions", "shape",
] as const;
const REQUIRED_MISMATCH_CATEGORIES = [
  "adapter_digest", "adapter_version", "call_identity", "session_generation",
  "principal", "binding", "ticket_field", "symbol", "order_ref", "deadline",
  "replay",
] as const;
const MIN_EXCHANGES_PER_OPERATION = 1;

async function loadFixture(): Promise<Fixture> {
  return JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as Fixture;
}

function exchangeNamed(fixture: Fixture, name: string): Exchange {
  const exchange = fixture.exchanges.find((entry) => entry.name === name);
  assert.ok(exchange, `fixture vector refers to missing exchange ${name}`);
  return exchange;
}

/**
 * Apply patches to a deep copy. `defineProperty` rather than assignment so a
 * `__proto__` key becomes an own property, exactly as JSON.parse would create
 * it, instead of silently replacing the prototype.
 */
function applyPatches(document: Record<string, unknown>, patches: readonly Patch[]): Record<string, unknown> {
  assert.ok(patches.length > 0, "a vector must change something");
  const copy = structuredClone(document);
  for (const patch of patches) applyOne(copy, patch);
  return copy;
}

function applyOne(copy: Record<string, unknown>, patch: Patch): void {
  let cursor: Record<string, unknown> = copy;
  for (const key of patch.path.slice(0, -1)) {
    const next = cursor[key];
    assert.ok(next && typeof next === "object", `patch path ${patch.path.join(".")} is not an object path`);
    cursor = next as Record<string, unknown>;
  }
  const leaf = patch.path[patch.path.length - 1]!;
  if (patch.delete) {
    assert.ok(Object.hasOwn(cursor, leaf), `patch deletes absent ${patch.path.join(".")}`);
    delete cursor[leaf];
  } else {
    Object.defineProperty(cursor, leaf, { value: structuredClone(patch.value), enumerable: true, writable: true, configurable: true });
  }
}

function messageOf(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test("the browser order fixture pins its protocol and canonical profile", async () => {
  const fixture = await loadFixture();
  assert.equal(fixture.schema_version, "aether.ats.browser-order-golden/1");
  assert.equal(fixture.protocol, AGENT_BROWSER_ATS_ORDER_PROTOCOL);
  assert.equal(fixture.canonical_profile, ATS_CANONICAL_PROFILE);
});

// Each vector test collects every problem before asserting, so a broken guard
// names ALL the vectors it blinds, not just the first one the loop reaches.

test("every exchange validates, reproduces its digests and answers its own call", async () => {
  const fixture = await loadFixture();
  const problems: string[] = [];
  for (const exchange of fixture.exchanges) {
    let call: ReturnType<typeof validateBrowserOrderCall>;
    let result: ReturnType<typeof validateBrowserOrderResult>;
    try {
      call = validateBrowserOrderCall(exchange.call);
      result = validateBrowserOrderResult(exchange.result);
    } catch (error) {
      problems.push(`${exchange.name}: refused a faithful exchange: ${(error as Error).message}`);
      continue;
    }
    if (digestOf(call) !== exchange.call_digest) problems.push(`${exchange.name}: call digest drifted`);
    if (digestOf(result) !== exchange.result_digest) problems.push(`${exchange.name}: result digest drifted`);
    if (!fixture.adapter_registry.some((pin) => adapterPinsEqual(pin, call.adapter))) {
      problems.push(`${exchange.name}: call names an adapter outside the qualified registry`);
    }
    const verdict = verifyBrowserResult(call, result);
    if (!verdict.answers) problems.push(`${exchange.name}: gate refused a faithful answer: ${verdict.reason}`);
    const state = result.operation === "verify_session" && result.status === "ok" && result.data !== null
      ? deriveBrowserBindingState(result.data)
      : null;
    if (state !== exchange.expect.binding_state) problems.push(`${exchange.name}: binding state ${String(state)}`);
    if (requiresReconciliation(result) !== exchange.expect.requires_reconciliation) problems.push(`${exchange.name}: reconciliation`);
  }
  assert.deepEqual(problems, []);
});

test("every operation has a faithful exchange", async () => {
  const fixture = await loadFixture();
  const missing = BROWSER_ORDER_OPERATIONS.filter(
    (operation) => fixture.exchanges.filter((entry) => entry.call["operation"] === operation).length < MIN_EXCHANGES_PER_OPERATION,
  );
  assert.deepEqual(missing, [], "operations without a faithful exchange");
});

function rejectProblems(
  label: "call" | "result",
  required: readonly string[],
  vectors: readonly Reject[],
  base: (reject: Reject) => Record<string, unknown>,
  validate: (value: unknown) => unknown,
): string[] {
  const problems = required
    .filter((category) => !vectors.some((entry) => entry.category === category))
    .map((category) => `no ${label} reject covers ${category}`);
  for (const reject of vectors) {
    const document = base(reject);
    if (messageOf(() => validate(document)) !== null) problems.push(`${reject.name}: control ${label} must validate`);
    const message = messageOf(() => validate(applyPatches(document, reject.patches)));
    if (message === null) problems.push(`${reject.name}: patched ${label} was accepted`);
    else if (!message.includes(reject.expect)) problems.push(`${reject.name}: refused for another reason: ${message}`);
  }
  return problems;
}

test("every call reject fails validation for its stated reason", async () => {
  const fixture = await loadFixture();
  const problems = rejectProblems("call", REQUIRED_CALL_REJECT_CATEGORIES, fixture.call_rejects,
    (reject) => exchangeNamed(fixture, reject.exchange).call, validateBrowserOrderCall);
  assert.deepEqual(problems, []);
});

test("every result reject fails validation for its stated reason", async () => {
  const fixture = await loadFixture();
  const problems = rejectProblems("result", REQUIRED_RESULT_REJECT_CATEGORIES, fixture.result_rejects,
    (reject) => exchangeNamed(fixture, reject.exchange).result, validateBrowserOrderResult);
  assert.deepEqual(problems, []);
});

test("every mismatch is well-formed but refused by the result gate for its stated reason", async () => {
  const fixture = await loadFixture();
  const problems = REQUIRED_MISMATCH_CATEGORIES
    .filter((category) => !fixture.mismatches.some((entry) => entry.category === category))
    .map((category) => `no mismatch covers ${category}`);
  for (const mismatch of fixture.mismatches) {
    const exchange = exchangeNamed(fixture, mismatch.exchange);
    const rawCall = mismatch.target === "call" ? applyPatches(exchange.call, mismatch.patches) : exchange.call;
    const rawResult = mismatch.target === "result" ? applyPatches(exchange.result, mismatch.patches) : exchange.result;
    // Both documents must still parse: the refusal has to come from the gate,
    // or the vector proves the shape check twice and the gate never.
    let verdict: ReturnType<typeof verifyBrowserResult>;
    try {
      verdict = verifyBrowserResult(validateBrowserOrderCall(rawCall), validateBrowserOrderResult(rawResult));
    } catch (error) {
      problems.push(`${mismatch.name}: refused by shape, not by the gate: ${(error as Error).message}`);
      continue;
    }
    if (verdict.answers) problems.push(`${mismatch.name}: gate accepted a mismatched answer`);
    else if (!verdict.reason.includes(mismatch.expect)) problems.push(`${mismatch.name}: refused for another reason: ${verdict.reason}`);
  }
  assert.deepEqual(problems, []);
});

test("a changed adapter digest never equals the qualified pin", async () => {
  const fixture = await loadFixture();
  const pin = fixture.adapter_registry[0]!;
  assert.equal(adapterPinsEqual(pin, { ...pin }), true);
  assert.equal(adapterPinsEqual(pin, { ...pin, adapter_digest: `sha256:${"0".repeat(64)}` }), false);
  assert.equal(adapterPinsEqual(pin, { ...pin, adapter_version: "0.0.0-changed" }), false);
  assert.equal(adapterPinsEqual(pin, { ...pin, adapter_id: "site.other-broker" }), false);
});

test("no valid call can carry a URL, script or free-text string", async () => {
  // Every string a caller can send is a bounded identifier-shaped token or a
  // digest: no whitespace, slash, quote, angle bracket or parenthesis. Closed
  // field lists stop a selector-shaped identifier from having anywhere to go.
  const BOUNDED_TOKEN = /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}|sha256:[0-9a-f]{64})$/;
  const fixture = await loadFixture();
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") assert.match(value, BOUNDED_TOKEN, `free-form string at ${path}`);
    else if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
    else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`);
  };
  for (const exchange of fixture.exchanges) {
    // The schema tag is the one slash-bearing string, and it is pinned to a
    // single literal rather than chosen by the caller.
    const { schema_version: tag, ...rest } = validateBrowserOrderCall(exchange.call);
    assert.equal(tag, BROWSER_ORDER_CALL_SCHEMA);
    walk(rest, exchange.name);
  }
});

test("every ATS contract module performs no I/O and holds no credential", async () => {
  // Scans the whole directory, so a new module is covered the day it lands
  // instead of waiting for someone to extend a hand-written list.
  const directory = "src/core/ats_contracts";
  const modules = (await readdir(directory)).filter((name) => name.endsWith(".ts"));
  assert.ok(modules.includes("browser_order.ts"), "browser order module missing from the scan");
  for (const name of modules) {
    const source = await readFile(`${directory}/${name}`, "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    for (const forbidden of ["node:fs", "node:net", "node:http", "node:child_process", "fetch(", "process.env"]) {
      assert.ok(!code.includes(forbidden), `${name} reached for ${forbidden}`);
    }
  }
});
