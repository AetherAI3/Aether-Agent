<!-- GENERATED FILE: run `npm run docs:generate`; do not edit by hand. -->
<!-- manifest-digest: sha256:845aebd7f9882dd7d38977c75e678ccf15a3d2a2fd740c4eb37711a95e24dc4e -->
# Generated command reference

This reference is generated from the validated, versioned command manifest. Availability is evaluated at runtime; a listed command may still require authentication, a hosted capability, or local tooling.

Global shell flags accepted by the manifest:

`--agent`, `--all`, `--apply`, `--audit`, `--available`, `--ci`, `--cwd`, `--effort`, `--help`, `--interactive`, `--json`, `--junit`, `--license-key`, `--local`, `--model`, `--no-browser`, `--no-log`, `--no-skills`, `--out`, `--password`, `--pool`, `--quiet`, `--repo`, `--resume`, `--scope`, `--skill`, `--test-cmd`, `--token`, `--username`, `--version`, `--with-token`, `--worktree`, `--yes`

## Shell commands

### Start

#### `aether help [command]`

show grouped help or command detail

Permission: `read-only` · Availability: `runtime-dependent` · Telemetry: `shell.help`

#### `aether agent [task]`

run the coding agent or open its REPL

Permission: `local-write` · Availability: `runtime-dependent` · Telemetry: `shell.agent` · Aliases: `aether code` · Requires: `aether.hosted-or-local`

#### `aether chat [prompt]`

start chat or send one prompt

Permission: `network` · Availability: `runtime-dependent` · Telemetry: `shell.chat` · Requires: `aether.hosted`

#### `aether resume [session-id|export [id] --out <file>]`

replay a local session, or export it as a portable handoff

Permission: `local-write` · Availability: `runtime-dependent` · Telemetry: `shell.resume`

#### `aether run <neo|kronus> <task>`

stream an orchestrator run

Permission: `network` · Availability: `runtime-dependent` · Telemetry: `shell.run` · Requires: `aether.hosted`

#### `aether models [use <id>]`

list models or set the default

Permission: `read-only` · Availability: `runtime-dependent` · Telemetry: `shell.models` · Requires: `aether.hosted`

#### `aether agents`

list available orchestrators

Permission: `read-only` · Availability: `runtime-dependent` · Telemetry: `shell.agents` · Requires: `aether.hosted`

#### `aether exec [--exec-driver ollama|cloud|selftest] [flags] "task"`

run the packaged coding agent over versioned JSONL

Permission: `local-write` · Availability: `runtime-dependent` · Telemetry: `shell.exec` · Requires: `aether.hosted`, `aether.local-child`, `aether.headless.v1`, `aether.headless.v2`

Command flags:

- `--permission <value>`
- `--allow-tool <value>…`
- `--capability-pack <value>…`
- `--timeout-ms <value>`
- `--max-uvt <value>`
- `--exec-driver <value>`
- `--exec-protocol <value>`
- `--agent-definition <value>`
- `--authority-ttl-ms <value>`

#### `aether setup --local`

diagnose bounded local Ollama setup without changing configuration

Permission: `read-only` · Availability: `runtime-dependent` · Telemetry: `shell.setup` · Requires: `ollama.local`

#### `aether local doctor|models|use <model>|pull <model>`

diagnose and explicitly manage the local Ollama runtime

Permission: `local-write` · Availability: `runtime-dependent` · Telemetry: `shell.local` · Requires: `ollama.local`

#### `aether preview start|open|logs|status|stop`

manage an explicitly declared loopback development preview

Permission: `local-write` · Availability: `runtime-dependent` · Telemetry: `shell.preview` · Requires: `aether.local-preview`

Command flags:

- `--command <value>`
- `--arg <value>…`
- `--ready-url <value>`
- `--preview-cwd <value>`
- `--preview-timeout-ms <value>`
- `--no-open`

#### `aether sessions [inspect|continue|export|archive|clean] [id]`

browse, inspect and continue past project sessions

Permission: `local-write` · Availability: `runtime-dependent` · Telemetry: `shell.sessions`

Command flags:

- `--undo`
- `--no-select`

#### `aether review [stage|unstage|revert|commit|diff|verify]`

review changes, pick files or hunks, commit

Permission: `local-write` · Availability: `runtime-dependent` · Telemetry: `shell.review`

Command flags:

- `--files <value>`
- `--hunks <value>`
- `-m, --message <value>`
- `--approve <value>`
- `--title <value>`
- `--body <value>`
- `--base <value>`

#### `aether ship [--title t] [--base b]`

publish the head branch and open a pull request

Permission: `destructive` · Availability: `runtime-dependent` · Telemetry: `shell.ship`

Command flags:

