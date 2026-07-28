import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { planAdoption, verifyAdoptedProject } from '../../src/commands/adopt.js'
import { applyAdoption } from '../../src/commands/init.js'
import { startTask } from '../../src/commands/task-start.js'
import { verifyCandidateEligibility } from '../../src/commands/task-verify.js'
import { verifyReviewEligibility } from '../../src/commands/task-review.js'
import { verifyCloseEligibility } from '../../src/commands/task-close.js'
import { buildProgram } from '../../src/cli/main.js'
import { testRunnerBundle } from '../helpers/runner-bundle.js'

const taskBase = {
  taskId: 'task-1',
  implementationOwner: 'codex',
  objective: 'Implement one bounded behavior.',
  scope: ['src/**'],
  nonGoals: ['deployment'],
  authorityInputs: ['spec.md'],
  acceptance: [{
    id: 'AC-01',
    observation: 'The named check passes.',
    positiveCases: ['valid input'],
    negativeCases: ['missing input'],
  }],
  requiredGates: ['pnpm test'],
  openChoices: ['internal names'],
}

describe('project command workflow', () => {
  it('keeps adopt CLI read-only until an exact plan digest is supplied', async () => {
    const project = mkdtempSync(join(tmpdir(), 'governance-cli-'))
    let output = ''
    const program = buildProgram({ write: (text) => { output += text } })
    await program.parseAsync(['node', 'sop', 'adopt', project, '--json'])

    const parsed = JSON.parse(output) as {
      digest: string
      writes: Array<Record<string, unknown>>
    }
    expect(parsed.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(parsed.writes.length).toBeGreaterThan(0)
    expect(parsed.writes.every((write) => 'afterDigest' in write && !('after' in write))).toBe(true)
    expect(verifyAdoptedProject(project).errors).toContain('PROJECT_POLICY_MISSING')
  })

  it('includes the pinned runner in a bootstrap adoption plan', async () => {
    const project = mkdtempSync(join(tmpdir(), 'governance-cli-runner-'))
    const bundle = join(project, 'engineering-governance-0.1.0-dev.tgz')
    writeFileSync(bundle, 'test runner archive\n')
    let output = ''
    await buildProgram({ write: (text) => { output += text } }).parseAsync([
      'node',
      'sop',
      'adopt',
      project,
      '--runner-bundle',
      bundle,
      '--json',
    ])
    const plan = JSON.parse(output) as { writes: Array<{ path: string; after?: unknown }> }
    expect(plan.writes.every((write) => write.after === undefined)).toBe(true)
    expect(plan.writes.map((write) => write.path)).toContain(join(
      project,
      '.delivery/runtime/engineering-governance-0.1.0-dev.tgz',
    ))
  })

  it('plans before applying and verifies the adopted project', () => {
    const project = mkdtempSync(join(tmpdir(), 'governance-cli-'))
    const plan = planAdoption(project, { runnerBundlePath: testRunnerBundle() })

    expect(plan.writes.map((write) => write.path.endsWith('policy.yaml'))).toContain(true)
    expect(verifyAdoptedProject(project).valid).toBe(false)

    expect(applyAdoption(plan, plan.digest).applied.length).toBeGreaterThan(0)
    expect(verifyAdoptedProject(project)).toEqual({ valid: true, errors: [] })
  })

  it('rejects an apply digest that was not reviewed', () => {
    const project = mkdtempSync(join(tmpdir(), 'governance-cli-'))
    const plan = planAdoption(project)
    expect(() => applyAdoption(plan, 'f'.repeat(64))).toThrow('ADOPTION_PLAN_DIGEST_MISMATCH')
  })
})

describe('task command workflow', () => {
  it('keeps R1 lightweight', () => {
    const result = startTask({
      ...taskBase,
      signals: { localEdit: true, classificationComplete: true },
    })
    expect(result.risk).toBe('R1')
    expect(result.state).toBe('DEFINED')
    expect(result.artifacts).toEqual([])
  })

  it('creates a frozen R2 contract artifact', () => {
    const result = startTask({ ...taskBase, signals: { crossModule: true } })
    expect(result.risk).toBe('R2')
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0]?.path).toBe('.delivery/tasks/task-1/contract.yaml')
    expect(result.artifacts[0]?.content).toContain('contractDigest:')
  })

  it('keeps an unauthorized R3 task out of candidate state', () => {
    const task = startTask({ ...taskBase, signals: { production: true } })
    expect(verifyCandidateEligibility({
      risk: task.risk,
      requiredGateErrors: [],
      authorizationRequired: true,
      authorizationApproved: false,
    })).toEqual({
      valid: false,
      errors: ['CANDIDATE_VERIFICATION_REQUIRED', 'USER_AUTHORIZATION_REQUIRED'],
    })
  })

  it('requires independent, finding-free R2 review', () => {
    expect(verifyReviewEligibility({
      risk: 'R2',
      implementationOwner: 'qoder',
      reviewOwner: 'qoder',
      blockingFindingIds: [],
    }).errors).toContain('INDEPENDENT_REVIEW_REQUIRED')

    expect(verifyReviewEligibility({
      risk: 'R2',
      implementationOwner: 'qoder',
      reviewOwner: 'codex',
      blockingFindingIds: ['F-1'],
    }).errors).toContain('BLOCKING_FINDING:F-1')
  })

  it('closes only coherent accepted tasks', () => {
    expect(verifyCloseEligibility({
      state: 'ACCEPTED',
      projectStatusValid: true,
      pendingRequiredIds: [],
    })).toEqual({ valid: true, errors: [] })

    expect(verifyCloseEligibility({
      state: 'CANDIDATE',
      projectStatusValid: false,
      pendingRequiredIds: ['AC-02'],
    }).errors).toEqual([
      'PROJECT_STATUS_INCOHERENT',
      'REQUIRED_ITEM_PENDING:AC-02',
      'TASK_NOT_ACCEPTED',
    ])
  })
})
