import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, lstat, unlink, readdir, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AppContext } from "./context.js";
import { configDir } from "./config.js";
import { managedAccountOperation, type ManagedAccountScope } from "./managed_agent_local.js";
import { type ManagedAgent, type ManagedAgentConfig } from "./managed_agents.js";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
async function safePath(path: string): Promise<void> {
  let cursor = resolve(path);
  for (;;) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Agent creation state cannot follow symbolic links."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(cursor); if (parent === cursor) return; cursor = parent;
  }
}

/** Persist the nonce before POST under Cloud’s canonical account identity.
 * Token rotation preserves retries; another account gets a separate intent. */
export async function createManagedDraft(ctx: AppContext, config: ManagedAgentConfig, options: { root?: string; signal?: AbortSignal } = {}): Promise<{ agent: ManagedAgent; accountScope: ManagedAccountScope; complete(): Promise<void> }> {
  options.signal?.throwIfAborted();
  const operation = await managedAccountOperation(ctx, options.signal);
  const { client, account: accountScope } = operation;
  const origin = accountScope.cloudOrigin;
  const configDigest = digest(stable(config));
  const legacy = join(options.root ?? join(configDir(), "managed-agents"), "pending-create", digest(origin), configDigest);
  await safePath(legacy);
  try { await lstat(legacy); throw new Error("Legacy creation is pending without a verified account owner. Reconcile it before creating again; automatic adoption is disabled."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const directory = join(options.root ?? join(configDir(), "managed-agents"), "pending-create", digest(JSON.stringify([origin, accountScope.accountSubject])), configDigest);
  await safePath(directory);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const fresh = { schema_version: "aether.managed-agent-create/2", origin, account_subject: accountScope.accountSubject, config_digest: configDigest, idempotency_key: randomUUID() };
  let createdDirectory = false;
  try { await mkdir(directory, { mode: 0o700 }); createdDirectory = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (createdDirectory) {
    const file = await open(join(directory, `${fresh.idempotency_key}.json`), "wx", 0o600);
    try { await file.writeFile(JSON.stringify(fresh) + "\n"); await file.sync(); }
    finally { await file.close(); }
  }
  const entries = await readdir(directory);
  if (entries.length !== 1 || !/^[0-9a-f-]{36}\.json$/.test(entries[0]!)) {
    throw new Error("Agent creation is being prepared or its state is incomplete. Retry after the other command finishes; preserve incomplete state for reconciliation.");
  }
  const path = join(directory, entries[0]!);
  const info = await lstat(path);
  if (!info.isFile() || info.size > 8192) throw new Error("Pending agent creation state is invalid. Preserve it and reconcile the account before retrying.");
  let intent: typeof fresh;
  try { intent = JSON.parse(await readFile(path, "utf8")) as typeof fresh; }
  catch { throw new Error("Pending agent creation is incomplete. Preserve its state and reconcile before retrying."); }
  if (intent.schema_version !== fresh.schema_version || intent.origin !== origin || intent.account_subject !== accountScope.accountSubject || intent.config_digest !== configDigest
      || !/^[0-9a-f-]{36}$/.test(intent.idempotency_key) || entries[0] !== `${intent.idempotency_key}.json`) throw new Error("Pending agent creation does not match this operation. Reconcile before retrying.");
  await operation.assertCurrent();
  options.signal?.throwIfAborted();
  const created = await client.create(config, intent.idempotency_key, options.signal);
  await operation.assertCurrent();
  const agent = await client.get(created.agent_id, options.signal);
  if (await client.identity(options.signal) !== accountScope.accountSubject) throw new Error("The account changed during creation. Preserve pending state and reconcile each account before retrying.");
  await operation.assertCurrent();
  return { agent, accountScope, async complete() {
    // Each operation removes only its immutable nonce file. A delayed completion
    // cannot remove a new operation created later for the same configuration.
    await safePath(path);
    try { await unlink(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    try { await rmdir(directory); }
    catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  } };
}