- `--files <value>`
- `--hunks <value>`
- `-m, --message <value>`
- `--approve <value>`
- `--title <value>`
- `--body <value>`
- `--base <value>`

### Account

#### `aether auth <login|status|token|refresh|logout>`

manage authentication

Permission: `account` · Availability: `runtime-dependent` · Telemetry: `shell.auth`

#### `aether github <connect|status|disconnect>`

manage the GitHub connection

Permission: `account` · Availability: `runtime-dependent` · Telemetry: `shell.github`

### Knowledge

#### `aether vault <command>`

search and manage semantic memory

Permission: `network` · Availability: `runtime-dependent` · Telemetry: `shell.vault` · Requires: `aether.hosted`

#### `aether workflow <command>`

create and manage workflows

Permission: `network` · Availability: `runtime-dependent` · Telemetry: `shell.workflow` · Requires: `aether.hosted`

#### `aether memory [status|inspect|forget|prune]`

inspect and manage scoped memory

Permission: `local-write` · Availability: `runtime-dependent` · Telemetry: `shell.memory`

#### `aether skills <subcommand>`

inspect, trust, and manage agent skills

Permission: `local-write` · Availability: `runtime-dependent` · Telemetry: `shell.skills`

#### `aether capabilities [--available]`

show the capability contract and runtime availability

Permission: `read-only` · Availability: `runtime-dependent` · Telemetry: `shell.capabilities`

### Media

#### `aether image <prompt>`

generate an image

Permission: `network` · Availability: `runtime-dependent` · Telemetry: `shell.image` · Aliases: `aether img` · Requires: `aether.hosted`

#### `aether video <prompt>`

generate a video

Permission: `network` · Availability: `runtime-dependent` · Telemetry: `shell.video` · Aliases: `aether vid` · Requires: `aether.hosted`

#### `aether output [open <n>]`

manage generated media

Permission: `local-write` · Availability: `runtime-dependent` · Telemetry: `shell.output` · Aliases: `aether out`

### System

#### `aether audit [limit]`

show chain\-of\-custody events

Permission: `read-only` · Availability: `runtime-dependent` · Telemetry: `shell.audit`

#### `aether receipt <order-id>`

export an audit proof package

Permission: `network` · Availability: `runtime-dependent` · Telemetry: `shell.receipt` · Requires: `aether.hosted`

#### `aether support-bundle`

export a redacted diagnostic support bundle

Permission: `local-write` · Availability: `runtime-dependent` · Telemetry: `shell.support-bundle`

#### `aether mcp [list|doctor|repair]`

manage and diagnose MCP servers

Permission: `network` · Availability: `runtime-dependent` · Telemetry: `shell.mcp`

#### `aether config [show|get|set]`

inspect or change configuration

Permission: `local-write` · Availability: `runtime-dependent` · Telemetry: `shell.config`

#### `aether doctor [--live|--fix] [--deep] [--only <id>]`

run structured runtime diagnostics

Permission: `network` · Availability: `runtime-dependent` · Telemetry: `shell.doctor`

Command flags:

- `--deep`
- `--live`
- `--fix`
- `--dry-run`
- `--no-ui`
- `--only <value>…`

## Interactive slash commands

### Session

#### `/help [command]`

this help, or detail for one command

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.help`

#### `/models`

interactive model picker

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.models` · Requires: `aether.catalogue`

#### `/model <n|id>`

switch model \(no arg → picker\)

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.model` · Requires: `aether.catalogue`

#### `/agent <n|id>`

switch orchestrator \(or picker\)

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.agent` · Requires: `aether.catalogue`

#### `/agents`

active agent sessions \+ UVT

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.agents` · Requires: `aether.catalogue`

#### `/tier`

plan tier \+ default model

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.tier` · Requires: `aether.catalogue`

#### `/effort [tier|1-6]`

effort dial \(LOW to CODEPRO\), drives aether code

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.effort`

#### `/audit [n]`

recent audit trail

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.audit`

#### `/doctor [deep]`

structured runtime diagnostics

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.doctor`

#### `/preview start|open|logs|status|stop`

manage the declared loopback development preview

Permission: `local-write` · Availability: `runtime-dependent` · Telemetry: `slash.preview` · Requires: `aether.local-preview`

#### `/clear`

clear screen

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.clear`

#### `/exit`

leave the REPL

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.exit` · Aliases: `/quit`

#### `/mcp [list|doctor|repair]`

manage and diagnose MCP servers

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.mcp`

### Agent Modes

#### `/autonomous-execution <task>`

execute without asking

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.autonomous-execution`

#### `/subagent-driven-execution <task>`

decompose \+ delegate

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.subagent-driven-execution`

#### `/self-review`

