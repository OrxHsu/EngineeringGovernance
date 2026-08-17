import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

import { validateDocument } from '../../src/policy/load.js'

describe('contract review schema', () => {
  it('rejects malformed and incomplete review records without throwing', () => {
    for (const value of [null, [], {}, { schemaVersion: 2 }, {
      schemaVersion: 2,
      artifactType: 'sop-contract-review-v2',
      taskId: 'task',
      decision: 'ACCEPTED',
    }]) {
      expect(validateDocument('contract-review', value).valid).toBe(false)
    }
  })

  it('rejects unknown keys and invalid finding classifications', () => {
    const invalid = {
      schemaVersion: 2,
      artifactType: 'sop-contract-review-v2',
      reviewId: `crv-task-${'0'.repeat(64)}`,
      taskId: 'task',
      risk: 'R2',
      reviewer: { id: 'reviewer', trustLevel: 'local-claim' },
      decision: 'REPAIR_REQUIRED',
      contract: { path: '/tmp/contract.yaml', rawSha256: '0'.repeat(64), digest: '0'.repeat(64) },
      checklist: {},
      r3Requirements: {},
      findings: [{ id: 'CR-001', severity: 'HIGH', classification: 'other', observation: 'bad', requiredChange: 'fix', evidenceRefs: [] }],
      nextStage: 'contract-repair',
      userActionRequired: false,
      unexpected: true,
    }
    const result = validateDocument('contract-review', invalid)
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('additionalProperties')
  })

  it('accepts the assisted-review template shape', () => {
    const template = parse(readFileSync(join(process.cwd(), 'templates/task-contract-review-assisted.yaml'), 'utf8'))
    expect(validateDocument('contract-review', template)).toEqual({ valid: true, errors: [] })
  })
})
