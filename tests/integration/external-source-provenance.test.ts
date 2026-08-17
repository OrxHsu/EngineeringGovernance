import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'

import { verifyHardenedClose } from '../../src/commands/task-close-v2.js'
import { verifyHardenedReview } from '../../src/commands/task-review-v2.js'
import { extensionDescriptor } from '../../src/extensions/registry.js'
import { canonicalDigest } from '../../src/model/digest.js'
import { validateProjectTaskGraph } from '../../src/project/task-graph.js'
import { applyTaskTransition } from '../../src/state/ledger.js'
import {
  hardenedTaskFixture,
  sha256,
  type HardenedTaskFixture,
} from '../helpers/hardened-task.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

const descriptor = extensionDescriptor('external-source-provenance', '1.0.0')

function allocation(destinationPath = 'implementation.txt') {
  return {
    mode: 'source-assisted',
    allocationId: 'allocation-1',
    accessMode: 'copy-exact',
    source: {
      locator: { kind: 'git', uri: 'https://example.invalid/source.git' },
      pin: { algorithm: 'git-commit', digest: 'a'.repeat(40) },
    },
    sourceUnits: [{ id: 'source-1', path: 'lib/transform.ts', symbols: ['transformTrip'] }],
    destinations: [{ repositoryId: 'root', path: destinationPath, symbols: ['transformTrip'] }],
    independentDestinations: [],
    releaseDecisionRequired: true,
  }
}

function documents(
  input: { taskId: string; contractDigest: string },
  releaseDecision = 'approved',
  sourceUse: 'inspect' | 'adapt' | 'copy-exact' = 'copy-exact',
) {
  const extension = { id: descriptor.id, version: descriptor.version, digest: descriptor.digest }
  return [
    {
      extensionId: descriptor.id,
      kind: 'external-source-use',
      document: {
        schemaVersion: 1,
        artifactType: 'external-source-use',
        extension,
        taskId: input.taskId,
        contractDigest: input.contractDigest,
        allocationId: 'allocation-1',
        sourceUses: [{ sourceUnitId: 'source-1', use: sourceUse }],
        destinationUses: [{
          repositoryId: 'root',
          path: 'implementation.txt',
          symbols: ['transformTrip'],
          sourceUnitIds: ['source-1'],
          use: 'copy-exact',
        }],
      },
    },
    {
      extensionId: descriptor.id,
      kind: 'external-source-release',
      document: {
        schemaVersion: 1,
        artifactType: 'external-source-release',
        extension,
        taskId: input.taskId,
        contractDigest: input.contractDigest,
        allocationId: 'allocation-1',
        decision: releaseDecision,
        decidedBy: { id: 'release-reviewer', trustLevel: 'local-claim' },
        destinationIds: ['root:implementation.txt'],
        dispositionId: 'project-reviewed-route-1',
        basis: 'Project-specific licensing review is recorded outside the core.',
      },
    },
  ]
}

function acceptedReview(fixture: HardenedTaskFixture): string {
  const path = join(fixture.root, `.delivery/tasks/${fixture.taskId}/review.yaml`)
  writeFileSync(path, stringify({
    schemaVersion: 2,
    artifactType: 'sop-review-v2',
    taskId: fixture.taskId,
    reviewer: { id: 'independent-reviewer', trustLevel: 'local-claim' },
    decision: 'ACCEPTED',
    contract: {
      path: fixture.contractPath,
      sha256: sha256(readFileSync(fixture.contractPath)),
      digest: fixture.contract.contractDigest,
    },
    candidate: {
      path: fixture.candidatePath,
      sha256: sha256(readFileSync(fixture.candidatePath)),
      digest: canonicalDigest(fixture.candidate),
    },
    verification: {
      path: fixture.verificationPath,
      sha256: sha256(readFileSync(fixture.verificationPath)),
    },
    reviewedImplementation: fixture.verification.implementationIdentities,
    findings: [],
    nextStage: 'close',
    userActionRequired: false,
  }))
  return path
}

