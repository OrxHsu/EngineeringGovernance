import type { Risk, TaskState, ValidationResult } from '../model/types.js'

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

  if (
    reviewOwner === undefined
    || reviewOwner.trim().length === 0
    || reviewOwner === implementationOwner
  ) {
    return { valid: false, errors: ['INDEPENDENT_REVIEW_REQUIRED'] }
  }

  return { valid: true, errors: [] }
}
