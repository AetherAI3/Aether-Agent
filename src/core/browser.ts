// Open a URL in the system default browser, cross-platform. Best-effort and
// non-fatal: headless boxes have no browser, so callers always print the URL
// too. Shared by `auth login` and `github connect` (same web-canonical flow).
//
// The launch itself lives in opener.ts, which every URL and file open in this
// CLI now goes through — one argument-array implementation, no shell string,
// and the same code path `doctor --live` proves. This used to spawn
// `cmd /c start "" <url>` on Windows, which handed the URL to the command
// interpreter as a token.

// Detection, typed failure codes and the loopback render proof live in
// browser_runtime.ts and are re-exported here, so "the browser seam" is one
// import for callers and there is no second browser stack to keep in step.
// `spawned` is not `rendered`: prefer openBrowserTyped over the raw launches
// below anywhere the operator has to be told why nothing appeared.

import { openTarget, openTargetChecked, type OpenOutcome } from "./opener.js";

export {
  BROWSER_HINTS,
  BROWSER_SCHEMA,
  browserHint,
  classifyLaunchError,
  detectBrowserRuntime,
  isBrowserAvailable,
  openBrowserTyped,
  verifyBrowserLaunch,
  type BrowserCode,
  type BrowserOpenResult,
  type BrowserRuntime,
  type VerifyResult,
} from "./browser_runtime.js";

/** Open `url` in the default browser. Never throws. */
export function openBrowser(url: string): void {
  openTarget(url);
}

/** Same launch, but with the outcome so a caller can report a refusal. */
export function openBrowserChecked(url: string): OpenOutcome {
  return openTarget(url);
}

/** Wait for the initial OS launcher outcome when an interactive recovery path
 * needs to tell the user whether the browser was actually started. */
export function openBrowserAwaitLaunch(url: string): Promise<OpenOutcome> {
  return openTargetChecked(url);
}
