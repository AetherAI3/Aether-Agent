// Explicitly pinned files are read once, at turn admission, from the checkout
// where the host will execute. Registry snapshots contain paths only.
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync, readlinkSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { confineToWorkspace, normalizeWorkspace } from "./workspace_scope.js";
import type { PinnedEntry } from "./context_registry.js";

export const SELECTED_CONTEXT_BOUNDS = {
  maxPins: 32,
  maxFileBytes: 64 * 1024,
} as const;

export interface PinSelection {
  originRoot: string | null;
  entries: readonly PinnedEntry[];
}

export type SelectedFileStatus = "included" | "unbound" | "outside" | "missing" | "unsupported" | "unreadable" | "too_large" | "binary" | "invalid_utf8" | "changed" | "budget" | "pin_limit" | "duplicate";

export interface SelectedFileDescriptor {
  /** Project-relative identity from the registry origin, when valid. */
  path: string;
  originPath: string;
  executionPath: string | null;
  status: SelectedFileStatus;
  reason: string;
  sourceBytes: number | null;
  includedBytes: number;
  /** Hash of the exact UTF-8 file bytes read at preview/admission. */
  digest: string | null;
  /** Full file only; no partial-file inclusion. */
  range: string | null;
}

export interface RunContextDescriptor {
  executionRoot: string;
  originRoot: string | null;
  capability: "coding" | "planning";
  transport: "host-executed" | "server-executed";
  files: readonly SelectedFileDescriptor[];
  rules: readonly { path: string; digest: string; status: string }[];
  skills: readonly { id: string; digest: string; invocation: string }[];
  contextBytes: number;
  contextLimitBytes: number;
}

/** In-memory only; contents never enter registry snapshots or generic logs. */
export interface AdmittedContext {
  descriptor: RunContextDescriptor;
  contents: ReadonlyMap<string, string>;
}

export interface ReadSelectedFile {
  descriptor: SelectedFileDescriptor;
  content: string | null;
}

function omission(path: string, originPath: string, executionPath: string | null, status: SelectedFileStatus, reason: string, sourceBytes: number | null = null): ReadSelectedFile {
  return { descriptor: { path, originPath, executionPath, status, reason, sourceBytes, includedBytes: 0, digest: null, range: null }, content: null };
}

function projectRelative(originRoot: string, path: string): string | null {
  const rel = relative(originRoot, path);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** Deterministic registry order. No neighboring-file scan and no fallback to origin. */
export function readSelectedFiles(selection: PinSelection, executionRoot: string): ReadSelectedFile[] {
  const targetRoot = normalizeWorkspace(executionRoot);
  const seen = new Set<string>();
  let originRoot: string | null = null;
  if (selection.originRoot) {
    try { originRoot = normalizeWorkspace(selection.originRoot); } catch { /* explicit unbound omissions below */ }
  }
  return selection.entries.map((pin, index) => {
    if (index >= SELECTED_CONTEXT_BOUNDS.maxPins) {
      return omission(pin.path, pin.path, null, "pin_limit", `only the first ${SELECTED_CONTEXT_BOUNDS.maxPins} pins can be assembled`);
    }
    if (!originRoot) return omission(pin.path, pin.path, null, "unbound", "pin origin workspace is unknown; no file was read");
    const rel = projectRelative(originRoot, pin.path);
    if (!rel) return omission(pin.path, pin.path, null, "outside", "pin is not a file below its recorded origin workspace");
    if (seen.has(rel)) return omission(rel, pin.path, null, "duplicate", "this project-relative file was already selected");
    seen.add(rel);
    let bound: string;
    try { bound = confineToWorkspace(targetRoot, rel); }
    catch { return omission(rel, pin.path, null, "outside", "execution path escapes its workspace or follows an outside link"); }
    let fd: number;
    try { fd = openSync(bound, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return omission(rel, pin.path, bound,
        code === "ENOENT" ? "missing" : code === "EISDIR" ? "unsupported" : "unreadable",
        code === "ENOENT" ? "file is absent in the execution workspace" : code === "EISDIR" ? "pin is not a regular file" : `file cannot be opened (${code ?? "unknown"})`);
    }
    try {
      const before = fstatSync(fd);
      if (!before.isFile()) return omission(rel, pin.path, bound, "unsupported", "pin is not a regular file");
      if (process.platform === "linux") {
        const opened = readlinkSync(`/proc/self/fd/${fd}`).replace(/ \(deleted\)$/, "");
        if (opened !== targetRoot && !opened.startsWith(targetRoot + sep)) {
          return omission(rel, pin.path, bound, "outside", "opened file resolves outside the execution workspace");
        }
      } else {
        const named = statSync(bound);
        if (named.dev !== before.dev || named.ino !== before.ino) {
          return omission(rel, pin.path, bound, "changed", "file path changed while opening; retry admission");
        }
      }
      if (before.size > SELECTED_CONTEXT_BOUNDS.maxFileBytes) {
        return omission(rel, pin.path, bound, "too_large", `file exceeds ${SELECTED_CONTEXT_BOUNDS.maxFileBytes} bytes`, before.size);
      }
      const buffer = Buffer.alloc(SELECTED_CONTEXT_BOUNDS.maxFileBytes + 1);
      let count = 0;
      while (count < buffer.length) {
        const n = readSync(fd, buffer, count, buffer.length - count, null);
        if (n === 0) break;
        count += n;
      }
      const after = fstatSync(fd);
      if (count > SELECTED_CONTEXT_BOUNDS.maxFileBytes) return omission(rel, pin.path, bound, "too_large", `file exceeds ${SELECTED_CONTEXT_BOUNDS.maxFileBytes} bytes`, after.size);
      let rebound: string | null = null;
      try { rebound = confineToWorkspace(targetRoot, rel); } catch { /* link changed or escaped */ }
      let namedMatches = false;
      try {
        const named = statSync(bound);
        namedMatches = named.dev === after.dev && named.ino === after.ino;
      } catch { /* file was removed or rebound */ }
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || count !== after.size || rebound !== bound || !namedMatches) {
        return omission(rel, pin.path, bound, "changed", "file changed during admission; retry to read one stable version", after.size);
      }
      const bytes = buffer.subarray(0, count);
      if (bytes.some((byte) => byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)) {
        return omission(rel, pin.path, bound, "binary", "file contains binary control bytes", count);
      }
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { return omission(rel, pin.path, bound, "invalid_utf8", "file is not valid UTF-8", count); }
      const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
      return { descriptor: { path: rel, originPath: pin.path, executionPath: bound, status: "included", reason: "complete file bound to execution workspace", sourceBytes: count, includedBytes: count, digest, range: count === 0 ? "empty file" : `bytes 0-${count - 1}` }, content };
    } catch (error) {
      return omission(rel, pin.path, bound, "unreadable", `file cannot be read (${(error as NodeJS.ErrnoException).code ?? "unknown"})`);
    } finally { closeSync(fd); }
  });
}
