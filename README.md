# Engineering Governance

Engineering Governance is the canonical, versioned development workflow for
user-owned projects. It defines risk classification, task states, evidence
integrity, independent review, exception handling, and safe project adoption.

The repository is currently `0.1.0-dev` and unreleased. It is not a published
package and does not represent the accepted `v1.0.0` policy baseline.

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
pnpm sop -- task start --input /absolute/path/to/start.yaml
pnpm sop -- task verify --input /absolute/path/to/candidate.yaml
pnpm sop -- task review --input /absolute/path/to/review.yaml
pnpm sop -- task close --input /absolute/path/to/close.yaml
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
configuration.

R0 and R1 tasks do not create standalone contract artifacts by default. R2 and
R3 return a frozen contract artifact; R2/R3 acceptance requires an independent
reviewer. Evidence kinds are not interchangeable, and evidence is bound to the
contract, runner version, raw artifact digest, run, and implementation identity.

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
