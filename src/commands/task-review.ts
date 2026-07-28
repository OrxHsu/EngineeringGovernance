import type { Risk, ValidationResult } from '../model/types.js'
import { validateAcceptanceAuthority } from '../state/transitions.js'

export interface ReviewEligibilityInput {
  risk: Risk
  implementationOwner: string
  reviewOwner?: string
  blockingFindingIds: string[]
}

export function verifyReviewEligibility(input: ReviewEligibilityInput): ValidationResult {
  const authority = validateAcceptanceAuthority(
    input.risk,
    input.implementationOwner,
    input.reviewOwner,
  )
  const errors = [
    ...authority.errors,
    ...input.blockingFindingIds.map((id) => `BLOCKING_FINDING:${id}`),
  ]
  const uniqueErrors = [...new Set(errors)].sort()
  return { valid: uniqueErrors.length === 0, errors: uniqueErrors }
}
