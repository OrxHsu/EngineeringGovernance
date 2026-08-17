import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'

import { contractSelfCheck, type CompletedSelfReview } from '../../src/commands/contract-self-check.js'
import { SELF_REVIEW_DIMENSIONS, mutualReviewErrors } from '../../src/review/mutual-review.js'

const temporary: string[] = []

function baseInput(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    taskId: 'self-review-test',
    contractAuthor: 'contract-author',
    implementationOwner: 'implementation-owner',
    objective: 'Review one task input.',
    scope: ['src/review/**'],
    nonGoals: ['deployment'],
    authorityInputs: ['CORE_INVARIANTS.md'],
    repositories: [{ id: 'root', path: process.cwd() }],
    acceptance: [{
      id: 'AC-01', observation: 'Review is bound.', positiveCases: ['pass'], negativeCases: ['reject'],
      evidenceKind: 'unit', command: {}, observerPolicy: {}, bindingRefs: ['d-review'],
    }],
    authorizationRequirements: [],
    evidenceFreshnessMs: 1000,
    designBindings: {
      deliverables: [], authorities: [], constants: [], equalities: [], transitions: [], actorRoles: [], artifactKinds: [],
    },
    predecessors: [],
    openChoices: [],
    signals: { crossModule: true },
  }
}

function response(status: 'PASS' | 'CONCERN' = 'PASS'): Record<string, unknown> {
  return {
    durationSeconds: 42,
    dimensions: SELF_REVIEW_DIMENSIONS.map((name) => ({
      name,
      status,
      evidence: status === 'PASS' ? `${name} is covered.` : `${name} needs independent attention.`,
    })),
    overallStatus: status === 'PASS' ? 'PASSED' : 'PASSED_WITH_CONCERNS',
    knownIssues: status === 'PASS' ? [] : SELF_REVIEW_DIMENSIONS.slice(0, 5).map((dimension) => ({
      dimension,
      observation: `${dimension} remains uncertain.`,
      severity: 'MEDIUM',
      deferReason: 'Independent review will resolve it.',
    })),
  }
}

function fixture(): { directory: string; inputPath: string; responsePath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'sop-self-review-'))
  temporary.push(directory)
  const inputPath = join(directory, 'input.yaml')
  const responsePath = join(directory, 'response.yaml')
  writeFileSync(inputPath, stringify(baseInput()))
  writeFileSync(responsePath, stringify(response()))
  return { directory, inputPath, responsePath }
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('contract self-check', () => {
  it('creates a deterministic request and exact subject-bound attachment', () => {
    const { inputPath, responsePath } = fixture()
    const request = contractSelfCheck(inputPath)
    expect(request.artifactType).toBe('engineering-governance-self-review-request-v1')
    expect(request.dimensions).toHaveLength(6)

    const completed = contractSelfCheck(inputPath, responsePath, '2026-08-16T00:00:00.000Z') as CompletedSelfReview
    expect(completed.selfReview.attemptCount).toBe(1)
    expect(completed.selfReview.effort).toBe('medium')
    expect(completed.selfReview.subjectDigest).toBe(request.subjectDigest)
    expect(mutualReviewErrors(completed.augmentedInput)).toEqual([])
  })

  it('rejects a second pass and unrecorded concerns', () => {
    const { directory, inputPath, responsePath } = fixture()
    const completed = contractSelfCheck(inputPath, responsePath) as CompletedSelfReview
    const augmentedPath = join(directory, 'augmented.yaml')
    writeFileSync(augmentedPath, stringify(completed.augmentedInput))
    expect(() => contractSelfCheck(augmentedPath)).toThrow('SELF_REVIEW_SINGLE_PASS_ONLY')

    const concernPath = join(directory, 'concern.yaml')
    const invalid = response('CONCERN')
    ;(invalid.knownIssues as unknown[]).pop()
    writeFileSync(concernPath, stringify(invalid))
    expect(() => contractSelfCheck(inputPath, concernPath)).toThrow('PREFLIGHT_SELF_REVIEW_CONCERN_UNRECORDED')
  })
})
