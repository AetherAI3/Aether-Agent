// Auth — token storage + login.
//
// The the Aether API authenticates username/password at POST /auth/login and returns
// a `session_token`, which the CLI sends as `Authorization:
// Bearer <session_token>` on every authed call.
// Browser-based login is the default flow.
//
// TODO: prefer the OS keychain over the file store; the TokenStore
// interface keeps that swappable.

import { dirname, join } from "node:path";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { configDir } from "./config.js";
import { LOGIN_PATH, defaultRequestTimeoutMs, isCredentialSafeUrl, sanitizeServerText } from "./transport.js";

export interface TokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
  /** Replace the ACTIVE token without widening persistence scope (used by the
   * automatic 401→refresh path). Stores that don't distinguish may omit it;
   * callers fall back to set(). */
  update?(token: string): Promise<void>;
  /** Safe provenance for diagnostics. Never includes a token or token fragment. */
  sourceInfo?(): Promise<TokenSourceInfo>;
}

export interface TokenSourceInfo {
  source: "stored" | "environment" | "injected" | "current-process";
  /** An environment credential currently takes precedence over a different saved login. */
  storedCredentialShadowed: boolean;
}

export function unsetEnvTokenCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "Remove-Item Env:AETHER_TOKEN" : "unset AETHER_TOKEN";
}

/**
 * O_NOFOLLOW is kept as defense-in-depth where the platform has it, but it is
 * NOT a portable guard: libuv does not define O_NOFOLLOW on Windows, so
 * `fsConstants.O_NOFOLLOW` is `undefined` there (verified on win32/Node 24) and
 * the flag degrades to 0 — every open silently followed whatever symlink,
 * junction or reparse point was planted at the token path. The explicit lstat
 * checks below are the guard that actually holds on both platforms.
 */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * True when `path` is a symlink or a Windows reparse point (junction / mount
 * point) rather than a plain entry. lstat never follows, so this reports on the
 * entry itself. On win32 a junction created with `symlink(..., "junction")`
 * reports `isSymbolicLink() === true` (verified empirically), which is what
 * makes one check cover both platforms.
 *
 * A missing entry is NOT link-like — nothing is planted, so callers proceed.
 */
