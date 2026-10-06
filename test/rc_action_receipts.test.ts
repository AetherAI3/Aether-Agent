// #220: CI and PR status reach the active RC session from Action Rail
// receipts, through the real `aether github ... --approve` execute hook.
//
// Every payload a test sees is checked against the Cloud display/1 contract
// (lib/remote_session/contracts.py `_validate_rc_display_payload`): a payload
// the broker rejects with 400 keeps the batch and wedges the whole outbox.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cmdGithub } from "../src/commands/github.js";
import { projectRefFor, rcOutboxPath } from "../src/commands/rc.js";
import type { ActionPlan } from "../src/core/action_rail.js";
import type { AppContext } from "../src/core/context.js";
import { actionReceiptDelivery, receiptDisplayEvents } from "../src/core/rc/action_receipts.js";
import { createOutbox, loadOutbox, saveOutbox } from "../src/core/rc/outbox.js";
import { payloadDigest } from "../src/core/rc/receipts.js";
import type { ApiClient } from "../src/core/transport.js";

const SESSION = "rs_" + "2".repeat(32);
const BODY_CANARY = "USER-AUTHORED-PR-BODY-CANARY";
const TOKEN_CANARY = "ghs_TOKENCANARY0123456789";

// ── local Cloud display/1 contract check ──────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(
  join(here, "..", "..", "test", "fixtures", "rc-display-v1.json"), "utf8",
)) as { payload_keys: Record<string, string[]> };

/** RC_DISPLAY_REQUIRED_KEYS in AETHER-CLOUD lib/remote_session/contracts.py. */
const REQUIRED_KEYS: Readonly<Record<string, readonly string[]>> = {
  plan: ["title", "status"], subagent: ["subagent_id", "status"], tool_activity: ["tool", "status"],
  diff_summary: ["files_changed", "insertions", "deletions"], tests: ["status"],
  ci: ["provider", "status"], pr_status: ["state"], artifact: ["artifact_id", "kind", "title"],
  preview: ["phase", "instance_id"], done: ["status"], error: ["code", "message"],
};
const COUNT_KEYS = new Set(["step", "total_steps", "files_changed", "insertions", "deletions",
  "passed", "failed", "skipped", "number"]);

