# PC capability plane: first implementation slice

This page tracks the 2026-09-25 Idea Arena handoff against the Aether Agent
source candidate. It describes implemented behavior, not an installed-package
or hosted-service entitlement claim.

## Commands

| Command | Effect | What it proves |
|---|---|---|
| `aether pc map [v1\|v2] [--json]` | Read-only | V2 separates support, readiness, permission, missing proof, and source/installed/hosted qualification. `map v1` preserves the older JSON envelope for one transition release. |
| `aether pc doctor [aether-cloud\|claude\|chatgpt\|ollama] [--json]` | Read-only local sampling | CPU delta, memory, workspace disk, non-internal network interface count, and selected app/browser processes with PID and start time on Windows. Missing probes are explicit. |
| `aether pc doctor <target> --probe-network` | Three outbound HEAD requests to a fixed target | Reachability p50/p95; includes remote service time. No cookies, tokens, prompt content, or user-defined URL is sent. |
| `aether pc verify-browser` | Opens a loopback readiness page | Interactive approval and a one-use callback prove that a browser rendered the page. The listener closes after the result. |
| `aether pc open [aether-cloud\|claude\|chatgpt]` | Opens one fixed site | One-use interactive approval bound to target and detected browser state. `--yes` and headless sessions cannot approve. Launcher start is reported as dispatch, not as verified page rendering. |
| `aether pc inspect-browser [aether-cloud\|claude\|chatgpt] [--json]` | Opens a fixed HTTPS site in a disposable Edge profile | After fresh interactive approval, observes a real top-level document, checks its origin and loader identity around inspection, and reports only fixed structural booleans. `rendered` does not mean authenticated; `login-required` means a password field or login route was observed. The profile is closed and removed afterward. |

`pc doctor` reports recommendations from observed resource pressure. CPU and
memory now use three timed samples and show their range. The optional fixed
target HEAD probe reports HTTP classes and status codes separately from latency:
a 401, redirect, or 500 is not application readiness, and partial or mixed
responses are marked inconclusive. Three requests still cannot establish an
app speedup or distinguish network time from remote service time. It never
changes settings or deletes files. In particular, local PC adjustments cannot
guarantee faster inference from Claude, ChatGPT, or Aether Cloud; reachability
measurements combine network and service response time.

The default `pc map` emits `aether.pc/2`. Its `lastProof` fields remain null
until target- and session-scoped evidence is actually recorded. A source value
of `implemented` identifies code in this candidate; `installed` and `hosted`
remain unverified. The prior `aether.pc/1` JSON remains available through
`pc map v1 --json` during the transition.

## Authority and implementation

`src/core/pc/broker.ts` owns short-lived, single-use PC action plans. A plan is
bound to the local user, session, adapter, operation, target, and expected
state. The broker consumes a plan before calling the host approval port, checks
the state again immediately before dispatch, and refuses changed, expired,
replayed, revoked, or headless requests. Model output, page content, and tool
results do not create approval. Fixed-target browser open and controlled Edge
inspection each use a fresh terminal prompt and do not treat `--yes` as a grant.

`src/core/pc/gateway.ts` now wraps the approved browser actions. It durably
writes a redacted intent before dispatch and an outcome afterward. If the intent
cannot be recorded, the action is denied before the adapter runs. If dispatch
or outcome recording fails after that point, the receipt is `unknown`; the
operator should check the browser before retrying. The local JSONL record uses
a target digest, not a raw URL, and is stored under the user's application data
directory. It is an audit aid under the current user profile, not protection
against another process with the same user's privileges.
The outcome records dispatch separately from postcondition verification. An
Edge launch followed by an unproved page state is logged as dispatched with
`verified: false` and returns a failed receipt. The browser proof separately
states whether Edge launched, navigation was attempted, and profile cleanup
completed.

The controlled inspection adapter launches Edge Stable with a separate temporary
profile and a random loopback DevTools port. It never attaches to the user's
normal browser profile. It reads top-level origin, readiness, and presence of
fixed landmarks without returning page text, DOM, cookies, storage, screenshots,
or credentials. A redirect outside the approved origin stops before structure
inspection. It watches for extra page targets during navigation and fails proof
if one appears, even if that page closes before the final count. Its
`browser.inspect` map entry remains **unverified** merely from
driver presence; the receipt from a particular run carries that run's proof.
Browser clicking, typing, and authenticated-session claims remain unavailable.
The temporary DevTools endpoint is local to this user's session, not an OS
isolation boundary against another same-user process. A failed profile cleanup
turns inspection into failure and is reported instead of hidden.

`ToolExecutor` also accepts an explicit `pc` mode. In that mode its legacy
coding tools, including shell and MCP routes, refuse execution. PC adapters
must use the gateway; selecting PC mode does not turn the coding shell into a
contained PC command runner. The hosted model route has not been proved to
call this local gateway, so the PC map continues to report cloud PC actions as
unverified.

The existing `run_shell` coding tool has a separate older permission gate. Its
workspace working directory is not an OS sandbox and must not be presented as
one. The PC capability map therefore marks general `command.execute` denied.
The development-only device runtime's Job Object containment applies only to
process groups it launched; it is not general desktop or shell containment.
The PC doctor imports only its reusable telemetry sampler. It does not start,
enroll, or enable the device runtime. `pc map` exposes this boundary as
`device.runtime: unavailable` and `command.execute: denied`.

## Next implementation gates from the handoff

1. Route **all** PC mutations, including new browser, desktop, process,
   system, and provider adapters, through the host broker with exact target
   identity, revocation, audit receipts, and cross-adapter bypass tests.
2. Add OS-enforced file/network boundaries and process-tree cancellation to a
   constrained command runner. Do not unlock generic PC command execution
   based on shell text matching or `cwd` alone.
3. Choose, pin, and qualify a Windows accessibility/screenshot driver.
   Implement app/window grants, sensitive-field masking, refreshed state after
   each action, elevated-window refusal, and session cleanup before `pc.act`
   or `pc.capture` can become available.
4. Add reversible optimization recipes with baseline, exact preview,
   postcondition, rollback, and measured improvement above noise.
5. Prove hosted Aether tool calls return to this local host broker on a live
   supported service route. Until then, cloud PC actions are unverified and
   no source-only claim may imply production availability.

The `pc` command intentionally reports each unimplemented surface. An
unavailable adapter must not silently fall back to legacy shell, generic MCP,
or a GUI path with broader authority.