review your own recent work

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.self-review`

#### `/recon <topic>`

deep reconnaissance

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.recon`

#### `/plan <topic>`

write implementation plan

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.plan`

#### `/research <topic>`

research\-gather\-summarize

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.research`

#### `/project-review`

ask the brain for a prose project review \(was /review\)

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.project-review`

#### `/code-review`

sweep: clean up \+ simplify

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.code-review`

#### `/writing-skills`

author reusable skills

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.writing-skills`

#### `/writing-plans <topic>`

write plan to \.hermes/plans/

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.writing-plans`

### Steering

#### `/queue <task>`

queue a task \(runs when current finishes\)

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.queue`

#### `/steer <guidance>`

mid\-task steering for the next turn

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.steer`

#### `/btw <note>`

contextual side note \(accumulates\)

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.btw`

### Context & Limits

#### `/pin <path> [reason]`

force file into persistent context \(pin list\)

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.pin`

#### `/drop <path>`

evict file from context

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.drop`

#### `/snapshot [resume <id>]`

save session state / reload a snapshot

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.snapshot`

#### `/limit <uvt>`

cap UVT spend for this session

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.limit`

#### `/audit-receipt [n]`

verified log of tool calls \+ UVT

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.audit-receipt`

#### `/rollback`

discard uncommitted changes to tracked files

Permission: `destructive` · Availability: `runtime-dependent` · Telemetry: `slash.rollback`

#### `/logs-view`

interactive session log browser

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.logs-view` · Aliases: `/logs`

### Goals & Workflows

#### `/goal <desc|view|start|pause|resume|cancel|complete|note>`

create/manage a goal \(agent plans phases\)

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.goal`

#### `/goals [id]`

list saved goals / view one

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.goals`

#### `/memory [status|inspect|forget|prune]`

inspect and manage scoped memory

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.memory`

#### `/workflow`

workflow status

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.workflow`

#### `/workflow-templates`

list workflow templates

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.workflow-templates`

#### `/workflow-template <n>`

load a workflow template

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.workflow-template`

### Vault

#### `/vault`

vault status

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.vault`

#### `/vault-context`

load vault context into the session

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.vault-context`

#### `/vault-search <q>`

search notes

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.vault-search`

#### `/vault-recent [n]`

recent notes

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.vault-recent`

#### `/vault-project <name>`

project notes

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.vault-project`

#### `/vault-tag <tag>`

notes by tag

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.vault-tag`

#### `/vault-tree`

vault folder tree

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.vault-tree`

### Orchestra

#### `/delegate <model> <task>`

delegate a sub\-task to a worker model

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.delegate`

#### `/tree`

live orchestration hierarchy

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.tree`

#### `/broadcast "<msg>"`

inject a directive to all sub\-agents

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.broadcast`

#### `/gather <id|all>`

merge completed work to staging

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.gather`

### UVT Tools

#### `/scaffold <type> <name>`

generate boilerplate \(component\|route\|module\)

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.scaffold`

#### `/port <file> <lang>`

translate code to another language

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.port`

#### `/test-drive "<target>"`

auto\-test: generate, run, fix, repeat

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.test-drive`

#### `/bench <target>`

profile & optimize code

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.bench`

#### `/purge`

flush transient context & temp files

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.purge`

#### `/stage-diff`

unified diff \+ commit message

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.stage-diff`

#### `/review [stage|unstage|revert|commit|diff|verify]`

review changes, pick files or hunks, commit

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.review`

#### `/ship [--title t] [--base b]`

publish the head branch and open a pull request

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.ship`

#### `/revert <file>`

discard uncommitted changes to one file

Permission: `destructive` · Availability: `runtime-dependent` · Telemetry: `slash.revert`

### Media

#### `/photogen <prompt> [--model --aspect]`

generate images

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.photogen`

#### `/frame <prompt>`

generate a single styled frame

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.frame`

#### `/re-frame <prompt>`

re\-run the last image with a new prompt

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.re-frame`

#### `/videogen <prompt> [--model --duration]`

generate video

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.videogen`

#### `/sequence <prompt>`

cinematic multi\-shot video

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.sequence`

#### `/animate <prompt>`

animate the last image

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.animate`

#### `/re-cut <prompt>`

re\-edit the last video

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.re-cut`

#### `/output [open|clean|list]`

manage generated media files

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.output`

#### `/storyboard <title>`

multi\-scene storyboard pipeline

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.storyboard`

### HUD

#### `/add <element>`

add a HUD overlay \(context\-bar, timer, tools, help, health, status\)

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.add`

#### `/hud remove|list|clear`

manage HUD overlay elements

Permission: `unknown` · Availability: `runtime-dependent` · Telemetry: `slash.hud`
