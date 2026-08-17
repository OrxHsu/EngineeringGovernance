import { describe, expect, it } from 'vitest'

import {
  responsibleActorForFinding,
  scoreForFinding,
  standingForScore,
} from '../../src/accountability/policy.js'

describe('beta3 graduated accountability policy', () => {
  it('scores repeated culpable defect classes and suspends security bypasses', () => {
    const first = scoreForFinding('BLOCKER', 'contract-authority-resolution', new Set(), 'contract_violation', 'culpable')
    const repeated = scoreForFinding('BLOCKER', 'contract-authority-resolution', new Set(['contract-authority-resolution']), 'contract_violation', 'culpable')
    const bypass = scoreForFinding('LOW', 'authorization-bypass', new Set(), 'newly_discovered_defect', 'culpable')
    const third = scoreForFinding('BLOCKER', 'contract-authority-resolution', new Map([['contract-authority-resolution', 2]]), 'contract_violation', 'culpable')
    expect(first).toMatchObject({ delta: 3, isFirstOffense: true, repeatCount: 0 })
    expect(repeated).toMatchObject({ delta: 9, isFirstOffense: false, repeatCount: 1 })
    expect(third).toMatchObject({ delta: 11, repeatCount: 2 })
    expect(bypass.immediateSuspension).toBe(true)
    expect(standingForScore(3)).toBe('WARNING')
    expect(standingForScore(12)).toBe('SUSPENDED')
  })

  it('attributes only the frozen culpable roles and gives new requirements zero', () => {
    expect(responsibleActorForFinding({ classification: 'contract_violation', responsibleRole: 'contract_author', contractAuthor: 'codex', implementationOwner: 'owner', culpability: 'culpable' })).toBe('codex')
    expect(responsibleActorForFinding({ classification: 'newly_discovered_defect', responsibleRole: 'implementation_owner', contractAuthor: 'author', implementationOwner: 'owner', culpability: 'culpable' })).toBe('owner')
    expect(responsibleActorForFinding({ classification: 'new_requirement', responsibleRole: 'none', contractAuthor: 'author', implementationOwner: 'owner', culpability: 'non_culpable_new_requirement' })).toBeNull()
  })
})
