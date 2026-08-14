import type { DocumentKind, ValidationResult } from '../model/types.js'
import { validateDocument } from '../policy/load.js'

type LegacyDocumentKind = Extract<
  DocumentKind,
  'task-contract' | 'candidate' | 'review' | 'closure' | 'execution-receipt'
> | 'task-start'

interface LegacyInspection extends ValidationResult {
  kind?: LegacyDocumentKind
  schemaVersion: number | null
  summary: Record<string, unknown>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function legacyKind(value: Record<string, unknown>): LegacyDocumentKind | undefined {
  if (value.artifactType === 'sop-command-execution-v1') return 'execution-receipt'
  if (Object.hasOwn(value, 'projectPath') && Object.hasOwn(value, 'statusArtifacts')) return 'closure'
  if (Object.hasOwn(value, 'reviewer') && Object.hasOwn(value, 'findings')) return 'review'
  if (Object.hasOwn(value, 'sopVersion') && Object.hasOwn(value, 'implementationOwner')) {
    return 'task-contract'
  }
  if (Object.hasOwn(value, 'authorizationRequired')) return 'candidate'
  if (
    Object.hasOwn(value, 'taskId')
    && Object.hasOwn(value, 'implementationOwner')
    && Object.hasOwn(value, 'objective')
    && Object.hasOwn(value, 'signals')
    && Object.hasOwn(value, 'requiredGates')
  ) return 'task-start'
  return undefined
}

function stringArray(value: unknown, allowEmpty: boolean): boolean {
  return Array.isArray(value)
    && (allowEmpty || value.length > 0)
    && value.every((item) => typeof item === 'string' && item.length > 0)
}

function legacyTaskStartErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = []
  for (const key of ['taskId', 'implementationOwner', 'objective']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) errors.push(`/${key} required`)
  }
  for (const [key, allowEmpty] of [
    ['scope', false],
    ['nonGoals', true],
    ['authorityInputs', false],
    ['requiredGates', false],
    ['openChoices', true],
  ] as const) {
    if (!stringArray(value[key], allowEmpty)) errors.push(`/${key} invalid`)
  }
  if (!record(value.signals) || Object.keys(value.signals).length === 0) errors.push('/signals invalid')
  if (!Array.isArray(value.acceptance) || value.acceptance.length === 0) {
    errors.push('/acceptance invalid')
  } else {
    for (const [index, item] of value.acceptance.entries()) {
      if (
        !record(item)
        || typeof item.id !== 'string'
        || item.id.length === 0
        || typeof item.observation !== 'string'
        || item.observation.length === 0
        || !stringArray(item.positiveCases, false)
        || !stringArray(item.negativeCases, false)
      ) errors.push(`/acceptance/${index} invalid`)
    }
  }
  return errors
}

function summary(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of [
    'taskId',
    'risk',
    'state',
    'decision',
    'implementationOwner',
    'contractDigest',
    'artifactType',
    'runId',
  ]) {
    if (Object.hasOwn(value, key)) result[key] = value[key]
  }
  return result
}

export function inspectLegacyDocument(value: unknown): LegacyInspection {
  if (!record(value)) {
    return {
      valid: false,
      errors: ['LEGACY_DOCUMENT_NOT_AN_OBJECT'],
      schemaVersion: null,
      summary: {},
    }
  }
  const schemaVersion = typeof value.schemaVersion === 'number' ? value.schemaVersion : null
  if (schemaVersion !== null && schemaVersion !== 1) {
    return {
      valid: false,
      errors: ['LEGACY_INSPECT_REQUIRES_V1_OR_VERSIONLESS_DOCUMENT'],
      schemaVersion,
      summary: summary(value),
    }
  }
  const kind = legacyKind(value)
  if (kind === undefined) {
    return {
      valid: false,
      errors: ['LEGACY_DOCUMENT_KIND_UNKNOWN'],
      schemaVersion,
      summary: summary(value),
    }
  }
  let validation: ValidationResult
  if (kind === 'task-start') {
    const errors = legacyTaskStartErrors(value)
    validation = { valid: errors.length === 0, errors }
  } else {
    validation = validateDocument(kind, value)
  }
  return {
    valid: validation.valid,
    errors: validation.errors.map((error) => `LEGACY_SCHEMA_INVALID:${error}`),
    kind,
    schemaVersion,
    summary: summary(value),
  }
}
