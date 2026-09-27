// InstructionResolver — precedence, per-file applicability, conflict detection.
// Pure over discovered sources; no filesystem access here.

import { INSTRUCTION_PRECEDENCE, type InstructionConflict, type InstructionGraph, type InstructionSource } from "./instruction_types.js";
import { sanitizeForTransport } from "../skills/context_packet.js";
import { discoverInstructionSources } from "./instruction_discovery.js";

/** Cursor-subset glob → RegExp ( ** , * , ? only — discovery rejected the rest). */
function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") { pattern += ".*"; index++; }
      else pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else if (char != null) {
      // The global flag is not load-bearing today — `char` is a single code unit,
      // so there is never a second occurrence to miss — but the escape must not
      // silently depend on that invariant if this ever takes a longer token.
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + pattern + "$");
}

/** Does one source apply to a project-relative file path (posix separators)? */
// One sanitizer for every channel content can leave on: the composed brief
// goes through it via fenceSafe, and the typed packet goes through it here.
// Two channels carrying the same bytes must not disagree about what is safe.

export function sourceAppliesTo(source: InstructionSource, relativePath: string | null): boolean {
  if (source.parseStatus === "unsupported-syntax") return false;
  if (relativePath == null) {
    // No active file: subtree- or glob-scoped sources do not apply globally.
    return source.scopeDir === "" && source.globs == null;
  }
  if (source.scopeDir !== "" && relativePath !== source.scopeDir && !relativePath.startsWith(source.scopeDir + "/")) {
    return false;
  }
  if (source.globs != null) {
    return source.globs.some((glob) => globToRegExp(glob).test(relativePath));
  }
  return true;
}

/** Applicable sources for a path, highest precedence first; nearer nested AGENTS.md outranks farther. */
export function applicableSources(
  sources: readonly InstructionSource[],
  relativePath: string | null,
): InstructionSource[] {
  return sources
    .filter((source) => sourceAppliesTo(source, relativePath))
    .sort((a, b) => {
      const rank = INSTRUCTION_PRECEDENCE[b.kind] - INSTRUCTION_PRECEDENCE[a.kind];
      if (rank !== 0) return rank;
      // Deeper nested scope is "nearer" and wins between two nested AGENTS.md.
      return b.scopeDir.length - a.scopeDir.length;
    });
}

const NPM_TEST_PATTERN = /(?:^|[`\s])((?:npm|pnpm|yarn)\s+(?:run\s+)?[\w:.-]*test[\w:.-]*)/gim;
const RUNNER_PATTERN = /(?:^|[`\s])(pytest|go\s+test|cargo\s+test)/gim;
/** An argument token worth keeping: a flag, a path, or a scoped target —
 *  ordinary prose words ("Never", "here") do not qualify, which keeps a
 *  greedy match from swallowing the rest of a sentence. */
const ARG_TOKEN = /^(?:-{1,2}[\w=:.\/-]+|[\w-]*[\/.:][\w\/.:=-]*)$/;

/** Extract declared test commands — the highest-signal conflict class. */
export function extractTestCommands(content: string): string[] {
  const commands = new Set<string>();
  for (const match of content.matchAll(NPM_TEST_PATTERN)) {
    const command = match[1]?.trim().replace(/[`.,;]+$/, "");
    if (command) commands.add(command);
  }
  for (const match of content.matchAll(RUNNER_PATTERN)) {
    const runner = match[1];
    if (!runner || match.index == null) continue;
    const start = match.index + match[0].length;
    const tail = content.slice(start, start + 200).trimStart();
    const parts: string[] = [runner.replace(/\s+/g, " ")];
    for (const token of tail.split(/\s+/)) {
      const clean = token.replace(/[`.,;]+$/, "");
      if (!clean || !ARG_TOKEN.test(clean)) break;
      parts.push(clean);
      if (clean !== token) break; // sentence punctuation ends the command
    }
    commands.add(parts.join(" "));
  }
  return [...commands];
}

export function detectConflicts(ordered: readonly InstructionSource[]): InstructionConflict[] {
  const conflicts: InstructionConflict[] = [];
  const entries: { source: InstructionSource; value: string }[] = [];
  for (const source of ordered) {
    for (const command of extractTestCommands(source.content)) {
      entries.push({ source, value: command });
    }
  }
  const distinct = new Set(entries.map((entry) => entry.value));
  if (distinct.size > 1 && entries.length > 1) {
    const winner = entries[0];
    if (winner) {
      conflicts.push({
        topic: "test command",
        entries,
        effective: winner.value,
        reason: sourceLabel(winner.source) + " has higher precedence",
      });
    }
  }
  return conflicts;
}

