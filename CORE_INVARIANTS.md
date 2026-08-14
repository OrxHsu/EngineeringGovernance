# Global Development Core Invariants

Status: canonical development policy

Version: 2.0.0

These rules apply to every adopted project. Project rules may add constraints
but may not silently weaken these invariants.

Contract readiness is a global gate for new R2/R3 work; it is not a Phase 2D
special case.

| ID | Class | Invariant |
|---|---|---|
| `CORE-AUTH-01` | non_waivable | The versioned global governance package is the only authority for global workflow policy; adapters and Skills do not redefine it. |
| `CORE-OWNER-01` | non_waivable | Every mutating task has exactly one active implementation owner. |
| `CORE-OWNER-02` | non_waivable | Independent reviewers do not modify the candidate they review; doing so invalidates independence for that candidate. |
| `CORE-CONTRACT-01` | non_waivable | Implementation and review use the same visible frozen contract and acceptance IDs. |
| `CORE-CONTRACT-02` | non_waivable | A newly created R2/R3 schema-v2 task cannot enter `IN_PROGRESS` until an independent local-claim reviewer accepts the exact canonical contract-readiness artifact; R1 remains owner-only and pre-gate v2 history is grandfathered. |
| `CORE-CONTRACT-03` | non_waivable | Contract readiness is a completeness review, not a self-review: the contract author, implementation owner, and independent reviewer remain separate roles. |
| `CORE-EVIDENCE-01` | non_waivable | A completion or PASS claim requires fresh evidence from the real path being claimed; agent self-report is not evidence. |
| `CORE-EVIDENCE-02` | non_waivable | Compile, static, unit, integration, device, cloud, and production evidence remain distinct and cannot silently substitute for one another. |
| `CORE-EVIDENCE-03` | non_waivable | Evidence summaries are recomputed from non-empty underlying execution records bound to the frozen contract and implementation identities. |
| `CORE-STATE-01` | non_waivable | A task cannot enter CANDIDATE, ACCEPTED, or CLOSED with a failing or non-exempt pending required gate. |
| `CORE-GRAPH-01` | non_waivable | Active v2 task state is derived from one append-only ledger whose transitions enforce state-specific actor authority and whose canonical candidate, verification, review, and closure references bind exact artifact bytes and one task identity. |
| `CORE-EXT-01` | non_waivable | Enabled project extensions are registry-backed, version-and-digest bound, may only strengthen core policy, and remain enforced through every declared lifecycle hook. |
| `CORE-SOURCE-01` | non_waivable | External implementation sources default to independent mode; inspection, adaptation, or exact copying requires a frozen exact allocation, complete actual-use records, and an approved project release disposition. |
| `CORE-TRUST-01` | non_waivable | A local actor or approval string is only a recorded local claim; the runner must not present it as cryptographically authenticated identity or external authorization. |
| `CORE-REVIEW-01` | non_waivable | R2 and R3 acceptance requires a reviewer who did not implement the reviewed candidate. |
| `CORE-FINDING-01` | non_waivable | Every later finding is classified as contract violation, newly discovered defect, or new requirement without rewriting history. |
| `CORE-REPAIR-01` | non_waivable | A failed review triggers a horizontal check of sibling paths and the affected trust boundary before one consolidated repair record is issued. |
| `CORE-SAFETY-01` | non_waivable | Unrelated user or other-agent work is preserved; no reset, clean, stash, broad staging, or overwrite is inferred from an ordinary task. |
| `CORE-SAFETY-02` | user_authorization_required | Production mutation, destructive action, deployment, migration, billing action, external communication, and restricted runtime/device execution require explicit scoped authorization. |
| `CORE-EXIT-01` | non_waivable | Project unadoption is an explicit dry-run-first operation that removes only unchanged governance-managed material and preserves task/evidence history and unrelated project content. |
| `CORE-BLOCKED-01` | non_waivable | Test failures, unfinished implementation, and debugging difficulty are not external blockers. |
| `CORE-LEARNING-01` | default | Repeated defect classes are converted into durable tests, static checks, or CI gates when technically feasible. |

Only rules classified `waiverable` or `default` may use an exception record.
Rules classified `user_authorization_required` require approval for the exact
action and target; a standing workflow exception does not provide that approval.
