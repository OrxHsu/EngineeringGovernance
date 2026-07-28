# Global Workflow Implementation Handoff

Status: Third Independent Review Pending
Updated: 2026-07-29
Implementation owner: Codex in task `019fa9ea-1ddb-7513-a2df-05b5585c10ba`

## Frozen authority and candidate

- Contract: `.delivery/tasks/global-workflow-repair/contract.yaml`
- Contract digest: `29398532b2deb3c9c2a50605f5dd1cf4e8324ea217b31c3d59f9e8a3d04df66a`
- Candidate: `.delivery/tasks/global-workflow-repair/candidate.json`
- Candidate canonical digest: `2d96867cb32dc74d204360b81d27aa04219f2f48957d73131117c0bd8c5edbb9`
- Evidence: `.delivery/tasks/global-workflow-repair/evidence.json`
- Approved replay-plan digest: `99050046e585e0269a6c61ebb7bfd848a9a6f89e2f97b704264b6e8f38c82b3f`
- First review: `.delivery/tasks/global-workflow-repair/review.json`
- Second review: `.delivery/tasks/global-workflow-repair/review-repair2.json`
- Third review output: `.delivery/tasks/global-workflow-repair/review-repair3.json`
- Implementation commit: `77866c9a78dd14bb76dc3b31239fee7abde98d9b`
- Evidence closure commit: `15a9adfa55ef29a61124b4f167b1150f1cbb10e9`
- Governance digest: `f85636fecdfff9ff4729e5b8afcf684c060c0fe1fc1e221896f0482f14e23821`
- Runner SHA-256: `f533b20f75d19421ae9a037e014caf6cecbdad4480ae9e215b83aa87423d2d99`

## Exact cross-repository implementation identities

| Repository | Commit | Tree |
| --- | --- | --- |
| EngineeringGovernance | `77866c9a78dd14bb76dc3b31239fee7abde98d9b` | `a528f2aa42141977440c1a67e9a28b1f4c51f9da` |
| ProjTrav workspace | `65cd98a6a64109840b47c47a33d6bf7cddd8b8bd` | `d5f3c3e70b5445c847b6661789f2c928e3abaf0b` |
| ProjTrav server | `c379baeccb46443f6d1b4602769268ed5777cc5c` | `fcf1490a7d91518fe316e1d1730da4026126680d` |
| ProjTrav iOS | `d675c54d81f149681b6b642eaa0b6ec63884a91e` | `e687d82e72a673fd543c84a313db1a9f0c5b24e8` |
| NoMe V2 | `1b41a9f205a59be4fee54a7588891e04307b902b` | `5c0c62d67238f38f782539f57a461b8c7e9c7712` |

## Review history and current repairs

The first independent review reported four findings. The second review confirmed
that exact Git commit/tree sets, ProjTrav generated-target guards, and the
portable Node 22 gate were closed, but retained two P1 blockers.

Commit `77866c9` repairs those remaining blockers:

1. Caller-defined check IDs are rejected. Each receipt contains exactly one
   check ID derived from its normalized executable, arguments, and working
   directory.
2. Candidate verification initially executes nothing and returns the canonical
   replay-plan digest. Only explicit approval of that exact digest permits
   fresh command replay. A full-format receipt whose real command fails is
   rejected.
3. Candidate and review identity use the same canonical structured digest;
   formatting-only changes are stable and semantic changes fail. Exact file
   bytes remain separately bound by closure SHA-256 references.
4. Accepted review and closure artifacts bind the same replay-plan digest, so
   replay approval cannot drift between candidate, review, and close.

## Fresh evidence

- Node 22 `pnpm check`: 25 test files passed, 1 skipped; 107 tests passed,
  1 skipped; typecheck, build, placeholder, and license checks passed.
- Focused evidence suite: 4 files and 21 tests passed.
- R1/R2/R3 real-CLI pilots: 3/3 passed.
- Real ProjTrav/NoMe adoption dry-run: 1/1 passed with zero mutation.
- EngineeringGovernance, ProjTrav, and NoMe pinned checks returned
  `{ "valid": true, "errors": [] }` after adoption refresh.
