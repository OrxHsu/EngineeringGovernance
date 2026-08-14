import { rmSync } from 'node:fs'

import { afterEach, describe, expect, it } from 'vitest'

import { hardenedTaskFixture } from '../helpers/hardened-task.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

const requirement = {
  id: 'AUTH-01',
  action: 'deploy',
  target: 'production-api',
  scope: ['service:api', 'region:sg'],
  trustLevel: 'recorded-claim' as const,
  consumeOnce: true,
}

function document(input: { taskId: string; contractDigest: string }) {
  return {
    schemaVersion: 2,
    artifactType: 'sop-authorization-v2',
    authorizationId: 'authorization-1',
    requirementId: requirement.id,
    taskId: input.taskId,
    contractDigest: input.contractDigest,
    grantor: { id: 'user', role: 'user', trustLevel: 'local-claim' },
    action: requirement.action,
    target: requirement.target,
    scope: requirement.scope,
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: 'approved',
  }
}

describe('v2 authorization binding', () => {
  it('accepts an exact active local claim while exposing its trust level', () => {
    const fixture = hardenedTaskFixture({
      authorizationRequirements: [requirement],
      authorizationDocuments: (input) => [{
        requirementId: requirement.id,
        document: document(input),
      }],
    })
    temporaryDirectories.push(fixture.root)
    expect(fixture.verification.authorizationTrust).toEqual([
      { requirementId: 'AUTH-01', trustLevel: 'local-claim' },
    ])
  })

  it('rejects target drift and verified attestations without a trusted verifier', () => {
    expect(() => hardenedTaskFixture({
      authorizationRequirements: [requirement],
      authorizationDocuments: (input) => [{
        requirementId: requirement.id,
        document: { ...document(input), target: 'staging-api' },
      }],
    })).toThrow('AUTHORIZATION_TARGET_MISMATCH:AUTH-01')

    expect(() => hardenedTaskFixture({
      authorizationRequirements: [{ ...requirement, trustLevel: 'verified-attestation' }],
      authorizationDocuments: (input) => [{
        requirementId: requirement.id,
        document: {
          ...document(input),
          grantor: { id: 'user', role: 'user', trustLevel: 'verified-attestation' },
          attestation: { provider: 'example', subject: 'user', proof: 'opaque' },
        },
      }],
    })).toThrow('AUTHORIZATION_ATTESTATION_VERIFIER_UNAVAILABLE:AUTH-01')
  })
})
