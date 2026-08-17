import { readFileSync } from 'node:fs'

import { parse } from 'yaml'

import { preflightTaskInput, verifyPreflightPlan, type ContractPreflightDocument, type PreflightResult } from '../accountability/preflight.js'

export interface TaskPreflightOptions {
  projectRoot: string
  inputPath: string
  expectedPlan?: ContractPreflightDocument
}

export function runTaskPreflight(options: TaskPreflightOptions): PreflightResult {
  const result = preflightTaskInput(options.projectRoot, options.inputPath)
  if (!result.valid || options.expectedPlan === undefined) return result
  return verifyPreflightPlan(options.expectedPlan, options.projectRoot, options.inputPath)
}

export function readPreflightDocument(path: string): ContractPreflightDocument {
  return parse(readFileSync(path, 'utf8')) as ContractPreflightDocument
}
