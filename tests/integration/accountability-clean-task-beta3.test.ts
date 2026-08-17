import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'

import { inspectCleanTask } from '../../src/accountability/clean-task.js'
import { verifyCloseEligibility } from '../../src/commands/task-close.js'
import { verifyReviewEligibility } from '../../src/commands/task-review.js'
import { canonicalDigest } from '../../src/model/digest.js'
import { applyTaskTransition } from '../../src/state/ledger.js'
import { hardenedTaskFixture, sha256 } from '../helpers/hardened-task.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function closedFixture() {
  const fixture = hardenedTaskFixture()
  temporaryDirectories.push(fixture.root)
  const review = {
    schemaVersion: 2,
    artifactType: 'sop-review-v2',
    taskId: fixture.taskId,
    reviewer: { id: 'reviewer', trustLevel: 'local-claim' },
    decision: 'ACCEPTED',
    contract: { path: fixture.contractPath, sha256: sha256(readFileSync(fixture.contractPath)), digest: fixture.contract.contractDigest },
    candidate: { path: fixture.candidatePath, sha256: sha256(readFileSync(fixture.candidatePath)), digest: canonicalDigest(fixture.candidate) },
    verification: { path: fixture.verificationPath, sha256: sha256(readFileSync(fixture.verificationPath)) },
    reviewedImplementation: fixture.verification.implementationIdentities,
    findings: [],
    nextStage: 'close',
    userActionRequired: false,
  }
  const reviewPath = join(fixture.root, `.delivery/tasks/${fixture.taskId}/review.yaml`)
  writeFileSync(reviewPath, stringify(review))
  const reviewDecision = verifyReviewEligibility({ reviewPath } as never)
  if (!reviewDecision.valid || reviewDecision.transitionPlan === undefined) throw new Error(reviewDecision.errors.join(','))
  if (!applyTaskTransition(reviewDecision.transitionPlan, reviewDecision.transitionPlan.digest).applied) throw new Error('accept failed')

  const statusPath = join(fixture.root, 'STATUS.md')
  writeFileSync(statusPath, `Task ${fixture.taskId} accepted. Next: release planning.\n`)
  const closurePath = join(fixture.root, `.delivery/tasks/${fixture.taskId}/closure.yaml`)
  writeFileSync(closurePath, stringify({
    schemaVersion: 2,
    artifactType: 'sop-closure-v2',
    taskId: fixture.taskId,
    closer: { id: 'reviewer', trustLevel: 'local-claim' },
    contract: review.contract,
    candidate: review.candidate,
    verification: review.verification,
    review: { path: reviewPath, sha256: sha256(readFileSync(reviewPath)) },
    acceptedEventDigest: reviewDecision.transitionPlan.event.eventDigest,
    statusArtifacts: [{ path: statusPath, sha256: sha256(readFileSync(statusPath)) }],
    nextAction: 'release planning',
    userActionRequired: false,
  }))
  const closeDecision = verifyCloseEligibility({ closurePath })
  if (!closeDecision.valid || closeDecision.transitionPlan === undefined) throw new Error(closeDecision.errors.join(','))
  if (!applyTaskTransition(closeDecision.transitionPlan, closeDecision.transitionPlan.digest).applied) throw new Error('close failed')
  return fixture
}

describe('beta3 clean task verification', () => {
  it('accepts one real-path CLOSED task and assigns its risk credit', () => {
    const fixture = closedFixture()
    expect(inspectCleanTask(fixture.root, fixture.taskId)).toMatchObject({
      isClean: true,
      risk: 'R3',
      credit: -3,
      errors: [],
    })
  })

  it('rejects evidence changed after closure', () => {
    const fixture = closedFixture()
    writeFileSync(fixture.receiptPath, `${readFileSync(fixture.receiptPath, 'utf8')}\n`)
    const result = inspectCleanTask(fixture.root, fixture.taskId)
    expect(result.isClean).toBe(false)
    expect(result.noEvidenceForgery).toBe(false)
  })
})
