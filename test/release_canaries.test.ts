// Release canaries — executable gates, not a checklist someone remembers.
//
// The integration proof for the A0–A5 wave listed seven canaries and recorded
// that none of them ran. This file makes the ones that CAN run run on every
// build, so they cannot quietly lapse again.
//
// Coverage map, stated honestly:
//
//   1 denied mutation        HERE
//   2 live-child cancel      test/process_tree.test.ts  (whole tree, by pid)
//   3 reconnect replay       HERE
//   4 remote freshness       test/worktree.test.ts      (real git, pinned base)
//   5 fake-gh ship           test/ship_rail.test.ts + test/review_ship_e2e.test.ts
//   6 cap across reconnect   HERE
//   7 brain parity           test/brain_parity.test.ts  (injectable seam, #87)
//
// This map was accurate when written and stopped being accurate two commits
// later: #86 landed the ship rail and canary 5 with it, #87 landed the parity
// seam and canary 7. The closing note that said both were unwritable outlived
// the condition it described. A stale "not covered" reads as a standing excuse
// not to write the test, which is how a gap survives being closed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpWorkspace } from "./tmp_workspace.js";
import { ToolExecutor } from "../src/core/tool_executor.js";
import { ContextRegistry } from "../src/core/context_registry.js";

// ── Canary 1: a refused mutation changes nothing on disk ────────────────────

test("canary 1: a refused write never lands, and the write path is real", async () => {
  // bridge.test.ts already proves the brain receives a refusal. What it does
  // not check is the disk. A gate that refuses in the transcript while the
  // write still lands is the failure that matters, and it would pass there.
  const dir = tmpWorkspace("aether-canary1-");
  const target = join(dir, "guarded.txt");
  writeFileSync(target, "ORIGINAL\n");
  const exec = new ToolExecutor(dir);

  // A path escaping the workspace is refused by the executor itself — the one
  // denial drivable end to end without standing up a host loop.
  const refused = await exec.executeAsync("write_file", { path: "../escaped.txt", content: "x" });
  assert.notEqual(refused.exitCode, 0, "an escaping path must be refused");
  assert.match(refused.output, /refus|denied|outside/i);
  assert.equal(existsSync(join(dir, "..", "escaped.txt")), false, "nothing may be written outside the workspace");
  assert.equal(readFileSync(target, "utf8"), "ORIGINAL\n", "an unrelated file must be untouched");

  // Prove the write path really would have changed it, so the assertions above
  // are not vacuously passing against a broken executor.
  const prior = JSON.parse((await exec.executeAsync("read_file", { path: "guarded.txt" })).output);
  const allowed = await exec.executeAsync("write_file", { path: "guarded.txt", content: "REPLACED\n", expected_revision: prior.revision, replace_token: prior.replace_token });
  assert.equal(allowed.exitCode, 0);
  assert.equal(
    readFileSync(target, "utf8"),
    "REPLACED\n",
    "the write path must be real, or the refusal proves nothing",
  );
});

// ── Canary 3: a replayed terminal frame settles a turn once ─────────────────

test("canary 3: a turn replayed after reconnect is counted exactly once", () => {
  // A reconnect re-delivers frames from the last acknowledged sequence. If the
  // terminal frame settles twice, the session's recorded spend doubles silently.
  const reg = new ContextRegistry();

  reg.beginTurn("turn-1");
  reg.settleTurn("turn-1", 1200);

  // connection drops; client reconnects; server replays the same frame
  reg.settleTurn("turn-1", 1200);
  reg.settleTurn("turn-1", 1200);

  assert.equal(reg.uvtObserved, 1200, "a replayed terminal frame must not accumulate");

  // A genuinely new turn still counts, so dedupe is not over-suppressing.
  reg.beginTurn("turn-2");
  reg.settleTurn("turn-2", 300);
  assert.equal(reg.uvtObserved, 1500);
});

// ── Canary 6: the operator cap survives a reconnect ─────────────────────────

