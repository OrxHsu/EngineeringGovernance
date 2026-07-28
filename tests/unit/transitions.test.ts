import { describe, expect, it } from 'vitest'

import {
  canTransition,
  validateAcceptanceAuthority,
} from '../../src/state/transitions.js'

describe('workflow transitions', () => {
  it('allows the primary and repair paths', () => {
    expect(canTransition('DEFINED', 'IN_PROGRESS')).toBe(true)
    expect(canTransition('IN_PROGRESS', 'CANDIDATE')).toBe(true)
    expect(canTransition('CANDIDATE', 'REPAIR_REQUIRED')).toBe(true)
    expect(canTransition('REPAIR_REQUIRED', 'IN_PROGRESS')).toBe(true)
    expect(canTransition('CANDIDATE', 'ACCEPTED')).toBe(true)
    expect(canTransition('ACCEPTED', 'CLOSED')).toBe(true)
  })

  it('allows a resolved external blocker to resume', () => {
    expect(canTransition('IN_PROGRESS', 'BLOCKED')).toBe(true)
    expect(canTransition('BLOCKED', 'IN_PROGRESS')).toBe(true)
  })

  it('rejects reopening accepted or terminal history', () => {
    expect(canTransition('ACCEPTED', 'IN_PROGRESS')).toBe(false)
    expect(canTransition('CLOSED', 'REPAIR_REQUIRED')).toBe(false)
    expect(canTransition('CANCELLED', 'IN_PROGRESS')).toBe(false)
    expect(canTransition('SUPERSEDED', 'IN_PROGRESS')).toBe(false)
  })
})

describe('acceptance authority', () => {
  it('allows R1 owner verification', () => {
    expect(validateAcceptanceAuthority('R1', 'codex')).toEqual({ valid: true, errors: [] })
  })

  it.each(['R2', 'R3'] as const)('requires an independent reviewer for %s', (risk) => {
    expect(validateAcceptanceAuthority(risk, 'qoder')).toEqual({
      valid: false,
      errors: ['INDEPENDENT_REVIEW_REQUIRED'],
    })
    expect(validateAcceptanceAuthority(risk, 'qoder', 'qoder')).toEqual({
      valid: false,
      errors: ['INDEPENDENT_REVIEW_REQUIRED'],
    })
    expect(validateAcceptanceAuthority(risk, 'qoder', 'codex')).toEqual({
      valid: true,
      errors: [],
    })
  })
})
