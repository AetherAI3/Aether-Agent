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
  typing ahead retains the newer composer draft.
- Shell commands and results are excluded from chat history and hosted prompts.
  `/shell-result` explicitly shares up to 8 KiB of the latest user result as
  untrusted data. Reset clears that result.
  Ordinary chat history still honors `AETHER_NO_HISTORY=1`.

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
