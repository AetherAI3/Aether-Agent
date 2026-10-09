# Local console shell sessions

[← README](../README.md#chat-and-terminal)

**0.4.0 source candidate.** The newer shell-session and Linux terminal features
below describe `main`; check your installed version and the
[release evidence](releases/OPERATOR-PACKET-v0.4.0.md).

In the coding chat console (`aether` or `aether chat`), leading `!` submits directly to the
local host. It makes no model request. On Linux and macOS the console selects
`/bin/bash --noprofile --norc`. Windows starts with the existing one-shot
`cmd.exe` compatibility profile. Run `/shell-profile list` to inspect native
PowerShell executable/version readiness, then `/shell-profile use powershell`
to opt into a persistent PowerShell session. `/shell-profile status` reports
the active profile, session and cwd; `/shell-profile use cmd` returns to cmd.
No Bash syntax is translated into PowerShell syntax.

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

For Windows PowerShell, use native commands such as `Set-Location 'sub dir'`,
`$env:DEMO = 'hello world'`, and `function Get-Demo { 'ready' }`. User commands
and separately approved local-model shell tools share that selected session.
The PowerShell child is launched with `-NoProfile -NonInteractive` and the same
filtered environment; no profile script or parent credential is inherited.
Changing profiles explicitly discards cwd, environment, functions, queued
submissions and a staged `/shell-result`, without replaying commands. Cmd
continues to start a fresh process for each command.

The `aether agent` host tool loop also owns a fresh Bash session per coding run,
created **after** selecting its checkout/worktree. Hosted `aether chat` still
uses its existing server-side chat tools: those do not execute locally or
inherit the local shell. Use `aether agent` for host-enforced hosted coding
tools. Online account-agent and ATS chats remain separate surfaces.

## Input and display

- Leading whitespace before `!` is accepted; empty `!` prints a local usage
  error. `\!literal` sends literal-leading-`!` text to chat.
- A bracketed multiline TTY paste beginning with `!` is one shell submission,
  preserving its embedded newlines. Line-mode stdin is one command per line.
- Quoting and pipelines follow the active shell's native syntax. stdin belongs
  to the host protocol; noninteractive `!` commands do not own it. For input-driven programs on Linux, use the
  [interactive terminal](#interactive-linux-terminal).
- Commands show user/model origin, shell profile, session ID, command ID, real cwd, state,
  bounded output and exit code. The prompt shows cwd (and lost state). Model
  approvals show both shell cwd and the independent file-tool workspace root.
- `!` submissions made while a model turn is busy retain their shell type and
  wait until that turn completes. All local tools share a FIFO execution slot.
  Ctrl+C cancels the active command/turn and discards its queued follow-ups;
  typing ahead retains the newer composer draft. See [Queued input](#queued-input).
- Shell commands and results are excluded from chat history and hosted prompts.
  `/shell-result` previews a local attachment; only explicit Send shares it.
  The entire attachment, including metadata and fixed untrusted/omission framing,
  is capped at 8 KiB. Dropping or replacing a metadata line really removes it;
  mask/redact affect only editable text, never the protected framing. Redaction
  is an aid, not a guarantee. Reset/profile changes clear unsent previews.
  Pipes/JSON allow one explicit Send of a fresh result; sent/cancelled/empty
  selections cannot silently restage on repeat Send. Explicit preview can stage
  a deliberate retry. Attachment turns do not write custody receipts that might
  echo their content into an export or copy blocked submissions into history.
  Ordinary chat history still honors `AETHER_NO_HISTORY=1`.

## Queued input

Chat, user shell, and approved shell-share submissions made while a turn,
shell command or slash command is running wait in one ordered queue. Each entry gets a session-stable id
(`q1`, `q2`, … never reused) and a type: `chat`, `user shell`, `shell reset`,
`shell profile` or `shell-share`. The input that is running also has an id and is shown
separately; it cannot be edited (Ctrl+C cancels it).

| Command | Effect |
|---|---|
| `/queue` or `/queue list` | Running entry, pending entries in order, and the bound in use |
| `/queue <task>` | Queue a task (runs at once when idle) |
| `/queue edit <id> <text>` | Replace a pending chat or user shell entry in place |
| `/queue remove <id>` | Discard one pending entry |
| `/queue clear` | Discard every pending entry |
| `/queue resume` | Run entries that were kept after a failure |

- Queue commands are local bookkeeping. They work mid-stream and while a model
  switch is pending, never call a model, never start a process, and never
  enter chat history (an edit can carry shell text). A removed or cleared
  entry is never run.
- An edit is classified exactly like typed input and must keep the entry's
  type: a chat entry needs chat text (`\!` for a leading `!`; slash commands
  are not queued), a user shell entry needs `!<command>`. Shell-reset,
  shell-profile and shell-share actions have no editable text: remove and
  queue again. A
  rejected edit leaves the entry unchanged.
- Management keywords match exactly, so `/queue clear the cache` queues a
  task. Edit and remove act only on `q<number>` ids. Malformed controls naming
  such an id are refused locally, including pasted newline separators.
- Bound: 32 entries and 64 KiB of queued text, including approved attachment
  bytes and retained capture provenance. A rejected entry is not queued
  and its draft stays in the composer.
- Slash commands typed mid-turn other than `/steer`, `/btw` and `/queue` are
  not queued; the console says so and ↑ recalls them.

Shell-share binding freezes the exact fully framed reviewed bytes, capture and
session identity before queueing. Later edits, cancellation of a new preview,
or newly completed commands cannot alter that approved entry. To withdraw it,
use `/queue remove <id>` or `/queue clear`; preview Cancel affects only the
unsent preview. Preview/line/edit/redaction/cancel controls always run locally
at submission, even while a model streams, and never become queued prompts.
Queued shell-shares remain immutable; remove and re-review to change one.

Terminal handoff requires pending entries to be resumed or cleared first, so
terminal checkout reconciliation cannot move old queued commands to a fresh
shell. A shell/session generation change discards pending entries explicitly.

What happens to pending entries:

| Event | Pending entries |
|---|---|
| Turn or command completes | Next entry runs |
| Chat turn fails (including hosted 401) | Kept and listed as **paused**; nothing runs until `/queue resume`. A new submission runs alone, and later type-ahead is marked paused |
| Ctrl+C / turn or slash command cancelled | Discarded and listed |
| Local shell state lost, shell action failed, `/shell-reset`, or a shell profile change | Discarded and listed; queued commands never run against a different shell |
| `/auth new`, session exit | Discarded and listed |

The console has no reconnect path that replays work: a hosted turn that drops
is a failed turn (paused above), never a silent resume.

Line mode (non-TTY stdin, pipes, CI) reads the next line only after the
previous one finishes, so it has no pending queue. `/queue <task>` runs the
task as the next line. The management commands print that there is nothing
to manage.

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

`exit`, a shell crash, cancellation, timeout, invalid cwd or broken protocol
ends the session visibly. Use `/shell-reset` to start fresh at the original
workspace root. State is not reconstructed and a mutating command is never
replayed. Bash timeout/cancellation terminate the process group and escalate
to SIGKILL. Windows PowerShell uses `taskkill /T /F` for its child tree. Bash
background jobs are awaited as part of the command; deliberately detached
processes remain outside this non-PTY session-control guarantee.

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
