# CI recovery and evidence

The required `CI` matrix normally uses GitHub-hosted Linux and Windows runners. `CodeQL` and `Release truth` are separate workflows. A failed or skipped job is not evidence that its tests passed; inspect the job's steps and runner assignment before interpreting a workflow conclusion.

## Hosted-runner or artifact outage

1. Open the failed job and read its check annotations. A job with no assigned runner and no steps has not tested the source. Record the run URL and exact head SHA.
2. Check the account's **Billing & Licensing** page for a lock, failed payment, Actions budget, or storage limit. Only the account owner can resolve a payment or plan lock. Do not weaken required branch checks to work around it.
3. Check artifact and cache usage across the account, not only this repository. Keep artifacts needed by active releases, audits, or reviews. Delete only evidence confirmed obsolete under its owning repository's retention policy; deletion is irreversible. Lower future retention only after deciding how long each artifact type must remain available.
4. After service is restored, run a fresh PR check and a fresh `main` check. Record the exact SHA, Linux and Windows job URLs, CodeQL and release-truth results, and downloadable exact-source, parity, dependency-audit, and SBOM artifacts. The ATSv2 parity result also requires the separate private-repository access work in #266.

GitHub documents [billing locks](https://docs.github.com/en/billing/how-tos/troubleshooting/locked-account), [Actions billing troubleshooting](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows), and [artifact deletion](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/remove-workflow-artifacts).

## Temporary self-hosted route

The repository variables `AETHER_CI_SELF_HOSTED=1` and `AETHER_CI_SELF_HOSTED_PR=<reviewed PR number>` route Linux CI and CodeQL jobs for **that same-repository pull request only** to a dedicated `aether-agent-ci` runner. Without the matching PR number, other PRs stay hosted. `AETHER_CI_SELF_HOSTED_WINDOWS=1` additionally routes the Windows test and clean-install jobs to a real Windows x64 runner labeled `aether-agent-windows-ci`. Only set the Windows variable after that runner is online and has Git for Windows (including Bash) and Node.js 24 installed. `AETHER_CI_SELF_HOSTED_MAIN=1` additionally routes `main` push and manual `main` checks, including CodeQL and release truth, to the self-hosted runners. Scheduled runs, release branches, and fork pull requests remain hosted. When the master variable is absent, all jobs use hosted runners. Remove these variables after the outage.

The routing condition limits which PRs reach the runner; it does not isolate arbitrary code within a job. PR scripts can execute on the machine. Enable the fallback only for a controlled, trusted head on a dedicated runner whose filesystem, network reachability, credentials, and work directory have been reviewed. A persistent runner can retain state between jobs; use an ephemeral runner or rebuild and clean it before accepting a different head. Never expose private ATSv2 checkout credentials or other secrets to this public-repository job. Fork PRs must wait for hosted capacity or use another isolated, reviewed path.

If checkout hangs or a runner fails before tests begin, remove its `aether-agent-ci` label until its GitHub access and work directory are repaired. A queued or timed-out job supplies no test evidence. Keep a distinct maintenance label so the machine can be diagnosed without accepting CI jobs.

The disposable Windows runner should be a Windows Server 2022 x64 VM with at least 4 vCPU, 16 GB RAM, and 100 GB SSD. It needs outbound HTTPS on port 443, Git for Windows with Bash, and Node.js 24 on `PATH` before the first job; `actions/setup-python` installs the requested Python versions. Register it only to this repository with the custom label `aether-agent-windows-ci`, keep private credentials off the VM, and reimage it between different trusted heads. One VM is sufficient because a runner processes one job at a time.

All artifact-upload steps remain required. When storage rejects an upload, jobs continue running tests, record a compact file manifest and SHA-256 digests in their logs and step summaries, then fail a final evidence gate. Run logs are downloadable while the artifact quota is exhausted, but they do not replace the named Actions artifacts required to close #267. The ATSv2 gate cannot pass until #266 is resolved. A Windows VM and explicit main opt-in provide interim platform coverage; they do not prove GitHub-hosted capacity has recovered.
