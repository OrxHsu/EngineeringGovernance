import { describe, expect, it } from 'vitest'

import { validateException } from '../../src/policy/exceptions.js'

const base = {
  ruleId: 'DEFAULT-01',
  ruleClass: 'waiverable' as const,
  scope: ['project:sample'],
  approvedBy: 'user',
  issuedAt: '2026-07-28T00:00:00Z',
  expiresAt: '2026-07-30T00:00:00Z',
  status: 'active' as const,
  compensatingControls: ['independent review'],
}

describe('exception semantics', () => {
  it('accepts a scoped active waiver', () => {
    expect(validateException(base, new Date('2026-07-29T00:00:00Z'))).toEqual({
      valid: true,
      errors: [],
    })
  })

  it.each(['non_waivable', 'user_authorization_required'] as const)(
    'rejects the %s rule class',
    (ruleClass) => {
      const result = validateException({ ...base, ruleClass }, new Date('2026-07-29T00:00:00Z'))
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('EXCEPTION_RULE_CLASS_FORBIDDEN')
    },
  )

  it('rejects expired and revoked waivers', () => {
    expect(validateException(
      { ...base, expiresAt: '2026-07-28T12:00:00Z' },
      new Date('2026-07-29T00:00:00Z'),
    ).errors).toContain('EXCEPTION_EXPIRED')

    expect(validateException(
      { ...base, status: 'revoked' },
      new Date('2026-07-29T00:00:00Z'),
    ).errors).toContain('EXCEPTION_INACTIVE')
  })

  it('rejects missing approval, scope, and compensating controls', () => {
    const result = validateException({
      ...base,
      approvedBy: '',
      scope: [],
      compensatingControls: [],
    }, new Date('2026-07-29T00:00:00Z'))

    expect(result.errors).toEqual([
      'EXCEPTION_APPROVAL_MISSING',
      'EXCEPTION_COMPENSATING_CONTROLS_MISSING',
      'EXCEPTION_SCOPE_MISSING',
    ])
  })
})
