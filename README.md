# Engineering Governance

[![CI](https://github.com/OrxHsu/EngineeringGovernance/actions/workflows/ci.yml/badge.svg)](https://github.com/OrxHsu/EngineeringGovernance/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/OrxHsu/EngineeringGovernance?include_prereleases)](https://github.com/OrxHsu/EngineeringGovernance/releases)
[![License](https://img.shields.io/github/license/OrxHsu/EngineeringGovernance)](LICENSE)

Engineering Governance is the canonical, versioned development workflow for
user-owned projects. It defines risk classification, task states, evidence
integrity, independent review, exception handling, and safe project adoption.

`sop-2.1.0-release-v1` is the first formal `2.1.0` release. The repository is
public and the release is published on GitHub; npm publication remains a
separate channel and is intentionally not provided by this release.
Version 2 is a breaking lifecycle and artifact-format release. Existing 1.x
projects remain pinned until an explicit reviewed upgrade; see
[`MIGRATING_TO_2.0.md`](MIGRATING_TO_2.0.md).

This project is available under the [Apache-2.0 License](LICENSE). Security reports
should follow [SECURITY.md](SECURITY.md), not a public issue.

Release metadata and the reproducible runner are in
[`releases/sop-2.1.0-release-v1`](releases/sop-2.1.0-release-v1). The recorded
publication is documented in [`publication-record.json`](releases/sop-2.1.0-release-v1/publication-record.json).

## Quick Start

Clone the public repository and run its clean-machine checks:

```sh
git clone https://github.com/OrxHsu/EngineeringGovernance.git
cd EngineeringGovernance
pnpm install --frozen-lockfile
pnpm check
```

To install the Codex adapter and `delivery-sop` Skill through the reviewable
local plan flow:

```sh
pnpm sop -- global install --tool codex
pnpm sop -- global install --tool codex --apply-plan <the-same-plan-digest>
```

The release archive is available from [GitHub Releases](https://github.com/OrxHsu/EngineeringGovernance/releases/tag/sop-2.1.0-release-v1).
Its SHA-256 is recorded in `archive-verification.json`.

## Project Map

- `skills/delivery-sop/`: Codex operational adapter.
- `src/`, `schemas/`, `templates/`: CLI enforcement and machine-readable contracts.
- `tests/`: unit, integration, and adversarial verification.
- `DEVELOPMENT_SOP.md`: canonical workflow rules.
- `SECURITY.md`: vulnerability reporting and scope boundaries.

The CLI governs local reviewable project files. It does not authenticate people
or agents and does not authorize deployment, production, billing, or external
service changes.

## Runtime

- Node.js 22.x
- pnpm with the committed `pnpm-lock.yaml`

Install and verify from this repository:

```sh
pnpm install --frozen-lockfile
pnpm check
```

Until a release is installed globally, invoke the CLI through pnpm:

```sh
pnpm sop -- --help
pnpm sop -- check /absolute/path/to/project --json
pnpm sop -- adopt /absolute/path/to/project --runner-bundle /absolute/path/to/engineering-governance-<version>.tgz --json
```

Install the global Codex adapter and `delivery-sop` Skill with the same
dry-run/confirmed-digest protocol:

```sh
pnpm sop -- global install --tool codex
pnpm sop -- global install --tool codex --apply-plan <reviewed-sha256>
```

The dry-run reports only target paths and before/after digests; it does not emit
existing global instruction contents or CC Switch configuration values.

`init`, `adopt`, and `upgrade` are dry-run-first. With no `--apply-plan`, they
print the exact planned writes and a SHA-256 plan digest. Apply only the same
reviewed plan:

```sh
pnpm sop -- adopt /absolute/path/to/project --runner-bundle /absolute/path/to/engineering-governance-<version>.tgz --json
pnpm sop -- adopt /absolute/path/to/project --runner-bundle /absolute/path/to/engineering-governance-<version>.tgz --apply-plan <reviewed-sha256>
```

Application is rejected if a managed file changes after planning. Existing
content outside the managed block is preserved; the CLI never resets, stashes,
cleans, or broadly stages a worktree.

Task commands consume explicit YAML inputs and emit deterministic JSON:

```sh
pnpm sop -- contract self-check --input /absolute/path/to/start.yaml
pnpm sop -- contract self-check --input /absolute/path/to/start.yaml --response /absolute/path/to/self-review-response.yaml
pnpm sop -- task preflight --project /absolute/path/to/project --input /absolute/path/to/start.yaml
pnpm sop -- task start --project /absolute/path/to/project --input /absolute/path/to/start.yaml --preflight-plan <preflight-plan-sha256>
pnpm sop -- task start --project /absolute/path/to/project --input /absolute/path/to/start.yaml --preflight-plan <preflight-plan-sha256> --apply-plan <reviewed-start-plan-sha256>
pnpm sop -- task contract-review --input /absolute/path/to/.delivery/tasks/<task-id>/contract-review.yaml
pnpm sop -- task contract-review-request --project /absolute/path/to/project --task-id <task-id>
pnpm sop -- task review-summary --project /absolute/path/to/project --task-id <task-id>
pnpm sop -- task review-summary --project /absolute/path/to/project --task-id <task-id> --json
pnpm sop -- task transition --input /absolute/path/to/owner-transition.yaml
pnpm sop -- task transition --input /absolute/path/to/owner-transition.yaml --apply-plan <reviewed-plan-sha256>
pnpm sop -- task execute --input /absolute/path/to/command-execution.yaml
pnpm sop -- task verify --input /absolute/path/to/candidate.yaml
pnpm sop -- task verify --input /absolute/path/to/candidate.yaml --persist
pnpm sop -- task replay --input /absolute/path/to/candidate.yaml
pnpm sop -- task replay --input /absolute/path/to/candidate.yaml --apply-plan <reviewed-plan-sha256>
pnpm sop -- task review --input /absolute/path/to/review.yaml
pnpm sop -- task review --input /absolute/path/to/review.yaml --apply-plan <reviewed-plan-sha256>
pnpm sop -- task close --input /absolute/path/to/closure.yaml
pnpm sop -- task close --input /absolute/path/to/closure.yaml --apply-plan <reviewed-plan-sha256>
pnpm sop -- task verify-clean --project /absolute/path/to/project --task-id <task-id>
pnpm sop -- accountability status --project /absolute/path/to/project --actor <id-or-alias>
pnpm sop -- accountability gates --project /absolute/path/to/project --actor <id-or-alias>
pnpm sop -- accountability recovery-plan --project /absolute/path/to/project --actor <id-or-alias>
pnpm sop -- accountability incident-record --project /absolute/path/to/project --input /absolute/path/to/incident.yaml
pnpm sop -- accountability incident-record --project /absolute/path/to/project --input /absolute/path/to/incident.yaml --apply-plan <reviewed-plan-sha256>
pnpm sop -- legacy inspect --input /absolute/path/to/v1-artifact.yaml
```

Projects are never required to adopt this SOP. An already adopted project exits
only through the drift-checked two-step operation below; task/evidence history
and unrelated files are preserved. Unadoption refuses to plan if the pinned
runner archive or installed wrapper has drifted from its recorded identity:

```sh
pnpm sop -- unadopt /absolute/path/to/project
pnpm sop -- unadopt /absolute/path/to/project --apply-plan <reviewed-plan-sha256>
```

Build a portable, dependency-bundled runner archive for project CI:

```sh
pnpm bundle:runner -- --output /absolute/path/to/output
```

The project adapter records that archive's version, project-relative path, and
SHA-256 in `.delivery/policy.yaml`, then installs
`.delivery/bin/check-delivery-policy.sh`. The wrapper verifies the digest before
execution, installs only the local archive into a temporary prefix with npm
offline mode enabled, runs the pinned `sop check`, and removes the temporary
prefix. It does not write package state into the project or user-global npm
configuration. Adoption also inspects the archive before planning and requires
the expected package metadata, version, templates, schemas, sources, and
compiled `dist/` bytes to match the governance identity being installed.

Schema-v2 mutating R1-R3 tasks create a frozen contract and append-only ledger.
New R2/R3 tasks also require an independent contract-readiness review before
implementation can start; `task contract-review` checks the exact canonical
artifact and `task transition` enforces its ledger binding. R1 tasks remain
owner-only, and pre-gate v2 history is grandfathered without rewriting. R2/R3
acceptance still requires an independent candidate reviewer. `task execute` runs one
contract-frozen executable without a shell and emits a runner-produced receipt
containing the exact command, environment, times, exit code, stdout, stderr,
repository set, and checkout identities. Evidence kinds are not interchangeable.
Candidate verification consumes the canonical candidate and persisted receipts
without executing candidate-controlled commands, then binds its result to exact
contract, candidate, evidence, runner, and implementation identities. Review
and close are non-executing eligibility checks; their legal ledger transitions
require an explicit exact plan digest. `sop check` validates the complete task
graph and reports v1 task directories as legacy inspect-only history.

Beta1 additionally requires a read-only contract preflight before task start.
The preflight freezes input bytes, semantic bindings, repository baselines, risk,
and actor eligibility. A policy-anchored local actor registry and append-only
accountability chain enforce role permissions at every lifecycle boundary.
Culpable findings produce permanent defect-class penalties; remediation and
reinstatement require supervised clean calibration plus explicit user authority.
Rewards never waive readiness, evidence, review, authorization, or provenance
gates.

Beta2 mutual-review assistance is opt-in and backward compatible. A task input
with `selfReview` and `knownIssues` receives four additional preflight checks and
binds the author assessment to the exact pre-attachment input digest. The CLI
generates provider-neutral self-review and independent-review request packets;
it does not embed model credentials or let an author assessment accept a
contract. Assisted independent reviews are mechanically compared with the
author assessment, and `task review-summary` provides a short scan without
performing a lifecycle transition. The feature remains development source until
the combined runner receives independent review and explicit apply approval.

Beta3 accountability optimization adds a `WARNING` standing, graduated
defect-class repeat penalties, actor-specific permanent preflight gates, and a
mechanically verified clean-task recovery path. Historical bootstrap scores are
not rewritten. `task verify-clean`, `accountability gates`, and
`accountability recovery-plan` are read-only views; they never award credit,
install a gate, or change standing by themselves. See
`docs/PERMANENT_GATES.md` and `docs/ACCOUNTABILITY_RECOVERY.md`.

The `2.1.0` release supports a canonical set of implementation
owners while preserving one acting actor per ledger event. It also rejects new
R3 starts that cannot enter the downstream review path, and provides the
dry-run-first `accountability incident-record` command for user-authorized
responsibility and deduction records when the normal governance or review path
is itself blocked.

Pinned-runner bootstrap remediation keeps the runner-native lifecycle
authorization separate from the richer remediation sidecar. Candidate
authorization arrays contain only `sop-authorization-v2`; the `CANDIDATE`
ledger binds that artifact and the sidecar exactly once, while beta1
verification recomputes their contract, predecessor-defect, reviewer, scope,
path, raw-digest, semantic-digest, and expiry bindings. Task names and action
strings are not authorization.

The optional `external-source-provenance@1.0.0` extension defaults every task to
independent implementation. A source-assisted R3 task may freeze an exact
`inspect`, `adapt`, or `copy-exact` allocation. Exact copying is allowed only
inside the pinned source-unit and destination-unit allocation, with complete
actual-use records and an approved project-specific release disposition. The
global package deliberately contains no vendor- or license-specific verdicts.

## Scope and safety

The CLI performs local, reviewable governance-file writes only when given the
exact plan digest. Deployment, push, pull-request creation, production changes,
database migration, service restart, billing, external communication, and other
destructive or external actions are outside its scope. Those actions require
their own project workflow and authorization.

Canonical rules are in `DEVELOPMENT_SOP.md`, `CORE_INVARIANTS.md`, and
`RISK_CLASSIFICATION.md`. Schemas in `schemas/` define the machine-readable
contracts. Project rules may strengthen these requirements but cannot silently
weaken them.
