// Central bounds for skill metadata, loading, and instruction context.
// Exposed through the capability manifest — change deliberately.

export const SKILL_BOUNDS = {
  /** skill.json on disk. */
  maxMetadataBytes: 64 * 1024,
  /** SKILL.md instruction body. */
  maxInstructionBytes: 128 * 1024,
  /** One declared resource file. */
  maxResourceBytes: 256 * 1024,
  /** All loaded resources of one skill combined. */
  maxAggregateResourceBytes: 512 * 1024,
  /** Skills loaded into one turn (explicit + automatic). */
  maxSkillsPerTurn: 6,
  /** Automatic candidates loaded without explicit invocation. */
  maxAutomaticSkillsPerTurn: 3,
  /** Skill dependency chain depth. */
  maxDependencyDepth: 3,
  /** Approximate token budget for all loaded skill context. */
  maxLoadedSkillTokens: 16000,
  /** Instruction sources merged into one turn. */
  maxInstructionSources: 12,
  /**
   * Approximate token budget for all instruction (AGENTS.md &co) context put in
   * front of the model in one turn. Twelve 64 KB sources would otherwise be
   * ~192k tokens — bounding skill bodies is pointless if the rules beside them
   * are unbounded. Overflow DROPS the lowest-precedence sources whole and says
   * so out loud; it never clips a source mid-sentence and calls it complete.
   */
  maxInstructionContextTokens: 24000,
  /** Serialized size ceiling for the whole agent context packet on the wire. */
  maxContextPacketBytes: 512 * 1024,
  /** Nested AGENTS.md depth below the project root. */
  maxNestedInstructionDepth: 6,
  /** Bound the synchronous nested-rule walk before any chat pulse or request. */
  maxNestedInstructionDirectories: 256,
  maxNestedInstructionEntries: 2048,
  maxNestedInstructionScanMs: 500,
  /** One instruction file. */
  maxInstructionFileBytes: 64 * 1024,
  /** Description / name / trigger phrase field lengths. */
  maxNameChars: 80,
  maxDescriptionChars: 1024,
  maxTriggerPhrases: 16,
  maxTriggerPhraseChars: 120,
  maxCommandAliases: 4,
  maxResources: 32,
  maxDependencies: 8,
} as const;

export type SkillBounds = typeof SKILL_BOUNDS;
