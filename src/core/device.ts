// OAuth 2.0 Device Authorization Grant (RFC 8628) client — the default
// `aether auth login` flow. Requests a user_code, the user approves it in the
// portal (aethersystems.net/platform/device), and the CLI polls until the
// server hands back an `aek_` API key. Same flow as `gh auth login`.

import { ApiClient, DEVICE_CODE_PATH, DEVICE_TOKEN_PATH } from "./transport.js";
import { HttpError } from "./errors.js";
import { errTheme } from "../ui/theme.js";

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
}

export type PollResult = "wait" | "slow_down" | "denied" | "expired" | "ready";

interface PollResponse {
  error?: string;
  access_token?: string;
}

/** Pure: map a token-endpoint response to a poll action. */
export function classifyPoll(r: PollResponse): PollResult {
  if (r.access_token) return "ready";
  switch (r.error) {
    case "slow_down":
      return "slow_down";
    case "access_denied":
      return "denied";
    case "expired_token":
      return "expired";
    default:
      return "wait"; // authorization_pending or anything unknown
  }
}

/** Start a device-grant login. Unauthed endpoint. */
export async function requestDeviceCode(api: ApiClient, signal?: AbortSignal): Promise<DeviceCode> {
  return api.postJson<DeviceCode>(DEVICE_CODE_PATH, { client_id: "aether-cli" }, signal);
}

// Consecutive non-HTTP polling failures (network down, DNS failure, timeout,
// a malformed/bodyless response) before we tell the user something looks
// wrong. A single blip shouldn't interrupt "waiting for approval", but a
// sustained outage must not read as silent waiting for the whole expires_in
// window.
const NETWORK_WARN_THRESHOLD = 3;

/**
 * Poll the token endpoint until the user approves in the portal. Returns the raw
 * `aek_` token. `sleep` is injected so the loop is testable. Honors `slow_down`
 * (bump interval) and gives up at `expires_in`.
 */
export async function pollForToken(
  api: ApiClient,
  code: DeviceCode,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<string> {
  let interval = code.interval;
  const deadline = Date.now() + code.expires_in * 1000;
  let consecutiveNetworkErrors = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("login cancelled", "AbortError");
    await sleep(interval * 1000);
    if (signal?.aborted) throw signal.reason ?? new DOMException("login cancelled", "AbortError");
    let resp: PollResponse;
    try {
      resp = await api.postJson<PollResponse>(DEVICE_TOKEN_PATH, { device_code: code.device_code }, signal);
      consecutiveNetworkErrors = 0;
    } catch (err) {
      // The poll endpoint returns 400 with a string `error` body for pending/
      // slow_down/expired (RFC 8628); postJson throws HttpError carrying that
      // body — that's the ONLY case that should be folded into ordinary
      // polling state. Any OTHER thrown error (network down, DNS failure,
      // timeout, a malformed/bodyless response, or a non-400 HttpError such
      // as a 5xx that merely happens to carry a parseable JSON object body,
      // e.g. FastAPI's `{"detail": "..."}`) is a real problem, not "user
      // hasn't approved yet" — don't silently reclassify it as
      // authorization_pending, or a genuine outage reads as normal polling
      // for the whole expires_in window.
      if (
        err instanceof HttpError &&
        err.status === 400 &&
        typeof (err.body as Record<string, unknown> | undefined)?.["error"] === "string"
      ) {
        resp = err.body as PollResponse;
        consecutiveNetworkErrors = 0;
      } else {
        consecutiveNetworkErrors++;
        if (consecutiveNetworkErrors === NETWORK_WARN_THRESHOLD) {
          process.stderr.write(
            errTheme.dim("⚠ can't reach the server — still trying… (check your connection)\n"),
          );
        }
        continue;
      }
    }
    const action = classifyPoll(resp);
    if (action === "ready") return resp.access_token as string;
    // Denial is RECOVERABLE, and "authorization denied in the browser" said
    // neither that nor what to do next — it read like a verdict on the account.
    // It also matters that a denial is not necessarily the user's own: any
    // signed-in account that learns a user_code can refuse it, so a denial the
    // user did not perform means their code reached someone else.
    //
    // Kept to ONE line on purpose: this is rendered by formatErrorLine, which
    // puts its glyph on the first line only — a multi-line message loses the
    // glyph on every line after the first.
    if (action === "denied") {
      throw new Error(
        "authorization denied — nothing was authorized and no key was created. " +
          "Run `aether auth login` again to retry; if you didn't deny it, " +
          "someone else has your login code — don't share it.",
      );
    }
    if (action === "expired") throw new Error("login timed out — run `aether auth login` again");
    if (action === "slow_down") interval += 5;
  }
  if (consecutiveNetworkErrors >= NETWORK_WARN_THRESHOLD) {
    throw new Error(
      "login timed out — couldn't reach the server while waiting for approval; check your connection and try again",
    );
  }
  throw new Error("login timed out — run `aether auth login` again");
}
