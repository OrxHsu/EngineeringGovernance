---
name: delivery-sop
description: Operate development tasks through an adopted Engineering Governance project policy and CLI. Use whenever Codex starts, implements, verifies, reviews, repairs, accepts, or closes a repository change, including resumed work and external-agent candidate review.
---

# Delivery SOP

Use the installed `sop` CLI as the workflow authority. Do not restate or invent
global policy in this Skill.

## Establish project state

1. Locate the repository root and applicable agent instructions.
2. Read `.delivery/policy.yaml` and every extension it declares.
3. Run `sop check <absolute-project-path>` before mutating work.
4. Stop when the policy is missing, invalid, drifted, or names an unavailable
   pinned runner. Report the exact failure code and do not simulate a pass.

## Start or resume work

1. For a new task, prepare the explicit YAML input and run
   `sop task start --input <absolute-input-path>`.
2. Report the CLI-derived risk, state, required artifacts, and authorization
   gates. Do not infer a lower risk from task size.
3. For resumed work, read the existing task artifacts and confirm their policy,
   contract, owner, state, and implementation identities before continuing.
4. Keep the single recorded implementation owner through repair. A reviewer
   inspects the candidate but does not edit it.

## Verify, review, and close

1. Run the project's required fresh checks in the evidence environments named
   by its frozen contract.
2. Evaluate candidate eligibility with
   `sop task verify --input <absolute-input-path>`.
3. For an independent review, evaluate authority and blocking findings with
   `sop task review --input <absolute-input-path>`.
4. If repair is required, return one consolidated finding set to the recorded
   implementation owner and preserve the same contract.
5. Evaluate closure with `sop task close --input <absolute-input-path>` and
   report the resulting state, exact identities, verified checks, remaining
   unknowns, next stage, and whether user action is required.

Stop on a blocked authorization instead of performing the restricted action.
Do not mutate production or external systems through this Skill.
