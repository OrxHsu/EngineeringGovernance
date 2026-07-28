# NoMe V2 Governance Adoption

Status: applied; independent review pending
Date: 2026-07-29

## Candidate

- Governance implementation commit: `db0c8c3c937ec28cda2dff52630b26ac8aab7ada`
- SOP version: `1.0.0`
- SOP digest: `1557528236249c720f98df759ac7830364c6127348a7ca2fde12dd7aba3f2722`
- Runner digest: `47223a057538e057d7fa24a5164123a13f82a4a34a58ccef8829dece1456cc8e`
- Reviewed final runner refresh dry-run digest: `ac92b0dfc37d85e366cdbea42969eef28e13c88e29fca80cd904693d37c70b70`

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

Only `AGENTS.md` and the planned `.delivery` files were staged. During the adoption window an additional untracked acceptance file appeared under `Docs/acceptance/`; it was outside the managed scope and remains untracked.

## Verification

- `.delivery/bin/check-delivery-policy.sh`: `{ "valid": true, "errors": [] }` before and after commit
- The clean `42e93643` source plus governance upgrade was generated with XcodeGen
  and compiled using `generic/platform=iOS`: `BUILD SUCCEEDED`.
- The main worktree's concurrent WoMe candidate currently fails compilation
  because two new Swift files are untracked and therefore absent from the
  generated Xcode project. That separate business-worktree failure was not
  hidden, repaired, staged, or included in the governance commit.
- No Simulator or device was enumerated, launched, or used. No runtime/unit/UI test, deployment, push, or external operation was performed.

## Remaining gate

An independent reviewer must inspect commits `f54cbd1`, `f6abdd6`, and
`f666e28` plus fresh verification before this R3 adoption can be called
independently accepted. Runtime/UI evidence remains outside this
governance-only change.
