# Issue #247: final shell output retention

Reviewed against the original issue on 2026-10-01, based on main
`892b27b405964b779b7a7d7215f3458278a3f038`.

The original one-shot implementation retained a prefix up to 64 MiB and then
discarded all subsequent chunks. The persistent shell retained only its first
8,000 characters. Both could drop the real final summary.

## Acceptance evidence

| Original requirement | Implementation and regression evidence |
| --- | --- |
| Bounded head and rolling tail; continue draining both pipes | `BoundedOutput` owns two fixed buffers (7,920 payload bytes within an 8,000-byte body budget). Both execution paths continue reading and streaming stdout/stderr. Tests count every emitted byte across 66 MiB real child output. |
| Actual final bytes survive beyond 64 MiB | `run_shell`, `run_tests`, direct user execution, and persistent user/model execution retain initial output plus distinct final stdout/stderr markers and authoritative exit 7. |
| Single oversized chunk | A direct 65 MiB append retains `HEAD_247` and `FINAL SUMMARY: 1 failed`, with fixed retained capacity. |
| Incremental UTF-8, interleaved pipes | Independent pipe decoders; unit tests cover two-, three-, and four-byte cuts, wrapping, and exact omission accounting. Child fixtures stagger individual UTF-8 bytes across both pipes; persistent callbacks never split surrogate pairs. |
| Explicit omissions without invented summary | Rendered notices count omitted decoded UTF-8 bytes; final text is copied from actual output. Malformed input is decoded using Node's normal replacement semantics, so counts describe normalized UTF-8 rather than malformed raw bytes. |
| Cancellation and timeout distinctions | Real post-cap termination preserves summaries and codes 130/124 for both execution paths. Persistent sessions visibly lose state, refuse execution until reset, and produce clean output afterward. |
| Completion and isolation | Capture renders after pipe draining/decoder flush. Persistent protocol markers never appear in normal capture or callbacks; next commands have clean output. |

Explicit `/shell-result` sharing also uses bounded head/tail capture so a long
Unicode command cannot cause a second head-only truncation of the final summary.
File/web/search `capHeadTail` behavior remains unchanged.

## Validation

Seven new integration regressions failed on the unmodified implementation and
passed after the fix. Independent review included 5,000 randomized Unicode
capture cases without a prefix/suffix, byte-count, boundary, or budget failure.

Local environment: Linux, Node 24.19.0. The checked-in tests also run in the
repository's Windows CI job; persistent Bash tests explicitly skip unsupported
platforms.

Final local suite and hosted-check results are recorded in the PR and issue
closure comment. The initial full-suite run exposed two fixed-delay console
routing fixtures; those scenarios passed independently, and their synchronization
was hardened to observe completion rather than assume wall-clock timing.
