import { describe, expect, it } from 'vitest'

import {
  externalSourceMinimumRisk,
  validateExternalSourceTaskInput,
} from '../../src/extensions/external-source.js'

describe('external-source contract boundary', () => {
  it('keeps independent mode default-deny and below R3', () => {
    const input = validateExternalSourceTaskInput({ mode: 'independent' })
    expect(input).toEqual({ mode: 'independent' })
    expect(externalSourceMinimumRisk(input)).toBeUndefined()
  })

  it('rejects extra fields and incomplete source-assisted allocations', () => {
    expect(() => validateExternalSourceTaskInput({ mode: 'independent', source: 'forged' }))
      .toThrow('EXTERNAL_SOURCE_INDEPENDENT_INPUT_NOT_EMPTY')
    expect(() => validateExternalSourceTaskInput({ mode: 'source-assisted' }))
      .toThrow('EXTERNAL_SOURCE_INPUT_INVALID')
  })
})