export function sourceLabel(source: InstructionSource): string {
  switch (source.kind) {
    case "aether-project": return "canonical Aether project instruction (" + source.displayPath + ")";
    case "agents-root": return "root AGENTS.md";
    case "agents-nested": return "nested " + source.displayPath;
    case "aether-user": return "user-level Aether instruction";
    default: return "compatibility import (" + source.displayPath + ")";
  }
}

/**
 * Sources that govern a whole-repo RUN, precedence-ordered.
 *
 * applicableSources(sources, null) answers a different question — "which
 * sources apply with no file open" — and correctly excludes anything scoped to
 * a subtree or a glob. An agent run has no single open file but may touch every
 * file, so a nested src/AGENTS.md unquestionably governs it. Using the
 * no-file-open set for a run silently dropped every nested source: its rules
 * never reached the model, and a root-vs-nested conflict could never be
 * detected because only one side was ever in the comparison.
 *
 * Scope and globs are not discarded — they ride with each source so the reader
 * can see which subtree or file pattern a rule speaks for.
 */
export function runScopedSources(sources: readonly InstructionSource[]): InstructionSource[] {
  return sources
    .filter((source) => source.parseStatus !== "unsupported-syntax")
    .sort((a, b) => {
      const rank = INSTRUCTION_PRECEDENCE[b.kind] - INSTRUCTION_PRECEDENCE[a.kind];
      if (rank !== 0) return rank;
      return b.scopeDir.length - a.scopeDir.length;
    });
}

/** Build the full graph for a project: discovery + run-scope conflict pass. */
export function resolveInstructionGraph(projectRoot: string): InstructionGraph {
  const { sources, skipped, nestedScanComplete } = discoverInstructionSources(projectRoot);
  // runScopedSources drops a source whose glob frontmatter would not parse: its
  // scope is unknown, so applying it to the whole run would be a guess about
  // which files it governs. Dropping it is right; dropping it SILENTLY is not —
  // discovery found the file, read it, and the user believes it is in force.
  const unparsable = sources
    .filter((source) => source.parseStatus === "unsupported-syntax")
    .map((source) => ({
      path: source.displayPath,
      reason: "its scope could not be parsed, so it governs no known files and was NOT sent",
    }));
  return {
    sources,
    conflicts: detectConflicts(runScopedSources(sources)),
    skipped: [...skipped, ...unparsable],
    nestedScanComplete,
  };
}

export const INSTRUCTION_CONTEXT_CONTRACT_VERSION = 1;

export interface InstructionContextSource {
  kind: string;
  path: string;
  scope: string;
  digest: string;
  content: string;
  /**
   * File patterns this source is limited to (Cursor rules), or null for "the
   * whole scope". Additive and optional: a source whose applicability is
   * narrower than its directory must say so, or the reader treats a rule for
   * `*.tsx` as a rule for everything.
   */
  globs?: readonly string[];
}

export interface InstructionContextPacket {
  contract_version: number;
  sources: readonly InstructionContextSource[];
}

/**
 * Transport packet for the brain. Provenance rides with every source so the
 * model and the UI can attribute guidance; content is data, not system policy.
 */
export function buildInstructionContextPacket(
  sources: readonly InstructionSource[],
  relativePath: string | null,
): InstructionContextPacket {
  return packetOf(applicableSources(sources, relativePath));
}

/**
 * The packet for a whole-repo run: every source that can govern it, each
 * carrying the subtree and file patterns it speaks for. See runScopedSources.
 */
export function buildRunInstructionContextPacket(
  sources: readonly InstructionSource[],
): InstructionContextPacket {
  return packetOf(runScopedSources(sources));
}

function packetOf(ordered: readonly InstructionSource[]): InstructionContextPacket {
  return {
    contract_version: INSTRUCTION_CONTEXT_CONTRACT_VERSION,
    sources: ordered.map((source) => ({
      kind: source.kind,
      path: source.displayPath,
      scope: source.scopeDir === "" ? "project" : source.scopeDir,
      digest: "sha256:" + source.sha256,
      // Same treatment the skill packet gives skill bodies. An instruction file
      // is attacker-influenced content too (any repo you clone carries one), and
      // it must not reach a transport — or a consumer that reads this packet
      // instead of the composed brief — carrying raw control bytes.
      content: sanitizeForTransport(source.content),
      ...(source.globs ? { globs: source.globs } : {}),
    })),
  };
}
