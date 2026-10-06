import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { configDir } from "./config.js";
import { isLocalModelId } from "./local_ollama.js";
import { GIT_GLOBAL_ARGS } from "./git_commit_guard.js";
import { redactHeadless } from "./headless_protocol.js";
import { treeIdentity, type TreeIdentity } from "./verification_record.js";
import type { Runner } from "./worktree.js";

export const HEADLESS_CHECKPOINT_PROTOCOL = "aether.exec.checkpoint/2";
export const HEADLESS_AGENT_PROTOCOL = "aether.exec.agent/1";
export const HEADLESS_AGENT_VERSION = 1;
export const HEADLESS_AUTHORITY_MAX_MS = 4 * 60 * 60 * 1000;
export const HEADLESS_AGENT_MAX_BYTES = 32 * 1024;
export const HEADLESS_AGENT_INSTRUCTIONS_MAX_BYTES = 16 * 1024;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PACK_ID = /^[a-z][a-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/;
const TOOL_NAMES = new Set(["read_file", "list_directory", "patch_file", "write_file", "repo_search"]);
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "timed_out", "authority_expired"]);
const CHECKPOINT_STATES = new Set([
  "running", "paused", "completed", "failed", "cancelled", "timed_out", "authority_expired",
]);
const VERIFICATION_STATES = new Set(["pending", "ok", "failed", "unverified", "unattributable", "cancelled"]);

export type HeadlessPermission = "deny" | "read-only" | "workspace-write";
export type HeadlessDriver = "ollama" | "selftest" | "cloud";
export type HeadlessCheckpointState =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "authority_expired";

export interface HeadlessWorkspaceBinding {
  workspace_digest: string;
  repository_digest: string;
  head: string;
  tree_digest: string;
}

export interface LoadedHeadlessAgentDefinition {
  protocol: typeof HEADLESS_AGENT_PROTOCOL;
  version: typeof HEADLESS_AGENT_VERSION;
  id: string;
  path: string;
  digest: string;
  instructions: string;
  allowedTools: readonly string[];
  capabilityPacks: readonly string[];
  permissionCeiling: HeadlessPermission;
  expiresAt: string | null;
}

export interface HeadlessCheckpointAgent {
  id: string;
  version: number;
  path: string;
  digest: string;
  expires_at: string | null;
}

export interface HeadlessVerificationCheckpoint {
  command_digest: string | null;
  status: "pending" | "ok" | "failed" | "unverified" | "unattributable" | "cancelled";
  exit_code: number | null;
  head: string | null;
  tree_digest: string | null;
}

export interface HeadlessCheckpoint {
  protocol: typeof HEADLESS_CHECKPOINT_PROTOCOL;
  session: string;
  generation: number;
  owner_pid: number;
  created_at: string;
  updated_at: string;
  authority: { issued_at: string; expires_at: string };
  state: HeadlessCheckpointState;
  task: string;
  task_digest: string;
  driver: HeadlessDriver;
  model: string | null;
  model_tag: string | null;
  max_uvt: number | null;
  effort: string | null;
  permission: HeadlessPermission;
  allowed_tools: string[];
  capability_packs: string[];
  agent: HeadlessCheckpointAgent | null;
  workspace: HeadlessWorkspaceBinding;
  control: {
    next_sequence: number;
    steer_count: number;
    steer_bytes: number;
  };
  verification: HeadlessVerificationCheckpoint;
  terminal_exit_code: number | null;
}

