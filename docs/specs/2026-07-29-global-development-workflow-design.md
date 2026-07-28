# Global Development Workflow Governance — Design

Status: approved for implementation planning

Design version: 1.0

Date: 2026-07-29

Owner: user

Designer: Codex

## 1. Purpose

Create one cross-project development workflow that applies to every current and
future project, regardless of language, repository layout, or implementation
agent. The workflow must combine efficient single-owner delivery with
risk-proportionate independent review, reproducible evidence, and enforceable
state transitions.

This document designs the governance system. It does not make the system active.
The workflow becomes operational only after the canonical policy, CLI,
adapters, schemas, tests, and project integrations are implemented and verified.

## 2. Goals

1. Make a versioned global policy the highest user-owned development-governance
   layer across projects.
2. Give every task one implementation owner who is responsible for investigation,
   implementation, debugging, verification, and delivery.
3. Scale process cost by risk instead of forcing heavyweight artifacts onto
   every change.
4. Keep requirements and review criteria identical and visible before
   implementation.
5. Bind acceptance claims to real executions, immutable contracts, and exact
   implementation identities.
6. Use independent review as a risk gate, not as an endless teaching loop.
7. Convert recurring defects into permanent automated checks.
8. Support Codex, Qoder, Cursor, Claude, and future tools without creating
   divergent copies of the policy.
9. Preserve existing project authorities, generated-file ownership, dirty
   worktrees, and tool/runtime safety boundaries.

## 3. Non-goals

- The system does not prescribe one programming language, architecture, test
  framework, branching model, or CI provider for all projects.
- It does not require a standalone contract document for every low-risk edit.
- It does not allow an agent to authorize production writes, destructive actions,
  physical-device runs, billing actions, or external communications.
- It does not make an AI self-report equivalent to independent acceptance.
- It does not provide cryptographic proof that two AI identities are different
  when they share the same operating-system or Git identity. It enforces declared
  ownership, separate workflow events, source/evidence separation, and fresh
  review execution, and reports that limitation accurately.
- It does not replace product, architecture, security, data, or operational
  specifications owned by individual projects.

## 4. Authority and precedence

The user-owned governance order is:

1. Platform/system safety and capability constraints.
2. Explicit current user instructions and approvals.
3. Global non-waivable workflow invariants.
4. Versioned global workflow defaults.
5. Project extensions, which may strengthen but not weaken levels 3 or 4 unless
   an explicitly waiverable rule has a valid exception.
6. Task contracts, plans, and implementation choices.

The global governance repository is the only authority for levels 3 and 4.
Global AGENTS files, project AGENTS files, tool-specific rules, Skills, templates,
and CI snippets are adapters or generated outputs. They must not become parallel
policy authorities.

Rules are classified as:

- `non_waivable`: cannot be weakened by a project or task. Examples include
  truthful evidence, one active implementation owner, preserving unrelated user
  work, and not claiming unperformed validation.
- `user_authorization_required`: permitted only after an explicit, scoped user
  approval. Examples include production mutation and destructive operations.
- `waiverable`: may have a scoped, reasoned, expiring exception approved by the
  user.
- `default`: may be strengthened or replaced by an equivalent project mechanism
  that satisfies the same invariant.

## 5. Canonical repository

The canonical repository is:

```text
/Users/xgh/Documents/VibeCoding/EngineeringGovernance
```

Planned layout:

```text
EngineeringGovernance/
├── DEVELOPMENT_SOP.md
├── CORE_INVARIANTS.md
├── RISK_CLASSIFICATION.md
├── VERSION
├── package.json
├── pnpm-lock.yaml
├── src/
│   ├── cli/
│   ├── policy/
│   ├── state/
│   ├── evidence/
│   ├── adapters/
│   └── project/
├── schemas/
│   ├── project-policy.schema.json
│   ├── task-contract.schema.json
│   ├── evidence.schema.json
│   ├── review.schema.json
│   └── exception.schema.json
├── templates/
├── adapters/
├── tests/
└── docs/
    └── specs/
```

The CLI will be implemented in TypeScript for Node.js 22. Dependencies must be
locked, license-checked, and limited to mature packages needed for YAML parsing,
JSON Schema validation, and command-line behavior. Project applications do not
inherit these dependencies; they belong only to the governance tool.

Releases use semantic versions and immutable Git tags such as `v1.0.0`.

