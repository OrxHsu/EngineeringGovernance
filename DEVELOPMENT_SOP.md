# Global Development Workflow SOP

Status: canonical development policy

Version: 2.0.0

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

Every mutating task has one implementation owner. That owner investigates,
implements, debugs, verifies, and prepares the candidate end to end. Another
agent is not introduced merely to relay prompts or perform routine edits.

Independent review is proportional to risk:

- R0: read-only conclusion;
- R1: owner verification is sufficient unless project policy raises the gate;
- R2: one independent review is required;
- R3: a frozen contract, specialized evidence, authorization where applicable,
  and independent review are required.

## 3. Task definition

Before mutation, determine risk, implementation owner, objective, scope,
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

For newly created schema-v2 R2/R3 tasks, the contract author and implementation
owner are not the contract-readiness approver. Before `DEFINED -> IN_PROGRESS`,
an independent reviewer runs `task contract-review --input` against the exact
`.delivery/tasks/<task-id>/contract-review.yaml` artifact. The artifact binds
the task, risk, reviewer, raw contract SHA-256, semantic contract digest, nine
completeness categories, all applicable R3 categories, evidence references, and
one consolidated finding set. `ACCEPTED` requires every required item to pass
and no findings; `REPAIR_REQUIRED` cannot start implementation. Findings are
classified as `contract_violation`, `newly_discovered_defect`, or
`new_requirement` and return to the contract author as one repair record.
Self-review is forbidden.

The gate is a global rule, not a Phase 2D rule. R1 tasks keep the simpler owner
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

The implementation owner moves a v2 task to `IN_PROGRESS`, `CANDIDATE`,
`BLOCKED`, `CANCELLED`, or `SUPERSEDED` through a dry-run-first `task
transition` command and applies only the exact returned plan digest. The runner
checks owner identity at plan time, apply time, and project-check time. A
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

The implementation owner:

1. inspects real repository and authority state;
2. preserves unrelated work and generated-file ownership;
3. writes an observable failing test before production behavior changes when
   test-driven repair or feature work applies;
4. implements and debugs all in-scope behavior;
5. runs the required fresh gates in the required evidence environments;
6. records exact implementation identities and remaining unknowns;
7. reports CANDIDATE only when every non-exempt gate passes.

Ordinary engineering decisions remain with the owner. A material product
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
boundary, then issues one consolidated repair record. The original owner repairs
the candidate. Repeated micro-fix prompts are a process failure, not the default
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
