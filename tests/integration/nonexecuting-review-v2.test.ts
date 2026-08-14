import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'

import { verifyReviewEligibility } from '../../src/commands/task-review.js'
import { canonicalDigest } from '../../src/model/digest.js'
import { hardenedTaskFixture, sha256 } from '../helpers/hardened-task.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('non-executing v2 review', () => {
  it('consumes an exact persisted verification and returns an ACCEPTED transition plan', () => {
    let trigger = ''
    let marker = ''
    const fixture = hardenedTaskFixture({
      commandScript: (root) => {
        trigger = join(root, 'review-trigger')
        marker = join(root, 'review-executed')
        return `const fs=require('node:fs'); if(fs.existsSync(${JSON.stringify(trigger)})) fs.writeFileSync(${JSON.stringify(marker)}, 'bad'); process.stdout.write('passed\\n')`
      },
    })
    temporaryDirectories.push(fixture.root)
    writeFileSync(trigger, 'review must not execute the command\n')

    const review = {
      schemaVersion: 2,
      artifactType: 'sop-review-v2',
      taskId: fixture.taskId,
      reviewer: { id: ' Independent-Reviewer ', trustLevel: 'local-claim' },
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
    }
    const reviewPath = join(fixture.root, `.delivery/tasks/${fixture.taskId}/review.yaml`)
    writeFileSync(reviewPath, stringify(review))

    const decision = verifyReviewEligibility({ reviewPath } as never)
    expect(decision.errors).toEqual([])
    expect(decision.valid).toBe(true)
    expect(decision).toMatchObject({
      reviewerTrust: 'local-claim',
      transitionPlan: { event: { from: 'CANDIDATE', to: 'ACCEPTED', actorId: 'independent-reviewer' } },
    })
    expect(existsSync(marker)).toBe(false)
  })

  it('rejects normalized self-review and verification substitution without executing commands', () => {
    const fixture = hardenedTaskFixture()
    temporaryDirectories.push(fixture.root)
    const base = {
      schemaVersion: 2,
      artifactType: 'sop-review-v2',
      taskId: fixture.taskId,
      reviewer: { id: 'CODEX', trustLevel: 'local-claim' },
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
    }
    const reviewPath = join(fixture.root, `.delivery/tasks/${fixture.taskId}/review.yaml`)
    writeFileSync(reviewPath, stringify(base))
    expect(verifyReviewEligibility({ reviewPath } as never).errors).toContain('INDEPENDENT_REVIEW_REQUIRED')

    base.reviewer.id = 'reviewer'
    base.verification.sha256 = '0'.repeat(64)
    writeFileSync(reviewPath, stringify(base))
    expect(verifyReviewEligibility({ reviewPath } as never).errors).toContain(
      'VERIFICATION_ARTIFACT_DIGEST_MISMATCH',
    )
  })

  it('rejects a schema-valid verification that was not the runner-computed result', () => {
    const fixture = hardenedTaskFixture()
    temporaryDirectories.push(fixture.root)
    const forgedVerification = {
      ...fixture.verification,
      producer: { ...fixture.verification.producer, version: 'forged-version' },
    }
    writeFileSync(fixture.verificationPath, `${JSON.stringify(forgedVerification, null, 2)}\n`)
    const review = {
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
    }
    const reviewPath = join(fixture.root, `.delivery/tasks/${fixture.taskId}/review.yaml`)
    writeFileSync(reviewPath, stringify(review))

    expect(verifyReviewEligibility({ reviewPath } as never).errors).toContain(
      'VERIFICATION_RECOMPUTATION_MISMATCH',
    )
  })
})