## 6. Risk model

Every task receives the highest applicable level. Ambiguity raises the task one
level. Project extensions may raise, but may not silently lower, a level.

### R0 — read-only or advisory

Examples: explanation, read-only investigation, diagnosis, architecture review,
or audit without mutation.

Required record: the task response or an audit document when durable retention
is requested. It distinguishes confirmed facts, inference, and unknowns.

### R1 — local, reversible change

Examples: a bounded local edit with no security, persistent-data, external-system,
or broad user-behavior impact.

Required record: objective, owner, changed files, relevant fresh verification,
unverified items, and final commit identity when a commit exists. A separate
contract document is not required by default. The implementation owner may
self-accept after required automated checks pass.

### R2 — important or cross-boundary change

Examples: user-visible functionality, cross-module behavior, persistence logic,
multi-repository work, broad regression risk, or a phase/stage candidate.

Required record: frozen task contract, structured evidence manifest, and an
independent review. The implementation owner cannot accept the candidate.

### R3 — high-risk change

Examples: authentication, authorization, privacy, security, migrations, data
destruction, payments, release/deployment, production mutation, or irreversible
external effects.

Required record: all R2 artifacts plus the applicable trust-boundary analysis,
threat model, migration/recovery/rollback plan, explicit authorization record,
specialized gates, and production observation plan. Independent review is
mandatory. Actions marked `user_authorization_required` remain blocked until the
user approves the exact action and target.

## 7. Ownership model

- A task has exactly one active implementation owner.
- The implementation owner owns discovery, design within the frozen boundaries,
  code, debugging, tests, evidence generation, and candidate preparation.
- Two agents must not concurrently modify the same task scope.
- For R2 and R3, the reviewer must not have participated in implementation of
  the reviewed candidate.
- If a reviewer changes implementation code, that reviewer becomes an
  implementation participant and a new independent review is required.
- An implementation agent may use subagents only as internal helpers while
  retaining ownership; their changed paths and results belong to the same
  implementation side of the boundary.
- The user is not a transport layer for incremental repair instructions. A
  rejection produces one consolidated repair record after horizontal review of
  the affected boundary.

## 8. State machine

Primary path:

```text
DEFINED -> IN_PROGRESS -> CANDIDATE -> ACCEPTED -> CLOSED
```

Alternate states:

```text
CANDIDATE -> REPAIR_REQUIRED -> IN_PROGRESS
DEFINED|IN_PROGRESS|CANDIDATE|REPAIR_REQUIRED -> BLOCKED
DEFINED|IN_PROGRESS|CANDIDATE|REPAIR_REQUIRED|BLOCKED -> CANCELLED
DEFINED|IN_PROGRESS|CANDIDATE|REPAIR_REQUIRED|BLOCKED -> SUPERSEDED
```

Transition rules:

- `DEFINED`: objective, risk, owner, scope, and required artifact class exist.
- `IN_PROGRESS`: ownership is exclusive and required authority inputs are
  available.
- `CANDIDATE`: the frozen contract digest, implementation identities, and every
  required non-exempt gate have fresh passing evidence.
- `ACCEPTED`: R1 has a valid owner verification, or R2/R3 has a valid independent
  review of the exact candidate.
- `CLOSED`: acceptance is recorded, handoff/status artifacts are coherent, and
  the next permitted action is explicit.
- `REPAIR_REQUIRED`: at least one blocking finding exists. The review identifies
  all known sibling/trust-boundary failures and classifies every finding.
- `BLOCKED`: a real external dependency, missing authorization/resource, or
  unresolved material product decision prevents progress. Debugging difficulty,
  test failure, or unfinished work is not a blocker.
- `CANCELLED`: the user or owning authority intentionally stops the task.
- `SUPERSEDED`: a named successor contract replaces the task without rewriting
  its historical result.

Accepted or closed history is immutable. A later defect opens a new task.

## 9. Finding classification

Every post-implementation finding is exactly one of:

1. `contract_violation`: the candidate contradicts a requirement frozen before
   implementation. The implementation owner repairs it.
2. `newly_discovered_defect`: the behavior is defective but the frozen contract
   did not state the necessary condition. The contract/review designer owns the
   omission and creates explicit repair scope.
3. `new_requirement`: desired behavior changed or expanded after freezing. It is
   separately authorized and must not be presented as a prior failure.

