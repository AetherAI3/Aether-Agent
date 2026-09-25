import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ATS_CANONICAL_PROFILE, digestOf, validateModelOrderProposal,
} from "../src/core/ats_contracts/index.js";

interface Fixture {
  schema_version: string;
  canonical_profile: string;
  document: Record<string, unknown>;
  canonical_digest: string;
  rejects: { name: string; field: string; value: unknown }[];
}

test("the cross-language model proposal is closed and carries no target or approval", async () => {
  const fixture = JSON.parse(await readFile("test/fixtures/ats_model_proposal_golden.json", "utf8")) as Fixture;
  assert.equal(fixture.canonical_profile, ATS_CANONICAL_PROFILE);
  assert.equal(fixture.schema_version, "aether.ats.model-order-proposal-golden/1");
  const parsed = validateModelOrderProposal(fixture.document);
  assert.equal(digestOf(parsed), fixture.canonical_digest);
  for (const { name, field, value } of fixture.rejects) {
    assert.throws(() => validateModelOrderProposal({ ...fixture.document, [field]: value }), /./, name);
  }
  assert.throws(() => validateModelOrderProposal({ ...fixture.document, limit_price_minor: null }), /limit proposal/);
  assert.throws(() => validateModelOrderProposal({ ...fixture.document, order_type: "market" }), /market proposal/);
  assert.throws(() => validateModelOrderProposal({ ...fixture.document, expires_at: "2026-02-30T00:00:00Z" }));
  assert.throws(() => validateModelOrderProposal({ ...fixture.document, schema_version: "aether.ats.model-order-proposal/2" }));
});
