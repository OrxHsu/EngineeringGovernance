export type Risk = 'R0' | 'R1' | 'R2' | 'R3'

export type TaskState =
  | 'DEFINED'
  | 'IN_PROGRESS'
  | 'CANDIDATE'
  | 'ACCEPTED'
  | 'CLOSED'
  | 'REPAIR_REQUIRED'
  | 'BLOCKED'
  | 'CANCELLED'
  | 'SUPERSEDED'

export type DocumentKind =
  | 'project-policy'
  | 'task-contract'
  | 'evidence'
  | 'review'
  | 'exception'

export interface ValidationResult {
  valid: boolean
  errors: string[]
}
