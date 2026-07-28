<!-- engineering-governance:start -->
## Global Development Workflow

Governance version: `1.0.0`
Governance digest: `f85636fecdfff9ff4729e5b8afcf684c060c0fe1fc1e221896f0482f14e23821`

Before mutating work, read `.delivery/policy.yaml` and its declared project extensions, then run `sop check <absolute-project-path>`. Derive the task risk and frozen artifact requirements through `sop task start --input <absolute-input-path>`.

Non-waivable core rules: every mutating task has exactly one implementation owner; completion requires fresh evidence from the real path; compile, static, runtime, cloud, and production evidence are not interchangeable; R2/R3 acceptance requires an independent reviewer of the exact candidate.

Project rules may strengthen the global policy but cannot silently weaken it. This block is an adapter: the versioned governance package and its digest remain authoritative.
<!-- engineering-governance:end -->
