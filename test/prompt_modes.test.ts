// test/prompt_modes.test.ts — table-driven prompt-mode rewrites (REPL slash modes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPromptMode } from "../src/commands/prompt_modes.js";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { handleSlash } from "../src/commands/slash.js";
import type { AppContext } from "../src/core/context.js";
import { tmpWorkspace } from "./tmp_workspace.js";

test("plain text is not handled", () => {
  assert.deepEqual(applyPromptMode("fix the tests"), { handled: false });
});

test("unknown slash is not handled (falls through to handleSlash)", () => {
  assert.deepEqual(applyPromptMode("/models"), { handled: false });
});

test("/recon rewrites with topic and notice", () => {
  const r = applyPromptMode("/recon auth flow");
  assert.equal(r.handled, true);
  assert.ok(r.prompt!.startsWith("RECONNAISSANCE MODE. Thoroughly research: auth flow."));
  assert.equal(r.notice, '🔎 Recon: "auth flow"');
});

test("/recon without topic returns usage error", () => {
  const r = applyPromptMode("/recon");
  assert.equal(r.handled, true);
  assert.equal(r.error, "usage: /recon <topic>");
});

test("/plan carries planning capability and returns the plan without a write", () => {
  const r = applyPromptMode("/plan Add OAuth2 Support!");
  assert.equal(r.handled, true);
  assert.equal(r.capability, "planning");
  assert.match(r.prompt!, /Return the plan in your response without writing files/);
  assert.doesNotMatch(r.prompt!, /Save to/);
});

test("/self-review and /code-review need no arg", () => {
  assert.ok(applyPromptMode("/self-review").prompt!.startsWith("SELF-REVIEW MODE."));
  assert.ok(applyPromptMode("/code-review").prompt!.startsWith("CODE REVIEW MODE."));
});

// ── the /review rename ─────────────────────────────────────────────
//
// The prose project-review macro used to be called `/review`. That name now
// belongs to the change-review rail (commands/review.ts, `aether review`), and
// the rename was forced rather than cosmetic: applyPromptMode runs BEFORE
// handleSlash and matches no-arg modes by PREFIX, so while the macro was called
// `/review` every `/review …` line was rewritten into a prompt and the slash
// dispatcher never saw it. Two commands could not share the name.
//
// What has to stay true is a ROUTING property — which handler a typed token
// reaches — not a membership property. "`/review` is absent from MODES" can stay
// true while the bug returns: re-add a mode named `/rev`, or loosen the prefix
// rule, and `/review` is silently a paid prompt rewrite again. So the guard
// below drives the real composition and asserts which handler produced the
// answer. The two membership tests are kept because they localise a failure
// cheaply — they are not the guard.

type Routed =
  | { via: "prompt-macro"; prompt: string; notice: string | undefined }
  | { via: "slash-dispatch"; output: string };

/**
 * The REPL submit path, mirrored from src/commands/chat.ts: applyPromptMode is
 * consulted first and, when it handles the line, the rewritten prompt is sent
 * as a normal turn — handleSlash NEVER sees it. Only an unhandled line reaches
 * the dispatcher. If chat.ts ever changes that order, change this with it.
 */
async function route(line: string, cwd: string): Promise<Routed> {
  const mode = applyPromptMode(line);
  if (mode.handled) {
    return { via: "prompt-macro", prompt: mode.prompt ?? mode.error ?? "", notice: mode.notice };
  }
  const chunks: string[] = [];
  const out = new PassThrough();
  out.on("data", (chunk) => chunks.push(String(chunk)));
  const ctx = { flags: { cwd, yes: false, json: false } } as unknown as AppContext;
  await handleSlash(ctx, line, out);
  return { via: "slash-dispatch", output: chunks.join("") };
}

/** A real repository, so the rail reads a real state rather than an error. */
function tempRepo(): { dir: string; cleanup: () => void } {
  const dir = tmpWorkspace("prompt-modes-");
  const git = (...args: string[]): void => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  };
  git("init", "-b", "main");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-m", "seed");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// THE GUARD. An outcome, not a declaration: the token is routed through the real
// composition and the handler that answered is identified by output only it can
// produce. This survives any future edit to the modes table or the prefix rule.
test("routing: /review reaches the review rail, /code-review reaches the macro", async () => {
  const repo = tempRepo();
  try {
    const rail = await route("/review help", repo.dir);
    assert.equal(rail.via, "slash-dispatch");
    // "usage: aether review" is written by commands/review.ts and by nothing else.
    assert.ok(
      rail.via === "slash-dispatch" && rail.output.includes("usage: aether review"),
      `/review did not reach the review rail; got ${JSON.stringify(rail)}`,
    );
    assert.ok(
      rail.via === "slash-dispatch" && !rail.output.includes("REVIEW MODE."),
      "/review was answered by the prompt macro",
    );

    const sweep = await route("/code-review", repo.dir);
    assert.equal(sweep.via, "prompt-macro");
    assert.ok(
      sweep.via === "prompt-macro" && sweep.prompt.startsWith("CODE REVIEW MODE."),
      "/code-review did not reach the code-review macro",
    );

    const prose = await route("/project-review", repo.dir);
    assert.equal(prose.via, "prompt-macro");
    assert.ok(
      prose.via === "prompt-macro" && prose.prompt.startsWith("REVIEW MODE."),
      "/project-review did not reach the prose macro",
    );
  } finally {
    repo.cleanup();
  }
});

// Cheap localisers. Neither one is the guard above.
test("/project-review is the prose macro, and does not swallow /code-review", () => {
  assert.ok(applyPromptMode("/code-review").prompt!.startsWith("CODE REVIEW MODE."));
  const r = applyPromptMode("/project-review");
  assert.equal(r.handled, true);
  assert.ok(r.prompt!.startsWith("REVIEW MODE."));
  assert.equal(r.notice, "🔍 Full project review in progress…");
});

test("/review is not a prompt mode under any spelling the dispatcher sees", () => {
  assert.deepEqual(applyPromptMode("/review"), { handled: false });
  assert.deepEqual(applyPromptMode("/review help"), { handled: false });
  assert.deepEqual(applyPromptMode("/review stage --all"), { handled: false });
  assert.deepEqual(applyPromptMode("/review --files a,b"), { handled: false });
});

test("/autonomous-execution embeds the task", () => {
  const r = applyPromptMode("/autonomous-execution ship it");
  assert.ok(r.prompt!.endsWith("Task: ship it"));
  assert.equal(r.notice, '🚀 Autonomous execution: "ship it"');
});

test("/subagent-driven-execution and /writing-plans and /research rewrite", () => {
  assert.ok(applyPromptMode("/subagent-driven-execution build x").prompt!.startsWith("EXECUTION MODE: subagent-driven."));
  assert.ok(applyPromptMode("/writing-plans topic").prompt!.startsWith("Write a detailed, actionable implementation plan"));
  assert.ok(applyPromptMode("/research topic").prompt!.startsWith("RESEARCH MODE."));
  assert.ok(applyPromptMode("/writing-skills").prompt!.startsWith("SKILL AUTHORING MODE."));
});