export interface CreateCheckpointInput {
  session: string;
  task: string;
  driver: HeadlessDriver;
  model: string | null;
  modelTag: string | null;
  maxUvt?: number | null;
  effort: string | null;
  permission: HeadlessPermission;
  allowedTools: readonly string[];
  capabilityPacks: readonly string[];
  agent: LoadedHeadlessAgentDefinition | null;
  verifyCommand: string | undefined;
  authorityTtlMs: number;
  now?: Date;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function commandDigest(command: string | undefined): string | null {
  const trimmed = command?.trim();
  return trimmed ? digest(trimmed) : null;
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function runGit(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) return { status: 127, stdout: "", stderr: String(result.error) };
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const identityRunner: Runner = (command, args, cwd) => runGit(command, args, cwd);

/** Capture the exact committed repository plus its current workspace bytes. */
export function captureHeadlessWorkspace(workspace: string): HeadlessWorkspaceBinding {
  const root = realpathSync(resolve(workspace));
  const repository = runGit("git", [
    ...GIT_GLOBAL_ARGS,
    "-c",
    "core.fsmonitor=false",
    "-C",
    root,
    "rev-parse",
    "--show-toplevel",
  ]);
  if (repository.status !== 0 || !repository.stdout.trim()) {
    throw new Error("aether.exec/2 requires a Git workspace with a committed HEAD");
  }
  const repositoryRoot = realpathSync(repository.stdout.trim());
  const identity: TreeIdentity = treeIdentity(identityRunner, repositoryRoot);
  if (!identity.head || !SHA256.test(identity.digest)) {
    throw new Error("cannot bind aether.exec/2 to the repository HEAD and workspace tree");
  }
  return {
    workspace_digest: digest(root),
    repository_digest: digest(repositoryRoot),
    head: identity.head,
    tree_digest: identity.digest,
  };
}

function permissionRank(permission: HeadlessPermission): number {
  return permission === "deny" ? 0 : permission === "read-only" ? 1 : 2;
}

function stringArray(value: unknown, label: string, predicate: (item: string) => boolean): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !predicate(item))) {
    throw new Error(`agent definition ${label} is invalid`);
  }
  const items = [...new Set(value as string[])];
  if (items.length !== value.length) throw new Error(`agent definition ${label} contains duplicates`);
  return items;
}

/** Load one reusable agent definition without permitting path or authority escape. */
export function loadHeadlessAgentDefinition(
  workspace: string,
  requestedPath: string,
  now: Date = new Date(),
): LoadedHeadlessAgentDefinition {
  const root = realpathSync(resolve(workspace));
  const unresolved = resolve(root, requestedPath);
  if (!existsSync(unresolved)) throw new Error("agent definition does not exist");
  const absolute = realpathSync(unresolved);
  if (!contained(root, absolute)) throw new Error("agent definition escapes the workspace");
  if (!lstatSync(absolute).isFile()) throw new Error("agent definition is not a regular file");
  const bytes = readFileSync(absolute);
  if (bytes.byteLength > HEADLESS_AGENT_MAX_BYTES) throw new Error("agent definition exceeds 32768 bytes");
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("agent definition is malformed JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("agent definition must be an object");
  const obj = raw as Record<string, unknown>;
  const known = new Set([
    "protocol", "version", "id", "instructions", "allowed_tools", "capability_packs",
    "permission_ceiling", "expires_at",
  ]);
  const unknown = Object.keys(obj).find((key) => !known.has(key));
  if (unknown) throw new Error(`agent definition contains unknown field ${unknown}`);
  if (obj["protocol"] !== HEADLESS_AGENT_PROTOCOL || obj["version"] !== HEADLESS_AGENT_VERSION) {
    throw new Error("unsupported agent definition protocol or version");
  }
  if (typeof obj["id"] !== "string" || !SAFE_ID.test(obj["id"])) throw new Error("agent definition id is invalid");
  if (typeof obj["instructions"] !== "string" || !obj["instructions"].trim()) {
    throw new Error("agent definition instructions are empty");
  }
  if (Buffer.byteLength(obj["instructions"], "utf8") > HEADLESS_AGENT_INSTRUCTIONS_MAX_BYTES) {
    throw new Error("agent definition instructions exceed 16384 bytes");
  }
  const allowedTools = stringArray(obj["allowed_tools"], "allowed_tools", (item) => TOOL_NAMES.has(item));
  const capabilityPacks = stringArray(obj["capability_packs"], "capability_packs", (item) => PACK_ID.test(item));
  if (capabilityPacks.length > 16) throw new Error("agent definition capability_packs exceeds 16 entries");
  const ceiling = obj["permission_ceiling"];
  if (ceiling !== "deny" && ceiling !== "read-only" && ceiling !== "workspace-write") {
    throw new Error("agent definition permission_ceiling is invalid");
  }
  const expiresAt = obj["expires_at"] == null ? null : String(obj["expires_at"]);
  if (expiresAt !== null) {
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry)) throw new Error("agent definition expires_at is invalid");
    if (expiry <= now.getTime()) throw new Error("agent definition authority is expired");
  }
  return {
    protocol: HEADLESS_AGENT_PROTOCOL,
    version: HEADLESS_AGENT_VERSION,
    id: obj["id"],
    path: relative(root, absolute).replace(/\\/g, "/"),
    digest: digest(bytes),
    instructions: obj["instructions"],
    allowedTools,
    capabilityPacks,
    permissionCeiling: ceiling,
    expiresAt,
  };
}

