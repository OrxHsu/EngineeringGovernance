# Global Workflow Pilot Results

Status: passed on implementation candidate; independent candidate review pending
Date: 2026-07-29
Candidate base: `5ee1a70bdbd32a5c5e9044c522757801e0d43df1`

## Candidate revision

The independent review of the preceding `db0c8c3` candidate returned
`REPAIR_REQUIRED`. It found that evidence could still be authored as a PASS
list, candidate/review/closure decisions trusted caller summaries, generated
ProjTrav targets were absent from adoption guards, and the portable launcher
could continue under unsupported Node versions. Commit `5ee1a70` repaired all
four boundaries and added permanent adversarial coverage.

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
  102 tests passed, 1 skipped; typecheck, build, placeholder, and license checks
  passed.
- `REAL_PROJECT_DRY_RUN=1` real-project integration: 1/1 passed against the
  current ProjTrav and NoMe repositories without mutation.
- Project-pinned runner checks passed for EngineeringGovernance, ProjTrav, and
  NoMe.
- A digest-confirmed global install and check passed in an isolated HOME.
- The installed launcher executed successfully when
  `ENGINEERING_GOVERNANCE_ROOT` named the candidate worktree.
- The real user HOME global install remained dry-run only. Plan digest
  `4e53f7fa3a54f16878382a129e6e3395db37f3196015d74a66df6ddf6a1309d`
  was recorded and every managed-path digest remained unchanged.
- All acceptance observations are bound to runner-produced
  `sop-command-execution-v1` receipts. Handwritten PASS lists, forged trees,
  reduced repository identity sets, drifted candidate/review digests, and
  incoherent closure inputs are rejected.

## Remaining gate

These pilots establish workflow behavior on temporary repositories. They do not independently accept the current R3 implementation candidate or the real ProjTrav/NoMe adoption commits.
