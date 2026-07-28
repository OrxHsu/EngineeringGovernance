# Governance Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the versioned global SOP package, schemas, state/risk engine, evidence verifier, and safe project/task CLI.

**Architecture:** A TypeScript Node.js 22 CLI loads YAML project/task inputs, validates them with JSON Schema, and derives risk, state, and evidence decisions without trusting handwritten summaries. Mutation commands operate through a dry-run-first project layer; evidence verification binds frozen contract digests to implementation trees and optional evidence-only closure commits.

**Tech Stack:** Node.js 22, TypeScript, pnpm, Commander, YAML, Ajv, Vitest, Git CLI

---

## File map

- `package.json`, `pnpm-lock.yaml`, `tsconfig.json`: locked governance-only runtime and scripts.
- `DEVELOPMENT_SOP.md`, `CORE_INVARIANTS.md`, `RISK_CLASSIFICATION.md`, `VERSION`: canonical policy release.
- `schemas/*.schema.json`: machine contracts for project policy, tasks, evidence, reviews, and exceptions.
- `src/model/types.ts`: shared domain types.
- `src/policy/load.ts`, `src/policy/risk.ts`, `src/policy/exceptions.ts`: policy loading, classification, and exception checks.
- `src/state/transitions.ts`: state machine and acceptance authority.
- `src/evidence/verify.ts`, `src/evidence/git-identity.ts`: record recomputation and Git/tree binding.
- `src/project/discover.ts`, `src/project/managed-block.ts`, `src/project/mutate.ts`: authority discovery and safe patches.
- `src/metrics/derive.ts`: process-health metrics derived from task/review history.
- `src/commands/*.ts`, `src/cli/main.ts`: CLI commands and exit behavior.
- `templates/*`: default project/task artifacts.
- `tests/unit/*`, `tests/integration/*`, `tests/fixtures/*`: unit, adversarial, and temporary-repository evidence.

### Task 1: Package and CLI skeleton

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/cli/main.ts`
- Test: `tests/unit/cli-help.test.ts`

- [ ] **Step 1: Write the failing CLI help test**

```ts
import { describe, expect, it } from 'vitest'
import { buildProgram } from '../../src/cli/main.js'

describe('sop CLI', () => {
  it('registers the required top-level commands', () => {
    const names = buildProgram().commands.map((command) => command.name())
    expect(names).toEqual(['init', 'adopt', 'check', 'upgrade', 'task'])
  })
})
```

- [ ] **Step 2: Run the test and confirm the missing module failure**

Run: `pnpm exec vitest run tests/unit/cli-help.test.ts`

Expected: FAIL because `src/cli/main.ts` does not exist.

- [ ] **Step 3: Add the locked package and minimal CLI**

```json
{
  "name": "@xgh/engineering-governance",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22 <23" },
  "bin": { "sop": "dist/cli/main.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "sop": "tsx src/cli/main.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "check": "pnpm typecheck && pnpm test && pnpm build"
  },
  "dependencies": {
    "ajv": "8.17.1",
    "commander": "14.0.0",
    "yaml": "2.8.1"
  },
  "devDependencies": {
    "@types/node": "22.17.0",
    "tsx": "4.20.3",
    "typescript": "5.9.2",
    "vitest": "3.2.4"
  }
}
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

```ts
import { pathToFileURL } from 'node:url'
import { Command } from 'commander'

export function buildProgram(): Command {
  const program = new Command().name('sop')
  for (const name of ['init', 'adopt', 'check', 'upgrade']) program.command(name)
  program.command('task')
  return program
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildProgram().parseAsync()
}
```

- [ ] **Step 4: Install and verify the skeleton**

Run: `pnpm install --frozen-lockfile=false && pnpm exec vitest run tests/unit/cli-help.test.ts && pnpm typecheck`

