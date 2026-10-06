// redaction.ts — the host-side payload ALLOWLIST.
//
// Everything uploaded to the remote-session broker passes through
// `sanitizeRemotePayload()` first. The rule is allowlist, not blocklist: a key
// not explicitly allowed for its event type does not leave the machine,
// whatever it contains. A blocklist is always one provider behind.
//
// The host NEVER uploads: environment variables, auth tokens, arbitrary file
// contents, unredacted shell history, absolute local paths (project-relative
// identifiers only), MCP credentials, browser cookies, hidden prompts, or
// private memory. That list is encoded as RC_FORBIDDEN_KEYS plus the per-type
// allowlists, and enforced again broker-side.
//
// Ported from PR #108 with three changes:
//
//  1. The event vocabulary comes from viewer_profile.ts rather than being
//     restated, so the allowlist and the viewer projection cannot drift.
//  2. `transcript` is gone, along with its allowlist entry — see
//     viewer_profile.ts for why.
//  3. Detector reuse is unchanged and deliberate: redactEnvValues,
//     redactInline and SENSITIVE_KEY come from core/redaction.ts, the single
//     owner of secret-shaped scrubbing, so a new detector there protects this
//     sink too.

import { homedir } from "node:os";

import { redactEnvValues, redactInline, SENSITIVE_KEY } from "../redaction.js";
import {
  VIEWER_EVENT_TYPES,
  isViewerEventType,
  type ViewerEventType,
} from "./viewer_profile.js";

/** Categories the host must never upload — data, so the spec, the tests and
 *  the code all quote one list. */
export const RC_NEVER_UPLOADED = [
  "environment variables",
  "auth tokens",
  "arbitrary file contents",
  "unredacted shell history",
  "absolute local paths",
  "MCP credentials",
  "browser cookies",
  "hidden prompts / private memory",
] as const;

/** Key names dropped regardless of event type, before the allowlist runs.
 *  SENSITIVE_KEY (token/secret/password/…) is applied on top of these. */
const RC_FORBIDDEN_KEYS =
  /^(env|environ|environment|env_vars?|cookies?|shell_history|history|prompt|prompts|hidden_prompt|system_prompt|memory|private_memory|mcp|mcp_credentials?|file_contents?|contents?|body|raw|stdin|stdout|stderr)$/i;

/** Per-type allowed payload keys — identifiers and summaries, never raw content. */
const RC_ALLOWED_KEYS: Readonly<Record<ViewerEventType, readonly string[]>> = {
  session: [
    "state", "session_name", "repo", "branch", "base_commit",
    "dirty_file_count", "execution", "protocol_version",
  ],
  presence: ["protocol_version", "role", "device_id", "liveness"],
  plan: ["projection_version", "step", "total_steps", "title", "status"],
  subagent: ["projection_version", "subagent_id", "name", "status", "summary"],
  tool_activity: ["projection_version", "tool", "target", "status", "summary"],
  diff_summary: ["projection_version", "files_changed", "insertions", "deletions", "files"],
  tests: ["projection_version", "framework", "status", "passed", "failed", "skipped", "summary"],
  ci: ["projection_version", "provider", "status", "run_id", "url"],
  pr_status: ["projection_version", "repo", "number", "state", "title", "url", "checks_summary"],
  artifact: ["projection_version", "artifact_id", "kind", "title", "summary"],
  preview: ["projection_version", "phase", "url", "instance_id"],
  done: ["projection_version", "status", "summary"],
  error: ["projection_version", "code", "message"],
};

/** Broker frame bound: payload canonical JSON <= 32 KiB. */
export const RC_MAX_PAYLOAD_BYTES = 32 * 1024;
/** Per-string bound — summaries, never documents. */
const MAX_STRING_LENGTH = 1024;
const MAX_LIST_ITEMS = 64;

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/])/;
/**
 * Git's project-relative path form, with traversal and machine paths refused.
 *
 * At least as strict as Cloud's display/1 `files` rule, which refuses ANY
 * leading "~" as a home path — so a legitimate `~$Report.docx` (an Office lock
 * file) at the checkout root is refused here too. Anything this accepts that
 * Cloud refuses is a 400 that wedges the outbox.
 */
export function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && value.length <= 512 &&
    !ABSOLUTE_PATH.test(value) && !value.startsWith("~") && !value.includes(":") &&
    !/[\\\u0000-\u001f\u007f]/.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * The size of `value` as the broker measures it: canonical JSON with
 * ensure_ascii, where every UTF-16 unit at or above 0x80 is a six-byte `\uXXXX`
 * escape. UTF-8 under-counts non-ASCII text by up to 3x, and a payload the
 * broker finds over its bound is a 400 that keeps the batch.
 */
export function brokerJsonBytes(value: unknown): number {
  const json = JSON.stringify(value) ?? "";
  let bytes = 0;
  for (let index = 0; index < json.length; index += 1) bytes += json.charCodeAt(index) < 0x80 ? 1 : 6;
  return bytes;
}
// C0 controls and DEL, built without literal control characters in the source.
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g",
);

/**
 * Rewrite a path-shaped string to a project-relative identifier, or refuse it.
 *
 * An absolute path is both a privacy leak — it usually carries a username — and
 * an information leak about machine layout, and a viewer has use for neither:
 * it needs to know WHICH file, not where that file lives on someone's disk.
 */