export function confineWithAgentDefinition(
  permission: HeadlessPermission,
  allowedTools: readonly string[],
  capabilityPacks: readonly string[],
  definition: LoadedHeadlessAgentDefinition,
): void {
  if (permissionRank(permission) > permissionRank(definition.permissionCeiling)) {
    throw new Error(`requested permission exceeds agent definition ceiling ${definition.permissionCeiling}`);
  }
  const tool = allowedTools.find((item) => !definition.allowedTools.includes(item));
  if (tool) throw new Error(`requested tool ${tool} is outside the agent definition`);
  const pack = capabilityPacks.find((item) => !definition.capabilityPacks.includes(item));
  if (pack) throw new Error(`requested capability pack ${pack} is outside the agent definition`);
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    // EPERM proves the process exists even though this account cannot signal
    // it. Treating that as dead would permit a concurrent checkpoint resume.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function validateCheckpoint(value: unknown, expectedSession: string): HeadlessCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("checkpoint is not an object");
  const checkpoint = value as HeadlessCheckpoint;
  if (checkpoint.protocol !== HEADLESS_CHECKPOINT_PROTOCOL) throw new Error("checkpoint protocol is unsupported");
  if (checkpoint.session !== expectedSession || !SAFE_ID.test(checkpoint.session)) throw new Error("checkpoint session mismatch");
  if (!Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 0) throw new Error("checkpoint generation is invalid");
  if (!Number.isSafeInteger(checkpoint.owner_pid) || checkpoint.owner_pid <= 0) throw new Error("checkpoint owner is invalid");
  if (!Number.isFinite(Date.parse(checkpoint.created_at)) || !Number.isFinite(Date.parse(checkpoint.updated_at))) {
    throw new Error("checkpoint timestamps are invalid");
  }
  if (
    !checkpoint.authority
    || !Number.isFinite(Date.parse(checkpoint.authority.issued_at))
    || !Number.isFinite(Date.parse(checkpoint.authority.expires_at))
    || Date.parse(checkpoint.authority.expires_at) <= Date.parse(checkpoint.authority.issued_at)
  ) {
    throw new Error("checkpoint authority is invalid");
  }
  if (!CHECKPOINT_STATES.has(checkpoint.state)) throw new Error("checkpoint state is invalid");
  if (typeof checkpoint.task !== "string" || Buffer.byteLength(checkpoint.task, "utf8") > 64 * 1024) {
    throw new Error("checkpoint task is invalid");
  }
  if (!SHA256.test(checkpoint.task_digest) || checkpoint.task_digest !== digest(checkpoint.task)) {
    throw new Error("checkpoint task digest mismatch");
  }
  if (checkpoint.driver !== "ollama" && checkpoint.driver !== "selftest" && checkpoint.driver !== "cloud") {
    throw new Error("checkpoint driver is invalid");
  }
  if (
    (checkpoint.model !== null && typeof checkpoint.model !== "string")
    || (checkpoint.model_tag !== null && typeof checkpoint.model_tag !== "string")
    || (checkpoint.driver === "ollama" && (!checkpoint.model || !checkpoint.model_tag))
    || (checkpoint.driver === "selftest" && (checkpoint.model !== null || checkpoint.model_tag !== null))
    || (checkpoint.driver === "cloud" && (
      checkpoint.model_tag !== null
      || checkpoint.model === null
      || !checkpoint.model.trim()
      || isLocalModelId(checkpoint.model)
      || checkpoint.model.startsWith("aether-")
      || Buffer.byteLength(checkpoint.model, "utf8") > 256
    ))
  ) {
    throw new Error("checkpoint model binding is invalid");
  }
  if (checkpoint.max_uvt === undefined && checkpoint.driver !== "cloud") checkpoint.max_uvt = null;
  if (
    (checkpoint.driver === "cloud" && (!Number.isSafeInteger(checkpoint.max_uvt) || (checkpoint.max_uvt ?? 0) <= 0))
    || (checkpoint.driver !== "cloud" && checkpoint.max_uvt !== null)
  ) {
    throw new Error("checkpoint UVT budget binding is invalid");
  }
  if (checkpoint.effort !== null && (typeof checkpoint.effort !== "string" || checkpoint.effort.length > 32)) {
    throw new Error("checkpoint effort is invalid");
  }
  if (checkpoint.permission !== "deny" && checkpoint.permission !== "read-only" && checkpoint.permission !== "workspace-write") {
    throw new Error("checkpoint permission is invalid");
  }
  if (
    !Array.isArray(checkpoint.allowed_tools)
    || checkpoint.allowed_tools.some((tool) => typeof tool !== "string" || !TOOL_NAMES.has(tool))
    || new Set(checkpoint.allowed_tools).size !== checkpoint.allowed_tools.length
  ) {
    throw new Error("checkpoint allowed tools are invalid");
  }
  if (
    !Array.isArray(checkpoint.capability_packs)
    || checkpoint.capability_packs.length > 16
    || checkpoint.capability_packs.some((pack) => typeof pack !== "string" || !PACK_ID.test(pack))
    || new Set(checkpoint.capability_packs).size !== checkpoint.capability_packs.length
  ) {
    throw new Error("checkpoint capability packs are invalid");
  }
  if (checkpoint.agent !== null) {
    if (
      !checkpoint.agent
      || !SAFE_ID.test(checkpoint.agent.id)
      || checkpoint.agent.version !== HEADLESS_AGENT_VERSION
      || typeof checkpoint.agent.path !== "string"
      || isAbsolute(checkpoint.agent.path)
      || checkpoint.agent.path.split(/[\\/]/).includes("..")
      || !SHA256.test(checkpoint.agent.digest)
      || (checkpoint.agent.expires_at !== null && !Number.isFinite(Date.parse(checkpoint.agent.expires_at)))
    ) {
      throw new Error("checkpoint agent binding is invalid");
    }
  }
  if (
    !checkpoint.workspace
    || !SHA256.test(checkpoint.workspace.workspace_digest)
    || !SHA256.test(checkpoint.workspace.repository_digest)
    || !GIT_OBJECT_ID.test(checkpoint.workspace.head)
    || !SHA256.test(checkpoint.workspace.tree_digest)
  ) {
    throw new Error("checkpoint workspace binding is invalid");
  }
  if (
    !checkpoint.control
    || !Number.isSafeInteger(checkpoint.control.next_sequence)
    || checkpoint.control.next_sequence < 0
    || checkpoint.control.next_sequence > 256
    || !Number.isSafeInteger(checkpoint.control.steer_count)
    || checkpoint.control.steer_count < 0
    || checkpoint.control.steer_count > 16
    || !Number.isSafeInteger(checkpoint.control.steer_bytes)
    || checkpoint.control.steer_bytes < 0
    || checkpoint.control.steer_bytes > 16 * 1024
  ) {
    throw new Error("checkpoint control ledger is invalid");
  }
  if (
    !checkpoint.verification
    || (checkpoint.verification.command_digest !== null && !SHA256.test(checkpoint.verification.command_digest))
    || !VERIFICATION_STATES.has(checkpoint.verification.status)
    || (checkpoint.verification.exit_code !== null && !Number.isSafeInteger(checkpoint.verification.exit_code))
    || (checkpoint.verification.head !== null && !GIT_OBJECT_ID.test(checkpoint.verification.head))
    || (checkpoint.verification.tree_digest !== null && !SHA256.test(checkpoint.verification.tree_digest))
    || (checkpoint.verification.head === null) !== (checkpoint.verification.tree_digest === null)
  ) {
    throw new Error("checkpoint verification binding is invalid");
  }
  if (checkpoint.terminal_exit_code !== null && !Number.isSafeInteger(checkpoint.terminal_exit_code)) {
    throw new Error("checkpoint terminal exit code is invalid");
  }
  return checkpoint;
}

