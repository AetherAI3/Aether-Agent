# Aether ATS skills

A thin Apache-2.0 integration for Aether-Agent. It reuses the native ATS compiler, the public Aether Browser client and the Unlimited Context engine. It contains no paid ATS engine source, model credentials, entitlement changes, broker execution path, or alternative Nano compiler. The package remains private until release qualification; its name is reserved for the intended npm package, not evidence of registry publication.

## User flow

Use `aether auth login`, `aether agent create ATS Atlas`, and `aether --agent <id> chat` through Aether-Agent. Cloud owns the account, managed identity, shared DM thread and UVT; this package owns local setup only. Absolute storage locations and browser credentials stay on the device.

Standalone preparation:

```sh
aether-ats-skills memory mag_0123456789abcdef /absolute/drive/atlas-memory 5
aether-ats-skills scan /absolute/strategies
```

Memory requires Python 3.10+ and the real `aether-context` engine. With no configured interpreter, the pinned npm launcher provisions version 0.3.1 into its private cache environment when needed; it never installs globally. `AETHER_ATS_PYTHON` or the API's `python` option selects an already provisioned interpreter. `bootstrap:false` disables provisioning. If Python or the engine cannot be installed, setup reports unavailable and does not pretend a settings file is initialized memory.

`initializeMemory({agentId,directory,sizeGb,python?,bootstrap?})` validates an empty or already bound directory, available space and a 5–1024 GiB configured ceiling. It creates an exclusively owned temporary native `ContextPool` on the selected drive, writes and reopens a unique verification slice, then removes that temporary pool. It initializes empty native files only for a new binding and reopens the actual pool without adding data; existing context and native configuration are preserved even at capacity. The receipt reports the canonical location, engine version and native accounting ceiling. The ceiling is a native slice-accounting limit, not a reserved disk allocation or a hard filesystem quota; `reserved_bytes` is zero. Setup never grants the Cloud hosted-context witness requirement, starts a model, or alters subscription access. The native engine's flat index also has RAM costs; a larger ceiling does not guarantee a larger usable in-memory index.

## Strategy preparation

`scanStrategies({directory,python?})` scans direct regular files only: at most 100 strategies, 1,024 directory entries, and 16 KiB per file. It refuses symlinks and oversized inputs, retains source digests, and invokes **`llmre.nano_compile.compile_proposal`** for `.nano` source, preserving native effect admission and positioned compiler diagnostics. Install the entitled ATS runtime in the selected Python environment or set `AETHER_ATS_RUNTIME_PATH` to its absolute repository root. The bridge never imports modules from the strategy directory.

`.py`, `.pine` and `.pinescript` return `needs_conversion`; they are never executed or claimed equivalent to a Nano strategy. Produce reviewed `.nano` source alongside the original and rescan it. There is no verified Pine/Python converter in this package. A compiled result is preparation evidence, not permission to execute or proof of a live data feed.

The scan returns `{state:'scanned',directory,compiler,strategies,execution_enabled:false,recursive:false}`. Each strategy has `file` and `state` (`compiled`, `rejected`, `needs_conversion`, `unavailable`) plus source digest and diagnostics where available. The package does not mutate source files or the native strategy catalog.

## Browser and settings

`createBrowserObserver({env?})` uses `aether-browser@0.2.2`. Run a compatible browser runtime separately and check it with `aether-browser doctor`. The default API is `http://127.0.0.1:8092`; this strict numeric-loopback profile supports token-free local use. A remote API requires HTTPS and environment credentials (`AGENT_BROWSER_CONTROLLER_TOKEN`, optionally the role-specific `AGENT_BROWSER_OBSERVER_TOKEN`). Credentials never belong in URLs or chat. `AGENT_BROWSER_URL` selects the API.

Opening validates readiness and creates one owned session. Only a fresh, matching native snapshot with a validated PNG, viewport, timestamp and budget can become `observing`; health or a launched viewer alone cannot. The observer distinguishes stale frames, expiry, unavailable evidence, exhausted budget and failed cleanup. Retry explicitly closes the old session before opening another; no automatic budget renewal occurs. Closing aborts observation and releases that exact session. The adapter supplies a bounded transport around the pinned SDK: deadline and cancellation cover the entire streamed body, responses are capped at 18 MiB, and redirects are refused.

Native noVNC remains **unauthenticated and browser-host-local**. Open `http://127.0.0.1:6080/vnc.html` on the runtime's host. Never tunnel, proxy or publish noVNC or raw VNC. Remote authenticated API observation is supported, but it does not create a viewer on the terminal's machine. See the [Agent Browser security contract](https://github.com/AetherAI3/agent-browser/blob/9981040b2e873b4120d0bc57850cbbb917603708/docs/SECURITY.md).

Inside managed-agent chat, `/browser setup [URL]`, `open`, `status`, `refresh`, `stop` and `retry` control this lifecycle. `/ats browser` is an alias. ATS chat opens its configured view after memory verification; ordinary managed agents load browser support on demand. Background status redraws preserve the terminal draft and cursor.

### Read-only visual skill

`createBrowserVisionSkill(observer)` returns the opt-in `aether_browser_observe` tool. A host must already own and admit the observer. `invoke({max_text_chars:4096}, {signal})` takes a fresh capture and returns a PNG plus bounded page text under `trust: 'untrusted_page_data'` and `authority: 'observation_only'`. Its source receipt includes the session, sequence, capture time, image SHA-256, origin, dimensions and remaining budget. The tool accepts no click, navigation, trading or memory-write arguments.

Page text and pixels can contain hostile instructions. A consuming host must preserve their lower-trust placement and independently check every action. The return value can contain private page information; it is never logged, uploaded or attached to Cloud chat automatically. The current Cloud managed-agent executor has no local visual-tool bridge, so creating this skill does not make the DM model see the browser. That adapter and real model behavior require separate qualification.

This adapter exposes observations, not browser clicks or financial actions. Generic browser access is not ATS admission, and the package cannot bypass account entitlements or native execution gates. See [SETTINGS.md](SETTINGS.md) for independent UI permission labels, native execution requests and data configuration.

## Native integration boundary

The current ATS engine configuration explicitly describes autonomous execution as a future integration, and its native approval modes are `paper`, `approve`, `auto`. New terminal labels `plan`, `skip`, `danger` do not map implicitly to those modes. Local settings keep order execution `paper` and live execution disabled; a runtime receipt must independently establish any future authority. Shared Cloud chat and local browser/memory setup do not yet bind Cloud model tool calls to the local paid engine.

Run `npm test` for bridge, observer and settings tests. Native memory/compiler tests identify missing Python dependencies as skips; release qualification must run them with the actual pinned engines installed and show no native skips. Verify clean installation from a packed Agent artifact before releasing a dependency bump. Nothing in this package publishes a release automatically.
