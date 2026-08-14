import { applyPlannedWrites, assertPlannedGuardsUnchanged, } from '../project/mutate.js';
export function applyAdoption(plan, reviewedDigest) {
    if (plan.digest !== reviewedDigest)
        throw new Error('ADOPTION_PLAN_DIGEST_MISMATCH');
    assertPlannedGuardsUnchanged(plan.generatedTargets);
    return applyPlannedWrites(plan.writes, { dryRun: false });
}
