# Local console shell sessions

[← README](../README.md#chat-and-terminal)

**0.4.0 source candidate.** The newer shell-session and Linux terminal features
below describe `main`; check your installed version and the
[release evidence](releases/OPERATOR-PACKET-v0.4.0.md).

In the coding chat console (`aether` or `aether chat`), leading `!` submits directly to the
local host. It makes no model request. On Linux and macOS the console selects
`/bin/bash --noprofile --norc`; an unavailable Bash or unsupported platform
returns a visible refusal, with no silent shell substitution. Windows retains
the existing fresh noninteractive `cmd.exe` user-command path; it does not
share cwd, exports or functions.

```text
!cd subdir
!export DEMO='hello world'
!pwd
```

The next approved **local-model** `run_shell` or `run_tests` uses the same cwd
and exported `DEMO`. Variables, functions, shell options and exports persist
in that Bash process until reset/exit. No rc files are sourced. The initial
environment comes from the host's credential-free `childEnv` allowlist, not
all of the parent's environment. Explicit exports affect this session's child
commands only; they never modify the host process or another session.

The `aether agent` host tool loop also owns a fresh Bash session per coding run,
created **after** selecting its checkout/worktree. Hosted `aether chat` still
uses its existing server-side chat tools: those do not execute locally or
inherit the local shell. Use `aether agent` for host-enforced hosted coding
tools. Online account-agent and ATS chats remain separate surfaces.

## Input and display

- Leading whitespace before `!` is accepted; empty `!` prints a local usage
  error. `\!literal` sends literal-leading-`!` text to chat.
- A bracketed multiline TTY paste beginning with `!` is one Bash submission,
  preserving its embedded newlines. Line-mode stdin is one command per line.
- Quoting and pipelines follow Bash syntax. stdin belongs to the host protocol;
  `!` programs receive `/dev/null`. For input-driven programs on Linux, use the
  [interactive terminal](#interactive-linux-terminal).
- Commands show user/model origin, session ID, command ID, real cwd, state,
  bounded output and exit code. The prompt shows cwd (and lost state). Model
  approvals show both shell cwd and the independent file-tool workspace root.
- `!` submissions made while a model turn is busy retain their shell type and
  wait until that turn completes. All local tools share a FIFO execution slot.
  Ctrl+C cancels the active command/turn and discards its queued follow-ups;
  typing ahead retains the newer composer draft.
- Shell commands and results are excluded from chat history and hosted prompts.
  `/shell-result` stages a memory-only preview of at most 8 KiB, including
  immutable untrusted-data framing, an opaque capture ID, command/session IDs,
  captured cwd, exit status, and UTF-8 omission information. The displayed
  attachment is exactly the attachment submitted on `/shell-result send`;
  ordinary project instructions may surround it in the model request.
  `/shell-result lines` shows numbered body rows; `drop <first>[-<last>]`,
  `replace <line> <text>`, `mask <literal>` and `redact` update only that body.
  These transformations cannot remove protected trust/omission framing.
  `/shell-result edit <replacement text>` replaces the entire editable body,
  allowing command/cwd/secret-bearing lines to be removed. The preview updates
  after sanitation/redaction; edits retain an explicit edited-selection notice
  and capture omission count. Empty selections and `/shell-result cancel` make
  zero model requests. Oversized edits are refused without changing the draft.
  Redaction is an aid, not a guarantee: review all output and metadata.
  A later command cannot replace a staged preview. To preview the latest capture,
  cancel the existing draft first. Send consumes the draft before queueing, so a
  repeated send cannot submit it twice. Reset/exit clear unsent previews.
  TTY and pipe mode use the same explicit commands; pipes never wait for a
  confirmation prompt. Scripts/JSON sessions may explicitly send one fresh
  capture with `/shell-result send` without preview. An existing preview wins;
  sending/cancelling/emptying consumes one-step eligibility until a new command
  completes. Previewing again explicitly still permits a deliberate re-send.
  Neither previews, shell commands, nor edited attachment bodies enter ordinary
  chat history or durable custody receipts/support exports. A failed send is not
  copied into the chat composer or saved for authentication replay; stage and
  review again to retry. Later chat prompts do not automatically include it.
  Ordinary chat history still honors `AETHER_NO_HISTORY=1`.

## Manage pending console entries

TTY type-ahead and `/queue <task>` use a strict memory-only FIFO with stable
local IDs such as `q3`. `/queue` or `/queue list` displays the running entry
as immutable, then every pending entry's ID, type, approval state and text.
List text is terminal-escaped for safe inspection. Shell commands remain user
shell actions; listing, editing or queueing them never turns them into chat.

- `/queue edit <id> <replacement>` edits a pending entry in place. Shell edits
  require `!command`; a chat cannot become a shell/slash action. Active entries
  and shell resets cannot be edited. Invalid edits leave the entry unchanged
- `/queue remove <id>` discards only that pending entry; `/queue clear` discards
  all pending entries. Both are local and neither interrupts the active turn
- `/queue edit <id> <replacement body>` on a shell-share keeps the original
  capture binding but revokes its old Send approval. The new exact preview is
  shown. Use `/queue send <id>` after reviewing it; an empty selection cannot
  be sent. FIFO pauses at an unapproved head rather than skipping it
- After removing a paused head, `/queue run` explicitly resumes ready pending
  entries. List/edit/remove/clear never launch a model or process by themselves
- The bound is 32 pending entries and 64 KiB of UTF-8 serialized input, including
  retained capture provenance. Enqueue and edits enforce both limits; oversized
  edits preserve the previous entry. New rejected submissions are not queued
- Cancellation, turn/slash failure, auth-new, shell state loss, checkout/session
  changes and exit discard pending work and display the discarded IDs/types and
  remaining count. Discarded IDs never silently restart after auth repair or
  shell reset. A separately saved failed active chat still follows explicit
  authentication-repair controls; it does not contain the discarded queue
- Terminal handoff is refused while entries remain pending; run or clear them
  first so an old queued command cannot inherit a reconciled terminal checkout
- Queue management and queued shell text are excluded from ordinary history.
  Typing ahead is preserved while the active operation finishes or fails

Pipe/non-TTY mode remains sequential: it finishes one input line before reading
the next. It has no editable pending queue; queue-management commands print
local guidance and never invoke a model. Use TTY mode for responsive management
while streaming. Explicit shell-preview commands work in both modes.

## Interactive Linux terminal

Use `/terminal <command>` in the local coding console when a program needs
terminal input, for example `/terminal python3`. It requires Linux, Python 3 on
PATH, and TTY stdin/stdout. Pipes/CI and other platforms show guidance to use
`!command`.

| Action | Control |
|---|---|
| Interrupt the foreground program | Ctrl+C |
| Return to chat while the terminal keeps running | Ctrl+] |
| Check terminal ID and state | `/terminal-status` |
| Reattach | `/terminal-attach` |
| Stop the terminal and its process group | `/terminal-stop` |

One terminal runs per console. It starts an isolated Bash child in the current
shell directory using the reviewed child environment. It does not inherit the
persistent shell's exports/functions or change that shell's cwd. Normal
`!commands` and approved model shell tools retain their capture path.

While attached, input and resize go to the terminal. Local file, shell, and
model tools refuse execution while it is active, including when detached;
ordinary model chat stays available. Terminal edits belong to the user and are
excluded from automatic commits.

Exit, crash, or launch failure restores the console. Leaving the console stops
its terminal; restart never replays commands or reconnects an old session.
Attached output is live, and reattachment shows only an 8 KiB recent tail.
Commands and output are excluded from saved chat history and automatic hosted
prompts. This terminal is an explicit local user action, with no model-callable
PTY tool or Online DM terminal.

## Workspace and recovery

The workspace root is fixed by the local host and is separate from shell cwd.
Relative `read_file`, `write_file`, `repo_search` and diff snapshots resolve at
that root. Their existing traversal/symlink guards still apply. `cd` checks the
physical target before changing directory and refuses targets outside the
workspace, including symlink escapes. Failed `cd` leaves cwd intact. A shell
which bypasses the `cd` wrapper and ends outside that boundary is terminated
and loses its state. Arbitrary approved shell execution is **not an OS sandbox**:
it retains the same filesystem authority as the existing shell tool.

Branch/checkout identity changes reset cwd, environment, functions and commit
ownership. An external checkout switch refuses the next tool/submission and
asks for resubmission or fresh approval; it does not replay it. A new project
or coding worktree requires a new host session, never a retargeted executor.
Model approvals are bound to the displayed session/cwd/state revision; if
another local operation changes it before execution, the tool is refused.

`exit`, a Bash crash, cancellation, timeout, invalid cwd or broken protocol
ends the session visibly. Use `/shell-reset` to start fresh at the original
workspace root. State is not reconstructed and a mutating command is never
replayed. Timeout/cancellation terminate the process group and escalate to
SIGKILL. Background jobs are awaited as part of the command, so they belong
to its timeout/cancellation scope. Deliberately detached processes are outside
this non-PTY session-control guarantee.

## Automatic commit ownership

`git_commit` stages only paths observed changing during model operations.
Pre-existing dirty/staged paths retain the existing refusal/exclusion rules.
User shell mutations and external edits observed between operations are
excluded, including later edits to an agent-owned file. A file containing both
user and agent work is excluded as a whole, even if the agent edits it again.
There is no implicit hunk attribution or approval to sweep up user work.

Ownership probes fail closed on unreadable/unattributable files. They are
conservative attribution between serialized operations, not a filesystem lock:
an unrelated editor writing during a model command cannot always be attributed
automatically. Review changes before committing. Explicit user git commands and
approved model `run_shell` commands still have their original shell authority;
these staging restrictions apply to the automatic `git_commit` tool.
