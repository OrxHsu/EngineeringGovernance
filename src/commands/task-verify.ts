import { readFileSync } from 'node:fs'

import { parse } from 'yaml'

import {
  verifyEvidence,
  type EvidenceKind,
  type EvidenceVerificationOptions,
} from '../evidence/verify.js'
import { verifyGitIdentity, type GitIdentityInput } from '../evidence/git-identity.js'
import type { Risk, ValidationResult } from '../model/types.js'
import { validateDocument } from '../policy/load.js'
import { taskContractDigest } from './task-start.js'

interface CandidateVerificationInput {
  contractPath: string
  evidencePath: string
  artifactRoot: string
  requiredEvidenceKinds: Record<string, EvidenceKind>
  expectedImplementationIdentities: Record<string, string>
  verificationTime: string
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

export interface CandidateEligibilityInput {
  risk: Risk
  requiredGateErrors?: string[]
  authorizationRequired: boolean
  authorizationApproved: boolean
  verification?: CandidateVerificationInput
  authorization?: CandidateAuthorizationInput
  requestedAuthorizationScope?: string[]
  authorizationCheckTime?: string
}

function sameScope(left: string[], right: string[]): boolean {
  const canonical = (values: string[]): string[] => [...new Set(values)].sort()
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function verifyAuthorization(input: CandidateEligibilityInput): string[] {
  if (!input.authorizationRequired) return []
  if (!input.authorizationApproved) return ['USER_AUTHORIZATION_REQUIRED']
  if (input.authorization === undefined) return ['AUTHORIZATION_RECORD_REQUIRED']

  const errors: string[] = []
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

  if (input.authorizationCheckTime === undefined) {
    errors.push('AUTHORIZATION_CHECK_TIME_REQUIRED')
    return errors
  }
  const checkTime = Date.parse(input.authorizationCheckTime)
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
): string[] {
  const errors: string[] = []
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
  if (taskContractDigest(unsignedContract) !== contractDigest) {
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
  const verificationTime = new Date(input.verificationTime)
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
    maxEvidenceAgeMs: input.maxEvidenceAgeMs,
    artifactRoot: input.artifactRoot,
  }
  errors.push(...verifyEvidence(evidence, evidenceOptions).errors)

  if (input.gitIdentities.length === 0) errors.push('GIT_IDENTITY_REQUIRED')
  for (const identity of input.gitIdentities) {
    errors.push(...verifyGitIdentity(identity).errors)
  }
  return errors
}

export function verifyCandidateEligibility(input: CandidateEligibilityInput): ValidationResult {
  const errors = [...(input.requiredGateErrors ?? [])]
  if (input.risk === 'R2' || input.risk === 'R3') {
    if (input.verification === undefined) {
      errors.push('CANDIDATE_VERIFICATION_REQUIRED')
    } else {
      errors.push(...verifyCandidateArtifacts(input.risk, input.verification))
    }
  }
  errors.push(...verifyAuthorization(input))
  const uniqueErrors = [...new Set(errors)].sort()
  return { valid: uniqueErrors.length === 0, errors: uniqueErrors }
}
