import { generateRecoveryPlan } from '../accountability/recovery.js';
export function accountabilityRecoveryPlan(projectRoot, actorId) {
    return generateRecoveryPlan(projectRoot, actorId);
}
