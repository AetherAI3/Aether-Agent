// Hosted console authentication repair. No method here invokes a model.
// A failed request is retained separately from the live input buffer.
import type { AppContext } from "../core/context.js";
import { isApiKeyToken, unsetEnvTokenCommand } from "../core/auth.js";
import { HttpError } from "../core/errors.js";
import { MODELS_PATH } from "../core/transport.js";
import { cmdLogin } from "./login.js";
import { invalidateCatalog } from "./slash.js";
import type { TurnOutcome } from "../core/turn_lifecycle.js";

export interface FailedHostedTask {
  instruction: string;
  turnId: string;
  receipts: readonly string[];
  /** Only a rejected HTTP request proves the server did not accept the turn. */
  rejectedBeforeAcceptance: boolean;
}

export type RepairState = "idle" | "login-needed" | "ready" | "uncertain" | "account-change" | "identity-unknown";

export function isHosted401(error: unknown): boolean {
  return error instanceof HttpError && error.status === 401
    && !/(?:insufficient|empty|exhausted|depleted|out[ -]?of).{0,24}(?:uvt|balance|credit)|(?:uvt|balance|credit).{0,24}(?:insufficient|empty|exhausted|depleted)|payment.required/i.test(error.message);
}

export class ConsoleAuthRepair {
  private accountId: string | null = null;
  private failed: FailedHostedTask | null = null;
  private conversationStarted = false;
  state: RepairState = "idle";

  constructor(private readonly ctx: AppContext) {}

  get pending(): FailedHostedTask | null { return this.failed; }
  markHostedTurnStarted(): void { this.conversationStarted = true; }
  get submissionBlocked(): boolean { return this.state === "account-change" || this.state === "identity-unknown"; }

  /** Fetches the live owner before a hosted turn, when possible. */
  async captureAccount(): Promise<void> {
    if (this.accountId) return;
    try {
      const catalog = await this.ctx.api.getJson<{ account_id?: unknown }>(MODELS_PATH);
      if (typeof catalog.account_id === "string" && catalog.account_id.trim()) {
        this.accountId = catalog.account_id;
      }
    } catch { /* the turn itself will show the precise failure */ }
  }

  noteFailure(error: unknown, instruction: string, outcome: TurnOutcome | undefined, receipts: readonly string[]): boolean {
    if (!isHosted401(error) && !/^HTTP 401(?:\b|:)/i.test(outcome?.message ?? "")) return false;
    this.failed = {
      instruction,
      turnId: outcome?.turnId ?? "unknown",
      receipts: [...receipts],
      rejectedBeforeAcceptance: isHosted401(error) && receipts.length === 0,
    };
    this.state = "login-needed";
    return true;
  }

  async status(): Promise<string> {
    const token = await this.ctx.tokens.get();
    const source = await this.ctx.tokens.sourceInfo?.().catch(() => undefined);
    const sourceText = source?.source === "environment"
      ? `AETHER_TOKEN environment override${source.storedCredentialShadowed ? " (shadows a saved login)" : ""}`
      : source?.source === "stored" ? "saved CLI login" : source?.source ?? "none";
    const kind = token ? (isApiKeyToken(token) ? "API key" : "session token") : "none";
    let verification = "signed out";
    if (token) {
      try {
        const catalog = await this.ctx.api.getJson<{ account_id?: unknown }>(MODELS_PATH);
        verification = "verified";
        const freshId = typeof catalog.account_id === "string" && catalog.account_id.trim() ? catalog.account_id : null;
        if (this.failed) {
          this.state = !this.accountId || !freshId ? "identity-unknown"
            : this.accountId !== freshId ? "account-change"
              : this.failed.rejectedBeforeAcceptance ? "ready" : "uncertain";
        }
        if (!this.accountId) this.accountId = freshId;
      } catch (error) {
        verification = error instanceof HttpError
          ? error.status === 401 && !isHosted401(error) ? "balance or entitlement problem (reported as 401)"
            : error.status === 401 ? isApiKeyToken(token) ? "API key rejected (401)" : "session expired (401)"
              : error.status === 402 ? "balance required (402)"
            : error.status === 403 ? "access forbidden (403)" : error.status === 429 ? "rate limited (429)"
              : `server error (${error.status})`
          : "API unavailable; credential unverified";
      }
    }
    const lines = [`Auth: ${verification}; ${kind}; source: ${sourceText}.`];
    if (source?.source === "environment" || (process.env["AETHER_TOKEN"] ?? "").trim()) {
      lines.push(`AETHER_TOKEN overrides stored login in new processes. To change it: ${unsetEnvTokenCommand()}; then /auth status.`);
    }
    if (this.failed) lines.push(`Failed task ${this.failed.turnId} is saved separately from your draft.`);
    if (this.failed?.receipts.length) lines.push(`Known work receipts: ${this.failed.receipts.join("; ")}.`);
    if (this.state === "login-needed" && (verification === "API key rejected (401)" || verification === "session expired (401)" || verification === "signed out")) lines.push("Use /auth login to repair this session.");
    if (this.state === "login-needed" && /(?:balance|forbidden|rate limited)/.test(verification)) lines.push("Sign-in will not fix this response; resolve the account or rate limit first.");
    if (this.state === "ready") lines.push("Same account verified. Use /auth continue to submit the saved task explicitly.");
    if (this.state === "uncertain") lines.push("The prior turn may have run. Review its receipts and workspace before giving a new instruction; /auth continue is disabled.");
    if (this.state === "account-change") lines.push("Different account. Use /auth new to start a new conversation; the failed task will not be submitted.");
    if (this.state === "identity-unknown") lines.push("Account identity unavailable. Use /auth new to start a new conversation; automatic continuation is disabled.");
    return lines.join("\n") + "\n";
  }

