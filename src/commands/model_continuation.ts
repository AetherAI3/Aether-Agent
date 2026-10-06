// A reviewed, one-use bridge between console models. This is deliberately a
// brief, not a replay of the conversation or the user's terminal history.
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { redactInline, readRepoIdentity, type RepoIdentity } from "../core/session_log.js";
import { defaultRunner } from "../core/worktree.js";
import { sanitizeTerm } from "../ui/text.js";

export interface ContinuationState {
  workspace: string;
  account: string;
  rulesDigest: string;
  repo?: RepoIdentity;
  workspaceStatus?: string;
}

export interface ObservedTool {
  name: string;
  path?: string;
  exitCode: number;
}

export interface ModelTarget {
  id: string;
  label: string;
  contextWindow: number | null;
  destination: "local" | "cloud";
}

export interface SwitchProposal {
  target: ModelTarget;
  source: ContinuationState;
  brief: string;
  omitted: number;
}

const safe = (value: string, limit = 600): string => {
  const source = sanitizeTerm(value).replace(/\r/g, " ").trim()
    .replace(/-----BEGIN [^-\r\n]+-----[\s\S]*/g, "[REDACTED KEY]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
  const redacted = redactInline(source);
  const truncated = source.length > 512 || redacted.length > limit;
  return redacted.slice(0, limit) + (truncated ? " [truncated]" : "");
};

/** A digest is kept only in memory for drift comparison; no credential bytes
 * or digest appear in the brief sent to either destination. */
export function accountFingerprint(token: string | null): string {
  return token ? createHash("sha256").update(token).digest("hex") : "signed-out";
}

export function consoleWorkspaceState(cwd: string, account: string, rulesDigest = ""): ContinuationState {
  const rawStatus = gitStatus(cwd);
  return {
    workspace: resolve(cwd), account, rulesDigest, repo: readRepoIdentity(cwd, defaultRunner()),
    workspaceStatus: rawStatus === null ? "unavailable" : createHash("sha256").update(rawStatus).digest("hex"),
  };
}

/** Only paths and Git status codes are read. No diff, file contents, or shell
 * output enters the continuation record. */
function gitStatus(cwd: string): string | null {
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
    cwd, encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024, shell: false,
  });
  return result.status === 0 ? result.stdout : null;
}

export function observedWorkspaceChanges(cwd: string): string[] {
  const rawStatus = gitStatus(cwd);
  if (rawStatus === null || !rawStatus) return [];
  const entries = rawStatus.split("\0");
  const paths: string[] = [];
  let omitted = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status.includes("R") || status.includes("C")) i++; // skip rename source
    if (paths.length < 40) paths.push(`${status.includes("D") ? "deleted" : "changed"}: ${safe(path, 220)}`);
    else omitted++;
  }
  if (omitted) paths.push(`[${omitted} additional workspace paths omitted]`);
  return paths;
}

export class ConsoleTaskContinuation {
  sessionId = randomUUID();
  private source: ContinuationState;
  private goal = "";
  private constraints: string[] = [];
  private outstanding = "";
  private observed = new Map<string, string>();
  private checks: string[] = [];
  private proposal: SwitchProposal | null = null;
  private accepted: string | null = null;
  private acceptedAccount: string | null = null;
  private previewState: ContinuationState | null = null;
  private acceptedState: ContinuationState | null = null;
  private currentRevision = "unknown";

  constructor(source: ContinuationState) { this.source = source; }

  get pending(): SwitchProposal | null { return this.proposal; }
  get hasAcceptedBrief(): boolean { return this.accepted !== null; }

  /** Only submitted chat text is recorded. Shell input and model prose never
   * call this method. Tool receipts are from the host after execution. */
  recordTurn(prompt: string, tools: ObservedTool[], changes: string[], outcome: string, includePrompt = true): void {
    const text = includePrompt ? safe(prompt) : "";
    if (text && !this.goal) this.goal = text;
    else if (text && this.constraints.length < 8) this.constraints.push(text);
    for (const change of changes) this.observed.set(change, safe(change, 240));
    let failedCheck: string | null = null;
    for (const tool of tools) {
      if ((tool.name === "write_file" || tool.name === "patch_file") && tool.exitCode === 0 && tool.path) {
        const path = safe(tool.path, 220);
        this.observed.set(path, `host tool ${tool.name} succeeded: ${path}`);
      }
      if (tool.name === "run_tests" || tool.name === "test") {
        this.checks.push(`host ${tool.name}: exit ${tool.exitCode}`);
        if (tool.exitCode !== 0) failedCheck = `Host ${tool.name} failed (exit ${tool.exitCode}); needs follow-up.`;
      }
    }
    this.checks = this.checks.slice(-8);
    this.outstanding = failedCheck ?? (outcome === "succeeded"
      ? (this.checks.length ? "Latest host check completed; any remaining work needs user review." : "No outstanding check was verified by the host.")
      : `Last turn ${safe(outcome, 100)}; outcome needs review.`);
  }

  propose(target: ModelTarget, currentModel: string, now: ContinuationState): { status: "same" | "drift" | "ready"; reason?: string; proposal?: SwitchProposal } {
    if (target.id === currentModel) return { status: "same" };
    const reason = this.drift(now);
    this.currentRevision = now.repo?.head ?? "unknown";
    this.previewState = now;
    const rendered = this.render(target);
    this.proposal = { target, source: { ...this.source }, ...rendered };
    return { status: reason ? "drift" : "ready", ...(reason ? { reason } : {}), proposal: this.proposal };
  }

  edit(field: "goal" | "constraints" | "outstanding", value: string): SwitchProposal | null {
    if (!this.proposal) return null;
    const text = safe(value);
    if (field === "goal") this.goal = text;
    else if (field === "constraints") this.constraints = text ? [text] : [];
    else this.outstanding = text;
    const rendered = this.render(this.proposal.target);
    this.proposal = { ...this.proposal, ...rendered };
    return this.proposal;
  }