Expected: one test passes and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json src/cli/main.ts tests/unit/cli-help.test.ts
git commit -m "feat: scaffold governance CLI"
```

### Task 2: Canonical policy and schemas

**Files:**
- Create: `DEVELOPMENT_SOP.md`
- Create: `CORE_INVARIANTS.md`
- Create: `RISK_CLASSIFICATION.md`
- Create: `VERSION`
- Create: `schemas/project-policy.schema.json`
- Create: `schemas/task-contract.schema.json`
- Create: `schemas/evidence.schema.json`
- Create: `schemas/review.schema.json`
- Create: `schemas/exception.schema.json`
- Create: `src/model/types.ts`
- Create: `src/policy/load.ts`
- Test: `tests/unit/policy-load.test.ts`

- [ ] **Step 1: Add failing valid/invalid policy tests**

```ts
import { describe, expect, it } from 'vitest'
import { validateProjectPolicy } from '../../src/policy/load.js'

describe('project policy', () => {
  it('accepts a pinned valid policy', () => {
    expect(validateProjectPolicy({
      schemaVersion: 1,
      sopVersion: '1.0.0',
      sopDigest: 'a'.repeat(64),
      projectId: 'sample',
      adapters: [],
      artifactMapping: {},
    }).valid).toBe(true)
  })

  it('rejects an unpinned policy', () => {
    const result = validateProjectPolicy({ schemaVersion: 1, projectId: 'sample' })
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('sopVersion')
  })
})
```

- [ ] **Step 2: Run the focused test**

Run: `pnpm exec vitest run tests/unit/policy-load.test.ts`

Expected: FAIL because policy validation is missing.

- [ ] **Step 3: Define strict schemas and shared types**

The project policy schema must set `additionalProperties: false` and require
`schemaVersion`, `sopVersion`, `sopDigest`, `projectId`, `adapters`, and
`artifactMapping`. Task/evidence/review/exception schemas must use the exact
states and risk values from the approved design. Export matching TypeScript
unions:

```ts
export type Risk = 'R0' | 'R1' | 'R2' | 'R3'
export type TaskState =
  | 'DEFINED' | 'IN_PROGRESS' | 'CANDIDATE' | 'ACCEPTED' | 'CLOSED'
  | 'REPAIR_REQUIRED' | 'BLOCKED' | 'CANCELLED' | 'SUPERSEDED'

export interface ValidationResult {
  valid: boolean
  errors: string[]
}
```

Use Ajv in `load.ts` and sort normalized error strings by instance path and
keyword so repeated validation is deterministic.

- [ ] **Step 4: Write the three canonical policy documents from the approved design**

`DEVELOPMENT_SOP.md` owns the workflow, `CORE_INVARIANTS.md` lists stable rule
IDs with waiver classes, `RISK_CLASSIFICATION.md` owns R0-R3. Set `VERSION` to
`0.1.0-dev`; do not claim a `v1.0.0` release.

- [ ] **Step 5: Run schema, type, and document checks**

Run: `pnpm exec vitest run tests/unit/policy-load.test.ts && pnpm typecheck && rg -n "TBD|TODO|FIXME" DEVELOPMENT_SOP.md CORE_INVARIANTS.md RISK_CLASSIFICATION.md schemas src`

Expected: tests and typecheck pass; `rg` exits 1 with no placeholder matches.

- [ ] **Step 6: Commit**

```bash
git add DEVELOPMENT_SOP.md CORE_INVARIANTS.md RISK_CLASSIFICATION.md VERSION schemas src/model src/policy tests/unit/policy-load.test.ts
git commit -m "feat: define governance policy schemas"
```

### Task 3: Risk classification and exceptions

**Files:**
- Create: `src/policy/risk.ts`
- Create: `src/policy/exceptions.ts`
- Test: `tests/unit/risk.test.ts`
- Test: `tests/unit/exceptions.test.ts`

- [ ] **Step 1: Write failing highest-risk-wins tests**

```ts
import { describe, expect, it } from 'vitest'
import { classifyRisk } from '../../src/policy/risk.js'

