# Global Workflow Implementation Handoff

Status: Review Pending
Updated: 2026-07-29
Implementation owner: Codex in task `019fa9ea-1ddb-7513-a2df-05b5585c10ba`

## Objective and authority

Complete the local `1.0.0` EngineeringGovernance candidate, adopt ProjTrav and
NoMe without overwriting unrelated work, and stop before R3 independent
acceptance, main-branch merge, real global installation, tagging, publishing,
push, deployment, migration, or external communication.

- Frozen contract: `.delivery/tasks/global-workflow-repair/contract.yaml`
- Contract digest: `29398532b2deb3c9c2a50605f5dd1cf4e8324ea217b31c3d59f9e8a3d04df66a`
- Candidate input: `.delivery/tasks/global-workflow-repair/candidate.json`
- Evidence: `.delivery/tasks/global-workflow-repair/evidence.json`
- Implementation commit: `db0c8c3c937ec28cda2dff52630b26ac8aab7ada`
- Evidence closure commit: `296943e110b349b162b2270375518504894ebe48`
- Runner SHA-256: `47223a057538e057d7fa24a5164123a13f82a4a34a58ccef8829dece1456cc8e`

## Exact cross-repository candidate

| Repository | Commit | Tree |
| --- | --- | --- |
| EngineeringGovernance | `db0c8c3c937ec28cda2dff52630b26ac8aab7ada` | `aaa68cde65120143c6e46d54cc51ebecca7d88ee` |
| ProjTrav workspace | `63206f629a2e52154a5182efa67380ad9e62e711` | `683dfa2e3e77c814946822d64352fab55296a3a5` |
| ProjTrav server | `47754d1e14b2ea37521db282cc1e0488fe0c7d9c` | `abd884bfc83735179b8954e302e908a2764c8ec9` |
| ProjTrav iOS | `59d9d20de0ca5aea389c3363499e6d3b81c7bb94` | `1fd4d398fbe84f1c1f479f86aea611aad3b88d5b` |
| NoMe V2 | `f666e28bec149bc3bc9f91c83aa7aee888d1331d` | `c40766745807dd9d88888937bc1259cdf996a0c3` |

## Fresh verification

- Node 22 `pnpm check`: 24 test files passed, 1 skipped; 96 tests passed,
  1 skipped; typecheck, build, placeholder, and license checks passed.
- `REAL_PROJECT_DRY_RUN=1` integration: 1/1 passed without mutation.
- EngineeringGovernance, ProjTrav, and NoMe pinned runner checks returned
  `{ "valid": true, "errors": [] }`.
- ProjTrav docs sync passed; physical catalog passed with 233 tables and digest
  `69c77bf60898366e6ad4002f6b71ef62aca9ad9bfbc4c762c0946ef90789ce0c`;
  entity manifest passed with 326 entities, 233 tables, 233 operations, and
  digest `a9323f876740788f7dbf4e89cf5396810d525385238eae24a5523ba8ae0cf621`.
- NoMe clean source at the governance adoption boundary compiled successfully
  for `generic/platform=iOS` after XcodeGen generation. No Simulator or device
  was enumerated or used.
- Isolated-HOME global install/check passed. The launcher executed with
  `ENGINEERING_GOVERNANCE_ROOT` pointing to the candidate worktree.
- Real HOME global install remained dry-run only, plan digest
  `a1b80d9b7a09a6af2dcb8c155bca25a20f994c47854879449b03d772ffa0b5df`.
- `sop task verify --input .delivery/tasks/global-workflow-repair/candidate.json`
  returned `{ "valid": true, "errors": [] }` before this handoff commit.

## Review focus

The independent reviewer must inspect the exact commits and rerun the frozen
contract, with particular attention to:

1. invalid CLI decisions and project drift exiting non-zero;
2. evidence schema, raw executed IDs, evidence kinds, commit/tree identities,
   and evidence-only closure paths;
3. rejection of caller-controlled authorization/evidence clocks and the
   24-hour maximum evidence age;
4. authority-aware ProjTrav synchronization across three Git repositories;
5. preservation of NoMe and ProjTrav unrelated dirty or untracked paths;
6. the post-merge global launcher defaulting to the main governance repository.

Run from the governance worktree:

```sh
PATH="/opt/homebrew/opt/node@22/bin:$PATH" pnpm check
PATH="/opt/homebrew/opt/node@22/bin:$PATH" REAL_PROJECT_DRY_RUN=1 pnpm vitest run tests/integration/real-project-dry-run.test.ts
PATH="/opt/homebrew/opt/node@22/bin:$PATH" ./node_modules/.bin/tsx src/cli/main.ts task verify --input .delivery/tasks/global-workflow-repair/candidate.json
```

The implementation owner must not issue the acceptance decision. A finding-free
independent review may advance to local merge. Any blocking finding returns the
same implementation owner to repair and requires fresh evidence and a new exact
candidate.

## Current workspace state and limits

- EngineeringGovernance work is on `codex/global-workflow-implementation` in
  `.worktrees/global-workflow-implementation`.
- ProjTrav retains the pre-existing dirty Phase 2B handoff, server evidence/test
  copies, and iOS Qoder/Xcode/TestResults paths outside governance commits.
- NoMe retains an active dirty WoMe candidate. Its main worktree currently
  cannot compile because two untracked Swift files are absent from the generated
  Xcode project; this separate business candidate was not edited or staged by
  the governance work.
- The real global Codex home has not been mutated by this candidate.
- The recorded user authorization expires at `2026-07-30T00:00:00Z`. A review
  after that time requires fresh user authorization; the CLI uses process time
  and does not accept caller-provided clock values.

## Next permitted action

Obtain an independent R3 review of the exact candidate. If and only if it is
accepted: merge the governance branch locally, rerun the full checks from main,
perform a new real-HOME global dry-run, apply only that exact reviewed digest,
run `sop global check --tool codex`, and then record closure. Tagging, publishing,
pushing, deployment, migration, or external communication still requires its
own authorization.
