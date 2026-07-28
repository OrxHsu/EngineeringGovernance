import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { planCodexInstall } from '../adapters/codex.js'
import { planSkillInstall } from '../adapters/skill.js'
import { applyPlannedWrites, type MutationResult, type PlannedWrite } from '../project/mutate.js'
import { governanceIdentity } from './adopt.js'

export interface GlobalInstallPlan {
  tool: 'codex'
  homeDirectory: string
  governanceVersion: string
  governanceDigest: string
  writes: PlannedWrite[]
  digest: string
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function planDigest(plan: Omit<GlobalInstallPlan, 'digest'>): string {
  return sha256(JSON.stringify({
    tool: plan.tool,
    homeDirectory: plan.homeDirectory,
    governanceVersion: plan.governanceVersion,
    governanceDigest: plan.governanceDigest,
    writes: plan.writes.map((write) => ({
      path: write.path,
      beforeDigest: write.beforeDigest,
      afterDigest: sha256(write.after),
    })),
  }))
}

export function planGlobalInstall(options: {
  tool: string
  homeDirectory?: string
}): GlobalInstallPlan {
  if (options.tool !== 'codex') throw new Error(`GLOBAL_TOOL_UNSUPPORTED:${options.tool}`)
  const homeDirectory = resolve(options.homeDirectory ?? homedir())
  const identity = governanceIdentity()
  const codex = planCodexInstall({ homeDirectory, identity })
  const skill = planSkillInstall({
    targetDirectory: join(homeDirectory, '.codex', 'skills', 'delivery-sop'),
  })
  const unsigned = {
    tool: 'codex' as const,
    homeDirectory,
    governanceVersion: identity.version,
    governanceDigest: identity.digest,
    writes: [...codex.writes, ...skill.writes],
  }
  return { ...unsigned, digest: planDigest(unsigned) }
}

export function summarizeGlobalPlan(plan: GlobalInstallPlan): object {
  return {
    tool: plan.tool,
    homeDirectory: plan.homeDirectory,
    governanceVersion: plan.governanceVersion,
    governanceDigest: plan.governanceDigest,
    digest: plan.digest,
    writes: plan.writes.map((write) => ({
      path: write.path,
      beforeDigest: write.beforeDigest,
      afterDigest: sha256(write.after),
    })),
  }
}

export function applyGlobalInstall(
  plan: GlobalInstallPlan,
  reviewedDigest: string,
): MutationResult {
  if (plan.digest !== reviewedDigest) throw new Error('GLOBAL_PLAN_DIGEST_MISMATCH')
  return applyPlannedWrites(plan.writes, { dryRun: false })
}
