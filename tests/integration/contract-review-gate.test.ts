import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

import { canonicalDigest } from '../../src/model/digest.js'
import { startTask } from '../../src/commands/task-start.js'
import { validateProjectTaskGraph } from '../../src/project/task-graph.js'

const roots: string[] = []

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function writeReview(root: string, taskId: string, decision: 'ACCEPTED' | 'REPAIR_REQUIRED'): string {
  const contractPath = join(root, `.delivery/tasks/${taskId}/contract.yaml`)
  const contractRaw = readFileSync(contractPath)
  const contract = parse(contractRaw.toString('utf8')) as Record<string, any>
  const evidenceRef = {
    id: 'E-001', kind: 'contract', path: `.delivery/tasks/${taskId}/contract.yaml`,
    sha256: sha256(contractRaw), digest: canonicalDigest(contract),
  }
  const item = { status: 'PASS', evidenceRefs: [evidenceRef] }
  const r3 = { status: 'NA', applicabilityReason: 'risk-below-r3', evidenceRefs: [evidenceRef] }
  const review = {
    schemaVersion: 2,
    artifactType: 'sop-contract-review-v2',
    reviewId: `crv-${taskId}-${String(contract.contractDigest)}`,
    taskId,
    risk: contract.risk,
    reviewer: { id: 'independent-graph-reviewer', trustLevel: 'local-claim' },
    decision,
    contract: { path: contractPath, rawSha256: sha256(contractRaw), digest: contract.contractDigest },
    checklist: Object.fromEntries([
      'scope_non_goals', 'authority_dependencies', 'risk_owner_reviewer',
      'behavior_state_transitions', 'security_trust', 'evidence_environment',
      'external_source_provenance', 'rollout_recovery_compatibility',
      'unresolved_product_decisions',
    ].map((key) => [key, item])),
    r3Requirements: Object.fromEntries([
      'trust_threat_analysis', 'migration_recovery_rollback', 'specialized_gates',
      'scoped_authorization', 'production_observation',
    ].map((key) => [key, r3])),
    findings: decision === 'ACCEPTED' ? [] : [{
      id: 'CR-001', severity: 'BLOCKER', classification: 'contract_violation',
      observation: 'repair required', requiredChange: 'repair', evidenceRefs: [evidenceRef],
    }],
    nextStage: decision === 'ACCEPTED' ? 'implementation' : 'contract-repair',
    userActionRequired: decision !== 'ACCEPTED',
  }
  const reviewPath = join(root, `.delivery/tasks/${taskId}/contract-review.yaml`)
  writeFileSync(reviewPath, stringify(review))
  return reviewPath
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('contract-review graph gate', () => {
  it('allows a newly created R2 task to wait in DEFINED before review', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sop-contract-review-graph-')))
    roots.push(root)
    execFileSync('git', ['-C', root, 'init', '-b', 'main'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    writeFileSync(join(root, 'authority.md'), 'authority\n')
    execFileSync('git', ['-C', root, 'add', 'authority.md'])
    execFileSync('git', ['-C', root, 'commit', '-m', 'baseline'])

    const taskId = 'graph-readiness-task'
    const result = startTask({
      schemaVersion: 2,
      taskId,
      implementationOwner: 'codex',
      objective: 'Exercise the waiting state.',
      scope: ['src/**'],
      nonGoals: ['deployment'],
      authorityInputs: ['authority.md'],
      repositories: [{ id: 'root', path: root }],
      acceptance: [{
        id: 'AC-01', observation: 'The graph accepts waiting.', positiveCases: ['pass'], negativeCases: ['reject'],
        evidenceKind: 'unit', command: { repositoryId: 'root', cwd: '.', executable: process.execPath, arguments: ['--version'] },
        observerPolicy: { expectedExitCode: 0, output: 'nonempty', checkoutMutation: 'forbidden', replay: 'required' },
      }],
      authorizationRequirements: [],
      openChoices: [],
      signals: { crossModule: true, classificationComplete: true },
    }, { projectExtensions: [] })
    for (const artifact of result.artifacts) {
      const path = join(root, artifact.path)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, artifact.content)
    }
    const contract = parse(readFileSync(join(root, `.delivery/tasks/${taskId}/contract.yaml`), 'utf8')) as Record<string, unknown>
    expect(contract.contractReadiness).toMatchObject({ required: true })
    const graph = validateProjectTaskGraph(root)
    expect(graph.valid).toBe(true)
    expect(graph.errors).toEqual([])
    expect(sha256(readFileSync(join(root, `.delivery/tasks/${taskId}/ledger.jsonl`)))).toHaveLength(64)
  })

  it('allows a valid REPAIR_REQUIRED review while the task remains DEFINED', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sop-contract-review-repair-')))
    roots.push(root)
    execFileSync('git', ['-C', root, 'init', '-b', 'main'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    writeFileSync(join(root, 'authority.md'), 'authority\n')
    execFileSync('git', ['-C', root, 'add', 'authority.md'])
    execFileSync('git', ['-C', root, 'commit', '-m', 'baseline'])
    const taskId = 'defined-repair-task'
    const result = startTask({
      schemaVersion: 2, taskId, implementationOwner: 'codex', objective: 'Wait for repair.',
      scope: ['src/**'], nonGoals: [], authorityInputs: ['authority.md'], repositories: [{ id: 'root', path: root }],
      acceptance: [{
        id: 'AC-01', observation: 'waits', positiveCases: ['pass'], negativeCases: ['reject'], evidenceKind: 'unit',
        command: { repositoryId: 'root', cwd: '.', executable: process.execPath, arguments: ['--version'] },
        observerPolicy: { expectedExitCode: 0, output: 'nonempty', checkoutMutation: 'forbidden', replay: 'required' },
      }],
      authorizationRequirements: [], openChoices: [], signals: { crossModule: true },
    }, { projectExtensions: [] })
    for (const artifact of result.artifacts) {
      const path = join(root, artifact.path)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, artifact.content)
    }
    writeReview(root, taskId, 'REPAIR_REQUIRED')
    const graph = validateProjectTaskGraph(root)
    expect(graph.valid).toBe(true)
    expect(graph.errors).toEqual([])
  })
})
