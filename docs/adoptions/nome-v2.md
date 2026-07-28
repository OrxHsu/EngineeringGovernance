# NoMe V2 Governance Adoption

Status: applied; independent review pending
Date: 2026-07-29

## Candidate

- Governance implementation commit: `da5f19434740defa76c02ea74a3eed6f7d342266`
- SOP version: `0.1.0-dev`
- SOP digest: `e0242ef38e3d6e5c7bd537fa81108e1a20d7eb7417861e2383c3ec442af74c53`
- Runner digest: `b541e925883d8f859bdc59db358ca626f5578b2d327d5e30575478ca49c26d41`
- Reviewed dry-run digest: `ce56c5af73450c3d31d5f1aea85133f89da0951809055fbddf241141857b4778`

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

## Applied commit

- `f54cbd116e2f19d9bb9c28b86d62125e474084dd`

Only `AGENTS.md` and the planned `.delivery` files were staged. During the adoption window an additional untracked acceptance file appeared under `Docs/acceptance/`; it was outside the managed scope and remains untracked.

## Verification

- `.delivery/bin/check-delivery-policy.sh`: `{ "valid": true, "errors": [] }` before and after commit
- `scripts/quick-check.sh`: `BUILD SUCCEEDED` using the project-defined `generic/platform=iOS` compile-only path
- The repository pre-commit hook independently reran its compile check and passed.
- No Simulator or device was enumerated, launched, or used. No runtime/unit/UI test, deployment, push, or external operation was performed.

## Remaining gate

An independent reviewer must inspect commit `f54cbd1` and fresh verification before this R3 adoption can be called independently accepted. Runtime/UI evidence remains outside this governance-only change.
