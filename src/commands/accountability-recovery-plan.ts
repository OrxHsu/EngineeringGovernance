import { generateRecoveryPlan, type RecoveryPlan } from '../accountability/recovery.js'

export function accountabilityRecoveryPlan(projectRoot: string, actorId: string): RecoveryPlan {
  return generateRecoveryPlan(projectRoot, actorId)
}
