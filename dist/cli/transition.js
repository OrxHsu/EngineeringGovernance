import { applyTaskTransition } from '../state/ledger.js';
export function applyCliTransition(decision, approvedDigest) {
    if (approvedDigest === undefined)
        return decision;
    if (!decision.valid || decision.transitionPlan === undefined) {
        return {
            ...decision,
            valid: false,
            errors: decision.errors.length > 0 ? decision.errors : ['TASK_TRANSITION_PLAN_REQUIRED'],
            applied: false,
        };
    }
    const application = applyTaskTransition(decision.transitionPlan, approvedDigest);
    return {
        ...decision,
        valid: application.applied,
        errors: application.errors,
        applied: application.applied,
    };
}
