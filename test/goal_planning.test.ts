import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { AppContext } from "../src/core/context.js";
import { draftGoalPlan, inspectGoalRepository } from "../src/core/goal_planning.js";
import { getGoalForWorkspace } from "../src/core/goals.js";
import { handleGoal, handleGoalInput, goalHelp } from "../src/commands/goals.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "goal-plan-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "tsc" }, devDependencies: { typescript: "*" } }));
  writeFileSync(join(root, "src", "parser.ts"), "export const parser = true;\n");
  return root;
}

function harness(root: string, accept = true) {
  let text = "";
  let confirms = 0;
  const out = new Writable({ write(chunk, _encoding, next) { text += chunk.toString(); next(); } });
  const ctx = { flags: { cwd: root, yes: false }, confirm: async () => { confirms++; return accept; } } as unknown as AppContext;
  return { ctx, out, output: () => text, confirms: () => confirms };
}

test("existing parser objective yields narrow plan and keeps the user's constraint", async () => {
  const root = fixture();
  try {
    const goal = await draftGoalPlan("Fix the app's existing failing parser test; no new dependencies", root);
    assert.equal(goal.title, "Fix the app's existing failing parser test; no new dependencies");
    assert.deepEqual(goal.plan?.stack, ["Node.js", "TypeScript"]);
    assert.deepEqual(goal.plan?.relevantFiles, ["src/parser.ts"]);
    assert.equal(goal.plan?.verification.check, "npm test");
    assert.deepEqual(goal.plan?.constraints, ["no new dependencies"]);
    assert.ok(goal.phases.every(p => p.completionCriteria?.length));
    assert.doesNotMatch(goal.phases.map(p => `${p.title} ${p.description}`).join(" "), /scaffold|backend|auth|deploy|docker/i);
    assert.equal(readFileSync(join(root, "src", "parser.ts"), "utf8"), "export const parser = true;\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("empty and unknown repositories keep verification unresolved", async () => {
  const root = mkdtempSync(join(tmpdir(), "goal-empty-"));
  try {
    const goal = await draftGoalPlan("Repair the parser", root);
    assert.deepEqual(inspectGoalRepository(root, goal.title).checks, []);
    assert.equal(goal.plan?.source, "manual");
    assert.equal(goal.plan?.verification.state, "unresolved");
    assert.match(goal.phases.at(-1)?.completionCriteria?.[0] ?? "", /Choose and record/);
    assert.match(goal.plan?.assumptions.join(" ") ?? "", /Stack not identified/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mocked planner output is editable and failure falls back without pretending it ran", async () => {
  const root = fixture();
  try {
    let calls = 0;
    const model = await draftGoalPlan("Fix parser", root, async (_objective, facts) => {
      calls++;
      assert.deepEqual(facts.relevantFiles, ["src/parser.ts"]);
      return { phases: [{ title: "Repair parser", description: "Existing parser only", criteria: ["Parser check passes"] }] };
    });
    assert.equal(calls, 1);
    assert.equal(model.plan?.source, "model");
    assert.deepEqual(model.phases.map(p => p.title), ["Repair parser"]);
    const offline = await draftGoalPlan("Fix parser", root, async () => { throw new Error("offline Ollama"); });
    assert.equal(offline.plan?.source, "repository");
    assert.match(offline.plan?.assumptions.join(" ") ?? "", /model unavailable/);
    assert.equal(offline.plan?.state, "draft");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("draft edits, acceptance, and reopening preserve exactly reviewed phases", async () => {
  const root = fixture();
  const old = process.env["AETHER_GOALS_FILE"];
  process.env["AETHER_GOALS_FILE"] = join(root, "goals.json");
  try {
    const h = harness(root);
    await handleGoalInput(h.ctx, h.out, "Fix parser; no new dependencies");
    assert.equal(h.confirms(), 0);
    assert.equal(readFileSync(join(root, "src", "parser.ts"), "utf8"), "export const parser = true;\n");
    await handleGoal(h.ctx, h.out, "phase", "title 1 Repair existing parser");
    await handleGoal(h.ctx, h.out, "phase", "move 2 1");
    await handleGoal(h.ctx, h.out, "criteria", "1 npm test passes; result recorded");
    await handleGoal(h.ctx, h.out, "note", "1 Use the existing fixture");
    await handleGoal(h.ctx, h.out, "save", "");
    assert.equal(h.confirms(), 1);
    const stored = JSON.parse(readFileSync(join(root, "goals.json"), "utf8"));
    const id = stored[0].id as string;
    assert.equal(stored[0].plan.state, "accepted");
    assert.deepEqual(stored[0].plan.constraints, ["no new dependencies"]);
    assert.equal(stored[0].phases[0].title, "Verify with an existing check");
    assert.deepEqual(stored[0].phases[0].completionCriteria, ["npm test passes", "result recorded"]);
    assert.equal(stored[0].phases[0].userNote, "Use the existing fixture");
    await handleGoal(h.ctx, h.out, "edit", id);
    await handleGoal(h.ctx, h.out, "phase", "remove 2");
    assert.equal(getGoalForWorkspace(id, root)?.phases.length, 2, "edit stays unsaved");
    await handleGoal(h.ctx, h.out, "save", "");
    assert.equal(getGoalForWorkspace(id, root)?.phases.length, 1);
    assert.match(h.output(), /Drafted and accepted plans do not execute work/);
  } finally {
    if (old === undefined) delete process.env["AETHER_GOALS_FILE"];
    else process.env["AETHER_GOALS_FILE"] = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelled acceptance and incomplete manual phases leave the goal store untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "goal-manual-"));
  const old = process.env["AETHER_GOALS_FILE"];
  const file = join(root, "goals.json");
  process.env["AETHER_GOALS_FILE"] = file;
  try {
    const h = harness(root, false);
    await handleGoal(h.ctx, h.out, "", "Repair parser without publishing");
    assert.match(h.output(), /Constraint: without publishing/);
    await handleGoal(h.ctx, h.out, "phase", "add Inspect existing parser");
    await handleGoal(h.ctx, h.out, "save", "");
    assert.match(h.output(), /needs explicit completion criteria/);
    assert.equal(h.confirms(), 0);
    assert.equal(existsSync(file), false);
    await handleGoal(h.ctx, h.out, "criteria", "3 Parser behavior is understood");
    await handleGoal(h.ctx, h.out, "save", "");
    assert.equal(h.confirms(), 1);
    assert.equal(existsSync(file), false);
    await handleGoal(h.ctx, h.out, "draft", "");
    assert.match(h.output(), /Inspect existing parser/);
  } finally {
    if (old === undefined) delete process.env["AETHER_GOALS_FILE"];
    else process.env["AETHER_GOALS_FILE"] = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test("help distinguishes drafting, acceptance, and execution", () => {
  assert.match(goalHelp(), /draft a repository-grounded plan/);
  assert.match(goalHelp(), /accept and save/);
  assert.match(goalHelp(), /does not execute work/);
});
