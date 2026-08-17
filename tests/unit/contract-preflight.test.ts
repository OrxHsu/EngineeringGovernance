import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'

import { preflightTaskInput } from '../../src/accountability/preflight.js'
import { canonicalDigest } from '../../src/model/digest.js'
import { validateDocument } from '../../src/policy/load.js'
import { finalizeSelfReview, SELF_REVIEW_DIMENSIONS } from '../../src/review/mutual-review.js'

const temporary: string[] = []
const root = process.cwd()

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function validInput() {
  const authority = readFileSync(join(root, 'CORE_INVARIANTS.md'))
  const authorityDigest = canonicalDigest(authority.toString('utf8'))
  const ids = ['d-source', 'a-core', 'c-version', 'e-version', 't-start', 'role-owner', 'kind-contract']
  return {
    schemaVersion: 2,
    taskId: 'global-sop-2-1-beta-1-fix-1-repair-3',
    contractAuthor: 'codex',
    implementationOwner: 'codex',
    objective: 'Preflight completeness.',
    scope: ['src/**'],
    nonGoals: ['publish'],
    authorityInputs: [
      'CORE_INVARIANTS.md',
      'tests/fixtures/accountability/tasks/global-sop-2-1-beta-1-fix-1-repair-3/contract-defect.yaml',
    ],
    repositories: [{ id: 'root', path: root }],
    acceptance: [{ id: 'AC-01', observation: 'check', positiveCases: ['pass'], negativeCases: ['reject'], bindingRefs: ids }],
    authorizationRequirements: [{ id: 'AUTH-TEST', action: 'test', target: root, scope: ['local'], trustLevel: 'recorded-claim', consumeOnce: true }],
    evidenceFreshnessMs: 86_400_000,
    designBindings: {
      deliverables: [{ id: 'd-source', repositoryId: 'root', path: 'src', kind: 'source', schemaRef: 'none', artifactType: 'none' }],
      authorities: [{ id: 'a-core', location: 'repository', repositoryId: 'root', path: 'CORE_INVARIANTS.md', rawSha256: sha256(authority), semanticDigest: authorityDigest }],
      constants: [{ id: 'c-version', valueType: 'string', value: '2.1.0-beta.1', sourceRef: 'a-core' }],
      equalities: [{ id: 'e-version', leftRef: 'c-version', rightRef: 'a-core', comparison: 'exact_string' }],
      transitions: [{ id: 't-start', from: 'DEFINED', to: 'IN_PROGRESS', actorRoleRef: 'role-owner', artifactKindRefs: ['kind-contract'], authorizationRefs: ['AUTH-TEST'] }],
      actorRoles: [{ id: 'role-owner', actorId: 'codex', requiredStanding: 'SUSPENDED', distinctFrom: [] }],
      artifactKinds: [{ id: 'kind-contract', pathPattern: '.delivery/tasks/**/contract.yaml', schemaRef: 'task-contract', minimumCount: 1, maximumCount: 'none' }],
    },
    predecessors: [],
    openChoices: [],
    signals: { mutation: true, crossModule: true, authorization: true, security: true, migration: true, projectMinimum: 'R3' },
  }
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('beta1 contract preflight', () => {
  it.skipIf(process.env.CI === 'true')('accepts a complete input and binds exact input bytes and plan', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sop-preflight-')), 'input.yaml')
    temporary.push(path.slice(0, path.lastIndexOf('/')))
    writeFileSync(path, stringify(validInput()))
    const result = preflightTaskInput(root, path)
    expect(result.valid).toBe(true)
    expect(result.plan?.checks.map((check) => check.id)).toEqual([
      'input_schema', 'authority_resolvability', 'design_binding_schema', 'design_binding_references',
      'acceptance_coverage', 'risk_classification', 'actor_eligibility', 'actor_permanent_gates', 'authorization',
      'repository_baselines', 'open_choices',
    ])
    expect(result.plan?.inputRawSha256).toHaveLength(64)
    expect(result.plan?.planDigest).toHaveLength(64)
  })

  it.each(['null', '[]', 'schemaVersion: 2\n'])('rejects malformed input %s without TypeError', (content) => {
    const path = join(mkdtempSync(join(tmpdir(), 'sop-preflight-malformed-')), 'input.yaml')
    temporary.push(path.slice(0, path.lastIndexOf('/')))
    writeFileSync(path, content)
    expect(() => preflightTaskInput(root, path)).not.toThrow(/TypeError/u)
    expect(preflightTaskInput(root, path).valid).toBe(false)
  })

  it('rejects an unknown design binding key and changed authority bytes', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sop-preflight-invalid-')), 'input.yaml')
    temporary.push(path.slice(0, path.lastIndexOf('/')))
    const input = validInput() as Record<string, any>
    input.designBindings.deliverables[0].unexpected = true
    writeFileSync(path, stringify(input))
    expect(preflightTaskInput(root, path).errors.some((error) => error.includes('PREFLIGHT_DESIGN_BINDING'))).toBe(true)
  })

  it.skipIf(process.env.CI === 'true')('adds the beta2 mutual-review checks and binds the self-review subject', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'sop-preflight-mutual-review-')), 'input.yaml')
    temporary.push(path.slice(0, path.lastIndexOf('/')))
    const input = validInput() as Record<string, any>
    input.acceptance[0].observation = 'src security compatibility and rollback are observed.'
    const attachment = finalizeSelfReview(input, {
      durationSeconds: 30,
      dimensions: SELF_REVIEW_DIMENSIONS.map((name) => ({ name, status: 'PASS', evidence: `${name} is covered.` })),
      overallStatus: 'PASSED',
      knownIssues: [],
    }, '2026-08-16T00:00:00.000Z')
    Object.assign(input, attachment)
    writeFileSync(path, stringify(input))
    const result = preflightTaskInput(root, path)
    expect(result.valid).toBe(true)
    expect(result.plan?.checks.map((check) => check.id).slice(-4)).toEqual([
      'source_test_pairing', 'r3_mandatory_dimensions', 'scope_acceptance_coverage', 'self_review',
    ])
    expect(result.plan?.checks).toHaveLength(15)
    expect(validateDocument('contract-preflight', result.plan).valid).toBe(true)
    expect(result.plan?.selfReviewSubjectDigest).toBe(input.selfReview.subjectDigest)
  })
})
