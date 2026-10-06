# Pull request drafts

`aether ship` prepares a local PR title and body from the complete base-to-head diff, the current repository's `.github/pull_request_template.md` when present, an accepted active goal when one exists, and the current host verification record. The draft uses commit subjects only to identify the task; the listed files come from the final diff. It does not call a model or require a network connection to draft. Generated text is a proposal to review, not evidence that a check ran.

To edit the proposal before publishing:

```text
aether ship --pr-draft > ../pr-draft.json
# Edit the JSON title and body fields in your editor.
aether ship --draft-file ../pr-draft.json --json
aether ship --draft-file ../pr-draft.json --approve publish
```

The draft file contains the base and head revisions, repository, branch, template, accepted scope, and verification fingerprints. If any of them change, the command refuses the saved proposal and asks for a fresh draft. Keep the draft file outside the checkout so it cannot make a prior working-tree check stale. `--title` and `--body` override the draft text exactly, including multiline Markdown. `/ship` supports the same flags; quote a path with spaces.

The ordinary ship preview shows the exact title and full body before asking for publication approval. `--pr-draft` and `--json` never push or create a PR. A cancellation also makes no push or PR call. The publication step still uses the existing argv-based `git push` and `gh pr create` rail.

The verification section labels a recorded check as passed only if its receipt matches the current tree. Failed, stale, skipped, and unrun checks have distinct wording; CI is unknown in this local draft. Template checkboxes remain unchecked for review, and raw check logs are not copied into the body.
