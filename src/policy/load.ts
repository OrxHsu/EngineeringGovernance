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
  'replay-verification': new URL('../../schemas/replay-verification.schema.json', import.meta.url),
  'extensions-manifest': new URL('../../schemas/extensions-manifest.schema.json', import.meta.url),
  'external-source-use': new URL('../../schemas/external-source-use.schema.json', import.meta.url),
  'external-source-release': new URL('../../schemas/external-source-release.schema.json', import.meta.url),
  'contract-review': new URL('../../schemas/contract-review.schema.json', import.meta.url),
  'prior-review-finding': new URL('../../schemas/prior-review-finding.schema.json', import.meta.url),
  'release-record': new URL('../../schemas/release-record.schema.json', import.meta.url),
  'task-start-input': new URL('../../schemas/task-start-input.schema.json', import.meta.url),
  'contract-preflight': new URL('../../schemas/contract-preflight.schema.json', import.meta.url),
  'actor-registry-event': new URL('../../schemas/actor-registry-event.schema.json', import.meta.url),
  'accountability-event': new URL('../../schemas/accountability-event.schema.json', import.meta.url),
  'accountability-status': new URL('../../schemas/accountability-status.schema.json', import.meta.url),
  'accountability-bootstrap': new URL('../../schemas/accountability-bootstrap.schema.json', import.meta.url),
  'initial-actor-bootstrap': new URL('../../schemas/initial-actor-bootstrap.schema.json', import.meta.url),
  'permanent-gates': new URL('../../schemas/permanent-gates.schema.json', import.meta.url),
  'self-review': new URL('../../schemas/self-review.schema.json', import.meta.url),
  'known-issues': new URL('../../schemas/known-issues.schema.json', import.meta.url),
  'accountability-incident': new URL('../../schemas/accountability-incident.schema.json', import.meta.url),
  'legacy-task-compatibility': new URL('../../schemas/legacy-task-compatibility.schema.json', import.meta.url),
  'historical-evidence-compatibility': new URL('../../schemas/historical-evidence-compatibility.schema.json', import.meta.url),
}

const ajv = new Ajv2020({ allErrors: true, strict: true })
const validators = new Map<DocumentKind, ValidateFunction>()

for (const kind of ['self-review', 'known-issues', 'accountability-incident'] as const) {
  ajv.addSchema(JSON.parse(readFileSync(schemaPaths[kind], 'utf8')) as object)
}

function validatorFor(kind: DocumentKind): ValidateFunction {
  const cached = validators.get(kind)
  if (cached) return cached

  const schema = JSON.parse(readFileSync(schemaPaths[kind], 'utf8')) as { $id?: string }
  const validator = (schema.$id === undefined ? undefined : ajv.getSchema(schema.$id))
    ?? ajv.compile(schema)
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
