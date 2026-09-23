# ATS execution foundation checkpoint

**Source:** Aether-Agent main `1337b131778d17ad17cb8b37249297bcc83eb8f7`; ATSv2 main `ecdbc5c296f28f2331aea4e031c459f1171b99ea`.
**Parent specification:** Aether-Agent [#162](https://github.com/AetherAI3/Aether-Agent/pull/162).
**Companion Python review:** ATSv2 [#443](https://github.com/AetherAI3/ATSv2/pull/443).

This PR closes part of G0, supplies a strict POSIX ustar extraction component
for G1 and adds a closed model proposal boundary for G4. The extractor is
deliberately not selected by the installer until a signed artifact format is
defined. It parses and bounds every archive entry before writing and refuses
links, traversal, special files, duplicate names and unsafe Windows names. It
has not yet been qualified with the release artifact on Windows and Linux. It
does not turn on review, simulated paper or a provider order. `/ats doctor` now
reports local activation prerequisites separately from ATS simulated paper
order readiness. Research data verification never becomes an executable quote.

## Parity receipts

| Artifact | SHA-256 (file bytes) | Reviewed ATSv2 copy |
|---|---|---|
| `ats_contracts_golden.json` | `baed2ed715d697c3040ffdf5318734d20fa39b835719ac3b79896d9ba6bd7f15` | `ats-mcp/tests/fixtures/ats_contracts_golden.json` in #443 |
| `ats_model_proposal_golden.json` | `f6d07b91a5036729a7eb1d5acf241de1a6ea70ec60bd807629b959c16d84b5e1` | `ats-mcp/tests/fixtures/ats_model_proposal_golden.json` in #443 |

The Agent Node suite validates the model proposal and canonical digest. The
ATSv2 Python suite independently checks the copied digest vectors and validates
the proposed model input shape. Both suites need green CI at their exact heads
before the proposal is offered as a tool. An executable cross-repo harness and
complete TS/Python validator and ATS bridge translation parity remain G0 work.

## Next gates before an order

1. Freeze an independent runtime signing anchor, ustar artifact format (or
   review another confined extractor), entitlement endpoint, package and
   authenticated capability protocol. Then wire G1 transport, extractor,
   launcher and real device canary.
2. Admit exactly one E1 read-only status invocation with a durable host lease and
   Cloud result custody. Qualify native strategy activation and executable data
   rights in ATSv2.
3. Enroll one host and one ATS client/target. Use ATSv2's own grant, preview,
   reservation and human gateway for a **separately reviewed** simulated paper
   request. Ambiguous commit outcomes require evidence-only reconciliation.
4. Choose and qualify an external sandbox adapter separately. A live-capital
   program needs a separately approved provider, real account, numeric limits,
   independent review and one founder-operated canary.

Current release decision: **HOLD / NO ORDER SUBMISSION / NO LIVE CAPITAL**.
