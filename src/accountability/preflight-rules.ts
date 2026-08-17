import { basename } from 'node:path'

import type { Beta1TaskInput } from './preflight.js'

export interface EnhancedPreflightRuleResult {
  id: 'source_test_pairing' | 'r3_mandatory_dimensions' | 'scope_acceptance_coverage'
  passed: boolean
  errors: string[]
  warnings: string[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deliverablePaths(input: Beta1TaskInput, kind: 'source' | 'test'): string[] {
  if (!record(input.designBindings) || !Array.isArray(input.designBindings.deliverables)) return []
  return input.designBindings.deliverables
    .filter(record)
    .filter((item) => item.kind === kind && typeof item.path === 'string')
    .map((item) => String(item.path))
}

function explicitFile(path: string): boolean {
  return !path.includes('*') && /\.[a-z0-9]+$/iu.test(path)
}

function moduleName(path: string): string {
  return basename(path)
    .replace(/\.(?:test|spec)\.[^.]+$/u, '')
    .replace(/\.[^.]+$/u, '')
}

export function sourceTestPairingRule(input: Beta1TaskInput): EnhancedPreflightRuleResult {
  const sources = [...new Set([
    ...deliverablePaths(input, 'source'),
    ...input.authorityInputs.filter((path) => path.startsWith('src/')),
  ].filter(explicitFile))]
  const tests = [...new Set([
    ...deliverablePaths(input, 'test'),
    ...input.authorityInputs.filter((path) => path.startsWith('tests/')),
  ].filter(explicitFile))]
  const errors = sources
    .filter((source) => !tests.some((test) => moduleName(test) === moduleName(source)))
    .map((source) => `PREFLIGHT_SOURCE_TEST_PAIR_MISSING:${source}`)
  return { id: 'source_test_pairing', passed: errors.length === 0, errors, warnings: [] }
}

function acceptanceText(input: Beta1TaskInput): string {
  return input.acceptance.map((item) => record(item)
    ? [item.id, item.observation, item.positiveCases, item.negativeCases, item.bindingRefs].flat().join(' ')
    : '').join(' ').toLowerCase()
}

export function r3MandatoryDimensionsRule(input: Beta1TaskInput, risk: string): EnhancedPreflightRuleResult {
  if (risk !== 'R3') return { id: 'r3_mandatory_dimensions', passed: true, errors: [], warnings: [] }
  const text = acceptanceText(input)
  const dimensions = [
    ['security', /security|threat|vuln|authorization|authentication|trust/u],
    ['compatibility', /compat|backward|breaking|legacy/u],
    ['rollback', /rollback|recovery|restore|revert/u],
  ] as const
  const errors = dimensions
    .filter(([, pattern]) => !pattern.test(text))
    .map(([name]) => `PREFLIGHT_R3_DIMENSION_MISSING:${name}`)
  return { id: 'r3_mandatory_dimensions', passed: errors.length === 0, errors, warnings: [] }
}

const stopWords = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'will', 'can',
  'should', 'must', 'add', 'new', 'update', 'implement', 'implementation',
])

export function scopeAcceptanceCoverageRule(input: Beta1TaskInput): EnhancedPreflightRuleResult {
  const text = acceptanceText(input)
  const words = input.scope.join(' ').toLowerCase().match(/\b[a-z][a-z0-9-]{2,}\b/gu) ?? []
  const keywords = [...new Set(words.filter((word) => !stopWords.has(word)))].sort()
  const warnings = keywords
    .filter((keyword) => !text.includes(keyword))
    .slice(0, 20)
    .map((keyword) => `PREFLIGHT_SCOPE_ACCEPTANCE_KEYWORD_MISSING:${keyword}`)
  return { id: 'scope_acceptance_coverage', passed: true, errors: [], warnings }
}

export function runEnhancedPreflightRules(input: Beta1TaskInput, risk: string): EnhancedPreflightRuleResult[] {
  return [
    sourceTestPairingRule(input),
    r3MandatoryDimensionsRule(input, risk),
    scopeAcceptanceCoverageRule(input),
  ]
}
