import { describe, expect, it } from 'vitest'

import { classifyRisk } from '../../src/policy/risk.js'

describe('risk classification', () => {
  it('selects the highest matching signal', () => {
    expect(classifyRisk({ localEdit: true, persistentData: true })).toBe('R2')
    expect(classifyRisk({ localEdit: true, production: true })).toBe('R3')
  })

  it('raises an incompletely classified mutation to R2', () => {
    expect(classifyRisk({ mutation: true, classificationComplete: false })).toBe('R2')
  })

  it('classifies read-only and bounded local work', () => {
    expect(classifyRisk({ readOnly: true })).toBe('R0')
    expect(classifyRisk({ localEdit: true, classificationComplete: true })).toBe('R1')
  })

  it.each([
    'authentication', 'authorization', 'privacy', 'security', 'migration',
    'destructive', 'payments', 'production', 'deployment', 'remoteMutation',
    'externalCommunication', 'restrictedRuntime',
  ] as const)('classifies %s as R3', (signal) => {
    expect(classifyRisk({ [signal]: true })).toBe('R3')
  })

  it('honors a stricter project minimum', () => {
    expect(classifyRisk({ localEdit: true, projectMinimum: 'R2' })).toBe('R2')
  })
})
