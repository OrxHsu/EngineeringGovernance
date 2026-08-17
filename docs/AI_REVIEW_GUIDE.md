# AI-Assisted Independent Contract Review

The independent reviewer examines the exact frozen contract. The author
self-review helps comparison but has no acceptance authority.

## Request

After task start has created the canonical contract in `DEFINED`, generate the
provider-neutral review packet:

```sh
pnpm sop -- task contract-review-request \
  --project /absolute/path/to/project \
  --task-id example-task
```

Give the returned prompt to an AI actor that is distinct from both the contract
author and implementation owner. The reviewer must not edit the contract or
implementation.

## Review Artifact

Complete the normal contract-review-v2 checklist, applicable R3 requirements,
evidence references, findings, and decision. For mutual-review contracts also
complete `assistedReview`:

- six focused checklist observations;
- the six comparison dimensions in canonical self-review order;
- exact copied self statuses and independent reviewer statuses;
- agreement rate, missed concerns, and overcautious concerns.

The verifier recomputes the comparison. `ACCEPTED` cannot coexist with a FAIL,
a finding, a stale contract identity, or a non-independent reviewer. A failed
dimension produces one consolidated, mechanically testable repair finding; the
reviewer does not invent unrelated requirements.

## User Scan

Verify the canonical artifact, then render its short conclusion:

```sh
pnpm sop -- task contract-review --input /absolute/project/.delivery/tasks/example-task/contract-review.yaml
pnpm sop -- task review-summary --project /absolute/project --task-id example-task
```

The summary is read-only. The user still decides whether an accepted contract
may advance, and the owner uses the normal exact-plan transition afterward.
