# CI recovery and evidence

The required `CI` matrix normally uses GitHub-hosted Linux and Windows runners. `CodeQL` and `Release truth` are separate workflows. A failed or skipped job is not evidence that its tests passed; inspect the job's steps and runner assignment before interpreting a workflow conclusion.

## Hosted-runner or artifact outage

1. Open the failed job and read its check annotations. A job with no assigned runner and no steps has not tested the source. Record the run URL and exact head SHA.
2. Check the account's **Billing & Licensing** page for a lock, failed payment, Actions budget, or storage limit. Only the account owner can resolve a payment or plan lock. Do not weaken required branch checks to work around it.
3. Check artifact and cache usage across the account, not only this repository. Keep artifacts needed by active releases, audits, or reviews. Delete only evidence confirmed obsolete under its owning repository's retention policy; deletion is irreversible. Lower future retention only after deciding how long each artifact type must remain available.
4. After service is restored, run a fresh PR check and a fresh `main` check. Record the exact SHA, Linux and Windows job URLs, CodeQL and release-truth results, and downloadable exact-source, parity, dependency-audit, and SBOM artifacts. The ATSv2 parity result also requires the separate private-repository access work in #266.

GitHub documents [billing locks](https://docs.github.com/en/billing/how-tos/troubleshooting/locked-account), [Actions billing troubleshooting](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows), and [artifact deletion](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/remove-workflow-artifacts).

## Temporary self-hosted route

The repository variable `AETHER_CI_SELF_HOSTED=1` routes Linux CI jobs for **same-repository pull requests only** to the dedicated `aether-agent-ci` runner. It does not route Windows jobs, `main` pushes, scheduled jobs, or fork pull requests there. When the variable is absent, all jobs use their hosted runners. Keep it absent during normal operation and remove it after an outage.

The routing condition limits which PRs reach the runner; it does not isolate arbitrary code within a job. PR scripts can execute on the machine. Enable the fallback only for a controlled, trusted head on a dedicated runner whose filesystem, network reachability, credentials, and work directory have been reviewed. A persistent runner can retain state between jobs; use an ephemeral runner or rebuild and clean it before accepting a different head. Never expose private ATSv2 checkout credentials or other secrets to this public-repository job. Fork PRs must wait for hosted capacity or use another isolated, reviewed path.

All artifact-upload steps are required, including on the self-hosted route. If storage rejects an upload, the job fails rather than reporting a green check without its evidence. The fallback cannot satisfy the Windows or `main` acceptance checks for #267, and it cannot make the ATSv2 gate pass until #266 is resolved.
