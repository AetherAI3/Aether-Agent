// PR 2.3 — resumable setup progress (Spec 2 section 5).

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  accountBinding,
  beginSetup,
  completeStep,
  formatReceiptSummary,
  formatSetupProgress,
  nextStep,
  readSetupState,
  resumable,
  setupComplete,
  validateSetupState,
  writeSetupState,
  SETUP_STEPS,
} from "../src/core/ats_runtime/wizard.js";
import { buildAtsDoctorReport } from "../src/core/ats_runtime/doctor.js";

const ACCOUNT = { cloudOrigin: "https://example.test", accountSubject: "11111111-1111-4111-8111-111111111111" };
const OTHER = { cloudOrigin: "https://elsewhere.test", accountSubject: "22222222-2222-4222-8222-222222222222" };
const AGENT = "mag_atlas";
const T0 = "2026-09-22T12:00:00Z";

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aether-ats-wizard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a fresh setup starts at the account step and walks the seven steps in order", () => {
  let state = beginSetup(ACCOUNT, AGENT, T0);
  assert.equal(nextStep(state), "account");
  assert.equal(setupComplete(state), false);

  for (const step of SETUP_STEPS) {
    assert.equal(nextStep(state), step);
    state = completeStep(state, step, T0);
  }
  assert.equal(setupComplete(state), true);
  assert.equal(nextStep(state), null);
});

test("completing a step out of order is refused rather than reordered", () => {
  const state = beginSetup(ACCOUNT, AGENT, T0);
  assert.throws(() => completeStep(state, "data", T0), /cannot complete data before account/);
});

test("completing the same step twice is a no-op, so a retried resume is safe", () => {
  const first = completeStep(beginSetup(ACCOUNT, AGENT, T0), "account", T0);
  const again = completeStep(first, "account", T0);
  assert.deepEqual([...again.completed_steps], ["account"]);
});

test("saved progress resumes under the same account and agent, and not otherwise", () => {
  const state = completeStep(beginSetup(ACCOUNT, AGENT, T0), "account", T0);
  assert.equal(resumable(state, ACCOUNT, AGENT), true);
  // Section 5 step 1: an account change aborts rather than silently adopting.
  assert.equal(resumable(state, OTHER, AGENT), false);
  assert.equal(resumable(state, ACCOUNT, "mag_someoneelse"), false);
});

test("the account subject is stored only as a digest", async t => {
  const root = await temporary(t);
  const path = join(root, "setup.json");
  await writeSetupState(path, beginSetup(ACCOUNT, AGENT, T0));

  const state = await readSetupState(path);
  assert.equal(state?.account_binding, accountBinding(ACCOUNT));
  assert.match(state!.account_binding, /^[0-9a-f]{64}$/);

  const raw = await readFile(path, "utf8");
  assert.ok(!raw.includes(ACCOUNT.accountSubject), "the raw account subject must not be written to disk");
  assert.ok(!raw.includes(ACCOUNT.cloudOrigin), "the cloud origin must not be written to disk");
});

test("progress survives a round trip and a missing file is not an error", async t => {
  const root = await temporary(t);
  const path = join(root, "setup.json");
  assert.equal(await readSetupState(path), null);

  let state = beginSetup(ACCOUNT, AGENT, T0);
  state = completeStep(state, "account", T0);
  state = completeStep(state, "runtime", T0);
  await writeSetupState(path, state);

  const reloaded = await readSetupState(path);
  assert.deepEqual([...(reloaded?.completed_steps ?? [])], ["account", "runtime"]);
  assert.equal(nextStep(reloaded!), "storage");
});

test("a setup file that skips a step is refused, not resumed from", () => {
  assert.throws(() => validateSetupState({
    schema_version: "aether.ats.setup/1",
    account_binding: accountBinding(ACCOUNT),
    agent_id: AGENT,
    // `data` without `storage`: describes a setup that never happened.
    completed_steps: ["account", "runtime", "data"],
    started_at: T0,
    updated_at: T0,
  }), /skips a step/);
});

test("corrupt progress throws rather than silently restarting setup", async t => {
  const root = await temporary(t);
  const path = join(root, "setup.json");
  await writeFile(path, "{not json", { mode: 0o600 });
  await assert.rejects(readSetupState(path), /unreadable/);
});

test("progress rendering names the step a resume will continue from", () => {
  const state = completeStep(completeStep(beginSetup(ACCOUNT, AGENT, T0), "account", T0), "runtime", T0);
  const rendered = formatSetupProgress(state);
  assert.match(rendered, /resuming at step 3, Storage/);
  assert.match(rendered, /Account and policy\s+done/);
  assert.match(rendered, /Data\s+pending/);
});

test("the receipt summary is built from observed state, not from the answers given", async t => {
  const root = await temporary(t);
  // Nothing was installed, so the summary must say so even though a wizard run
  // would have "completed" its runtime step by choosing to skip it.
  const report = await buildAtsDoctorReport({
    runtimeStatePath: join(root, "runtime.json"),
    dataProfilePath: join(root, "data-profile.json"),
    dashboardStatePath: join(root, "dashboard.json"),
    strategies: { compiled: 0, rejected: 0, needs_conversion: 0, unavailable: 0, total: 0 },
    now: () => new Date(Date.parse(T0)),
  });
  const summary = formatReceiptSummary(report);
  assert.match(summary, /ATS setup summary/);
  assert.match(summary, /No ATS runtime is configured/);
  assert.match(summary, /0 compiled/);
  assert.match(summary, /aether ats doctor/);
});
