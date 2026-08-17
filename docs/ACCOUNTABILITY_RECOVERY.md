# Accountability Recovery

Beta3 recovery is faster but remains evidence-bound. The five standings are:

| Standing | Active score | Ordinary boundary |
| --- | ---: | --- |
| `GOOD_STANDING` | 0-2 | Normal role permissions |
| `WARNING` | 3-4 | R0/R1; supervised R2; no R3 or independent review |
| `WATCH` | 5-7 | R0/R1 and supervised R2; no review role |
| `PROBATION` | 8-11 | Authorized supervised remediation only |
| `SUSPENDED` | 12+ or forced | Exact user-authorized remediation only |

Recovery requirements are progressive: WARNING needs one clean task; WATCH
needs one supervised clean R2/R3 task; PROBATION additionally requires an
authorized remediation and gates for every unresolved defect class; SUSPENDED
requires those controls, two supervised clean R2/R3 tasks, and explicit user
reinstatement authorization. The full estimated path is four tasks from
PROBATION and five from SUSPENDED.

A task is clean only when all of these are recomputed from the real task path:

- The validated schema-v2 ledger ends at `CLOSED` and contains no repair,
  blocked, cancelled, or superseded transition.
- Contract review and implementation review are both `ACCEPTED` with no
  findings.
- There is one evidence run; every frozen acceptance ID has one valid receipt,
  exit code zero, and no policy errors.
- Candidate, verification, evidence, receipt, and authorization references
  retain their exact digests.
- R0 tasks never earn recovery credit.

Inspect a task and view the current plan with:

```sh
pnpm sop -- task verify-clean --project /absolute/path/to/project --task-id <task-id>
pnpm sop -- accountability recovery-plan --project /absolute/path/to/project --actor <actor-id>
```

Both commands are read-only. A reported credit is eligibility evidence, not a
score mutation. Standing changes still require an authorized accountability
event and, where applicable, complete permanent gates.
