# Global Workflow Pilot Results

Status: passed on implementation candidate; independent candidate review pending
Date: 2026-07-29
Candidate base: `77866c9a78dd14bb76dc3b31239fee7abde98d9b`

## Candidate revision

The first independent review of `db0c8c3` returned `REPAIR_REQUIRED`; commit
`5ee1a70` repaired its four findings. The second review then found two remaining
P1 trust-boundary defects: a full receipt could still be hand-authored while
caller-declared check IDs inherited one aggregate exit code, and `task review`
used a raw-file digest instead of the frozen canonical candidate digest.
Commit `77866c9` replaced caller IDs with a single command-derived identity,
requires explicit approval of the exact replay-plan digest before any fresh
execution, replays the approved command, and uses one canonical candidate digest
through candidate, review, and closure.

## Execution

Command:

```sh
pnpm vitest run tests/integration/pilots.test.ts
```

Result: 3 pilot tests passed. Each pilot spawned the real `src/cli/main.ts` process and asserted its process exit status and JSON decision.

## R1 local pilot

- `task start` derived `R1` and returned no standalone contract artifact.
- A temporary repository executed `node --test behavior.test.mjs` with exit 0.
- `task verify` accepted the lightweight result only after the pilot had observed the fresh command.
- No deployment, remote mutation, or durable task bundle was created.

## R2 review and repair pilot

- `task start` derived `R2` and emitted a frozen contract.
- A first implementation commit and evidence-only closure commit passed candidate artifact and exact Git commit/tree identity verification.
- Self-review was rejected with `INDEPENDENT_REVIEW_REQUIRED`.
- A distinct review identity reported `R2-F-01`; advancement was rejected with `BLOCKING_FINDING:R2-F-01`.
- The original implementation owner created the repair commit, regenerated raw execution evidence, and created a new evidence-only closure commit.
- The repaired candidate passed verification; a distinct finding-free review decision and coherent close input passed.

The reviewer identity in this automated pilot tests authority enforcement. It is not an independent human or agent review of the EngineeringGovernance repository candidate.

## R3 authorization pilot

- `task start` derived `R3` for a production-risk signal, but the action remained confined to a temporary repository target.
- Complete evidence and Git identity did not bypass missing authorization: `USER_AUTHORIZATION_REQUIRED` was returned.
- A boolean-only approval was rejected with `AUTHORIZATION_RECORD_REQUIRED`.
- An exact active user authorization for `temporary-project:r3-pilot` passed.
- A different requested target was rejected with `AUTHORIZATION_SCOPE_MISMATCH`.
- An authorization checked at its expiry boundary was rejected with `AUTHORIZATION_EXPIRED`.
- Caller-supplied authorization and evidence verification clocks were rejected;
  the CLI used process time, and evidence freshness could not be widened beyond
  the 24-hour policy ceiling.

No production system, external service, deployment, database, Simulator, or physical device was touched.

## Candidate-wide verification

- Node 22 `pnpm check`: 25 test files passed, 1 environment-gated test skipped;
  107 tests passed, 1 skipped; typecheck, build, placeholder, and license checks
  passed.
- `REAL_PROJECT_DRY_RUN=1` real-project integration: 1/1 passed against the
  current ProjTrav and NoMe repositories without mutation.
- Project-pinned runner checks passed for EngineeringGovernance, ProjTrav, and
  NoMe.
- A digest-confirmed global install and check passed in an isolated HOME.
- The installed launcher executed successfully when
  `ENGINEERING_GOVERNANCE_ROOT` named the candidate worktree.
- The real user HOME global install remained dry-run only. Plan digest
  `fca628a5ddcae3b2595b4b7badb4807f4aa9051fe06ac95d80305c6f9d23f2ae`
  was recorded and every managed-path digest remained unchanged.
- All acceptance observations are bound to one command-derived check identity
  per `sop-command-execution-v1` receipt. Verification executes nothing until
  the caller approves exact replay plan
  `99050046e585e0269a6c61ebb7bfd848a9a6f89e2f97b704264b6e8f38c82b3f`,
  then freshly replays those commands. Handwritten PASS lists, failed static
  receipts, forged trees, reduced repository identity sets, semantic candidate
  drift, replay-plan drift, and incoherent closure inputs are rejected.

## Remaining gate

These pilots establish workflow behavior on temporary repositories. They do not independently accept the current R3 implementation candidate or the real ProjTrav/NoMe adoption commits.
