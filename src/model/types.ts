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
  | 'replay-verification'
  | 'extensions-manifest'
  | 'external-source-use'
  | 'external-source-release'
  | 'contract-review'
  | 'prior-review-finding'
  | 'release-record'
  | 'task-start-input'
  | 'contract-preflight'
  | 'actor-registry-event'
  | 'accountability-event'
  | 'accountability-status'
  | 'accountability-bootstrap'
  | 'initial-actor-bootstrap'
  | 'permanent-gates'
  | 'self-review'
  | 'known-issues'
  | 'accountability-incident'

export interface ValidationResult {
  valid: boolean
  errors: string[]
}
