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

`createBrowserObserver({env?})` uses `aether-browser@0.2.2`, with `AGENT_BROWSER_URL`, `AGENT_BROWSER_CONTROLLER_TOKEN` and `AGENT_BROWSER_OBSERVER_TOKEN`. Run a compatible browser server separately. The observer validates server readiness, owns one browser session, exposes its noVNC viewer when locally reachable, and takes bounded periodic snapshots. It reports stale observations and exhausted vision budgets separately; reconnection or a new budget requires an explicit new session. A remote server's loopback viewer cannot be opened on the client machine automatically. Closing the observer releases its exact session.

This adapter exposes observations, not browser clicks or financial actions. Generic browser access is not ATS admission, and the package cannot bypass account entitlements or native execution gates. See [SETTINGS.md](SETTINGS.md) for independent UI permission labels, native execution requests and data configuration.

## Native integration boundary

The current ATS engine configuration explicitly describes autonomous execution as a future integration, and its native approval modes are `paper`, `approve`, `auto`. New terminal labels `plan`, `skip`, `danger` do not map implicitly to those modes. Local settings keep order execution `paper` and live execution disabled; a runtime receipt must independently establish any future authority. Shared Cloud chat and local browser/memory setup do not yet bind Cloud model tool calls to the local paid engine.

Run `npm test` for bridge, observer and settings tests. Native memory/compiler tests identify missing Python dependencies as skips; release qualification must run them with the actual pinned engines installed and show no native skips. Verify clean installation from a packed Agent artifact before releasing a dependency bump. Nothing in this package publishes a release automatically.
