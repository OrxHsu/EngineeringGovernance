<!-- engineering-governance:start -->
## Global Development Workflow

Governance version: `0.1.0-dev`
Governance digest: `e0242ef38e3d6e5c7bd537fa81108e1a20d7eb7417861e2383c3ec442af74c53`

Before mutating work, read `.delivery/policy.yaml` and its declared project extensions, then run `sop check <absolute-project-path>`. Derive the task risk and frozen artifact requirements through `sop task start --input <absolute-input-path>`.

Non-waivable core rules: every mutating task has exactly one implementation owner; completion requires fresh evidence from the real path; compile, static, runtime, cloud, and production evidence are not interchangeable; R2/R3 acceptance requires an independent reviewer of the exact candidate.

Project rules may strengthen the global policy but cannot silently weaken it. This block is an adapter: the versioned governance package and its digest remain authoritative.
<!-- engineering-governance:end -->
