import { describe, expect, it } from 'vitest'

import { deriveMetrics } from '../../src/metrics/derive.js'
import { closeTaskWithMetrics } from '../../src/commands/task-close.js'

describe('workflow health metrics', () => {
  it('derives process metrics without ranking owners', () => {
    const result = deriveMetrics([
      {
        taskId: 'a',
        risk: 'R1',
        candidateCount: 1,
        repairCycles: 0,
        escapedBlockingDefects: 0,
        definedAt: '2026-07-29T00:00:00Z',
        acceptedAt: '2026-07-29T00:10:00Z',
        gateFlakes: 0,
        gateFalsePositives: 0,
        expiredExceptions: 0,
        findings: [],
      },
      {
        taskId: 'b',
        risk: 'R2',
        candidateCount: 2,
        repairCycles: 1,
        escapedBlockingDefects: 1,
        definedAt: '2026-07-29T00:00:00Z',
        acceptedAt: '2026-07-29T00:30:00Z',
        gateFlakes: 2,
        gateFalsePositives: 1,
        expiredExceptions: 1,
        findings: [
          { defectClass: 'evidence-binding', permanentGateId: 'GATE-EV-01' },
          { defectClass: 'evidence-binding' },
        ],
      },
    ])

    expect(result.firstCandidateAcceptanceRate).toBe(0.5)
    expect(result.repairCyclesPerAcceptedTask).toBe(0.5)
    expect(result.escapedBlockingDefects).toBe(1)
    expect(result.gateFlakes).toBe(2)
    expect(result.gateFalsePositives).toBe(1)
    expect(result.expiredExceptions).toBe(1)
    expect(result.medianAcceptanceMillisecondsByRisk).toEqual({ R1: 600_000, R2: 1_800_000 })
    expect(result.repeatedDefectClassesConvertedRate).toBe(1)
    expect(result).not.toHaveProperty('ownerRanking')
  })

  it('returns zero rates for an empty history', () => {
    expect(deriveMetrics([])).toMatchObject({
      firstCandidateAcceptanceRate: 0,
      repairCyclesPerAcceptedTask: 0,
      repeatedDefectClassesConvertedRate: 0,
    })
  })

  it('emits metrics only for a closable task', () => {
    const result = closeTaskWithMetrics({
      eligibility: {
        state: 'ACCEPTED',
        projectStatusValid: true,
        pendingRequiredIds: [],
      },
      history: [],
    })
    expect(result.eligibility.valid).toBe(true)
    expect(result.metrics.firstCandidateAcceptanceRate).toBe(0)
  })
})
