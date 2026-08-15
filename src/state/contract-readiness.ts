import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

import { parse } from 'yaml'

import { normalizeActorId } from '../model/actor.js'
import { canonicalDigest } from '../model/digest.js'
import type { Risk, ValidationResult } from '../model/types.js'
import { validateDocument } from '../policy/load.js'
import { validateHardenedTaskContract } from '../policy/task-contract.js'

const checklistKeys = [
  'scope_non_goals',
  'authority_dependencies',
  'risk_owner_reviewer',
  'behavior_state_transitions',
  'security_trust',
  'evidence_environment',
  'external_source_provenance',
  'rollout_recovery_compatibility',
  'unresolved_product_decisions',
] as const

const r3Keys = [
  'trust_threat_analysis',
  'migration_recovery_rollback',
  'specialized_gates',
  'scoped_authorization',
  'production_observation',
] as const

// Contracts created by the pre-gate 2.0.0 runner are the only markerless
// histories that remain grandfathered after this gate is introduced.
export const PRE_GATE_POLICY_DIGEST = 'eba8165bd069c0e85e5b08217ea260e7b027e85158404a50644c03b57a909aca'

type ChecklistKey = typeof checklistKeys[number]
type R3Key = typeof r3Keys[number]

interface ContractReadinessContract {
  schemaVersion: 2
  taskId: string
  risk: Risk
  riskSignals: Record<string, unknown>
  implementationOwner: string
  contractDigest: string
  authorizationRequirements: unknown[]
  contractReadiness?: { required: boolean; reviewPath: string; gateVersion: string }
  [key: string]: unknown
}

interface EvidenceReference {
  id: string
  kind: string
  path: string
  sha256: string
  digest: string
}

interface CheckItem {
  status: 'PASS' | 'NA'
  evidenceRefs: EvidenceReference[]
  applicabilityReason?: string
}

interface ContractReviewArtifact {
  schemaVersion: 2
  artifactType: 'sop-contract-review-v2'
  reviewId: string
  taskId: string
  risk: 'R2' | 'R3'
  reviewer: { id: string; trustLevel: 'local-claim' }
  decision: 'ACCEPTED' | 'REPAIR_REQUIRED'
  contract: { path: string; rawSha256: string; digest: string }
  checklist: Record<ChecklistKey, CheckItem>
  r3Requirements: Record<R3Key, CheckItem>
  findings: Array<{
    id: string
    severity: 'BLOCKER' | 'HIGH' | 'MEDIUM' | 'LOW'
    classification: 'contract_violation' | 'newly_discovered_defect' | 'new_requirement'
    observation: string
    requiredChange: string
    evidenceRefs: EvidenceReference[]
  }>
  nextStage: 'implementation' | 'contract-repair'
  userActionRequired: boolean
}

function sortedIds(items: Array<{ id: string }>): boolean {
  return items.every((item, index) => index === 0 || items[index - 1]!.id < item.id)
}

function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function findingsOrdered(items: ContractReviewArtifact['findings']): boolean {
  const severityRank = { BLOCKER: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const
  return items.every((item, index) => {
    if (index === 0) return true
    const previous = items[index - 1]!
    const rank = severityRank[item.severity]
    const previousRank = severityRank[previous.severity]
    return rank > previousRank || (rank === previousRank && previous.id < item.id)
  })
}

function safeRegularFile(path: string): string | undefined {
  try {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) return undefined
    return realpathSync(path)
  } catch {
    return undefined
  }
}

function evidenceDigest(path: string): string {
  const raw = readFileSync(path)
  if (['.yaml', '.yml', '.json'].includes(extname(path))) {
    try { return canonicalDigest(parse(raw.toString('utf8'))) } catch { /* plain bytes below */ }
  }
  return canonicalDigest(raw.toString('utf8'))
}

function evidenceErrors(projectRoot: string, refs: EvidenceReference[], label: string): string[] {
  const errors: string[] = []
  if (!sortedIds(refs) || new Set(refs.map((ref) => ref.id)).size !== refs.length) {
    errors.push(`${label}_EVIDENCE_REFS_NOT_UNIQUE_SORTED`)
  }
  for (const ref of refs) {
    const path = resolve(projectRoot, ref.path)
    const relativePath = relative(projectRoot, path)
    if (relativePath.startsWith('..') || relativePath !== ref.path) {
      errors.push(`${label}_EVIDENCE_PATH_INVALID:${ref.id}`)
      continue
    }
    const canonical = safeRegularFile(path)
    if (canonical === undefined || canonical !== path) {
      errors.push(`${label}_EVIDENCE_PATH_UNSAFE:${ref.id}`)
      continue
    }
    const raw = readFileSync(canonical)
    if (sha256(raw) !== ref.sha256 || evidenceDigest(canonical) !== ref.digest) {
      errors.push(`${label}_EVIDENCE_IDENTITY_MISMATCH:${ref.id}`)
    }
  }
  return errors
}