- ProjTrav docs sync passed; physical catalog remained 233 tables with digest
  `69c77bf60898366e6ad4002f6b71ef62aca9ad9bfbc4c762c0946ef90789ce0c`;
  entity manifest remained 326 entities, 233 tables, 233 operations with digest
  `a9323f876740788f7dbf4e89cf5396810d525385238eae24a5523ba8ae0cf621`.
- The NoMe governance commit's compile-only pre-commit check passed. No
  Simulator or device was enumerated or used.
- Isolated-HOME plan, exact-digest apply, and global check passed.
- Real HOME remained dry-run only with plan digest
  `fca628a5ddcae3b2595b4b7badb4807f4aa9051fe06ac95d80305c6f9d23f2ae`;
  managed paths were unchanged.
- Candidate verification without replay approval exited 1 and returned only
  `EVIDENCE_REPLAY_APPROVAL_REQUIRED:99050046...`.
- Candidate verification with the exact approved replay digest freshly reran
  all five commands and returned `{ "valid": true, "errors": [] }`.

| Acceptance | Receipt | SHA-256 |
| --- | --- | --- |
| `GW-EXIT-01` | `artifacts/repair3-exit.json` | `4b618fa27b061705344cb55be7bcbbcf1c4b37b45de442a549f501abd351c89d` |
| `GW-EVIDENCE-01` | `artifacts/repair3-evidence.json` | `ab221e6a8e9349ca52a321d5c8294722a7a8249b479339c4bbca371a0c7626f7` |
| `GW-BOOTSTRAP-01` | `artifacts/repair3-bootstrap.json` | `4b8da5a91ce31fe352ca28ef18937076a067c014b29eca9af363f9c8360d292c` |
| `GW-ADOPT-01` | `artifacts/repair3-adoption.json` | `ec136caee5c14c60dc4bd67dde8005d91c2084650c373b831cfc6d84415ca7ed` |
| `GW-PILOT-01` | `artifacts/repair3-pilots.json` | `2a77e7c632a1b75af5f6d98288e62e073a1b42e854a2659b230f0b44164ba4d5` |

## Independent review procedure

From the governance worktree:

```sh
PATH="/opt/homebrew/opt/node@22/bin:$PATH" pnpm check
PATH="/opt/homebrew/opt/node@22/bin:$PATH" REAL_PROJECT_DRY_RUN=1 pnpm vitest run tests/integration/real-project-dry-run.test.ts
PATH="/opt/homebrew/opt/node@22/bin:$PATH" ./node_modules/.bin/tsx src/cli/main.ts task verify --input .delivery/tasks/global-workflow-repair/candidate.json
PATH="/opt/homebrew/opt/node@22/bin:$PATH" ./node_modules/.bin/tsx src/cli/main.ts task verify --input .delivery/tasks/global-workflow-repair/candidate.json --approve-replay 99050046e585e0269a6c61ebb7bfd848a9a6f89e2f97b704264b6e8f38c82b3f
```

The reviewer must inspect every command before approving the replay digest.
The review artifact must include both the exact candidate canonical digest and
the approved replay-plan digest, all five commit/tree identities, and a finding-
free `ACCEPTED` decision or a consolidated `REPAIR_REQUIRED` finding set. It
must be validated through the real artifact-bound `task review` path.

## Current workspace limits

- ProjTrav retains the pre-existing dirty Phase 2B handoff, server evidence/test
  copies, and iOS Qoder/Xcode/TestResults paths outside governance commits.
- NoMe retains untracked handoff and planning documents outside the governance
  commit.
- The real global Codex home has not been mutated.
- Current authorization expires at `2026-07-30T00:00:00Z` and does not include
  real-HOME installation.

## Next permitted action

Obtain a third independent R3 review of this exact candidate. A finding-free
review may advance to local merge and fresh main-branch checks. Real-HOME apply
requires a new explicit authorization naming that exact mutation. Tagging,
publishing, pushing, deployment, migration, and external communication remain
unauthorized.
