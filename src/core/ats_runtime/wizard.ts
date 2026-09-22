// Spec 2 section 5 — the resumable setup wizard's state.
//
// "Replace the raw question sequence with a receipt-backed wizard. Every
// completed step is resumable after interruption."
//
// The existing `ats.json.pending` binding already survives a crash, but it
// remembers only the storage ANSWERS — it has no idea which of the seven steps
// finished, so a resume re-asks everything. This module holds that missing
// progress, and holds it separately because section 15 requires
// `aether.ats.local/2` to stay immutable.
//
// FILE COUNT NOTE. Section 15 names three new files (runtime.json,
// data-profile.json, dashboard.json). This adds a fourth, setup.json. Wizard
// progress is genuinely not runtime, data or dashboard state, and folding it
// into any of those would mean an older Agent reading one of them and finding
// fields it cannot interpret — the exact problem section 15 created separate
// files to avoid.
//
// ACCOUNT BINDING. Section 5 step 1: "Abort and tear down if the account
// changes", and "Never silently adopt a legacy setup without an account/agent
// binding." So progress is bound to an account digest and an agent id, and a
// resume under a different account is refused rather than adopted. The digest
// is stored instead of the subject itself so this file stays safe to include
// in a diagnostic bundle (section 14).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { choice, closed, fail, hex64, ident, schemaTag, timestamp, uniqueList } from "../ats_contracts/primitives.js";
import type { ManagedAccountScope } from "../managed_agent_local.js";
import { refuseSymlinkedPath, writePrivateFile } from "./paths.js";
import type { AtsDoctorReport } from "./doctor.js";

export const SETUP_STATE_SCHEMA = "aether.ats.setup/1" as const;

/** The seven steps of section 5, in the order they must be completed. */
export const SETUP_STEPS = [
  "account",
  "runtime",
  "storage",
  "data",
  "nano",
  "preferences",
  "receipt",
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface SetupStateV1 {
  readonly schema_version: typeof SETUP_STATE_SCHEMA;
  /** sha256 over [cloudOrigin, accountSubject]. Never the subject itself. */
  readonly account_binding: string;
  readonly agent_id: string;
  readonly completed_steps: readonly SetupStep[];
  readonly started_at: string;
  readonly updated_at: string;
}

const STATE_FIELDS = [
  "schema_version", "account_binding", "agent_id", "completed_steps", "started_at", "updated_at",
] as const;

/** The binding a setup file is pinned to. Matches managedAgentStorageDirectory's scheme. */
export function accountBinding(account: ManagedAccountScope): string {
  return createHash("sha256")
    .update(JSON.stringify([account.cloudOrigin, account.accountSubject]))
    .digest("hex");
}

export function validateSetupState(value: unknown, name = "ATS setup state"): SetupStateV1 {
  const raw = closed(value, name, STATE_FIELDS);
  const steps = uniqueList(raw.completed_steps, `${name} completed steps`, SETUP_STEPS.length,
    (entry, entryName) => choice(entry, SETUP_STEPS, entryName));
  const startedAt = timestamp(raw.started_at, `${name} started at`);
  const updatedAt = timestamp(raw.updated_at, `${name} updated at`);
  if (Date.parse(updatedAt) < Date.parse(startedAt)) {
    fail(`${name} cannot have been updated before it started.`);
  }
  // Steps complete in order. A file claiming `data` without `runtime` describes
  // a setup that never happened, and resuming from it would skip the step that
  // decides whether a runtime exists at all.
  const ordered = SETUP_STEPS.filter(step => steps.includes(step));
  const highest = steps.reduce((max, step) => Math.max(max, SETUP_STEPS.indexOf(step)), -1);
  if (steps.length !== highest + 1) {
    fail(`${name} skips a step, so it does not describe a resumable setup.`);
  }

  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, SETUP_STATE_SCHEMA, name) as typeof SETUP_STATE_SCHEMA,
    account_binding: hex64(raw.account_binding, `${name} account binding`),
    agent_id: ident(raw.agent_id, `${name} agent id`),
    completed_steps: Object.freeze(ordered),
    started_at: startedAt,
    updated_at: updatedAt,
  });
}

