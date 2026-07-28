# NoMe V2 Governance Adoption

Status: applied; independent review pending
Date: 2026-07-29

## Candidate

- Governance implementation commit: `5ee1a70bdbd32a5c5e9044c522757801e0d43df1`
- Governance implementation tree: `25ba5efaaecf2a2ebdcd72e776d722035f22dce2`
- SOP version: `1.0.0`
- SOP digest: `ea247f12a2f2cee2bcea67affd0f3e93fc9ee198ddd2036226015f10845ba26e`
- Runner digest: `83aa693997938c9b2f01b12d81ea73af88dd227dd3701743de67052fcc8b985f`

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
