---
status: active
workspace: /Users/xgh/Documents/VibeCoding/EngineeringGovernance
repository: /Users/xgh/Documents/VibeCoding/EngineeringGovernance
branch: codex/global-sop-hardening-1
head: 9b5e9d7aeaff87bb431b55e9ecf5944e591bd490
worktree: dirty
status_fingerprint: 310c593ae38a038e84427c8d5037a3b6fdef660fbc65f75f19a8b520e2add048
workstream: global-sop-2-1-beta-1-fix-1
updated: 2026-08-16T11:40:09Z
source_task: global-sop-2-1-beta-1-fix-1-repair-4
---

# Session Handoff: SOP 2.1.0-beta.1 source development

## Objective

Keep the current beta1 source implementation coherent and testable while additional user comments and features are merged. Do not release, apply, or close this stage until the combined final diff receives independent review.

## Scope And Non-Goals

- In scope: contract preflight, actor/accountability enforcement, remediation provenance, repaired-candidate graph semantics, opt-in beta2 mutual-review assistance, beta3 graduated accountability and recovery, schemas, docs, generated dist, and tests already present in the dirty worktree.
- Non-goal for this checkpoint: repair-5, further SOP ledger transitions, candidate/replay/close operations, runner installation, policy apply, publishing, deployment, consumer migration, ProjTrav/NoMe changes, or TREK inspection.

## Authority

- Source and tests in `src/`, `schemas/`, `scripts/`, `tests/`, and generated `dist/` are the implementation under development.
- `.delivery/tasks/global-sop-2-1-beta-1-fix-1-repair-4/ledger.jsonl` is retained as append-only historical evidence; it is not the gate for continued development of SOP itself.
- `.delivery/tasks/global-sop-2-1-beta-1-fix-1-repair-4/ledger.jsonl` sequence 4 binds the independent implementation review raw SHA 324f451c3e60b1a18763c52f896c813dcb0933de87e520e0a9b7eb075b16c0fc and is the durable authority for the three repaired P0 findings.
- The user's 2026-08-16 decision is that a SOP version under development must not govern or approve itself; the new runner becomes authoritative only after implementation, independent review, release, and explicit apply.
- `docs/implementation-prompts/beta2-ai-mutual-review.md` is the feature input for the mutual-review addition; the provider-neutral request/response implementation is authoritative over its hard-coded model pseudocode.
- The user-supplied beta3 path in the Claude worktree did not exist. `docs/implementation-prompts/beta3-optimize-accountability.md` in this open main worktree is the beta3 feature input.

## Current State

The source stage is converged but intentionally remains open. The three P0 repairs, beta2 mutual-review, and beta3 accountability optimization are implemented, and the normal engineering verification baseline is green. Additional user comments and features may still be merged before the final combined review.

Historical task `global-sop-2-1-beta-1-fix-1-repair-4` remains `IN_PROGRESS`. Its ledger raw SHA is `0adc19462856b3de1c7de4e654e6eddf248697c4c9ff8403d3afaeb10d5b087a`; sequence 8 event digest `e6a8617bc2487a2ad952054618e2e9d7dc455314574a2f00c78277b2d0a538ff` is unchanged. No repair-5 directory exists, and no task was closed.

Repository HEAD/tree remain `9b5e9d7aeaff87bb431b55e9ecf5944e591bd490` / `cfce858488fbed818dd57aba7c7cd7f4edac7629`. The worktree is intentionally dirty and does not yet define a final candidate identity.

## Decisions

- Stop the repair-5/repair-6 chain. Do not use the under-development beta1 SOP to authorize, verify, review, or close itself.
- Keep existing `.delivery` repair history intact; do not delete, rewrite, restore stale canonical review artifacts, or append more transitions during source development.
- Preserve the three P0 repairs: exact user-authorized actor registry transitions, fail-closed accountability derivation/sanctions, and predecessor-bound remediation eligibility.
- Keep the repaired-candidate task-graph behavior as a product bug fix, but review it with the final combined source diff rather than using it to rescue the historical repair task.
- Merge forthcoming comments/features before freezing a final candidate. Independent review, release packaging, and explicit apply happen only after that combined implementation is stable.
- Mutual-review is opt-in when both `selfReview` and `knownIssues` are present, preserving beta1 input behavior. Self-review remains advisory and cannot accept a contract or authorize a transition.
- AI integration is provider-neutral: the CLI emits exact self-review and independent-review request packets and validates structured responses. The runner contains no model credentials or hard-coded vendor network client.
- The under-development runner does not dog-food itself as acceptance evidence. A user-readable review summary is read-only and explicit user confirmation remains outside the transition command.
- Preserve strict-v1 historical bootstrap scores exactly. New finding transitions use graduated-v2 scoring with WARNING at 3-4, normalized lifetime defect-class counts, escalating repeat surcharges, and unchanged immediate suspension for trust-boundary offenses.
- Permanent gate documents bind actor, finding, remediation event, rule, document digest, and trigger chain. Preflight checks gates for author and owner but remains read-only; installation and trigger recording are explicit mutations.
- A clean task must be a real CLOSED schema-v2 task with no repair/block path, two accepted zero-finding reviews, one complete first-pass evidence run, and recomputed artifact identities. Clean verification and recovery-plan commands are read-only and never award credit or change standing.

