import type { Risk, TaskState, ValidationResult } from '../model/types.js'
import { normalizeActorId } from '../model/actor.js'

const transitions: Record<TaskState, readonly TaskState[]> = {
  DEFINED: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'],
  IN_PROGRESS: ['CANDIDATE', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'],
  CANDIDATE: ['ACCEPTED', 'REPAIR_REQUIRED', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'],
  REPAIR_REQUIRED: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'],
  BLOCKED: ['IN_PROGRESS', 'CANCELLED', 'SUPERSEDED'],
  ACCEPTED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
  SUPERSEDED: [],
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return transitions[from].includes(to)
}

export function validateAcceptanceAuthority(
  risk: Risk,
  implementationOwner: string,
  reviewOwner?: string,
): ValidationResult {
  if (risk === 'R0' || risk === 'R1') return { valid: true, errors: [] }

  let normalizedOwner: string
  let normalizedReviewer: string | undefined
  try {
    normalizedOwner = normalizeActorId(implementationOwner)
    normalizedReviewer = reviewOwner === undefined ? undefined : normalizeActorId(reviewOwner)
  } catch {
    return { valid: false, errors: ['INDEPENDENT_REVIEW_REQUIRED'] }
  }
  if (normalizedReviewer === undefined || normalizedReviewer === normalizedOwner) {
    return { valid: false, errors: ['INDEPENDENT_REVIEW_REQUIRED'] }
  }

  return { valid: true, errors: [] }
}