export class HeadlessCheckpointStore {
  readonly directory: string;

  constructor(private readonly workspace: string, directory?: string) {
    const root = realpathSync(resolve(workspace));
    this.directory = directory ?? join(configDir(), "exec-v2", digest(root).slice(0, 24));
  }

  path(session: string): string {
    if (!SAFE_ID.test(session)) throw new Error("invalid checkpoint session id");
    return join(this.directory, `${session}.json`);
  }

  create(input: CreateCheckpointInput): HeadlessCheckpoint {
    if (!SAFE_ID.test(input.session)) throw new Error("invalid checkpoint session id");
    if (!Number.isSafeInteger(input.authorityTtlMs) || input.authorityTtlMs < 1000 || input.authorityTtlMs > HEADLESS_AUTHORITY_MAX_MS) {
      throw new Error("authority TTL must be an integer from 1000 to 14400000");
    }
    const now = input.now ?? new Date();
    const agentExpiry = input.agent?.expiresAt ? Date.parse(input.agent.expiresAt) : Number.POSITIVE_INFINITY;
    const expires = Math.min(now.getTime() + input.authorityTtlMs, agentExpiry);
    const storedTask = String(redactHeadless(input.task));
    const checkpoint: HeadlessCheckpoint = {
      protocol: HEADLESS_CHECKPOINT_PROTOCOL,
      session: input.session,
      generation: 0,
      owner_pid: process.pid,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      authority: { issued_at: now.toISOString(), expires_at: new Date(expires).toISOString() },
      state: "running",
      task: storedTask,
      task_digest: digest(storedTask),
      driver: input.driver,
      model: input.model,
      model_tag: input.modelTag,
      max_uvt: input.maxUvt ?? null,
      effort: input.effort,
      permission: input.permission,
      allowed_tools: [...input.allowedTools].sort(),
      capability_packs: [...input.capabilityPacks].sort(),
      agent: input.agent ? {
        id: input.agent.id,
        version: input.agent.version,
        path: input.agent.path,
        digest: input.agent.digest,
        expires_at: input.agent.expiresAt,
      } : null,
      workspace: captureHeadlessWorkspace(this.workspace),
      control: { next_sequence: 0, steer_count: 0, steer_bytes: 0 },
      verification: {
        command_digest: commandDigest(input.verifyCommand),
        status: input.verifyCommand?.trim() ? "pending" : "unverified",
        exit_code: null,
        head: null,
        tree_digest: null,
      },
      terminal_exit_code: null,
    };
    validateCheckpoint(checkpoint, checkpoint.session);
    this.write(checkpoint, now);
    return checkpoint;
  }

