import { applyTaskTransition, type TaskTransitionPlan } from '../state/ledger.js'

export interface CliTransitionDecision {
  valid: boolean
  errors: string[]
  transitionPlan?: TaskTransitionPlan
}

export function applyCliTransition<T extends CliTransitionDecision>(
  decision: T,
  approvedDigest?: string,
): T | (T & { applied: boolean }) {
  if (approvedDigest === undefined) return decision
  if (!decision.valid || decision.transitionPlan === undefined) {
    return {
      ...decision,
      valid: false,
      errors: decision.errors.length > 0 ? decision.errors : ['TASK_TRANSITION_PLAN_REQUIRED'],
      applied: false,
    }
  }
  const application = applyTaskTransition(decision.transitionPlan, approvedDigest)
  return {
    ...decision,
    valid: application.applied,
    errors: application.errors,
    applied: application.applied,
  }
}
