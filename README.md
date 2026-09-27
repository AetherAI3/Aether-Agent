<div align="center">

# Aether Agent

**Aether Agent is an open-source terminal coding agent that edits your repository, runs your chosen checks, and reports verified results through hosted models or local Ollama.**

<img width="847" alt="Aether Agent cyan-to-violet wordmark on a dark textured background" src="assets/aether-agent-hero.png" />

[![CI](https://github.com/AetherAI3/aether-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/AetherAI3/aether-agent/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/aether-agents?label=npm)](https://www.npmjs.com/package/aether-agents)
[![PyPI](https://img.shields.io/pypi/v/aether-agent?label=PyPI&color=3775a9)](https://pypi.org/project/aether-agent/)
[![Node 24+](https://img.shields.io/badge/node-24%2B-14b8a6)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-Apache--2.0-06b6d4)](LICENSE)

[Quickstart](#quickstart) · [Choose a model route](#choose-a-model-route) · [Why Aether](#why-aether-agent) · [Commands](#core-commands) · [Security](#security-and-local-authority) · [Docs](#documentation-and-support)

</div>

<!-- SOURCE-0.3-WORKFLOWS:START -->

> **Requires 0.3.2 or newer.** Check the installed CLI with `aether --version`.

## Quickstart

From the repository you want Aether to work on:

```bash
npm install -g aether-agents@latest --ignore-scripts
aether auth login
aether agent --test-cmd "npm test" "fix the failing test"
```

Prefer Python tooling? `pipx install aether-agent` installs the same CLI and forwards
every command to it, so `aether-agent code "..."` and `aether code "..."` do the same
work. See [`packages/pypi-cli`](packages/pypi-cli/README.md).

The third command gives Aether one task and one verification command. The local
host runs `npm test`; its real exit code determines whether the result is verified.

## Choose a model route

Both routes keep workspace tools, permission decisions, session records, and
verification on the CLI host. The difference is where model inference runs.

### Hosted Aether models

Sign in, then inspect the models available to your account:

```bash
aether auth login
aether models
```

Hosted runs send the task and context you provide to the Aether API. Repository
tools and verification still execute in your checkout. Hosted coding is account-
and capability-dependent; if the service cannot provide the required local-
authority protocol, the CLI refuses the run instead of silently moving tool
execution to the server.

### Local Ollama

Install [Ollama](https://ollama.com/), start it, then prepare and select a model:

```bash
aether setup --local
aether local pull qwen2.5-coder:7b --yes
aether local use qwen2.5-coder:7b --yes
aether agent --local --test-cmd "npm test" "fix the failing test"
```

This route requires no Aether account. With Ollama on the default
`http://localhost:11434` endpoint, inference can stay on the machine after Ollama
and the model are downloaded. If `OLLAMA_HOST` points elsewhere, prompts go to
that configured endpoint. Network-capable tools remain separate, permissioned
actions.

## Why Aether Agent

- **Terminal-first coding.** Start from the repository and keep the task, diff,
  tests, and review in one command-line workflow.
- **Local and offline-capable inference.** Use a local Ollama endpoint without an
  Aether account; after installation and model download, model inference does not
  require the hosted Aether service.
- **Hosted frontier-model access.** Use the live model set exposed to your Aether
  account when you want hosted inference.
- **Repository-aware tools.** File, search, shell, Git, session, and review tools
  operate against the selected workspace rather than an unbounded machine view.
- **Verification loops.** Supply `--test-cmd` so completion is tied to a real
  command and exit code; later repository changes make that evidence stale.
- **MCP support.** Inspect and diagnose configured MCP servers from the same CLI,
  without bypassing tool permissions.
- **Operator-controlled execution.** Writes, shell commands, network access, Git
  operations, and publication stay behind host-side authority checks.

## Model stack

The dated public snapshot marks Aether Neo, DeepSeek V4, GPT-5.4/5.5/5.6, and
Claude 4.5/4.8/5 text entries as available at the catalogue level. That is not an
account entitlement: **`aether models` is the authoritative live result for the
signed-in account.** Kimi K2.6/K3 and Gemma 4 are catalogued but marked
**unavailable** in the current snapshot, so they are not presented here as usable.

Local Ollama availability is independent of that hosted catalogue and depends on
the models installed at the configured Ollama endpoint.

<!-- MODEL-CATALOGUE:START -->
A dated, sanitized offline fallback snapshot is available as [HTML](docs/model-catalogue/index.html), [JSON](docs/model-catalogue/catalogue.json), and [Markdown](docs/generated/model-catalogue.md). It was generated at `2026-08-23T00:00:00.000Z` from Cloud public projection `model-catalogue-v1` with verified digest `sha256:80ba3ba1144d301e2cca407ceced74cb2b371f1da6e3982b87305ff12a3d4712`. Listed availability is not an account entitlement; use `aether models` while signed in.
<!-- MODEL-CATALOGUE:END -->

## Core commands

| Command | Purpose |
|---|---|
| `aether auth login` | Sign in for hosted model access. |
| `aether agent [task]` | Run the coding agent or open its REPL. |
| `aether agent --local [task]` | Run through the configured Ollama endpoint. |
| `aether models` | Show the hosted models visible to the signed-in account. |
| `aether local doctor\|models\|use\|pull` | Diagnose and manage local Ollama. |
| `aether sessions` | Inspect and continue project-scoped sessions. |
| `aether review` | Inspect changes and current verification evidence. |
| `aether mcp` | List, diagnose, or repair configured MCP servers. |
| `aether doctor` | Diagnose the configured environment. |
| `aether ship` | Preview and approve branch and pull-request publication. |

Use `aether help <command>` or the generated
[command reference](docs/generated/commands.md) for flags, slash commands,
environment variables, and exit codes.

<!-- SOURCE-0.3-WORKFLOWS:END -->

## Security and local authority

- File tools are confined to the selected workspace. Write, shell, Git, network,
  and publishing actions pass through host-side permission gates.
- Hosted tasks and supplied context are sent to the configured Aether API, while
  repository tools and checks run locally. The local-authority coding route fails
  closed when the server cannot honor that contract.
- Ollama prompts go to the configured Ollama endpoint. The default is loopback;
  offline use also requires avoiding separately permissioned network tools.
- Credentials and session records live outside the repository. Portable handoffs
  omit transcripts, file contents, shell commands, and absolute paths, but should
  still be reviewed before sharing.
- `aether ship` prints its branch, commit, destination, and pull-request plan
  before acting. `--yes` alone does not grant publication authority.

Read [SECURITY.md](SECURITY.md) for supported versions, the security boundary,
and private vulnerability reporting.

## Documentation and support

- [Generated command reference](docs/generated/commands.md) and
  [model catalogue](docs/generated/model-catalogue.md)
- [Protocol and architecture documentation](docs/) and
  [production operations](docs/PRODUCTION_OPERATIONS.md)
- [Contributing guide](CONTRIBUTING.md)
- [GitHub issues](https://github.com/AetherAI3/aether-agent/issues) for bugs and
  feature requests; use the private path in [SECURITY.md](SECURITY.md) for
  vulnerabilities
- [Apache-2.0 license](LICENSE) and [Aether name/service notice](NOTICE.md)

Other Aether web and desktop products are separate surfaces; this CLI does not
claim cross-product session continuation.

## Release and source notes

The repository and published package are versioned independently. Use the live
badge or `npm view aether-agents version` for the npm `latest` dist-tag, and
`aether --version` for the installed CLI.

| Install | Version | What it represents |
|---|---:|---|
| npm `latest` | [![npm latest](https://img.shields.io/npm/v/aether-agents?label=&color=14b8a6)](https://www.npmjs.com/package/aether-agents) | Published package; the badge resolves the live dist-tag. |
| PyPI `aether-agent` | [![PyPI latest](https://img.shields.io/pypi/v/aether-agent?label=&color=3775a9)](https://pypi.org/project/aether-agent/) | Launcher that installs and runs the npm CLI; it fetches the npm `latest` dist-tag unless you pin one. |
| `main` source build | **0.3.2** | Current repository source: the 0.3 workflow plus every 0.3.1 maintenance fix. |

The [release record](docs/releases/2026-08-22.md),
[release notes](RELEASE_NOTES.md), and
[operator packet](docs/releases/OPERATOR-PACKET-v0.3.0.md) preserve detailed
release and package evidence.

For a source build, Node.js 24 or newer is required:

```bash
git clone https://github.com/AetherAI3/aether-agent.git
cd aether-agent
npm ci --ignore-scripts
npm run build
npm link
```

## Development

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run smoke
npm run verify:production
npm run docs:check
npm run release:truth
npm pack --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. The package
has no runtime dependencies; TypeScript and Node types are development-only.

Apache-2.0 — use it, fork it, and ship it. The license covers the code, not the
Aether name or hosted service ([LICENSE](LICENSE) · [NOTICE.md](NOTICE.md)).