  async login(signal?: AbortSignal, noBrowser = false): Promise<string> {
    if (this.ctx.flags.local) return "Offline mode does not use hosted login.\n";
    const source = await this.ctx.tokens.sourceInfo?.().catch(() => undefined);
    const result = await cmdLogin(this.ctx, { noBrowser }, undefined, signal);
    if (result !== 0 || signal?.aborted) return "Login was cancelled or failed. The task and draft are still available.\n";
    const after = await this.ctx.tokens.get();
    const newSource = await this.ctx.tokens.sourceInfo?.().catch(() => undefined);
    if (!after || (source?.source === "environment" && newSource?.source === "environment")) {
      return `Login did not replace the active environment credential. ${unsetEnvTokenCommand()}; then /auth status.\n`;
    }
    let freshId: string | null = null;
    try {
      const catalog = await this.ctx.api.getJson<{ account_id?: unknown }>(MODELS_PATH, signal);
      freshId = typeof catalog.account_id === "string" && catalog.account_id.trim() ? catalog.account_id : null;
      invalidateCatalog();
    } catch (error) {
      this.state = this.conversationStarted ? "identity-unknown" : "idle";
      return `Signed in, but the model catalog could not be refreshed (${error instanceof HttpError ? `HTTP ${error.status}` : "API unavailable"}). The saved task was not submitted.\n`;
    }
    if (this.conversationStarted && this.accountId && freshId && this.accountId !== freshId) {
      this.state = "account-change";
      return "Signed in to a different account. Use /auth new for a fresh conversation; no saved task was submitted.\n";
    }
    if (this.conversationStarted && (!this.accountId || !freshId)) {
      this.state = "identity-unknown";
      return "Signed in, but the prior account could not be proven. Use /auth new for a fresh conversation.\n";
    }
    this.accountId = freshId;
    this.state = this.failed ? (this.failed.rejectedBeforeAcceptance ? "ready" : "uncertain") : "idle";
    return this.failed
      ? this.state === "ready"
        ? "Signed in to the same account; model catalog refreshed. Use /auth continue to submit the saved task explicitly.\n"
        : "Signed in to the same account; model catalog refreshed. The earlier turn may have run, so review receipts and workspace before a new instruction.\n"
      : "Signed in; model catalog refreshed.\n";
  }

  takeContinuation(): FailedHostedTask | null {
    if (this.state !== "ready" || !this.failed || !this.failed.rejectedBeforeAcceptance) return null;
    const task = this.failed;
    this.failed = null;
    this.state = "idle";
    return task;
  }

  startNewConversation(): string {
    if (this.state !== "account-change" && this.state !== "identity-unknown") return "No account change needs a new conversation.\n";
    this.failed = null;
    this.state = "idle";
    this.accountId = null;
    this.conversationStarted = false;
    return "New conversation started. The previous task was not submitted; recall it from history if history is enabled.\n";
  }
}
