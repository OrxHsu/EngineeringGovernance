# Global Development Workflow SOP

Status: canonical development policy

Version: 2.1.0

## 1. Applicability and authority

This SOP applies to every adopted project and development agent. Platform/system
constraints and explicit current user instructions remain higher priority. The
global core invariants apply above project workflow extensions. Project product,
architecture, data, and operations documents continue to own their domains.

Agent entrypoints, Skills, prompts, templates, and generated rules are adapters.
They must point to this package version and digest rather than evolve a parallel
workflow.

A project owner may leave a project unadopted and use another workflow. Once a
project is adopted, agents must not silently bypass its pinned policy. Leaving
the SOP uses `sop unadopt <project>` as a read-only plan followed by the exact
unchanged `--apply-plan <digest>`. Unadoption preserves `.delivery/tasks/**`,
`.delivery/evidence/**`, Git history, and unrelated project content.

## 2. Default operating model

Every mutating task has one or more explicitly recorded implementation owners.
Each mutation and lifecycle transition records exactly one acting owner from
that frozen set. The owner set investigates, implements, debugs, verifies, and
prepares the candidate end to end; adding an owner is a contract change, not an
informal handoff.

Independent review is proportional to risk:

- R0: read-only conclusion;
- R1: owner verification is sufficient unless project policy raises the gate;
- R2: one independent review is required;
- R3: a frozen contract, specialized evidence, authorization where applicable,
  and independent review are required.

## 3. Task definition

Before mutation, determine risk, implementation owners, objective, scope,
non-goals, authoritative inputs, acceptance observations, positive/negative
cases, required evidence kinds, open implementation choices, and legitimate
blockers.

`task start` is dry-run-first. It binds the adopted project, current checkout,
enabled extension identities, frozen commands, and initial ledger event into one
plan. Only the exact unchanged `--apply-plan <digest>` creates the canonical
contract and ledger; existing targets, path indirection, or intervening drift
fail without overwrite.

R2/R3 requirements are frozen before implementation. Requirements and review
criteria are identical. Natural-language properties such as secure, private,
bound, executed, or complete require observable checks.

### Contract readiness before implementation

For newly created schema-v2 R2/R3 tasks, the contract author and all implementation
owners are not the contract-readiness approver. Before `DEFINED -> IN_PROGRESS`,
an independent reviewer runs `task contract-review --input` against the exact
`.delivery/tasks/<task-id>/contract-review.yaml` artifact. The artifact binds
the task, risk, reviewer, raw contract SHA-256, semantic contract digest, nine
completeness categories, all applicable R3 categories, evidence references, and
one consolidated finding set. `ACCEPTED` requires every required item to pass
and no findings; `REPAIR_REQUIRED` cannot start implementation. Findings are
classified as `contract_violation`, `newly_discovered_defect`, or
`new_requirement` and return to the contract author as one repair record.
The contract author cannot act as the independent reviewer. An optional
input-bound author self-review is advisory only and never grants acceptance,
implementation authority, or a lifecycle transition.

The gate is a global rule, not a Phase 2D rule. New R3 `task start` plans fail
before writing a contract unless the input already contains the preflight-bound
author self-review and known-issues structure required by the downstream review
request. R1 tasks keep the simpler owner
transition. A task may remain `DEFINED` while waiting for review. A markerless
R2/R3 schema-v2 contract is grandfathered only when its contract is `sopVersion:
2.0.0`, its `policyDigest` equals the frozen pre-gate digest
`eba8165bd069c0e85e5b08217ea260e7b027e85158404a50644c03b57a909aca`, and its
ledger begins with sequence-1 `null -> DEFINED`; otherwise it is invalid and
cannot bypass readiness. Such historical evidence is not rewritten; v1 remains
inspect-only. Returning from
`REPAIR_REQUIRED` may reuse the accepted readiness artifact only if the exact
contract bytes and semantic digest are unchanged; drift requires a new review.

Contract-readiness uses both identities deliberately: the semantic digest is
the contract identity used by normal candidate/review binding, while the raw
SHA-256 prevents an unreviewed byte-level edit before implementation. Thus even
formatting-only edits require a fresh readiness review.

For R3, trust/threat analysis and migration/recovery/rollback are always
applicable. Specialized gates, scoped authorization, and production observation
are mechanically applicable from the frozen risk signals, authorization list,
and production/deployment flags; an `NA` entry must carry the exact permitted
reason. Local actor and approval strings remain `local-claim`, not authenticated
identity or external authorization. External-source provenance remains
default-deny and requires exact allocation, actual-use, and release records.
The global package does not grant access to TREK implementation material or
turn a project-specific source boundary into a global product requirement.

### Beta1 contract preflight and accountability

