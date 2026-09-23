# ATS browser execution: G0 release matrix

**Date:** 2026-09-23 UTC
**Gate:** G0, contract and release baseline, from the
[execution spec (V2)](2026-09-23-ats-agent-browser-remaining-gates-v2.md), section 4.
**Status:** baseline recorded. This record authorizes no paper or live order.

## What a passing fixture proves

A passing fixture means only that both sides agree on shapes and refusals.
It does not show that an order tool exists or is safe, that any order was
previewed, approved or placed, that a browser session or site adapter works,
or that any of the gates G1 to G6 has passed.

## Merged pull requests

SHAs read with `gh pr view <n> --json headRefOid,mergeCommit,mergedAt` on
2026-09-23.

| Repository | PR | Title | PR head SHA | Merge SHA | Merged (UTC) |
|---|---|---|---|---|---|
| Aether-Agent | [#163](https://github.com/AetherAI3/aether-agent/pull/163) | feat(ats): clarify order readiness and enforce model proposal boundary | `ef13252d29d229d3c2845c25f83fd2cfaac2d16e` | `a8f066167dbfb816617d9bc99390d9319ece04cb` | 2026-09-23 12:05:12 |
| Aether-Agent | [#164](https://github.com/AetherAI3/aether-agent/pull/164) | feat(ats): freeze the agent-browser-ats-order/1 browser order contract | `c937bab5d40e89b56e062d1aa173612abd374af9` | `c105fd458ba8afc37588c7fb1a59082160d8f88c` | 2026-09-23 15:38:29 |
| Aether-Agent | [#165](https://github.com/AetherAI3/aether-agent/pull/165) | docs(ats): show browser order contract and actual execution gates | `198b6a94febb6a3d5bd3b3af43f22b0a24d3d8d1` | `ee84f38aa925c34feec907785aaaabf58e7b62be` | 2026-09-23 20:14:37 |
| ATSv2 | [#443](https://github.com/AetherAI3/ATSv2/pull/443) | test(ats): pin Agent proposal boundary and canonical wire vectors | `4da992be9cca67be47830d268beabd38c6661cd5` | `32eb3aa2ffea71b9d3d910e5d2abf778b5d05cc3` | 2026-09-23 12:07:48 |
| ATSv2 | [#444](https://github.com/AetherAI3/ATSv2/pull/444) | test(ats): lift agent-browser-ats-order/1 validators and pin Agent's vectors | `e357913f17ff62b88ab57316ddae1c21231932fe` | `205e0b00e0bda0da1fcafffeecb2a6a51b66eb31` | 2026-09-23 15:27:55 |

## Pinned fixtures

All four files live in Aether-Agent `test/fixtures/`. The sha256 is over the
file bytes.

| Fixture | sha256 | ATSv2 pin at `205e0b00e0bda0da1fcafffeecb2a6a51b66eb31` |
|---|---|---|
| `ats_contracts_golden.json` | `baed2ed715d697c3040ffdf5318734d20fa39b835719ac3b79896d9ba6bd7f15` | `AGENT_CONTRACT_FILE_SHA256` in `ats-mcp/tests/test_agent_wire_conformance.py`; byte `cmp` in `.github/workflows/ats-mcp.yml` |
| `ats_model_proposal_golden.json` | `f6d07b91a5036729a7eb1d5acf241de1a6ea70ec60bd807629b959c16d84b5e1` | `AGENT_PROPOSAL_FILE_SHA256` in the same test; byte `cmp` in `ats-mcp.yml` |
| `ats_browser_order_golden.json` | `c71d623885c6253725c674a0f1c85a51a729bcd41992ef9b8ac41227431a492c` | `AGENT_BROWSER_ORDER_FILE_SHA256` in `ats-mcp/tests/test_agent_browser_ats_order_conformance.py`; byte `cmp` in `ats-mcp.yml` |
| `ats_contracts_v2_golden.json` | `837994a7dc3624e807eeef57e629648f0b8b19362c31ab4fa3958da6203d3544` | **Pending ATSv2 pin.** It lands with the Spec 1 `/2` closure (branch `feat/ats-contracts-v2-closure`); ATSv2 pins it in lane W1-D. |

The first three are byte-identical at every commit in the next section and at
the head of the `/2` closure branch, which does not modify them.

## The Agent SHA that ATSv2 pins

ATSv2's `.github/workflows/ats-mcp.yml` at `205e0b00e0bda0da1fcafffeecb2a6a51b66eb31`
checks out Aether-Agent at `db4129f674dc68df1a018bd75eaa3eca88636461`, asserts
that exact head, and compares the three fixtures byte-for-byte. That SHA is
the pre-merge head of Agent #164, "feat(ats): freeze the
agent-browser-ats-order/1 browser order contract". The branch then merged
main (`c937bab5d40e89b56e062d1aa173612abd374af9`, the PR's final head) and
landed as `c105fd458ba8afc37588c7fb1a59082160d8f88c`. So the pin is not a
main commit. It is an ancestor of the #164 merge, and the pinned fixture
bytes did not change on the way in:

| Agent commit | Role | `ats_contracts_golden.json` | `ats_model_proposal_golden.json` | `ats_browser_order_golden.json` |
|---|---|---|---|---|
| `db4129f674dc68df1a018bd75eaa3eca88636461` | ATSv2's pinned Agent head | `baed2ed7...7f15` | `f6d07b91...b5e1` | `c71d6238...492c` |
| `c937bab5d40e89b56e062d1aa173612abd374af9` | #164 final head | same | same | same |
| `c105fd458ba8afc37588c7fb1a59082160d8f88c` | #164 merge | same | same | same |
| `ee84f38aa925c34feec907785aaaabf58e7b62be` | #165 merge, main at this record | same | same | same |

At the #163 merge (`a8f066167dbfb816617d9bc99390d9319ece04cb`) the contract
and proposal fixtures already had these bytes; the browser order fixture did
not exist yet. Moving ATSv2's pin to a merged main SHA and adding the `/2`
fixture is lane W1-D.

## G0 evidence

- **Cross-language fixture run.** The Node suites and the three independent
  Python verifiers (`ats_contracts_golden_verify.py`,
  `ats_browser_order_verify.py`, `ats_contracts_v2_verify.py`) pass on the
  `/2` closure branch, and CI runs all three on Linux and Windows.
- **Zero order tools registered.** `test/ats_no_order_tool.test.ts` reads 32
  tool, action and command registries, from the brain tool list and
  CloudBrain's live advertisement to every command dispatcher in
  `src/commands`. It finds none of the order contracts' 17 operations, no
  order, trade or position being submitted, committed, placed, cancelled,
  executed, closed, routed or amended, no buy, sell, short or flatten, and no
  approval. It also finds no import of the proposal or browser-order
  validators outside `src/core/ats_contracts/`, and no MCP server. The
  inventory covers what this CLI registers, advertises and dispatches; tools
  offered by a user-configured MCP server or by Cloud's MCP broker are outside
  it, and the CLI's `ToolExecutor` refuses any name outside `TOOLS`.
- **Doctor refusal projection.** Not produced by this lane. The execution
  spec records the last observed projection: `paper_order_ready=false`,
  `provider_sandbox_ready=false`, `broker_live_ready=false`.
