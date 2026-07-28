# Global Workflow Implementation Handoff

Status: Independent Re-review Pending
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
- Candidate digest: `bbcfd9aaae2f0d7c6ca554c975c5fff95d06d0046441e442059fc631b562d055`
- Evidence: `.delivery/tasks/global-workflow-repair/evidence.json`
- Historical repair-required review: `.delivery/tasks/global-workflow-repair/review.json`
- New review output: `.delivery/tasks/global-workflow-repair/review-repair2.json`
- Implementation commit: `5ee1a70bdbd32a5c5e9044c522757801e0d43df1`
- Evidence closure commit: `9c30f40f5966c458780a478d18ffbc63dc5be1c4`
- Governance digest: `ea247f12a2f2cee2bcea67affd0f3e93fc9ee198ddd2036226015f10845ba26e`
- Runner SHA-256: `83aa693997938c9b2f01b12d81ea73af88dd227dd3701743de67052fcc8b985f`

## Exact cross-repository candidate

| Repository | Commit | Tree |
| --- | --- | --- |
| EngineeringGovernance | `5ee1a70bdbd32a5c5e9044c522757801e0d43df1` | `25ba5efaaecf2a2ebdcd72e776d722035f22dce2` |
| ProjTrav workspace | `3ad83efe6ccc3c48a0404033388722d3a64f3de0` | `4dce6b5b05bc7812f54586ad76c073966b21f9aa` |
| ProjTrav server | `b6c58b35584353fe0b6badd38587ed743f667865` | `342ea17f979f9b53998537b6c97815f26d8094ae` |
| ProjTrav iOS | `ee7ab323d872c9bb39163236fec27282d997f6ad` | `819b73e7b63504d4b7e7e882e0d4a38e36466722` |
| NoMe V2 | `2910996bf942ce1d5f06f62736d0a1bee9c92c5b` | `f737ae6e81eb12241f1c6961c454efb7e653deee` |

## Prior review and repairs

The first independent R3 review returned `REPAIR_REQUIRED`. The same frozen
contract remained in force. Commit `5ee1a70` repaired the four findings:

1. `GW-R3-F-001`: evidence is now runner-produced command execution data with
   exact commit/tree sets; handwritten PASS lists, forged trees, and reduced
   repository sets are rejected.
2. `GW-R3-F-002`: review and closure now load and revalidate artifact chains,
   candidate digests, reviewer independence, exact identities, status, and
   next-action equality.
3. `GW-R3-F-003`: ProjTrav generated adapters are planned and guarded in their
   owning Git repositories, but remain sync-produced rather than directly
   authored.
4. `GW-R3-F-004`: the portable gate selects Node 22 from supported Homebrew
   paths or exits 69 before npm under an unsupported ambient runtime.

## Fresh verification

- Node 22 `pnpm check`: 25 test files passed, 1 skipped; 102 tests passed,
  1 skipped; typecheck, build, placeholder, and license checks passed.
- Focused artifact-binding suite: 8 tests passed.
- R1/R2/R3 real-CLI pilots: 3/3 passed.
- `REAL_PROJECT_DRY_RUN=1` integration: 1/1 passed without mutation and
  included the five ProjTrav generated targets.
- ProjTrav docs sync passed; physical catalog passed with 233 tables and digest
  `69c77bf60898366e6ad4002f6b71ef62aca9ad9bfbc4c762c0946ef90789ce0c`;
  entity manifest passed with 326 entities, 233 tables, 233 operations, and
  digest `a9323f876740788f7dbf4e89cf5396810d525385238eae24a5523ba8ae0cf621`.
- Project-pinned runner checks passed for EngineeringGovernance, ProjTrav, and
  NoMe.
- The NoMe governance commit's compile-only pre-commit check passed. No
  Simulator or device was enumerated or used.
- Isolated-HOME plan, digest-confirmed apply, and global check passed.
- Real HOME remained dry-run only with plan digest
  `4e53f7fa3a54f16878382a129e6e3395db37f3196015d74a66df6ddf6a1309d`;
  managed-path digests were unchanged.

Machine receipts and SHA-256 values:

| Acceptance | Receipt | SHA-256 |
| --- | --- | --- |
| `GW-EXIT-01` | `artifacts/repair2-exit.json` | `d2988124a24231713ad09b91b7045061a5f74d5705dcbbde9a2f495396d93b0a` |
| `GW-EVIDENCE-01` | `artifacts/repair2-evidence.json` | `311af4bb1db14eb581d5fe9e696ba6805bc785cd8f3abd468b8440803fc2b890` |
| `GW-BOOTSTRAP-01` | `artifacts/repair2-bootstrap.json` | `eecf1c683166837b89bd0a4e10f08dbf1db6f28b7819cff987252154044459f9` |
| `GW-ADOPT-01` | `artifacts/repair2-adoption.json` | `f1d3c82f16cc3d20dfdc8929d3a5212a9829c25bc5a1974016f30478ad212c66` |
| `GW-PILOT-01` | `artifacts/repair2-pilots.json` | `13c96587478637d5b9d530ba438c80effc0a4acd74c468c9aabcbe58b0128e7b` |

## Independent re-review focus

The reviewer must inspect the exact identities above, the historical findings,
the repair diff, and the runner-produced receipts. Run from the governance
worktree:

```sh
PATH="/opt/homebrew/opt/node@22/bin:$PATH" pnpm check
PATH="/opt/homebrew/opt/node@22/bin:$PATH" REAL_PROJECT_DRY_RUN=1 pnpm vitest run tests/integration/real-project-dry-run.test.ts
PATH="/opt/homebrew/opt/node@22/bin:$PATH" ./node_modules/.bin/tsx src/cli/main.ts task verify --input .delivery/tasks/global-workflow-repair/candidate.json
```

The implementation owner must not issue the acceptance decision. The reviewer
must write a schema-valid artifact at
`.delivery/tasks/global-workflow-repair/review-repair2.json` and validate it
through `task review` against the exact candidate.

## Current workspace state and limits

- EngineeringGovernance work is on `codex/global-workflow-implementation` in
  `.worktrees/global-workflow-implementation`.
- ProjTrav retains the pre-existing dirty Phase 2B handoff, server evidence/test
  copies, and iOS Qoder/Xcode/TestResults paths outside governance commits.
- NoMe retains untracked handoff and planning documents outside the governance
  commit.
- The real global Codex home has not been mutated by this candidate.
- The recorded authorization expires at `2026-07-30T00:00:00Z` and does not
  include real-HOME installation. The CLI uses process time and rejects stale
  or caller-timed authorization.

## Next permitted action

Obtain an independent R3 re-review of the exact repair candidate. A
finding-free review may advance to local merge and fresh main-branch checks.
Applying the reviewed plan to the real Codex home requires a new explicit
authorization whose scope names that exact mutation. Tagging, publishing,
pushing, deployment, migration, or external communication remain unauthorized.
