<!-- engineering-governance:start -->
## Global Development Workflow

Governance version: `2.0.0`
Governance digest: `821ebedcc94ed63f5f9199a7eaa8b8bd579d565766bb34916bb5da45643d3781`

Before mutating work, read `.delivery/policy.yaml` and its declared project extensions, then run `sop check <absolute-project-path>`. Derive the task risk and frozen artifact requirements through `sop task start --project <absolute-project-path> --input <absolute-input-path>`.

Non-waivable core rules: every mutating task has exactly one implementation owner; completion requires fresh evidence from the real path; compile, static, runtime, cloud, and production evidence are not interchangeable; R2/R3 acceptance requires an independent reviewer of the exact candidate.

Project rules may strengthen the global policy but cannot silently weaken it. This block is an adapter: the versioned governance package and its digest remain authoritative.

Under governance 2.x, v1 task directories are legacy inspect-only history. Active mutation requires a schema-v2 contract and append-only ledger produced by the pinned runner.
<!-- engineering-governance:end -->