Beta1 task inputs are read-only preflighted before `task start`. The preflight
binds the input raw SHA-256, semantic digest, policy identity, repository
baselines, authority bytes, design bindings, risk, authorization requirements,
and actor eligibility into one plan digest. Start consumes only that exact plan;
missing, stale, changed-byte, cross-project, or caller-supplied plans fail
without creating a task or consuming authorization.

### Beta2 mutual-review assistance

Beta2 review assistance is explicitly enabled only when a task input contains
both `selfReview` and `knownIssues`. Existing beta1 inputs retain their prior
ten-check preflight. An enabled input adds source/test pairing, R3
security/compatibility/rollback coverage, bounded scope-to-acceptance warnings,
and exact self-review validation. The self-review ID binds the task, author, and
canonical digest of the task input before either review attachment is added.

`contract self-check --input` emits a provider-neutral request packet with six
fixed questions, medium effort, and a 300-second budget. Supplying a structured
`--response` returns the exact `selfReview`, `knownIssues`, and augmented task
input. The CLI does not hold model credentials or claim that an external model
obeyed the wall-clock budget; the recorded result remains a local advisory
claim. A second attachment, wrong author/task/digest, reordered dimensions,
unrecorded non-timeout concern, or blocker disguised as a deferrable issue fails
preflight.

The independent reviewer may obtain an exact prompt packet through `task
contract-review-request`. A beta2 canonical review must add the assisted
checklist and a six-dimension comparison whose agreement rate, missed concerns,
and overcautious concerns are recomputed by the verifier. The reviewer must be
distinct from the contract author and every implementation owner. `task
review-summary` then renders the accepted or repair-required conclusion for a
quick user scan, but it performs no transition. Explicit user confirmation and
the normal review-bound owner transition remain required.

An under-development runner does not use these mechanisms to accept, release,
or apply itself. Dog-food review becomes evidence only after an independently
reviewed release candidate exists; explicit apply remains a separate user
decision.

The accountability registry is a policy-anchored, append-only local claim.
Actor IDs are normalized and immutable; aliases resolve to one active actor and
cannot evade a sanction. Findings carry their origin bytes, semantic identity,
classification, defect class, responsible role, culpability, and score effect.
Contract violations belong to the contract author. For a task with multiple
implementation owners, every implementation defect finding names the exact
responsible owner from the frozen set. A defect proven present in previously accepted bytes belongs
to the reviewer who missed it. New requirements and proven tool defects score
zero. Under beta3 graduated scoring, a first BLOCKER/HIGH/MEDIUM/LOW finding
scores 3/2/1/0. Repeat surcharges are defect-class specific and escalate as
6/8/10/12, 5/6/7/8, 3/4/5/6, and 1/1/2/2 respectively. Defect classes are
normalized before counting. Evidence-forgery, identity-evasion,
authorization-bypass, and prohibited-mutation still force `SUSPENDED`.
Historical strict-v1 bootstrap snapshots retain their recorded scores and are
never retroactively rewritten; new non-bootstrap finding transitions must carry
the graduated breakdown and repeat count that the event-chain verifier
recomputes.

### Historical scoring transition

Prior to 2026-08-16T19:00:00Z, accountability events used strict-v1 scoring:
BLOCKER = 8 points, HIGH = 5, MEDIUM = 3, LOW = 1, with a flat +4 repeat
surcharge. From 2026-08-16T19:00:00Z onward, new findings use graduated-v2
scoring as documented above (first BLOCKER = 3, escalating surcharges 6/8/10/12).
Historical scores are not retroactively recalculated; they remain as recorded
evidence of accountability under the rules in effect at the time. Actors with
standing derived from strict-v1 events follow graduated-v2 recovery paths and
thresholds. New violations after the transition are scored under graduated-v2
rules. The transition preserves the append-only ledger invariant and provides a
clear version boundary for accountability policy evolution.

When the governance tool, contract review, implementation review, or task
lifecycle is itself blocked, responsibility recording must not depend on that
same unavailable path. `accountability incident-record` uses a separate
dry-run/apply plan, exact evidence identities, an active subject actor, and an
explicit `user-authority` grant. The applied incident is embedded in the
append-only accountability event chain and immediately affects the recomputed
score and standing. It does not create or accept a task state, substitute for a
review, or authorize implementation.

Standing is recomputed from the append-only event chain at every preflight,
transition, review, repair, and close boundary. `GOOD_STANDING` has ordinary
roles. `WARNING` may perform R0/R1 work, requires supervision for R2, and cannot
author or review R3. `WATCH` cannot author, own, or review R3; `PROBATION` has no
ordinary mutating role; and `SUSPENDED` is read-only except for one exact,
user-authorized supervised remediation task. Reinstatement requires permanent
gates for every unresolved defect class, risk-matched supervised clean
calibrations, distinct reviewer/supervisor identities, and a non-expired
consume-once user authorization.

