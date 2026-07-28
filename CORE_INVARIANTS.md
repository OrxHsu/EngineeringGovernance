# Global Development Core Invariants

Status: canonical development policy

Version: 1.0.0

These rules apply to every adopted project. Project rules may add constraints
but may not silently weaken these invariants.

| ID | Class | Invariant |
|---|---|---|
| `CORE-AUTH-01` | non_waivable | The versioned global governance package is the only authority for global workflow policy; adapters and Skills do not redefine it. |
| `CORE-OWNER-01` | non_waivable | Every mutating task has exactly one active implementation owner. |
| `CORE-OWNER-02` | non_waivable | Independent reviewers do not modify the candidate they review; doing so invalidates independence for that candidate. |
| `CORE-CONTRACT-01` | non_waivable | Implementation and review use the same visible frozen contract and acceptance IDs. |
| `CORE-EVIDENCE-01` | non_waivable | A completion or PASS claim requires fresh evidence from the real path being claimed; agent self-report is not evidence. |
| `CORE-EVIDENCE-02` | non_waivable | Compile, static, unit, integration, device, cloud, and production evidence remain distinct and cannot silently substitute for one another. |
| `CORE-EVIDENCE-03` | non_waivable | Evidence summaries are recomputed from non-empty underlying execution records bound to the frozen contract and implementation identities. |
| `CORE-STATE-01` | non_waivable | A task cannot enter CANDIDATE, ACCEPTED, or CLOSED with a failing or non-exempt pending required gate. |
| `CORE-REVIEW-01` | non_waivable | R2 and R3 acceptance requires a reviewer who did not implement the reviewed candidate. |
| `CORE-FINDING-01` | non_waivable | Every later finding is classified as contract violation, newly discovered defect, or new requirement without rewriting history. |
| `CORE-REPAIR-01` | non_waivable | A failed review triggers a horizontal check of sibling paths and the affected trust boundary before one consolidated repair record is issued. |
| `CORE-SAFETY-01` | non_waivable | Unrelated user or other-agent work is preserved; no reset, clean, stash, broad staging, or overwrite is inferred from an ordinary task. |
| `CORE-SAFETY-02` | user_authorization_required | Production mutation, destructive action, deployment, migration, billing action, external communication, and restricted runtime/device execution require explicit scoped authorization. |
| `CORE-BLOCKED-01` | non_waivable | Test failures, unfinished implementation, and debugging difficulty are not external blockers. |
| `CORE-LEARNING-01` | default | Repeated defect classes are converted into durable tests, static checks, or CI gates when technically feasible. |

Only rules classified `waiverable` or `default` may use an exception record.
Rules classified `user_authorization_required` require approval for the exact
action and target; a standing workflow exception does not provide that approval.
