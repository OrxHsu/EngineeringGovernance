import { readFileSync } from 'node:fs'

import { parse } from 'yaml'

import {
  verifyEvidence,
  type EvidenceKind,
  type ImplementationIdentity,
  type EvidenceVerificationOptions,
} from '../evidence/verify.js'
import { verifyGitIdentity, type GitIdentityInput } from '../evidence/git-identity.js'
import type { Risk, ValidationResult } from '../model/types.js'
import { validateDocument } from '../policy/load.js'
import { canonicalDigest } from '../model/digest.js'
import {
  verifyHardenedCandidate,
  type HardenedCandidateEligibilityInput,
  type HardenedVerificationArtifact,
} from './task-verify-v2.js'

interface CandidateVerificationInput {
  contractPath: string
  evidencePath: string
  artifactRoot: string
  requiredEvidenceKinds: Record<string, EvidenceKind>
  expectedImplementationIdentities: ImplementationIdentity[]
  maxEvidenceAgeMs: number
  gitIdentities: GitIdentityInput[]
}

interface CandidateAuthorizationInput {
  schemaVersion: 1
  authorizationId: string
  approvedBy: 'user'
  issuedAt: string
  expiresAt: string
  scope: string[]
  status: 'approved'
}

export interface LegacyCandidateEligibilityInput {
  risk: Risk
  requiredGateErrors?: string[]
  authorizationRequired: boolean
  authorizationApproved: boolean
  verification?: CandidateVerificationInput
  authorization?: CandidateAuthorizationInput
  requestedAuthorizationScope?: string[]
}

export type CandidateEligibilityInput = LegacyCandidateEligibilityInput | HardenedCandidateEligibilityInput

export function isHardenedCandidate(
  input: CandidateEligibilityInput,
): input is HardenedCandidateEligibilityInput {
  return 'schemaVersion' in input && input.schemaVersion === 2
}

export interface CandidateVerificationContext {
  authorizationCheckTime?: Date
  evidenceVerificationTime?: Date
  evidenceReplayPlanDigest?: string
  candidatePath?: string
}

const maximumEvidenceAgeMs = 24 * 60 * 60 * 1000

