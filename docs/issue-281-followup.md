# Shell attachment review: defensive follow-up to #281

The line editor remains available: `lines`, `drop`, `replace`, `mask` and
`redact`, plus whole-body `edit`. The safety boundaries now apply to the entire
submitted attachment, rather than only the body suffix.

- Dropping/replacing command or cwd lines removes them from the sent payload;
  a second metadata header cannot re-add them
- The complete attachment is bounded at 8 KiB, including immutable trust and
  omission framing. Oversized edits fail without changing the reviewed draft
- Mask/redact transform only editable text. They cannot erase the fixed
  untrusted-data warning or the source omission record
- Terminal sanitation and project-context fence escaping happen before review,
  so the reviewed attachment remains byte-identical in the real model request
- Preview/edit/cancel are resolved locally before the busy queue. Send consumes
  an immutable snapshot synchronously; later commands cannot substitute output
- A rejected/failed attachment cannot become ordinary input history through
  the composer or authentication retry. Its model turn does not persist
  custody receipts that might echo the attachment into an exported artifact
- JSON retains `shell_share_preview`, `shell_share_lines`, and JSON status
  records. Scripts/JSON can explicitly send one fresh capture without a prompt;
  send, cancel and empty selections consume that one-step eligibility. A staged
  preview takes precedence; repeating send cannot silently resurrect it

Regression coverage uses harmless synthetic commands and mocked hosted/local
model transports. `shell_attachment_controls.test.ts` exercises the retained
line editor and the metadata/framing/full-byte-bound failures; the existing
console tests now cover real synthetic TTY and pipes with history enabled,
held-stream queue binding, 401/500 failures, custody exclusion, and exact
request bytes under project rules. Focused local coverage: 34 tests pass.

This change does not weaken branch protection, CI artifact requirements, live
release-truth checks, authentication, or tool permissions. Local functional
acceptance and actual release/service qualification remain separate.