function checkItemErrors(item: CheckItem, label: string): string[] {
  const errors: string[] = []
  if (item.status === 'PASS' && item.applicabilityReason !== undefined) {
    errors.push(`${label}_PASS_HAS_APPLICABILITY_REASON`)
  }
  if (item.status === 'NA' && (!item.applicabilityReason || item.applicabilityReason.length === 0)) {
    errors.push(`${label}_NA_REASON_REQUIRED`)
  }
  errors.push(...evidenceErrors(currentProjectRoot, item.evidenceRefs, label))
  return errors
}

let currentProjectRoot = ''

function r3Applicability(contract: ContractReadinessContract): Record<R3Key, boolean> {
  if (contract.risk !== 'R3') {
    return {
      trust_threat_analysis: false,
      migration_recovery_rollback: false,
      specialized_gates: false,
      scoped_authorization: false,
      production_observation: false,
    }
  }
  const signals = contract.riskSignals
  const anySpecialized = [
    'authentication', 'authorization', 'privacy', 'security', 'restrictedRuntime',
    'migration', 'destructive', 'payments', 'externalCommunication',
  ].some((key) => signals[key] === true)
  const anyScopedAuth = contract.authorizationRequirements.length > 0 || [
    'production', 'deployment', 'remoteMutation', 'restrictedRuntime', 'destructive',
    'payments', 'externalCommunication',
  ].some((key) => signals[key] === true)
  return {
    trust_threat_analysis: true,
    migration_recovery_rollback: true,
    specialized_gates: anySpecialized,
    scoped_authorization: anyScopedAuth,
    production_observation: ['production', 'deployment', 'remoteMutation'].some((key) => signals[key] === true),
  }
}

export interface ContractReadinessVerification extends ValidationResult {
  reviewerId?: string
  review?: ContractReviewArtifact
  contract?: ContractReadinessContract
  reviewPath?: string
}