## Completed

- Repaired actor-registry policy, authorization, actor-state transition, and replay bindings.
- Repaired accountability derivation so direct standing/sanction forgery, omitted active sanctions, and caller-cached state fail closed.
- Repaired the remediation bridge so copied or candidate-selected predecessor tasks cannot establish eligibility.
- Added adversarial tests for all three P0 boundaries and source task-graph handling for historical reviews after a newer candidate.
- Increased only the real-repository task-graph test timeout from 15 to 30 seconds after it consistently required 17-19 seconds in the full suite while passing functionally in isolation.
- Rebuilt generated dist from current TypeScript source.
- Added opt-in enhanced preflight rules for explicit source/test pairing, R3 security/compatibility/rollback coverage, bounded scope-to-acceptance warnings, and exact self-review validation.
- Added `contract self-check`, exact pre-attachment input digest binding, single attached-pass enforcement, structured known issues, and provider-neutral response finalization.
- Added `task contract-review-request`, reviewer separation from both author and owner, assisted checklist/schema, mechanically recomputed self-review comparison, and `task review-summary`.
- Added self-review and independent-review guides, response/review templates, schema coverage, CLI help, focused tests, and generated dist.
- Added `WARNING`, normalized graduated scoring, exact repeat metadata validation for new accountability events, and beta3 standing/permission schema coverage while preserving historical bootstrap derivation.
- Added provenance-bound permanent gate documents, digest-chained trigger history, built-in gate mappings, fail-closed actor gate preflight enforcement, and `accountability gates`.
- Added real-path clean-task verification, provisional R3/R2/R1 recovery credit calculation, four/five-task recovery planning, permanent-gate recovery requirements, `task verify-clean`, and `accountability recovery-plan`.
- Added permanent-gate and recovery guides, beta3 CLI documentation, adversarial gate tamper tests, exact standing-boundary scoring tests, CLOSED-task evidence-tamper tests, recovery-plan immutability coverage, and regenerated dist.

## Verification

- Node 22 build and typecheck: PASS.
- Focused beta3 boundary suite: PASS, including graduated scoring, gate provenance/tamper, real CLOSED clean-task, historical sanction derivation, and recovery planning.
- Unit suite: PASS, 32 files and 138 tests.
- Integration suite: PASS, 28 files and 129 tests; one explicitly skipped real-project test.
- Combined full suite: PASS, 60 files and 267 tests; one explicitly skipped file/test.
- Governance docs: PASS, 18 semantic assertions.
- Placeholder scan: PASS, 200 files.
- License inventory: PASS, 64 packages.
- Accountability bootstrap exact output: PASS with `valid: true`, codex score 20/SUSPENDED, reviewer score 8/PROBATION, and repair-4 remediation identity.
- `git diff --check`: PASS.
- Codex disk guard: PASS with 52.9 GiB free and no clone warning at beta3 startup.
- The first concurrent unit run exposed only the 15-second real-repository scan timeout; the isolated test passed in 11.88 seconds, and the full unit suite passed after the focused 30-second budget correction.

## Pending

- [ ] Merge the user's remaining comments and feature changes without resetting or cleaning the current dirty worktree.
- [ ] Re-run build, unit, integration, static checks, and diff checks on the combined final source.
- [ ] Freeze one exact final diff/commit identity and obtain independent implementation review outside self-governing beta1 lifecycle logic.
- [ ] Only after acceptance, prepare a separate release/apply decision; keep this stage open until then.

## Next Action

Accept the next user comment or feature, inspect its overlap with the current dirty implementation, merge it into this source stage, and re-run proportionate verification. Do not create repair-5 and do not close or apply the SOP.

## Risks And Blockers

- The worktree contains a large amount of related beta1 source, documentation, generated, and historical `.delivery` state. Never reset, clean, stash, broadly stage, or overwrite it.
- There is no final candidate, commit, replay, verification, or accepted implementation review for the combined stage yet; current green tests are a development checkpoint, not release acceptance.
- Provider-neutral packet and schema tests prove structure and binding, not the quality, latency, or false-positive rate of a live Codex/Claude review. That runtime/product evidence remains pending until an exact combined candidate is independently exercised.
- Permanent gate and clean-task tests prove local artifact integrity and lifecycle binding; they do not authenticate a human/AI identity beyond the existing local-claim and explicit authorization model.
- The pinned 2.0.0 project check remains incompatible with the historical repaired-candidate lifecycle. That known self-governance defect is not a development gate under the user's explicit decision, but it must be resolved before any future apply strategy relies on that task graph.

## External Agent Evidence

- The earlier independent review established three P0 implementation findings against the first candidate; all three have corresponding code and adversarial-test repairs in the current worktree.
- No independent reviewer has accepted the current combined source. Review remains pending until the user's additional comments/features are merged.
- No external AI review was invoked for beta2 in this task; the implementation was exercised through deterministic request/response fixtures and the existing independent-review verifier.
