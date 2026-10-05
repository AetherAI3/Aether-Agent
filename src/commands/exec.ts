import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { AppContext } from "../core/context.js";
import { BundledChildBrain, type BundledChildMode } from "../core/brain_bundled_child.js";
import { CloudBrain } from "../core/brain_cloud.js";
import type { Brain, BrainControlResult, TaskCommand } from "../core/brain.js";
import type { BrainDone, VerifyOutcome } from "../core/verify_gate.js";
import { ToolExecutor, type ToolResult } from "../core/tool_executor.js";
import { TOOLS, PROTOCOL_VERSION } from "../core/brain_protocol.js";
import { toolDefinition } from "../core/tool_registry.js";
import {
  ControlLedger,
  HeadlessWriter,
  HEADLESS_CONTROL_PROTOCOL,
  HEADLESS_CONTROL_PROTOCOL_V2,
  HEADLESS_MAX_LINE_BYTES,
  HEADLESS_PROTOCOL,
  HEADLESS_PROTOCOL_V2,
  V2ControlLedger,
  parseControlFrame,
  redactHeadless,
  type ControlFrame,
  type HeadlessProtocol,
  type V2ControlOutcome,
} from "../core/headless_protocol.js";
import { LineBuffer } from "../core/brain_protocol.js";
import { resolveLocalModelSelection } from "../core/local_ollama.js";
import {
  HeadlessCheckpointStore,
  captureHeadlessWorkspace,
  commandDigest,
  confineWithAgentDefinition,
  loadHeadlessAgentDefinition,
  type HeadlessCheckpoint,
  type HeadlessDriver,
  type LoadedHeadlessAgentDefinition,
} from "../core/headless_session.js";

export const EXEC_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  unverified: 4,
  protocol: 64,
  authority: 77,
  timeout: 124,
  cancelled: 130,
} as const;
export type ExecPermission = "deny" | "read-only" | "workspace-write";
export const EXEC_V1_TOOLS = ["read_file", "list_directory", "patch_file", "write_file", "repo_search"] as const;
export interface ExecOptions {
  permission: ExecPermission;
  allowedTools: readonly string[];
  capabilityPacks: readonly string[];
  timeoutMs: number;
  verifyCommand?: string;
  brain?: Brain;
  writeLine?: (line: string) => void;
  sessionId?: string;
  resume?: string;
  driver?: HeadlessDriver;
  protocol?: HeadlessProtocol;
  agentDefinition?: string;
  authorityTtlMs?: number;
  maxUvt?: number;
  checkpointDirectory?: string;
  now?: () => Date;
}

function git(cwd: string, args: string[]): string | null {
  const run = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", shell: false, timeout: 3000 });
  return run.status === 0 ? String(run.stdout).trim() || null : null;
}

function repositoryIdentity(cwd: string): Record<string, unknown> {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  return {
    root: root ? realpathSync(root) : realpathSync(cwd),
    git: Boolean(root),
    head: root ? git(root, ["rev-parse", "HEAD"]) : null,
    branch: root ? git(root, ["branch", "--show-current"]) : null,
    remote: root ? git(root, ["remote", "get-url", "origin"]) : null,
  };
}

function allowed(permission: ExecPermission, tool: string, declared: ReadonlySet<string>): { ok: boolean; reason: string } {
  const definition = toolDefinition(tool);
  if (!definition) return { ok: false, reason: "unknown-tool" };
  if (["network", "shell", "git"].includes(definition.sideEffect)) return { ok: false, reason: `${definition.sideEffect}-disabled` };
  if (!declared.has(tool)) return { ok: false, reason: "undeclared-tool" };
  if (permission === "deny") return { ok: false, reason: "permission-deny" };
  if (permission === "read-only" && definition.sideEffect !== "read") return { ok: false, reason: "permission-escalation" };
  return { ok: true, reason: "declared-and-authorized" };
}

function verificationStatus(result: ToolResult | null, configured: boolean): VerifyOutcome {
  if (!configured) return { status: "unverified", remaining: 0, exitCode: -1 };
  if (result?.exitCode === 0) return { status: "ok", remaining: 0, exitCode: 0 };
  return { status: "incomplete", remaining: 0, exitCode: result?.exitCode || 1 };
}

