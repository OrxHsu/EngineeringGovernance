import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { planManagedBlockWrite } from '../project/managed-block.js'
import { renderCoreBlock, type CoreBlockIdentity } from './render.js'
import type { ProjectAdapterDecision } from './generic.js'

export function planQoderAdapter(options: {
  projectRoot: string
  identity: CoreBlockIdentity
}): ProjectAdapterDecision {
  const projectRoot = resolve(options.projectRoot)
  const owningSource = join(projectRoot, 'AGENTS.md')
  if (!existsSync(owningSource)) throw new Error('QODER_AGENTS_AUTHORITY_MISSING')
  const block = renderCoreBlock(options.identity).trimEnd()
  const current = readFileSync(owningSource, 'utf8')
  const write = planManagedBlockWrite(owningSource, block)
  const plannedWrites = write.after === current ? [] : [write]
  const valid = current.includes(block)
  return {
    tool: 'qoder',
    owningSource,
    generatedTargets: [],
    plannedWrites,
    verification: { valid, errors: valid ? [] : ['QODER_GOVERNANCE_BLOCK_MISSING_OR_DRIFTED'] },
    removal: { strategy: 'managed-block', targets: [owningSource] },
  }
}
