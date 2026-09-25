<div align="center">

<img width="620" alt="Aether" src="assets/aether-agent-hero.png" />

# Aether Agent

**Coding and account agents in your terminal.**

It reads your repository, makes the change, runs the checks you name,
and shows you the exit code. Hosted models or your own local Ollama.
The 0.4.0 source candidate also brings your account agents and Online chats
into the terminal, with guided ATS setup.

[![CI](https://github.com/AetherAI3/aether-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/AetherAI3/aether-agent/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/aether-agents?label=npm)](https://www.npmjs.com/package/aether-agents)
[![PyPI](https://img.shields.io/pypi/v/aether-agent?label=PyPI&color=3775a9)](https://pypi.org/project/aether-agent/)
[![Node 24+](https://img.shields.io/badge/node-24%2B-14b8a6)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-Apache--2.0-06b6d4)](LICENSE)

[Quickstart](#quickstart) · [Models](#pick-where-the-model-runs) · [Commands](#commands) · [Aether Code](#aether-code-on-the-web) · [Safety](#what-stays-on-your-machine) · [Patch notes](#versions-and-patch-notes)

<br />

<img width="820" alt="Aether Agent starting up, then the slash-command help and the model picker" src="assets/aether-agent-demo.gif" />

<sub>Install → launch → `/help` → `/models`. That's the whole first run.</sub>

</div>

<!-- SOURCE-0.3-WORKFLOWS:START -->

> **Requires 0.3.2 or newer.** Check what you have with `aether --version`.
>
> The live npm badge below resolves the currently published `latest`. Until a
> verified `v0.4.0` tag and registry publication exist, the account-agent and
> ATS sections below describe the 0.4.0 source candidate on `main`; source text
> alone is not publication evidence.

## Quickstart

Run these from inside the repository you want Aether to work on:

```bash
npm install -g aether-agents@latest --ignore-scripts
aether auth login
aether
```

That last line is the whole idea: **one task, one way to prove it worked.**
Aether makes the edit, your machine runs `npm test`, and the real exit code
decides whether the run is verified. No exit code, no claim.

Prefer Python? `pipx install aether-agent` installs the same CLI and forwards
every command to it, so `aether-agent code "..."` and `aether code "..."` do the
same work. See [`packages/pypi-cli`](packages/pypi-cli/README.md).

## Account agents and ATS — 0.4.0 source candidate

ATS is the trading adapter for account agents.

### What works now — and what does not

Aether Agent 0.4.0 has a real, account-bound ATS setup and observation path. It
can create the managed-agent draft, verify local memory, install and compile the
reviewed Nano starter strategies, save data-provider configuration, and open a
bounded browser observer. Those capabilities are useful today, but they are not
broker execution.

| Stage | 0.4.0 status | Release boundary |
|---|---|---|
| Account agent, consent and local ownership | **Available in the source candidate** | Identity-bound setup; consent never grants trading authority. |
| Memory, strategy scan/compile and data configuration | **Available in the source candidate** | Preparation and diagnostics only; no order can result. |
| Browser observation | **Available in the source candidate** | Read-only, freshness-checked images; no model-controlled browser action. |
| ATS runtime and market-data session | **Verification framework on `main`; production wiring unavailable** | The signed runtime source, pinned trust anchor, launcher and authenticated probe are not configured. Strategy compilation and a research data setting do not prove executable market data. |
| ATS simulated paper orders | **Not connected to the managed agent** | ATSv2 has a separate local paper journal; the Agent has no authenticated order path to it. A simulated fill is not a trading-site fill. |
| Agent Browser paper orders | **Contract only; no order tool registered** | The browser order wire is validated in Agent and ATSv2, but an authenticated viewer, qualified site adapter, browser ticket port, approval and order-history reconciliation are still required. |
| Supervised live orders | **Not shipped** | Requires a separately verified live account and arm, scoped limits, human approval, reliable stop/cancel and an attended reconciled canary. |
| Autonomous live trading | **Not shipped** | No setup choice, mode preference, strategy, chat message or policy receipt enables it. |

The merged [Agent browser order contract](https://github.com/AetherAI3/Aether-Agent/pull/164)
and [ATSv2 mirror](https://github.com/AetherAI3/ATSv2/pull/444) agree on typed
calls and refusal results. They register no trading tool and cannot submit an
order. `/ats doctor` reports paper activation prerequisites separately from
ATS simulated paper, provider sandbox and live order readiness; the latter
three are not ready in this build. The first intended browser execution proof
is an order in a user-signed-in **paper** account through the same Agent Browser
session, confirmed against that site's order history. Live capital has a
separate gate. See the [Agent Browser execution plan](docs/specs/2026-09-23-ats-agent-browser-orders.md)
and [operator packet](docs/releases/OPERATOR-PACKET-v0.4.0.md).

After signing in, use `aether agent list` to see the same managed agents as
Aether Online. `aether agent chat` opens the one-column picker; select an agent
to read and send messages in its existing Online conversation.

```bash
aether agent list
aether agent create ATS Atlas
aether agent configure <agent-id> purpose "Review my trading strategies"
aether agent chat <agent-id>
```

ATS setup asks for a local memory folder, a memory size, a strategy folder and
data provider/symbol settings. Local resources belong to the verified account
and agent; rotating a token preserves that identity. Switching accounts while
chat is open closes its local resources and requires reopening the conversation.
Before the first setup for a policy version, the terminal presents the
[ATS Autonomous Trading Acceptable Use, Risk and Data Policy](ATS_ACCEPTABLE_USE_POLICY.md):
choose `1` to accept or `2` to reject. Rejection exits before creating an agent
or configuring storage, strategies, datafeeds, browsers, plugins or MCP. The
local, pseudonymous consent receipt records the policy digest but grants no
broker or trading authority.
The packaged adapters verify storage and report native Nano compiler results.
Inside ATS chat, type /ats status, /ats strategies or /ats data to inspect the
workspace. Shift-Tab cycles the
local ATS permission preference. Model availability, projects, APR memory and
UVT admission remain enforced by Cloud.

ATS chat opens the configured browser view after memory verification. For any
managed agent, `/browser setup [URL]` configures the connection and `/browser open`
opens it. Use `/browser status`, `/browser refresh`, `/browser stop` or
`/browser retry` to manage the view; `/ats browser` is an alias. Status updates
preserve your draft and cursor. LIVE requires a fresh validated screenshot;
an open window alone is not proof of observation. Retry starts a new bounded
session after releasing the old one. Cleanup receipts survive restarts. If a
creation response was lost, an idle runtime cannot prove that request finished;
the terminal retains the receipt and blocks replacement until cleanup is known.

The local API defaults to `http://127.0.0.1:8092`. Run
`npx aether-browser@0.2.2 doctor` to check the separately installed runtime.
Remote APIs use HTTPS and environment credentials. The native noVNC viewer
stays on the browser host and must never be tunneled or published.
The bundled read-only visual skill exposes verified images for an admitted
host; Cloud DM does not yet receive those images or control this browser.

These commands require the matching Cloud terminal adapter. ATS setup also
requires its Python engine and a separately running Agent Browser runtime;
missing services are reported explicitly. This candidate prepares and observes
an ATS workspace. It does not yet provide model-controlled broker actions or
automatic live orders: it does not start an execution engine, connect a broker,
or submit or reconcile orders. See the
[candidate packet](docs/releases/OPERATOR-PACKET-v0.4.0.md) for the qualification
still required before publication.

## Pick where the model runs

Both routes keep your files, your permissions, and your verification on your
machine. The only thing that moves is where the model thinks.

### Hosted — sign in and go

```bash
aether auth login
aether models
```

Your task and the context you hand over go to the Aether API. Repository tools
and checks still run in your checkout. If the service can't honour that
local-authority contract, the run stops rather than quietly moving your tools
to a server.

### Local — no account needed

Install [Ollama](https://ollama.com/), start it, then:

```bash
aether setup --local
aether local pull qwen2.5-coder:7b --yes
aether local use qwen2.5-coder:7b --yes
aether agent --local --test-cmd "npm test" "fix the failing test"
```

Once Ollama and the model are downloaded, inference can stay on the machine.
The default endpoint is loopback; if `OLLAMA_HOST` points elsewhere, prompts go
there instead. Network tools stay separate and permissioned either way.

## Model catalogue

What your account can actually reach is whatever `aether models` prints while
you are signed in. The snapshot below is a dated reference, published so the
list is readable without signing in first.

<!-- MODEL-CATALOGUE:START -->
A dated, sanitized offline fallback snapshot is available as [HTML](docs/model-catalogue/index.html), [JSON](docs/model-catalogue/catalogue.json), and [Markdown](docs/generated/model-catalogue.md). It was generated at `2026-09-22T01:47:56.169Z` from Cloud public projection `model-catalogue-v1` with verified digest `sha256:f5f516625932d8932bfca221aa5dbf3eb1d7b415eba8dabe298da24b984c64f7`. Listed availability is not an account entitlement; use `aether models` while signed in.
<!-- MODEL-CATALOGUE:END -->

Local Ollama is independent of all of it — you get whatever you have installed
at your configured endpoint.

## What you get

- **One terminal workflow.** Task, diff, tests, and review in the same place you
  already work.
- **Proof, not claims.** `--test-cmd` ties "done" to a command and an exit code.
  Change the repo afterwards and that evidence goes stale on purpose.
- **Repo-aware tools.** File, search, shell, Git, session, and review tools
  scoped to the workspace you chose — not your whole machine.
- **Work you can pick back up.** Sessions are project-scoped: list them, resume
  one, or hand it off as a redacted bundle.
- **MCP built in.** Inspect, diagnose, and repair configured MCP servers without
  stepping around tool permissions.

## Commands

| Command | What it does |
|---|---|
| `aether auth login` | Sign in for hosted models. |
| `aether agent [task]` | Run the coding agent, or open its REPL. |
| `aether agent list\|create\|configure\|chat` | List, create and configure account agents, or open their shared Online DM conversation (0.4.0 source candidate). |
| `aether agent --local [task]` | Same, through your Ollama endpoint. |
| `aether models` | Show the hosted models your account can see. |
| `aether local doctor\|models\|use\|pull` | Diagnose and manage local Ollama. |
| `aether sessions` | Inspect and continue project-scoped sessions. |
| `aether review` | See the changes and the current verification evidence. |
| `aether mcp` | List, diagnose, or repair MCP servers. |
| `aether doctor` | Check the environment. |
| `aether pc map\|doctor\|verify-browser\|open` | Inspect PC capabilities and local performance; verify a browser or open a named app after fresh interactive approval. |
| `aether ship` | Preview and approve a branch and pull request. |

`aether help <command>` has the details, or read the generated
[command reference](docs/generated/commands.md) for every flag, slash command,
environment variable, and exit code.

### PC capability preview

`aether pc map` shows which PC actions this source build can actually perform.
`aether pc doctor claude`, `chatgpt`, `aether-cloud`, or `ollama` samples local
CPU, memory, disk, network-interface, and process health. Add `--probe-network`
to contact only the named target and measure three reachability requests. This
does not measure model inference speed. `aether pc verify-browser` opens a local
readiness page and verifies that a browser rendered it through a one-use loopback
callback. `aether pc open claude` opens a fixed
site after a fresh terminal approval; `--yes` cannot approve that action.

Desktop capture/input, browser automation, system changes, and general PC
command execution remain unavailable until their scoped driver and OS sandbox
are implemented and tested. The existing coding `run_shell` tool is separate.
See [PC capability plane](docs/pc-capability-plane.md) for the boundary and
follow-on implementation gates.

<!-- SOURCE-0.3-WORKFLOWS:END -->

## Aether Code on the web

<div align="center">
<img width="300" alt="Aether Code" src="assets/aether-code.png" />
</div>

[**Aether Code**](https://app.aethersystems.net/) is the browser surface for the
same Aether account — one of three apps on the portal, alongside Web Chat and
Design Lab. Sign in once, then pick where you want to work that day.

Aether Code and Aether Agent are deliberately separate products. The CLI is
standalone and open source: on the local route it needs no Aether account at
all. Coding workspace sessions stay on their host; the managed-agent workflow
above shares account agents and their Online DM conversations.

### Remote viewing status in the 0.4.0 source candidate

Remote viewing — `aether rc` — is the observer-only bridge between a terminal
run and the browser. Its host foundation and local status/exposure controls are
on `main`; they remain outside the published 0.3.x line. A fully qualified live
Cloud viewer journey is still unproven, and the old draft
[PR #108](https://github.com/AetherAI3/aether-agent/pull/108) is not release
evidence for current `main`. The source-candidate contract is:

- Starting a session prints a link and a QR code.
- Your phone or browser **watches** the run. It never gets tool authority.
- One command shows what is exposed; another revokes it.
- Outbound TLS only — no inbound listener on your machine.
- Events are allowlisted and redacted: no environment variables, credentials,
  cookies, private memory, raw file contents, absolute paths, or unredacted
  shell history.
- If the broker drops, your local session carries on regardless.

Those are release requirements, not goals — which is why the work is still open
rather than shipped.

## What stays on your machine

- **Files stay in the workspace.** File tools are confined to the workspace you
  selected, and writes, shell, Git, network, and publishing each pass a
  host-side permission gate.
- **Hosted runs send only what you hand over.** Your task and context go to the
  Aether API; repository tools and checks run in your checkout, and the
  local-authority route fails closed rather than quietly degrading.
- **Local runs stay local.** Ollama prompts go to your configured endpoint,
  which is loopback by default.
- **Secrets live outside the repository.** So do session records. Portable
  handoffs drop transcripts, file contents, shell commands, and absolute paths —
  still give one a read before you share it.
- **Publishing is never implicit.** `aether ship` prints its branch, commit,
  destination, and pull-request plan before it acts, and `--yes` on its own is
  not publication authority.

[SECURITY.md](SECURITY.md) has the supported versions, the full boundary, and
the private path for reporting a vulnerability.

## Versions and patch notes

The repository and the published package are versioned independently.

| Install | Version | What it is |
|---|---:|---|
| npm `latest` | [![npm latest](https://img.shields.io/npm/v/aether-agents?label=&color=14b8a6)](https://www.npmjs.com/package/aether-agents) | The published package; the badge resolves the live dist-tag. |
| PyPI `aether-agent` | [![PyPI latest](https://img.shields.io/pypi/v/aether-agent?label=&color=3775a9)](https://pypi.org/project/aether-agent/) | A launcher that installs and runs the npm CLI. It follows npm `latest` unless you pin one. |
| `main` source build | **0.4.0** | Source candidate for shared agents and ATS setup; publication and live-service qualification are recorded separately in the [operator packet](docs/releases/OPERATOR-PACKET-v0.4.0.md). |

- **[Release notes](RELEASE_NOTES.md)** — one entry per release, in plain language.
- **[Release log](docs/releases/README.md)** — dated candidate, publication, and
  documentation events, plus operator packets that freeze prerelease
  qualification and link the authoritative tag and registry evidence.
- **[Releases and tags](https://github.com/AetherAI3/aether-agent/releases)** —
  every published version.

## Build from source

Node.js 24 or newer:

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

The runtime bundles the reviewed `aether-ats-skills` source package with exact
`aether-browser` and `aether-context` dependencies. TypeScript and Node types
remain development-only. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull
request, and see the [architecture and protocol docs](docs/) or
[production operations](docs/PRODUCTION_OPERATIONS.md) if you are going deeper.

## Help and license

Bugs and feature requests go to
[GitHub issues](https://github.com/AetherAI3/aether-agent/issues). Security
reports use the private path in [SECURITY.md](SECURITY.md).

The Agent and bundled ATS adapter code are Apache-2.0. The paid ATS engine is a
separate prerequisite. The license covers the code, not the
Aether name or the hosted service ([LICENSE](LICENSE) · [NOTICE.md](NOTICE.md)).
