import { deriveAccountabilityStatus, type AccountabilityStatus } from './derive.js'
import { inspectCleanTask, type CleanTaskChecks } from './clean-task.js'
import { hasPermanentGates } from './permanent-gates.js'
import type { Standing } from './policy.js'

export interface RecoveryStep {
  from: Standing
  to: Standing
  requirements: string[]
  cleanTasksRequired: number
}

export interface RecoveryPlan {
  actorId: string
  currentStanding: Standing
  currentScore: number
  lifetimeScore: number
  unresolvedDefectClasses: string[]
  permanentGatesSatisfied: boolean
  steps: RecoveryStep[]
  estimatedTasks: number
}

const steps: Record<Exclude<Standing, 'GOOD_STANDING'>, RecoveryStep> = {
  WARNING: {
    from: 'WARNING', to: 'GOOD_STANDING', cleanTasksRequired: 1,
    requirements: ['Complete 1 clean R1/R2/R3 task'],
  },
  WATCH: {
    from: 'WATCH', to: 'WARNING', cleanTasksRequired: 1,
    requirements: ['Complete 1 clean R2/R3 task with a GOOD_STANDING supervisor'],
  },
  PROBATION: {
    from: 'PROBATION', to: 'WATCH', cleanTasksRequired: 1,
    requirements: ['Complete an authorized remediation', 'Install a permanent gate for every unresolved defect class', 'Complete 1 clean R2/R3 task with a GOOD_STANDING supervisor'],
  },
  SUSPENDED: {
    from: 'SUSPENDED', to: 'PROBATION', cleanTasksRequired: 2,
    requirements: ['Complete an authorized remediation', 'Install a permanent gate for every unresolved defect class', 'Complete 2 clean R2/R3 tasks with a GOOD_STANDING supervisor', 'Obtain user authorization for reinstatement'],
  },
}

const order: Standing[] = ['GOOD_STANDING', 'WARNING', 'WATCH', 'PROBATION', 'SUSPENDED']

export function recoveryStepForStanding(standing: Standing): RecoveryStep | null {
  return standing === 'GOOD_STANDING' ? null : steps[standing]
}

export function generateRecoveryPlan(projectRoot: string, actorId: string): RecoveryPlan {
  const status = deriveAccountabilityStatus(projectRoot, actorId)
  const path: RecoveryStep[] = []
  let standing = status.standing
  while (standing !== 'GOOD_STANDING') {
    const step = steps[standing]
    path.push(step)
    standing = step.to
  }
  return {
    actorId: status.actorId,
    currentStanding: status.standing,
    currentScore: status.activePenaltyScore,
    lifetimeScore: status.lifetimePenaltyScore,
    unresolvedDefectClasses: status.unresolvedDefectClasses,
    permanentGatesSatisfied: hasPermanentGates(projectRoot, status.actorId, status.unresolvedDefectClasses),
    steps: path,
    estimatedTasks: path.reduce((total, step) => total + step.cleanTasksRequired, 0) + (status.standing === 'PROBATION' ? 1 : 0),
  }
}

export interface RecoveryValidation {
  valid: boolean
  status: AccountabilityStatus
  cleanTask: CleanTaskChecks
  oldScore: number
  newScore: number
  oldStanding: Standing
  newStanding: Standing
  errors: string[]
}

export function validateRecoveryStep(
  projectRoot: string,
  actorId: string,
  taskId: string,
  options: { userAuthorized?: boolean } = {},
): RecoveryValidation {
  const status = deriveAccountabilityStatus(projectRoot, actorId)
  const cleanTask = inspectCleanTask(projectRoot, taskId)
  const errors = [...cleanTask.errors]
  if (!cleanTask.isClean || cleanTask.credit >= 0) errors.push('ACCOUNTABILITY_RECOVERY_TASK_NOT_CLEAN')
  if ((status.standing === 'PROBATION' || status.standing === 'SUSPENDED')
    && !hasPermanentGates(projectRoot, status.actorId, status.unresolvedDefectClasses)) {
    errors.push('ACCOUNTABILITY_RECOVERY_PERMANENT_GATES_REQUIRED')
  }
  if ((status.standing === 'WATCH' || status.standing === 'PROBATION' || status.standing === 'SUSPENDED')
    && cleanTask.risk !== 'R2' && cleanTask.risk !== 'R3') {
    errors.push('ACCOUNTABILITY_RECOVERY_R2_OR_R3_REQUIRED')
  }
  const requiredCleanTasks = recoveryStepForStanding(status.standing)?.cleanTasksRequired ?? 0
  if (status.calibration.consecutiveCleanCount + 1 < requiredCleanTasks) {
    errors.push('ACCOUNTABILITY_RECOVERY_MORE_CLEAN_TASKS_REQUIRED')
  }
  if (status.standing === 'SUSPENDED' && options.userAuthorized !== true) {
    errors.push('ACCOUNTABILITY_RECOVERY_USER_AUTHORIZATION_REQUIRED')
  }
  const newScore = Math.max(0, status.activePenaltyScore + cleanTask.credit)
  const newStanding = order.find((candidate) => {
    if (candidate === 'GOOD_STANDING') return newScore < 3
    if (candidate === 'WARNING') return newScore >= 3 && newScore < 5
    if (candidate === 'WATCH') return newScore >= 5 && newScore < 8
    if (candidate === 'PROBATION') return newScore >= 8 && newScore < 12
    return newScore >= 12
  }) ?? 'SUSPENDED'
  return {
    valid: errors.length === 0 && order.indexOf(newStanding) < order.indexOf(status.standing),
    status,
    cleanTask,
    oldScore: status.activePenaltyScore,
    newScore,
    oldStanding: status.standing,
    newStanding,
    errors: [...new Set(errors)].sort(),
  }
}
