import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  acquireMemoryWriterLease,
  appendJournalEvent,
  formatJournal,
  installBundledStrategies,
  listBundledStrategies,
  readJournal,
} from "aether-ats-skills";

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aether-agent-ats-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("the shipped ATS dependency holds one real writer lease on Windows and POSIX", async t => {
  const root = await temporary(t);
  const directory = resolve(root, "memory");
  await mkdir(directory);
  const ownerScope = { cloudOrigin: "https://api.aethersystems.net", accountSubject: "11111111-1111-4111-8111-111111111111" };
  await writeFile(join(directory, ".aether-ats-memory.json"), JSON.stringify({
    schema_version: "aether.ats.memory/1", state: "ready", persistence_verified: true,
    agent_id: "mag_atlas", directory,
    owner_scope: { cloud_origin: ownerScope.cloudOrigin, account_subject: ownerScope.accountSubject },
  }), { mode: 0o600 });
  const options = { directory, ownerScope, agentId: "mag_atlas", sizeGb: 5 };
  const first = await acquireMemoryWriterLease(options);
  assert.equal(first.receipt.lock_scope, "ats_runtime_writer");
  assert.equal(first.receipt.runtime_exclusivity_verified, true);
  await assert.rejects(acquireMemoryWriterLease(options), (error: Error & { code?: string }) => error.code === "MEMORY_LEASE_BUSY");
  await first.close();
  const second = await acquireMemoryWriterLease(options);
  await second.close();
});

test("the shipped ATS dependency contains exact Nano starters and a bounded journal", async t => {
  const root = await temporary(t);
  const library = await listBundledStrategies();
  assert.equal(library.revision, "76c91e4b926c0aa8416cbb6b8724031d8141a8d9");
  assert.equal(library.strategies.length, 55);
  const directory = resolve(root, "strategies");
  const installed = await installBundledStrategies({ directory, selection: "starter" });
  assert.equal(installed.installed.length, 6);
  assert.equal(installed.execution_enabled, false);
  assert.match(await readFile(installed.installed[0]!.file, "utf8"), /strategy\s+[A-Za-z]/);

  const journal = resolve(root, "journal.jsonl");
  await appendJournalEvent(journal, { agentId: "mag_atlas", type: "setup.ready", summary: "ATS setup verified.", details: { strategy_count: 6 } });
  const rows = await readJournal(journal);
  assert.equal(rows.length, 1);
  assert.match(formatJournal(rows), /setup\.ready/);
});
