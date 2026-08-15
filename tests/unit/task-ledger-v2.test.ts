import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

import { startTask } from '../../src/commands/task-start.js'
import { canonicalDigest } from '../../src/model/digest.js'
import {
  applyTaskTransition,
  planTaskTransition,
  readTaskLedger,
} from '../../src/state/ledger.js'
import { validateAcceptanceAuthority } from '../../src/state/transitions.js'

const temporaryDirectories: string[] = []

function writeAcceptedReadinessReview(root: string, contract: Record<string, unknown>): string {
  const taskId = String(contract.taskId)
  const contractPath = join(root, `.delivery/tasks/${taskId}/contract.yaml`)
  const contractRaw = readFileSync(contractPath)
  const evidenceRef = {
    id: 'E-001',
    kind: 'contract',
    path: `.delivery/tasks/${taskId}/contract.yaml`,
    sha256: createHash('sha256').update(contractRaw).digest('hex'),
    digest: canonicalDigest(contract),
  }
  const item = { status: 'PASS', evidenceRefs: [evidenceRef] }
  const na = { status: 'NA', applicabilityReason: 'risk-below-r3', evidenceRefs: [evidenceRef] }
  const review = {
    schemaVersion: 2,
    artifactType: 'sop-contract-review-v2',
    reviewId: `crv-${taskId}-${String(contract.contractDigest)}`,
    taskId,
    risk: contract.risk,
    reviewer: { id: 'independent-ledger-reviewer', trustLevel: 'local-claim' },
    decision: 'ACCEPTED',
    contract: { path: contractPath, rawSha256: evidenceRef.sha256, digest: contract.contractDigest },
    checklist: Object.fromEntries([
      'scope_non_goals', 'authority_dependencies', 'risk_owner_reviewer',
      'behavior_state_transitions', 'security_trust', 'evidence_environment',
      'external_source_provenance', 'rollout_recovery_compatibility',
      'unresolved_product_decisions',
    ].map((key) => [key, item])),
    r3Requirements: Object.fromEntries([
      'trust_threat_analysis', 'migration_recovery_rollback', 'specialized_gates',
      'scoped_authorization', 'production_observation',
    ].map((key) => [key, na])),
    findings: [],
    nextStage: 'implementation',
    userActionRequired: false,
  }
  const reviewPath = join(root, `.delivery/tasks/${taskId}/contract-review.yaml`)
  writeFileSync(reviewPath, stringify(review))
  return reviewPath
}

