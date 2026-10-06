# Issue 284: bounded pending console management

## Contract

TTY pending entries have stable local IDs and retained types (chat, user shell,
shell reset, or reviewed shell-share). The active entry is immutable. List,
edit, remove and clear are local controls handled before history and ordinary
submission; malformed management syntax fails closed. Pending entries are
bounded at 32 entries and 64 KiB of UTF-8 serialized input, including retained
attachment provenance. Edits enforce the same bound and preserve position.

A reviewed shell-share keeps its capture identity. Editing it revokes prior
Send approval and pauses strict FIFO at that entry until explicit `/queue send`.
Removal never dispatches later work; `/queue run` is the explicit ready-FIFO
resume control. Empty attachment selections cannot be approved. Failure,
cancellation, checkout/session changes, auth-new, and exit display discarded
IDs/types and pending count; discarded entries never resume after recovery.
Terminal handoff requires an empty pending queue to prevent inherited checkout
changes. Existing model-switch controls remain reachable and preserve a saved
draft without overtaking earlier queued entries.

Pipe mode is intentionally sequential. Queue-management input prints local
TTY guidance and makes no model requests; it does not imply responsive pipe
queue editing while a prior turn is running.

## Regression coverage

Focused suite: 57 tests pass across console input/shell, attachment/line editor,
pending queue, and model continuation.

- Real synthetic TTY streaming with local list/edit/remove/clear operations
- Model and process spies prove removed/cleared/cancelled entries do not execute
- Active immutability, invalid reclassification, count/UTF-8 edit bounds
- Strict mixed FIFO and paused edited attachment requiring new explicit Send
- 401, ordinary failure, active cancellation, shell loss and checkout reset
- Draft preservation, cancelled model-switch restore, and exit while paused
- Malformed pasted controls cannot become a model prompt or ordinary history
- Non-TTY local guidance; all #281 privacy/binding/line-editor regressions rerun

All fixtures are synthetic. No paid model call, real credential, live service
qualification, branch-protection change, or CI-gate weakening is involved.
Final exact-tree aggregate/CI evidence belongs with the PR. Baseline smoke DNS,
release packet, billing, runner availability and artifact-quota failures must
be reported separately rather than relabeled as feature acceptance passes.
