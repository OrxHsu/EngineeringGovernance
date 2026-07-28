import type { AdoptionPlan } from './adopt.js'
import { applyPlannedWrites, type MutationResult } from '../project/mutate.js'

export function applyAdoption(plan: AdoptionPlan, reviewedDigest: string): MutationResult {
  if (plan.digest !== reviewedDigest) throw new Error('ADOPTION_PLAN_DIGEST_MISMATCH')
  return applyPlannedWrites(plan.writes, { dryRun: false })
}