function closure(fixture: HardenedTaskFixture, reviewPath: string, acceptedEventDigest: string): string {
  const statusPath = join(fixture.root, 'STATUS.md')
  const nextAction = 'release planning'
  writeFileSync(statusPath, `${fixture.taskId}: ${nextAction}\n`)
  const path = join(fixture.root, `.delivery/tasks/${fixture.taskId}/closure.yaml`)
  writeFileSync(path, stringify({
    schemaVersion: 2,
    artifactType: 'sop-closure-v2',
    taskId: fixture.taskId,
    closer: { id: 'independent-reviewer', trustLevel: 'local-claim' },
    contract: {
      path: fixture.contractPath,
      sha256: sha256(readFileSync(fixture.contractPath)),
      digest: fixture.contract.contractDigest,
    },
    candidate: {
      path: fixture.candidatePath,
      sha256: sha256(readFileSync(fixture.candidatePath)),
      digest: canonicalDigest(fixture.candidate),
    },
    verification: {
      path: fixture.verificationPath,
      sha256: sha256(readFileSync(fixture.verificationPath)),
    },
    review: { path: reviewPath, sha256: sha256(readFileSync(reviewPath)) },
    acceptedEventDigest,
    statusArtifacts: [{ path: statusPath, sha256: sha256(readFileSync(statusPath)) }],
    nextAction,
    userActionRequired: false,
  }))
  return path
}

describe('external-source provenance extension', () => {
  it('permits exact copying only inside a pinned allocation with use and release records', () => {
    const fixture = hardenedTaskFixture({
      projectExtensions: [descriptor],
      extensionInputs: { [`${descriptor.id}@${descriptor.version}`]: allocation() },
      extensionDocuments: (input) => documents(input) as never,
    })
    temporaryDirectories.push(fixture.root)
    expect(fixture.verification.extensionResults).toEqual([{
      extensionId: descriptor.id,
      version: descriptor.version,
      status: 'satisfied',
      releaseTrust: 'local-claim',
    }])
  })

  it('rejects unallocated destinations and a blocked release decision', () => {
    expect(() => hardenedTaskFixture({
      projectExtensions: [descriptor],
      extensionInputs: { [`${descriptor.id}@${descriptor.version}`]: allocation('src/other.ts') },
      extensionDocuments: (input) => documents(input) as never,
    })).toThrow('EXTERNAL_SOURCE_DESTINATION_USE_MISMATCH')

    expect(() => hardenedTaskFixture({
      projectExtensions: [descriptor],
      extensionInputs: { [`${descriptor.id}@${descriptor.version}`]: allocation() },
      extensionDocuments: (input) => documents(input, 'blocked') as never,
    })).toThrow('EXTERNAL_SOURCE_RELEASE_BLOCKED')

    expect(() => hardenedTaskFixture({
      projectExtensions: [descriptor],
      extensionInputs: { [`${descriptor.id}@${descriptor.version}`]: allocation() },
      extensionDocuments: (input) => documents(input, 'approved', 'inspect') as never,
    })).toThrow('EXTERNAL_SOURCE_USE_RELATION_MISMATCH:root:implementation.txt:source-1')
  }, 60_000)

  it('keeps source-use and release bytes bound through review, close, and project check', () => {
    const fixture = hardenedTaskFixture({
      projectExtensions: [descriptor],
      extensionInputs: { [`${descriptor.id}@${descriptor.version}`]: allocation() },
      extensionDocuments: (input) => documents(input) as never,
    })
    temporaryDirectories.push(fixture.root)
    expect(fixture.verification.extensionArtifacts).toHaveLength(2)
    expect(fixture.verification.extensionArtifacts).toEqual(expect.arrayContaining(
      fixture.candidate.extensionArtifacts as typeof fixture.verification.extensionArtifacts,
    ))

    const reviewPath = acceptedReview(fixture)
    const review = verifyHardenedReview(reviewPath)
    expect(review.valid).toBe(true)
    expect(review.transitionPlan).toBeDefined()
    expect(applyTaskTransition(review.transitionPlan!, review.transitionPlan!.digest).applied).toBe(true)
    const closurePath = closure(fixture, reviewPath, review.transitionPlan!.event.eventDigest)
    expect(verifyHardenedClose(closurePath).valid).toBe(true)

    const release = fixture.verification.extensionArtifacts.find((artifact) => (
      artifact.kind === 'external-source-release'
    ))!
    writeFileSync(release.path, `${readFileSync(release.path, 'utf8')}\n`)

    expect(verifyHardenedReview(reviewPath).errors).toContain(
      `VERIFIED_EXTENSION:${descriptor.id}:external-source-release_ARTIFACT_DIGEST_MISMATCH`,
    )
    expect(verifyHardenedClose(closurePath).errors).toContain(
      `VERIFIED_EXTENSION:${descriptor.id}:external-source-release_ARTIFACT_DIGEST_MISMATCH`,
    )
    expect(validateProjectTaskGraph(fixture.root).errors).toContain(
      `TASK_GRAPH_VERIFICATION_EXTENSION_ARTIFACT_INVALID:${fixture.taskId}`,
    )
  })
})
