// A local, editable PR proposal grounded in the final branch diff. No model,
// network request, push, or PR creation occurs while this draft is prepared.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GIT_GLOBAL_ARGS } from "./git_commit_guard.js";
import type { Goal } from "./goals.js";
import { redactForBundle } from "./redaction.js";
import type { RepoState } from "./review_state.js";
import type { VerificationReading } from "./verification_record.js";
import { confineToWorkspace } from "./workspace_scope.js";
import type { Runner } from "./worktree.js";

export interface PrDraftBinding {
  version: 1;
  repository: string;
  branch: string;
  baseBranch: string;
  baseRevision: string;
  headRevision: string;
  templateDigest: string;
  verificationDigest: string;
  scopeDigest: string;
}

export interface PreparedPrDraft {
  binding: PrDraftBinding;
  title: string;
  body: string;
}

interface DiffFile { path: string; status: string; added: number | null; removed: number | null }

const DEFAULT_TEMPLATE = `## Why

## What changed

## Verification

- [ ] Relevant tests and checks pass, or the reason they were not run is below.
- [ ] Public commands, examples, and generated docs were checked when applicable.

Evidence or commands:

## Scope and risk
`;
const COMPACT_TEMPLATE = DEFAULT_TEMPLATE.slice(0, DEFAULT_TEMPLATE.indexOf("## Scope and risk"));
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const clean = (value: string, max = 240): string => redactForBundle(value.replace(/[\r\n\0]+/g, " ").trim()).slice(0, max);
const quotedPath = (path: string): string => `\`${clean(path, 180).replace(/`/g, "'")}\``;
const git = (run: Runner, root: string, args: string[]) => run("git", [...GIT_GLOBAL_ARGS, "-C", root, ...args], root);

/** Only a regular, bounded template in the selected checkout is considered. */
export function readPrTemplate(root: string): string | null {
  try {
    const path = confineToWorkspace(root, join(".github", "pull_request_template.md"), true);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    return readFileSync(path, "utf8");
  } catch { return null; }
}

