import { describe, expect, it } from 'vitest'

import {
  r3MandatoryDimensionsRule,
  scopeAcceptanceCoverageRule,
  sourceTestPairingRule,
} from '../../src/accountability/preflight-rules.js'
import type { Beta1TaskInput } from '../../src/accountability/preflight.js'

function input(): Beta1TaskInput {
  return {
    schemaVersion: 2,
    taskId: 'mutual-review',
    contractAuthor: 'author',
    implementationOwner: 'owner',
    objective: 'Add review assistance.',
    scope: ['Implement review summary and compatibility handling'],
    nonGoals: [],
    authorityInputs: [],
    repositories: [],
    acceptance: [{
      id: 'SECURITY-COMPATIBILITY-ROLLBACK',
      observation: 'Security, compatibility, and rollback behavior is observed.',
      bindingRefs: ['source'],
      positiveCases: ['pass'],
      negativeCases: ['reject'],
    }],
    authorizationRequirements: [],
    evidenceFreshnessMs: 1,
    designBindings: {
      deliverables: [
        { id: 'source', kind: 'source', path: 'src/review/mutual-review.ts' },
        { id: 'test', kind: 'test', path: 'tests/unit/mutual-review.test.ts' },
      ],
    },
    predecessors: [],
    openChoices: [],
    signals: {},
  }
}

describe('enhanced preflight rules', () => {
  it('pairs explicit source files with corresponding tests', () => {
    expect(sourceTestPairingRule(input()).passed).toBe(true)
    const missing = input()
    ;(missing.designBindings.deliverables as unknown[]).pop()
    expect(sourceTestPairingRule(missing).errors).toEqual([
      'PREFLIGHT_SOURCE_TEST_PAIR_MISSING:src/review/mutual-review.ts',
    ])
  })

  it('requires security, compatibility, and rollback observations for R3', () => {
    expect(r3MandatoryDimensionsRule(input(), 'R3').passed).toBe(true)
    const missing = input()
    missing.acceptance[0]!.id = 'COMPATIBILITY'
    missing.acceptance[0]!.observation = 'Only compatibility is observed.'
    expect(r3MandatoryDimensionsRule(missing, 'R3').errors).toEqual([
      'PREFLIGHT_R3_DIMENSION_MISSING:security',
      'PREFLIGHT_R3_DIMENSION_MISSING:rollback',
    ])
    expect(r3MandatoryDimensionsRule(missing, 'R2').passed).toBe(true)
  })

  it('records bounded scope coverage warnings without failing', () => {
    const result = scopeAcceptanceCoverageRule(input())
    expect(result.passed).toBe(true)
    expect(result.warnings).toContain('PREFLIGHT_SCOPE_ACCEPTANCE_KEYWORD_MISSING:summary')
  })
})
