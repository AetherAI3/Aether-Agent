# PC capability plane: first implementation slice

This page tracks the 2026-09-25 Idea Arena handoff against the Aether Agent
source candidate. It describes implemented behavior, not an installed-package
or hosted-service entitlement claim.

## Commands

| Command | Effect | What it proves |
|---|---|---|
| `aether pc map [--json]` | Read-only | Available, unavailable, denied, and unverified PC adapters. A registered browser is unverified until a page render is observed. |
| `aether pc doctor [aether-cloud\|claude\|chatgpt\|ollama] [--json]` | Read-only local sampling | CPU delta, memory, workspace disk, non-internal network interface count, and selected app/browser processes with PID and start time on Windows. Missing probes are explicit. |
| `aether pc doctor <target> --probe-network` | Three outbound HEAD requests to a fixed target | Reachability p50/p95; includes remote service time. No cookies, tokens, prompt content, or user-defined URL is sent. |
| `aether pc verify-browser` | Opens a loopback readiness page | Interactive approval and a one-use callback prove that a browser rendered the page. The listener closes after the result. |
| `aether pc open [aether-cloud\|claude\|chatgpt]` | Opens one fixed site | One-use interactive approval bound to target and detected browser state. `--yes` and headless sessions cannot approve. Launcher start is reported as dispatch, not as verified page rendering. |

`pc doctor` reports recommendations from observed resource pressure. It never
changes settings or deletes files. In particular, local PC adjustments cannot
guarantee faster inference from Claude, ChatGPT, or Aether Cloud; reachability
measurements combine network and service response time.

## Authority and implementation

`src/core/pc/broker.ts` owns short-lived, single-use PC action plans. A plan is
bound to the local user, session, adapter, operation, target, and expected
state. The broker consumes a plan before calling the host approval port, checks
the state again immediately before dispatch, and refuses changed, expired,
replayed, revoked, or headless requests. Model output, page content, and tool
results do not create approval. The first adapter is a fixed-target browser
open; the command uses a fresh terminal prompt and does not treat `--yes` as a
grant.

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
