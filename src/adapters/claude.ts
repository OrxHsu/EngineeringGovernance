import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { generatedVerification, planGeneratedFile, type ProjectAdapterDecision } from './generic.js'

const importContent = readFileSync(new URL('../../adapters/claude/import.md', import.meta.url), 'utf8')

export function planClaudeAdapter(options: { projectRoot: string }): ProjectAdapterDecision {
  const projectRoot = resolve(options.projectRoot)
  const owningSource = join(projectRoot, 'AGENTS.md')
  if (!existsSync(owningSource)) throw new Error('CLAUDE_AGENTS_AUTHORITY_MISSING')
  const target = join(projectRoot, 'CLAUDE.md')
  return {
    tool: 'claude',
    owningSource,
    generatedTargets: [target],
    plannedWrites: planGeneratedFile(target, importContent),
    verification: generatedVerification(target, importContent),
    removal: { strategy: 'generated-file', targets: [target] },
  }
}
