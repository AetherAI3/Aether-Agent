import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type { Writable } from "node:stream";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ManagedAccountScope } from "../core/managed_agent_local.js";
import { managedChatInput } from "../ui/managed_chat_input.js";
import { leaseTerminalInput } from "../ui/input_lease.js";

export const ATS_POLICY_VERSION = "1.0.0";
export const ATS_POLICY_EFFECTIVE_DATE = "2026-09-18";
export const ATS_POLICY_SHA256 = "30a6e043617a9089f0306a8ee4b15054d33fac296bb8c284a9ec044c98a56154";
export const ATS_POLICY_URL = "https://github.com/AetherAI3/Aether-Agent/blob/main/ATS_ACCEPTABLE_USE_POLICY.md";

interface AtsPolicyReceipt {
  schema_version: "aether.ats.policy-consent/1";
  policy_version: string;
  policy_effective_date: string;
  policy_sha256: string;
  accepted_at: string;
  account_scope_sha256: string;
  decision: "accepted";
  grants_trading_authority: false;
}

export interface AtsPolicyAcceptanceOptions {
  root: string;
  account: ManagedAccountScope;
  signal?: AbortSignal;
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  out?: Writable;
}

function accountDigest(account: ManagedAccountScope): string {
  return createHash("sha256").update(account.cloudOrigin).update("\0").update(account.accountSubject).digest("hex");
}

export function atsPolicyReceiptPath(root: string, account: ManagedAccountScope): string {
  return join(root, "policy-consents", `${accountDigest(account)}.json`);
}

async function refuseLinks(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("ATS policy consent storage cannot follow a symbolic link."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function validReceipt(value: unknown, account: ManagedAccountScope): value is AtsPolicyReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<AtsPolicyReceipt>;
  return receipt.schema_version === "aether.ats.policy-consent/1"
    && receipt.policy_version === ATS_POLICY_VERSION
    && receipt.policy_effective_date === ATS_POLICY_EFFECTIVE_DATE
    && receipt.policy_sha256 === ATS_POLICY_SHA256
    && receipt.account_scope_sha256 === accountDigest(account)
    && receipt.decision === "accepted"
    && receipt.grants_trading_authority === false
    && typeof receipt.accepted_at === "string"
    && Number.isFinite(Date.parse(receipt.accepted_at));
}

async function readReceipt(path: string, account: ManagedAccountScope): Promise<AtsPolicyReceipt | null> {
  await refuseLinks(path);
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return validReceipt(parsed, account) ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeReceipt(path: string, account: ManagedAccountScope): Promise<void> {
  await refuseLinks(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const receipt: AtsPolicyReceipt = {
    schema_version: "aether.ats.policy-consent/1",
    policy_version: ATS_POLICY_VERSION,
    policy_effective_date: ATS_POLICY_EFFECTIVE_DATE,
    policy_sha256: ATS_POLICY_SHA256,
    accepted_at: new Date().toISOString(),
    account_scope_sha256: accountDigest(account),
    decision: "accepted",
    grants_trading_authority: false,
  };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(receipt, null, 2) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

const NOTICE = `
Aether ATS Autonomous Trading Policy v${ATS_POLICY_VERSION} (${ATS_POLICY_EFFECTIVE_DATE})

ATS can use autonomous agents, bundled Nano strategies, browser tools, plugins,
datafeeds and MCP connections. If you separately enable execution, orders run
through accounts, credentials and infrastructure that you select and control.

Material terms:
  • Trading can cause rapid, substantial or total loss, including losses beyond deposits.
  • Aether provides software, not individualized investment, legal or tax advice.
  • Strategies, backtests, data and AI outputs can be wrong, stale or unsuitable.
  • You control execution authority and are responsible for supervision, limits,
    reconciliation, broker/venue terms, regulatory compliance, taxes and losses.
  • Plugins, browser pages, datafeeds and MCP servers are independent, untrusted
    third parties and may process data under their own terms.
  • Do not put broker secrets, private keys or passwords in prompts, chats or files.
  • Acceptance does not connect a broker or grant this agent trading authority.
  • Warranty, liability and indemnity terms apply, subject to non-waivable law.

Full policy (bundled as ATS_ACCEPTABLE_USE_POLICY.md):
${ATS_POLICY_URL}
SHA-256: ${ATS_POLICY_SHA256}

1 — Accept and continue
2 — Reject and stop setup
`;

/** Require versioned clickwrap before any ATS draft, storage, strategy or connector setup. */
export async function requireAtsPolicyAcceptance(options: AtsPolicyAcceptanceOptions): Promise<boolean> {
  const input = options.input ?? process.stdin;
  const out = options.out ?? process.stdout;
  const path = atsPolicyReceiptPath(options.root, options.account);
  if (await readReceipt(path, options.account)) return true;
  if (!input.isTTY) throw new Error("ATS policy acceptance requires an interactive terminal. Run `aether agent create ATS <name>` and choose 1 or 2.");
  options.signal?.throwIfAborted();
  const release = leaseTerminalInput(input);
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  const active = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const owned = managedChatInput(input);
  const reader = createInterface({ input: owned.input, output: out, terminal: true });
  reader.on("SIGINT", cancel);
  reader.on("close", cancel);
  try {
    out.write(NOTICE);
    for (;;) {
      const answer = (await reader.question("Choice [2]: ", { signal: active })).trim() || "2";
      if (answer === "2") return false;
      if (answer === "1") { await writeReceipt(path, options.account); return true; }
      out.write("Enter 1 to accept or 2 to reject.\n");
    }
  } finally {
    reader.removeListener("SIGINT", cancel);
    reader.removeListener("close", cancel);
    reader.close();
    owned.dispose();
    release();
  }
}
