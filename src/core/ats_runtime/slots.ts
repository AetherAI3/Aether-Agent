// Versioned installation slots — the transactional core of runtime install
// and rollback.
//
// The previous design swapped the live directory and THEN wrote the receipt,
// so a crash in between left `runtime.json` describing bytes that were no
// longer there, and rollback deleted the version it displaced. Both are fixed
// by never mutating anything in place:
//
//   <install root>/active.json              atomic pointer: which slot is live
//   <install root>/slots/a/                 one complete installation
//   <install root>/slots/a/.ats-slot-receipt.json
//   <install root>/slots/b/                 the other one
//
// An install fully populates the INACTIVE slot, verifies it, writes and fsyncs
// that slot's receipt, and only then rewrites the pointer. The pointer write is
// the commit: before it the old install is untouched and the new one invisible;
// after it the new one is live and the old one is still intact one directory
// away. Rollback is therefore the same operation in reverse — a pointer switch,
// deleting nothing.
//
// RECOVERY. A crash can only leave the pointer naming a slot whose receipt is
// missing or inconsistent, because the pointer is written last.
// `recoverActiveSlot` detects that and falls back to the other slot when it is
// self-consistent, so the next start runs a known-good version rather than a
// half-installed one.

import { createHash } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { choice, closed, hex64, ident, schemaTag, timestamp } from "../ats_contracts/primitives.js";
import {
  validateRuntimeInstallationReceipt,
  type RuntimeInstallationReceiptV1,
} from "../ats_contracts/runtime.js";
import { refuseSymlinkedPath, writePrivateFile } from "./paths.js";

export const ACTIVE_POINTER_SCHEMA = "aether.ats.runtime-active/1" as const;
export const SLOT_RECEIPT_SCHEMA = "aether.ats.runtime-slot/1" as const;

export const SLOTS = ["a", "b"] as const;
export type SlotName = (typeof SLOTS)[number];

/** The file a slot's own receipt lives in; excluded from that slot's digest. */
export const SLOT_RECEIPT_FILE = ".ats-slot-receipt.json";

export function slotsRoot(installRoot: string): string {
  return join(installRoot, "slots");
}

export function slotDir(installRoot: string, slot: SlotName): string {
  return join(slotsRoot(installRoot), slot);
}

export function slotReceiptPath(installRoot: string, slot: SlotName): string {
  return join(slotDir(installRoot, slot), SLOT_RECEIPT_FILE);
}

export function activePointerPath(installRoot: string): string {
  return join(installRoot, "active.json");
}

export function otherSlot(slot: SlotName): SlotName {
  return slot === "a" ? "b" : "a";
}

export interface ActivePointerV1 {
  readonly schema_version: typeof ACTIVE_POINTER_SCHEMA;
  readonly slot: SlotName;
  readonly installation_id: string;
  readonly tree_sha256: string;
  readonly switched_at: string;
}

const POINTER_FIELDS = ["schema_version", "slot", "installation_id", "tree_sha256", "switched_at"] as const;

export function validateActivePointer(value: unknown, name = "Active runtime pointer"): ActivePointerV1 {
  const raw = closed(value, name, POINTER_FIELDS);
  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, ACTIVE_POINTER_SCHEMA, name) as typeof ACTIVE_POINTER_SCHEMA,
    slot: choice(raw.slot, SLOTS, `${name} slot`),
    installation_id: ident(raw.installation_id, `${name} installation id`),
    tree_sha256: hex64(raw.tree_sha256, `${name} tree digest`),
    switched_at: timestamp(raw.switched_at, `${name} switched at`),
  });
}

export interface SlotReceiptV1 {
  readonly schema_version: typeof SLOT_RECEIPT_SCHEMA;
  readonly slot: SlotName;
  readonly installation: RuntimeInstallationReceiptV1;
  readonly tree_sha256: string;
  readonly committed_at: string;
}

const SLOT_FIELDS = ["schema_version", "slot", "installation", "tree_sha256", "committed_at"] as const;

export function validateSlotReceipt(value: unknown, name = "Runtime slot receipt"): SlotReceiptV1 {
  const raw = closed(value, name, SLOT_FIELDS);
  return Object.freeze({
    schema_version: schemaTag(raw.schema_version, SLOT_RECEIPT_SCHEMA, name) as typeof SLOT_RECEIPT_SCHEMA,
    slot: choice(raw.slot, SLOTS, `${name} slot`),
    installation: validateRuntimeInstallationReceipt(raw.installation, `${name} installation`),
    tree_sha256: hex64(raw.tree_sha256, `${name} tree digest`),
    committed_at: timestamp(raw.committed_at, `${name} committed at`),
  });
}

/**
 * The record separator, BUILT rather than written as an escape.
 *
 * A `\u0000` escape typed into a source file can land on disk as a real NUL
 * byte instead of the six escape characters. Runtime behaviour is identical so
 * tests stay green, but git then classifies the file as binary and the diff
 * becomes unreviewable — which happened to this exact file once already.
 * Constructing it leaves nothing for an escape layer to mangle. The digest is
 * unchanged either way; only the spelling in source differs.
 */
const NUL = String.fromCharCode(0);

/**
 * A deterministic digest over a directory's contents.
 *
 * Paths are normalized to forward slashes and sorted, so the same tree hashes
 * identically on Windows and POSIX — otherwise a receipt written on one would
 * refuse to verify on the other. Each file contributes its relative path, its
 * length and the digest of its bytes; the length is included so two files
 * whose contents differ only at a truncation boundary cannot collide by
 * concatenation. Directories contribute their path alone, which keeps an empty
 * directory meaningful rather than invisible.
 *
 * Mode bits are deliberately NOT included: Windows does not carry POSIX
 * permissions, so hashing them would make every digest platform-specific.
 */
