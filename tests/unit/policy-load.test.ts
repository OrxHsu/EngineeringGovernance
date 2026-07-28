import { describe, expect, it } from 'vitest'

import { validateDocument, validateProjectPolicy } from '../../src/policy/load.js'

describe('project policy', () => {
  it('accepts a pinned valid policy', () => {
    const result = validateProjectPolicy({
      schemaVersion: 1,
      sopVersion: '1.0.0',
      sopDigest: 'a'.repeat(64),
      projectId: 'sample',
      adapters: [],
      artifactMapping: {},
    })

    expect(result).toEqual({ valid: true, errors: [] })
  })

  it('rejects an unpinned policy', () => {
    const result = validateProjectPolicy({ schemaVersion: 1, projectId: 'sample' })

    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('sopVersion')
  })

  it('rejects unknown properties', () => {
    const result = validateProjectPolicy({
      schemaVersion: 1,
      sopVersion: '1.0.0',
      sopDigest: 'a'.repeat(64),
      projectId: 'sample',
      adapters: [],
      artifactMapping: {},
      handwrittenPass: true,
    })

    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('additionalProperties')
  })
})

describe('workflow document schemas', () => {
  it.each([
    ['task-contract', {
      schemaVersion: 1,
      taskId: 'task-1',
      sopVersion: '1.0.0',
      contractDigest: 'b'.repeat(64),
      risk: 'R2',
      state: 'DEFINED',
      implementationOwner: 'codex',
      objective: 'Implement one bounded feature.',
      scope: ['src/**'],
      nonGoals: ['deployment'],
      authorityInputs: ['spec.md'],
      acceptance: [{
        id: 'AC-01',
        observation: 'The command returns exit code zero.',
        positiveCases: ['valid input'],
        negativeCases: ['missing input'],
      }],
      requiredGates: ['pnpm test'],
      openChoices: ['internal function names'],
    }],
    ['evidence', {
      schemaVersion: 1,
      taskId: 'task-1',
      contractDigest: 'b'.repeat(64),
      runId: 'run-1',
      runnerVersion: '1.0.0',
      implementationCommits: [{ repository: 'repo', commit: 'c'.repeat(40), tree: 'd'.repeat(40) }],
      records: [{
        acceptanceId: 'AC-01',
        runId: 'run-1',
        executedCheckIds: ['test:ac-01'],
        command: 'pnpm test',
        exitCode: 0,
        startedAt: '2026-07-29T00:00:00Z',
        endedAt: '2026-07-29T00:00:01Z',
        evidenceKind: 'unit',
        implementationIdentities: { repo: 'c'.repeat(40) },
        rawArtifact: { path: 'artifacts/test.json', sha256: 'e'.repeat(64) },
        observation: 'Named test executed successfully.',
      }],
      summary: { passedIds: ['AC-01'], failedIds: [] },
    }],
    ['review', {
      schemaVersion: 1,
      taskId: 'task-1',
      contractDigest: 'b'.repeat(64),
      reviewedImplementation: [{ repository: 'repo', commit: 'c'.repeat(40) }],
      reviewer: 'independent-codex',
      decision: 'ACCEPTED',
      findings: [],
      nextStage: 'CLOSED',
      userActionRequired: false,
    }],
    ['exception', {
      schemaVersion: 1,
      exceptionId: 'EX-1',
      ruleId: 'CORE-01',
      ruleClass: 'waiverable',
      reason: 'Temporary compatibility boundary.',
      scope: ['project:sample'],
      approvedBy: 'user',
      issuedAt: '2026-07-29T00:00:00Z',
      expiresAt: '2026-08-01T00:00:00Z',
      status: 'active',
      compensatingControls: ['manual independent review'],
    }],
    ['authorization', {
      schemaVersion: 1,
      authorizationId: 'AUTH-1',
      approvedBy: 'user',
      issuedAt: '2026-07-29T00:00:00Z',
      expiresAt: '2026-07-29T01:00:00Z',
      scope: ['temporary-project:r3-pilot'],
      status: 'approved',
    }],
  ] as const)('accepts a minimal valid %s document', (kind, input) => {
    expect(validateDocument(kind, input)).toEqual({ valid: true, errors: [] })
  })
})
