# Global Workflow Pilot Results

Status: passed on implementation candidate; independent candidate review pending
Date: 2026-07-29
Candidate base: `da5f19434740defa76c02ea74a3eed6f7d342266`

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
- A first implementation commit and evidence-only closure commit passed candidate artifact and Git identity verification.
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

No production system, external service, deployment, database, Simulator, or physical device was touched.

## Remaining gate

These pilots establish workflow behavior on temporary repositories. They do not independently accept the current R3 implementation candidate or the real ProjTrav/NoMe adoption commits.
