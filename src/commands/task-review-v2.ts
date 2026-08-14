import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { parse } from 'yaml'

import { governanceIdentity } from './adopt.js'
import type { HardenedCandidateEligibilityInput } from './task-verify-v2.js'
import type { Risk } from '../model/types.js'
import { canonicalDigest } from '../model/digest.js'
import { normalizeActorId } from '../model/actor.js'
import { validateDocument } from '../policy/load.js'
import { planTaskTransition, readTaskLedger, type TaskTransitionPlan } from '../state/ledger.js'
import { validateAcceptanceAuthority } from '../state/transitions.js'

interface ArtifactReference {
  path: string
  sha256: string
}

interface ArtifactWithDigest extends ArtifactReference {
  digest: string
}

interface ImplementationIdentityV2 {
  repositoryId: string
  repository: string
  commit: string
  tree: string
  checkoutDigest: string
}

interface ReviewV2 {
  schemaVersion: 2
  artifactType: 'sop-review-v2'
  taskId: string
  reviewer: { id: string; trustLevel: 'local-claim' }
  decision: 'ACCEPTED' | 'REPAIR_REQUIRED'
  contract: ArtifactWithDigest
  candidate: ArtifactWithDigest
  verification: ArtifactReference
  reviewedImplementation: ImplementationIdentityV2[]
  findings: Array<{ id: string }>
  nextStage: 'close' | 'repair'
  userActionRequired: boolean
}

interface ContractV2 {
  schemaVersion: 2
  taskId: string
  sopVersion: string
  policyDigest: string
  contractDigest: string
  risk: Risk
  implementationOwner: string
  evidenceFreshnessMs: number
  [key: string]: unknown
}

interface VerificationV2 {
  schemaVersion: 2
  artifactType: 'sop-candidate-verification-v2'
  producer: { name: string; version: string; policyDigest: string }
  taskId: string
  contract: ArtifactWithDigest
  candidate: ArtifactWithDigest
  evidence: ArtifactReference
  receipts: Array<ArtifactReference & { acceptanceId: string }>
  implementationIdentities: ImplementationIdentityV2[]
  verifiedAt: string
  decision: 'eligible'
}

export interface HardenedReviewDecision {
  valid: boolean
  errors: string[]
  reviewerTrust?: 'local-claim'
  transitionPlan?: TaskTransitionPlan
}

function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function readExact(path: string, expectedPath: string, expectedSha256: string, label: string): Buffer {
  const unresolved = resolve(path)
  if (lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
    throw new Error(`${label}_ARTIFACT_UNSAFE`)
  }
  const canonical = realpathSync(unresolved)
  if (canonical !== expectedPath) throw new Error(`${label}_CANONICAL_PATH_MISMATCH`)
  const raw = readFileSync(canonical)
  if (sha256(raw) !== expectedSha256) throw new Error(`${label}_ARTIFACT_DIGEST_MISMATCH`)
  return raw
}

