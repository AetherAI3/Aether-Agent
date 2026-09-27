# aether-agent

The pip/pipx front door to **[Aether Agent](https://github.com/AetherAI3/aether-agent) by Aether
AI** — an open-source terminal coding agent that edits your repository, runs your chosen checks,
and reports verified results, through hosted models or local Ollama.

```bash
pipx install aether-agent
aether-agent auth login
aether-agent code --test-cmd "npm test" "fix the failing test"
```

Aether Agent itself is a Node program, published to npm as
[`aether-agents`](https://www.npmjs.com/package/aether-agents). This package installs and runs it,
so a Python-first machine can get the agent with the installer it already uses. It is the same
agent and the same commands — not a reimplementation, and not a second interface to keep in sync.

Requires **Node 24+** on PATH (the agent's own requirement) and Python 3.10+.

## What it actually does

- **Forwards everything.** Every argument that is not in the `self` namespace goes to the real
  `aether` CLI unchanged, and its exit code becomes this process's exit code. `aether-agent code`,
  `aether-agent doctor`, `aether-agent sessions`, and the slash commands inside the REPL all behave
  exactly as documented in [`COMMANDS.md`](https://github.com/AetherAI3/aether-agent/blob/main/COMMANDS.md).
- **Installs the same agent the npm route does.** By default it fetches the npm `latest`
  dist-tag, so `pipx install aether-agent` and `npm install -g aether-agents@latest` land on the
  same agent. Pin a specific one with `self install --npm-version 0.3.1` or
  `AETHER_AGENT_NPM_VERSION`. Installation goes into a private prefix under your own data
  directory, with `--ignore-scripts`, so it needs no administrator rights and runs no package
  lifecycle scripts.
- **Defers to an agent you already have.** If `aether` is already on PATH, that is the one it runs.
  It never installs a second copy behind your back.
- **Adds no dependencies.** It shells out to `node` and `npm`, which the agent requires anyway.

## The `self` namespace

Launcher-owned commands are namespaced so they can never shadow an agent command — `aether doctor`
is the agent's, `aether-agent self doctor` is the launcher's.

```bash
aether-agent self install              # install or update the agent CLI
aether-agent self install --npm-version 0.3.1
aether-agent self doctor               # node, npm, install root, and which aether would run
aether-agent self path                 # print that binary's path
aether-agent self uninstall            # remove only what this launcher installed
```

`self install` is optional: the first forwarded command installs the agent if it is missing. Run
it again later to update to the current `latest`.

This package's own version tracks the repository's `main`, so the launcher and the agent release
together; it is not the version installed. `aether-agent self doctor` prints both.

## Environment

| Variable | Effect |
| --- | --- |
| `AETHER_AGENT_HOME` | Where the launcher keeps its private npm prefix. Defaults to `$XDG_DATA_HOME/aether-agent` (`%LOCALAPPDATA%\aether-agent` on Windows). |
| `AETHER_AGENT_NPM_VERSION` | Pin the version or dist-tag of `aether-agents` to install, instead of `latest`. Validated before use. |

The agent's own variables — `AETHER_API_KEY`, `OLLAMA_HOST`, and the rest — are read by the agent,
not by this launcher, and are documented in
[`COMMANDS.md`](https://github.com/AetherAI3/aether-agent/blob/main/COMMANDS.md#environment-variables).

## Which install should I use?

Use whichever matches how you manage tools. They install the same agent:

```bash
pipx install aether-agent                              # this package
npm install -g aether-agents@latest --ignore-scripts   # npm directly
```

`pipx` keeps the launcher in its own environment; the agent still lands in the launcher's prefix
rather than in your Python environment.

## Where the authority stays

Repository tools, permission decisions, session records, and verification run on your machine
under the agent, exactly as they do for the npm install — this launcher only starts it. Hosted runs
send the task and context you provide to the Aether API; the local Ollama route needs no Aether
account. See the [security policy](https://github.com/AetherAI3/aether-agent/blob/main/SECURITY.md).

Apache-2.0 · [Aether AI](https://github.com/AetherAI3) · [`NOTICE.md`](NOTICE.md)
