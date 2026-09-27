# Aether Agent v0.3.2 — one line again

**September 3, 2026**

- **The v0.3.1 fixes are on `main`.** v0.3.1 was released from a branch that was
  never merged, so `main` moved forward without its browser-launcher
  verification and browser-login recovery path — while still declaring `0.3.0`,
  a version older than the one on the registry. That line is merged, and the
  declared version leads the published one again.
- **Browser sign-in reports what actually happened.** Opening the sign-in page
  now waits for the operating system launcher to start or fail, so a machine
  with no browser says so instead of reporting a launch it only attempted.
- **No new surface.** This patch adds no command, flag, or contract of its own.

---

# Aether Agent v0.3.1 — first-run recovery

**August 28, 2026**

- **Clearer first-run recovery.** The CLI now stops before executing on an
  unsupported Node.js runtime and prints the upgrade path. Browser-based sign-in
  continues with the displayed URL and code when the system browser cannot open.
- **No feature expansion.** This is a compatibility patch over v0.3.0; it does
  not include the later device-runtime work on `main`.

---

# Aether Agent v0.3.0 — durable work, verified delivery

**Release candidate finalized August 27, 2026**

0.2.0 was never published. It was written up on August 19, and then `main` kept
moving: a skills runtime, a capability contract, a redacted support bundle, a
command-registration seam, a review-to-pull-request rail, a project session
library, and the wiring that finally puts skills inside a real run all landed on
top of the version that was already spoken for. Rather than quietly widen 0.2.0
to mean two different things, this release takes the next number and describes
everything actually on `main`.

Covers every unpublished change after `v0.1.0`, including the work described
by the never-published v0.2.0 notes and the final PR #107 product spine. The tag
is cut only from the verified merge commit on `main`; historical candidate
ranges below remain provenance for the work they actually measured.

<!-- Capability dispositions are checked independently from COMMANDS.md and the command manifest. -->
<!-- CAPABILITY-RELEASE:START -->
- `aether.catalogue` — `exempt`: an existing runtime requirement, unchanged in this release.
- `aether.hosted` — `exempt`: an existing runtime requirement, unchanged in this release.
- `aether.hosted-or-local` — `exempt`: an existing runtime requirement, unchanged in this release.
- `aether.local-child` — `announced`: the new headless driver is deliberately limited to a local brain child process.
- `aether.headless.v1` — `announced`: versioned JSONL events, controls, permission decisions, receipts, and authoritative verification.
- `aether.headless.v2` — `announced`: repository-bound checkpoints, confined reusable agent definitions, bounded acknowledged controls, and commit-bound verification.
- `aether.local-preview` — `announced`: the managed preview supervisor accepts declared commands and loopback URLs only.
- `ollama.local` — `announced`: local setup and Ollama management are explicit command surfaces.
<!-- CAPABILITY-RELEASE:END -->

## Compatibility

- **Node.js 24 or newer is required.** Aether Agent 0.1.0 accepted Node 20,
  but the 0.3 test runner and runtime contract use Node 24 behavior. Upgrade
  Node before installing 0.3.0; the package manifest and both installers refuse
  an older runtime instead of leaving a partially working CLI.

## New

- **Managed localhost previews.** `aether preview start|open|logs|status|stop`
  and `/preview` run only an explicit argv declaration or
  `.aether/preview.json`, show the execution and network plan before consent,
  detect a reachable loopback URL, and use the existing no-shell platform
  opener. An owner-private, one-use challenge authenticates control; the local
  supervisor owns the full process tree, so stale PID files and unrelated
  processes are never attached to or killed. Headless
  runs print the URL without claiming a browser opened. This is a separate
  local capability and does not relax web-fetch SSRF rules.