Permanent gates live at
`.delivery/accountability/permanent-gates/<actor-id>.json`. Each document binds
the normalized actor, remediation event, originating finding, selected rule,
and a digest-chained trigger history. Preflight-check gates are evaluated for
the contract author and every implementation owner. An unreadable, forged, or
unknown preflight gate fails closed. Preflight remains read-only; recording a
trigger or installing a gate is an explicit mutation after verified
remediation.

A clean task is not a success label. It must be a schema-v2 task whose validated
ledger is exactly CLOSED without REPAIR_REQUIRED, BLOCKED, CANCELLED, or
SUPERSEDED history; both contract and implementation reviews must be ACCEPTED
with zero findings; the single evidence run must cover every acceptance ID with
valid zero-exit receipts; and all candidate, verification, authorization, and
evidence identities must recompute. R3/R2/R1 clean tasks carry provisional
recovery credits of -3/-2/-1, while R0 carries none. `task verify-clean` only
reports this result. Applying credit or changing standing remains an explicit,
authorized accountability event, never a side effect of inspection.
Recognition is revocable and never waives contract readiness, evidence,
independent review, authorization, provenance, or runtime gates.

A bootstrap remediation that must remain verifiable by an older pinned runner
uses two mutually bound artifacts. The lifecycle authorization remains the
runner-native `sop-authorization-v2` at the canonical requirement path and is
the only authorization placed in candidate and verification authorization
arrays. A separate `engineering-governance-remediation-authorization-v1`
sidecar binds the accepted contract, lifecycle path/raw SHA-256/semantic digest,
supervisor, contract reviewer, implementation reviewer, scope, and expiry. The
`CANDIDATE` ledger event references both exact artifacts once. Eligibility is
derived from the terminal predecessor ledger and its bound contract-defect,
the replacement contract and accepted review, and both authorization
identities; a task ID or matching action string alone never grants an exception.
Historical authorization shapes remain valid only in their original histories.

### External implementation sources

External-source use is default-deny and vendor-neutral. Without an enabled,
version-and-digest-bound provenance extension, the task remains `independent`:
no external implementation material is inspected, adapted, or copied.

A source-assisted task is R3 and freezes one just-in-time allocation containing:

- one immutable locator and pin;
- exact source units and symbols;
- exact destination repositories, paths, and symbols;
- one maximum access mode: `inspect`, `adapt`, or `copy-exact`;
- every changed destination classified exactly once as source-assisted or
  independent;
- actual-use records and an approved project-specific release disposition.

`copy-exact` is permitted only when the allocation itself permits
`copy-exact`, actual use stays within the exact source and destination subsets,
and the release disposition is approved. The global extension does not decide
vendor licenses or product policy; a project may prohibit a source entirely or
add stricter review and release rules.

## 4. State machine

Primary path:

```text
DEFINED -> IN_PROGRESS -> CANDIDATE -> ACCEPTED -> CLOSED
```

Repair path:

```text
CANDIDATE -> REPAIR_REQUIRED -> IN_PROGRESS
```

Incomplete states may become BLOCKED, CANCELLED, or SUPERSEDED only through a
recorded legal transition. Accepted and closed history is immutable; a later
defect opens a new task.

Any recorded implementation owner may move a v2 task to `IN_PROGRESS`, `CANDIDATE`,
`BLOCKED`, `CANCELLED`, or `SUPERSEDED` through a dry-run-first `task
transition` command and applies only the exact returned plan digest. The runner
checks membership in the frozen owner set at plan time, apply time, and
project-check time. The ledger still records one acting actor per event. A
`CANDIDATE` transition must bind the canonical candidate and verification
artifacts required for that state. Review and close use their dedicated
commands and enforce independent reviewer authority rather than accepting a
caller-selected generic actor.

For v2 mutating tasks, `.delivery/tasks/<task-id>/contract.yaml` and
`ledger.jsonl` are the canonical contract and state record. Candidate,
verification, review, and closure artifacts use the exact canonical filenames
defined by their schemas. Project check rejects duplicate or orphan artifacts,
cross-task ancestry, stale byte references, and state that disagrees with the
ledger. A v1 task directory remains historical evidence and is reported as
legacy inspect-only; the v2 runner must not silently continue its active
lifecycle.

## 5. Implementation

The recorded implementation owners:

1. inspects real repository and authority state;
2. preserves unrelated work and generated-file ownership;
3. writes an observable failing test before production behavior changes when
   test-driven repair or feature work applies;
4. implements and debugs all in-scope behavior;
5. runs the required fresh gates in the required evidence environments;
6. records exact implementation identities and remaining unknowns;
7. reports CANDIDATE only when every non-exempt gate passes.

Ordinary engineering decisions remain with the owner set. A material product
decision, unavailable resource, high-risk authorization, or real external
blocker is raised to the user.

