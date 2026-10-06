import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { parseArgs } from "node:util";
import type { AppContext } from "../src/core/context.js";
import { newGoal, newPhase } from "../src/core/goals.js";
import { newGoalPhaseRun } from "../src/core/goal_run.js";
import { fillPrTemplate, preparePrDraft, readPreparedPrDraft } from "../src/core/pr_draft.js";
import { readRepoState } from "../src/core/review_state.js";
import { classifyVerification, treeIdentity, writeVerification, type VerificationRecord } from "../src/core/verification_record.js";
import { defaultRunner, type Runner, type RunResult } from "../src/core/worktree.js";
import { parseShipSlashArgs, runShip, type ShipDeps } from "../src/commands/ship.js";
import { CLI_PARSE_OPTIONS } from "../src/commands/cli_registry.js";
import type { PromptIO } from "../src/ui/interact.js";
import { TEMP_ROOT } from "./tmp_workspace.js";

const TEMPLATE = `## Why

What problem does this pull request solve?

## What changed

Summarize the focused change and call out any user-visible behavior.

## Verification

- [ ] Relevant tests and checks pass, or the reason they were not run is below.
- [ ] Public commands, examples, and generated docs were checked when applicable.

Evidence or commands:

## Scope and risk

- Security or local-authority impact:
- Compatibility or release impact:
- Follow-up work intentionally left out:
`;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function fixture(withTemplate: boolean) {
  const home = mkdtempSync(join(TEMP_ROOT, "pr-draft-"));
  const repo = join(home, "repo");
  const remote = join(home, "github.com", "octocat", "hello-world.git").replaceAll("\\", "/");
  mkdirSync(repo);
  mkdirSync(join(home, "github.com", "octocat"), { recursive: true });
  git(home, "init", "--bare", "--initial-branch=main", remote);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Draft Test");
  git(repo, "config", "user.email", "draft@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.autocrlf", "false");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "parser.ts"), "export const parse = (text: string) => text;\n");
  if (withTemplate) {
    mkdirSync(join(repo, ".github"));
    writeFileSync(join(repo, ".github", "pull_request_template.md"), TEMPLATE);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "chore: base");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "origin", "main");
  git(repo, "switch", "-c", "feature/pr-draft");
  const previousConfig = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = join(home, "config");
  return {
    home, repo, remote,
    state: () => {
      const state = readRepoState(defaultRunner(), repo, { base: "main" });
      assert.equal(state.ok, true);
      return state;
    },
    cleanup: () => {
      if (previousConfig === undefined) delete process.env["AETHER_CONFIG_DIR"];
      else process.env["AETHER_CONFIG_DIR"] = previousConfig;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function commitParser(repo: string): void {
  writeFileSync(join(repo, "src", "parser.ts"), "export const parse = (text: string) => [...text].join('');\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "fix(parser): parser crashes on multibyte input");
}

function commitTest(repo: string): void {
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "test", "parser.test.ts"), "assert.equal(parse('☃'), '☃');\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "test(parser): cover multibyte input");
}

function reading(repo: string) {
  return classifyVerification(null, treeIdentity(defaultRunner(), repo));
}

function sink() {
  let value = "";
  const out = new PassThrough();
  out.on("data", chunk => { value += String(chunk); });
  return { out, text: () => value };
}

function runner() {
  const real = defaultRunner();
  const calls: string[][] = [];
  const run: Runner = (cmd, args, cwd) => {
    calls.push([cmd, ...args]);
    if (cmd === "gh") return { status: 0, stdout: args[0] === "pr" ? "https://github.com/octocat/hello-world/pull/42\n" : "", stderr: "" } as RunResult;
    return real(cmd, args, cwd);
  };
  return { run, calls };
}

function deps(repo: string, run: Runner, out: PassThrough, answer = "n"): ShipDeps {
  const io: PromptIO = { tty: true, note: () => {}, question: async () => answer };
  return { run, cwd: repo, out, io };
}

const ctx = { flags: { cwd: "", yes: false, json: false } } as unknown as AppContext;

test("custom template headings and checklist intent survive without pre-checked claims", () => {
  const body = fillPrTemplate("## Release notes\n\n- [x] Announced\n\n## Verification\n\n- [x] Tests pass\n", {
    why: "A concrete problem.", changed: "A focused change.", verification: "No check ran.", risk: "Review the diff.",
  });
  assert.match(body, /^## Release notes\n\n- \[ \] Announced/m);
  assert.match(body, /## Verification\n\n- \[ \] Tests pass\n\nNo check ran/);
  assert.match(body, /## Why\n\nA concrete problem/);
  assert.equal(body.includes("[x]"), false);
});

test("shell and console accept the same draft flags and quoted file path", () => {
  const parsed = parseArgs({ args: ["ship", "--pr-draft", "--draft-file", "draft proposal.json"], allowPositionals: true, strict: true, options: CLI_PARSE_OPTIONS });
  assert.equal(parsed.values["pr-draft"], true);
  assert.equal(parsed.values["draft-file"], "draft proposal.json");
  assert.deepEqual(parseShipSlashArgs('--pr-draft --draft-file "draft proposal.json"'), {
    yes: false, json: false, draft: true, draftFile: "draft proposal.json",
  });
});

test("multi-commit final diff fills the repository template with an honest golden body", () => {
  const s = fixture(true);
  try {
    commitParser(s.repo);
    commitTest(s.repo);
    const draft = preparePrDraft(defaultRunner(), s.state(), reading(s.repo));
    assert.equal(draft.title, "fix(parser): parser crashes on multibyte input");
    assert.equal(draft.body, `## Why

Problem or objective: parser crashes on multibyte input.

## What changed

- Added \`test/parser.test.ts\`.
- Updated \`src/parser.ts\`.

## Verification

- [ ] Relevant tests and checks pass, or the reason they were not run is below.
- [ ] Public commands, examples, and generated docs were checked when applicable.

Evidence or commands:

- Host check: not verified — nothing has verified this working tree.
- CI: not observed by this local draft; check the PR after it opens.

## Scope and risk

- Security or local-authority impact: review the final diff.
- Compatibility or release impact: not assessed by this local draft.
- Follow-up work: none recorded in this draft.
`);
    assert.equal(draft.body.includes("chore: base"), false);
  } finally { s.cleanup(); }
});

test("one-file branch without a template stays short and keeps fallback headings", () => {
  const s = fixture(false);
  try {
    commitParser(s.repo);
    const draft = preparePrDraft(defaultRunner(), s.state(), reading(s.repo));
    assert.equal(draft.body, `## Why

Problem or objective: parser crashes on multibyte input.

## What changed

- Updated \`src/parser.ts\` in the final branch diff.

## Verification

- [ ] Relevant tests and checks pass, or the reason they were not run is below.
- [ ] Public commands, examples, and generated docs were checked when applicable.

Evidence or commands:

- Host check: not verified — nothing has verified this working tree.
- CI: not observed by this local draft; check the PR after it opens.
`);
  } finally { s.cleanup(); }
});

test("passed, failed, stale, skipped and unrun checks have distinct truthful text", () => {
  const s = fixture(false);
  try {
    commitParser(s.repo);
    const state = s.state();
    const identity = treeIdentity(defaultRunner(), s.repo);
    const base: VerificationRecord = { version: 1, command: "npm test", exitCode: 0, ranAt: "2026-01-01T00:00:00.000Z", head: identity.head, treeDigest: identity.digest, remaining: null };
    assert.match(preparePrDraft(defaultRunner(), state, reading(s.repo)).body, /Host check: not verified/);
    writeVerification(s.repo, base);
    const green = classifyVerification(base, identity);
    assert.match(preparePrDraft(defaultRunner(), state, green).body, /Host check: npm test — passed \(exit 0\)/);
    assert.match(preparePrDraft(defaultRunner(), state, green).body, /- \[ \] Relevant tests/);
    const red = classifyVerification({ ...base, exitCode: 3, remaining: 2 }, identity);
    assert.match(preparePrDraft(defaultRunner(), state, red).body, /Host check: npm test — failed \(exit 3\)/);
    const stale = classifyVerification({ ...base, treeDigest: "other" }, identity);
    assert.match(preparePrDraft(defaultRunner(), state, stale).body, /Host check: stale/);
    const scope = newGoal("Fix parser without new dependencies", s.repo);
    const phase = newPhase(1, "Repair", "Fix parser");
    phase.run = newGoalPhaseRun(scope, phase, s.repo);
    phase.run.check = { state: "skipped", exitCode: null, reason: "operator skipped verification" };
    scope.phases = [phase];
    scope.activePhaseId = phase.id;
    scope.plan = { state: "accepted", source: "manual", stack: [], relevantFiles: ["src/parser.ts"], checks: [], instructions: [], assumptions: [], constraints: ["no new dependencies"], verification: { state: "unresolved", check: null } };
    const skipped = preparePrDraft(defaultRunner(), state, reading(s.repo), scope);
    assert.match(skipped.body, /Host check: skipped in the last goal attempt/);
    assert.match(skipped.body, /Accepted constraint: no new dependencies/);
    assert.match(skipped.body, /CI: not observed/);
    scope.plan.relevantFiles = ["unrelated.ts"];
    const unrelated = preparePrDraft(defaultRunner(), state, reading(s.repo), scope);
    assert.equal(unrelated.body.includes("no new dependencies"), false);
    assert.equal(unrelated.body.includes("skipped in the last goal attempt"), false);
  } finally { s.cleanup(); }
});

test("an edited multiline draft and explicit overrides reach gh as exact argv; draft and cancel never publish", async () => {
  const s = fixture(false);
  try {
    commitParser(s.repo);
    const { run, calls } = runner();
    const exportOut = sink();
    assert.equal(await runShip(ctx, deps(s.repo, run, exportOut.out), { yes: false, json: false, draft: true }), 0);
    assert.equal(calls.some(call => call.includes("push") || call[0] === "gh"), false);
    const draft = JSON.parse(exportOut.text()) as ReturnType<typeof preparePrDraft>;
    draft.title = "  User title ☃  ";
    draft.body = "# Edited\n\nLine two $(id) `uname`\n";
    const path = join(s.home, "edited.json");
    writeFileSync(path, JSON.stringify(draft));
    assert.deepEqual(readPreparedPrDraft(path), draft);

    const previewOut = sink();
    assert.equal(await runShip(ctx, deps(s.repo, run, previewOut.out), { yes: false, json: true, draftFile: path }), 0);
    const preview = JSON.parse(previewOut.text()) as { title: string; body: string; commands: Array<{ cmd: string; args: string[] }> };
    assert.equal(preview.title, draft.title);
    assert.equal(preview.body, draft.body);
    const plannedGh = preview.commands.find(command => command.cmd === "gh")!.args;
    assert.equal(plannedGh[plannedGh.indexOf("--title") + 1], draft.title);
    assert.equal(plannedGh[plannedGh.indexOf("--body") + 1], draft.body);

    const cancelOut = sink();
    assert.equal(await runShip(ctx, deps(s.repo, run, cancelOut.out, "n"), { yes: false, json: false, draftFile: path }), 1);
    assert.match(cancelOut.text(), /cancelled — nothing was published/);
    assert.equal(calls.some(call => call.includes("push") || call[0] === "gh"), false);

    const publishOut = sink();
    assert.equal(await runShip(ctx, deps(s.repo, run, publishOut.out), { yes: false, json: false, draftFile: path, approve: "publish" }), 0, publishOut.text());
    const created = calls.find(call => call[0] === "gh" && call[1] === "pr" && call[2] === "create")!;
    assert.equal(created[created.indexOf("--title") + 1], draft.title);
    assert.equal(created[created.indexOf("--body") + 1], draft.body);
    assert.equal(git(s.remote, "rev-parse", "refs/heads/feature/pr-draft").trim(), git(s.repo, "rev-parse", "HEAD").trim());
  } finally { s.cleanup(); }
});

test("head or base drift rejects an edited draft before push or PR", async () => {
  for (const drift of ["head", "base"] as const) {
    const s = fixture(false);
    try {
      commitParser(s.repo);
      const { run, calls } = runner();
      const exportOut = sink();
      await runShip(ctx, deps(s.repo, run, exportOut.out), { yes: false, json: false, draft: true, base: "main" });
      const path = join(s.home, "edited.json");
      writeFileSync(path, exportOut.text());
      if (drift === "head") {
        writeFileSync(join(s.repo, "src", "parser.ts"), "export const parse = (text: string) => text.normalize();\n");
        git(s.repo, "commit", "-am", "fix: revise parser");
      } else {
        git(s.repo, "switch", "main");
        writeFileSync(join(s.repo, "base.txt"), "new base\n");
        git(s.repo, "add", "-A");
        git(s.repo, "commit", "-m", "chore: advance base");
        git(s.repo, "push", "origin", "main");
        git(s.repo, "switch", "feature/pr-draft");
      }
      const out = sink();
      assert.equal(await runShip(ctx, deps(s.repo, run, out.out), { yes: false, json: false, draftFile: path, base: "main", approve: "publish" }), 1);
      assert.match(out.text(), /prepared PR draft is stale/);
      assert.equal(calls.some(call => call.includes("push") && call[0] === "git" && call.includes("refs/heads/feature/pr-draft:refs/heads/feature/pr-draft")), false);
      assert.equal(calls.some(call => call[0] === "gh"), false);
    } finally { s.cleanup(); }
  }
});

test("a revision changed during approval refuses publication after the preview", async () => {
  const s = fixture(false);
  try {
    commitParser(s.repo);
    const { run, calls } = runner();
    const out = sink();
    const io: PromptIO = {
      tty: true, note: () => {}, question: async () => {
        writeFileSync(join(s.repo, "src", "parser.ts"), "export const parse = (text: string) => text.normalize();\n");
        git(s.repo, "commit", "-am", "fix: change after preview");
        return "y";
      },
    };
    assert.equal(await runShip(ctx, { run, cwd: s.repo, out: out.out, io }, { yes: false, json: false }), 1);
    assert.match(out.text(), /prepared PR draft is stale.*nothing was published/s);
    assert.equal(calls.some(call => call[0] === "gh"), false);
    assert.equal(calls.some(call => call[0] === "git" && call.includes("push")), false);
  } finally { s.cleanup(); }
});

test("explicit title and body overrides remain byte-for-byte in the local preview", async () => {
  const s = fixture(false);
  try {
    commitParser(s.repo);
    const { run } = runner();
    const title = "  Exact title  ";
    const body = "\nA\n\nB ☃\n";
    const out = sink();
    await runShip(ctx, deps(s.repo, run, out.out), { yes: false, json: true, title, body });
    const preview = JSON.parse(out.text()) as { title: string; body: string };
    assert.equal(preview.title, title);
    assert.equal(preview.body, body);
  } finally { s.cleanup(); }
});
