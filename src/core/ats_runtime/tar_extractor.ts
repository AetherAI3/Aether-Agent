// A strictly bounded POSIX ustar extractor for a future *explicitly pinned*
// runtime archive format. It is not selected by default: the release owner
// must first publish a signed manifest format and artifact contract.
//
// Parse and validate the entire archive before its first filesystem write.
// Refuse PAX/GNU extensions, links, special files, duplicates, absolute paths,
// Windows alternate streams, non-canonical names and corrupt checksums. Then
// confine each create in the private staging directory, with O_EXCL/O_NOFOLLOW
// for files. The post-extraction walk remains an independent second check.

import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { checkEntries, DEFAULT_ARCHIVE_LIMITS, type ArchiveEntry, type ArchiveLimits } from "./archive_guard.js";
import { refuseSymlinkedPath } from "./paths.js";
import type { ArchiveExtractor } from "./install.js";

const BLOCK = 512;

interface TarEntry {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly size: number;
  readonly offset: number;
  readonly executable: boolean;
}

function invalid(): never {
  // Deliberately never print untrusted archive paths or header bytes.
  throw new Error("The ATS runtime archive is malformed or unsupported.");
}

function field(header: Uint8Array, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  const bytes = end < 0 ? raw : raw.subarray(0, end);
  const value = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(value, "utf8").equals(Buffer.from(bytes))) invalid();
  return value;
}

function octal(header: Uint8Array, start: number, length: number): number {
  const value = field(header, start, length).trim();
  if (!/^[0-7]+$/.test(value)) invalid();
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) invalid();
  return parsed;
}

function validPath(path: string, type: "file" | "directory", maxLength: number): void {
  const candidate = type === "directory" && path.endsWith("/") ? path.slice(0, -1) : path;
  if (!candidate || candidate.length > maxLength || candidate.includes("\\") || candidate.includes(":")) invalid();
  if (isAbsolute(candidate) || candidate.startsWith("/") || candidate.startsWith("//")) invalid();
  if (candidate.split("/").some(part => !part || part === "." || part === ".." ||
    /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) invalid();
  if (/\p{Cc}/u.test(candidate)) invalid();
}

function parseTar(bytes: Uint8Array, limits: ArchiveLimits): TarEntry[] {
  if (bytes.byteLength < BLOCK * 2 || bytes.byteLength % BLOCK !== 0) invalid();
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let position = 0;
  let ended = false;
  while (position < bytes.byteLength) {
    const header = bytes.subarray(position, position + BLOCK);
    if (header.every(b => b === 0)) {
      if (position + 2 * BLOCK > bytes.byteLength ||
          !bytes.subarray(position).every(b => b === 0)) invalid();
      ended = true;
      break;
    }
    if (field(header, 257, 6) !== "ustar" || field(header, 263, 2) !== "00") invalid();
    const checksum = octal(header, 148, 8);
    let calculated = 0;
    for (let i = 0; i < BLOCK; i += 1) {
      calculated += i >= 148 && i < 156 ? 32 : header[i]!;
    }
    if (checksum !== calculated) invalid();
    const flag = header[156];
    const type = flag === 0 || flag === 48 ? "file" : flag === 53 ? "directory" : invalid();
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    validPath(path, type, limits.maxPathLength);
    const canonical = type === "directory" && path.endsWith("/") ? path.slice(0, -1) : path;
    if (seen.has(canonical)) invalid();
    seen.add(canonical);
    const size = octal(header, 124, 12);
    if (type === "directory" && size !== 0) invalid();
    const rounded = Math.ceil(size / BLOCK) * BLOCK;
    const next = position + BLOCK + rounded;
    if (!Number.isSafeInteger(next) || next > bytes.byteLength) invalid();
    if (type === "file" && bytes.subarray(position + BLOCK + size, next).some(b => b !== 0)) invalid();
    entries.push({ path: canonical, type, size, offset: position + BLOCK,
      executable: (octal(header, 100, 8) & 0o111) !== 0 });
    if (entries.length > limits.maxEntries) invalid();
    position = next;
  }
  if (!ended) invalid();
  const verdict = checkEntries(entries.map(({ path, type, size }): ArchiveEntry => ({ path, type, size })), limits);
  if (!verdict.ok) invalid();
  // The entry count and output bytes are already bounded before writes.
  return entries;
}

/** Available only once an artifact manifest explicitly pins POSIX ustar. */
export const strictTarExtractor: ArchiveExtractor = {
  async extract({ bytes, destination, limits = DEFAULT_ARCHIVE_LIMITS, signal }) {
    signal?.throwIfAborted();
    const entries = parseTar(bytes, limits);
    await refuseSymlinkedPath(destination);
    const root = resolve(destination);
    for (const entry of entries) {
      signal?.throwIfAborted();
      const target = resolve(root, entry.path);
      const rel = relative(root, target);
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) invalid();
      const parent = dirname(target);
      await refuseSymlinkedPath(parent);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await refuseSymlinkedPath(parent);
      if (entry.type === "directory") {
        await mkdir(target, { mode: 0o700 });
      } else {
        const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0), entry.executable ? 0o700 : 0o600);
        try {
          await handle.writeFile(bytes.subarray(entry.offset, entry.offset + entry.size));
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    }
  },
};
