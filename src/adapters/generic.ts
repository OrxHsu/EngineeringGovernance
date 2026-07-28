import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { ValidationResult } from '../model/types.js'
import type { PlannedWrite } from '../project/mutate.js'
import { renderCoreBlock, type CoreBlockIdentity } from './render.js'

export interface AdapterRemoval {
  strategy: 'generated-file' | 'managed-block' | 'none'
  targets: string[]
}

export interface ProjectAdapterDecision {
  tool: 'claude' | 'cursor' | 'generic' | 'qoder'
  owningSource: string
  generatedTargets: string[]
  plannedWrites: PlannedWrite[]
  verification: ValidationResult
  removal: AdapterRemoval
}

export function textDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function planGeneratedFile(path: string, after: string): PlannedWrite[] {
  if (!existsSync(path)) return [{ path, beforeDigest: null, after }]
  const before = readFileSync(path, 'utf8')
  if (before === after) return []
  throw new Error(`GENERATED_TARGET_CONFLICT:${path}`)
}

export function generatedVerification(path: string, expected: string): ValidationResult {
  const valid = existsSync(path) && readFileSync(path, 'utf8') === expected
  return { valid, errors: valid ? [] : [`GENERATED_TARGET_MISSING_OR_DRIFTED:${path}`] }
}

export function planGenericAdapter(options: {
  projectRoot: string
  identity: CoreBlockIdentity
}): ProjectAdapterDecision {
  const projectRoot = resolve(options.projectRoot)
  const owningSource = join(projectRoot, 'AGENTS.md')
  if (existsSync(owningSource)) {
    return {
      tool: 'generic',
      owningSource,
      generatedTargets: [],
      plannedWrites: [],
      verification: { valid: true, errors: [] },
      removal: { strategy: 'none', targets: [] },
    }
  }

  const content = renderCoreBlock(options.identity)
  return {
    tool: 'generic',
    owningSource,
    generatedTargets: [owningSource],
    plannedWrites: planGeneratedFile(owningSource, content),
    verification: generatedVerification(owningSource, content),
    removal: { strategy: 'generated-file', targets: [owningSource] },
  }
}
