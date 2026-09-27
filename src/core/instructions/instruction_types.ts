// Typed boundary for instruction-file discovery and resolution.
//
// Instruction files are TEXT GUIDANCE with visible provenance — never
// executable configuration. Nothing here runs commands, follows links,
// grants permissions, or imports secrets.

export type InstructionSourceKind =
  | "aether-project"   // .aether/instructions.md — canonical project instruction
  | "agents-root"      // AGENTS.md at the project root
  | "agents-nested"    // AGENTS.md in a subdirectory (applies to its subtree)
  | "aether-user"      // user-level Aether instructions (<configDir>/instructions.md)
  | "claude"           // CLAUDE.md compatibility import
  | "gemini"           // GEMINI.md compatibility import
  | "copilot"          // .github/copilot-instructions.md compatibility import
  | "cursor-rule";     // .cursor/rules/*.mdc compatibility import

/**
 * Precedence rank — higher wins on conflict (operator turn and active skill
 * outrank all files and live outside this module). A lower-precedence source
 * may add non-conflicting guidance but never erases a higher one.
 */
export const INSTRUCTION_PRECEDENCE: Readonly<Record<InstructionSourceKind, number>> = {
  "agents-nested": 60,
  "aether-project": 50,
  "agents-root": 40,
  "aether-user": 30,
  "claude": 20,
  "gemini": 19,
  "copilot": 18,
  "cursor-rule": 17,
};

export interface InstructionSource {
  kind: InstructionSourceKind;
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the project root where applicable, else the absolute path. */
  displayPath: string;
  /**
   * Directory subtree (relative to project root, "" = whole project) the
   * source applies to. Nested AGENTS.md applies only inside its directory.
   */
  scopeDir: string;
  /** Cursor rules: parsed glob patterns; null = applies to whole scope. */
  globs: readonly string[] | null;
  /** sha256 of the raw bytes — provenance for the context drawer / doctor. */
  sha256: string;
  sizeBytes: number;
  content: string;
  parseStatus: "ok" | "truncated" | "unsupported-syntax" | "invalid-encoding";
  /** Honest warnings, e.g. unsupported Cursor matching syntax. */
  warnings: readonly string[];
}

export interface InstructionConflict {
  /** e.g. "test command" */
  topic: string;
  entries: readonly { source: InstructionSource; value: string }[];
  /** The winning value after precedence. */
  effective: string;
  reason: string;
}

export interface InstructionGraph {
  sources: readonly InstructionSource[];
  conflicts: readonly InstructionConflict[];
  /** Sources discovered but skipped, with a visible reason (over cap, bad encoding). */
  skipped: readonly { path: string; reason: string }[];
  /** False when nested AGENTS.md discovery stopped at a scan limit. */
  nestedScanComplete: boolean;
}
