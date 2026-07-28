import type { Risk, ValidationResult } from '../model/types.js'

export interface CandidateEligibilityInput {
  risk: Risk
  requiredGateErrors: string[]
  authorizationRequired: boolean
  authorizationApproved: boolean
}

export function verifyCandidateEligibility(input: CandidateEligibilityInput): ValidationResult {
  const errors = [...input.requiredGateErrors]
  if (input.authorizationRequired && !input.authorizationApproved) {
    errors.push('USER_AUTHORIZATION_REQUIRED')
  }
  const uniqueErrors = [...new Set(errors)].sort()
  return { valid: uniqueErrors.length === 0, errors: uniqueErrors }
}
