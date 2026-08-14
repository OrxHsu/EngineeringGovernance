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
  | 'candidate'
  | 'evidence'
  | 'review'
  | 'closure'
  | 'exception'
  | 'authorization'
  | 'task-event'
  | 'execution-receipt'
  | 'verification'

export interface ValidationResult {
  valid: boolean
  errors: string[]
}