  loadForResume(session: string, now: Date = new Date()): HeadlessCheckpoint {
    const path = this.path(session);
    let checkpoint: HeadlessCheckpoint;
    try { checkpoint = validateCheckpoint(JSON.parse(readFileSync(path, "utf8")), session); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("checkpoint")) throw error;
      throw new Error("checkpoint is missing or unreadable");
    }
    if (Date.parse(checkpoint.authority.expires_at) <= now.getTime()) throw new Error("checkpoint authority is expired");
    if (TERMINAL_STATES.has(checkpoint.state)) throw new Error(`checkpoint is terminal (${checkpoint.state})`);
    if (processAlive(checkpoint.owner_pid)) {
      throw new Error(`checkpoint is owned by active process ${checkpoint.owner_pid}`);
    }
    const current = captureHeadlessWorkspace(this.workspace);
    if (
      current.workspace_digest !== checkpoint.workspace.workspace_digest
      || current.repository_digest !== checkpoint.workspace.repository_digest
      || current.head !== checkpoint.workspace.head
      || current.tree_digest !== checkpoint.workspace.tree_digest
    ) {
      throw new Error("checkpoint repository or workspace binding is stale");
    }
    checkpoint.owner_pid = process.pid;
    checkpoint.generation += 1;
    checkpoint.state = "running";
    this.write(checkpoint, now);
    return checkpoint;
  }

  refreshWorkspace(checkpoint: HeadlessCheckpoint, now: Date = new Date()): void {
    checkpoint.workspace = captureHeadlessWorkspace(this.workspace);
    this.write(checkpoint, now);
  }

  write(checkpoint: HeadlessCheckpoint, now: Date = new Date()): void {
    checkpoint.updated_at = now.toISOString();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(checkpoint.session);
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(checkpoint, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* preserve original error */ }
      throw error;
    }
  }
}