Review criteria cannot change silently. A contract change creates a new contract
revision with a new digest and a recorded reason.

## 10. Required artifacts

### R0

No repository artifact is required unless a durable audit was requested.

### R1

The commit, pull request, task record, or final report contains:

- objective and owner;
- scoped changed files;
- verification commands and results;
- unverified behavior and remaining risk;
- final commit identity when applicable.

### R2

1. Task contract: risk, owner, authoritative inputs, objective, scope, non-goals,
   acceptance IDs, positive/negative cases, required gates, legitimate blockers,
   and intentionally open implementation choices.
2. Evidence manifest: contract digest, implementation identities, runner version,
   execution records, environment, raw artifacts and digests, exemptions, and
   recomputed summary.
3. Independent review: reviewed identities, findings, classifications, decision,
   pending items, next stage, and whether user action is required.

### R3

All R2 artifacts plus applicable threat/trust analysis, migration and rollback
plan, recovery proof, scoped authorization record, and production observation
or rollback-window record.

Existing project conventions may own the physical locations. New projects use:

```text
.delivery/
├── policy.yaml
├── extensions.yaml
├── exceptions/
└── tasks/
    └── <task-id>/
        ├── contract.yaml
        ├── evidence.json
        └── review.md
```

An existing handoff may satisfy the contract and review schemas. The adapter
must map it; it must not create a second divergent copy merely to match the
default directory.

## 11. Evidence integrity

Evidence is produced by the governance runner or imported from a supported raw
test format and validated by the runner. A handwritten PASS field is never
sufficient.

Each required acceptance record contains:

- acceptance ID;
- non-empty executed test/check IDs;
- command and exit code;
- start/end timestamps;
- relevant environment identity;
- exact implementation repository and commit/tree identity;
- raw result path and digest;
- observed output needed to establish the claim.

The validator recomputes summaries from underlying records and rejects omitted,
empty, duplicated, reordered, stale, cross-run, wrong-commit, forged, or
partially populated evidence. Compile, static, unit, integration, device, cloud,
and production evidence are different evidence kinds and cannot substitute for
one another unless the frozen contract explicitly permits it.

### Implementation and evidence commits

The system uses an explicit two-layer identity model:

1. `implementationCommits`: immutable code/configuration commits in one or more
   repositories.
2. `evidenceClosureCommit`: an optional later commit containing only allowlisted
   evidence/status paths.

Post-commit verification checks that:

- the recorded implementation commits exist;
- implementation trees match the recorded tree digests;
- changes after each implementation commit are limited to declared evidence or
  status paths;
- the contract digest and runner version are unchanged;
- the evidence closure commit can be verified without requiring current HEAD to
  equal an earlier implementation commit.

This prevents evidence generation from invalidating its own SHA claim.

## 12. CLI

The primary executable is `sop`:

```text
sop init <project>
sop adopt <project>
sop check <project>
sop upgrade <project>
sop task start
sop task execute
sop task verify
sop task review
sop task close
```

Behavioral requirements:

- `init` creates the default integration for a new project.
- `adopt` first performs discovery and emits a dry-run patch. It edits the
  authoritative source of generated files, never only the generated target.
- `check` is read-only and verifies policy, adapters, state, artifacts, and
  evidence.
- `upgrade` previews policy and adapter changes before mutation.
- `task start` classifies risk, establishes ownership, and creates only the
  artifacts required for that risk.
- `task execute` runs one exact executable without a shell, derives one check ID
  from the normalized executable, arguments, and working directory, and writes
  a runner-produced receipt with command, environment, timing, exit status,
  stdout, and stderr. Callers cannot declare executed check IDs.
- `task verify` imports only supported receipts, rejects handwritten PASS lists,
  and first reports a canonical digest of the exact local replay plan without
  executing it. Only an explicit caller approval of that exact digest permits
  fresh replay. Candidate status then derives from the replay plus exact
  contract, commit, tree, and Git-set equality. Non-replayable external results
  require a distinct supported adapter.
- `task review` reads the candidate and review artifacts, revalidates candidate
  eligibility, and binds the decision to the canonical structured candidate
  digest, approved replay-plan digest, and complete implementation identity set.
  Formatting-only changes preserve the candidate digest; semantic changes do not.
