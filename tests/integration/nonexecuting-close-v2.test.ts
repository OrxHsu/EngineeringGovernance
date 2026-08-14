import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'

import { verifyCloseEligibility } from '../../src/commands/task-close.js'
import { verifyReviewEligibility } from '../../src/commands/task-review.js'
import { canonicalDigest } from '../../src/model/digest.js'
import { applyTaskTransition } from '../../src/state/ledger.js'
import { hardenedTaskFixture, sha256 } from '../helpers/hardened-task.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function acceptedFixture(commandScript?: (root: string) => string) {
  const fixture = hardenedTaskFixture({ commandScript })
  temporaryDirectories.push(fixture.root)
  const review = {
    schemaVersion: 2,
    artifactType: 'sop-review-v2',
    taskId: fixture.taskId,
    reviewer: { id: 'reviewer', trustLevel: 'local-claim' },
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
  const reviewDecision = verifyReviewEligibility({ reviewPath } as never)
  if (!reviewDecision.valid || reviewDecision.transitionPlan === undefined) {
    throw new Error(`review fixture failed:${reviewDecision.errors.join(',')}`)
  }
  const applied = applyTaskTransition(reviewDecision.transitionPlan, reviewDecision.transitionPlan.digest)
  if (!applied.applied) throw new Error(`accept fixture failed:${applied.errors.join(',')}`)
  return { ...fixture, review, reviewPath, acceptedEventDigest: reviewDecision.transitionPlan.event.eventDigest }
}

describe('non-executing v2 close', () => {
  it('binds the accepted event and status artifacts, then returns a CLOSED transition plan', () => {
    let trigger = ''
    let marker = ''
    const fixture = acceptedFixture((root) => {
      trigger = join(root, 'close-trigger')
      marker = join(root, 'close-executed')
      return `const fs=require('node:fs'); if(fs.existsSync(${JSON.stringify(trigger)})) fs.writeFileSync(${JSON.stringify(marker)}, 'bad'); process.stdout.write('passed\\n')`
    })
    writeFileSync(trigger, 'close must not execute the command\n')
    const statusPath = join(fixture.root, 'STATUS.md')
    writeFileSync(statusPath, `Task ${fixture.taskId} accepted. Next: release planning.\n`)
    const closure = {
      schemaVersion: 2,
      artifactType: 'sop-closure-v2',
      taskId: fixture.taskId,
      closer: { id: 'reviewer', trustLevel: 'local-claim' },
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
      review: { path: fixture.reviewPath, sha256: sha256(readFileSync(fixture.reviewPath)) },
      acceptedEventDigest: fixture.acceptedEventDigest,
      statusArtifacts: [{ path: statusPath, sha256: sha256(readFileSync(statusPath)) }],
      nextAction: 'release planning',
      userActionRequired: false,
    }
    const closurePath = join(fixture.root, `.delivery/tasks/${fixture.taskId}/closure.yaml`)
    writeFileSync(closurePath, stringify(closure))

    const decision = verifyCloseEligibility({ closurePath })
    expect(decision.errors).toEqual([])
    expect(decision.valid).toBe(true)
    expect(decision).toMatchObject({
      closerTrust: 'local-claim',
      transitionPlan: { event: { from: 'ACCEPTED', to: 'CLOSED', actorId: 'reviewer' } },
    })
    expect(existsSync(marker)).toBe(false)
  })

  it('rejects a forged accepted event and a substituted review', () => {
    const fixture = acceptedFixture()
    const statusPath = join(fixture.root, 'STATUS.md')
    writeFileSync(statusPath, `Task ${fixture.taskId}. Next: release planning.\n`)
    const closure = {
      schemaVersion: 2,
      artifactType: 'sop-closure-v2',
      taskId: fixture.taskId,
      closer: { id: 'closer', trustLevel: 'local-claim' },
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
      verification: { path: fixture.verificationPath, sha256: sha256(readFileSync(fixture.verificationPath)) },
      review: { path: fixture.reviewPath, sha256: sha256(readFileSync(fixture.reviewPath)) },
      acceptedEventDigest: '0'.repeat(64),
      statusArtifacts: [{ path: statusPath, sha256: sha256(readFileSync(statusPath)) }],
      nextAction: 'release planning',
      userActionRequired: false,
    }
    const closurePath = join(fixture.root, `.delivery/tasks/${fixture.taskId}/closure.yaml`)
    writeFileSync(closurePath, stringify(closure))
    expect(verifyCloseEligibility({ closurePath }).errors).toContain('CLOSURE_ACCEPTED_EVENT_MISMATCH')

    closure.acceptedEventDigest = fixture.acceptedEventDigest
    closure.review.sha256 = '0'.repeat(64)
    writeFileSync(closurePath, stringify(closure))
    expect(verifyCloseEligibility({ closurePath }).errors).toContain('REVIEW_ARTIFACT_DIGEST_MISMATCH')
  })
})
