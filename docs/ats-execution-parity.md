# Agent ↔ ATSv2 execution wire parity

The exact Agent JSON document shapes are the cross-repository wire for this
gate. ATSv2 implements their closed validators in `ats_mcp.agent_execution_v2`
and `ats_mcp.agent_foundation_wire`. ATSv2's native `agent_bridge/v1` remains a
separate contract. The authenticated gateway that enrolls a client, binds an
account and grant, presents human approval, and calls a broker port is a later
gate. These validators do not register an order tool or grant execution
authority.

Run from the Agent checkout with Node 24, Python 3, pytest, and `npm ci`
installed:

```text
npm run ats:execution-parity -- --atsv2 <ATSv2 checkout> --report ats-execution-parity.json
```

`contracts/ats-execution-parity/v1.json` pins the ATSv2 Git SHA and SHA-256 of
five fixture byte streams. The command refuses a different ATSv2 head, a dirty
tracked checkout, or a fixture mismatch. Set `AETHER_EXPECTED_AGENT_SHA` to
require a specific Agent head too; CI sets it to the tested pull request head.
For local edits in progress, `--allow-dirty` bypasses only the tracked checkout
check, while revision and fixture checks still run. `AETHER_PARITY_PYTHON` can
select a Python executable when `python` is not on `PATH`.

The gate compiles the Agent TypeScript source and runs the Node contract,
browser order, Spec 2, and no-order-tool tests. It then runs the independent
Agent Python mirrors and ATSv2's production Python validator conformance tests.
The JSON report names both Git revisions, fixture digests and vector counts,
test suites, and the no-order-tool result. CI runs it on Linux and Windows and
retains the report as an artifact.

Each fixture uses LF bytes on both platforms. The manifest hashes repository
bytes, not a platform-specific checkout transformation. Changing a schema,
digest, unit, refusal, or one of these fixture streams requires a reviewed
update to the validator, fixture pin, and ATSv2 revision together.
