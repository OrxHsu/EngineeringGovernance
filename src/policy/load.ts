import { readFileSync } from 'node:fs'

import type { ErrorObject, ValidateFunction } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'

import type { DocumentKind, ValidationResult } from '../model/types.js'

const schemaPaths: Record<DocumentKind, URL> = {
  'project-policy': new URL('../../schemas/project-policy.schema.json', import.meta.url),
  'task-contract': new URL('../../schemas/task-contract.schema.json', import.meta.url),
  candidate: new URL('../../schemas/candidate.schema.json', import.meta.url),
  evidence: new URL('../../schemas/evidence.schema.json', import.meta.url),
  review: new URL('../../schemas/review.schema.json', import.meta.url),
  closure: new URL('../../schemas/closure.schema.json', import.meta.url),
  exception: new URL('../../schemas/exception.schema.json', import.meta.url),
  authorization: new URL('../../schemas/authorization.schema.json', import.meta.url),
  'task-event': new URL('../../schemas/task-event.schema.json', import.meta.url),
  'execution-receipt': new URL('../../schemas/execution-receipt.schema.json', import.meta.url),
  verification: new URL('../../schemas/verification.schema.json', import.meta.url),
}

const ajv = new Ajv2020({ allErrors: true, strict: true })
const validators = new Map<DocumentKind, ValidateFunction>()

function validatorFor(kind: DocumentKind): ValidateFunction {
  const cached = validators.get(kind)
  if (cached) return cached

  const schema = JSON.parse(readFileSync(schemaPaths[kind], 'utf8')) as object
  const validator = ajv.compile(schema)
  validators.set(kind, validator)
  return validator
}

function describeError(error: ErrorObject): string {
  const path = error.instancePath || '/'
  const missing = typeof error.params.missingProperty === 'string'
    ? `:${error.params.missingProperty}`
    : ''
  return `${path}${missing} ${error.keyword} ${error.message ?? 'invalid'}`
}

export function validateDocument(kind: DocumentKind, input: unknown): ValidationResult {
  const validator = validatorFor(kind)
  const valid = validator(input)
  if (valid) return { valid: true, errors: [] }

  return {
    valid: false,
    errors: (validator.errors ?? []).map(describeError).sort(),
  }
}

export function validateProjectPolicy(input: unknown): ValidationResult {
  return validateDocument('project-policy', input)
}
