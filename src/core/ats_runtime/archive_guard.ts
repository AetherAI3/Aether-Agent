// The security contract every ATS runtime archive must satisfy before its
// bytes are allowed to become an installation.
//
// strictTarExtractor now provides a bounded ustar implementation, but it is
// not automatically selected until the release owner pins a signed archive
// format. Other extractors must satisfy these same rules.
//
// TWO LAYERS. The extractor must enforce confinement while it writes:
//
//   1. `checkEntries` screens a declared listing BEFORE extraction, for
//      extractors that can enumerate an archive cheaply. Advisory: a hostile
//      archive can misdeclare its own listing.
//   2. `verifyExtractedTree` walks what remains inside staging afterwards with
//      lstat and refuses unsafe entries. It cannot discover a write outside
//      staging or reverse disk exhaustion that already occurred. A real
//      extractor must reject escaping paths and bound extraction up front.
//
// A caller that skips layer 2 has no contract at all, so `install.ts` runs it
// unconditionally and discards the staging tree on any violation.

import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { refuseSymlinkedPath } from "./paths.js";

export type ArchiveViolation =
  | "too_many_entries"
  | "too_large"
  | "path_escape"
  | "symlink"
  | "hardlink"
  | "device"
  | "absolute_path"
  | "parent_traversal"
  | "name_too_long";

export interface ArchiveVerdict {
  readonly ok: boolean;
  readonly violation: ArchiveViolation | null;
  /** Bounded and path-free: a violation message must not echo an attacker's path. */
  readonly detail: string | null;
}

const OK: ArchiveVerdict = Object.freeze({ ok: true, violation: null, detail: null });

function refuse(violation: ArchiveViolation, detail: string): ArchiveVerdict {
  return { ok: false, violation, detail };
}

export interface ArchiveLimits {
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
  readonly maxPathLength: number;
}

/**
 * Defaults sized for a Python runtime tree with its virtualenv: generous
 * enough not to reject a legitimate install, bounded enough that a malicious
 * archive cannot fill a disk before the digest check would have caught it.
 */
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({
  maxEntries: 200_000,
  maxTotalBytes: 2 * 1024 ** 3,
  maxPathLength: 1_024,
});

export type ArchiveEntryType = "file" | "directory" | "symlink" | "hardlink" | "other";

export interface ArchiveEntry {
  readonly path: string;
  readonly type: ArchiveEntryType;
  readonly size: number;
}

/**
 * Screen a declared listing. Advisory only — see the module header — but it
 * lets an extractor refuse before writing a single byte.
 */
export function checkEntries(
  entries: readonly ArchiveEntry[],
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): ArchiveVerdict {
  if (entries.length > limits.maxEntries) {
    return refuse("too_many_entries", `The archive declares more than ${limits.maxEntries} entries.`);
  }
  let total = 0;
  for (const entry of entries) {
    const path = entry.path;
    if (typeof path !== "string" || !path.length || path.length > limits.maxPathLength) {
      return refuse("name_too_long", "The archive contains an entry whose path is missing or too long.");
    }
    // A NUL byte truncates a path in a C-level syscall, so a name containing
    // one can address a different file than the one validated here.
    if (path.includes("\0")) {
      return refuse("path_escape", "The archive contains an entry with an embedded NUL byte.");
    }
    if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.startsWith("\\\\")) {
      return refuse("absolute_path", "The archive contains an absolute path.");
    }
    if (path.split(/[/\\]/).includes("..")) {
      return refuse("parent_traversal", "The archive contains a parent-directory traversal.");
    }
    if (entry.type === "symlink") return refuse("symlink", "The archive contains a symbolic link.");
    if (entry.type === "hardlink") return refuse("hardlink", "The archive contains a hard link.");
    if (entry.type === "other") return refuse("device", "The archive contains a device or special file.");

    if (entry.type === "file") {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
        return refuse("too_large", "The archive declares an invalid entry size.");
      }
      total += entry.size;
      if (total > limits.maxTotalBytes) {
        return refuse("too_large", `The archive declares more than ${limits.maxTotalBytes} bytes.`);
      }
    }
  }
  return OK;
}

/**
 * Walk what was actually extracted and refuse anything that should not exist.
 *
 * `lstat` rather than `stat` throughout: `stat` follows a link and would
 * happily report a symlink-to-/etc as an ordinary file. Every real path is
 * additionally resolved and confined to the staging root, which catches a link
 * whose target sits outside even when the link itself looks innocuous.
 */
export async function verifyExtractedTree(
  root: string,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<ArchiveVerdict> {
  try {
    await refuseSymlinkedPath(root);
    if (!(await lstat(root)).isDirectory()) {
      return refuse("device", "The extracted tree root is not a directory.");
    }
  } catch {
    return refuse("path_escape", "The extracted tree root or an ancestor is unsafe.");
  }
  const base = await realpath(resolve(root));
  let entries = 0;
  let total = 0;

  const walk = async (dir: string): Promise<ArchiveVerdict> => {
    const listing = await readdir(dir, { withFileTypes: true });
    for (const item of listing) {
      entries += 1;
      if (entries > limits.maxEntries) {
        return refuse("too_many_entries", `The extracted tree holds more than ${limits.maxEntries} entries.`);
      }
      const full = join(dir, item.name);
      if (item.name.includes("\0")) {
        return refuse("path_escape", "An extracted entry has an embedded NUL byte.");
      }
      const rel = relative(base, resolve(full));
      if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
        return refuse("path_escape", "An extracted entry resolves outside the staging directory.");
      }

      const stats = await lstat(full);
      if (stats.isSymbolicLink()) {
        return refuse("symlink", "The extracted tree contains a symbolic link.");
      }
      if (stats.isBlockDevice() || stats.isCharacterDevice() || stats.isFIFO() || stats.isSocket()) {
        return refuse("device", "The extracted tree contains a device or special file.");
      }
      if (stats.isDirectory()) {
        const nested = await walk(full);
        if (!nested.ok) return nested;
        continue;
      }
      if (!stats.isFile()) {
        return refuse("device", "The extracted tree contains an unsupported file type.");
      }
      // More than one link to the same inode means a hard link, which can
      // alias a file outside the tree that lstat alone reports as ordinary.
      if (stats.nlink > 1) {
        return refuse("hardlink", "The extracted tree contains a hard link.");
      }
      total += stats.size;
      if (total > limits.maxTotalBytes) {
        return refuse("too_large", `The extracted tree exceeds ${limits.maxTotalBytes} bytes.`);
      }
    }
    return OK;
  };

  return walk(base);
}
