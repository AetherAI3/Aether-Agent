# Residual shell-review and queue safeguards after #308 and #315

Base inspected: `52a890c` (includes persistent PowerShell #312, live steering
#314, and queue management #315). The existing focused console suite passed
32/32 on that base with a writable isolated test home.

## #281: reproduced gaps and regressions

Harmless synthetic probes on the unmodified base confirmed:

- A dropped command line reappeared in a second metadata header
- Replacing one line with 8,193 bytes produced an 8,811-byte attachment
- Masking the literal `untrusted data` erased the fixed trust warning
- Project-rule framing changed reviewed tag-shaped bytes on the model wire
- A mocked custody receipt echoed capture text into durable storage

The repaired flow bounds the complete attachment, transforms only editable
text, escapes project framing before review, and excludes attachment-turn
receipts. Script/JSON one-step Send remains explicit but cannot resurrect a
sent, cancelled or empty selection. Blocked attachment submissions cannot be
restored into ordinary input history. Line/drop/replace/mask/redact UI remains.

## #284: reproduced gaps and regressions

The base also accepted altered bytes behind the same command-ID send binding,
classified a malformed multiline `/queue edit q1` as chat, and reported a
checkout-changing command as `completed` after its shell session ID changed.

Send now queues an immutable approved byte snapshot with capture/session
identity; retained snapshot bytes count toward the existing queue bound.
Malformed edits naming queue IDs fail locally. Session-generation changes
explicitly discard pending work, and terminal handoff cannot change a pending
queue's shell underneath it. Direct and actual busy-TTY tests cover same-capture
edit/cancel after Send, wire equality, process/model spies, history and future
prompt isolation, checkout-reset no-replay, and full-queue admission retry that
keeps the exact edited attachment instead of losing it. Independent review also
replayed an actual auth-blocked TTY Send then Enter with enabled history:
zero model calls, no restored attachment, and no fixture in ordinary history.

The #315 queue IDs, list/edit/remove/clear/resume UI, held-after-chat-failure
policy, and ordinary-task keyword compatibility are retained. #312 shell
profiles and #314 steering remain present and have targeted regression coverage.
No old duplicate queue implementation or unrelated release repair is applied.

All fixtures are local and synthetic; models/receipt responses are mocked.
Live service qualification, native Windows runtime coverage, and required CI
are separate. No gate, branch-protection setting, billing setting, or artifact
requirement is weakened. Final exact-head aggregate evidence belongs in the PR.