## 6. Evidence

Evidence records contain a non-empty acceptance ID, executed check IDs, command,
exit code, timestamps, environment, implementation identities, observation, raw
artifact path, and digest. Summaries are derived from records and are never the
sole proof of execution.

Evidence kinds are explicit: static, compile, unit, integration, device, cloud,
and production. One kind cannot be relabeled as another.

Imported local execution evidence must use a supported machine format. The
default format is a `task execute` receipt produced by the pinned runner from
one exact contract-frozen executable invocation without a shell. Candidate
verification is static and never executes candidate-controlled commands. When
fresh replay is contract-required, `task replay` first returns a digest-bound
plan containing only the frozen executable, arguments, working directory,
environment, repository set, and checkout state. Only the exact unchanged
`--apply-plan <digest>` executes it and emits a separate replay-verification
artifact. Verification binds exact command, output, timing, runner, commit,
tree, checkout, evidence, authorization, and extension-artifact identities. A
non-replayable external result needs a separately supported adapter and cannot
be relabeled as a local command receipt.

Review and project check re-evaluate the persisted verification from its bound
contract, candidate, receipts, replay artifact, authorization records, and
extension results. A schema-valid or internally hashed verification document is
not sufficient when those semantics no longer validate.

The implementation identity and optional evidence-closure identity are separate.
An evidence-only closure commit may change only contract-allowlisted evidence or
status paths. Verification uses recorded commit and tree identities instead of
requiring final HEAD to equal the earlier implementation commit.

## 7. Review and repair

An R2/R3 reviewer inspects actual commits, diffs, files, repository state, and
fresh evidence. The reviewer does not trust the implementation report and does
not edit the candidate.

Candidate and normal implementation-review binding uses the canonical
structured-document digest, so formatting-only changes do not alter that
identity while semantic changes do. The pre-implementation readiness artifact
also binds raw contract bytes, so formatting-only edits before implementation
invalidate readiness. The accepted review and closure also bind the exact
approved replay-plan digest.
Closure artifact references additionally bind exact file bytes with SHA-256.

A review decision is ACCEPTED or REPAIR_REQUIRED. Generic completeness
categories are always `PASS`; only the explicitly applicable R3 entries may be
`NA` with their exact reason. Findings are ordered by severity descending
(`BLOCKER`, `HIGH`, `MEDIUM`, `LOW`) and then by finding ID, and classified as:

- contract violation;
- newly discovered defect;
- new requirement.

On rejection, the reviewer checks sibling paths and the complete affected trust
boundary, then issues one consolidated repair record. The frozen owner set repairs
the candidate, with every repair mutation attributed to one acting owner.
Repeated micro-fix prompts are a process failure, not the default
workflow.

## 8. Closure

ACCEPTED means the exact candidate satisfied the applicable gate. CLOSED also
requires coherent task, handoff/status, evidence, and next-action records.
Review eligibility is derived from candidate and review files themselves;
closure eligibility is derived from a digest-bound closure file. Caller-supplied
owner names, accepted-state strings, booleans, or finding summaries are not
acceptance or closure evidence.

A closure report states the outcome, verified commands/results, exact commits,
remaining risks or pending authorized runtime work, the next permitted stage,
and whether user action is required.

Project check validates the complete v2 task graph, including contract and
policy identity, ledger continuity, the unique current candidate and accepted
review, closure ancestry, and every exact current artifact reference. It does
not infer active v2 state from legacy filenames or caller-authored state labels.

## 9. Exceptions and authorization

Only waiverable/default rules accept exception records. Each exception names the
rule, reason, scope, compensating controls, approver, issue time, expiry, and
status. Non-waivable exceptions fail validation.

User-authorization-required actions need approval for the exact action and
target. A prior approval for another task, device, environment, or time does not
silently carry forward.

The built-in file-backed actor and approval records have trust level
`local-claim`. Their exact bytes and scope are bound, but they do not prove who
created the file. A requirement for authenticated identity must name and verify
an external attestation provider; when none is configured, the runner fails
closed instead of upgrading a local claim.

## 10. Continuous improvement

The workflow records first-candidate acceptance, repair cycles, escaped blocking
defects, gate flakes/false positives, time to acceptance by risk, exception
health, and repeated defects converted to permanent gates. Metrics evaluate the
process, not individual owners.

When the same defect class repeats, update the contract template, test, scanner,
or CI gate so future tasks fail earlier. Do not normalize an endless
author-review-repair loop.

## 11. Breaking migration from 1.x

Version 2.0.0 is a breaking governance release. Adopted 1.x projects remain
pinned to their existing runner until an explicit dry-run upgrade is reviewed
and applied. Active v1 artifacts are not relabeled as v2. Follow
`MIGRATING_TO_2.0.md` for project policy, extension manifest, task, and runner
migration rules.
