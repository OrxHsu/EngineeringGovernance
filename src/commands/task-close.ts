import type { TaskState, ValidationResult } from '../model/types.js'

export interface CloseEligibilityInput {
  state: TaskState
  projectStatusValid: boolean
  pendingRequiredIds: string[]
}

export function verifyCloseEligibility(input: CloseEligibilityInput): ValidationResult {
  const errors: string[] = []
  if (!input.projectStatusValid) errors.push('PROJECT_STATUS_INCOHERENT')
  errors.push(...input.pendingRequiredIds.map((id) => `REQUIRED_ITEM_PENDING:${id}`))
  if (input.state !== 'ACCEPTED') errors.push('TASK_NOT_ACCEPTED')
  const uniqueErrors = [...new Set(errors)].sort()
  return { valid: uniqueErrors.length === 0, errors: uniqueErrors }
}
