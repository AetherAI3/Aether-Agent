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

`read_file · write_file · run_shell · run_tests · repo_search · git_commit`

- One path-guard confines every path to `cwd` (traversal refused).
- `read_file` accepts `path` and optional byte `offset` (default 0) and
  `max_bytes` (4–4096, default 4096). Its result reports the actual byte range,
  total size, `complete`, `truncated`, `next_offset`, and line-boundary flags.
  A long path may reduce the returned byte count to keep the tool output below
  its cap. Continue at `next_offset` when truncated. An offset inside a UTF-8 character,
  binary content, or invalid UTF-8 is rejected. UTF-8 validation covers the
  returned range; unread bytes are not certified as text. A tail range can have
  `truncated=false` while `complete=false` because earlier bytes were omitted.
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