function assertDisplayContract(eventType: string, payload: Record<string, unknown>): void {
  const allowed = FIXTURE.payload_keys[eventType];
  assert.ok(allowed, `${eventType} is a display/1 event type`);
  assert.equal(payload["projection_version"], "1", `${eventType} carries projection_version 1`);
  for (const key of Object.keys(payload)) assert.ok(allowed.includes(key), `${eventType}.${key} is allowlisted`);
  for (const key of REQUIRED_KEYS[eventType] ?? []) {
    assert.ok(key in payload, `${eventType}.${key} is required`);
    if (typeof payload[key] === "string") assert.notEqual(payload[key], "", `${eventType}.${key} is non-empty`);
  }
  for (const [key, value] of Object.entries(payload)) {
    if (key === "projection_version") continue;
    if (COUNT_KEYS.has(key)) {
      assert.ok(Number.isSafeInteger(value) && (value as number) >= 0, `${eventType}.${key} is a bounded count`);
    } else {
      assert.equal(typeof value, "string", `${eventType}.${key} is a string`);
      assert.ok((value as string).length <= 512 && !/[\u0000-\u001f\u007f]/.test(value as string));
    }
  }
  if ("repo" in payload) assert.match(String(payload["repo"]), /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
  if ("run_id" in payload) assert.match(String(payload["run_id"]), /^[1-9][0-9]*$/);
  if ("url" in payload) {
    const url = new URL(String(payload["url"]));
    assert.equal(url.protocol, "https:");
    assert.ok(url.host && !url.username && !url.password && !url.search && !url.hash);
    if (eventType === "pr_status") {
      assert.equal(payload["url"], `https://github.com/${String(payload["repo"])}/pull/${String(payload["number"])}`);
    }
  }
}

// ── fixtures ───────────────────────────────────────────────────────────────

function plan(overrides: Partial<ActionPlan> = {}): ActionPlan {
  return {
    plan_id: "plan_rc_0001",
    action_digest: `sha256:${"a".repeat(64)}`,
    action_type: "aether.github.pr.create",
    project_id: "proj_rc",
    repository: "AetherAI3/aether-agent",
    repo: null,
    effect_preview: `Open a draft PR. ${BODY_CANARY}`,
    requested_permissions: { pull_requests: "write" },
    granted_permissions: { pull_requests: "write" },
    required_assurance: "session",
    secret_uses: [],
    budget: { max_uvt: 1, max_cost_minor: 0, currency: "USD" },
    warnings: [],
    blockers: [],
    policy_digest: `sha256:${"b".repeat(64)}`,
    expires_at: "2026-10-05T01:00:00Z",
    prepare_performed_external_writes: false,
    ...overrides,
  };
}

/** A Cloud receipt shaped like lib/action_rail/service.py build_receipt, plus hostile extras. */
function receiptFor(p: ActionPlan, ids: Record<string, unknown>, reconciled: unknown): Record<string, unknown> {
  return {
    schema: "aether.action_receipt/1",
    receipt_kind: "github_action",
    receipt_id: "rcpt_" + "c".repeat(32),
    plan_id: p.plan_id,
    action_digest: p.action_digest,
    action_type: p.action_type,
    actor_id: "user_private_actor",
    repository: p.repository,
    token_scope_fingerprint: TOKEN_CANARY,
    provider_object_ids: ids,
    reconciled,
    issued_at: "2026-10-05T00:00:00Z",
    body: BODY_CANARY,
    logs: `Run failed at C:\\Users\\someone\\private ${TOKEN_CANARY}`,
  };
}

interface Harness {
  root: string;
  path: string;
  ctx: AppContext;
  sent: Array<{ event_type: string; payload: Record<string, unknown> }>;
  /** Every append body exactly as it was handed to the transport, including attempts that failed. */
  wire: string[];
  appendCalls: () => number;
  setOffline(value: boolean): void;
  /** Hold every append until the promise settles: a broker that never answers. */
  setHold(hold: Promise<void> | null): void;
  setNext(plan: ActionPlan, receipt: Record<string, unknown>): void;
  cleanup(): void;
}

function harness(options: { session?: boolean; revokePending?: boolean } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "aether-rc-receipts-"));
  const path = rcOutboxPath(projectRefFor(root));
  if (options.session !== false) {
    const record = createOutbox({
      session_id: SESSION, project_ref: projectRefFor(root), device_id: "dev-test", epoch: 1, project_root: root,
    });
    record.revoke_pending = options.revokePending === true;
    saveOutbox(path, record);
  }
  const sent: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
  const wire: string[] = [];
  let appends = 0;
  let offline = false;
  let hold: Promise<void> | null = null;
  let seq = 0;
  let nextPlan = plan();
  let nextReceipt: Record<string, unknown> = {};
  const api = {
    async getJson(endpoint: string) {
      assert.equal(endpoint, `/cloud/actions/github/actions/${nextPlan.plan_id}`);
      return nextPlan;
    },
    async postJson(endpoint: string, body: unknown) {
      if (endpoint === "/cloud/actions/github/execute") {
        assert.deepEqual(body, {
          plan_id: nextPlan.plan_id,
          action_digest: nextPlan.action_digest,
          approve: (body as { approve: string }).approve,
        });
        return { receipt: nextReceipt };
      }
      assert.equal(endpoint, `/remote/sessions/${SESSION}/host/events`);
      appends += 1;
      wire.push(JSON.stringify(body));
      if (hold) await hold;
      if (offline) throw new Error("broker offline");
      const events = (body as { events: Array<{
        host_event_id: string; event_type: string; payload: Record<string, unknown>;
      }> }).events;
      sent.push(...events.map(({ event_type, payload }) => ({ event_type, payload })));
      return { session_id: SESSION, receipts: events.map((event) => ({
        host_event_id: event.host_event_id, seq: ++seq, payload_digest: payloadDigest(event.payload),
      })) };
    },
  } as unknown as ApiClient;
  return {
    root,
    path,
    ctx: { flags: { cwd: root }, api } as unknown as AppContext,
    sent,
    wire,
    appendCalls: () => appends,
    setOffline(value) { offline = value; },
    setHold(value) { hold = value; },
    setNext(p, r) { nextPlan = p; nextReceipt = r; },
    cleanup() {
      rmSync(path, { force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Run one real `aether github` command, capturing only its JSON envelope. */
async function execute(h: Harness, argv: string[]): Promise<{ code: number; envelope: Record<string, unknown> }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text = String(chunk);
    if (text.startsWith('{"schema":"aether.cli.github/1"')) {
      chunks.push(text);
      return true;
    }
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await cmdGithub(h.ctx, argv, { json: true });
  } finally {
    process.stdout.write = original;
  }
  await actionReceiptDelivery();
  assert.equal(chunks.length, 1, "exactly one envelope is printed");
  return { code, envelope: JSON.parse(chunks[0]!) as Record<string, unknown> };
}

/**
 * Nothing private reaches what can leave this machine: every append body the
 * broker was handed, whole, and the outbox record whose queued events become
 * the next bodies.
 *
 * The record's own `project_root` is the one field exempt from the scan, and
 * only because it is local bookkeeping: loadOutbox needs it to re-relativize
 * paths after a restart, and flushOutbox never sends it (device_id and events
 * only). It is asserted to be exactly that rather than scanned as text, which
 * failed on Linux for the harness's own field and was vacuous on Windows,
 * where JSON escapes the root's backslashes so a raw-path search never matches.
 */
function assertNoLeak(h: Harness): void {
  const forbidden = [BODY_CANARY, TOKEN_CANARY, "user_private_actor", "feat/private-branch",
    "queued", "html_url", "someone", "workflow_path", ".github/workflows", "?token",
    // The project root both raw and as JSON text spells it on every platform.
    h.root, JSON.stringify(h.root).slice(1, -1)];
  const scanned = [...h.wire];
  if (existsSync(h.path)) {
    const { project_root: localRoot, ...record } = JSON.parse(readFileSync(h.path, "utf8")) as Record<string, unknown>;
    assert.equal(localRoot, h.root, "the outbox keeps its project root as local bookkeeping");
    scanned.push(JSON.stringify(record));
  }
  for (const body of h.wire) assert.ok(!body.includes("project_root"), "the project root field never travels");
  for (const text of scanned) {
    for (const value of forbidden) {
      assert.ok(!text.includes(value), `${value} must not reach the outbox or the wire`);
    }
  }
}

// ── tests ──────────────────────────────────────────────────────────────────

test("a PR receipt reaches the active RC session, then its reconciled update replaces it", async () => {
  const h = harness();
  try {
    const create = plan();
    h.setNext(create, receiptFor(create, {
      number: 7,
      html_url: "https://github.com/AetherAI3/aether-agent/pull/7?token=leak",
      ref: "feat/private-branch",
      status: "queued",
    }, false));
    const first = await execute(h, ["pr", "create", "--plan", create.plan_id, "--approve", "create-draft-pr"]);
    assert.equal(first.code, 0);
    assert.equal(first.envelope["status"], "executed");
    assert.equal((first.envelope["receipt"] as Record<string, unknown>)["receipt_id"], "rcpt_" + "c".repeat(32),
      "the command's own receipt output is unchanged");

    const update = plan({ plan_id: "plan_rc_0002", action_type: "aether.github.pr.update",
      action_digest: `sha256:${"d".repeat(64)}` });
    h.setNext(update, receiptFor(update, { number: 7 }, true));
    const second = await execute(h, ["pr", "update", "--plan", update.plan_id, "--approve", "update-pr"]);
    assert.equal(second.code, 0);

    assert.deepEqual(h.sent, [
      { event_type: "pr_status", payload: { projection_version: "1", repo: "AetherAI3/aether-agent", number: 7,
        state: "issued", url: "https://github.com/AetherAI3/aether-agent/pull/7" } },
      { event_type: "pr_status", payload: { projection_version: "1", repo: "AetherAI3/aether-agent", number: 7,
        state: "reconciled", url: "https://github.com/AetherAI3/aether-agent/pull/7" } },
    ]);
    for (const event of h.sent as Array<{ event_type: string; payload: Record<string, unknown> }>) {
      assertDisplayContract(event.event_type, event.payload);
      // Only what the receipt states: no title, checks, deployment or merge state.
      for (const absent of ["title", "checks_summary", "deployment_status", "merged"]) {
        assert.equal(event.payload[absent], undefined);
      }
    }
    assert.equal(loadOutbox(h.path, h.root).events.length, 0, "receipted events leave the queue");
    assertNoLeak(h);
  } finally {
    h.cleanup();
  }
});

test("a CI rerun receipt publishes the run identity and issued versus reconciled honestly", async () => {
  const h = harness();
  try {
    for (const [index, reconciled] of [false, true].entries()) {
      const rerun = plan({ plan_id: `plan_ci_000${index}`, action_type: "aether.github.ci.rerun_failed" });
      h.setNext(rerun, receiptFor(rerun, { run_id: 4242, status: "queued" }, reconciled));
      const result = await execute(h, ["ci", "rerun", "--plan", rerun.plan_id, "--approve", "rerun-failed-checks"]);
      assert.equal(result.code, 0);
    }
    assert.deepEqual(h.sent, [
      { event_type: "ci", payload: { projection_version: "1", provider: "github", status: "issued", run_id: "4242" } },
      { event_type: "ci", payload: { projection_version: "1", provider: "github", status: "reconciled", run_id: "4242" } },
    ]);
    for (const event of h.sent) assertDisplayContract(event.event_type, event.payload);
    assertNoLeak(h);
  } finally {
    h.cleanup();
  }
});

test("non-matching action types and unbound receipts publish nothing through the real hook", async () => {
  const h = harness();
  try {
    // A workflow dispatch receipt carries a path and a branch, not a run: there
    // is no CI or PR identity to show, so nothing is invented.
    const dispatch = plan({ plan_id: "plan_wf_0001", action_type: "aether.github.workflow.dispatch" });
    h.setNext(dispatch, receiptFor(dispatch,
      { workflow_path: ".github/workflows/ci.yml", ref: "feat/private-branch", status: "queued" }, false));
    assert.equal((await execute(h, ["workflow", "dispatch", "--plan", dispatch.plan_id,
      "--approve", "dispatch-workflow"])).code, 0);

    // A receipt that does not bind to the plan just executed is not a record of it.
    const create = plan({ plan_id: "plan_pr_0009" });
    h.setNext(create, { ...receiptFor(create, { number: 9 }, false), plan_id: "plan_someone_else" });
    assert.equal((await execute(h, ["pr", "create", "--plan", create.plan_id, "--approve", "create-draft-pr"])).code, 0);
    h.setNext(create, { ...receiptFor(create, { number: 9 }, false), action_type: "aether.github.ci.rerun_failed" });
    assert.equal((await execute(h, ["pr", "create", "--plan", create.plan_id, "--approve", "create-draft-pr"])).code, 0);
    h.setNext(create, { ...receiptFor(create, { number: 9 }, false), action_digest: `sha256:${"f".repeat(64)}` });
    assert.equal((await execute(h, ["pr", "create", "--plan", create.plan_id, "--approve", "create-draft-pr"])).code, 0);

    // Issued versus reconciled is unknowable without a boolean, so it is not guessed.
    h.setNext(create, receiptFor(create, { number: 9 }, "yes"));
    assert.equal((await execute(h, ["pr", "create", "--plan", create.plan_id, "--approve", "create-draft-pr"])).code, 0);

    assert.equal(h.appendCalls(), 0, "nothing was sent");
    assert.equal(loadOutbox(h.path, h.root).events.length, 0, "nothing was queued");
    assertNoLeak(h);
  } finally {
    h.cleanup();
  }
});

test("an unreachable broker never changes the command result and the receipt stays durable", async () => {
  const h = harness();
  try {
    h.setOffline(true);
    const create = plan();
    h.setNext(create, receiptFor(create, { number: 11 }, false));
    const offline = await execute(h, ["pr", "create", "--plan", create.plan_id, "--approve", "create-draft-pr"]);
    assert.equal(offline.code, 0);
    assert.equal(offline.envelope["status"], "executed");
    const queued = loadOutbox(h.path, h.root).events;
    assert.equal(queued.length, 1, "the projection is durable before any upload");
    assert.equal(queued[0]?.event_type, "pr_status");
    assertDisplayContract("pr_status", queued[0]!.payload);

    h.setOffline(false);
    const rerun = plan({ plan_id: "plan_ci_0011", action_type: "aether.github.ci.rerun_failed" });
    h.setNext(rerun, receiptFor(rerun, { run_id: 77 }, false));
    assert.equal((await execute(h, ["ci", "rerun", "--plan", rerun.plan_id,
      "--approve", "rerun-failed-checks"])).code, 0);
    assert.deepEqual(h.sent.map((event) => event.event_type), ["pr_status", "ci"], "replay keeps receipt order");
    for (const event of h.sent) assertDisplayContract(event.event_type, event.payload);
    assert.equal(loadOutbox(h.path, h.root).events.length, 0);
  } finally {
    h.cleanup();
  }
});

test("a broker that never answers cannot delay the command: the receipt is durable before the upload", async () => {
  const h = harness();
  let release!: () => void;
  h.setHold(new Promise<void>((resolve) => { release = resolve; }));
  try {
    const create = plan({ plan_id: "plan_pr_0021" });
    h.setNext(create, receiptFor(create, { number: 21 }, false));
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let code: number | "still waiting";
    try {
      // If the hook awaited the upload, the command would still be waiting on
      // the held append when this deadline fires.
      code = await Promise.race([
        cmdGithub(h.ctx, ["pr", "create", "--plan", create.plan_id, "--approve", "create-draft-pr"], { json: true }),
        new Promise<"still waiting">((resolve) => { setTimeout(() => resolve("still waiting"), 5_000).unref(); }),
      ]);
    } finally {
      process.stdout.write = original;
    }
    assert.equal(code, 0, "the command returned its own result while the upload was held");
    assert.equal(h.appendCalls(), 1, "the upload was started, not awaited");
    assert.deepEqual(loadOutbox(h.path, h.root).events.map((event) => event.event_type), ["pr_status"],
      "the projection was durable before any broker answer");

    release();
    await actionReceiptDelivery();
    assert.deepEqual(h.sent.map((event) => event.event_type), ["pr_status"]);
    assert.equal(loadOutbox(h.path, h.root).events.length, 0, "the late receipt still clears the queue");
  } finally {
    release();
    h.cleanup();
  }
});

test("without an active RC session the command is unchanged and no outbox is created", async () => {
  for (const options of [{ session: false }, { revokePending: true }]) {
    const h = harness(options);
    try {
      const create = plan();
      h.setNext(create, receiptFor(create, { number: 3 }, false));
      const result = await execute(h, ["pr", "create", "--plan", create.plan_id, "--approve", "create-draft-pr"]);
      assert.equal(result.code, 0);
      assert.equal(result.envelope["status"], "executed");
      assert.equal(h.appendCalls(), 0);
      if (options.session === false) assert.equal(existsSync(h.path), false, "no RC state is created");
      else assert.equal(loadOutbox(h.path, h.root).events.length, 0, "a revoked session receives nothing");
    } finally {
      h.cleanup();
    }
  }
});

test("an identifier the sanitizer would rewrite is dropped, never published altered", () => {
  // A container checkout at /app and a repository owned by "apple": the
  // sanitizer scrubs the project root out of every string, which would turn
  // the PR link into one that no longer matches repo/number. The broker
  // rejects that with 400 and the batch wedges, so the link is dropped.
  const create = plan({ repository: "apple/swift" });
  const events = receiptDisplayEvents(receiptFor(create, { number: 5 }, false), create, "/app");
  assert.deepEqual(events, [{ event_type: "pr_status", payload: {
    projection_version: "1", repo: "apple/swift", number: 5, state: "issued",
  } }]);
  for (const event of events) assertDisplayContract(event.event_type, event.payload);

  // A repository that is not a plain owner/name yields neither repo nor link.
  const odd = plan({ repository: "evil.example/../../x?a=b" });
  const [unsafe] = receiptDisplayEvents(receiptFor(odd, { number: 5 }, true), odd, "/repo");
  assert.ok(unsafe);
  assertDisplayContract(unsafe.event_type, unsafe.payload);
  assert.deepEqual(unsafe.payload, { projection_version: "1", number: 5, state: "reconciled" });
});