export function relativizePath(value: string, projectRoot: string): string {
  const normalizedRoot = projectRoot.replace(/[\\/]+$/, "");
  for (const root of [normalizedRoot, normalizedRoot.replaceAll("\\", "/")]) {
    if (root && (value === root || value.startsWith(root + "/") || value.startsWith(root + "\\"))) {
      const rest = value.slice(root.length).replace(/^[\\/]+/, "").replaceAll("\\", "/");
      return rest === "" ? "." : rest;
    }
  }
  if (ABSOLUTE_PATH.test(value) || (homedir() && value.startsWith(homedir()))) {
    return "[external-path]";
  }
  return value;
}

function sanitizeString(value: string, projectRoot: string, env: NodeJS.ProcessEnv): string {
  let out = value.replace(CONTROL_CHARS, "");
  out = relativizePath(out, projectRoot);
  // Embedded (not whole-string) absolute roots still get scrubbed.
  const roots = [
    projectRoot,
    projectRoot.replaceAll("\\", "/"),
    homedir(),
    homedir().replaceAll("\\", "/"),
  ];
  for (const root of roots) if (root) out = out.split(root).join("[path]");
  out = redactEnvValues(out, env);
  out = redactInline(out); // bearer/key=value scrub plus a 512-char hard cap
  return out.slice(0, MAX_STRING_LENGTH);
}

function sanitizePathIdentifier(value: string, projectRoot: string, env: NodeJS.ProcessEnv): string {
  if (!value) return "[unnamed-file]";
  if (value.replaceAll("\\", "/").split("/").includes("..")) return "[external-path]";
  // Cloud's display/1 identifier rule reads ANY leading "~" as a home path
  // ("absolute local paths are forbidden"): `~`, `~user/x`, even an Office
  // lock file `~$Report.docx`. Sent as-is it is a 400 that keeps the batch at
  // the head of the outbox, so it is refused here, before durable enqueue.
  if (value.startsWith("~")) return "[external-path]";
  return sanitizeString(value, projectRoot, env);
}

export interface SanitizeOptions {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Reduce an arbitrary payload to the bounded, allowlisted shape for its type.
 *
 * Returns null when the event must not be sent at all: an unknown or excluded
 * event type, nothing safe left after filtering, or an over-size result. Null
 * is a refusal, never "send something smaller" — inventing a fallback payload
 * shape outside the shared Cloud fixture is how a viewer starts rendering
 * fields nobody agreed on.
 */
export function sanitizeRemotePayload(
  eventType: string,
  payload: Record<string, unknown>,
  options: SanitizeOptions,
): Record<string, unknown> | null {
  if (!isViewerEventType(eventType)) return null;
  if (eventType === "diff_summary") {
    const files = payload["files"];
    if (files !== undefined && (!Array.isArray(files) || files.some((path: unknown) =>
      typeof path !== "string" || !isSafeRelativePath(path)))) return null;
    // Cloud's display/1 contract REQUIRES all three counts. A payload missing
    // one is a 400, and a rejected batch stays at the head of the outbox and
    // blocks every later event, so it is refused here before durable enqueue.
    for (const key of ["files_changed", "insertions", "deletions"]) {
      const count = payload[key];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
    }
  }
  const allowed = RC_ALLOWED_KEYS[eventType];
  const env = options.env ?? process.env;
  const out: Record<string, unknown> = {};

  for (const key of allowed) {
    // Defence in depth: an allowlist entry that is itself credential-shaped
    // should never have been written, and is dropped rather than trusted.
    if (RC_FORBIDDEN_KEYS.test(key) || SENSITIVE_KEY.test(key)) continue;
    const value = payload[key];
    if (value === undefined || value === null) continue;

    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") out[key] = key === "target"
      ? (value.includes("://") ? "[external-target]" : sanitizePathIdentifier(value, options.projectRoot, env))
      : sanitizeString(value, options.projectRoot, env);
    else if (Array.isArray(value)) {
      const items = value
        .filter((item): item is string => typeof item === "string")
        .slice(0, MAX_LIST_ITEMS)
        .map((item) => key === "files"
          ? sanitizePathIdentifier(item, options.projectRoot, env)
          : sanitizeString(item, options.projectRoot, env));
      if (items.length) out[key] = items;
    }
    // Nested objects are refused: the wire shapes are flat by construction, and
    // a nested bag is how untyped content reaches a viewer unreviewed.
  }

  if (Object.keys(out).length === 0) return null;
  if (brokerJsonBytes(out) > RC_MAX_PAYLOAD_BYTES) return null;
  return out;
}

/** The event types this sanitizer bounds. In sync with the viewer profile by
 *  construction — these keys ARE the profile's list. */
export function sanitizableEventTypes(): readonly string[] {
  return VIEWER_EVENT_TYPES;
}

/** Exact display/1 allowlist manifest pinned against the Cloud broker fixture. */
export function rcDisplayPayloadKeys(): Record<string, string[]> {
  return Object.fromEntries(
    VIEWER_EVENT_TYPES.filter((type) => type !== "session" && type !== "presence")
      .map((type) => [type, [...RC_ALLOWED_KEYS[type]].sort()]),
  );
}