- `task close` reads a closure artifact and refuses closure unless its candidate,
  accepted review, adopted-project status, status-artifact digests, and next
  action agree.

All mutation commands support `--dry-run`. Existing dirty files outside the
managed patch are preserved. An overlapping dirty managed file causes a safe
stop with a patch preview; it is never reset, stashed, or overwritten.

For authority-owned generated targets, the adoption plan lists exact paths and
before-digests without authoring them directly. Those guards are part of the
plan digest, are checked in each owning Git repository, and are rechecked before
source writes. Project-native synchronization remains their only writer.

Adapter removal only removes a managed block when its current digest matches a
known installed version. Otherwise it stops for manual review.

## 13. Agent adapters and Skill

### Codex

- A managed universal block is installed through the persistent owner of Codex
  global configuration, including CC Switch common configuration when it owns
  the value.
- Existing unrelated global instructions remain preserved.
- `/Users/xgh/.codex/skills/delivery-sop/SKILL.md` becomes an operational adapter
  that reads project policy and invokes `sop`; it does not copy policy text.

### Qoder

- Project `AGENTS.md` plus the CLI are the default integration.
- The installer does not create `.qoder/rules` when that would shadow an
  authoritative AGENTS entrypoint.

### Cursor and Claude

- The installer prefers supported common AGENTS discovery.
- Compatibility adapters are generated only when required and are marked with
  source version and digest.
- Claude import files reference or import the adjacent AGENTS source rather than
  restating the policy.

### Future tools

An adapter declares discovery mechanism, generated targets, owning source,
installation check, drift check, and removal behavior. No adapter may redefine
the policy.

## 14. Project adoption

Every adopted project receives at least:

```text
.delivery/policy.yaml
.delivery/extensions.yaml
```

`policy.yaml` records global SOP version/digest, adapter inventory, project
artifact mapping, CI integration, and minimum supported version.

`extensions.yaml` records project rules that strengthen or specialize the global
workflow. A validator rejects an extension that weakens a core invariant.

For projects with generated documentation or agent entrypoints, adoption edits
the canonical generator source and uses the project's supported sync/check
commands. It does not modify generated targets directly.

ProjTrav and NoMe adoption occur only after the governance package passes its
own tests. Each adoption begins with a read-only discovery and dry-run, preserves
existing dirty worktrees, and is committed independently in each Git repository.
No implementation agent may edit the same scope concurrently during adoption.

## 15. Exceptions

Exceptions live under `.delivery/exceptions/<exception-id>.yaml` and contain:

- exact rule ID;
- waiverability class;
- reason and compensating controls;
- project/task/path scope;
- approver;
- issue and expiry timestamps;
- status.

The CLI rejects exceptions for non-waivable rules, missing explicit approval,
expired dates, or out-of-scope use. Exceptions never imply production or
destructive authorization unless the user separately approved that exact action.

## 16. CI enforcement

Each project exposes a `delivery-policy` gate. CI obtains the exact tagged
governance runner or a checksum-pinned release artifact and runs `sop check`.

The gate verifies:

- supported policy version and digest;
- adapter/source synchronization;
- project extensions and exceptions;
- risk/artifact consistency;
- legal state transitions;
- contract/evidence/review schema validity;
- underlying executed records and recomputed summaries;
- implementation/evidence identities;
- reviewer/implementer separation declarations for R2/R3;
- absence of non-exempt pending gates at candidate or acceptance state.

R2/R3 fail closed when the validator is unavailable, policy digests differ, or
required evidence cannot be verified. R1 completion reports missing governance
validation honestly and cannot be presented as compliant when the required gate
was not available.

## 17. Versioning and upgrades

- Projects pin an exact SOP version for reproducible historical review.
- New tasks use the project's active supported version.
- Existing task contracts remain reviewable under their recorded version.
- Normal upgrades use a previewed, explicit project change.
- A global release may raise `minimumSupportedVersion` for critical core fixes.
  A project below the minimum cannot create a new compliant candidate.
- Upgrades never rewrite historical task evidence or accepted decisions.
- Release notes classify changes as core correction, default change, schema
  change, adapter change, or tooling-only change.

## 18. Error handling and safety

- Read-only discovery precedes every adoption or upgrade.
- Mutation targets are resolved exactly and checked for overlap with dirty files.
- Writes are atomic at the individual-file level and followed by a complete
  check.