export function beginSetup(account: ManagedAccountScope, agentId: string, startedAt: string): SetupStateV1 {
  return validateSetupState({
    schema_version: SETUP_STATE_SCHEMA,
    account_binding: accountBinding(account),
    agent_id: agentId,
    completed_steps: [],
    started_at: startedAt,
    updated_at: startedAt,
  });
}

/** The first step not yet done, or null when setup is finished. */
export function nextStep(state: SetupStateV1): SetupStep | null {
  return SETUP_STEPS.find(step => !state.completed_steps.includes(step)) ?? null;
}

export function setupComplete(state: SetupStateV1): boolean {
  return nextStep(state) === null;
}

/**
 * Mark a step done. Completing out of order is refused rather than reordered:
 * a caller that thinks it finished `data` before `runtime` has a bug, and
 * silently accepting it would persist a state that resumes into the wrong step.
 */
export function completeStep(state: SetupStateV1, step: SetupStep, updatedAt: string): SetupStateV1 {
  if (state.completed_steps.includes(step)) return state;
  const expected = nextStep(state);
  if (expected !== step) {
    fail(`ATS setup cannot complete ${step} before ${expected ?? "it is finished"}.`);
  }
  return validateSetupState({
    ...state,
    completed_steps: [...state.completed_steps, step],
    updated_at: updatedAt,
  });
}

/**
 * Whether saved progress may be resumed under this account and agent.
 *
 * Section 5 step 1 requires aborting and tearing down on an account change, so
 * a mismatch is an explicit refusal — never a silent fresh start, which would
 * quietly abandon a runtime and memory the previous account still owns.
 */
export function resumable(state: SetupStateV1, account: ManagedAccountScope, agentId: string): boolean {
  return state.account_binding === accountBinding(account) && state.agent_id === agentId;
}

export async function readSetupState(path: string): Promise<SetupStateV1 | null> {
  await refuseSymlinkedPath(path);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ATS setup progress is unreadable. Inspect it before continuing; it was not overwritten.");
  }
  return validateSetupState(parsed);
}

export async function writeSetupState(path: string, state: SetupStateV1): Promise<void> {
  await writePrivateFile(path, JSON.stringify(validateSetupState(state), null, 2) + "\n");
}

/** Operator-facing step labels, matching the section 5 headings. */
const STEP_LABELS: Readonly<Record<SetupStep, string>> = Object.freeze({
  account: "Account and policy",
  runtime: "Runtime",
  storage: "Storage",
  data: "Data",
  nano: "Nano workspace",
  preferences: "Preferences",
  receipt: "Receipt summary",
});

export function formatSetupProgress(state: SetupStateV1): string {
  const lines = SETUP_STEPS.map((step, index) => {
    const done = state.completed_steps.includes(step);
    return `  ${index + 1}. ${STEP_LABELS[step].padEnd(20)} ${done ? "done" : "pending"}`;
  });
  const next = nextStep(state);
  const headline = next
    ? `ATS setup · resuming at step ${SETUP_STEPS.indexOf(next) + 1}, ${STEP_LABELS[next]}`
    : "ATS setup · complete";
  return [headline, ...lines, ""].join("\n");
}

/**
 * Section 5 step 7's receipt summary, rendered from the doctor's axes rather
 * than from the wizard's own memory of what it did. Asking the system what is
 * true is the whole point of a receipt-backed wizard: a summary built from the
 * answers the operator typed would say "Runtime: installed" even when the
 * install was rolled back a moment later.
 */
export function formatReceiptSummary(report: AtsDoctorReport): string {
  const width = Math.max(...report.axes.map(axis => axis.name.length));
  const rows = report.axes.map(axis => `  ${axis.name.padEnd(width)}  ${axis.detail}`);
  return [
    "ATS setup summary",
    ...rows,
    "",
    "  aether ats doctor",
    "  aether ats dashboard open",
    "",
  ].join("\n");
}