test("canary 6: the cap stops the next turn even when frames were replayed", () => {
  const reg = new ContextRegistry();
  reg.setUvtCap(1000);

  reg.beginTurn("t1");
  reg.settleTurn("t1", 600);
  assert.equal(reg.checkUvtCap().capped, false, "600 of 1000 is not yet the boundary");

  // Reconnect replays t1. Without dedupe this reads as 1200 and trips the cap
  // early — the opposite failure, but still a lie about what was spent.
  reg.settleTurn("t1", 600);
  assert.equal(reg.uvtObserved, 600, "replay must not inflate observed spend");
  assert.equal(reg.checkUvtCap().capped, false);

  reg.beginTurn("t2");
  reg.settleTurn("t2", 400);
  const at = reg.checkUvtCap();
  assert.equal(at.capped, true, "reaching the cap counts as reaching it");
  assert.equal(at.remaining, 0);
  assert.equal(at.observed, 1000);
});

test("canary 6b: an unmeasured session is never reported as capped", () => {
  // The dangerous inverse: treating "no usage frame arrived" as zero spend, and
  // letting work continue against a cap nobody has measured against.
  const reg = new ContextRegistry();
  reg.setUvtCap(1000);
  const check = reg.checkUvtCap();
  assert.equal(check.capped, false);
  assert.equal(check.observed, null, "unknown is not zero");
  assert.equal(check.remaining, null, "unmeasured headroom is not the full cap");
  assert.equal(reg.usageStatus(), "unknown");
});

// ── Canary 5 — fake-gh ship. WRITTEN. ───────────────────────────────────────
//
// It used to say: "There is no PR-creation path to exercise. repo.ts's
// prCreateHint returns a STRING for the user to run; no subprocess ever invokes
// `gh pr create`." Both halves are now false. `aether ship` / `/ship` invoke it,
// and the run tail offers it instead of printing it.
//
// The canary lives in two files rather than one, split by layer:
//   test/ship_rail.test.ts       — the argv boundary, fake gh, hostile strings.
//   test/review_ship_e2e.test.ts — the whole rail through the real command
//                                  entry points: a real repository, a real bare
//                                  remote, the refs that actually moved, and
//                                  the exact `gh pr create` argv.

// ── The map above is enforced, not asserted in prose ────────────────────────
//
// Canaries 2, 4, 5 and 7 live in other files. A coverage map that only claims
// they exist is a comment, and comments do not fail when the file they name is
// deleted or renamed — which is precisely how the previous version of this
// header went stale in the other direction.
// It also went stale in this one: main's closing note still called canary 7
// unwritable after #87 had landed the injectable parity seam and
// test/brain_parity.test.ts. Enforcing the map is what stops either kind of
// untruth from surviving a merge.

test("every canary this file delegates is a real file with real assertions", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const delegated: Array<[string, string]> = [
    ["canary 2 (live-child cancel)", "process_tree.test.js"],
    ["canary 4 (remote freshness)", "worktree.test.js"],
    ["canary 5 (fake-gh ship, argv boundary)", "ship_rail.test.js"],
    ["canary 5 (fake-gh ship, end to end)", "review_ship_e2e.test.js"],
    ["canary 7 (brain parity)", "brain_parity.test.js"],
  ];
  for (const [canary, file] of delegated) {
    // Read the TypeScript source, not the compiled copy: a test file that
    // compiled to an empty module would still exist on disk under dist/.
    const source = join(here, "..", "..", "test", file.replace(/\.js$/, ".ts"));
    assert.equal(existsSync(source), true, `${canary}: ${source} does not exist`);
    const text = readFileSync(source, "utf8");
    assert.ok(/\bassert\./.test(text), `${canary}: ${file} contains no assertions`);
    assert.ok(
      (text.match(/^test\(/gm) ?? []).length > 0,
      `${canary}: ${file} declares no top-level tests`,
    );
  }
});
