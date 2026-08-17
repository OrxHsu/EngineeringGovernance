<!-- engineering-governance:start -->
## Global Development Workflow

Governance version: `2.1.0`
Governance digest: `1a2aae4b0fb723ac1e0280b37016e347a24786470d6cbf508d784d2bd81a611f`

Before mutating work, read `.delivery/policy.yaml` and its declared project extensions, then run `sop check <absolute-project-path>`. Derive the task risk and frozen artifact requirements through `sop task start --project <absolute-project-path> --input <absolute-input-path>`.

Non-waivable core rules: every mutating task has one or more explicitly recorded implementation owners, and every mutation is attributable to exactly one acting owner from that set; completion requires fresh evidence from the real path; compile, static, runtime, cloud, and production evidence are not interchangeable; R2/R3 acceptance requires an independent reviewer of the exact candidate.

Project rules may strengthen the global policy but cannot silently weaken it. This block is an adapter: the versioned governance package and its digest remain authoritative.

Under governance 2.x, v1 task directories are legacy inspect-only history. Active mutation requires a schema-v2 contract and append-only ledger produced by the pinned runner.
<!-- engineering-governance:end -->