  accept(now: ContinuationState): { ok: true; target: ModelTarget; brief: string } | { ok: false; reason: string } {
    if (!this.proposal) return { ok: false, reason: "no model switch is pending" };
    if (this.source.rulesDigest === "rules-unavailable") return { ok: false, reason: "rules provenance is unavailable; choose /switch fresh" };
    if (this.proposal.target.contextWindow !== null && this.proposal.target.contextWindow < 2_048) {
      return { ok: false, reason: "target context window is too small for a safe continuation; choose /switch fresh" };
    }
    const reason = this.drift(now);
    if (reason) return { ok: false, reason };
    if (this.previewState && this.workspaceChanged(this.previewState, now)) {
      return { ok: false, reason: "workspace or revision changed since the brief was shown; cancel and choose the model again" };
    }
    const { target, brief } = this.proposal;
    this.accepted = brief;
    this.acceptedAccount = now.account;
    this.acceptedState = now;
    this.proposal = null;
    this.previewState = null;
    return { ok: true, target, brief };
  }

  fresh(now: ContinuationState): { ok: true; target: ModelTarget } | { ok: false; reason: string } {
    if (!this.proposal) return { ok: false, reason: "no model switch is pending" };
    const target = this.proposal.target;
    this.proposal = null;
    this.previewState = null;
    this.accepted = null;
    this.acceptedAccount = null;
    this.acceptedState = null;
    this.goal = ""; this.constraints = []; this.outstanding = "";
    this.observed.clear(); this.checks = [];
    this.source = now;
    this.sessionId = randomUUID();
    return { ok: true, target };
  }

  cancel(): void { this.proposal = null; this.previewState = null; }

  /** Consume once only when a model call is actually about to begin. */
  promptForNextTurn(prompt: string, now?: ContinuationState): string {
    if (!this.accepted) return prompt;
    if (now) {
      if (this.acceptedAccount !== null && now.account !== this.acceptedAccount) {
        this.accepted = null;
        this.acceptedAccount = null;
        this.acceptedState = null;
        throw new Error("Continuation blocked before the model call: destination account changed. Start a fresh console session.");
      }
      const reason = this.drift(now);
      if (reason) {
        this.accepted = null;
        this.acceptedAccount = null;
        this.acceptedState = null;
        throw new Error(`Continuation blocked before the model call: ${reason}. Start a fresh console session.`);
      }
      if (this.acceptedState && this.workspaceChanged(this.acceptedState, now)) {
        this.accepted = null;
        this.acceptedAccount = null;
        this.acceptedState = null;
        throw new Error("Continuation blocked before the model call: workspace or revision changed after approval. Start a fresh console session.");
      }
    }
    const brief = this.accepted;
    this.accepted = null;
    this.acceptedAccount = null;
    this.acceptedState = null;
    return `Accepted console continuation brief (user reviewed; observed host results are identified separately):\n${brief}\n\nCurrent user request:\n${prompt}`;
  }

  private drift(now: ContinuationState): string | null {
    if (resolve(now.workspace) !== resolve(this.source.workspace)) return "workspace changed; cancel and start a fresh console session";
    if (this.source.repo && (this.source.workspaceStatus === "unavailable" || now.workspaceStatus === "unavailable")) return "workspace status could not be verified; choose a fresh start";
    if (this.source.account !== "signed-out" && now.account !== this.source.account) return "account changed; prior context cannot be carried automatically";
    if (now.rulesDigest !== this.source.rulesDigest) return "project rules changed; review them and start a fresh session";
    if (this.source.repo?.remote !== now.repo?.remote || this.source.repo?.branch !== now.repo?.branch) return "repository or branch changed; prior context cannot be carried automatically";
    return null;
  }

  private workspaceChanged(before: ContinuationState, now: ContinuationState): boolean {
    return before.repo?.head !== now.repo?.head
      || (before.workspaceStatus !== undefined && now.workspaceStatus !== undefined && before.workspaceStatus !== now.workspaceStatus);
  }

  private render(target: ModelTarget): { brief: string; omitted: number } {
    const max = Math.max(1_200, Math.min(8_000, Math.floor((target.contextWindow ?? 4_096) * 0.20) * 3));
    const compact = target.contextWindow !== null && target.contextWindow < 4_096;
    const essential = [
      `Source session: ${this.sessionId}`,
      `Workspace: ${safe(this.source.workspace, compact ? 180 : 300)}`,
      `Revision: ${safe(this.source.repo?.head ?? "unknown", 80)} (source), ${safe(this.currentRevision, 80)} (current); branch: ${safe(this.source.repo?.branch ?? "unknown", 100)}`,
      `Destination: ${target.destination} / ${safe(target.id, 100)}`,
      `Target context: ${target.contextWindow ?? "unknown (conservative brief cap)"}`,
      `Goal (user text): ${safe(this.goal || "none recorded", compact ? 180 : 512)}`,
      `Outstanding (user editable): ${safe(this.outstanding || "none recorded", compact ? 180 : 512)}`,
    ];
    const optional = [
      ...this.constraints.map(v => `User constraint/update: ${v}`),
      ...[...this.observed.values()].map(v => `Observed workspace/tool result: ${v}`),
      ...this.checks.map(v => `Observed check: ${v}`),
    ];
    let brief = essential.join("\n");
    let omitted = 0;
    for (const line of optional) {
      if (brief.length + line.length + 80 > max) { omitted++; continue; }
      brief += "\n" + line;
    }
    if (omitted) brief += `\n[${omitted} optional item(s) omitted for target context limit]`;
    return { brief, omitted };
  }
}