function isLinkLike(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Refuse to persist a credential into a directory we cannot vouch for: it must
 * be a real directory (not a symlink/junction redirecting the write elsewhere),
 * owned by us, and not writable by other local accounts who could otherwise
 * swap `.token` for a symlink between our check and our write.
 *
 * The uid/mode half is POSIX-only: Windows has no `process.getuid` and models
 * this with ACLs, which Node does not expose — that half is deliberately
 * skipped there and called out as a residual risk rather than faked.
 */
function assertSafeConfigDir(dir: string): void {
  if (isLinkLike(dir)) {
    throw new Error(`refusing to write the token: config dir ${dir} is a symlink or reparse point, not a real directory`);
  }
  const st = statSync(dir);
  if (!st.isDirectory()) throw new Error(`refusing to write the token: ${dir} is not a directory`);
  const getuid = (process as { getuid?: () => number }).getuid;
  if (typeof getuid !== "function") return; // win32: see doc comment above.
  const uid = getuid.call(process);
  if (st.uid !== uid) {
    throw new Error(`refusing to write the token: config dir ${dir} is owned by uid ${st.uid}, not ${uid}`);
  }
  // Group/world-WRITABLE only. Readable (0755) is left alone on purpose: dirs
  // created by older versions are common and a read bit does not let another
  // account swap the token file.
  if (st.mode & 0o022) {
    throw new Error(
      `refusing to write the token: config dir ${dir} is group/world-writable (mode 0${(st.mode & 0o777).toString(8)})`,
    );
  }
}

/**
 * Windows only: MoveFileEx cannot replace a destination that another process
 * currently has open, and fails EPERM (a sharing violation surfaced as EPERM by
 * libuv). This is not theoretical — a reader doing exactly what `get()` does in
 * a second process reproduces it in well under 200 attempts on win32/Node 24,
 * verified by this repo's concurrency test.
 *
 * POSIX rename() has no such restriction, so the retry is a win32 accommodation
 * only. It is bounded (~350ms worst case) and gives up loudly rather than
 * looping: a login that cannot store its token must not report success.
 */
const RENAME_RETRY_DELAYS_MS = [2, 5, 10, 20, 40, 60, 80, 120] as const;

async function renameWithWindowsRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (!retryable || delay === undefined) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** File-backed token store (0600). Fallback until keychain is wired. */
export class FileTokenStore implements TokenStore {
  private path = join(configDir(), ".token");

  async sourceInfo(): Promise<TokenSourceInfo> {
    return { source: "stored", storedCredentialShadowed: false };
  }

  async get(): Promise<string | null> {
    if (!existsSync(this.path)) return null;
    // A symlink/junction planted at the token path by another local account is
    // treated exactly like "no token" — never read through it. This lstat is
    // the portable half of the guard; O_NOFOLLOW below is defense-in-depth on
    // the platforms that define it.
    //
    // Residual TOCTOU: on POSIX the open's O_NOFOLLOW closes the window between
    // this lstat and the open. On Windows there is no such flag, so an attacker
    // who can win that microsecond-wide race AND create symlinks (which needs
    // SeCreateSymbolicLinkPrivilege or Developer Mode) could still swap the
    // entry after the check. Documented, not fixable without a native handle
    // API Node does not expose.
    if (isLinkLike(this.path)) return null;
    let fd: number;
    try {
      fd = openSync(this.path, fsConstants.O_RDONLY | O_NOFOLLOW);
    } catch {
      return null;
    }
    try {
      const buf = Buffer.alloc(8192);
      const bytes = readSync(fd, buf, 0, buf.length, 0);
      const t = buf.subarray(0, bytes).toString("utf8").trim();
      return t || null;
    } catch {
      // e.g. EISDIR when the path is a directory — same as "no token".
      return null;
    } finally {
      closeSync(fd);
    }
  }

  async set(token: string): Promise<void> {
    // mkdirSync is required here: on a fresh machine nothing else creates the
    // config dir before first login, so omitting this throws ENOENT (verified
    // bug on HEAD's side). Creating dir 0700 / file 0600 AT CREATION (rather
    // than write-then-chmod) closes the race window where the token would
    // otherwise be briefly world-readable.
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertSafeConfigDir(dir);
    // Never write THROUGH a planted link. Failing loudly (rather than the old
    // silent O_NOFOLLOW-that-is-0 pass-through on Windows) is the point: a
    // login that cannot store its token safely must not report success.
    if (isLinkLike(this.path)) {
      throw new Error(
        `refusing to write the token: ${this.path} is a symlink or reparse point, not a regular file`,
      );
    }

    // Write-to-temp + rename instead of the old O_TRUNC-in-place write. In
    // place, a crash (or a full disk) between truncate and write left an EMPTY
    // or partial .token, and a concurrent reader in another process saw a
    // truncated credential and reported "not logged in". rename() is atomic on
    // POSIX and, on Windows, replaces an existing destination via MoveFileEx
    // REPLACE_EXISTING semantics (verified empirically on win32/Node 24, and
    // covered by a test). rename() also never follows a symlink at the
    // destination, so it replaces a planted link rather than writing into its
    // target — a second layer under the lstat guard above.
    //
    // The temp file is a sibling (same directory, therefore same volume, so the
    // rename cannot degrade to a copy), is created O_EXCL so it can never
    // adopt an attacker's pre-planted file, and is 0600 from creation.
    const tmp = join(dir, `.token.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
      try {
        writeFileSync(fd, token, "utf8");
        // Durability before the rename: without it a crash can land the rename
        // while the data blocks are still unwritten, i.e. the empty-file
        // failure mode we just removed, reintroduced by the page cache.
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        chmodSync(tmp, 0o600);
      } catch {
        // non-fatal on filesystems that don't support POSIX modes.
      }
      await renameWithWindowsRetry(tmp, this.path);
    } catch (err) {
      // Never leave a partial credential lying beside the real one.
      try {
        unlinkSync(tmp);
      } catch {
        // already gone (e.g. the open itself failed) — nothing to clean.
      }
      throw err;
    }
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // non-fatal on filesystems that don't support POSIX modes.
    }
  }

  async clear(): Promise<void> {
    let st;
    try {
      st = lstatSync(this.path);
    } catch {
      return; // already absent — logging out twice is not an error.
    }
    // unlink on a link removes the LINK, never the file it points at, so
    // `aether auth logout` can never delete another account's file even if one
    // was planted here. On win32 a directory junction also unlinks cleanly and
    // leaves its target's contents intact (verified empirically); rmdirSync is
    // the fallback for the platforms/kernels where unlink refuses a directory
    // reparse point. Neither path ever recurses INTO the junction.
    try {
      unlinkSync(this.path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (st.isSymbolicLink() || st.isDirectory()) {
        if (code === "EPERM" || code === "EISDIR" || code === "EACCES") {
          rmdirSync(this.path);
          return;
        }
      }
      if (code === "ENOENT") return; // raced with another logout.
      throw err;
    }
  }
}

export function defaultTokenStore(): TokenStore {
  return new FileTokenStore();
}

/**
 * A long-lived API token (PAT) starts with `aek_`; a session token (minted by
 * /auth/login or /auth/refresh) doesn't. The one canonical definition of that
 * prefix, shared by transport.ts's refreshSession() (an `aek_` token never
 * expires, so a 401 on one is never retried) and commands/auth.ts's
 * isApiToken (status/token display) — previously hand-duplicated in both
 * places, risking silent drift if the prefix scheme ever changes (LOOP-01
 * round 2; mirrors this file's own tokenStoreForInjected, added for the same
 * "one canonical decision" reason).
 */
export function isApiKeyToken(token: string | null | undefined): boolean {
  return typeof token === "string" && token.startsWith("aek_");
}

/**
 * The one canonical "injected token -> TokenStore" decision, shared by every
 * surface that resolves an embedded/injected session token (tokenStoreFromEnv
 * for the CLI entry, AetherClient's constructor for library embedders) so the
 * choice can't silently drift into hand-maintained copies (LOOP-01 round 1).
 *
 * An empty/whitespace token counts as unset and falls back to the file store.
 *
 * `persistOnLogin` is the one axis that legitimately differs by surface:
 *  - true  (EnvOverrideTokenStore): an explicit login's fresh token persists to
 *    disk too, so a NEW process (no env override) still sees it — this is the
 *    CLI-entry fix for PR #47's "✓ Logged in" evaporating with the process.
 *  - false (StaticTokenStore): the token stays in-process only. AetherClient is
 *    an embeddable library surface (desktop in-process embed, Aether AI on the
 *    web) whose consumers explicitly must NOT have a `.login()` call clobber
 *    the standalone CLI's independent on-disk session — see StaticTokenStore's
 *    doc comment below.
 */
export function tokenStoreForInjected(
  injected: string | undefined | null,
  opts: { persistOnLogin: boolean },
): TokenStore {
  const t = (injected ?? "").trim();
  if (!t) return defaultTokenStore();
  return opts.persistOnLogin ? new EnvOverrideTokenStore(t, defaultTokenStore()) : new StaticTokenStore(t);
}

/**
 * Token store for a running CLI process, choosing the source by environment.
 *
 * An injected `AETHER_TOKEN` — how the desktop app (and the web server) embed a
 * user's EXISTING session into the spawned CLI — WINS over the on-disk file
 * store, so a user already signed into AetherCloud who opens a terminal is
 * authenticated as that same account and is NEVER asked to re-run
 * `aether auth login`. With no env token (a standalone CLI user), it falls back
 * to the file store, so the normal login flow is unaffected. Mirrors
 * AetherClient's embedded-token resolution (both go through
 * tokenStoreForInjected) so the interactive REPL and the universal chat client
 * agree on auth reads; only the login-persistence axis differs (see
 * tokenStoreForInjected's doc comment).
 */
export function tokenStoreFromEnv(env: NodeJS.ProcessEnv = process.env): TokenStore {
  return tokenStoreForInjected(env["AETHER_TOKEN"], { persistOnLogin: true });
}

/**
 * Env-injected token that still honors an explicit login. The injected token
 * wins for reads until the user logs in; set() then updates BOTH the in-memory
 * override and the on-disk store. Previously the fresh token lived only in a
 * StaticTokenStore, so "✓ Logged in" evaporated with the process and every
 * later run re-read the stale AETHER_TOKEN and got 401s at model-select —
 * the exact bug in PR #47.
 */
export class EnvOverrideTokenStore implements TokenStore {
  private source: TokenSourceInfo["source"] = "environment";
  constructor(
    private override: string,
    private readonly disk: TokenStore,
  ) {}
  async get(): Promise<string | null> {
    return this.override || this.disk.get();
  }
  async set(token: string): Promise<void> {
    this.override = token;
    await this.disk.set(token);
    this.source = "current-process";
  }
  /** Automatic refresh of an embedded session stays in-process: the desktop
   * app owns AETHER_TOKEN, and a background rotation must not overwrite the
   * standalone CLI's independent on-disk login. */
  async update(token: string): Promise<void> {
    this.override = token;
    this.source = "current-process";
  }
  async sourceInfo(): Promise<TokenSourceInfo> {
    const stored = this.source === "environment" ? await this.disk.get() : null;
    return {
      source: this.source,
      storedCredentialShadowed: Boolean(stored && stored !== this.override),
    };
  }
  async clear(): Promise<void> {
    this.override = "";
    await this.disk.clear();
    this.source = "stored";
  }
}

/**
 * In-memory token store for embedded/headless use — a parent process (desktop,
 * web server) injects the user's session_token directly (e.g. AETHER_TOKEN)
 * instead of reading the keychain/file. This is how surfaces route through the
 * core without sharing the CLI's on-disk token.
 */
export class StaticTokenStore implements TokenStore {
  constructor(private token: string) {}
  async sourceInfo(): Promise<TokenSourceInfo> {
    return { source: "injected", storedCredentialShadowed: false };
  }
  async get(): Promise<string | null> {
    return this.token || null;
  }
  async set(token: string): Promise<void> {
    this.token = token;
  }
  async clear(): Promise<void> {
    this.token = "";
  }
}

interface LoginResponseBody {
  authenticated: boolean;
  session_token?: string;
  commitment_hash?: string;
  reason?: string;
  plan?: string;
}

export interface LoginResult {
  plan?: string;
  commitmentHash?: string;
}

/** Authenticate with username/password against /auth/login; store the token. */
export async function loginWithPassword(
  baseUrl: string,
  store: TokenStore,
  creds: { username: string; password: string; licenseKey?: string },
): Promise<LoginResult> {
  if (!isCredentialSafeUrl(baseUrl)) throw new Error("login refused: insecure transport");
  // Bounded on its own: this runs before any token exists, so it can't go
  // through ApiClient.request()'s default timeout — without one, a stalled
  // /auth/login response would hang the headless `--username/--password` flow
  // (login.ts's CI/scripts path) forever with no other cancellation mechanism.
  // Shares AETHER_REQUEST_TIMEOUT_MS with ApiClient so one env var controls
  // both; 0 (explicitly disabled) is honored rather than passing a
  // zero-length AbortSignal.timeout(), which would abort immediately.
  const timeoutMs = defaultRequestTimeoutMs();
  const res = await fetch(baseUrl.replace(/\/$/, "") + LOGIN_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      username: creds.username,
      password: creds.password,
      license_key: creds.licenseKey ?? null,
    }),
    ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  let body: LoginResponseBody;
  try {
    body = (await res.json()) as LoginResponseBody;
  } catch {
    throw new Error(`login failed (HTTP ${res.status})`);
  }
  if (!res.ok || !body.authenticated || !body.session_token) {
    // body.reason is raw JSON from an un-authenticated POST /auth/login
    // response — a compromised/misconfigured backend (or a self-hosted dev
    // server) could otherwise inject raw control bytes, including OSC 52
    // clipboard-hijack sequences, since login.ts's headless catch writes
    // this message straight to stderr with no sanitization of its own
    // (LOOP-06 round 2). Same strip-and-cap treatment toHttpError applies to
    // every OTHER server-text path, via the shared sanitizeServerText().
    const reason =
      typeof body.reason === "string" && body.reason.trim() ? sanitizeServerText(body.reason) : undefined;
    throw new Error(`login failed: ${reason ?? `HTTP ${res.status}`}`);
  }
  await store.set(body.session_token);
  const result: LoginResult = {};
  // Same server-controlled-text hazard as `reason` above, just on the SUCCESS
  // path: login.ts:74 writes `plan` straight to stdout
  // (`✓ Logged in (plan: ${r.plan}).`) with no sanitization of its own, so a
  // compromised/misconfigured backend's `plan`/`commitment_hash` fields need
  // the same treatment before they leave loginWithPassword.
  if (typeof body.plan === "string" && body.plan.trim()) result.plan = sanitizeServerText(body.plan);
  if (typeof body.commitment_hash === "string" && body.commitment_hash.trim()) {
    result.commitmentHash = sanitizeServerText(body.commitment_hash);
  }
  return result;
}
