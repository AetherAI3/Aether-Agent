# Contributing to Aether Agent

Aether Agent is a TypeScript CLI for Node.js 24 or newer. Keep changes focused,
fail closed at security boundaries, and avoid runtime dependencies unless the
benefit and review plan are explicit.

## Set up a development checkout

```sh
git clone https://github.com/AetherAI3/aether-agent.git
cd aether-agent
npm ci --ignore-scripts
npm run build
```

Use `npm ci --ignore-scripts`, not `npm install`, for a reproducible checkout.
The package intentionally has zero runtime dependencies.

## Repository map

```text
src/main.ts                  executable entry and top-level dispatch
src/commands/                shell/slash commands and command manifest
src/core/                    transport, auth, brains, tools, policy, diagnostics
src/ui/                      terminal rendering and interaction
src/skills/builtin/          packaged built-in skills and eval cases
scripts/                     docs, production, release-truth, and demo tooling
test/                        node:test unit, integration, CLI, and policy tests
docs/generated/              manifest/catalogue outputs; do not hand-edit
docs/model-catalogue/        verified Cloud public-projection snapshot
install.sh / install.ps1     POSIX and Windows installers
```

`src/core/client.ts` is the shared client route. Public command metadata lives
in `src/commands/command_manifest_data.ts`; executable loaders remain separate.
Regenerate derived documentation after changing the manifest.

## Local verification

Run the narrow tests for your change while developing, then run the full gates:

```sh
npm run build
npm run typecheck
npm run lint
npm test
npm run smoke
npm run docs:check
npm run verify:production
npm run release:truth
npm pack --dry-run
```

`npm run lint` is the dependency-free strict TypeScript lint gate. `npm test`
builds first, then runs the repository's unit and integration tests from
`dist/test`. The smoke harness is environment-aware: signed-in Cloud and local
Ollama checks can report skips when those services are not configured, but a
real failure must not be relabeled as a skip.

Useful installed-CLI smoke checks after `npm run build` are:

```sh
node dist/src/main.js --version
node dist/src/main.js --help
node dist/src/main.js auth status
node dist/src/main.js doctor
node dist/src/main.js doctor --live --no-ui
```

Use a temporary `AETHER_CONFIG_DIR` when testing first-run or authentication
states. Never commit a token, config directory, support bundle, or live receipt.

## Generated and public truth

- Run `npm run docs:generate` only when the command manifest or verified public
  catalogue projection changed; commit every resulting generated file.
- `npm run docs:check` must be clean. Do not hand-edit `docs/generated/**` or
  generated catalogue outputs.
- Runtime `aether models` is authoritative for account-scoped model
  availability. Catalogue refreshes must come through the canonical Cloud
  public-projection and digest verification path.
- `npm run verify:production` checks package contents, installers, workflows,
  exact-tarball installation, and public-document policy.
- `npm run release:truth` performs the public/release truth checks, including
  live registry evidence when available. An unavailable required probe is not
  a pass.

## Installer syntax checks

On macOS, Linux, or WSL:

```sh
sh -n install.sh
bash -n install.sh
```

On Windows PowerShell:

```powershell
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path .\install.ps1),
  [ref]$tokens,
  [ref]$errors
) > $null
if ($errors) { $errors; exit 1 }
```

Installers must keep npm lifecycle scripts disabled and must not recommend a
mutable-main `curl | sh` flow. Test permission, PATH, unsupported-Node, and
headless-browser failures without weakening TLS or authentication.

## Pull request expectations

- Explain the user-visible problem and why the change is scoped to it.
- Add regression coverage for success, refusal, and actionable failure output.
- Keep generated files in sync and list the exact verification commands run.
- Call out platform coverage and anything not exercised live.
- Include `npm pack --dry-run` evidence for package/runtime changes.
- Do not version-bump, tag, publish, or edit release evidence in a feature PR.
- Do not mix unrelated cleanup into the change.

## Security boundaries

Never weaken TLS enforcement, credential handling, secret redaction,
confirmation gates, sandbox/workspace confinement, tool permissions, or local
authority checks to make a test pass. Do not add internal hosts, private model
routes, tokens, keys, or real account data to source, fixtures, logs, docs, or
PR text. Security reports belong in the private process described in
[`SECURITY.md`](SECURITY.md), not a public issue.

By contributing, you agree that your contributions are licensed under
Apache-2.0.
