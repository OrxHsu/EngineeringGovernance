import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'

import { parse } from 'yaml'

import type { Risk, ValidationResult } from '../model/types.js'
import { validateDocument } from '../policy/load.js'
import { validateAcceptanceAuthority } from '../state/transitions.js'
import { canonicalDigest } from '../model/digest.js'
import {
  isHardenedCandidate,
  verifyLegacyCandidateEligibility,
  type CandidateEligibilityInput,
} from './task-verify.js'
import { verifyHardenedReview, type HardenedReviewDecision } from './task-review-v2.js'

interface ReviewDocument {
  schemaVersion: 1
  taskId: string
  contractDigest: string
  candidateDigest: string
  replayPlanDigest?: string
  reviewedImplementation: Array<{ repository: string; commit: string; tree: string }>
  reviewer: string
  decision: 'ACCEPTED' | 'REPAIR_REQUIRED'
  findings: Array<{ id: string; severity: string; classification: string; observation: string }>
  nextStage: string
  userActionRequired: boolean
}

interface ContractDocument {
  taskId: string
  contractDigest: string
  risk: Risk
  implementationOwner: string
}

export interface ReviewEligibilityInput {
  candidatePath: string
  reviewPath: string
  replayPlanDigest: string
}

export interface HardenedReviewEligibilityInput {
  reviewPath: string
}

function digest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function readStructured(path: string): { raw: Buffer; value: unknown } {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error('ARTIFACT_PATH_UNSAFE')
  }
  const raw = readFileSync(path)
  return { raw, value: parse(raw.toString('utf8')) as unknown }
}

function sameIdentities(
  left: Array<{ repository: string; commit: string; tree: string }>,
  right: Array<{ repository: string; commit: string; tree: string }>,
): boolean {
  const canonical = (values: Array<{ repository: string; commit: string; tree: string }>) => (
    [...values].sort((a, b) => a.repository.localeCompare(b.repository))
  )
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

export function verifyReviewEligibility(
  input: ReviewEligibilityInput | HardenedReviewEligibilityInput,
): ValidationResult & Partial<HardenedReviewDecision> {
  let reviewSchemaVersion: number | undefined
  try {
    const review = readStructured(input.reviewPath).value as { schemaVersion?: number }
    reviewSchemaVersion = review.schemaVersion
  } catch {
    return { valid: false, errors: ['REVIEW_FILE_UNREADABLE'] }
  }
  if (reviewSchemaVersion === 2) return verifyHardenedReview(input.reviewPath)
  return { valid: false, errors: ['LEGACY_REVIEW_REQUIRES_PINNED_V1_RUNNER'] }
}

export function verifyLegacyReviewEligibility(
  input: ReviewEligibilityInput,
): ValidationResult {
  const errors: string[] = []
  let candidate: CandidateEligibilityInput
  try {
    const loaded = readStructured(input.candidatePath)
    candidate = loaded.value as CandidateEligibilityInput
  } catch {
    return { valid: false, errors: ['CANDIDATE_FILE_UNREADABLE'] }
  }

  const candidateSchema = validateDocument('candidate', candidate)
  if (!candidateSchema.valid) {
    return {
      valid: false,
      errors: candidateSchema.errors.map((error) => `CANDIDATE_SCHEMA_INVALID:${error}`),
    }
  }
  if (isHardenedCandidate(candidate)) {
    return { valid: false, errors: ['REVIEW_V2_VERIFICATION_ARTIFACT_REQUIRED'] }
  }
  const candidateDecision = verifyLegacyCandidateEligibility(candidate, {
    evidenceReplayPlanDigest: input.replayPlanDigest,
  })
  errors.push(...candidateDecision.errors.map((error) => `CANDIDATE_INVALID:${error}`))
  if (candidate.verification === undefined) {
    errors.push('CANDIDATE_VERIFICATION_REQUIRED')
    return { valid: false, errors: [...new Set(errors)].sort() }
  }

  let contract: ContractDocument
  try {
    contract = parse(readFileSync(candidate.verification.contractPath, 'utf8')) as ContractDocument
  } catch {
    errors.push('CONTRACT_FILE_UNREADABLE')
    return { valid: false, errors: [...new Set(errors)].sort() }
  }

  let review: ReviewDocument
  try {
    review = readStructured(input.reviewPath).value as ReviewDocument
  } catch {
    errors.push('REVIEW_FILE_UNREADABLE')
    return { valid: false, errors: [...new Set(errors)].sort() }
  }
  const reviewSchema = validateDocument('review', review)
  if (!reviewSchema.valid) {
    errors.push(...reviewSchema.errors.map((error) => `REVIEW_SCHEMA_INVALID:${error}`))
    return { valid: false, errors: [...new Set(errors)].sort() }
  }

  if (review.taskId !== contract.taskId) errors.push('REVIEW_TASK_ID_MISMATCH')
  if (review.contractDigest !== contract.contractDigest) errors.push('REVIEW_CONTRACT_MISMATCH')
  if (review.candidateDigest !== canonicalDigest(candidate)) {
    errors.push('REVIEW_CANDIDATE_DIGEST_MISMATCH')
  }
  if (review.replayPlanDigest !== input.replayPlanDigest) {
    errors.push('REVIEW_REPLAY_PLAN_MISMATCH')
  }
  if (!sameIdentities(
    review.reviewedImplementation,
    candidate.verification.expectedImplementationIdentities,
  )) {
    errors.push('REVIEW_IMPLEMENTATION_IDENTITY_MISMATCH')
  }

  errors.push(...validateAcceptanceAuthority(
    contract.risk,
    contract.implementationOwner,
    review.reviewer,
  ).errors)
  if (review.decision !== 'ACCEPTED') errors.push('REVIEW_REPAIR_REQUIRED')
  if (review.decision === 'ACCEPTED' && review.findings.length > 0) {
    errors.push('ACCEPTED_REVIEW_HAS_FINDINGS')
  }
  if (review.decision === 'REPAIR_REQUIRED' && review.findings.length === 0) {
    errors.push('REPAIR_REVIEW_FINDINGS_REQUIRED')
  }
  errors.push(...review.findings.map((finding) => `BLOCKING_FINDING:${finding.id}`))

  const uniqueErrors = [...new Set(errors)].sort()
  return { valid: uniqueErrors.length === 0, errors: uniqueErrors }
}

export function artifactDigest(path: string): string {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error('ARTIFACT_PATH_UNSAFE')
  }
  return digest(readFileSync(path))
}
