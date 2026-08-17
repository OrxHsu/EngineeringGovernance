import { describe, expect, it } from 'vitest'

import { permissionsForStanding, standingForScore } from '../../src/accountability/policy.js'

describe('beta1 reinstatement boundaries', () => {
  it('does not let reward labels bypass standing thresholds', () => {
    expect(standingForScore(8)).toBe('PROBATION')
    expect(standingForScore(5)).toBe('WATCH')
    expect(permissionsForStanding('SUSPENDED')).toEqual(['r0'])
    expect(permissionsForStanding('GOOD_STANDING')).toContain('implementation-reviewer')
  })
})
