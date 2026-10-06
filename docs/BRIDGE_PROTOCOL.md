# AetherCode ↔ Brain Bridge Protocol (FROZEN v1)

The event seam between the **headless brain** (decides) and the **TS host**
(renders + executes). One schema, two transports. Canonical for both sides:

- Python brain: `aether_agent/protocol.py` (Unlimited-Context repo)
- TS host: `src/core/brain_protocol.ts` (this repo)

Design — split by **responsibility, not language**:

> The TS host owns **all rendering** and **all tool execution** (one path-guard).
> The brain is **headless** — it emits events and never touches the terminal or
> the filesystem. Both brains (local Python/Ollama · cloud Aether API) emit the
> same events, so local and cloud UX are **identical by construction**. Switching
> local↔cloud swaps the transport; host code is unchanged.

## Transports

| | local | cloud |
|---|---|---|
| wire | NDJSON over stdio (subprocess stdout=events, stdin=commands) | SSE (universal stream) |
| brain | `python -m aether_agent.headless` (Ollama) | Aether API `/agent/chat/stream` |
| tool round-trip | full (host executes, replies) | server-side today (see note) |

**NDJSON framing:** one JSON object per line. The host buffers partial lines
(`LineBuffer`) — a JSON object may split across stdout chunks (LSP/DAP pattern).
The wire is **ASCII-safe** (`ensure_ascii=true`): kaomoji become `\uXXXX` escapes
so a Windows cp1252 pipe never trips; the host's `JSON.parse` decodes them back.

## Messages

### brain → host (events)

| type | fields | meaning |
|---|---|---|
| `stage` | `name, face` | staged-lifecycle marker (recon…reveal) |
| `monologue` | `text, depth` | nested reasoning-tree line (dim) |
| `skill` | `name, reason` | a procedure packet was pinned (local-hardening: procedure layer) |
| `tool_call` | `id, name, args` | **host must execute and reply** with `tool_result` |
| `telemetry` | `tokens, tps, ctx_used, ctx_cap, vram` | live effort/velocity |
| `status` | `phase, pool_used, pool_cap` | drives the pool-fill bar (`pool_cap = pool_gb × 233M`) |
| `checkpoint` | `git_sha` | a verified step was committed |
| `done` | `ok, result` | run finished |
| `error` | `msg` | run aborted |

### host → brain (commands)

| type | fields | meaning |
|---|---|---|
| `task` | `text, cwd, pool_gb, effort, model` | starts a run (first message) |
| `tool_result` | `id, output, exit_code` | reply to a `tool_call` |
| `control` | `action (pause\|resume\|steer), note` | interactive control |