export function verifyContractReadinessArtifact(
  projectRootInput: string,
  taskId: string,
  reviewPathInput: string,
): ContractReadinessVerification {
  const errors: string[] = []
  const projectRoot = realpathSync(resolve(projectRootInput))
  currentProjectRoot = projectRoot
  const taskRoot = join(projectRoot, '.delivery', 'tasks', taskId)
  const contractPath = join(taskRoot, 'contract.yaml')
  const canonicalReviewPath = join(taskRoot, 'contract-review.yaml')
  const reviewPath = resolve(reviewPathInput)
  if (reviewPath !== canonicalReviewPath) errors.push('CONTRACT_REVIEW_CANONICAL_PATH_MISMATCH')
  const reviewCanonical = safeRegularFile(reviewPath)
  if (reviewCanonical === undefined || reviewCanonical !== reviewPath) {
    return { valid: false, errors: [...errors, 'CONTRACT_REVIEW_ARTIFACT_UNSAFE'] }
  }
  let review: unknown
  try { review = parse(readFileSync(reviewCanonical, 'utf8')) } catch {
    return { valid: false, errors: [...errors, 'CONTRACT_REVIEW_FILE_UNREADABLE'] }
  }
  const schema = validateDocument('contract-review', review)
  if (!schema.valid) errors.push(...schema.errors.map((error) => `CONTRACT_REVIEW_SCHEMA_INVALID:${error}`))
  if (!schema.valid || review === null || typeof review !== 'object' || Array.isArray(review)) {
    return { valid: false, errors: [...new Set(errors)].sort(), reviewPath: reviewCanonical }
  }
  const reviewArtifact = review as ContractReviewArtifact
  if (reviewArtifact.taskId !== taskId) errors.push('CONTRACT_REVIEW_TASK_MISMATCH')
  const contractCanonical = safeRegularFile(contractPath)
  if (contractCanonical === undefined || contractCanonical !== contractPath) {
    return { valid: false, errors: [...errors, 'CONTRACT_REVIEW_CONTRACT_UNSAFE'] }
  }
  let contract: ContractReadinessContract
  const contractRaw = readFileSync(contractCanonical)
  try { contract = parse(contractRaw.toString('utf8')) as ContractReadinessContract } catch {
    return { valid: false, errors: [...errors, 'CONTRACT_REVIEW_CONTRACT_UNREADABLE'] }
  }
  const contractSchema = validateHardenedTaskContract(contract)
  if (!contractSchema.valid) errors.push(...contractSchema.errors.map((error) => `CONTRACT_REVIEW_CONTRACT_INVALID:${error}`))
  if (contract.contractReadiness?.required !== true) errors.push('CONTRACT_READINESS_NOT_REQUIRED')
  const contractDigest = contract.contractDigest
  const expectedReviewId = `crv-${taskId}-${contractDigest}`
  if (reviewArtifact.reviewId !== expectedReviewId) errors.push('CONTRACT_REVIEW_ID_MISMATCH')
  if (reviewArtifact.risk !== contract.risk || (contract.risk !== 'R2' && contract.risk !== 'R3')) errors.push('CONTRACT_REVIEW_RISK_MISMATCH')
  if (reviewArtifact.contract === undefined || typeof reviewArtifact.contract !== 'object' || reviewArtifact.contract === null || Array.isArray(reviewArtifact.contract)
    || reviewArtifact.contract.path !== contractCanonical || reviewArtifact.contract.rawSha256 !== sha256(contractRaw) || reviewArtifact.contract.digest !== contractDigest) {
    errors.push('CONTRACT_REVIEW_CONTRACT_IDENTITY_MISMATCH')
  }
  try {
    if (reviewArtifact.reviewer === undefined || typeof reviewArtifact.reviewer !== 'object' || reviewArtifact.reviewer === null || Array.isArray(reviewArtifact.reviewer)
      || normalizeActorId(reviewArtifact.reviewer.id) === normalizeActorId(contract.implementationOwner)) {
      errors.push('CONTRACT_REVIEW_SELF_REVIEW_FORBIDDEN')
    }
  } catch { errors.push('CONTRACT_REVIEW_REVIEWER_INVALID') }

  for (const key of checklistKeys) {
    const item = reviewArtifact.checklist?.[key]
    if (item === undefined) errors.push(`CONTRACT_REVIEW_CHECKLIST_MISSING:${key}`)
    else {
      errors.push(...evidenceErrors(projectRoot, item.evidenceRefs, `CHECKLIST_${key}`))
      if (item.status !== 'PASS') errors.push(`CONTRACT_REVIEW_CHECKLIST_NOT_PASS:${key}`)
      if (item.applicabilityReason !== undefined) errors.push(`CONTRACT_REVIEW_CHECKLIST_REASON_UNEXPECTED:${key}`)
    }
  }
  const applicability = r3Applicability(contract)
  for (const key of r3Keys) {
    const item = reviewArtifact.r3Requirements?.[key]
    if (item === undefined) {
      errors.push(`CONTRACT_REVIEW_R3_MISSING:${key}`)
      continue
    }
    errors.push(...evidenceErrors(projectRoot, item.evidenceRefs, `R3_${key}`))
    if (applicability[key]) {
      if (item.status !== 'PASS') errors.push(`CONTRACT_REVIEW_R3_REQUIRED:${key}`)
    } else {
      const expectedReason = contract.risk === 'R2'
        ? 'risk-below-r3'
        : key === 'specialized_gates'
          ? 'no-specialized-signal'
          : key === 'scoped_authorization'
            ? 'no-scoped-authorization-action'
            : 'no-production-action'
      if (item.status !== 'NA' || item.applicabilityReason !== expectedReason) {
      errors.push(`CONTRACT_REVIEW_R3_NA_REASON_INVALID:${key}`)
      }
    }
  }
  if (!findingsOrdered(reviewArtifact.findings)
    || new Set(reviewArtifact.findings.map((finding) => finding.id)).size !== reviewArtifact.findings.length) {
    errors.push('CONTRACT_REVIEW_FINDINGS_NOT_UNIQUE_SEVERITY_SORTED')
  }
  for (const finding of reviewArtifact.findings) errors.push(...evidenceErrors(projectRoot, finding.evidenceRefs, `FINDING_${finding.id}`))
  if (reviewArtifact.decision === 'ACCEPTED') {
    if (reviewArtifact.findings.length !== 0 || reviewArtifact.nextStage !== 'implementation' || reviewArtifact.userActionRequired) {
      errors.push('CONTRACT_REVIEW_ACCEPTANCE_INVARIANT_INVALID')
    }
  } else if (reviewArtifact.findings.length === 0 || reviewArtifact.nextStage !== 'contract-repair') {
    errors.push('CONTRACT_REVIEW_REPAIR_INVARIANT_INVALID')
  }
  const uniqueErrors = [...new Set(errors)].sort()
  return {
    valid: uniqueErrors.length === 0,
    errors: uniqueErrors,
    reviewerId: reviewArtifact.reviewer.id,
    review: reviewArtifact,
    contract,
    reviewPath: reviewCanonical,
  }
}
