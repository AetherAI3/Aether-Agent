// Where the headless ATS runtime keeps its state, and the filesystem guards
// every write to it goes through.
//
// Spec 2 section 15 is explicit that `aether.ats.local/2` (ats.json) stays
// IMMUTABLE and the new runtime facts live in separate files beside it:
//
//   ats.json           — existing setup binding. Untouched by this module.
//   runtime.json       — installation receipt + supervisor state.
//   data-profile.json  — DataProfileV1 + the last probe receipt.
//   dashboard.json     — local dashboard enablement.
//
// The separation is not tidiness. An older Agent build reading ats.json must
// not find runtime authority encoded in it, or it will act on a runtime it
// cannot supervise. Keeping the new state in files it does not know about
// makes a downgrade safe by construction.

import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { managedAgentStorageDirectory, type ManagedAccountScope } from "../managed_agent_local.js";

/** The agent-scoped directory holding ats.json and the three Spec 2 files. */
export function atsStateDir(root: string, account: ManagedAccountScope, agentId: string): string {
  return managedAgentStorageDirectory(root, account, agentId);
}

export function runtimeStatePath(root: string, account: ManagedAccountScope, agentId: string): string {
  return join(atsStateDir(root, account, agentId), "runtime.json");
}

export function dataProfilePath(root: string, account: ManagedAccountScope, agentId: string): string {
  return join(atsStateDir(root, account, agentId), "data-profile.json");
}

export function dashboardStatePath(root: string, account: ManagedAccountScope, agentId: string): string {
  return join(atsStateDir(root, account, agentId), "dashboard.json");
}

/**
 * Wizard progress (section 5). A fourth file beside section 15's three: setup
 * progress is not runtime, data or dashboard state, and folding it into one of
 * those would hand an older Agent fields it cannot interpret.
 */
export function setupStatePath(root: string, account: ManagedAccountScope, agentId: string): string {
  return join(atsStateDir(root, account, agentId), "setup.json");
}

/**
 * The private runtime directory. Spec 2 step 2.3 requires the runtime to be
 * installed into an Agent-owned private directory, so it sits under the same
 * account- and agent-scoped root as the rest of the local state: an account
 * switch invalidates the whole subtree at once rather than leaving an
 * installed runtime reachable from a different account.
 */
export function runtimeInstallDir(root: string, account: ManagedAccountScope, agentId: string): string {
  return join(atsStateDir(root, account, agentId), "runtime");
}

/** Where a previous installation is parked so a failed upgrade can roll back. */
export function runtimePreviousDir(root: string, account: ManagedAccountScope, agentId: string): string {
  return join(atsStateDir(root, account, agentId), "runtime.previous");
}

/**
 * Refuse a path whose any ancestor is a symbolic link.
 *
 * This is the guard `ats_agent.ts` has always applied to its settings file,
 * lifted here so the runtime, data-profile and dashboard files get the same
 * treatment. Spec 2 section 14 requires refusing symlinks outright: without
 * this, an attacker who can create a link inside the agent's own storage
 * directory redirects a 0600 write — a credential file, an installation
 * receipt — to a path they can read.
 *
 * It walks upward to the filesystem root because checking only the leaf misses
 * a linked parent directory, which redirects the write just as effectively.
 */
export async function refuseSymlinkedPath(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("ATS runtime state cannot follow a symbolic link.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/**
 * Write a file atomically with owner-only permissions.
 *
 * `wx` on the temporary file means an existing path is never opened, so a
 * pre-created link or file cannot be written through. The rename is what makes
 * the update atomic: a reader sees either the whole previous file or the whole
 * new one, never a half-written receipt. Without this an interrupted install
 * leaves a truncated runtime.json that the next run would have to treat as
 * corrupt, which section 17's interrupted-installation canary forbids.
 */
export async function writePrivateFile(path: string, contents: string): Promise<void> {
  await refuseSymlinkedPath(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
