# Existing Project Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt ProjTrav and NoMe into the verified global workflow without overwriting existing authorities, dirty worktrees, generated targets, or Apple runtime safety rules.

**Architecture:** The governance CLI first produces authority-aware dry-run manifests for each project. Adoption writes `.delivery` policy files and managed references into each project's canonical rule sources, then invokes existing project synchronization/check commands. Each independent Git repository receives exact-path commits; no application implementation or runtime/device action is included.

**Tech Stack:** Governance CLI, Git, project-owned shell/Node validators, Markdown/YAML policy adapters

---

## File map

### ProjTrav

- Modify: `/Users/xgh/Documents/VibeCoding/ProjTrav_V1/Docs/AGENTS.md`
- Modify: `/Users/xgh/Documents/VibeCoding/ProjTrav_V1/Docs/rules/workspace-agent-entrypoint.md`
- Modify: `/Users/xgh/Documents/VibeCoding/ProjTrav_V1/Docs/rules/backend-agent-rules.md`
- Modify: `/Users/xgh/Documents/VibeCoding/ProjTrav_V1/Docs/rules/ios-agent-rules.md`
- Create: `/Users/xgh/Documents/VibeCoding/ProjTrav_V1/.delivery/policy.yaml`
- Create: `/Users/xgh/Documents/VibeCoding/ProjTrav_V1/.delivery/extensions.yaml`
- Create: `/Users/xgh/Documents/VibeCoding/ProjTrav_V1/.delivery/check-delivery-policy.sh`
- Create: `/Users/xgh/Documents/VibeCoding/ProjTrav_V1/.delivery/runtime/engineering-governance-1.0.0.tgz`
- Generated checks may update exact documented AGENTS/CLAUDE/Cursor targets in the three existing Git repositories.

### NoMe

- Modify: `/Users/xgh/Documents/VibeCoding/NoMe_V2/AGENTS.md`
- Create: `/Users/xgh/Documents/VibeCoding/NoMe_V2/.delivery/policy.yaml`
- Create: `/Users/xgh/Documents/VibeCoding/NoMe_V2/.delivery/extensions.yaml`
- Create: `/Users/xgh/Documents/VibeCoding/NoMe_V2/.delivery/check-delivery-policy.sh`
- Create: `/Users/xgh/Documents/VibeCoding/NoMe_V2/.delivery/runtime/engineering-governance-1.0.0.tgz`

### Governance package

- Create: `tests/integration/real-project-dry-run.test.ts`
- Create: `docs/adoptions/projtrav-v1.md`
- Create: `docs/adoptions/nome-v2.md`

### Task 1: Real-project preflight and dry-run fixtures

**Files:**
- Create: `tests/integration/real-project-dry-run.test.ts`
- Create: `docs/adoptions/projtrav-v1.md`
- Create: `docs/adoptions/nome-v2.md`

- [ ] **Step 1: Record read-only authority mappings**

ProjTrav maps generated root/server/iOS entrypoints to root `Docs/rules/*` and
keeps root `Docs/` authoritative. NoMe maps directly to root `AGENTS.md` and keeps
`Docs/ODD.md` as project product/data authority. Record exact pre-adoption HEADs
and dirty paths without copying file contents into the adoption record.

- [ ] **Step 2: Add a gated real-project dry-run test**

```ts
it.runIf(process.env.REAL_PROJECT_DRY_RUN === '1')('does not mutate real projects', async () => {
  const before = await snapshotTrackedAndUntrackedTargets(projects)
  await runSop(['adopt', projTrav, '--json'])
  await runSop(['adopt', noMe, '--json'])
  expect(await snapshotTrackedAndUntrackedTargets(projects)).toEqual(before)
})
```

- [ ] **Step 3: Run package gates and real dry-run**

Run: `pnpm check && REAL_PROJECT_DRY_RUN=1 pnpm exec vitest run tests/integration/real-project-dry-run.test.ts`

Expected: package gates pass; dry-run reports planned canonical-source writes and
zero filesystem changes.

- [ ] **Step 4: Commit governance-side preflight**

```bash
git add tests/integration/real-project-dry-run.test.ts docs/adoptions
git commit -m "test: verify real project adoption dry-runs"
```

### Task 2: Install global Codex adapter and Skill

**Files:**
- Modify managed block only: `/Users/xgh/.codex/AGENTS.md`
- Create managed Skill: `/Users/xgh/.codex/skills/delivery-sop/`

- [ ] **Step 1: Run a fresh global dry-run and save its plan digest**

Run: `pnpm sop -- global install --tool codex`

Expected: exact managed paths and one plan digest; no writes.

- [ ] **Step 2: Verify no manager-owned source is bypassed**

Inspect CC Switch ownership read-only. If it owns the relevant global instruction
source, change the persistent common source through its supported mechanism; do
not edit only a generated target. If it does not own AGENTS content, apply the
managed block directly to `.codex/AGENTS.md`.

- [ ] **Step 3: Apply the exact reviewed plan**

Run: `pnpm sop -- global install --tool codex --apply-plan <exact-dry-run-digest>`