function sameScope(left: string[], right: string[]): boolean {
  const canonical = (values: string[]): string[] => [...new Set(values)].sort()
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function verifyAuthorization(
  input: LegacyCandidateEligibilityInput,
  context: CandidateVerificationContext,
): string[] {
  if (!input.authorizationRequired) return []
  const errors: string[] = []
  if (Object.hasOwn(input, 'authorizationCheckTime')) {
    errors.push('AUTHORIZATION_CHECK_TIME_CALLER_CONTROLLED')
  }
  if (!input.authorizationApproved) return [...errors, 'USER_AUTHORIZATION_REQUIRED']
  if (input.authorization === undefined) return [...errors, 'AUTHORIZATION_RECORD_REQUIRED']

  const schema = validateDocument('authorization', input.authorization)
  if (!schema.valid) {
    errors.push(...schema.errors.map((error) => `AUTHORIZATION_SCHEMA_INVALID:${error}`))
    return errors
  }
  if (
    input.requestedAuthorizationScope === undefined
    || input.requestedAuthorizationScope.length === 0
  ) {
    errors.push('AUTHORIZATION_SCOPE_REQUIRED')
  } else if (!sameScope(input.authorization.scope, input.requestedAuthorizationScope)) {
    errors.push('AUTHORIZATION_SCOPE_MISMATCH')
  }

  const checkTime = (context.authorizationCheckTime ?? new Date()).getTime()
  const issuedAt = Date.parse(input.authorization.issuedAt)
  const expiresAt = Date.parse(input.authorization.expiresAt)
  if (
    !Number.isFinite(checkTime)
    || !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || issuedAt >= expiresAt
  ) {
    errors.push('AUTHORIZATION_TIME_RANGE_INVALID')
  } else {
    if (checkTime < issuedAt) errors.push('AUTHORIZATION_NOT_YET_VALID')
    if (checkTime >= expiresAt) errors.push('AUTHORIZATION_EXPIRED')
  }
  return errors
}

interface TaskContractDocument {
  sopVersion: string
  contractDigest: string
  risk: Risk
  acceptance: Array<{ id: string }>
  [key: string]: unknown
}

function verifyCandidateArtifacts(
  risk: Risk,
  input: CandidateVerificationInput,
  context: CandidateVerificationContext,
): string[] {
  const errors: string[] = []
  if (Object.hasOwn(input, 'verificationTime')) {
    errors.push('EVIDENCE_VERIFICATION_TIME_CALLER_CONTROLLED')
  }
  if (
    !Number.isInteger(input.maxEvidenceAgeMs)
    || input.maxEvidenceAgeMs <= 0
    || input.maxEvidenceAgeMs > maximumEvidenceAgeMs
  ) {
    errors.push('EVIDENCE_MAX_AGE_EXCEEDS_POLICY')
  }
  if (
    new Set(input.expectedImplementationIdentities.map((identity) => identity.repository)).size
    !== input.expectedImplementationIdentities.length
  ) {
    errors.push('EXPECTED_IMPLEMENTATION_IDENTITIES_DUPLICATED')
  }
  if (
    new Set(input.gitIdentities.map((identity) => identity.repository)).size
    !== input.gitIdentities.length
  ) {
    errors.push('GIT_IDENTITIES_DUPLICATED')
  }
  let contract: TaskContractDocument
  try {
    contract = parse(readFileSync(input.contractPath, 'utf8')) as TaskContractDocument
  } catch {
    return ['CONTRACT_FILE_UNREADABLE']
  }

  const contractSchema = validateDocument('task-contract', contract)
  if (!contractSchema.valid) {
    return contractSchema.errors.map((error) => `CONTRACT_SCHEMA_INVALID:${error}`)
  }
  const { contractDigest, ...unsignedContract } = contract
  if (canonicalDigest(unsignedContract) !== contractDigest) {
    errors.push('CONTRACT_DIGEST_INVALID')
  }
  if (contract.risk !== risk) errors.push('CONTRACT_RISK_MISMATCH')

  const acceptanceIds = contract.acceptance.map((acceptance) => acceptance.id)
  if (new Set(acceptanceIds).size !== acceptanceIds.length) {
    errors.push('CONTRACT_ACCEPTANCE_IDS_DUPLICATED')
  }
  for (const acceptanceId of acceptanceIds) {
    if (input.requiredEvidenceKinds[acceptanceId] === undefined) {
      errors.push(`EVIDENCE_KIND_REQUIREMENT_MISSING:${acceptanceId}`)
    }
  }

  let evidence: unknown
  try {
    evidence = JSON.parse(readFileSync(input.evidencePath, 'utf8')) as unknown
  } catch {
    errors.push('EVIDENCE_FILE_UNREADABLE')
    return errors
  }
  const verificationTime = context.evidenceVerificationTime ?? new Date()
  if (!Number.isFinite(verificationTime.getTime())) {
    errors.push('VERIFICATION_TIME_INVALID')
    return errors
  }
  const evidenceOptions: EvidenceVerificationOptions = {
    requiredAcceptanceIds: acceptanceIds,
    expectedContractDigest: contractDigest,
    expectedImplementationIdentities: input.expectedImplementationIdentities,
    requiredEvidenceKinds: input.requiredEvidenceKinds,
    expectedRunnerVersion: contract.sopVersion,
    verificationTime,
    maxEvidenceAgeMs: Math.min(
      Math.max(input.maxEvidenceAgeMs, 1),
      maximumEvidenceAgeMs,
    ),
    artifactRoot: input.artifactRoot,
    ...(context.evidenceReplayPlanDigest === undefined
      ? {}
      : { approvedReplayPlanDigest: context.evidenceReplayPlanDigest }),
  }
  errors.push(...verifyEvidence(evidence, evidenceOptions).errors)

  const expectedGitIdentitySet = input.expectedImplementationIdentities
    .map((identity) => `${identity.repository}\0${identity.commit}\0${identity.tree}`)
    .sort()
  const actualGitIdentitySet = input.gitIdentities
    .map((identity) => (
      `${identity.repository}\0${identity.implementationCommit}\0${identity.implementationTree}`
    ))
    .sort()
  if (JSON.stringify(actualGitIdentitySet) !== JSON.stringify(expectedGitIdentitySet)) {
    errors.push('GIT_IDENTITY_SET_MISMATCH')
  }
  for (const identity of input.gitIdentities) {
    errors.push(...verifyGitIdentity(identity).errors)
  }
  return errors
}

export function verifyCandidateEligibility(
  input: HardenedCandidateEligibilityInput,
  context: CandidateVerificationContext = {},
): ValidationResult & { verificationArtifact?: HardenedVerificationArtifact } {
  if (!isHardenedCandidate(input)) return { valid: false, errors: ['LEGACY_CANDIDATE_REQUIRES_PINNED_V1_RUNNER'] }
  return verifyHardenedCandidate(input, context)
}

export function verifyLegacyCandidateEligibility(
  legacyInput: LegacyCandidateEligibilityInput,
  context: CandidateVerificationContext = {},
): ValidationResult {
  const candidateSchema = validateDocument('candidate', legacyInput)
  const errors = candidateSchema.valid
    ? [...(legacyInput.requiredGateErrors ?? [])]
    : candidateSchema.errors.map((error) => `CANDIDATE_SCHEMA_INVALID:${error}`)
  if (candidateSchema.valid && (legacyInput.risk === 'R2' || legacyInput.risk === 'R3')) {
    if (legacyInput.verification === undefined) {
      errors.push('CANDIDATE_VERIFICATION_REQUIRED')
    } else {
      errors.push(...verifyCandidateArtifacts(legacyInput.risk, legacyInput.verification, context))
    }
  }
  if (candidateSchema.valid) errors.push(...verifyAuthorization(legacyInput, context))
  const uniqueErrors = [...new Set(errors)].sort()
  return { valid: uniqueErrors.length === 0, errors: uniqueErrors }
}
