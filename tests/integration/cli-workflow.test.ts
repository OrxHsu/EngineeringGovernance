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

const legacyTaskBase = {
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
    const bundle = testRunnerBundle()
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
      '.delivery/runtime/engineering-governance-2.0.0.tgz',
    ))
  }, 15_000)

  it('rejects a correctly named runner archive with unverified internals', () => {
    const project = mkdtempSync(join(tmpdir(), 'governance-cli-invalid-runner-'))
    const bundle = join(project, 'engineering-governance-2.0.0.tgz')
    writeFileSync(bundle, 'not a governance runner\n')
    expect(() => planAdoption(project, { runnerBundlePath: bundle })).toThrow()
  })

  it('plans before applying and verifies the adopted project', () => {
    const project = mkdtempSync(join(tmpdir(), 'governance-cli-'))
    const plan = planAdoption(project, { runnerBundlePath: testRunnerBundle() })

    expect(plan.writes.map((write) => write.path.endsWith('policy.yaml'))).toContain(true)
    expect(verifyAdoptedProject(project).valid).toBe(false)

    expect(applyAdoption(plan, plan.digest).applied.length).toBeGreaterThan(0)
    expect(verifyAdoptedProject(project)).toEqual({ valid: true, errors: [] })
  }, 15_000)

  it('rejects an apply digest that was not reviewed', () => {
    const project = mkdtempSync(join(tmpdir(), 'governance-cli-'))
    const plan = planAdoption(project)
    expect(() => applyAdoption(plan, 'f'.repeat(64))).toThrow('ADOPTION_PLAN_DIGEST_MISMATCH')
  })
})

describe('task command workflow', () => {
  it('rejects legacy task starts instead of silently generating v1 artifacts', () => {
    expect(() => startTask(legacyTaskBase as never)).toThrow(
      'ACTIVE_COMMAND_REQUIRES_SCHEMA_VERSION_2',
    )
  })

  it('keeps legacy candidate declarations on the pinned v1 runner', () => {
    expect(verifyCandidateEligibility({
      risk: 'R3',
      requiredGateErrors: [],
      authorizationRequired: true,
      authorizationApproved: false,
    })).toEqual({
      valid: false,
      errors: ['LEGACY_CANDIDATE_REQUIRES_PINNED_V1_RUNNER'],
    })
  })

  it('requires review artifacts instead of owner declarations', () => {
    expect(verifyReviewEligibility({
      risk: 'R2',
      implementationOwner: 'qoder',
      reviewOwner: 'qoder',
      blockingFindingIds: [],
    } as never).errors).toContain('REVIEW_FILE_UNREADABLE')
  })

  it('rejects artifact-free review and close declarations', () => {
    expect(verifyReviewEligibility({
      risk: 'R3',
      implementationOwner: 'codex',
      reviewOwner: 'independent-reviewer',
      blockingFindingIds: [],
    } as never).valid).toBe(false)

    expect(verifyCloseEligibility({
      state: 'ACCEPTED',
      projectStatusValid: true,
      pendingRequiredIds: [],
    } as never).valid).toBe(false)
  })

  it('requires a bound closure artifact', () => {
    expect(verifyCloseEligibility({
      state: 'ACCEPTED',
      projectStatusValid: true,
      pendingRequiredIds: [],
    } as never).errors).toEqual(['CLOSURE_FILE_UNREADABLE'])
  })
})