export async function computeTreeDigest(
  root: string,
  exclude: readonly string[] = [SLOT_RECEIPT_FILE],
): Promise<string> {
  const skip = new Set(exclude);
  const records: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    const listing = await readdir(dir, { withFileTypes: true });
    for (const item of listing) {
      const full = join(dir, item.name);
      const rel = relative(root, full).split(sep).join("/");
      if (skip.has(rel) || skip.has(item.name)) continue;
      if (item.isDirectory()) {
        records.push(`d${NUL}${rel}`);
        await walk(full);
        continue;
      }
      if (!item.isFile()) continue;
      const bytes = await readFile(full);
      records.push(`f${NUL}${rel}${NUL}${bytes.byteLength}${NUL}${createHash("sha256").update(bytes).digest("hex")}`);
    }
  };

  await walk(root);
  records.sort();
  return createHash("sha256").update(records.join("\n")).digest("hex");
}

async function readJsonOrNull(path: string): Promise<unknown | null> {
  await refuseSymlinkedPath(path);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // A corrupt pointer or receipt reads as absent rather than throwing:
    // recovery's whole job is to cope with a half-written file, and the other
    // slot is still there to fall back to.
    return null;
  }
}

export async function readActivePointer(installRoot: string): Promise<ActivePointerV1 | null> {
  const parsed = await readJsonOrNull(activePointerPath(installRoot));
  if (parsed === null) return null;
  try {
    return validateActivePointer(parsed);
  } catch {
    return null;
  }
}

export async function readSlotReceipt(installRoot: string, slot: SlotName): Promise<SlotReceiptV1 | null> {
  const parsed = await readJsonOrNull(slotReceiptPath(installRoot, slot));
  if (parsed === null) return null;
  try {
    const receipt = validateSlotReceipt(parsed);
    // A receipt naming a different slot was copied, not committed here.
    return receipt.slot === slot ? receipt : null;
  } catch {
    return null;
  }
}

export async function writeSlotReceipt(installRoot: string, receipt: SlotReceiptV1): Promise<void> {
  await writePrivateFile(
    slotReceiptPath(installRoot, receipt.slot),
    JSON.stringify(validateSlotReceipt(receipt), null, 2) + "\n",
  );
}

/**
 * The commit. `writePrivateFile` writes a temporary file, fsyncs it and
 * renames, so the pointer is never observed half-written: a reader sees the
 * previous slot or the new one, never a torn value.
 */
export async function switchActiveSlot(installRoot: string, pointer: ActivePointerV1): Promise<void> {
  await writePrivateFile(
    activePointerPath(installRoot),
    JSON.stringify(validateActivePointer(pointer), null, 2) + "\n",
  );
}

export interface SlotResolution {
  readonly slot: SlotName;
  readonly receipt: SlotReceiptV1;
  /** True when the pointer was inconsistent and this came from the other slot. */
  readonly recovered: boolean;
}

/**
 * Resolve which slot should be live, repairing an interrupted install.
 *
 * Checks, in order: the pointer names a slot; that slot has a receipt; the
 * receipt agrees with the pointer on installation id and tree digest. If any of
 * that fails, the other slot is tried, and if it is self-consistent the pointer
 * is rewritten to it. That is the rollback half of section 17's
 * interrupted-installation canary, performed automatically rather than left for
 * an operator to discover.
 *
 * This does NOT re-hash the tree — that is `verifyActiveTree`, which callers run
 * before launch. Recovery only answers "which slot is internally consistent",
 * and re-hashing here would make every status call walk the whole tree.
 */
export async function recoverActiveSlot(installRoot: string, now: string): Promise<SlotResolution | null> {
  const pointer = await readActivePointer(installRoot);

  if (pointer) {
    const receipt = await readSlotReceipt(installRoot, pointer.slot);
    if (receipt
      && receipt.installation.installation_id === pointer.installation_id
      && receipt.tree_sha256 === pointer.tree_sha256) {
      return { slot: pointer.slot, receipt, recovered: false };
    }
  }

  // Either there is no pointer, or it names a slot whose commit never
  // finished. Fall back to whichever slot is self-consistent.
  const candidates: readonly SlotName[] = pointer ? [otherSlot(pointer.slot)] : SLOTS;
  for (const slot of candidates) {
    const receipt = await readSlotReceipt(installRoot, slot);
    if (!receipt) continue;
    await switchActiveSlot(installRoot, {
      schema_version: ACTIVE_POINTER_SCHEMA,
      slot,
      installation_id: receipt.installation.installation_id,
      tree_sha256: receipt.tree_sha256,
      switched_at: now,
    });
    return { slot, receipt, recovered: true };
  }
  return null;
}

/**
 * Re-hash the live slot and compare it to its receipt. This is the "verify
 * active bytes against the active receipt before launch" check: a receipt
 * proves what was installed, and only a fresh digest proves those are still the
 * bytes on disk.
 *
 * It costs one pass over the tree, which is acceptable because the runtime is a
 * long-lived daemon started rarely rather than a per-command hot path — and the
 * alternative is launching whatever happens to be sitting in the directory.
 */
export async function verifyActiveTree(installRoot: string, resolution: SlotResolution): Promise<boolean> {
  const dir = slotDir(installRoot, resolution.slot);
  try {
    if (!(await stat(dir)).isDirectory()) return false;
  } catch {
    return false;
  }
  return (await computeTreeDigest(dir)) === resolution.receipt.tree_sha256;
}

/** Discard a slot entirely. Only ever called on the INACTIVE slot. */
export async function clearSlot(installRoot: string, slot: SlotName): Promise<void> {
  await rm(slotDir(installRoot, slot), { recursive: true, force: true });
}