- **`aether exec` — a packaged, agent-driven JSONL interface.** It starts the
  packaged Node/Ollama brain child by default; explicit `--exec-driver cloud` uses an
  authenticated hosted Cloud text-model dev session with required local tool authority and no server-side
  downgrade. Cloud runs require explicit `--model` and `--max-uvt`, binding v2 resume to the same model
  and per-session hosted spend ceiling instead of a mutable server default; the client
  rejects a mismatched acknowledgement.
  Neo/Kronus `aether-*` orchestrator IDs are rejected because the dev-session endpoint cannot
  preserve their identity. Actual-Aether headless dogfood remains an external product dependency:
  it needs a versioned orchestrator dev-session contract with router confirmation, local tool
  receipts, controls/replay/cancel, and no server fallback. It emits `aether.exec/1` frames by default, with
  an opt-in `aether.exec/2` session protocol for durable repository/workspace-bound
  checkpoints, authority-expiring resume, confined `aether.exec.agent/1` definitions,
  and session-correlated pause, resume, steer, and cancellation acknowledgements. It retains
  sequence and correlation IDs, explicit permission decisions, bounded tool
  receipts, structured stdin controls, and exactly one terminal result. Network
  agent shell, Git, and network tools are disabled; configured host-run verification is authoritative,
  so a model claim can never turn a failing, absent, or workspace-mutating gate into exit 0.
  Cloud pause, resume, and steer are accepted only after the dev-session endpoint returns a
  valid acknowledgement; transport loss or malformed state fails closed. The packaged
  hosted-text-model production dogfood remains an acceptance dependency and has not been run by
  this implementation change. Ollama and the model-free installation selftest are not
  substitutes for that acceptance run.
- **Bounded local setup.** `aether setup --local` and `aether local doctor`
  diagnose Ollama without an account or a hosted request. `local models` lists
  namespaced `ollama:<tag>` ids; `local use` and `local pull` show their plans
  and require explicit approval. Neither operation silently switches the
  backend. Auto-local fallback refuses bare model ids, hosted paths refuse the
  `ollama:` namespace, and the compatibility bare-tag form is accepted only
  beside an explicit `--local`.
