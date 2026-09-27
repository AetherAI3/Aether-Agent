// Canonical redaction: the single home for secret-shaped pattern detection.
// session_log.ts (durable event records) and support_bundle.ts (exported
// bundles) both import from here so a new detector protects every sink at once.
//
// Invariant: findings returned by scanForSecrets() describe the CLASS of the
// match, never the matched text — a scanner that echoes the secret is a leak.

import { homedir } from "node:os";

// `[_-]key` (rather than only the enumerated `api_key` / `private_key`) so a
// secret named for what it unlocks is still classified as one. SC-DEVICE-01's
// own `device_command_key` matched none of the enumerated spellings, which is
// exactly the failure mode a name-by-name allowlist has: the newest secret is
// always the one it does not know about. Over-matching a `cache_key` costs
// nothing — the detectors that consult this only fire on 32+ char hex values
// and on environment variables, both already opaque.
export const SENSITIVE_KEY = /token|secret|password|authorization|[_-]key|api[_-]?key|private[_-]?key|credential|pat/i;

/** Inline redaction for short event fields — behavior owned by session_log's
 * contract: bearer/key-value scrubbing plus a hard 512-char cap. */
export function redactInline(value: string): string {
  return value
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/((?:token|secret|password|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 512);
}

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/g;
const BEARER_PATTERN = /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const USERINFO_URL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+@)/gi;

function redactJwt(text: string): string {
  return text.replace(JWT_PATTERN, "[REDACTED-JWT]");
}

function redactUserinfoUrls(text: string): string {
  return text.replace(USERINFO_URL_PATTERN, "$1[REDACTED]@");
}

/** `"secret_key": "<hex>"` / `secret_key=<hex>` — hex values of 32+ chars in
 * key/value positions whose key matches the sensitive pattern. */
function redactSecretHexPairs(text: string): string {
  return text
    .replace(/("([^"\\]{1,64})"\s*:\s*")([0-9a-fA-F]{32,})(")/g, (whole, open: string, key: string, _hex, close: string) =>
      SENSITIVE_KEY.test(key) ? open + "[REDACTED]" + close : whole,
    )
    .replace(/\b([\w-]{1,64})([:=]\s*)([0-9a-fA-F]{32,})\b/g, (whole, key: string, sep: string) =>
      SENSITIVE_KEY.test(key) ? key + sep + "[REDACTED]" : whole,
    );
}

/** Replace values of sensitive-named environment variables wherever they occur. */
export function redactEnvValues(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (!SENSITIVE_KEY.test(key)) continue;
    out = out.split(value).join("[REDACTED]");
  }
  return out;
}

/** Replace the user's home directory (raw, JSON-escaped, and slash-normalized
 * spellings) with "~" so exported text carries no private absolute paths. */
export function redactHomeDir(text: string, home: string = homedir()): string {
  if (!home) return text;
  const spellings = [home.replaceAll("\\", "\\\\"), home, home.replaceAll("\\", "/")];
  let out = text;
  for (const spelling of spellings) {
    if (spelling) out = out.split(spelling).join("~");
  }
  return out;
}

/** Full pass for exported artifacts: every detector plus path/env scrubbing. */
export function redactForBundle(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  out = out.replace(BEARER_PATTERN, "$1[REDACTED]");
  out = out.replace(/((?:token|secret|password|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;"]+/gi, "$1[REDACTED]");
  out = redactSecretHexPairs(out);
  out = redactJwt(out);
  out = redactUserinfoUrls(out);
  out = redactEnvValues(out, env);
  out = redactHomeDir(out);
  return out;
}

/** Detector classes only — used to verify a bundle AFTER redaction ran. */
export function scanForSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const findings: string[] = [];
  if (new RegExp(JWT_PATTERN.source).test(text)) findings.push("jwt-shaped string");
  if (new RegExp(BEARER_PATTERN.source, "i").test(text)) findings.push("bearer token");
  for (const match of text.matchAll(new RegExp(USERINFO_URL_PATTERN.source, "gi"))) {
    if (match[2] !== "[REDACTED]@") {
      findings.push("url with userinfo");
      break;
    }
  }
  const hexPair = /("([^"\\]{1,64})"\s*:\s*")([0-9a-fA-F]{32,})(")|\b([\w-]{1,64})([:=]\s*)([0-9a-fA-F]{32,})\b/g;
  for (const match of text.matchAll(hexPair)) {
    const key = match[2] ?? match[5] ?? "";
    if (SENSITIVE_KEY.test(key)) {
      findings.push("hex secret in sensitive key position");
      break;
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (!SENSITIVE_KEY.test(key)) continue;
    if (text.includes(value)) {
      findings.push("sensitive environment value");
      break;
    }
  }
  return findings;
}
