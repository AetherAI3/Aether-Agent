import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PcActionBroker } from "../src/core/pc/broker.js";
import { PcFileAudit, PcHostGateway, type PcAuditEntry } from "../src/core/pc/gateway.js";

function broker() {
  return new PcActionBroker("session", "user", { interactive: true, approve: async () => true });
}

test("PC gateway flushes a redacted intent before effect and then records outcome", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aether-pc-audit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "audit.jsonl");
  const actionBroker = broker();
  const plan = actionBroker.plan({ adapter: "browser.open", operation: "open", target: "secret-target", expectedState: "ready" });
  const gateway = new PcHostGateway(actionBroker, new PcFileAudit(path));
  const receipt = await gateway.execute(plan, () => "ready", () => {
    const rows = readFileSync(path, "utf8").trim().split("\n").map((row) => JSON.parse(row) as PcAuditEntry);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.phase, "intent");
    return true;
  });
  assert.equal(receipt.status, "succeeded");
  const content = readFileSync(path, "utf8");
  assert.doesNotMatch(content, /secret-target/);
  const rows = content.trim().split("\n").map((row) => JSON.parse(row) as PcAuditEntry);
  assert.deepEqual(rows.map((row) => row.phase), ["intent", "outcome"]);
  assert.equal(rows[1]?.dispatched, true);
});

test("PC gateway makes failed intent logging a zero-effect denial", async () => {
  const actionBroker = broker();
  const plan = actionBroker.plan({ adapter: "browser.open", operation: "open", target: "claude", expectedState: "ready" });
  let effects = 0;
  const gateway = new PcHostGateway(actionBroker, { append: () => { throw new Error("disk unavailable"); } });
  const receipt = await gateway.execute(plan, () => "ready", () => { effects++; return true; });
  assert.equal(receipt.status, "denied");
  assert.equal(effects, 0);
});

test("PC gateway reports uncertain outcome after post-effect journal failure or adapter throw", async () => {
  for (const adapterThrows of [false, true]) {
    const actionBroker = broker();
    const plan = actionBroker.plan({ adapter: "browser.open", operation: "open", target: "claude", expectedState: "ready" });
    let effects = 0;
    const entries: PcAuditEntry[] = [];
    const gateway = new PcHostGateway(actionBroker, { append: (entry) => {
      entries.push(entry);
      if (entry.phase === "outcome" && !adapterThrows) throw new Error("disk full");
    } });
    const receipt = await gateway.execute(plan, () => "ready", () => {
      effects++;
      if (adapterThrows) throw new Error("launcher state unknown");
      return true;
    });
    assert.equal(receipt.status, "unknown");
    assert.equal(effects, 1);
    assert.deepEqual(entries.map((entry) => entry.phase), ["intent", "outcome"]);
  }
});