Expected: only the managed global block and managed Skill paths change.

- [ ] **Step 4: Verify installation**

Run: `pnpm sop -- global check --tool codex && pnpm check`

Expected: adapter/Skill digests match and all governance tests pass.

### Task 3: Adopt ProjTrav across its three Git repositories

**Files:**
- Modify/Create: exact ProjTrav paths listed in the file map

- [ ] **Step 1: Confirm implementation writers are stopped and snapshot all repositories**

Check active Qoder/Codex tasks and test/database processes. Record root, Server,
and iOS HEAD/status. Stop without applying if another agent is editing any
overlapping rule or `.delivery` path.

- [ ] **Step 2: Run and inspect the adoption dry-run**

Run: `pnpm sop -- adopt /Users/xgh/Documents/VibeCoding/ProjTrav_V1 --json`

Expected: planned writes target root canonical `Docs/` rule sources and new root
`.delivery` files; generated targets are identified with before-digest guards,
included in the reviewed plan digest, and checked for dirty overlap in each of
the root, server, and iOS Git repositories without being directly authored.

- [ ] **Step 3: Apply the exact plan digest**

Run: `pnpm sop -- adopt /Users/xgh/Documents/VibeCoding/ProjTrav_V1 --apply-plan <exact-dry-run-digest>`

Expected: unrelated dirty paths are unchanged.

- [ ] **Step 4: Run ProjTrav canonical synchronization and policy checks**

Run from ProjTrav root:

```bash
./scripts/sync-docs.sh --write
./scripts/sync-docs.sh --check
node scripts/generate-physical-catalog.mjs --check
node scripts/check-entity-contract-manifest.mjs --check
.delivery/check-delivery-policy.sh
```

Expected: every command exits 0. Do not run Simulator, device enumeration,
physical-device tests, application implementation tests, migrations, or remote
operations for this governance-only adoption.

- [ ] **Step 5: Commit exact paths in each owning repository**

Create coherent commits only after verifying each repository diff. Never stage
the pre-existing modified `Docs/handoffs/phase-2b-places-map.md` unless it was
changed by this adoption and its ownership is explicitly resolved.

### Task 4: Adopt NoMe

**Files:**
- Modify/Create: exact NoMe paths listed in the file map

- [ ] **Step 1: Confirm writers are stopped and snapshot NoMe**

Record HEAD/status and active tasks. Preserve the large mixed dirty worktree and
stop on overlap with `AGENTS.md` or `.delivery`.

- [ ] **Step 2: Run and inspect the dry-run**

Run: `pnpm sop -- adopt /Users/xgh/Documents/VibeCoding/NoMe_V2 --json`

Expected: planned writes preserve `Docs/ODD.md` authority and existing AGENTS
content while adding the managed global workflow block and project extension.

- [ ] **Step 3: Apply the exact plan digest**

Run: `pnpm sop -- adopt /Users/xgh/Documents/VibeCoding/NoMe_V2 --apply-plan <exact-dry-run-digest>`

Expected: only `AGENTS.md` and new `.delivery` paths change.

- [ ] **Step 4: Run NoMe governance and compile-only checks**

Run from NoMe root:

```bash
.delivery/check-delivery-policy.sh
scripts/quick-check.sh
```

Expected: governance check and unsigned `generic/platform=iOS` compile exit 0.
Do not enumerate or run a Simulator/device.

- [ ] **Step 5: Commit exact NoMe paths**

Stage only `AGENTS.md`, `.delivery/policy.yaml`, and
`.delivery/extensions.yaml` after confirming all unrelated dirty paths are
unchanged.

### Task 5: R1/R2/R3 pilots and v1.0.0 release candidate

**Files:**
- Create: `tests/pilots/r1-local/`
- Create: `tests/pilots/r2-review/`
- Create: `tests/pilots/r3-authorization/`
- Create: `docs/pilot-results.md`
- Modify: `VERSION`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Execute the R1 pilot**

Use a temporary repository. Verify one owner can complete a local reversible
change with fresh tests and without a standalone contract bundle.

- [ ] **Step 2: Execute the R2 rejection/repair/acceptance pilot**

Freeze a contract, create a candidate with one cross-boundary violation, require
a consolidated `REPAIR_REQUIRED`, repair under the original owner, generate
fresh evidence, and accept through a distinct review record.

- [ ] **Step 3: Execute the R3 authorization pilot**

Verify missing authorization fails closed, a scoped test authorization permits
only the named temporary target, and expiry or scope drift rejects execution.

- [ ] **Step 4: Run final package and adopted-project gates**

Run: `pnpm install --frozen-lockfile && pnpm check && pnpm sop -- check <each-adopted-project>`

Expected: all package/pilot/project governance gates pass with no skipped
required checks.

- [ ] **Step 5: Prepare but do not publish the release**

Set package/VERSION to `1.0.0`, update README and pilot results, run the full
gate again, and commit. Create local tag `v1.0.0` only after final independent
review; do not push or publish without explicit user authorization.
