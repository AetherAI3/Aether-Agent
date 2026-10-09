// src/commands/prompt_modes.ts — the REPL's stateless prompt-rewrite modes
// (/recon, /plan, /research, …). Each mode turns a slash line into a fully
// framed prompt for the brain. Table-driven so chat.ts stays a thin key loop;
// strings are byte-identical to the original inline branches.

export interface PromptModeResult {
  handled: boolean;
  capability?: "planning";
  /** The rewritten prompt to send as a normal turn. */
  prompt?: string;
  /** A one-line notice to print before the turn starts. */
  notice?: string;
  /** Usage error (mode matched but the required argument is missing). */
  error?: string;
}

interface PromptMode {
  /** Match prefix. Arg modes match `${cmd} `; no-arg modes match startsWith(cmd). */
  cmd: string;
  takesArg: boolean;
  usage?: string;
  notice: (arg: string) => string;
  build: (arg: string) => string;
  capability?: "planning";
}

const slugify = (topic: string): string =>
  topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

// Original branch order preserved from chat.ts so matching semantics are unchanged.
const MODES: PromptMode[] = [
  {
    cmd: "/writing-plans",
    takesArg: true,
    usage: "usage: /writing-plans <topic>",
    notice: (topic) => `✎ Writing plan for: "${topic}"`,
    build: (topic) =>
      `Write a detailed, actionable implementation plan for: ${topic}. ` +
      `Save to .hermes/plans/${slugify(topic)}.md. Include: phases with numbered tasks, ` +
      `file manifest (new + modified), testing strategy, out-of-scope items.`,
  },
  {
    cmd: "/subagent-driven-execution",
    takesArg: true,
    usage: "usage: /subagent-driven-execution <task>",
    notice: (task) => `⚡ Subagent execution: "${task}"`,
    build: (task) =>
      `EXECUTION MODE: subagent-driven. ` +
      `Decompose the following task into parallel sub-tasks. Use the delegate_task tool ` +
      `to spawn subagents for each independent workstream. Synthesize all results. Task: ${task}`,
  },
  {
    cmd: "/self-review",
    takesArg: false,
    notice: () => "🔍 Self-review in progress…",
    build: () =>
      "SELF-REVIEW MODE. Review your own recent work in this session. " +
      "Identify: (1) mistakes made and how to avoid them, (2) improvements that could be made, " +
      "(3) what you would do differently if starting over, (4) patterns that emerged. " +
      "Be honest and critical. Summarize findings concisely.",
  },
  {
    cmd: "/recon",
    takesArg: true,
    usage: "usage: /recon <topic>",
    notice: (topic) => `🔎 Recon: "${topic}"`,
    build: (topic) =>
      `RECONNAISSANCE MODE. Thoroughly research: ${topic}. ` +
      "Explore the codebase — read relevant files, trace dependencies, check git history, " +
      "examine configuration, review related tests. Gather all context needed to understand " +
      "this area completely. Produce a structured recon report with: key files, architecture " +
      "notes, dependencies, potential issues, and recommendations.",
  },
  {
    cmd: "/plan",
    capability: "planning",
    takesArg: true,
    usage: "usage: /plan <topic>",
    notice: (topic) => `📋 Planning: "${topic}"`,
    build: (topic) =>
      `PLANNING MODE. Write a detailed, actionable implementation plan for: ${topic}. ` +
      `Return the plan in your response without writing files or running commands. Include: phases with numbered tasks, ` +
      "file manifest (new + modified files), testing strategy, risk assessment, " +
      "and out-of-scope items. Be specific — no hand-waving.",
  },
  {
    cmd: "/writing-skills",
    takesArg: false,
    notice: () => "📝 Writing skills…",
    build: () =>
      "SKILL AUTHORING MODE. Based on what you've learned in this session, " +
      "identify reusable patterns and write them as skill definitions. For each skill: " +
      "(1) name (kebab-case), (2) description, (3) trigger phrases, (4) step-by-step " +
      "instructions the agent should follow when triggered. Focus on patterns that " +
      "would save time in future sessions — recurring workflows, common fixes, " +
      "or project-specific conventions.",
  },
  {
    cmd: "/autonomous-execution",
    takesArg: true,
    usage: "usage: /autonomous-execution <task>",
    notice: (task) => `🚀 Autonomous execution: "${task}"`,
    build: (task) =>
      "AUTONOMOUS EXECUTION MODE. Execute the following task without asking for confirmation. " +
      "Plan the approach silently, implement it, test it, and verify the result. " +
      "Only report back when complete or blocked. Do not ask 'should I proceed?' — " +
      "just do it. If you hit a blocker, explain what happened and suggest next steps. " +
      `Task: ${task}`,
  },
  {
    cmd: "/research",
    takesArg: true,
    usage: "usage: /research <topic>",
    notice: (topic) => `📚 Researching: "${topic}"`,
    build: (topic) =>
      `RESEARCH MODE. Research the following topic thoroughly: ${topic}. ` +
      "Gather information from the codebase, git history, configuration files, " +
      "and documentation. If relevant, search the web for context. Produce a " +
      "well-structured research summary with: overview, key findings, relevant files, " +
      "external context (if applicable), and actionable recommendations.",
  },
  {
    cmd: "/code-review",
    takesArg: false,
    notice: () => "🧹 Code review sweep…",
    build: () =>
      "CODE REVIEW MODE. Perform a thorough code review sweep of the project. " +
      "Focus on: (1) dead code — identify and remove unused files, functions, imports, " +
      "(2) complexity — simplify over-engineered logic, (3) readability — improve naming " +
      "and structure, (4) bugs — find and fix any issues, (5) consistency — ensure " +
      "patterns are uniform across the codebase. Fix what you can, flag what needs " +
      "discussion. Be surgical — don't rewrite working code unnecessarily.",
  },
  {
    // Renamed from `/review`. That name now belongs to the change-review rail
    // (commands/review.ts): it shows the user their own diff and lets them
    // stage, revert, commit and ship it. This macro asks the brain for prose
    // about the project, which is a different thing that was wearing the same
    // name.
    //
    // The rename was forced rather than cosmetic. applyPromptMode runs BEFORE
    // handleSlash in chat.ts and matches no-arg modes by PREFIX, so while this
    // entry said "/review" every `/review …` line was rewritten into a prompt
    // and the slash dispatcher never saw it. Two commands could not share it.
    cmd: "/project-review",
    takesArg: false,
    notice: () => "🔍 Full project review in progress…",
    build: () =>
      "REVIEW MODE. Perform a comprehensive review of the current project state. " +
      "Cover: (1) recent changes — what was modified and why, (2) code quality assessment, " +
      "(3) test coverage gaps, (4) outstanding issues or TODOs, (5) architecture concerns, " +
      "(6) recommendations for improvement. Be thorough but concise.",
  },
];

/** Match a submitted line against the prompt-mode table. */
export function applyPromptMode(line: string): PromptModeResult {
  for (const m of MODES) {
    if (m.takesArg) {
      if (line !== m.cmd && !line.startsWith(m.cmd + " ")) continue;
      const arg = line.slice(m.cmd.length).trim();
      if (!arg) return { handled: true, error: m.usage! };
      return { handled: true, prompt: m.build(arg), notice: m.notice(arg), ...(m.capability ? { capability: m.capability } : {}) };
    }
    if (!line.startsWith(m.cmd)) continue;
    return { handled: true, prompt: m.build(""), notice: m.notice("") };
  }
  return { handled: false };
}