describe('risk classification', () => {
  it('selects the highest matched rule', () => {
    expect(classifyRisk({ localEdit: true, persistentData: true, production: false })).toBe('R2')
    expect(classifyRisk({ localEdit: true, persistentData: false, production: true })).toBe('R3')
  })

  it('raises ambiguous mutation to R2', () => {
    expect(classifyRisk({ mutation: true, classificationComplete: false })).toBe('R2')
  })
})
```

- [ ] **Step 2: Write failing exception boundary tests**

```ts
import { expect, it } from 'vitest'
import { validateException } from '../../src/policy/exceptions.js'

it('rejects non-waivable and expired exceptions', () => {
  expect(validateException({ ruleClass: 'non_waivable' }, new Date('2026-07-29')).valid).toBe(false)
  expect(validateException({
    ruleClass: 'waiverable', approvedBy: 'user', expiresAt: '2026-07-28T00:00:00Z'
  }, new Date('2026-07-29')).valid).toBe(false)
})
```

- [ ] **Step 3: Run the focused tests**

Run: `pnpm exec vitest run tests/unit/risk.test.ts tests/unit/exceptions.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement deterministic risk and exception decisions**

```ts
const rank = { R0: 0, R1: 1, R2: 2, R3: 3 } as const

export function highestRisk(risks: Array<keyof typeof rank>): keyof typeof rank {
  return risks.reduce((highest, risk) => rank[risk] > rank[highest] ? risk : highest, 'R0')
}
```

Risk inputs use named booleans and explicit project overrides; exception checks
require exact rule ID, scope, approver, issue time, expiry, and compensating
controls. Never lower a non-waivable or authorization-required rule.

- [ ] **Step 5: Run focused and full unit tests**

Run: `pnpm exec vitest run tests/unit/risk.test.ts tests/unit/exceptions.test.ts && pnpm typecheck`

Expected: all focused tests pass and typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/policy/risk.ts src/policy/exceptions.ts tests/unit/risk.test.ts tests/unit/exceptions.test.ts
git commit -m "feat: classify workflow risk and exceptions"
```

### Task 4: State machine and review authority

**Files:**
- Create: `src/state/transitions.ts`
- Test: `tests/unit/transitions.test.ts`

- [ ] **Step 1: Write the complete transition-matrix test**

```ts
import { describe, expect, it } from 'vitest'
import { canTransition } from '../../src/state/transitions.js'

