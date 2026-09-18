# Agent and ATS browser setup review

Scope: continuation of Agent #154 and ATS #441; Cloud #1691 remains the shared managed-agent companion. Agent base ccbe1595, original candidate af326b59; ATS base 420538ae, original candidate 8f8ac98e. Canonical ATS follow-up: eaf11bf367dd6aeb7ba354e59d8cfb4a84b3387a. Browser dependency0.2.2, Context dependency0.3.1; Agent candidate0.4.0.

## Four independent lanes

1. Browser builder: bounded transport, native image/schema validation, exact-session lifecycle.
2. Terminal builder: ordinary/ATS setup, explicit browser controls, input-preserving asynchronous output.
3. Runtime qualification: real pinned Context/Nano, native Browser API failure lifecycle, separate live qualification harness.
4. Read-only breaker: benign fixtures, independent reproductions and fix verification. Root integrated source custody, visual skill and package/release gates.

Findings and responses were recorded in an append-only queue. The breaker did not modify product code. LOOP-10 used benign local fixtures; no confirmed security exploit was demonstrated. LOOP-11 reviewed concrete evidence and retained unknown boundaries. Supplied PROTOCOL.md was absent, and Aether project bootstrap returned no matching project.

## Findings and resolution

| Finding | Before | Fix and evidence |
| --- | --- | --- |
| B1: response body escapes SDK deadline | Real local HTTP fixture stayed pending after headers, timeout and caller abort | Adapter buffers a bounded body before returning to pinned SDK; timeout/abort remain active; redirects refused. Actual SDK fixture rejects at56ms for50ms deadline. Canonical standalone SDK is unchanged. |
| B2: remote viewer guidance conflicts with native security | Suggested tunneling an unauthenticated loopback viewer | Browser-host-local noVNC only; remote authenticated API observation stays distinct. Setup/docs no longer suggest forwarding. |
| B3: incomplete evidence claims observing | Metadata-only snapshot reported observing without PNG, URL or viewport | Native closed schema, bounded PNG CRC/raster/dimensions, session/freshness/expiry/budget validation before publishing immutable receipt. |
| B4: terminal cancellation misses observer open | Cancelled health later admitted one session before cleanup | Combined signal forwarded through actual dependency; cancelled health creates zero sessions, admitted create receives identity then releases exactly once. |

Four review rounds found3,1,0,0 new root causes. B1–B4 are addressed in the scoped implementation. Independent local custody comparison matched all12 source receipt hashes across canonical ATS source, Agent vendor and installed dependency. The local installed dependency is a vendor symlink; packed installation is a separate required gate.

The four-round budget ended without the five consecutive clean rounds required for LOOP-17 convergence. Its session exit is BUDGET_EXHAUSTED/FAIL-with-artifact, separate from PASS for the concrete fixes reviewed here. No global security certification or model prompt-injection resistance is claimed.

## Packaging follow-through

The release gate found P1: working managed-chat commands were absent from the canonical slash manifest. Two scoped entries now record managed-agent ownership, existing hosted-account requirements and release disposition; generated docs include both. The coding REPL gives a managed-chat entry-point hint without executing tools or reflecting arguments. Two new tests failed before the fix; the48-test manifest/slash/docs subset then passed. All six generated documentation outputs match. This integration gate fix followed the bounded breaker review and is not an additional claimed LOOP-17 convergence round.

## Evidence and remaining boundaries

- ATS package61/61 tests pass, zero skips, with actual published Context0.3.1 and pinned native Nano/ATS compile seam. Browser/transport/visual subset34/34 independently passes.
- Agent terminal/controller/managed suites45/45 pass, zero skips. Real readline fixture preserves a wrapped draft and edited cursor during asynchronous updates. Both cancellation seam tests import the actual synchronized dependency.
- Actual unmodified Browser0.2.2 API plus published JS SDK: health succeeded, create returned BROWSER_NOT_READY/503 without consuming the slot; service closed. This proves the failure lifecycle only.
- Actual headed Chrome/noVNC remains unqualified because the executor denies AF_UNIX display sockets. No host isolation was changed. The opt-in source test test/live_runtime.mjs requires the native Browser acceptance namespace and is excluded from default fixture suites; disabled invocation skips, not passes.
- Cold unattended context bootstrap was interrupted by tool network approval cancellation. Direct fresh private-venv engine qualification passes; interrupted bootstrap is neither a product pass nor product failure.
- The visual skill returns a PNG, bounded untrusted page data and source/hash evidence to an admitted host. No automatic upload, Cloud multimodal tool bridge, model browser actions, strategy conversion, live data adapter or broker authority is established.
- Windows terminal/native visual behavior and concurrent memory access by an independent live engine remain unqualified. Local memory setup does not grant Cloud APR activation.
- The broad Agent suite's previously reproduced baseline review_counts EPIPE remains separately documented. No completely green full-suite claim.

Final package proof:569 files and3,468,703 unpacked bytes; offline installed archive imports the pinned SDK and visual skill and passes CLI/headless selftest. Release/package/coherence/public-document suites65/65 pass. See docs/releases/OPERATOR-PACKET-v0.4.0.md for final local packaging evidence and the draft PR for committed-head hosted checks. No release, deployment, live trade or self-merge occurred.
