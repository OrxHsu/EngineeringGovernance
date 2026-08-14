import { describe, expect, it } from 'vitest'

import { verifyLegacyCandidateEligibility as verifyCandidateEligibility } from '../../src/commands/task-verify.js'

const approvedAuthorization = {
  schemaVersion: 1 as const,
  authorizationId: 'AUTH-TEST-1',
  approvedBy: 'user' as const,
  issuedAt: '2026-07-29T00:00:00Z',
  expiresAt: '2026-07-29T01:00:00Z',
  scope: ['temporary-project:r3-pilot'],
  status: 'approved' as const,
}

function decision(overrides: Record<string, unknown> = {}) {
  return verifyCandidateEligibility({
    risk: 'R1',
    authorizationRequired: true,
    authorizationApproved: true,
    authorization: approvedAuthorization,
    requestedAuthorizationScope: ['temporary-project:r3-pilot'],
    ...overrides,
  }, { authorizationCheckTime: new Date('2026-07-29T00:30:00Z') })
}

describe('scoped user authorization', () => {
  it('accepts an exact active authorization record', () => {
    expect(decision()).toEqual({ valid: true, errors: [] })
  })

  it('rejects boolean-only, expired, and scope-drifted approvals', () => {
    expect(decision({ authorization: undefined }).errors).toContain(
      'AUTHORIZATION_RECORD_REQUIRED',
    )
    expect(verifyCandidateEligibility({
      risk: 'R1',
      authorizationRequired: true,
      authorizationApproved: true,
      authorization: approvedAuthorization,
      requestedAuthorizationScope: ['temporary-project:r3-pilot'],
    }, { authorizationCheckTime: new Date('2026-07-29T01:00:00Z') }).errors).toContain(
      'AUTHORIZATION_EXPIRED',
    )
    expect(decision({
      requestedAuthorizationScope: ['temporary-project:other'],
    }).errors).toContain('AUTHORIZATION_SCOPE_MISMATCH')
  })

  it('rejects a caller-controlled authorization clock', () => {
    expect(decision({ authorizationCheckTime: '2026-07-29T00:30:00Z' }).errors).toContain(
      'AUTHORIZATION_CHECK_TIME_CALLER_CONTROLLED',
    )
  })
})