function fixture(): { root: string; contract: Record<string, unknown>; reviewPath: string } {
  const created = mkdtempSync(join(tmpdir(), 'sop-v2-ledger-'))
  temporaryDirectories.push(created)
  const root = realpathSync(created)
  execFileSync('git', ['-C', root, 'init', '-b', 'main'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
  writeFileSync(join(root, 'baseline.txt'), 'baseline\n')
  execFileSync('git', ['-C', root, 'add', 'baseline.txt'])
  execFileSync('git', ['-C', root, 'commit', '-m', 'baseline'])
  const task = startTask({
    schemaVersion: 2,
    taskId: 'ledger-task',
    implementationOwner: ' Codex ',
    objective: 'Prove append-only transitions.',
    scope: ['src/**'],
    nonGoals: [],
    authorityInputs: ['spec.md'],
    repositories: [{ id: 'root', path: root }],
    acceptance: [{
      id: 'AC-01',
      observation: 'The ledger is valid.',
      positiveCases: ['ordered event'],
      negativeCases: ['forged event'],
      evidenceKind: 'static',
      command: {
        repositoryId: 'root', cwd: '.', executable: process.execPath, arguments: ['--version'],
      },
      observerPolicy: {
        expectedExitCode: 0,
        output: 'nonempty',
        checkoutMutation: 'forbidden',
        replay: 'not-required',
      },
    }],
    authorizationRequirements: [],
    openChoices: [],
    signals: { mutation: true, crossModule: true },
  })
  for (const artifact of task.artifacts) {
    const path = join(root, artifact.path)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, artifact.content)
  }
  const contract = parse(task.artifacts[0]!.content) as Record<string, unknown>
  const reviewPath = writeAcceptedReadinessReview(root, contract)
  return { root, contract, reviewPath }
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('v2 task ledger', () => {
  it('plans and atomically applies an exact legal transition', () => {
    const { root, contract, reviewPath } = fixture()

    const plan = planTaskTransition({
      projectRoot: root,
      taskId: 'ledger-task',
      actorId: 'CODEX',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'contract-review', path: reviewPath }],
    })
    expect(plan.event).toMatchObject({
      sequence: 2,
      from: 'DEFINED',
      to: 'IN_PROGRESS',
      actorId: 'codex',
      contractDigest: contract.contractDigest,
    })
    expect(applyTaskTransition(plan, '0'.repeat(64))).toEqual({
      applied: false,
      errors: ['TASK_TRANSITION_PLAN_DIGEST_MISMATCH'],
    })
    expect(applyTaskTransition(plan, plan.digest)).toEqual({ applied: true, errors: [] })

    const ledger = readTaskLedger({
      projectRoot: root,
      taskId: 'ledger-task',
      contractDigest: String(contract.contractDigest),
      contractSha256: plan.contract.sha256,
      implementationOwner: 'codex',
    })
    expect(ledger.valid).toBe(true)
    expect(ledger.currentState).toBe('IN_PROGRESS')
    expect(ledger.events).toHaveLength(2)
  })

  it('rejects illegal jumps, forged history, and normalized self-review aliases', () => {
    const { root, reviewPath } = fixture()
    expect(() => planTaskTransition({
      projectRoot: root,
      taskId: 'ledger-task',
      actorId: 'reviewer',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'contract-review', path: reviewPath }],
    })).toThrow('TASK_TRANSITION_IMPLEMENTATION_OWNER_REQUIRED')
    const forged = planTaskTransition({
      projectRoot: root,
      taskId: 'ledger-task',
      actorId: 'codex',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'contract-review', path: reviewPath }],
    })
    forged.event.actorId = 'reviewer'
    const { eventDigest: _eventDigest, ...unsignedEvent } = forged.event
    forged.event.eventDigest = canonicalDigest(unsignedEvent)
    const { digest: _digest, ...unsignedPlan } = forged
    forged.digest = canonicalDigest(unsignedPlan)
    expect(applyTaskTransition(forged, forged.digest).errors).toContain(
      'TASK_TRANSITION_IMPLEMENTATION_OWNER_REQUIRED',
    )
    expect(() => planTaskTransition({
      projectRoot: root,
      taskId: 'ledger-task',
      actorId: 'reviewer',
      to: 'ACCEPTED',
      artifacts: [{ kind: 'review', path: reviewPath }],
    })).toThrow('TASK_TRANSITION_NOT_ALLOWED:DEFINED:ACCEPTED')

    const ledgerPath = join(root, '.delivery/tasks/ledger-task/ledger.jsonl')
    writeFileSync(ledgerPath, readFileSync(ledgerPath, 'utf8').replace('DEFINED', 'CLOSED'))
    expect(() => planTaskTransition({
      projectRoot: root,
      taskId: 'ledger-task',
      actorId: 'codex',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'contract-review', path: reviewPath }],
    })).toThrow('TASK_LEDGER_INVALID')

    expect(validateAcceptanceAuthority('R3', 'Codex', ' codex ')).toEqual({
      valid: false,
      errors: ['INDEPENDENT_REVIEW_REQUIRED'],
    })
  })

  it('rejects a REPAIR_REQUIRED readiness review before implementation', () => {
    const { root, reviewPath } = fixture()
    const review = parse(readFileSync(reviewPath, 'utf8')) as Record<string, any>
    const evidenceRefs = review.checklist.scope_non_goals.evidenceRefs
    review.decision = 'REPAIR_REQUIRED'
    review.nextStage = 'contract-repair'
    review.userActionRequired = true
    review.findings = [{
      id: 'CR-001', severity: 'BLOCKER', classification: 'contract_violation',
      observation: 'incomplete', requiredChange: 'repair', evidenceRefs,
    }]
    writeFileSync(reviewPath, stringify(review))
    expect(() => planTaskTransition({
      projectRoot: root,
      taskId: 'ledger-task',
      actorId: 'codex',
      to: 'IN_PROGRESS',
      artifacts: [{ kind: 'contract-review', path: reviewPath }],
    })).toThrow('TASK_CONTRACT_READINESS_NOT_ACCEPTED')
  })
})