Wire keys are **snake_case** (Python's keys); the TS host maps them to camelCase
on decode and back on encode.

## Tools (the ONE implementation — host-side)

`read_file · list_directory · patch_file · write_file · run_shell · run_tests · repo_search · git_commit`

- One path-guard confines every path to `cwd` (traversal refused).
- `read_file` accepts `path` and either byte `offset`/`max_bytes` (4–4096,
  default 4096) or line `start_line`/`max_lines` (1–200, default 200). Its JSON
  result reports content, file size, and an explicit continuation (`next_offset`
  or `next_start_line`). Byte results also report the returned range,
  `complete`, `truncated`, and line-boundary flags. Every successful result
  includes an opaque `revision`. For Linux files up to 16 MiB, send it unchanged
  as `expected_revision` with each later byte or line range. A changed snapshot returns exit code 1 with
  `stale_revision` and no content; restart from the beginning. A long path or heavily
  escaped content may reduce the returned byte count to keep output bounded.
  An offset inside a UTF-8 character, binary content, or invalid UTF-8 is
  rejected. Each read of a file up to 16 MiB captures one bounded buffer,
  validates and hashes that buffer, and returns ranges from those same bytes.
  Initial reads and guarded continuations return the actual whole-file
  `sha256` and `validation_scope: whole_file`. Larger files support unguarded
  bounded byte pages with `sha256: null` and `validation_scope: returned_range`.
  A tail byte range can have `truncated: false`
  while `complete: false` because earlier bytes were omitted. Hosted dev
  sessions explicitly advertise `read_file_ranges: true` and
  `read_file_revisions: true` when supported.

  Bounded revisions bind the content digest to the opened file's device,
  identity, size, and nanosecond change timestamps. Identical timestamps after
  a same-size rewrite cannot authorize changed content. Every continuation
  computes a fresh snapshot digest, bounded by 16 MiB per call. Guarded reads
  above 16 MiB or on other platforms return `revision_unsupported` with exit
  code 1 before content I/O. All revision comparisons use the opened handle;
  Linux verifies that handle stays inside the workspace, and observed changes
  during a read still fail the read-conflict check.
- `write_file` creates a missing path with create-only semantics. To replace an
  existing regular text file, send `expected_revision` and `replace_token` from
  the **same complete byte-mode `read_file` result** (`complete: true`). The
  token is signed for this executor, path, and revision, and is absent from
  partial, line-mode, binary, and unsupported reads. A legacy `path`/`content`
  call against an existing file fails with guidance. A stale revision fails
  before replacement. Since a complete byte result is limited to 4096 bytes,
  use `patch_file` for larger files. Hosted dev sessions advertise
  `write_file_preconditions: true`; the hosted server rejects coding sessions
  that request `write_file` without this flag with a clear upgrade error.
  Local and hosted calls execute through the same host validator. Tokens
  cannot be carried to another executor/session.
  The host stages content in a sibling file and syncs it first. New files are
  committed with an atomic hard link that fails if another creator won the
  race. Replacements recheck the bounded prior image and path identity just
  before same-directory rename. On filesystems where rename over a file is
  unsupported or blocked (including some Windows sharing modes), the call
  fails and leaves the old file intact. Concurrent writers that bypass this
  host and change the path in the interval between final check and rename are
  outside the host's compare-and-swap guarantee; use an external workspace
  lock when such writers are present. Successful replacements report prior
  and new revisions for audit.
- Tool output is bounded. Shell and test output includes `[exit N]`; file reads
  include explicit range and continuation metadata. The host sends the same
  result shape to local and cloud brains.

## The loop

```
host.send(task)
for each event from brain:
    host.render(event)                      # the only renderer
    if event is tool_call:
        result = host.execute(tool_call)    # local fs/test/git, path-guarded
        host.send(tool_result(id, result))  # brain resumes deciding
    if event is done|error: stop
```

## Three local-hardening layers (what the brain injects)

| layer | fixes | mechanism |
|---|---|---|
| **memory** | forgetting | Unlimited Context retrieval keeps the thread |
| **procedure** | missing know-how | **skill layer** — pin the matched how-to (`skill` event) |
| **correctness** | mistakes | ground-truth gate — green tests → `checkpoint`; stalled → re-strategize |

Skills are **priors, not truth**: a skill that fails the tests is overridden by
the grounding gate (opinions in, facts win).

## Honest boundary (cloud tool round-trip)

Today's universal SSE runs its tools **server-side** and emits no `tool_call`
frame / no upstream channel, so `CloudBrain.sendToolResult` is a no-op and the
cloud path surfaces the frames that exist (delta/reasoning/task_*/done/error).
When the server adds `tool_call` frames + an upstream `tool_result` channel,
`CloudBrain` implements the same round-trip the local brain already does — **no
host change** (that is the point of the seam).

## Status: built + unit-verified · live-model run pending

- Python brain headless + skill layer: `tests/test_bridge.py` (11) green.
- TS host (protocol/line-buffer/tool-executor/host-loop/status-bar):
  `test/bridge.test.ts` + `test/statusbar.test.ts` (18) green.
- Cross-language wire proven: Python NDJSON → TS decoder, faces round-trip.
- **Not yet run:** the live local loop (needs Ollama + `qwen3-coder:30b`) and the
  ON-vs-OFF kill-gate. The flagged risk stands — stress the local brain's
  tool-call emission over a long session first.