function finalDiff(run: Runner, state: RepoState): DiffFile[] {
  const range = `${state.base.revision}...${state.head.revision}`;
  const statuses = git(run, state.root, ["diff", "--no-renames", "--name-status", "-z", range]);
  const numbers = git(run, state.root, ["diff", "--no-renames", "--numstat", "-z", range]);
  if (statuses.status !== 0 || numbers.status !== 0) throw new Error("could not inspect the complete base-to-head diff");
  const counts = new Map<string, { added: number | null; removed: number | null }>();
  for (const line of numbers.stdout.split("\0")) {
    if (!line) continue;
    const [add, remove, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if (!path) continue;
    counts.set(path, { added: add === "-" ? null : Number(add), removed: remove === "-" ? null : Number(remove) });
  }
  const fields = statuses.stdout.split("\0");
  const files: DiffFile[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    if (!status || !path) continue;
    files.push({ path, status, ...(counts.get(path) ?? { added: null, removed: null }) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function commitSubjects(run: Runner, state: RepoState, files: DiffFile[]): string[] {
  // History only supplies human wording. Limit it to commits touching paths
  // that survive in the final diff, so an abandoned side path does not lead.
  const paths = files.length <= 100 ? ["--", ...files.map(file => file.path)] : [];
  const result = git(run, state.root, ["log", "--reverse", "--format=%s%x00", "-n", "60", `${state.base.revision}..${state.head.revision}`, ...paths]);
  if (result.status !== 0) return [];
  return result.stdout.split("\0").map(s => clean(s)).filter(Boolean);
}

function subjectText(subject: string): string {
  return subject.replace(/^(?:feat|fix|docs|test|chore|refactor|build|ci|perf)(?:\([^)]*\))?!?:\s*/i, "").trim();
}

function primarySubject(subjects: string[], files: DiffFile[]): string {
  const useful = subjects.find(s => /^(?:feat|fix|perf)(?:\([^)]*\))?!?:/i.test(s) && !/\brevert\b/i.test(s))
    ?? subjects.find(s => !/^(?:chore|test|docs|ci|build|revert|fixup|squash)(?:\(|:|!)/i.test(s))
    ?? subjects[0];
  return useful || `Update ${files.length === 1 ? files[0]!.path : `${files.length} files`}`;
}

function describeFiles(files: DiffFile[]): string {
  if (files.length === 1) {
    const file = files[0]!;
    const verb = file.status.startsWith("A") ? "Added" : file.status.startsWith("D") ? "Removed" : "Updated";
    return `- ${verb} ${quotedPath(file.path)} in the final branch diff.`;
  }
  const groups = [
    { name: "Added", files: files.filter(f => f.status.startsWith("A")) },
    { name: "Updated", files: files.filter(f => !f.status.startsWith("A") && !f.status.startsWith("D")) },
    { name: "Removed", files: files.filter(f => f.status.startsWith("D")) },
  ];
  return groups.filter(g => g.files.length).map(g => {
    const names = g.files.slice(0, 5).map(f => quotedPath(f.path)).join(", ");
    const extra = g.files.length > 5 ? `, and ${g.files.length - 5} more` : "";
    return `- ${g.name} ${names}${extra}.`;
  }).join("\n");
}

function verificationText(reading: VerificationReading, scope?: Goal): string {
  const record = reading.record;
  if (reading.status === "verified" && record) return `- Host check: ${clean(record.command)} — passed (exit 0).`;
  if (reading.status === "failed" && record) return `- Host check: ${clean(record.command)} — failed (exit ${record.exitCode}).`;
  if (reading.status === "stale") return `- Host check: stale — ${clean(reading.reason)}. Re-run it for the current tree.`;
  const prior = scope?.phases.find(phase => phase.id === scope.activePhaseId)?.run
    ?? scope?.phases.map(phase => phase.run).filter(Boolean).at(-1);
  if (prior?.check?.state === "skipped" || (prior?.check?.state === "not_run" && /skip/i.test(prior.check.reason))) {
    return `- Host check: skipped in the last goal attempt — ${clean(prior.check.reason)}. No current-tree result is recorded.`;
  }
  if (prior?.check?.state === "failed") {
    return `- Host check: failed in the last goal attempt — ${clean(prior.check.reason)}. No current-tree result is recorded.`;
  }
  return `- Host check: not verified — ${clean(reading.reason)}.`;
}

/** Keep every heading and checkbox; replace only recognized placeholder prose. */
export function fillPrTemplate(template: string | null, sections: { why: string; changed: string; verification: string; risk: string }, compact = false): string {
  const source = (template?.trim() || (compact ? COMPACT_TEMPLATE : DEFAULT_TEMPLATE).trim()).replace(/\r\n/g, "\n").replace(/^([ \t]*- )\[[xX]\]/gm, "$1[ ]");
  const chunks = source.split(/(?=^##\s+.+$)/m);
  const seen = new Set<keyof typeof sections>();
  const filled = chunks.map(chunk => {
    const heading = /^##\s+(.+)\n?/.exec(chunk);
    if (!heading) return chunk.trim();
    const label = heading[1]!.trim().toLowerCase();
    const key = /^(?:why|problem|motivation)$/.test(label) ? "why"
      : /^(?:what changed|summary|changes)$/.test(label) ? "changed"
      : /^(?:verification|tests?|test plan)$/.test(label) ? "verification"
      : /^(?:scope and risk|risk|risks)$/.test(label) ? "risk" : null;
    if (!key) return chunk.trim();
    seen.add(key);
    const checklist = [...chunk.matchAll(/^[ \t]*- \[[ xX]\].+$/gm)].map(m => m[0]!.replace(/\[[xX]\]/, "[ ]"));
    const evidenceLabel = key === "verification" && /Evidence or commands:/i.test(chunk) ? "Evidence or commands:\n\n" : "";
    return `${heading[0]!.trim()}\n\n${checklist.length ? checklist.join("\n") + "\n\n" : ""}${evidenceLabel}${sections[key]}`.trim();
  });
  for (const [key, heading] of [["why", "Why"], ["changed", "What changed"], ["verification", "Verification"], ["risk", "Scope and risk"]] as const) {
    if (compact && !template && key === "risk") continue;
    if (!seen.has(key)) filled.push(`## ${heading}\n\n${sections[key]}`);
  }
  return filled.filter(Boolean).join("\n\n") + "\n";
}

export function preparePrDraft(run: Runner, state: RepoState, reading: VerificationReading, scope?: Goal): PreparedPrDraft {
  if (!state.base.revision || !state.base.branch || !state.head.revision || !state.head.branch || !state.remote?.spec) {
    throw new Error("a resolved base, head, and GitHub destination are required to draft a pull request");
  }
  const files = finalDiff(run, state);
  if (!files.length) throw new Error("the final base-to-head diff is empty; there is no change to describe");
  const subjects = commitSubjects(run, state, files);
  const primary = primarySubject(subjects, files);
  const relevant = scope?.plan?.relevantFiles ?? [];
  const matchingFiles = relevant.some(path => files.some(file => file.path === path));
  const matchingRun = scope?.phases.some(phase => phase.run?.resulting?.head === state.head.revision);
  const accepted = scope?.plan?.state === "accepted" && (matchingFiles || matchingRun || (scope.status === "running" && !relevant.length))
    ? scope : undefined;
  const objective = clean(accepted?.title || subjectText(primary), 200);
  const title = clean(accepted?.title || primary, 200);
  const template = readPrTemplate(state.root);
  const additions = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  const size = files.length > 3 ? `\n- Final diff: ${files.length} files; ${additions} added and ${deletions} removed lines.` : "";
  const constraints = accepted?.plan?.constraints.slice(0, 5).map(value => `- Accepted constraint: ${clean(value)}.`).join("\n");
  const authorityFiles = files.filter(file => /(?:auth|permission|credential|token|security|publish|ship|tool_executor)/i.test(file.path)).slice(0, 3);
  const authorityRisk = authorityFiles.length
    ? `- Security or local-authority impact: review changes to ${authorityFiles.map(file => quotedPath(file.path)).join(", ")}.`
    : "- Security or local-authority impact: review the final diff.";
  const sections = {
    why: `Problem or objective: ${objective}.`,
    changed: describeFiles(files) + size,
    verification: `${verificationText(reading, accepted)}\n- CI: not observed by this local draft; check the PR after it opens.`,
    risk: [constraints, authorityRisk, "- Compatibility or release impact: not assessed by this local draft.", "- Follow-up work: none recorded in this draft."].filter(Boolean).join("\n"),
  };
  const body = redactForBundle(fillPrTemplate(template, sections, files.length === 1 && !template && !constraints));
  const binding: PrDraftBinding = {
    version: 1,
    repository: state.remote.spec.full,
    branch: state.head.branch,
    baseBranch: state.base.branch,
    baseRevision: state.base.revision,
    headRevision: state.head.revision,
    templateDigest: sha(template ?? "(no template)"),
    verificationDigest: sha(JSON.stringify(reading)),
    scopeDigest: sha(JSON.stringify(accepted ? { id: accepted.id, title: accepted.title, plan: accepted.plan } : null)),
  };
  return { binding, title, body };
}

export function readPreparedPrDraft(path: string): PreparedPrDraft {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("draft file must be a regular JSON file of at most 256 KiB");
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("draft file is not valid JSON"); }
  if (!value || typeof value !== "object") throw new Error("draft file is not an object");
  const draft = value as PreparedPrDraft;
  if (!draft.binding || draft.binding.version !== 1 || typeof draft.title !== "string" || typeof draft.body !== "string") {
    throw new Error("draft file needs a version 1 binding, title, and body");
  }
  return draft;
}

/** Exact binding, including the template, accepted scope, and check evidence. */
export function assertCurrentPrDraft(saved: PreparedPrDraft, current: PreparedPrDraft): void {
  for (const key of Object.keys(current.binding) as Array<keyof PrDraftBinding>) {
    if (saved.binding[key] !== current.binding[key]) throw new Error(`prepared PR draft is stale (${key} changed); create and review a new draft`);
  }
}