- Partial installation is reported as `INCOMPLETE_ADOPTION`; it is never called
  compliant.
- Missing tools, unsupported repository layouts, unresolved generated-file
  ownership, or conflicting authority cause a safe stop with exact remediation.
- The CLI never resets, cleans, stashes, broadly stages, rewrites history, pushes,
  deploys, migrates, or changes external systems automatically.
- Secrets and raw credentials are excluded from artifacts and logs.

## 19. Verification strategy

### Unit tests

- risk classification precedence;
- state transition matrix;
- schema validation;
- exception scope/expiry;
- managed-block generation and digest verification;
- implementation/evidence commit identity logic.

### Adversarial tests

Evidence fixtures cover omitted, empty, duplicate, reordered, cross-run, stale,
forged, wrong-commit, partially populated, summary-mismatch, and evidence-commit
drift cases.

### Integration tests

Temporary Git repositories cover new adoption, existing AGENTS preservation,
generated-source ownership, dirty managed/unmanaged paths, multi-repository task
identity, upgrade, and safe removal.

### Adapter golden tests

Codex, Qoder, Cursor, Claude, and generic AGENTS outputs are compared to reviewed
golden files and checked for canonical version/digest markers.

### End-to-end pilots

1. Synthetic R1 task: single owner and self-verification, no excess documents.
2. Synthetic R2 task: contract, implementation/evidence closure, independent
   review, rejection, consolidated repair, and acceptance.
3. Synthetic R3 task: authorization gate, adversarial evidence, rollback plan,
   and fail-closed behavior.
4. ProjTrav dry-run/adoption/check without Simulator or device enumeration.
5. NoMe dry-run/adoption/check without Simulator or device enumeration.

No project adoption is complete until its existing native sync/check mechanism
and `sop check` both pass.

## 20. Success metrics

The workflow records process health without evaluating people:

- first-candidate acceptance rate;
- repair cycles per accepted task;
- escaped blocking defects;
- gate flake/false-positive rate;
- median time from `DEFINED` to `ACCEPTED` by risk level;
- stale/expired exception count;
- percentage of repeated defect classes converted into permanent gates.

A healthy rollout should reduce repeated repair cycles and escaped defects
without materially increasing R1 delivery time.

## 21. Rollout sequence

1. Approve and commit this design.
2. Produce an implementation plan with dependency order and exact verification.
3. Implement canonical policy, schemas, CLI, test fixtures, and package checks.
4. Verify the governance package against temporary repositories.
5. Install the Codex global managed block and `delivery-sop` Skill through their
   persistent configuration owners.
6. Dry-run, then adopt ProjTrav using its canonical Docs/rules synchronization.
7. Dry-run, then adopt NoMe using its own authoritative rule sources.
8. Execute R1/R2/R3 pilots, correct the governance package, and publish `v1.0.0`.
9. Use the workflow for all new projects and audit existing projects before their
   next implementation task.

## 22. Implementation acceptance

The system is ready for `v1.0.0` only when:

1. Every canonical file, schema, CLI command, adapter, and template has passing
   tests.
2. All adversarial evidence mutations are rejected for the intended reason.
3. R1 produces no unnecessary standalone task bundle.
4. R2/R3 cannot reach `ACCEPTED` without exact candidate identity and required
   independent review.
5. Evidence closure commits verify without final-HEAD equality ambiguity.
6. Existing rule files and dirty worktrees survive adoption without unrelated
   changes.
7. Generated adapters are reproducible and drift-detectable.
8. ProjTrav and NoMe dry-run/adoption checks pass in their real repositories.
9. No Simulator, device enumeration, production mutation, deployment, migration,
   push, or external communication occurs without its existing authorization.
10. A clean machine or CI environment can obtain the exact tagged runner and
    verify a project without relying on hidden conversation state.

## 23. Design decision summary

- Use a standalone, versioned governance repository as the sole global workflow
  authority.
- Use global and project AGENTS files as adapters, not authorities.
- Use a Skill for Codex ergonomics, not policy storage.
- Use machine schemas and a CLI/CI gate for enforcement.
- Use one implementation owner and risk-based independent review.
- Preserve lightweight delivery for R0/R1 and full traceability for R2/R3.
- Bind evidence to immutable contracts and implementation trees using an explicit
  implementation/evidence-closure model.
- Adopt existing projects through authority-aware, dry-run-first integration.
