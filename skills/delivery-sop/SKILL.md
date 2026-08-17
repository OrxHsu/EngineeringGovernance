---
name: delivery-sop
description: Operate development tasks through an adopted Engineering Governance project policy and CLI. Use whenever Codex starts, implements, verifies, reviews, repairs, accepts, or closes a repository change, including resumed work and external-agent candidate review.
---

# Delivery SOP

Use the installed `~/.codex/bin/sop` launcher as the workflow authority. Do not
restate or invent global policy in this Skill.

## Establish project state

1. Locate the repository root and applicable agent instructions.
2. Read `.delivery/policy.yaml` and every extension it declares when present.
3. Stop when the policy is missing for ordinary project work. The only permitted
   bootstrap mutation is a reviewed, dry-run-first
   `~/.codex/bin/sop adopt <absolute-project-path> --runner-bundle <absolute-runner-archive>`
   plan applied with its exact digest; ordinary project mutation remains blocked
   until the pinned runner and adoption checks pass.
4. Run `~/.codex/bin/sop check <absolute-project-path>` before mutating work.
5. Stop when the policy is invalid, drifted, or names an unavailable pinned
   runner. Report the exact failure code and do not simulate a pass.
6. If check reports a task as legacy inspect-only, preserve it as history. Do
   not run v2 mutation, review, or closure commands against that task; follow
   the package migration guide or start a new v2 task.

## Start or resume work

1. For a new beta1 mutating task, first run the read-only
   `~/.codex/bin/sop task preflight --project <absolute-project-path> --input <absolute-input-path>`.
   The preflight plan binds input bytes, semantic design bindings, authority
   identities, repository baselines, risk, authorization, and actor standing.
   Do not start when it is invalid.
2. Prepare a schema-v2 YAML input and run
   `~/.codex/bin/sop task start --project <absolute-project-path> --input <absolute-input-path> --preflight-plan <preflight-digest>`.
   Beta1 start must consume the exact unchanged preflight plan digest.
3. Inspect the returned start plan, then apply only its exact unchanged digest.
   The runner creates the contract and ledger at their canonical paths. Report
   the CLI-derived risk, state, required artifacts, and authorization gates. Do
   not infer a lower risk from task size.
4. Before implementation, use `~/.codex/bin/sop task transition --input
   <absolute-input-path>` to inspect the owner transition to `IN_PROGRESS`, then
   apply only its exact unchanged digest. Use the same dry-run/apply operation
   for owner transitions to `CANDIDATE`, `BLOCKED`, `CANCELLED`, or
   `SUPERSEDED`; the `CANDIDATE` input binds its canonical candidate and
   verification artifacts.
5. For resumed work, read the existing task artifacts and confirm their policy,
   contract, owner set, state, and implementation identities before continuing.
6. Keep the frozen implementation-owner set through repair. Each mutation and
   transition must identify exactly one acting owner from that set. A reviewer
   inspects the candidate but does not edit it.

## Verify, review, and close

1. Run the project's required fresh checks in the evidence environments named
   by its frozen contract.
2. Capture supported local execution evidence with
   `~/.codex/bin/sop task execute --input <absolute-input-path>`; name one exact
   executable and argument vector, omit caller-defined check IDs, and do not use
   a shell. The runner derives the command check identity.
3. Evaluate the canonical candidate with
   `~/.codex/bin/sop task verify --input <absolute-candidate-path>`. Verification
   consumes persisted receipts and executes no candidate-controlled command.
   Persist an eligible result with `--persist`, then use the owner transition
   command to move the ledger to `CANDIDATE`.
4. When the contract requires replay, run `task replay --input
   <absolute-candidate-path>` to inspect the plan, then apply only its exact
   unchanged digest with `--apply-plan <digest>`. Replay is never hidden inside
   verify, review, or close.
5. For an independent review, evaluate the canonical review artifact with
   `~/.codex/bin/sop task review --input <absolute-review-path>`. The review
   binds the exact contract, candidate, verification, implementation identities,
   and ledger state. Apply a returned transition only with its exact reviewed
   plan digest.
6. If repair is required, return one consolidated finding set to the recorded
   implementation-owner set and preserve the same contract.
7. Evaluate the canonical closure artifact with
   `~/.codex/bin/sop task close --input <absolute-closure-path>`. Closure binds
   the accepted ledger event, candidate, verification, review, status artifacts,
   and next action. Apply its transition only with the exact reviewed plan digest.

At every beta1 boundary, query `~/.codex/bin/sop accountability status --project
<absolute-project-path> --actor <id-or-alias>` when actor eligibility matters.
Standing is recomputed from the policy-anchored append-only registry and event
chain; caller-supplied role, standing, alias, reward, or stale plan values are
not authority. Sanctions remain active until the frozen, user-authorized,
risk-matched remediation and reinstatement requirements are evidenced.

When the governance tool or review lifecycle is itself blocked, do not fabricate
a task transition. Prepare an exact user-authorized incident input and use
`~/.codex/bin/sop accountability incident-record --project <absolute-project-path>
--input <absolute-input-path>` followed by its unchanged `--apply-plan` digest.
This path records responsibility and deduction in the accountability event chain
without treating the blocked task or review as accepted.

For a pinned-runner bootstrap remediation, keep the standard lifecycle
authorization in candidate authorization arrays and validate any richer
remediation sidecar independently. Require the exact CANDIDATE ledger event to
consume both mutually bound artifacts once; never grant the exception from a
task ID or action string alone.

Stop on a blocked authorization instead of performing the restricted action.
Do not mutate production or external systems through this Skill.