function sameIdentities(left: ImplementationIdentityV2[], right: ImplementationIdentityV2[]): boolean {
  const canonical = (items: ImplementationIdentityV2[]) => [...items]
    .sort((a, b) => a.repositoryId.localeCompare(b.repositoryId))
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function referenceErrors(reference: ArtifactReference, label: string): string[] {
  try {
    const unresolved = resolve(reference.path)
    if (lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
      return [`${label}_ARTIFACT_UNSAFE`]
    }
    return sha256(readFileSync(realpathSync(unresolved))) === reference.sha256
      ? []
      : [`${label}_ARTIFACT_DIGEST_MISMATCH`]
  } catch {
    return [`${label}_ARTIFACT_UNREADABLE`]
  }
}

export function verifyHardenedReview(reviewPathInput: string, now = new Date()): HardenedReviewDecision {
  let reviewPath: string
  let reviewRaw: Buffer
  let review: ReviewV2
  try {
    const unresolved = resolve(reviewPathInput)
    if (lstatSync(unresolved).isSymbolicLink() || !lstatSync(unresolved).isFile()) {
      return { valid: false, errors: ['REVIEW_ARTIFACT_UNSAFE'] }
    }
    reviewPath = realpathSync(unresolved)
    reviewRaw = readFileSync(reviewPath)
    review = parse(reviewRaw.toString('utf8')) as ReviewV2
  } catch {
    return { valid: false, errors: ['REVIEW_FILE_UNREADABLE'] }
  }
  const schema = validateDocument('review', review)
  if (!schema.valid || review.schemaVersion !== 2) {
    return {
      valid: false,
      errors: schema.errors.map((error) => `REVIEW_SCHEMA_INVALID:${error}`),
    }
  }

  const taskDirectory = dirname(reviewPath)
  const projectRoot = realpathSync(resolve(taskDirectory, '../../..'))
  const expectedTaskDirectory = realpathSync(join(projectRoot, '.delivery', 'tasks', review.taskId))
  const errors: string[] = []
  if (taskDirectory !== expectedTaskDirectory || reviewPath !== join(taskDirectory, 'review.yaml')) {
    errors.push('REVIEW_CANONICAL_PATH_MISMATCH')
  }

  let contract: ContractV2
  let candidate: HardenedCandidateEligibilityInput
  let verification: VerificationV2
  try {
    const raw = readExact(
      review.contract.path,
      join(taskDirectory, 'contract.yaml'),
      review.contract.sha256,
      'CONTRACT',
    )
    contract = parse(raw.toString('utf8')) as ContractV2
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : 'CONTRACT_ARTIFACT_UNREADABLE'] }
  }
  try {
    const raw = readExact(
      review.candidate.path,
      join(taskDirectory, 'candidate.yaml'),
      review.candidate.sha256,
      'CANDIDATE',
    )
    candidate = parse(raw.toString('utf8')) as HardenedCandidateEligibilityInput
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : 'CANDIDATE_ARTIFACT_UNREADABLE'] }
  }
  try {
    const raw = readExact(
      review.verification.path,
      join(taskDirectory, 'verification.json'),
      review.verification.sha256,
      'VERIFICATION',
    )
    verification = JSON.parse(raw.toString('utf8')) as VerificationV2
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : 'VERIFICATION_ARTIFACT_UNREADABLE'] }
  }

  const contractSchema = validateDocument('task-contract', contract)
  if (!contractSchema.valid || contract.schemaVersion !== 2) errors.push('CONTRACT_SCHEMA_INVALID')
  else {
    const { contractDigest, ...unsigned } = contract
    if (canonicalDigest(unsigned) !== contractDigest) errors.push('CONTRACT_DIGEST_INVALID')
    if (review.contract.digest !== contractDigest) errors.push('REVIEW_CONTRACT_DIGEST_MISMATCH')
    const identity = governanceIdentity()
    if (contract.sopVersion !== identity.version || contract.policyDigest !== identity.digest) {
      errors.push('CONTRACT_POLICY_IDENTITY_MISMATCH')
    }
  }
  const candidateSchema = validateDocument('candidate', candidate)
  if (!candidateSchema.valid || candidate.schemaVersion !== 2) errors.push('CANDIDATE_SCHEMA_INVALID')
  if (canonicalDigest(candidate) !== review.candidate.digest) errors.push('REVIEW_CANDIDATE_DIGEST_MISMATCH')
  const verificationSchema = validateDocument('verification', verification)
  if (!verificationSchema.valid || verification.schemaVersion !== 2) {
    errors.push('VERIFICATION_SCHEMA_INVALID')
  } else {
    if (verification.taskId !== review.taskId) errors.push('VERIFICATION_TASK_ID_MISMATCH')
    if (JSON.stringify(verification.contract) !== JSON.stringify(review.contract)) {
      errors.push('VERIFICATION_CONTRACT_REF_MISMATCH')
    }
    if (JSON.stringify(verification.candidate) !== JSON.stringify(review.candidate)) {
      errors.push('VERIFICATION_CANDIDATE_REF_MISMATCH')
    }
    if (!sameIdentities(verification.implementationIdentities, review.reviewedImplementation)) {
      errors.push('REVIEW_IMPLEMENTATION_IDENTITY_MISMATCH')
    }
    errors.push(...referenceErrors(verification.evidence, 'VERIFIED_EVIDENCE'))
    for (const receipt of verification.receipts) {
      errors.push(...referenceErrors(receipt, `VERIFIED_RECEIPT:${receipt.acceptanceId}`))
    }
    const verifiedAt = Date.parse(verification.verifiedAt)
    const age = now.getTime() - verifiedAt
    if (!Number.isFinite(verifiedAt) || !Number.isFinite(now.getTime())) errors.push('VERIFICATION_TIME_INVALID')
    else if (age < 0) errors.push('VERIFICATION_TIME_IN_FUTURE')
    else if (age > contract.evidenceFreshnessMs) errors.push('VERIFICATION_STALE')
  }
  if (review.taskId !== contract.taskId || review.taskId !== candidate.taskId) {
    errors.push('REVIEW_TASK_ID_MISMATCH')
  }
  let reviewerId: string | undefined
  try {
    reviewerId = normalizeActorId(review.reviewer.id)
  } catch {
    errors.push('REVIEWER_ID_INVALID')
  }
  if (reviewerId !== undefined) {
    errors.push(...validateAcceptanceAuthority(
      contract.risk,
      contract.implementationOwner,
      reviewerId,
    ).errors)
  }
  const findingIds = review.findings.map((finding) => finding.id)
  if (new Set(findingIds).size !== findingIds.length) errors.push('REVIEW_FINDING_IDS_DUPLICATED')

  const ledger = readTaskLedger({
    projectRoot,
    taskId: review.taskId,
    contractDigest: contract.contractDigest,
    contractSha256: review.contract.sha256,
    implementationOwner: contract.implementationOwner,
  })
  if (!ledger.valid) errors.push(...ledger.errors.map((error) => `TASK_LEDGER_INVALID:${error}`))
  else if (ledger.currentState !== 'CANDIDATE') {
    errors.push(`TASK_STATE_NOT_REVIEWABLE:${ledger.currentState ?? 'UNKNOWN'}`)
  }

  const uniqueErrors = [...new Set(errors)].sort()
  if (uniqueErrors.length > 0 || reviewerId === undefined) {
    return { valid: false, errors: uniqueErrors, reviewerTrust: 'local-claim' }
  }
  const transitionPlan = planTaskTransition({
    projectRoot,
    taskId: review.taskId,
    actorId: reviewerId,
    to: review.decision,
    artifacts: [
      { kind: 'review', path: reviewPath },
      { kind: 'verification', path: review.verification.path },
    ],
  })
  return { valid: true, errors: [], reviewerTrust: 'local-claim', transitionPlan }
}