describe('workflow transitions', () => {
  it('allows the primary and repair paths', () => {
    expect(canTransition('DEFINED', 'IN_PROGRESS')).toBe(true)
    expect(canTransition('IN_PROGRESS', 'CANDIDATE')).toBe(true)
    expect(canTransition('CANDIDATE', 'REPAIR_REQUIRED')).toBe(true)
    expect(canTransition('REPAIR_REQUIRED', 'IN_PROGRESS')).toBe(true)
    expect(canTransition('CANDIDATE', 'ACCEPTED')).toBe(true)
    expect(canTransition('ACCEPTED', 'CLOSED')).toBe(true)
  })

  it('rejects reopening accepted history', () => {
    expect(canTransition('ACCEPTED', 'IN_PROGRESS')).toBe(false)
    expect(canTransition('CLOSED', 'REPAIR_REQUIRED')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `pnpm exec vitest run tests/unit/transitions.test.ts`

Expected: FAIL because the state module is missing.

- [ ] **Step 3: Implement an explicit allowlist and acceptance guard**

```ts
const transitions: Record<TaskState, readonly TaskState[]> = {
  DEFINED: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'],
  IN_PROGRESS: ['CANDIDATE', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'],
  CANDIDATE: ['ACCEPTED', 'REPAIR_REQUIRED', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'],
  REPAIR_REQUIRED: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'],
  BLOCKED: ['IN_PROGRESS', 'CANCELLED', 'SUPERSEDED'],
  ACCEPTED: ['CLOSED'],
  CLOSED: [], CANCELLED: [], SUPERSEDED: [],
}
```

Add `validateAcceptanceAuthority(risk, implementationOwner, reviewOwner)` so R1
allows owner verification while R2/R3 requires a distinct non-empty reviewer.

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run tests/unit/transitions.test.ts && pnpm typecheck`

Expected: transition and authority cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/state/transitions.ts tests/unit/transitions.test.ts
git commit -m "feat: enforce workflow state transitions"
```

### Task 5: Evidence integrity and Git identity

**Files:**
- Create: `src/evidence/verify.ts`
- Create: `src/evidence/git-identity.ts`
- Test: `tests/unit/evidence.test.ts`
- Test: `tests/integration/git-identity.test.ts`
- Create: `tests/fixtures/evidence/*.json`

- [ ] **Step 1: Write failing adversarial evidence tests**

```ts
import { describe, expect, it } from 'vitest'
import { verifyEvidence } from '../../src/evidence/verify.js'

describe('evidence verification', () => {
  it.each([
    'empty-records.json', 'duplicate-id.json', 'summary-mismatch.json',
    'wrong-commit.json', 'cross-run.json', 'partial-record.json'
  ])('rejects %s', async (fixture) => {
    const result = await verifyEvidence(new URL(`../fixtures/evidence/${fixture}`, import.meta.url))
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Write the evidence-closure Git test**

Create a temporary repository with an implementation commit, then an
evidence-only commit. Assert that verification accepts allowlisted
`.delivery/tasks/**/evidence.json` changes and rejects a production-source change
after the implementation commit.

- [ ] **Step 3: Run focused tests**

Run: `pnpm exec vitest run tests/unit/evidence.test.ts tests/integration/git-identity.test.ts`

Expected: FAIL because verification modules and fixtures are missing.

- [ ] **Step 4: Implement record recomputation**

```ts
export interface EvidenceDecision {
  valid: boolean
  errors: string[]
  passedIds: string[]
}

export interface EvidenceRecord {
  acceptanceId: string
  executedCheckIds: string[]
  exitCode: number
  runId: string
  implementationIdentities: Record<string, string>
  rawArtifact: { path: string; sha256: string }
}

export function recomputePassedIds(records: EvidenceRecord[]): string[] {
  return records
    .filter((record) => record.exitCode === 0 && record.executedCheckIds.length > 0)
    .map((record) => record.acceptanceId)
    .sort()
}
```

Reject missing raw-artifact digests, empty executed IDs, duplicate acceptance IDs,
non-zero exit codes reported as pass, mismatched summaries, mixed run IDs, and
implementation identities that do not match every record.

- [ ] **Step 5: Implement the two-layer Git check**

Use `git rev-parse`, `git cat-file -e`, `git rev-parse <sha>^{tree}`, and
`git diff --name-only <implementationSha>..<closureSha>`. Never change the
repository. Reject any post-implementation path outside the contract's exact
evidence/status allowlist.

- [ ] **Step 6: Run evidence tests and typecheck**

Run: `pnpm exec vitest run tests/unit/evidence.test.ts tests/integration/git-identity.test.ts && pnpm typecheck`

Expected: all adversarial rejection cases and valid closure cases pass.

- [ ] **Step 7: Commit**

```bash
git add src/evidence tests/unit/evidence.test.ts tests/integration/git-identity.test.ts tests/fixtures/evidence
git commit -m "feat: verify execution evidence and Git identity"
```

### Task 6: Safe project discovery and managed patches

**Files:**
- Create: `src/project/discover.ts`
- Create: `src/project/managed-block.ts`
- Create: `src/project/mutate.ts`
- Test: `tests/integration/project-adoption.test.ts`

- [ ] **Step 1: Write failing temporary-repository tests**

Cover an empty project, an existing AGENTS file, a generated AGENTS file with a
named canonical source, an unrelated dirty file, and a dirty overlapping source.
Assert dry-run never writes, apply preserves unrelated content, and overlap stops.

```ts
expect(await adoptProject(repo, { dryRun: true })).toMatchObject({ changed: false })
expect(await readFile(join(repo, 'AGENTS.md'), 'utf8')).toBe(original)
```

- [ ] **Step 2: Run the focused integration test**

Run: `pnpm exec vitest run tests/integration/project-adoption.test.ts`

Expected: FAIL because project discovery is missing.

- [ ] **Step 3: Implement read-only discovery**

Discovery returns repository roots, Git status, candidate AGENTS/CLAUDE/Cursor
files, generated ownership markers, package/CI systems, existing `.delivery`,
and conflicts. It never follows a generated target as the mutation source when
an authoritative source is declared.

- [ ] **Step 4: Implement managed blocks and atomic mutation**

```ts
export const START = '<!-- engineering-governance:start -->'
export const END = '<!-- engineering-governance:end -->'

export interface PlannedWrite {
  path: string
  beforeDigest: string | null
  after: string
}
```

Require an exact before-digest at apply time, write to a same-directory temporary
file, fsync, rename, then re-read and verify the after-digest. Do not implement
reset, stash, clean, broad staging, or automatic commit.

- [ ] **Step 5: Verify project safety**

Run: `pnpm exec vitest run tests/integration/project-adoption.test.ts && pnpm typecheck`

Expected: all dry-run, preservation, conflict, and atomic-write cases pass.

- [ ] **Step 6: Commit**

```bash
git add src/project tests/integration/project-adoption.test.ts
git commit -m "feat: add safe project adoption engine"
```

### Task 7: Project and task commands

**Files:**
- Create: `src/commands/init.ts`
- Create: `src/commands/adopt.ts`
- Create: `src/commands/check.ts`
- Create: `src/commands/upgrade.ts`
- Create: `src/commands/task-start.ts`
- Create: `src/commands/task-verify.ts`
- Create: `src/commands/task-review.ts`
- Create: `src/commands/task-close.ts`
- Modify: `src/cli/main.ts`
- Create: `templates/project-policy.yaml`
- Create: `templates/project-extensions.yaml`
- Create: `templates/task-contract.yaml`
- Create: `templates/review.md`
- Test: `tests/integration/cli-workflow.test.ts`

- [ ] **Step 1: Write a failing R1/R2/R3 CLI workflow test**

Use temporary repositories and invoke the program with injected stdout/stderr.
Assert R1 avoids a standalone task bundle, R2 creates contract/evidence/review
paths, and R3 refuses a user-authorization-required transition without approval.

- [ ] **Step 2: Run the focused test**

Run: `pnpm exec vitest run tests/integration/cli-workflow.test.ts`

Expected: FAIL because command handlers are absent.

- [ ] **Step 3: Implement project commands**

`init` refuses non-empty unmanaged projects and routes them to `adopt`. `adopt`
defaults to dry-run. `check` is always read-only. `upgrade` requires exact current
version/digest and emits a patch before apply.

- [ ] **Step 4: Implement task commands**

`task start` derives risk and ownership. `task verify` executes declared gates or
imports supported raw formats and derives candidate eligibility. `task review`
requires exact candidate identities and classification for each finding.
`task close` checks accepted status plus coherent project/handoff records.

- [ ] **Step 5: Register exact CLI options**

```ts
program.command('adopt')
  .argument('<project>')
  .option('--apply', 'apply the reviewed patch', false)
  .action(runAdopt)

const task = program.command('task')
task.command('start').requiredOption('--input <path>').action(runTaskStart)
task.command('verify').requiredOption('--contract <path>').action(runTaskVerify)
task.command('review').requiredOption('--candidate <path>').action(runTaskReview)
task.command('close').requiredOption('--task <path>').action(runTaskClose)
```

- [ ] **Step 6: Verify the workflow**

Run: `pnpm exec vitest run tests/integration/cli-workflow.test.ts && pnpm check`

Expected: workflow tests, full tests, typecheck, and build exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/commands src/cli/main.ts templates tests/integration/cli-workflow.test.ts
git commit -m "feat: implement governance project and task commands"
```

### Task 8: Process-health metrics

**Files:**
- Create: `src/metrics/derive.ts`
- Test: `tests/unit/metrics.test.ts`
- Modify: `src/commands/task-close.ts`
- Modify: `schemas/review.schema.json`

- [ ] **Step 1: Write failing metric derivation tests**

```ts
import { expect, it } from 'vitest'
import { deriveMetrics } from '../../src/metrics/derive.js'

it('derives task health without ranking owners', () => {
  const result = deriveMetrics([
    { taskId: 'a', risk: 'R1', candidateCount: 1, repairCycles: 0, escapedBlockingDefects: 0 },
    { taskId: 'b', risk: 'R2', candidateCount: 2, repairCycles: 1, escapedBlockingDefects: 0 },
  ])
  expect(result.firstCandidateAcceptanceRate).toBe(0.5)
  expect(result.repairCyclesPerAcceptedTask).toBe(0.5)
  expect(result).not.toHaveProperty('ownerRanking')
})
```

- [ ] **Step 2: Run and observe failure**

Run: `pnpm exec vitest run tests/unit/metrics.test.ts`

Expected: FAIL because the metrics module is missing.

- [ ] **Step 3: Implement deterministic aggregate metrics**

Derive first-candidate acceptance, repair cycles, escaped blocking defects,
gate flake/false-positive counts, median time to acceptance by risk, expired
exceptions, and repeated defect classes linked to a permanent gate. Review
records add optional `defectClass` and `permanentGateId`; metrics contain no
per-owner ranking.

- [ ] **Step 4: Emit metrics from task closure without mutating history**

`task close` reads completed task records, emits a deterministic JSON metrics
summary to stdout, and leaves accepted task artifacts immutable.

- [ ] **Step 5: Verify and commit**

Run: `pnpm exec vitest run tests/unit/metrics.test.ts tests/integration/cli-workflow.test.ts && pnpm typecheck`

```bash
git add src/metrics/derive.ts tests/unit/metrics.test.ts src/commands/task-close.ts schemas/review.schema.json
git commit -m "feat: derive workflow health metrics"
```

### Task 9: Complete adversarial and package verification

**Files:**
- Create: `tests/integration/adversarial-workflow.test.ts`
- Create: `scripts/check-placeholders.mjs`
- Create: `scripts/check-licenses.mjs`
- Modify: `package.json`
- Create: `README.md`

- [ ] **Step 1: Add final negative workflow cases**

Test omitted, empty, duplicated, reordered, cross-run, stale, forged,
wrong-commit, partial, compiled-only-as-runtime, expired-exception,
self-review-R2, dirty-overlap, and missing-runner cases. Each fixture must assert
the exact stable error code.

- [ ] **Step 2: Add package checks**

`check-placeholders.mjs` scans canonical/runtime sources for unresolved markers
while allowing documented command metavariables. `check-licenses.mjs` reads the
pnpm lock/importer graph and permits only reviewed permissive dependency licenses.

- [ ] **Step 3: Document exact installation and command behavior**

README examples use `pnpm sop -- ...` before global installation, label
`0.1.0-dev` as unreleased, and state all destructive/external actions remain out
of scope.

- [ ] **Step 4: Run the full fresh gate**

Run: `pnpm install --frozen-lockfile && pnpm check && node scripts/check-placeholders.mjs && node scripts/check-licenses.mjs && git diff --check`

Expected: every command exits 0 with zero test failures and zero disallowed
licenses/placeholders.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/adversarial-workflow.test.ts scripts package.json README.md
git commit -m "test: harden governance workflow gates"
```