- **A review → commit → pull request rail.** `aether review` reads the
  repository's real state, lets you pick what goes in, commits exactly that, and
  `aether ship` publishes the head branch and opens the pull request.
  - `aether review [stage|unstage|revert|commit|diff|verify]`, with `--files`,
    `--hunks`, `-m`, `--base` (#94, #102).
  - `aether ship [--title t] [--body b] [--base b]` pushes HEAD — and only HEAD —
    and opens the PR against the branch it actually resolved (#95, #102).
  - **`--approve <action>` is the authority boundary.** `--yes` on its own never
    approves a destructive or a publishing step; the action has to be named
    (#102).
  - The state is read in one pass: repository root, remote identity, head and
    base revisions, commits ahead and behind, and every changed path. The push
    URL is read separately with `git remote get-url --push`, so a configured
    `pushurl` cannot publish somewhere you were never shown, and an unresolvable
    base leaves ahead/behind **unknown rather than zero** (#93).
  - A verification record stores the verify gate's result together with the head
    commit and a digest of the working tree, and compares that identity *before*
    it looks at the exit code — so neither a stale green nor a stale red can be
    rendered as current, and nothing upgrades unknown or stale to verified
    (#93, #97).
  - Changed files carry their added/removed line counts beside the state rather
    than inside it (#101).
- **`aether sessions`** — the project session library. `list`, `inspect`,
  `continue`, `export`, `archive` and `clean`, as a width-aware table on a
  terminal and tab-separated columns with a fixed field order when piped. An
  index beside the session directories makes "what was I doing here" cheap, but
  the per-session manifest stays the authority, so a lost or corrupt index costs
  time and never information. Where a session can be continued is answered as one
  of six distinct states — ready, stale branch, moved checkout, another
  workspace, missing checkout, archived — because the remedies differ, and the
  same facts appear as a PROJECT CONTINUITY block on entry. A count nobody
  recorded prints `unknown`, not `0`. Nothing here deletes: `archive` sets a flag
  and `clean` drops index rows for sessions already gone (#99).
- **Skills and `AGENTS.md` are inside real runs now, and their policy is
  enforced.** The runtime shipped in #72 with no production call site — a run
  never saw a skill, never saw `AGENTS.md`, and never enforced a tool policy.
  One seam now composes the brief before a brain is chosen, so the hosted and
  local paths carry the byte-identical string, and the refusal runs immediately
  before this host executes a tool. A skill only ever **subtracts** from the tool
  surface: the guard runs before the operator permission gate, never instead of
  it, so nothing a manifest says can add a tool, add a permission, or skip a
  confirmation. A skill matched automatically contributes context but not policy
  — only an explicit `--skill <id>` narrows (#100).
- **Agent skills** — `aether skills` inspects, trusts and manages skills, and six
  are built into the package: `review-pr`, `fix-ci`, `ship`, `doctor-project`,
  `research-and-implement`, `frontend-from-screenshot`. Skills are discovered,
  schema-validated, lazily loaded and trust-locked; an untrusted skill is not
  silently run.
- **`aether capabilities`** — the capability contract this build actually
  implements, and, with `--available`, what is reachable right now. A surface the
  build does not have reads as absent, not as unchecked.
- **`aether support-bundle`** — a redacted diagnostic bundle you can hand to
  someone without handing over your credentials or your file contents.
- **An authoritative command-registration seam.** The versioned manifest owns
  public help, flags, permissions, availability, documentation, and release
  disposition; the runtime registry owns only handler names and loaders. CI
  reconciles both sides, so missing/orphan handlers and flag collisions fail at
  load time instead of drifting across separate hand-maintained surfaces. You
  feel this as the three `doctor` fixes below — those flags were lost precisely
  because the old shape let a command's public contract and dispatch diverge.

## Carried forward from the unpublished 0.2.0

- **Handoffs** — `aether resume export` writes one portable file: the task, the
  model that ran it, the verify gate's verdict, how many tests were still
  failing, the files that changed, the verification command, and the repository
  it belongs to. Continue anywhere with `aether agent --resume <file>`, on
  whatever model you want. No absolute paths, no file contents, no shell
  commands, no credential-shaped values ride along.
- **`--resume` reaches the brain** — the prior session becomes a continuation
  brief the model reads before its own instruction. With no new task, the run
  continues the original one.
- **`aether agent --local "<task>"` works after a plain npm install** — the
  one-shot offline form used to die with `spawn python ENOENT`. It now drives the
  Ollama brain that ships in the package. `AETHER_LOCAL_BRAIN=python` opts back in.
- **Session logs stopped redacting your file paths** — the credential filter
  matched `pat` inside `path`. Real credential keys are still redacted.
- **`npm run demo:handoff`** — a deterministic end-to-end proof: two sessions,
  two models, two checkouts, one verify gate, no account and no model download.
  See [`docs/demo/handoff.md`](docs/demo/handoff.md).

## Fixed

- **A coding run no longer turns into a chat about your code without saying so.**
  When a server answers 403/404 to a dev-session request, CloudBrain treated it
  as "legacy server" and rerouted the run onto the one-way chat
  stream. That path runs its tools **server-side against the cloud vault**, so a
  session asked to work in your checkout quietly became a conversation about it:
  normal header, plausible reply, **exit 0**, and nothing anywhere saying the
  transport had changed. A `ROUTING_DRIFT` banner now prints before any model
  output, carrying the status, the server's own sanitized detail, the
  consequence in plain words, and what to do about it; `--json` carries it
  structurally as `kind:"routing_drift"` (#105). The current production doctor
  probe is still unproven: on August 27 the required non-billable
  `purpose:"doctor", max_uvt:0` session was rejected with HTTP 403 because
  production Agent DevSessions are disabled. No session was created, no UVT was
  spent, and no orphan was left, so this release does not claim hosted coding
  works.
- **`aether auth login` opens the approval page on Windows.** The win32 launcher
  used `explorer.exe` for URLs as well as file paths, which opens a File Explorer
  window rather than the default browser — so the device-approval page never
  appeared and the login poll sat on *"Waiting for approval in your browser…"*
  forever. URLs now go through `rundll32.exe url.dll,FileProtocolHandler`, the
  no-shell equivalent of a shell-execute on a URL, with the URL kept as a single
  argv element. A URL containing control characters or whitespace is refused
  outright (#103).
- **The stored credential cannot be redirected through a planted link, or torn
  in half by a crash.** The token store guarded its reads and writes with
  `O_NOFOLLOW ?? 0`, and `O_NOFOLLOW` is not defined on Windows — so the guard
  collapsed to `0` there and a symlink or directory junction planted at the token
  path was followed on both read and write, handing over the session token or
  capturing the next one. A junction needs no privilege to create. Reads and
  writes now `lstat` the path first and refuse a link on every platform, and the
  write is a `0600` exclusive temp file, fsynced and renamed over the target
  instead of truncate-then-write, so a crash mid-write can no longer leave an
  empty token file or let a concurrent reader see half a credential. Clearing the
  token removes a planted link rather than whatever it pointed at (#104).
- **Ctrl+C stops a local turn.** The abort signal now reaches local runs instead
  of being dropped at the chat boundary.
- **`/limit` is a real stop boundary**, and unknown spend is reported as unknown
  rather than as zero — so a session nobody measured no longer looks like a
  session that spent nothing.
- **`/rollback` stopped lying about HEAD** and stopped accepting a count it never
  used.
- **`--repo` is validated and fetched** rather than reused blind, and the
  worktree is pinned to the fetched revision; an unknown base is refused instead
  of guessed.
- **Tool execution is async with process-tree teardown** — cancelling a run kills
  the whole tree, not just the shell that fronted it, so `npm test` or a compiler
  no longer keeps running after you stopped it.
- **Ollama's own `OLLAMA_HOST` format is accepted**, and the request timeout stays
  armed through the body read instead of expiring at the headers.
- **Ollama tool results are correlated by id**, schemas are generated, and steer
  is no longer faked on the local path.
- **CLI startup no longer blocks on an unbounded `git status`** in a large or
  slow repository.
- **The hosted dev-session protocol version the server answers is actually
  checked**, instead of the version the client hoped for.
- **`aether doctor --live` now actually runs the live proof.** It never had. The
  CLI's argv parse swallowed any flag a command had not declared, so `--live`
  was stripped before `doctor` saw it: the command quietly ran the fast
  configured-only report and **exited 0**, presenting a live end-to-end
  verification that was never performed. `--deep`, `--dry-run`, `--no-ui` and
  `--only <id>` were lost the same way.
- **`aether doctor --fix` is reachable at all.** The whole repair path was
  unreachable, and because the global `--yes` never arrived either,
  `aether doctor --fix --yes` answered *"re-run with `--yes`"* to someone who had
  just passed it. `--fix` still changes nothing without `--yes`, and still shows
  its repair plan first.
- **A mistyped command no longer costs you a model call.** Command lookup
  lowercased the token while dispatch was case-sensitive, so `aether Vault` fell
  past the typo guard into a chat turn and billed it. Wrong case now reaches the
  "did you mean" guard, as it always should have.

## Behaviour changes

- **A run that needs local authority now fails closed, with the new exit code
  3.** `aether agent`, and any run that pinned `--model`, will no longer fall back
  to the chat stream when the dev session is refused: no chat-stream request is
  issued at all and the process exits **3**, a newly documented code in
  `COMMANDS.md`. This is a deliberate exit-status change — a script that treated
  a degraded run as success will now see a failure, which is the point. Chat-shaped
  runs that pinned nothing still degrade, but they announce it. `--local` (Ollama)
  and the auth paths are untouched (#105).
- **A symlinked config directory is now refused when writing the token.** Saving
  a credential validates the config directory first: it must be a real
  directory, not a link, owned by you, and not group- or world-writable. If you
  deliberately symlink or junction `~/.config/aether` — onto another drive, into
  a dotfiles checkout, across a container mount — `aether auth login` now **fails
  loudly** instead of writing your token through the link. Replace the link with
  a real directory, or point `AETHER_CONFIG_DIR` at one. This is deliberate: on
  Windows a directory junction needs no privilege to create, which makes
  redirecting the config directory the most reachable form of the attack #104
  closes. The ownership and permission half of the check is POSIX-only — Node
  does not expose Windows ACLs — but the link refusal itself applies everywhere
  (#104).
- **Reading the token no longer throws on a planted link; it reports no token.**
  A read that encounters a link is treated as "not signed in" rather than
  surfacing a credential, so the recovery path is `aether auth login`, not an
  error nobody can act on (#104).

## Authentication

Stated with its provenance, because half of this lives in a server this
repository cannot test:

- **Device-grant login works end to end again.** The repository-side half of that
  is #103 above: before it, the approval page never opened on Windows, so the
  flow could not complete there at all. The other half — the API accepting
  long-lived `aek_` tokens — is a **server-side** change. It is verified by
  operators against the deployed API and is **not** proven by any test in this
  repository, which has no live credential.
- **`aether auth logout` ends the session on the server, not just on disk.** The
  client posts to `/auth/logout` with the stored token before clearing the local
  credential. That call is **best-effort**: if the server is unreachable the
  local credential is still cleared, so a successful `Logged out.` is proof the
  credential is gone from this machine, and not by itself proof the server
  honoured it. The client call is not new in this range — what changed is on the
  server side.

## Availability — read this before upgrading

**0.3.0 ships from source until the release workflow publishes it.** At the time
these notes were written the registry served exactly one version of
`aether-agents`, `0.1.0`, and `latest` resolved to `0.1.0`; that is a dated
observation, not a standing claim about today. Read the current state with
`npm view aether-agents version`, and read your own install with
`aether --version`. If that reports a version below 0.3.0, none of the above is
in it.

Until `aether --version` reports 0.3.0 or newer, build from source:

```bash
git clone https://github.com/AetherAI3/aether-agent
cd aether-agent && npm ci && npm run build && npm link
```

Publishing is founder-owned: it needs a `v0.3.0` tag on the release commit, a
published GitHub release, the protected `npm-production` environment, and the
exact npm trusted-publisher binding for `AetherAI3/aether-agent` workflow
`release.yml`. No long-lived npm token is used. The exact sequence, with the
packed tarball's digest and manifest, is in
[`docs/releases/OPERATOR-PACKET-v0.3.0.md`](docs/releases/OPERATOR-PACKET-v0.3.0.md).

When 0.3.0 is published it upgrades in place: no configuration changes, no
migration, and 0.1.x session logs are read unchanged.

---

# Aether Agent v0.2.0 — the work outlives the session

**August 19, 2026**

Start a task on one model. Finish it on another, on another machine. Your tests
decide when it's done.

- **Handoffs** — `aether resume export` writes one portable file: the task, the
  model that ran it, the verify gate's verdict, how many tests were still
  failing, the files that changed, the verification command, and the repository
  it belongs to. Copy it anywhere and continue with `aether agent --resume
  <file>`, on whatever model you want. Nothing in it is keyed to an absolute
  path, so the receiving checkout does not have to live where the work started —
  and no file contents, shell commands, or credential-shaped values ride along.
- **`--resume` now reaches the brain** — the prior session is summarized into a
  continuation brief the model reads before its own instruction, rather than
  being replayed only for the human. With no new task, the run continues the
  original one. No re-pasted chat history.
- **`aether agent --local "<task>"` works after a plain npm install** — the
  one-shot offline form used to spawn the separately-installed Python brain and
  die with `spawn python ENOENT`. It now drives the Ollama brain that ships in
  the package. `AETHER_LOCAL_BRAIN=python` opts back in.
- **Session logs stopped redacting your file paths** — the credential filter
  matched `pat` inside `path`, so every edited file in every log read
  `[REDACTED]`. Real credential keys are still redacted.
- **A run that never reached your tests no longer reports a failing one.**
- **`npm run demo:handoff`** — a five-second deterministic proof of all of it:
  two sessions, two models, two checkouts, one verify gate, no account and no
  model download. See [`docs/demo/handoff.md`](docs/demo/handoff.md).

**Superseded — 0.2.0 was never released.** No `v0.2.0` tag, no GitHub release
and no npm version ever existed for it. `main` kept moving after these notes
were written, so the work above ships as part of **[v0.3.0](#aether-agent-v030--skills-and-a-release-that-matches-the-repository)**
instead of widening 0.2.0 to mean two different things. This entry is kept as
the record of what was written on August 19, not as an install instruction —
see the v0.3.0 availability section above.

---

# Aether Agent — your artifacts get an identity, and doctor stops guessing

**August 14, 2026**

Two things you can lose quietly — the record of what you generated, and the
belief that your setup works — stop being losable.

- **Every generated artifact gets a UUID** plus a persistent short reference.
  The old log numbered entries by array length, so once retention trimmed to
  100, the 101st generation and every one after it all answered to `101`.
  `output open 101` picked whichever came first. That is gone.
- **History cannot silently vanish.** Writes are locked across processes,
  atomic, flushed, and backed up. A corrupt index recovers from backup or
  rebuilds from the files still on disk — and always tells you which happened
  instead of rendering an empty list. The unreadable copy is kept as evidence,
  and an index written by a newer Aether is never overwritten.
- **Opening a file or a URL no longer goes through a shell.** Both paths used
  to build a command string, so a filename containing a quote or an `&` was an
  injection primitive. One implementation now hands the target to the OS as an
  argument array — and the Windows URL path actually works, which it did not
  before.
- **`aether doctor` answers three questions, not one.** Configured, reachable,
  and verified-now are separate. A check nobody ran says `not checked`; a
  surface this build does not have says `n/a` with the reason. Neither is a
  green tick any more.
- **`aether doctor --live` proves it** — a real session, sequence-numbered
  frames, pause/resume/steer acknowledgement, a sandboxed tool round trip, a
  browser open confirmed by a loopback callback, branch freshness compared
  without fetching, and a Protocol-C receipt round trip. Billing is accounted
  across the run: the agent loop runs only when the server confirms a
  non-billable doctor session, and reports itself unproven otherwise.
- **`aether doctor --fix`** shows its exact repair plan — scope, risk,
  reversibility, backup — and changes nothing without `--yes`. It cannot rotate
  credentials, spend, invoke a model, edit source, or move a git ref.

Nothing to do on upgrade: `output open <number>` keeps working and existing
history migrates on first read. Full detail in
[docs/releases/2026-08-14.md](docs/releases/2026-08-14.md).


---

# Aether Agent — the API brain goes bidirectional

**August 12, 2026**

The hosted path is now a true coding brain for your terminal. Until today the
cloud stream was one-way: the server reasoned and replied, but it could not
drive the tools on your machine. That gap is closed.

- **Agent dev sessions** — `aether agent` on the API path now opens a dedicated
  coding session: the Aether API plans and reasons, and every file read, edit,
  shell command, test run, and Git commit executes locally through the same
  permission gate and path guards the local brain has always used. Your source
  tree never leaves your machine.
- **Replay-safe by construction** — every frame carries a per-session sequence
  number. After a network drop the Agent reconnects from the last frame it saw,
  and a redelivered `tool_call` is skipped, never re-executed. Tool results are
  idempotent upstream: a retried POST is a no-op, a conflicting one is refused.
- **Steer, pause, resume — for real** — `/steer`, pause, and resume now reach
  the hosted brain mid-session and apply at the next model step. No restart, no
  lost work.
- **Effort reaches the cloud** — the `/effort` dial (LOW through CODEPRO) is now
  on the wire for hosted runs; previously it only shaped local runs despite the
  docs saying otherwise.
- **Clean teardown** — Ctrl+C/exit now aborts the stream immediately and closes
  the server session instead of leaving the socket to idle out for two minutes.
- **Graceful fallback** — against an older server (or with the feature flag
  off) the Agent silently uses the previous one-way stream. Nothing breaks.

Requires a server with agent dev sessions enabled; the client negotiates the
protocol version at session start and fails safe.

---

## Aether Agent — August 2026 fleet update

**August 6, 2026**

The fleet is server-side, so everything below is already reachable from an
installed CLI — no client upgrade required. Run `aether models` to see what
your plan can select.

- **Six frontier models on Pro/Team** *(shipped July 25)* — **Claude Opus 5**
  (`opus5`), the full **GPT-5.6** family — Sol, Terra and Luna (`gpt56_sol`,
  `gpt56_terra`, `gpt56_luna`) — **Kimi K3** (`kimi_k3`) and **Gemini 3.6
  Flash** (`gemini36_flash`). Every one carries a million-token context window,
  and each has its own monthly spend ceiling. All six are additive: `--model
  opus` still resolves to Claude Opus 4.8.
- **GPT-5.6 opened to its true window** — the family is priced through the full
  1,050,000-token window with stepped rates, so prompts above 272k tokens are
  billed exactly rather than estimated.
- **Media fleet expanded to 32 models** *(shipped July 27)* — 15 image, 16 video
  and text-to-3D, up from the original eight. New in the terminal's `/photogen`,
  `/videogen` and `/storyboard` paths: FLUX.2 (Klein / Pro / Flex / Max),
  Nano Banana 2, Recraft V4, Seedream 4.5, Riverflow V2, GPT-5 Image, Sora 2 Pro,
  Kling 3.0 Pro, Kling Video O1, Wan 2.6 & 2.7, Hailuo 2.3, Grok Imagine and the
  Veo 3.1 Fast / Lite tiers. Image generation is Solo and up; video stays Pro/Team.
  *(Correction to the June notes below: the model shipped as `vision_kling` is
  **Kling 3.0 Standard** — the old "Kling 2.5 Turbo Pro" label named a model the
  backend does not call.)*
- **Media spend is checked before rendering, not after** — every generation is
  priced against your balance in a preflight, with a platform-wide kill switch.
  Costs are computed by the platform, never reported by the model.
- **Model selection validated on the automation path** — the loop path used to
  accept a caller-supplied model key unchecked; it is now validated against your
  entitlements like every other path.

---

## Aether Agent — July 2026 engineering update

**July 20, 2026**

- **TypeScript 7 native compiler** — repository builds are about 3.4x faster on
  the migration benchmark, with stricter whole-project checks enabled.
- **Cleaner npm package** — compiled tests no longer ship, the tarball is about
  26% smaller, and the CLI again has zero runtime dependencies.
- **ESM command reliability** — interactive media, workflow brainstorming,
  context purge, rollback, and revert no longer depend on unavailable CommonJS
  `require(...)` calls.
- **Public-repo cleanup** — internal execution notes and an unfiled third-party
  abuse-report draft were removed from the published source tree.

---

## Aether AI — June 2026 release

**June 9, 2026** — AetherCloud + Aether Agent

---

This release ships image & video generation, web chat becomes a workspace, the terminal grows into a full agent console, and memory now bridges every surface. Here's what landed.

---

## Aether-Vision — Media Generation

Eight models. One orchestrator. Zero compromises.

- **3 image models** — Nano Banana Pro, Recraft V3, GPT Image 2. Free tier gets a teaser; Solo and up get full access.
- **5 video & 3D models** — Seedance 2.0, Veo 3.1, Kling 2.5 Turbo Pro, HunyuanVideo 1.5, Hunyuan3D 2.1. Pro/Team only.
- **Aether-Vision orchestrator** — Pair a text reasoning brain with the vision fleet. One prompt plans, prompt-engineers, and generates in a single run.
- **Batch generation** — 1/2/4 variations per prompt, concurrent queueing. Keep chatting while renders finish.
- **Desktop picker + viFrontend bridge** — VISION section in the model picker, generated media auto-opens in the project media viewport.

## Web Chat — Now a Workspace

- **Workflows render live in chat** — Diagrams, step cards, structured output instead of a wall of text.
- **Artifact dock** — Files, diagrams, SVG previews, vault docs collect beside the conversation.
- **Inline image & video artifacts** — Generated media renders directly in the transcript with live progress.
- **Voice-to-text** — Press-to-talk mic in the composer on web and desktop.
- **Light / dark mode** — Surface-level toggle that remembers your choice.

## Aether Agent Terminal — Full Console

30+ new slash commands. The terminal is no longer just a chat window.

- **Session control** — `/pin`, `/drop`, `/snapshot`, `/limit`, `/audit-receipt`, `/rollback`, `/logs-view`. Snapshot to cloud, resume anywhere.
- **Agent modes** — `/queue`, `/steer`, `/btw`, `/writing-plans`, `/subagent-driven-execution`, `/autonomous-execution`, `/self-review`, `/recon`, `/plan`, `/research`, `/code-review`.
- **Orchestra** — `/delegate`, `/tree`, `/broadcast`, `/gather`. Tree-of-agents from one prompt. Pro/Team gated.
- **UVT & media commands** — Usage tracking plus image, video, and storyboard pipelines from the REPL.
- **Vault & MCP** — Browse vault notes in-terminal. Interactive MCP server manager.
- **Goal chains** — `/goal` and `/goals` track persistent multi-step tasks with phase boxes across sessions.
- **Terminal UX overhaul** — Cursor-tracking input with kill/delete ops, ANSI-aware text utils, stage animations, chunk tokenizer fixes, stream sanitization, logs viewer with search.

## Memory — One Brain, Every Surface

- **QOPC behavioral memory** — The agent detects skills and patterns from how you work. Shown live in terminal as it learns.
- **Cloud memory bridge** — Memories live in AetherCloud, keyed to you. Terminal, web, and desktop all read the same store. Inline memory chips in chat. Delete anything, anytime.
- **Shared skill learning** — Teach it once on any surface, it knows everywhere.

## Platform & Security

- **Security hardening across every surface** — Coordinated red-team sweeps: web, API, desktop client, server mesh. Token handling, billing, rate limiting, sandboxing.
- **Desktop red-team self-heal** — IPC jail escapes closed, chat XSS hardened, SSRF blocked, timer leak fixed.
- **New desktop installer** — Slint software-renderer wizard. No NSIS, no WebView2. Runtime provisioning (Node, Git, ripgrep) out of the box.
- **Agent orchestration API** — `/agents` management endpoints with lifecycle hooks and per-user context registry.
- **Faster chat turns** — Request-scoped user-context dedup cuts redundant DB reads.
- **MCP broker** — Flag-gated sub-app mount with OAuth providers catalog and JWT/aek_ token verification.
- **Live audit trail** — Now reports tool calls and UVT spend.

---

*AetherCloud & Aether Agent — June 9, 2026*
