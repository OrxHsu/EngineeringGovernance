# Global Development Workflow SOP

Status: canonical development policy

Version: 1.0.0

## 1. Applicability and authority

This SOP applies to every adopted project and development agent. Platform/system
constraints and explicit current user instructions remain higher priority. The
global core invariants apply above project workflow extensions. Project product,
architecture, data, and operations documents continue to own their domains.

Agent entrypoints, Skills, prompts, templates, and generated rules are adapters.
They must point to this package version and digest rather than evolve a parallel
workflow.

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

R2/R3 requirements are frozen before implementation. Requirements and review
criteria are identical. Natural-language properties such as secure, private,
bound, executed, or complete require observable checks.

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

The implementation identity and optional evidence-closure identity are separate.
An evidence-only closure commit may change only contract-allowlisted evidence or
status paths. Verification uses recorded commit and tree identities instead of
requiring final HEAD to equal the earlier implementation commit.

## 7. Review and repair

An R2/R3 reviewer inspects actual commits, diffs, files, repository state, and
fresh evidence. The reviewer does not trust the implementation report and does
not edit the candidate.

A review decision is ACCEPTED or REPAIR_REQUIRED. Findings are ordered by
severity and classified as:

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

A closure report states the outcome, verified commands/results, exact commits,
remaining risks or pending authorized runtime work, the next permitted stage,
and whether user action is required.

## 9. Exceptions and authorization

Only waiverable/default rules accept exception records. Each exception names the
rule, reason, scope, compensating controls, approver, issue time, expiry, and
status. Non-waivable exceptions fail validation.

User-authorization-required actions need approval for the exact action and
target. A prior approval for another task, device, environment, or time does not
silently carry forward.

## 10. Continuous improvement

The workflow records first-candidate acceptance, repair cycles, escaped blocking
defects, gate flakes/false positives, time to acceptance by risk, exception
health, and repeated defects converted to permanent gates. Metrics evaluate the
process, not individual owners.

When the same defect class repeats, update the contract template, test, scanner,
or CI gate so future tasks fail earlier. Do not normalize an endless
author-review-repair loop.
