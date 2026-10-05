# Account agents and ATS

[← README](../README.md#account-agents-and-ats--040-source-candidate)

**0.4.0 source candidate.** This guide describes the account-agent workflow on
`main`. It requires the matching Cloud terminal adapter. Source availability,
package publication, and live-service qualification are separate; see the
[operator packet](releases/OPERATOR-PACKET-v0.4.0.md).

## Open an account agent

Sign in, then use the same managed agents and conversations as Aether Online:

```bash
aether auth login
aether agent list
aether agent chat
```

`aether agent chat` opens the one-column picker. Choose an agent to read and
send messages in its existing Online conversation. To open one directly, use
`aether agent chat <agent-id>`.

## Set up an ATS workspace

ATS is the trading adapter for account agents. The CLI prepares a workspace
and provides read-only browser observation; it does not connect an order tool.

```bash
aether agent create ATS Atlas
aether agent configure <agent-id> purpose "Review my trading strategies"
aether agent chat <agent-id>
```

| Setup step | What you choose or verify |
|---|---|
| Policy consent | Review the [ATS policy](../ATS_ACCEPTABLE_USE_POLICY.md); choose `1` to accept or `2` to reject. |
| Local memory | A folder and memory size, verified for the signed-in account and agent. |
| Strategies | A strategy folder; install and compile the reviewed Nano starters. |
| Data settings | Provider and symbols. Saving settings does not prove an executable market-data session. |
| Browser | A separately running Agent Browser runtime for bounded observation. |

The ATS Python engine is a separate prerequisite. The bundled adapters verify
storage and report native Nano compiler results; missing services produce
explicit diagnostics.

Rejection of the policy exits before agent creation or configuration of storage,
strategies, datafeeds, browsers, plugins, or MCP. Acceptance records a local,
pseudonymous receipt with the policy digest. It grants no trading authority.

Local resources belong to the verified account and agent. Token rotation keeps
that identity; switching accounts closes local resources and requires reopening
the conversation. Shift-Tab changes the local ATS permission preference.
Model access, projects, APR memory, and UVT admission remain enforced by Cloud.

## Inspect the workspace

Run these inside the managed-agent chat:

| Command | Purpose |
|---|---|
| `/ats status` | Inspect workspace status. |
| `/ats strategies` | Inspect strategy preparation. |
| `/ats data` | Inspect provider and symbol settings. |
| `/ats doctor` | Inspect activation prerequisites and separate execution-readiness states. |
| `/ats browser` | Open the configured browser view. |

## Browser controls

ATS chat opens the configured view after memory verification. Any managed agent
can configure its browser connection with these chat commands:

| Command | Purpose |
|---|---|
| `/browser setup [URL]` | Configure the connection. |
| `/browser open` | Open the view. |
| `/browser status` | Check the current observation state. |
| `/browser refresh` | Request a fresh view. |
| `/browser stop` | Release the session. |
| `/browser retry` | Release the old session and start a new bounded attempt. |

The local API defaults to `http://127.0.0.1:8092`. Check the separately installed
runtime with:

```bash
npx aether-browser@0.2.2 doctor
```

- **Observation:** `LIVE` requires a fresh validated screenshot. An open window
  alone is not observation proof. The bundled visual skill exposes verified
  images for an admitted host; Cloud DM does not yet receive those images or
  control the browser.
- **Connection:** remote APIs require HTTPS and environment credentials. The
  native noVNC viewer stays on the browser host; never tunnel or publish it.
- **Recovery:** status updates preserve your draft and cursor. Cleanup receipts
  survive restarts. If a creation response is lost, the receipt is retained and
  replacement is blocked until cleanup is known; an idle runtime alone cannot
  prove that the original request finished.

## Execution status

| Capability | Current status | Remaining boundary |
|---|---|---|
| Account setup, memory, strategies, data settings | Available in the source candidate | Preparation and diagnostics only. |
| Browser observation | Read-only source workflow | Requires the runtime and fresh validated images. |
| ATS runtime and market data | Verification framework on `main`; production wiring unavailable | Signed source, pinned trust anchor, launcher, and authenticated probe are not configured. |
| ATS simulated paper orders | Not connected to the managed agent | ATSv2 has a separate local paper journal; Agent has no authenticated order path to it. |
| Agent Browser paper orders | Contract only; no order tool registered | Requires an authenticated viewer, qualified site adapter, browser ticket port, approval, and order-history reconciliation. |
| Supervised live orders | Not shipped | Requires a verified live account, explicit arm, scoped limits, human approval, reliable stop/cancel, and an attended reconciled canary. |
| Autonomous live trading | Not shipped | Setup choices, strategies, chats, and policy receipts cannot enable it. |

The CLI does not yet provide model-controlled broker actions or automatic live
orders. It does not start an execution engine, connect a broker, or submit or
reconcile orders. `/ats doctor` separates browser paper activation prerequisites
from ATS simulated paper, provider sandbox, and live readiness; those latter
three are not ready in this build.

The [Agent browser order contract](https://github.com/AetherAI3/Aether-Agent/pull/164)
and [ATSv2 mirror](https://github.com/AetherAI3/ATSv2/pull/444) agree on typed calls
and refusal results. They register no trading tool. The intended first execution
proof is an order in a user-signed-in paper account through the same Agent
Browser session, reconciled against that site's order history. A local
simulated fill is not a trading-site fill; live capital has a separate gate.

[Execution plan](specs/2026-09-23-ats-agent-browser-orders.md) ·
[Candidate qualification](releases/OPERATOR-PACKET-v0.4.0.md) ·
[ATS policy](../ATS_ACCEPTABLE_USE_POLICY.md)
