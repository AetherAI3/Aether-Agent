import { test } from "node:test";
import assert from "node:assert/strict";
import { registerRestore, runRestores, restoreCount } from "../src/ui/restore.js";

test("registerRestore runs steps once, LIFO, and consumes them", () => {
  const order: string[] = [];
  const prior = restoreCount();
  registerRestore(() => order.push("outer"));
  registerRestore(() => order.push("inner"));
  assert.equal(restoreCount(), prior + 2);
  runRestores();
  assert.deepEqual(order, ["inner", "outer"]); // innermost surface restores first
  assert.equal(restoreCount(), 0);
  runRestores(); // second run is a no-op
  assert.deepEqual(order, ["inner", "outer"]);
});

test("unregister removes the step so clean teardown never double-runs", () => {
  let runs = 0;
  const un = registerRestore(() => {
    runs += 1;
  });
  un();
  runRestores();
  assert.equal(runs, 0);
});

test("a throwing step never blocks the remaining steps", () => {
  let ran = false;
  registerRestore(() => {
    ran = true;
  });
  registerRestore(() => {
    throw new Error("terminal gone");
  });
  runRestores(); // must not throw
  assert.equal(ran, true);
});

test("process hooks install once (no listener stacking across registers)", () => {
  const before = process.listeners("exit").length;
  const u1 = registerRestore(() => {});
  const u2 = registerRestore(() => {});
  const after = process.listeners("exit").length;
  assert.ok(after - before <= 1, `exit listeners grew by ${after - before}`);
  u1();
  u2();
});
