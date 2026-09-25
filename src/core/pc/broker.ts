import { createHash, randomUUID } from "node:crypto";

/** A host-built request. Model text, page content and tool output cannot mint it. */
export interface PcActionRequest {
  adapter: string;
  operation: string;
  target: string;
  expectedState: string;
}

export interface PcActionPlan extends PcActionRequest {
  id: string;
  sessionId: string;
  userId: string;
  expiresAt: number;
}

export interface PcActionReceipt {
  planId: string;
  status: "succeeded" | "denied" | "stale" | "failed";
  reason: string;
  observedAt: string;
}

export interface PcApprovalPort {
  /** Must be supplied by the local interactive host, never by a model. */
  interactive: boolean;
  approve(plan: Readonly<PcActionPlan>): Promise<boolean>;
}

interface StoredPlan {
  plan: PcActionPlan;
  digest: string;
}

function fingerprint(request: PcActionRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([request.adapter, request.operation, request.target, request.expectedState]))
    .digest("hex");
}

/** In-memory, single-use grant authority for PC actions in one local session. */
export class PcActionBroker {
  private readonly plans = new Map<string, StoredPlan>();
  private revoked = false;

  constructor(
    private readonly sessionId: string,
    private readonly userId: string,
    private readonly approval: PcApprovalPort,
    private readonly now: () => number = Date.now,
  ) {}

  plan(request: PcActionRequest, ttlMs = 30_000): PcActionPlan {
    if (this.revoked) throw new Error("PC session revoked");
    if (!request.adapter || !request.operation || !request.target || !request.expectedState) {
      throw new Error("PC action target and expected state are required");
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60_000) {
      throw new Error("PC action lifetime must be 1–60000 ms");
    }
    const plan: PcActionPlan = {
      ...request,
      id: randomUUID(),
      sessionId: this.sessionId,
      userId: this.userId,
      expiresAt: this.now() + ttlMs,
    };
    this.plans.set(plan.id, { plan, digest: fingerprint(plan) });
    return Object.freeze(plan);
  }

  revoke(): void {
    this.revoked = true;
    this.plans.clear();
  }

  /** Re-observe immediately before the effect. Consume the plan even on denial. */
  async execute(
    candidate: PcActionPlan,
    observe: () => Promise<string> | string,
    perform: () => Promise<boolean> | boolean,
  ): Promise<PcActionReceipt> {
    const receipt = (status: PcActionReceipt["status"], reason: string): PcActionReceipt => ({
      planId: candidate.id, status, reason, observedAt: new Date(this.now()).toISOString(),
    });
    const stored = this.plans.get(candidate.id);
    this.plans.delete(candidate.id);
    if (this.revoked || !stored) return receipt("denied", "revoked, unknown or already used plan");
    const plan = stored.plan;
    if (plan.sessionId !== this.sessionId || plan.userId !== this.userId ||
        candidate.sessionId !== this.sessionId || candidate.userId !== this.userId ||
        fingerprint(candidate) !== stored.digest || candidate.expiresAt !== plan.expiresAt) {
      return receipt("denied", "plan identity or action changed");
    }
    if (this.now() >= plan.expiresAt) return receipt("denied", "plan expired");
    if (!this.approval.interactive) return receipt("denied", "interactive approval unavailable");
    try {
      if (!await this.approval.approve(plan)) return receipt("denied", "user declined action");
      if (this.revoked || this.now() >= plan.expiresAt) return receipt("denied", "grant revoked or expired");
      if (await observe() !== plan.expectedState) return receipt("stale", "target state changed");
      if (this.revoked) return receipt("denied", "grant revoked");
      return await perform()
        ? receipt("succeeded", "action dispatched; target outcome may require separate verification")
        : receipt("failed", "adapter did not dispatch the action");
    } catch {
      return receipt("failed", "approval, observation or action failed");
    }
  }
}