function sameWorkspace(
  first: ReturnType<typeof captureHeadlessWorkspace>,
  second: ReturnType<typeof captureHeadlessWorkspace>,
): boolean {
  return first.workspace_digest === second.workspace_digest
    && first.repository_digest === second.repository_digest
    && first.head === second.head
    && first.tree_digest === second.tree_digest;
}

function normalizeBrainControl(
  result: BrainControlResult | void,
  fallbackState: "running" | "paused",
): BrainControlResult {
  return result ?? {
    accepted: false,
    state: fallbackState,
    error: "brain did not provide a control acknowledgement",
  };
}

function checkpointAgentMatches(
  checkpoint: HeadlessCheckpoint,
  definition: LoadedHeadlessAgentDefinition | null,
): boolean {
  if (!checkpoint.agent) return definition === null;
  return definition !== null
    && checkpoint.agent.id === definition.id
    && checkpoint.agent.version === definition.version
    && checkpoint.agent.path === definition.path
    && checkpoint.agent.digest === definition.digest;
}

export async function runHeadlessExec(ctx: AppContext, task: string, opts: ExecOptions): Promise<number> {
  const cwd = realpathSync(resolve(ctx.flags.cwd));
  const protocol = opts.protocol ?? HEADLESS_PROTOCOL;
  const v2 = protocol === HEADLESS_PROTOCOL_V2;
  const now = opts.now ?? (() => new Date());
  let taskText = task;
  let driver = opts.driver ?? "ollama";
  let permission = opts.permission;
  let allowedTools = [...opts.allowedTools];
  let capabilityPacks = [...opts.capabilityPacks];
  let effort = (ctx.flags.effort ?? ctx.cfg.defaultEffort) || null;
  let localModel: { tag: string; id: string } | null = null;
  let cloudModel: string | null = null;
  let maxUvt: number | null = opts.maxUvt ?? null;
  let agentDefinition: LoadedHeadlessAgentDefinition | null = null;
  let checkpointStore: HeadlessCheckpointStore | null = null;
  let checkpoint: HeadlessCheckpoint | null = null;

  try {
    if (v2) {
      checkpointStore = new HeadlessCheckpointStore(cwd, opts.checkpointDirectory);
      if (opts.resume) {
        if (ctx.flags.model?.trim()) throw new Error("--model cannot replace checkpoint authority during resume");
        if (opts.maxUvt !== undefined) throw new Error("--max-uvt cannot replace checkpoint authority during resume");
        checkpoint = checkpointStore.loadForResume(opts.resume, now());
        if (commandDigest(opts.verifyCommand) !== checkpoint.verification.command_digest) {
          throw new Error("--test-cmd must match the checkpoint verification command");
        }
        taskText = checkpoint.task;
        driver = checkpoint.driver;
        permission = checkpoint.permission;
        allowedTools = [...checkpoint.allowed_tools];
        capabilityPacks = [...checkpoint.capability_packs];
        effort = checkpoint.effort;
        maxUvt = checkpoint.max_uvt;
        if (checkpoint.agent) {
          agentDefinition = loadHeadlessAgentDefinition(cwd, checkpoint.agent.path, now());
        }
        if (!checkpointAgentMatches(checkpoint, agentDefinition)) {
          throw new Error("checkpoint agent definition changed or is unavailable");
        }
        if (driver === "ollama") {
          if (!checkpoint.model || !checkpoint.model_tag) throw new Error("checkpoint model binding is invalid");
          localModel = { id: checkpoint.model, tag: checkpoint.model_tag };
        } else if (driver === "cloud") {
          cloudModel = checkpoint.model;
        }
      } else if (opts.agentDefinition) {
        agentDefinition = loadHeadlessAgentDefinition(cwd, opts.agentDefinition, now());
        confineWithAgentDefinition(permission, allowedTools, capabilityPacks, agentDefinition);
      }
    }
    if (!checkpoint) {
      if (driver === "selftest" && ctx.flags.model?.trim()) {
        throw new Error("--model is unavailable with the selftest driver; selftest performs no model work");
      }
      if (driver === "ollama") localModel = resolveLocalModelSelection(ctx.flags.model, ctx.cfg.localModel ?? "");
      if (driver === "cloud") {
        const requestedModel = ctx.flags.model?.trim();
        if (!requestedModel) {
          throw new Error("--exec-driver cloud requires an explicit --model so checkpoints cannot drift with the server default");
        }
        if (requestedModel.startsWith("ollama:")) {
          throw new Error("an ollama: model cannot be sent to the Aether cloud driver");
        }
        if (requestedModel.startsWith("aether-")) {
          throw new Error(
            "aether-* orchestrator ids are not supported by the local-authority cloud dev-session contract",
          );
        }
        if (!Number.isSafeInteger(maxUvt) || (maxUvt ?? 0) <= 0) {
          throw new Error("--exec-driver cloud requires --max-uvt <positive integer>");
        }
        cloudModel = requestedModel;
      } else if (maxUvt !== null) {
        throw new Error("--max-uvt is available only with --exec-driver cloud");
      }
    }
  } catch (error) {
    const explicit = ctx.flags.model?.trim();
    const message = explicit && driver === "ollama" && !explicit.startsWith("ollama:")
      ? `Model ${JSON.stringify(explicit)} is unavailable to aether exec. Use an explicit ollama:<tag>; bare and hosted model ids are rejected.`
      : error instanceof Error ? error.message : String(error);
    process.stderr.write(`aether exec: ${String(redactHeadless(message))}\n`);
    return EXEC_EXIT.usage;
  }

  const writer = new HeadlessWriter(cwd, opts.writeLine, v2 ? (opts.resume ?? opts.sessionId) : opts.sessionId, protocol);
  if (v2 && !checkpoint) {
    try {
      checkpoint = checkpointStore!.create({
        session: writer.sessionId,
        task: taskText,
        driver,
        model: driver === "cloud" ? cloudModel : localModel?.id ?? null,
        modelTag: localModel?.tag ?? null,
        maxUvt: driver === "cloud" ? maxUvt : null,
        effort,
        permission,
        allowedTools,
        capabilityPacks,
        agent: agentDefinition,
        verifyCommand: opts.verifyCommand,
        authorityTtlMs: opts.authorityTtlMs ?? 60 * 60 * 1000,
        now: now(),
      });
    } catch (error) {
      process.stderr.write(`aether exec: ${String(redactHeadless(error instanceof Error ? error.message : String(error)))}\n`);
      return EXEC_EXIT.usage;
    }
  }

  const declared = new Set(allowedTools.filter((tool) => (EXEC_V1_TOOLS as readonly string[]).includes(tool)));
  const warnings: string[] = [];
  if (process.stdin.isTTY) warnings.push("stdin controls unavailable on a TTY; send process signals or pipe versioned JSONL controls");
  if (!opts.verifyCommand) warnings.push("no verification command configured; successful agent completion remains non-zero/unverified");
  if (!v2 && opts.resume) warnings.push("resume is not supported by aether.exec/1; the request will be rejected without starting a brain");
  if (driver === "selftest") warnings.push("selftest driver validates installed child/protocol wiring only; it performs no model work");
  if (driver === "cloud") warnings.push("cloud driver requires a hosted Cloud text-model dev session and refuses any server-side execution downgrade");
  if (v2 && opts.resume) warnings.push("resumed from a workspace checkpoint; model conversation state is not replayed");
  const brain = opts.brain ?? (driver === "cloud"
    ? new CloudBrain(ctx.api, undefined, {
        requireLocalAuthority: true,
        localToolCapabilities: [...declared],
        maxUvt: maxUvt ?? undefined,
      })
    : new BundledChildBrain({
        mode: driver as BundledChildMode,
        allowedTools: [...declared] as (typeof EXEC_V1_TOOLS)[number][],
        diagnostic: (text) => process.stderr.write(String(redactHeadless(text))),
      }));
  const exec = new ToolExecutor(cwd, opts.verifyCommand);
  const abort = new AbortController();
  let cancelled = false;
  let timedOut = false;
  let authorityExpired = false;
  let protocolFailed = false;
  let done: BrainDone | null = null;
  let brainFailed = false;
  let brainRunning = true;
  let sessionState: "running" | "paused" = "running";
  const controlLedger = new ControlLedger();
  const v2Ledger = new V2ControlLedger(checkpoint ? {
    nextSequence: checkpoint.control.next_sequence,
    steerCount: checkpoint.control.steer_count,
    steerBytes: checkpoint.control.steer_bytes,
  } : {});
  const controls = new LineBuffer();

  writer.emit("session", {
    session: writer.sessionId,
    bridge_protocol: PROTOCOL_VERSION,
    repository: repositoryIdentity(cwd),
    backend: driver === "selftest" ? "bundled-selftest-child"
      : driver === "cloud" ? "aether-cloud-dev-session" : "bundled-ollama-child",
    model: driver === "cloud" ? cloudModel : localModel?.id ?? null,
    max_uvt: driver === "cloud" ? maxUvt : null,
    effort,
    permissions: {
      mode: permission, explicit_decisions: true,
      agent_network_tools: "disabled", agent_shell_tools: "disabled", remote_shell: "disabled",
    },
    tools: [...declared].sort(),
    capability_packs: [...capabilityPacks].sort(),
    warnings,
    verification_command: opts.verifyCommand ?? null,
    control_protocol: v2 ? HEADLESS_CONTROL_PROTOCOL_V2 : HEADLESS_CONTROL_PROTOCOL,
    ...(v2 && checkpoint ? {
      checkpoint: {
        protocol: checkpoint.protocol,
        generation: checkpoint.generation,
        authority_expires_at: checkpoint.authority.expires_at,
        workspace: checkpoint.workspace,
        resumed: Boolean(opts.resume),
        resume_mode: opts.resume ? "workspace-checkpoint" : null,
      },
      agent_definition: checkpoint.agent,
    } : {}),
  });

  if (!v2 && opts.resume) {
    writer.emit("control_result", {
      action: "resume", accepted: false, error: "unsupported in aether.exec/1", requested_session: opts.resume,
    });
    writer.terminal({ ok: false, exit_code: EXEC_EXIT.usage, reason: "resume-unsupported" });
    return EXEC_EXIT.usage;
  }

  const persistCheckpoint = (refreshWorkspace = false): boolean => {
    if (!v2 || !checkpoint || !checkpointStore) return true;
    try {
      if (refreshWorkspace) checkpointStore.refreshWorkspace(checkpoint, now());
      else checkpointStore.write(checkpoint, now());
      return true;
    } catch (error) {
      protocolFailed = true;
      process.stderr.write(`aether exec: checkpoint failure: ${String(redactHeadless(error instanceof Error ? error.message : String(error)))}\n`);
      return false;
    }
  };

  const cancel = (reason: "signal" | "control" | "timeout" | "protocol" | "authority-expired"): void => {
    if (!cancelled) {
      cancelled = true;
      timedOut = reason === "timeout";
      authorityExpired = reason === "authority-expired";
      protocolFailed = protocolFailed || reason === "protocol";
      abort.abort();
      brain.close();
      if (checkpoint) {
        checkpoint.state = authorityExpired ? "authority_expired"
          : timedOut ? "timed_out"
            : reason === "control" || reason === "signal" ? "cancelled" : "failed";
        persistCheckpoint(true);
      }
      writer.emit("cancelled", { reason });
    }
  };
  const onSignal = (): void => cancel("signal");
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const timer = setTimeout(() => cancel("timeout"), opts.timeoutMs);
  timer.unref();
  const authorityTimer = checkpoint
    ? setTimeout(() => cancel("authority-expired"), Math.max(1, Date.parse(checkpoint.authority.expires_at) - now().getTime()))
    : null;
  authorityTimer?.unref();

  const updateV2ControlCheckpoint = (state?: "running" | "paused" | "cancelled"): void => {
    if (!checkpoint) return;
    const snapshot = v2Ledger.snapshot();
    checkpoint.control.next_sequence = snapshot.nextSequence;
    checkpoint.control.steer_count = snapshot.steerCount;
    checkpoint.control.steer_bytes = snapshot.steerBytes;
    if (state === "paused") checkpoint.state = "paused";
    else if (state === "running") checkpoint.state = "running";
    else if (state === "cancelled") checkpoint.state = "cancelled";
  };

  const consumeV1Control = (frame: ControlFrame): void => {
    const ledger = controlLedger.accept(frame);
    if (!ledger.accepted) {
      writer.emit("control_result", { accepted: false, action: frame.action, error: ledger.error }, frame.correlation_id);
      cancel("protocol");
      return;
    }
    if (frame.action === "cancel") {
      writer.emit("control_result", { accepted: true, action: frame.action }, frame.correlation_id);
      cancel("control");
      return;
    }
    writer.emit("control_result", {
      accepted: false, action: frame.action, error: "unsupported in aether.exec/1; instruction was not applied",
    }, frame.correlation_id);
  };

  const consumeV2Control = async (frame: ControlFrame): Promise<void> => {
    if (frame.correlation_id !== writer.sessionId) {
      writer.emit("control_result", {
        accepted: false, action: frame.action, error: "control correlation_id does not match the session",
      }, frame.correlation_id);
      return;
    }
    const decision = v2Ledger.begin(frame);
    if (decision.kind === "rejected") {
      writer.emit("control_result", { accepted: false, action: frame.action, error: decision.error }, frame.correlation_id);
      return;
    }
    if (decision.kind === "duplicate") {
      writer.emit("control_result", { ...decision.outcome, duplicate: true }, frame.correlation_id);
      return;
    }
    let outcome: V2ControlOutcome;
    if (!brainRunning && frame.action !== "cancel") {
      outcome = { accepted: false, action: frame.action, state: sessionState, error: "brain is no longer running" };
    } else if (frame.action === "cancel") {
      outcome = { accepted: true, action: "cancel", state: "cancelled" };
    } else if (frame.action === "pause" && sessionState === "paused") {
      outcome = { accepted: false, action: "pause", state: "paused", error: "session is already paused" };
    } else if (frame.action === "resume" && sessionState !== "paused") {
      outcome = { accepted: false, action: "resume", state: "running", error: "session is not paused" };
    } else {
      const acknowledged = normalizeBrainControl(await Promise.resolve(brain.control(frame.action, frame.note)), sessionState);
      const state = acknowledged.state === "paused" ? "paused" : sessionState === "paused" && frame.action !== "resume" ? "paused" : "running";
      const accurate = frame.action === "pause"
        ? acknowledged.accepted && acknowledged.state === "paused"
        : frame.action === "resume"
          ? acknowledged.accepted && acknowledged.state === "running"
          : acknowledged.accepted;
      outcome = {
        accepted: accurate,
        action: frame.action,
        state,
        ...(!accurate ? { error: acknowledged.error ?? "brain did not apply the control" } : {}),
      };
    }
    v2Ledger.complete(frame, outcome);
    if (outcome.accepted && outcome.state !== "cancelled") sessionState = outcome.state;
    updateV2ControlCheckpoint(outcome.state);
    persistCheckpoint(outcome.accepted && frame.action === "pause");
    writer.emit("control_result", { ...outcome }, frame.correlation_id);
    if (outcome.accepted && frame.action === "cancel") cancel("control");
  };

  const consumeControl = async (line: string): Promise<void> => {
    const expected = v2 ? HEADLESS_CONTROL_PROTOCOL_V2 : HEADLESS_CONTROL_PROTOCOL;
    const parsed = parseControlFrame(line, expected);
    if (!parsed.ok) {
      writer.emit("control_result", { accepted: false, error: parsed.error });
      cancel("protocol");
      return;
    }
    if (v2) await consumeV2Control(parsed.frame);
    else consumeV1Control(parsed.frame);
  };
  let controlChain = Promise.resolve();
  const enqueueControl = (line: string): void => {
    controlChain = controlChain.then(() => cancelled ? undefined : consumeControl(line)).catch((error) => {
      writer.emit("control_result", { accepted: false, error: error instanceof Error ? error.message : String(error) });
      cancel("protocol");
    });
  };
  const onStdin = (chunk: Buffer | string): void => {
    for (const line of controls.push(String(chunk))) {
      if (line.trim()) enqueueControl(line);
    }
    if (!cancelled && Buffer.byteLength(controls.rest(), "utf8") > HEADLESS_MAX_LINE_BYTES) {
      controlChain = controlChain.then(() => {
        writer.emit("control_result", { accepted: false, error: "unterminated control frame exceeds 16384 bytes" });
        cancel("protocol");
      });
    }
  };
  const onStdinEnd = (): void => {
    if (!cancelled && controls.rest().trim()) {
      controlChain = controlChain.then(() => {
        writer.emit("control_result", { accepted: false, error: "truncated control frame" });
        cancel("protocol");
      });
    }
  };
  if (!process.stdin.isTTY) {
    process.stdin.on("data", onStdin);
    process.stdin.once("end", onStdinEnd);
  }

  try {
    const confinedTask = agentDefinition
      ? `${taskText}\n\n[Confined agent definition ${agentDefinition.id}@${agentDefinition.version}]\n${agentDefinition.instructions}`
      : taskText;
    const taskCommand: TaskCommand = {
      type: "task", text: confinedTask, cwd, poolGb: 5,
      model: driver === "cloud" ? cloudModel ?? undefined : localModel?.tag,
      effort: effort || undefined, testCmd: opts.verifyCommand,
    };
    for await (const event of brain.run(taskCommand)) {
      if (cancelled) break;
      const correlation = event.type === "tool_call" && event.id ? event.id : writer.sessionId;
      writer.emit("agent_event", { event }, correlation);
      if (event.type === "tool_call") {
        if (event.name === "patch_file") {
          const preview = exec.previewPatch(event.args);
          writer.emit("patch_preview", { output: preview.output, valid: preview.exitCode === 0 }, event.id);
        }
        const decision = allowed(permission, event.name, declared);
        writer.emit("permission_decision", { tool: event.name, approved: decision.ok, reason: decision.reason }, event.id);
        const result = decision.ok
          ? await exec.executeAsync(event.name, event.args, { signal: abort.signal, timeoutMs: opts.timeoutMs })
          : { output: `[denied: ${decision.reason}]`, exitCode: 1 };
        writer.emit("tool_receipt", { tool: event.name, exit_code: result.exitCode, output: result.output }, event.id);
        if (v2 && !persistCheckpoint(true)) cancel("protocol");
        brain.sendToolResult(event.id, result);
      } else if (event.type === "done") {
        done = { ok: event.ok, remaining: event.remaining, reason: event.reason };
      } else if (event.type === "error") {
        brainFailed = true;
      }
    }
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    await controlChain;
  } catch (error) {
    brainFailed = true;
    process.stderr.write(`aether exec: ${String(redactHeadless(error instanceof Error ? error.message : String(error)))}\n`);
    writer.emit("diagnostic", { level: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    brainRunning = false;
    brain.close();
  }

  let verification: VerifyOutcome;
  let verificationOutput = "[cancelled before verification]";
  let verificationAuthoritative = false;
  let verificationCommitBound = false;
  if (cancelled) {
    verification = { status: "error", remaining: 0, exitCode: authorityExpired ? EXEC_EXIT.authority : timedOut ? 124 : 130 };
    if (checkpoint) checkpoint.verification.status = "cancelled";
  } else if (v2 && opts.verifyCommand) {
    try {
      const before = captureHeadlessWorkspace(cwd);
      const result = await exec.executeAsync(
        "run_tests",
        { command: opts.verifyCommand },
        { signal: abort.signal, timeoutMs: opts.timeoutMs },
      );
      const after = captureHeadlessWorkspace(cwd);
      verificationOutput = result.output;
      verificationAuthoritative = true;
      verificationCommitBound = sameWorkspace(before, after);
      verification = verificationCommitBound
        ? verificationStatus(result, true)
        : { status: "error", remaining: 0, exitCode: result.exitCode || 1 };
      if (checkpoint) {
        checkpoint.verification.status = verificationCommitBound
          ? result.exitCode === 0 ? "ok" : "failed"
          : "unattributable";
        checkpoint.verification.exit_code = result.exitCode;
        checkpoint.verification.head = verificationCommitBound ? after.head : null;
        checkpoint.verification.tree_digest = verificationCommitBound ? after.tree_digest : null;
        if (verificationCommitBound) checkpoint.workspace = after;
        persistCheckpoint();
      }
    } catch (error) {
      verificationAuthoritative = true;
      verification = { status: "error", remaining: 0, exitCode: 1 };
      verificationOutput = error instanceof Error ? error.message : String(error);
      if (checkpoint) {
        checkpoint.verification.status = "unattributable";
        checkpoint.verification.exit_code = 1;
        persistCheckpoint();
      }
    }
  } else {
    const result = opts.verifyCommand
      ? await exec.executeAsync("run_tests", { command: opts.verifyCommand }, { signal: abort.signal, timeoutMs: opts.timeoutMs })
      : null;
    verification = verificationStatus(result, Boolean(opts.verifyCommand));
    verificationOutput = result?.output ?? "[not configured]";
    verificationAuthoritative = result !== null;
  }
  writer.emit("verification", {
    status: verification.status, exit_code: verification.exitCode,
    authoritative: verificationAuthoritative, commit_bound: verificationCommitBound, output: verificationOutput,
    ...(v2 && checkpoint ? { head: checkpoint.verification.head, tree_digest: checkpoint.verification.tree_digest } : {}),
  });
  let exitCode = protocolFailed ? EXEC_EXIT.protocol
    : authorityExpired ? EXEC_EXIT.authority
      : timedOut ? EXEC_EXIT.timeout
        : cancelled ? EXEC_EXIT.cancelled
          : brainFailed || !done?.ok ? EXEC_EXIT.failed
            : verification.status === "ok" ? EXEC_EXIT.ok
              : verification.status === "unverified" ? EXEC_EXIT.unverified : EXEC_EXIT.failed;
  if (checkpoint) {
    checkpoint.state = exitCode === EXEC_EXIT.ok ? "completed"
      : exitCode === EXEC_EXIT.cancelled ? "cancelled"
        : exitCode === EXEC_EXIT.timeout ? "timed_out"
          : exitCode === EXEC_EXIT.authority ? "authority_expired" : "failed";
    checkpoint.terminal_exit_code = exitCode;
    if (!persistCheckpoint()) exitCode = EXEC_EXIT.protocol;
  }
  writer.terminal({ ok: exitCode === 0, exit_code: exitCode, verification, agent: done });
  clearTimeout(timer);
  if (authorityTimer) clearTimeout(authorityTimer);
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  process.stdin.removeListener("data", onStdin);
  process.stdin.removeListener("end", onStdinEnd);
  // Attaching a data listener resumes stdin. Leave no flowing stream behind
  // after the headless session, or an embedded runner can remain alive.
  if (!process.stdin.isTTY) process.stdin.pause();
  return exitCode;
}

export async function cmdExec(ctx: AppContext, argv: string[], flags: {
  str(name: string): string | undefined; list(name: string): string[];
}): Promise<number> {
  const task = argv.join(" ").trim();
  const protocolValue = flags.str("exec-protocol") ?? "1";
  const protocol = protocolValue === "1" || protocolValue === HEADLESS_PROTOCOL
    ? HEADLESS_PROTOCOL
    : protocolValue === "2" || protocolValue === HEADLESS_PROTOCOL_V2
      ? HEADLESS_PROTOCOL_V2
      : null;
  if (!protocol) {
    process.stderr.write("aether exec: --exec-protocol must be 1 or 2\n");
    return EXEC_EXIT.usage;
  }
  if (!task && !(protocol === HEADLESS_PROTOCOL_V2 && ctx.flags.resume)) {
    process.stderr.write('usage: aether exec [flags] "task"\n');
    return EXEC_EXIT.usage;
  }
  if (protocol === HEADLESS_PROTOCOL_V2 && ctx.flags.resume && task) {
    process.stderr.write("aether exec: a resumed v2 session takes its task from the checkpoint; do not provide a new task\n");
    return EXEC_EXIT.usage;
  }
  if (Buffer.byteLength(task, "utf8") > 64 * 1024) {
    process.stderr.write("aether exec: task exceeds 65536 bytes\n");
    return EXEC_EXIT.usage;
  }
  const permission = flags.str("permission") ?? "read-only";
  if (!["deny", "read-only", "workspace-write"].includes(permission)) {
    process.stderr.write("aether exec: --permission must be deny, read-only, or workspace-write\n");
    return EXEC_EXIT.usage;
  }
  const timeout = Number(flags.str("timeout-ms") ?? "900000");
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 3_600_000) {
    process.stderr.write("aether exec: --timeout-ms must be an integer from 100 to 3600000\n");
    return EXEC_EXIT.usage;
  }
  const requested = flags.list("allow-tool");
  const unknown = requested.filter((tool) => !(TOOLS as readonly string[]).includes(tool));
  if (unknown.length) {
    process.stderr.write(`aether exec: unknown --allow-tool ${unknown[0]}\n`);
    return EXEC_EXIT.usage;
  }
  const forbidden = requested.filter((tool) => !(EXEC_V1_TOOLS as readonly string[]).includes(tool));
  if (forbidden.length) {
    const version = protocol === HEADLESS_PROTOCOL_V2 ? "aether.exec/2" : "v1";
    process.stderr.write(`aether exec: --allow-tool ${forbidden[0]} is unavailable in ${version} (shell, git, and network tools are disabled)\n`);
    return EXEC_EXIT.usage;
  }
  const packs = flags.list("capability-pack");
  if (packs.length > 16 || packs.some((pack) => !/^[a-z][a-z0-9._-]{0,127}$/.test(pack))) {
    process.stderr.write("aether exec: capability packs must be 1-16 bounded identifiers\n");
    return EXEC_EXIT.usage;
  }
  const driver = flags.str("exec-driver") ?? "ollama";
  if (driver !== "ollama" && driver !== "selftest" && driver !== "cloud") {
    process.stderr.write("aether exec: --exec-driver must be ollama, cloud, or selftest\n");
    return EXEC_EXIT.usage;
  }
  const rawMaxUvt = flags.str("max-uvt");
  const maxUvt = rawMaxUvt === undefined ? undefined : Number(rawMaxUvt);
  if (rawMaxUvt !== undefined && (!Number.isSafeInteger(maxUvt) || (maxUvt ?? 0) <= 0)) {
    process.stderr.write("aether exec: --max-uvt must be a positive integer\n");
    return EXEC_EXIT.usage;
  }
  const ttl = Number(flags.str("authority-ttl-ms") ?? "3600000");
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 14_400_000) {
    process.stderr.write("aether exec: --authority-ttl-ms must be an integer from 1000 to 14400000\n");
    return EXEC_EXIT.usage;
  }
  const agentDefinition = flags.str("agent-definition");
  if (protocol === HEADLESS_PROTOCOL && (agentDefinition || flags.str("authority-ttl-ms"))) {
    process.stderr.write("aether exec: --agent-definition and --authority-ttl-ms require --exec-protocol 2\n");
    return EXEC_EXIT.usage;
  }
  if (protocol === HEADLESS_PROTOCOL_V2 && ctx.flags.resume) {
    const authorityOverride = flags.str("permission") || requested.length || packs.length
      || flags.str("exec-driver") || flags.str("authority-ttl-ms") || agentDefinition
      || rawMaxUvt || ctx.flags.model || ctx.flags.effort;
    if (authorityOverride) {
      process.stderr.write("aether exec: resume refuses model, driver, permission, tool, pack, agent, effort, TTL, or UVT overrides\n");
      return EXEC_EXIT.usage;
    }
  }
  return runHeadlessExec(ctx, task, {
    permission: permission as ExecPermission,
    allowedTools: requested.length ? requested : ["read_file", "repo_search"],
    capabilityPacks: packs.length ? packs : ["core.read.v1"],
    timeoutMs: timeout,
    verifyCommand: ctx.flags.testCmd,
    resume: ctx.flags.resume,
    driver,
    protocol,
    authorityTtlMs: ttl,
    maxUvt,
    ...(agentDefinition ? { agentDefinition } : {}),
  });
}
