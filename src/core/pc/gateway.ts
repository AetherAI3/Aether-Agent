import { createHash } from "node:crypto";
import { existsSync, fsyncSync, lstatSync, mkdirSync, openSync, closeSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PcActionBroker, type PcActionPlan, type PcActionReceipt } from "./broker.js";

/** Fixed, redacted fields only. Target identifiers are hashed before storage. */
export interface PcAuditEntry {
  phase: "intent" | "outcome";
  planId: string;
  adapter: string;
  operation: string;
  targetDigest: string;
  observedAt: string;
  dispatched?: boolean;
}

export interface PcAuditPort {
  append(entry: PcAuditEntry): Promise<void> | void;
}

const MAX_AUDIT_BYTES = 5 * 1024 * 1024;

export function defaultPcAuditPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = process.platform === "win32"
    ? env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local")
    : env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  return join(root, "AetherAgent", "pc-actions.jsonl");
}

/** Small, bounded local journal. A failed pre-effect append refuses the action. */
export class PcFileAudit implements PcAuditPort {
  constructor(private readonly path: string = defaultPcAuditPath()) {}

  append(entry: PcAuditEntry): void {
    const line = JSON.stringify(entry) + "\n";
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > 1024) throw new Error("PC audit record exceeds limit");
    const parent = dirname(this.path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (lstatSync(parent).isSymbolicLink()) throw new Error("PC audit directory is a link");
    if (existsSync(this.path)) {
      if (lstatSync(this.path).isSymbolicLink()) throw new Error("PC audit file is a link");
      if (statSync(this.path).size + bytes > MAX_AUDIT_BYTES) throw new Error("PC audit journal is full");
    }
    const fd = openSync(this.path, "a", 0o600);
    try {
      if (writeSync(fd, line) !== bytes) throw new Error("PC audit write incomplete");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

function auditEntry(plan: PcActionPlan, phase: PcAuditEntry["phase"], dispatched?: boolean): PcAuditEntry {
  const entry: PcAuditEntry = {
    phase,
    planId: plan.id,
    adapter: plan.adapter,
    operation: plan.operation,
    targetDigest: createHash("sha256").update(plan.target).digest("hex"),
    observedAt: new Date().toISOString(),
  };
  if (dispatched !== undefined) entry.dispatched = dispatched;
  return entry;
}

/** Use the v1 one-use broker while making the write-ahead audit mandatory. */
export class PcHostGateway {
  constructor(
    private readonly broker: PcActionBroker,
    private readonly audit: PcAuditPort,
  ) {}

  async execute(
    plan: PcActionPlan,
    observe: () => Promise<string> | string,
    perform: () => Promise<boolean> | boolean,
  ): Promise<PcActionReceipt> {
    let intentFailed = false;
    let outcomeFailed = false;
    let performFailed = false;
    const receipt = await this.broker.execute(plan, observe, async () => {
      try {
        await this.audit.append(auditEntry(plan, "intent"));
      } catch {
        intentFailed = true;
        return false; // No adapter call after an unavailable intent journal.
      }
      let dispatched = false;
      try {
        dispatched = await perform();
      } catch {
        // An adapter can throw after issuing an external effect. Its outcome
        // is unknown until a separate observation reconciles it.
        performFailed = true;
      } finally {
        try {
          await this.audit.append(auditEntry(plan, "outcome", performFailed ? undefined : dispatched));
        } catch {
          outcomeFailed = true;
        }
      }
      return dispatched;
    });
    if (intentFailed) return { ...receipt, status: "denied", reason: "PC audit unavailable; action not dispatched" };
    if (outcomeFailed || performFailed) return { ...receipt, status: "unknown", reason: "action outcome is uncertain; verify before retry" };
    return receipt;
  }
}
