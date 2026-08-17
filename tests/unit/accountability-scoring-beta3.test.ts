import { describe, expect, it } from 'vitest'

import { calculatePenalty, deriveStanding } from '../../src/accountability/scoring.js'

describe('beta3 accountability scoring', () => {
  it('normalizes defect classes and escalates each repeat independently', () => {
    const first = calculatePenalty({ severity: 'BLOCKER', defectClass: 'Missing_Test File' }, { findings: [] })
    const second = calculatePenalty(
      { severity: 'BLOCKER', defectClass: 'missing-test-file' },
      { findings: [{ defectClass: 'Missing Test_File' }] },
    )
    const third = calculatePenalty(
      { severity: 'BLOCKER', defectClass: 'missing-test-file' },
      { findings: [{ defectClass: 'missing-test-file' }, { defectClass: 'missing_test_file' }] },
    )

    expect(first).toMatchObject({ totalDelta: 3, isFirstOffense: true, repeatCount: 0, defectClass: 'missing-test-file' })
    expect(second).toMatchObject({ totalDelta: 9, repeatPenalty: 6, repeatCount: 1 })
    expect(third).toMatchObject({ totalDelta: 11, repeatPenalty: 8, repeatCount: 2 })
  })

  it('derives all five standings at exact boundaries', () => {
    expect([0, 3, 5, 8, 12].map((score) => deriveStanding(score))).toEqual([
      'GOOD_STANDING', 'WARNING', 'WATCH', 'PROBATION', 'SUSPENDED',
    ])
  })
})
