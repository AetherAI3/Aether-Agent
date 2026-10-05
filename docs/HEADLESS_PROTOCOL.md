# Headless agent protocol

`aether exec [flags] "task"` is the non-interactive agent surface. The name is deliberately separate from the hosted-orchestrator `aether run` and human TUI `aether agent` commands. The default `ollama` driver starts the Node/Ollama child shipped inside the npm package. The explicit `cloud` driver uses the authenticated Aether dev-session protocol while keeping every tool decision and execution in this host; it refuses the legacy server-executed downgrade. No driver opens a TTY or exposes an agent shell tool.

Stdout is newline-delimited JSON. Protocol v1 (`aether.exec/1`) remains the default; v2 (`aether.exec/2`) is opt-in with `--exec-protocol 2`. In either version the first frame is `session`, every frame has a monotonically increasing `sequence` and `correlation_id`, and exactly one `terminal` frame ends a session that initialized. Human diagnostics use stderr. Payloads larger than 16 KiB are redacted and written below `.aether/artifacts/<session>/`; the event carries a workspace-relative path, byte count, and SHA-256 digest.

```text
aether exec --test-cmd "npm test" --permission workspace-write \
  --allow-tool read_file --allow-tool repo_search --allow-tool write_file \
  "fix the failing unit test"
```

The default permission is `read-only`, with `read_file` and `repo_search` declared. Operators may also declare `list_directory` for bounded, cursor-based listings and `patch_file` for digest-checked edits under `workspace-write`. `read_file` streams at most 200 lines or a 4096-byte range per call, with an explicit continuation and a SHA-256 digest for patchable files up to 16 MiB (`sha256: null` for larger files). Its `validation_scope` field is `whole_file` for those patchable files and `returned_range` for larger files, whose bytes outside the returned range are not checked for binary content. `patch_file` emits an exact preview before the permission decision and rejects stale digests. Agent-requested shell, test-shell, Git, and network tools are unavailable in both versions and are rejected at argument parsing as well as the execution gate. The operator-supplied `--test-cmd` is a separate final verification gate. Every model tool request produces a `permission_decision` and `tool_receipt`; undeclared tools and permission escalation fail closed.

`--exec-driver ollama` is the default local model child. `--exec-driver cloud` selects a hosted Cloud text model through a dev session that is required to preserve local tool authority. It requires both explicit `--model <text-model-id>` and `--max-uvt <positive-integer>` bindings. The client verifies that the create response preserved the exact model, while the server enforces the per-session UVT ceiling; both values are immutable in a v2 checkpoint and resume. Neo/Kronus `aether-*` orchestrator IDs are rejected because this dev-session contract does not preserve their router identity. `--exec-driver selftest` is a deterministic installation check: it proves the installed child process, JSONL transport, and verification gate from outside the source tree, performs no model work, and says so in the initial frame.

## Controls

When stdin is a pipe, it accepts one JSON object per line using `aether.exec.control/1`:

```json
{"protocol":"aether.exec.control/1","sequence":0,"correlation_id":"controller-1","action":"steer","note":"only edit tests"}
{"protocol":"aether.exec.control/1","sequence":1,"correlation_id":"controller-1","action":"cancel"}
```

The v1 vocabulary reserves `pause`, `resume`, `steer`, and `cancel`, but only `cancel` is implemented. The other actions return `accepted:false` and are never forwarded or described as applied. Malformed, truncated, duplicate, or out-of-sequence controls terminal-fail the run; later controls are ignored. SIGINT/SIGTERM and timeout terminate the full child process tree and produce one terminal frame.

## Protocol v2 sessions

V2 requires a Git workspace with a committed `HEAD`:

```text
aether exec --exec-protocol 2 --test-cmd "npm test" \
  --authority-ttl-ms 3600000 "fix the failing unit test"
```

Before starting the brain, the host atomically creates an `aether.exec.checkpoint/2` checkpoint under the Aether configuration directory. It binds the canonical workspace and repository, commit, complete working-tree digest, driver/model selection, verification-command digest, permission envelope, optional agent definition, control position, and authority expiry. Checkpoint files are created with restrictive permissions where the platform supports them and are never published as workspace artifacts. A run refreshes the binding after its own accepted mutations. A resume refuses terminal, expired, unreadable, concurrently owned, changed-definition, changed-command, different-commit, or different-workspace checkpoints. Resume authority can only be reused as recorded; model, driver, permission, tools, packs, agent, effort, and TTL cannot be replaced:

```text
aether exec --exec-protocol 2 --resume <session-id> --test-cmd "npm test"
```

V2 controls use `aether.exec.control/2`, and `correlation_id` must equal the session id:

```json
{"protocol":"aether.exec.control/2","sequence":0,"correlation_id":"<session-id>","action":"pause"}
{"protocol":"aether.exec.control/2","sequence":1,"correlation_id":"<session-id>","action":"steer","note":"only edit tests"}
{"protocol":"aether.exec.control/2","sequence":2,"correlation_id":"<session-id>","action":"resume"}
```

Controls are serialized. An identical in-process retry returns the original outcome, a conflicting duplicate is rejected, and a future sequence is rejected without consuming the missing slot. A resumed checkpoint rejects sequences older than its durable control position as stale. Each session accepts at most 256 controls, 16 steer instructions, and 16 KiB of steer text. Pause, resume, and steer are reported as accepted only after the selected brain acknowledges the state change. The cloud driver awaits and validates the Aether control response; a lost or malformed acknowledgement is `accepted:false`. Cancellation and authority expiry close the brain and, for child drivers, tear down the process tree.

Optional agent files use this workspace-confined, versioned shape:

```json
{
  "protocol": "aether.exec.agent/1",
  "version": 1,
  "id": "reviewer",
  "instructions": "Inspect the change and report concrete defects.",
  "allowed_tools": ["read_file", "repo_search"],
  "capability_packs": ["core.read.v1"],
  "permission_ceiling": "read-only",
  "expires_at": "2026-08-24T00:00:00.000Z"
}
```

Load it with `--agent-definition <workspace-relative-path>`. Real-path confinement prevents traversal and symlink escape. Unknown fields, duplicate authority entries, unsupported tools, oversized definitions, expired definitions, and requests above the definition's tool/pack/permission ceiling fail before model execution.

V2 verification records the commit and workspace digest immediately before and after the host-run command. Exit 0 is possible only when the command succeeds and that identity does not change; verification that generates or modifies workspace files is `unattributable` and fails closed.

Packaged v2 model drivers are local Ollama and the explicit hosted text-model `cloud` dev-session driver. The cloud path requires local execution authority, exact model acknowledgement, an explicit per-session UVT ceiling, refuses server-side downgrade, and awaits control acknowledgements. The existing Neo/Kronus orchestrator route executes server-side and therefore cannot serve as this local-authority driver. Actual-Aether headless dogfood remains an external product dependency on a versioned orchestrator dev-session contract with router confirmation, local tool receipts, controls/replay/cancel, and no server fallback. The deterministic `selftest` proves child transport and control wiring but performs no model work. A production hosted-text-model dogfood run remains a separate acceptance gate and has not been performed by this implementation change; neither selftest nor Ollama is evidence for that hosted path.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Agent completed and authoritative verification passed |
| 1 | Agent or verification failed |
| 2 | Invalid invocation |
| 4 | Agent completed but no verification command was configured |
| 64 | Control protocol violation |
| 77 | V2 authority expired |
| 124 | Timeout |
| 130 | Cancelled |

A model's `done.ok` is advisory. Only the host-run `--test-cmd` verification can produce exit 0.
