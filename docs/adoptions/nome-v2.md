# NoMe V2 Governance Adoption

Status: applied; independent review pending
Date: 2026-07-29

## Candidate

- Governance implementation commit: `77866c9a78dd14bb76dc3b31239fee7abde98d9b`
- Governance implementation tree: `a528f2aa42141977440c1a67e9a28b1f4c51f9da`
- SOP version: `1.0.0`
- SOP digest: `f85636fecdfff9ff4729e5b8afcf684c060c0fe1fc1e221896f0482f14e23821`
- Runner digest: `f533b20f75d19421ae9a037e014caf6cecbdad4480ae9e215b83aa87423d2d99`

## Authority map

- Repository adapter and agent authority: `AGENTS.md`
- Product and data-trust authority preserved unchanged: `Docs/ODD.md`
- XcodeGen authority preserved unchanged: `project.yml` and optional `project.local.yml`

## Pre-adoption state

- Branch: `codex/repository-baseline`
- Commit: `8a2ef9dd1abd163e29c0ebd086c39f3e11686fe6`
- Existing untracked handoffs and planning files under `Docs/` were preserved and not staged.
- No NoMe Codex task was active; listed NoMe tasks were idle or not loaded.
- The Qoder desktop process was running, but no managed-path overlap was present. Exact before-digest checks remained the final write guard.

## Applied commits

- Initial development adoption: `f54cbd116e2f19d9bb9c28b86d62125e474084dd`
- `1.0.0` upgrade: `f6abdd615726e3c8b643afd672090c12beab52f1`
- Trusted-clock runner refresh: `f666e28bec149bc3bc9f91c83aa7aee888d1331d`
- Artifact-binding and portable-runtime repair refresh: `2910996bf942ce1d5f06f62736d0a1bee9c92c5b`
- Approved-replay and canonical-digest refresh: `1b41a9f205a59be4fee54a7588891e04307b902b`

Only `AGENTS.md` and the planned `.delivery` files were staged. Existing
untracked handoffs and planning documents under `Docs/` remain outside the
governance commits.

## Verification

- `.delivery/bin/check-delivery-policy.sh`: `{ "valid": true, "errors": [] }` before and after commit
- The final governance commit's pre-commit hook compiled the current project
  using the project's compile-only iOS path and reported success.
- The fresh real-project dry-run snapshotted the planned governance boundary
  and observed zero mutation.
- No Simulator or device was enumerated, launched, or used. No runtime/unit/UI test, deployment, push, or external operation was performed.

## Remaining gate

An independent reviewer must inspect the exact final commit and tree recorded
in the repair candidate plus fresh machine execution receipts before this R3
adoption can be called independently accepted. Runtime/UI evidence remains
outside this governance-only change.
